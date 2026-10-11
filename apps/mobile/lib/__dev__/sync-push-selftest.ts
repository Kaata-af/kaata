// Real push worker + SQLite, synthetic records only. No phone/production data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { pushFailureMessage } from "../sync/push-error";
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const fixture = new Database(":memory:");
fixture.exec(`
  CREATE TABLE event_log (
    event_id TEXT PRIMARY KEY, event_type TEXT, vault_id TEXT, target_id TEXT,
    relationship_id TEXT, hlc_physical_ms INTEGER, hlc_logical INTEGER,
    hlc_device_id TEXT, device_id TEXT, author_user_id_local_only TEXT,
    actor_account_id TEXT, payload_json TEXT, payload_schema INTEGER,
    appended_at INTEGER, author_seq INTEGER, event_sig_b64 TEXT,
    signer_device_pubkey TEXT, push_attempts INTEGER DEFAULT 0,
    server_acked_at INTEGER, rejected_at INTEGER, tombstone_reason TEXT,
    next_push_at INTEGER, last_reject_reason TEXT, applied_at INTEGER
  );
  CREATE TABLE credit_admission_intents(event_id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,status TEXT,reason TEXT);
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
`);
const sqlite = {
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  withTransactionAsync: async (callback: () => Promise<void>) => {
    fixture.exec("BEGIN");
    try {
      await callback();
      fixture.exec("COMMIT");
    } catch (error) {
      fixture.exec("ROLLBACK");
      throw error;
    }
  },
};
const installId = randomUUID();
const vaultId = randomUUID();
let markedBackedUp = 0;
function stub(name: string, exports: object) {
  const filename = require.resolve(name);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: { __esModule: true, ...exports },
  } as NodeJS.Module;
}
stub("../api", { getBackendUrl: async () => "https://synthetic.invalid" });
stub("../auth", { getSessionJWT: async () => "synthetic-session" });
stub("../db", {
  getAppMeta: async (key: string) =>
    (
      fixture.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value ?? null,
  setAppMeta: async (key: string, value: string) =>
    fixture.prepare("INSERT OR REPLACE INTO app_meta VALUES (?,?)").run(key, value),
});
stub("../db-tx", { getDb: async () => sqlite, getInstallIdSync: () => installId });
stub("../projection", {
  applyEventMutex: { runExclusive: async (fn: () => Promise<unknown>) => fn() },
});
stub("../projection-conflicts", { notifyProjectionConflictsChanged: () => {} });
let creditRepaints = 0,
  sweeps = 0;
stub("../ledger-events", {
  emitLedgerApplied: () => {
    creditRepaints++;
  },
});
stub("../projection/sweep", {
  scheduleSweep: () => {
    sweeps++;
  },
});
stub("../sync/cursor", {
  markPushDone: async () => {
    markedBackedUp++;
  },
});
stub("../sync/pull", {
  markSelfMembershipRevoked: async () => {},
  markVaultArchivedFromServer: async () => {},
});
const { pushEvents } = require("../sync/push") as typeof import("../sync/push");

async function run() {
  const localID = "local:AbCdEfGhIjKlMnOp";
  const genesisID = randomUUID();
  const insert = fixture.prepare(`INSERT INTO event_log
    (event_id,event_type,vault_id,target_id,hlc_physical_ms,hlc_logical,hlc_device_id,
     device_id,author_user_id_local_only,actor_account_id,payload_json,payload_schema,
     appended_at,author_seq,event_sig_b64,signer_device_pubkey)
    VALUES (?,?,?,?,?,0,?,?,?,NULL,?,1,?, ?,?,?)`);
  const payload = JSON.stringify({ account_id: localID, role: "owner" });
  // Opaque proof bytes must pass through; cryptographic verification is pinned
  // by the real Go HTTP/Ed25519/restore test, not this network stub.
  insert.run(
    genesisID,
    "vault_member_added",
    vaultId,
    localID,
    100,
    installId,
    installId,
    "self",
    payload,
    100,
    1,
    "signature",
    "public-key",
  );
  for (let i = 0; i < 103; i++) {
    insert.run(
      randomUUID(),
      "entry_created",
      vaultId,
      randomUUID(),
      101 + i,
      installId,
      installId,
      "self",
      JSON.stringify({ amount_afn: 12.34 }),
      101 + i,
      2 + i,
      "signature",
      "public-key",
    );
  }
  const before = fixture.prepare("SELECT * FROM event_log ORDER BY event_id").all();
  const realFetch = globalThis.fetch;
  let failure = true;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.events.length, 104);
    const genesis = request.events[0];
    assert.equal(genesis.target_id, localID);
    assert.equal(genesis.actor_account_id, null);
    assert.equal(genesis.event_sig_b64, "signature");
    assert.equal(genesis.signer_device_pubkey, "public-key");
    assert.deepEqual(genesis.payload, JSON.parse(payload));
    if (failure)
      return new Response(JSON.stringify({ error: "events[0].target_id must be a uuid" }), {
        status: 400,
      });
    return new Response(
      JSON.stringify({
        accepted: request.events.map((e: { event_id: string }, i: number) => ({
          event_id: e.event_id,
          server_seq: i + 1,
        })),
        duplicates: [],
        rejected: [],
      }),
    );
  };
  try {
    await assert.rejects(
      pushEvents(vaultId),
      /push failed: 400: events\[0\]\.target_id must be a uuid/,
    );
    assert.deepEqual(
      fixture.prepare("SELECT * FROM event_log ORDER BY event_id").all(),
      before,
      "HTTP failure must neither rewrite nor discard queued history",
    );
    assert.equal(markedBackedUp, 0);
    failure = false;
    assert.deepEqual(await pushEvents(vaultId), { pushed: 104, duplicates: 0, rejected: 0 });
    assert.equal(markedBackedUp, 1);
    const after = fixture.prepare("SELECT * FROM event_log ORDER BY event_id").all() as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(
      after.map((row) => ({ ...row, server_acked_at: null })),
      before,
      "successful retry only acknowledges records; signed contents survive",
    );
    assert.deepEqual(await pushEvents(vaultId), { pushed: 0, duplicates: 0, rejected: 0 });
    assert.equal(sweeps, 1, "HTTPS acknowledgement wakes deferred projection replay");
    assert.equal(creditRepaints, 1, "acknowledgement repaints the separate intent surface");
    const deferred = randomUUID(),
      historical = randomUUID();
    for (const id of [deferred, historical])
      insert.run(
        id,
        "entry_created",
        vaultId,
        randomUUID(),
        200,
        installId,
        installId,
        "self",
        JSON.stringify({ amount_afn: 12.34 }),
        200,
        null,
        "signature",
        "public-key",
      );
    fixture.prepare("UPDATE event_log SET applied_at=1 WHERE event_id=?").run(historical);
    for (const id of [deferred, historical])
      fixture
        .prepare("INSERT INTO credit_admission_intents VALUES(?,?,?,'pending',NULL)")
        .run(id, vaultId, "rel");
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          accepted: [],
          duplicates: [],
          rejected: [deferred, historical].map((event_id) => ({
            event_id,
            reason: "credit_limit_exceeded",
          })),
        }),
      );
    await pushEvents(vaultId);
    const verdict = (id: string) =>
      fixture
        .prepare("SELECT rejected_at,applied_at,last_reject_reason FROM event_log WHERE event_id=?")
        .get(id) as {
        rejected_at: number | null;
        applied_at: number | null;
        last_reject_reason: string | null;
      };
    assert.ok(verdict(deferred).rejected_at, "unapplied clerk attempt is terminally refused");
    assert.equal(
      verdict(historical).rejected_at,
      null,
      "already-visible history never silently disappears",
    );
    assert.equal(verdict(historical).applied_at, 1);
    assert.equal(
      (
        fixture
          .prepare("SELECT status FROM credit_admission_intents WHERE event_id=?")
          .get(deferred) as { status: string }
      ).status,
      "refused",
    );
    assert.equal(creditRepaints, 2, "background refusal immediately repaints intent status");
  } finally {
    globalThis.fetch = realFetch;
    fixture.close();
  }

  for (const error of [
    "events[103].hlc.device_id must be a uuid",
    "events[0].actor_account_id does not match session account",
    "events[1]: event_sig_b64 and signer_device_pubkey must be supplied together",
    "invalid json body",
  ]) {
    assert.equal(pushFailureMessage(400, { error }), `push failed: 400: ${error}`);
  }
  for (const body of [
    null,
    {},
    "private",
    { error: 45 },
    { error: "<html>gateway failed</html>" },
    { error: "events[0].payload customer private note" },
    { error: "events[0].target_id must be a uuid\nsecret" },
    { error: "a".repeat(1000) },
  ]) {
    assert.equal(
      pushFailureMessage(400, body),
      "push failed: 400",
      "unknown server text must not leak into shared diagnostics",
    );
  }
  assert.equal(pushFailureMessage(502, { error: "invalid json body" }), "push failed: 502");
  console.log(
    "PASS sync push: 104-record retry, immutable proof/history, honest backup status, bounded private-safe diagnostics",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
