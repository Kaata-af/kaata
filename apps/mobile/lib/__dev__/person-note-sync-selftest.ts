import assert from "node:assert/strict";
import type { LedgerEvent } from "../events";
import { fixture } from "./person-currency-selftest";
import { compileUI, deferred } from "./ui-fixture";

async function main() {
  const f = await fixture();
  await f.eventLog.appendPersonEdit({
    userId: "person",
    relationshipId: "r1",
    vaultId: "v1",
    note: "Internal delivery instructions",
    expectedAccountId: null,
  });
  await f.eventLog.appendPersonEdit({
    userId: "person",
    relationshipId: "r1",
    vaultId: "v1",
    note: null,
    expectedAccountId: null,
  });
  const rows = f.rows().filter((row) => row.event_type === "person_note_set");
  assert.equal(rows.length, 2);
  const originalMoney = f.sql.prepare("SELECT * FROM entries").all();
  const wire = rows.map((row, index) => ({
    ...f.wire(row),
    account_id: row.actor_account_id,
    schema_version: row.payload_schema,
    server_seq: index + 1,
  }));
  f.sql.exec(
    "DELETE FROM event_log WHERE event_type='person_note_set'; UPDATE relationships SET note=NULL,field_hlcs=NULL WHERE id='r1';",
  );
  await f.auth.switchSession("account", "synthetic-session");
  const ingester = compileUI("../projection/ingest-row", {
    "../db-tx": f.dbTx,
    "../events": require("../events"),
    "../hlc": require("../hlc"),
    "./index": f.projection,
  });
  let sweeps = 0;
  const history = compileUI("../person-note-sync", {
    "./api": { getBackendUrl: async () => "https://notes.invalid" },
    "./auth": f.auth,
    "./currency-sync": require("../currency-sync"),
    "./customer-note": require("../customer-note"),
    "./db-tx": f.dbTx,
    "./event-sig": f.signature,
    "./projection": f.projection,
    "./projection/ingest-row": ingester,
    "./projection/sweep": {
      sweepVaultNow: async () => {
        sweeps++;
        // The signature/ACL state machine itself is exercised by customer-note
        // selftest. Here retain the real ingest rows and run their real applier.
        for (const row of f
          .rows()
          .filter((row) => row.event_type === "person_note_set" && row.applied_at == null)) {
          await f.persons.applyPersonNoteSet(f.tx, f.wire(row));
          f.sql
            .prepare("UPDATE event_log SET applied_at=? WHERE event_id=?")
            .run(Date.now(), row.event_id);
        }
      },
    },
  }) as typeof import("../person-note-sync");
  const marker = "person_notes_history_v1:account:v1";
  const marked = () =>
    (f.sql.prepare("SELECT value FROM app_meta WHERE key=?").get(marker) as any)?.value;
  const page = (events: unknown[] = [], has_more = false, next_after_server_seq = 0) => ({
    vault_id: "v1",
    events,
    has_more,
    next_after_server_seq,
  });
  const priorFetch = globalThis.fetch;
  try {
    for (const status of [404, 403, 500]) {
      globalThis.fetch = async () => new Response(null, { status });
      assert.equal(await history.syncPersonNotesHistory("v1"), false);
      assert.equal(marked(), undefined, "unsupported/denied response stays retryable");
    }
    for (const bad of [
      { ...page(), vault_id: "other" },
      page([{ ...wire[0], vault_id: "other" }], false, 1),
      page([{ ...wire[0], event_sig_b64: null }], false, 1),
      page([{ ...wire[0], payload: { note: "changed without signing" } }], false, 1),
      page([{ ...wire[0], relationship_id: "other" }], false, 1),
      page([{ ...wire[0], event_type: "entry_created" }], false, 1),
      page([wire[0]], false, 0),
      page([], true, 0),
      { ...page(), has_more: "false" },
    ]) {
      globalThis.fetch = async () => Response.json(bad);
      await assert.rejects(history.syncPersonNotesHistory("v1"));
      assert.equal(marked(), undefined);
      assert.equal(f.rows().filter((row) => row.event_type === "person_note_set").length, 0);
    }
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      const after = new URL(String(url)).searchParams.get("after_server_seq");
      assert.equal(new URL(String(url)).pathname, "/v1/sync/person-notes");
      assert.equal(new URL(String(url)).searchParams.get("vault_id"), "v1");
      assert.equal(new URL(String(url)).searchParams.get("limit"), "200");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer synthetic-session",
      );
      requests++;
      if (after === "0") return Response.json(page([wire[0]], true, 1));
      throw new Error("connection lost after first page");
    };
    await assert.rejects(history.syncPersonNotesHistory("v1"), /connection lost/);
    assert.equal(marked(), undefined);
    assert.equal(
      f.saved().note,
      "Internal delivery instructions",
      "complete first page is durable",
    );
    assert.equal(f.rows().filter((row) => row.event_type === "person_note_set").length, 1);
    globalThis.fetch = async (url) => {
      requests++;
      return new URL(String(url)).searchParams.get("after_server_seq") === "0"
        ? Response.json(page([wire[0]], true, 1))
        : Response.json(page([wire[1]], false, 2));
    };
    assert.equal(await history.syncPersonNotesHistory("v1"), true);
    assert.equal(marked(), "1");
    assert.equal(f.saved().note, null, "signed clear survives an older snapshot cursor");
    assert.equal(requests, 4, "failed recovery restarts idempotently at its private cursor0");
    assert.equal(f.rows().filter((row) => row.event_type === "person_note_set").length, 2);
    for (const original of rows) {
      const restored = f.rows().find((row) => row.event_id === original.event_id)!;
      for (const key of [
        "event_sig_b64",
        "signer_device_pubkey",
        "payload_json",
        "author_seq",
        "target_id",
        "relationship_id",
      ])
        assert.equal(restored[key], original[key], `recovery preserves original ${key}`);
    }
    assert.equal(await history.syncPersonNotesHistory("v1"), true);
    assert.equal(requests, 4, "successful bootstrap performs no repeat request");
    assert.ok(sweeps >= 3);
    assert.deepEqual(f.sql.prepare("SELECT * FROM entries").all(), originalMoney);
    assert.equal(
      f.sql
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_state'")
        .get(),
      undefined,
      "recovery neither requires nor creates the normal sync cursor table",
    );

    f.sql.prepare("DELETE FROM app_meta WHERE key=?").run(marker);
    const response = deferred<Response>();
    const entered = deferred<void>();
    globalThis.fetch = async () => {
      entered.resolve();
      return response.promise;
    };
    const session = await f.auth.captureCurrentSession();
    const pending = history.syncPersonNotesHistory("v1", session);
    await entered.promise;
    await f.auth.switchSession("other-account", "other-session");
    response.resolve(Response.json(page([wire[0]], false, 1)));
    await assert.rejects(pending, /session_changed/);
    assert.equal(marked(), undefined, "late response cannot complete another account's bootstrap");
    await f.auth.switchSession("account", "synthetic-session");
    let sharedRequests = 0;
    globalThis.fetch = async () => {
      sharedRequests++;
      return Response.json(page());
    };
    assert.deepEqual(
      await Promise.all([
        history.syncPersonNotesHistory("v1"),
        history.syncPersonNotesHistory("v1"),
      ]),
      [true, true],
    );
    assert.equal(sharedRequests, 1, "parallel sync callers share one bootstrap");
  } finally {
    globalThis.fetch = priorFetch;
    f.sql.close();
  }
  console.log(
    "PASS note history: original signed page recovery, durable retry, strict scope/signatures, session changes and no ordinary cursor writes",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
