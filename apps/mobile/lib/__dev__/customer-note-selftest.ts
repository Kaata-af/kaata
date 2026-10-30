// Synthetic SQLite and Ed25519 only; no phone, network, or customer data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LedgerEvent, PersonNoteSetEvent } from "../events";
import { isKnownEventType, isUserLedgerEventType } from "../events";
import { fixture } from "./person-currency-selftest";
import { compileUI } from "./ui-fixture";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function noteEvent(f: Fixture, note: string | null, vault = "v1", relationship = "r1") {
  return {
    event_id: randomUUID(),
    event_type: "person_note_set",
    vault_id: vault,
    target_id: relationship,
    relationship_id: relationship,
    hlc: { pms: 0, l: 0, did: "device" },
    device_id: "device",
    author_user_id_local_only: "self",
    actor_account_id: f.dbTx.getAccountIdSync(),
    payload_schema: 1,
    appended_at: 0,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: { note },
  } satisfies PersonNoteSetEvent;
}
async function append(f: Fixture, note: string | null) {
  const event = noteEvent(f, note);
  const result = await f.projection.applyEvent(event, { origin: "local" });
  assert.ok(result.applied, JSON.stringify(result));
  return f.rows().find((row) => row.event_id === event.event_id)!;
}

async function snapshotCheck(f: Fixture, set: any, clear: any) {
  const mapping = compileUI("../projection/ingest-row", {
    "../db-tx": f.dbTx,
    "../events": require("../events"),
    "../hlc": require("../hlc"),
    "./index": {},
  });
  const toWire = (row: any) => ({
    ...f.wire(row),
    account_id: row.actor_account_id,
    schema_version: row.payload_schema,
    server_seq: row.author_seq,
  });
  const genesis = f.rows().find((row) => row.event_type === "vault_member_added")!;
  const vault = f.sql.prepare("SELECT * FROM vaults WHERE id='v1'").get();
  const relationship = {
    id: "r1",
    vault_id: "v1",
    user_a_id: "self",
    user_b_id: "person",
    context: "peer",
    created_at: 1,
    updated_at: 1,
    archived_at: null,
  };
  const pending = new Map<string, LedgerEvent>();
  const received: LedgerEvent[] = [];
  let cursor = 0;
  const fieldHlc = compileUI("../projection/field-hlc", {
    "../db": { FIELD_HLC_INIT: { pms: -1, l: 0, did: "" } },
    "../hlc": require("../hlc"),
  });
  const restore = compileUI("../restore", {
    "./credit-alert-observation": require("../credit-alert-observation"),
    "./projection": {
      applyEventMutex: { runExclusive: async (work: () => Promise<unknown>) => work() },
    },
    "./credit-policy-cache": {},
    "./credit-alert-cache": require("../credit-alert-cache"),
    "./api": {},
    "./currency-sync": {},
    "./auth": {},
    "./db-tx": f.dbTx,
    "./hlc": require("../hlc"),
    "./projection/field-hlc": fieldHlc,
    "./entry-date": require("../entry-date"),
    "./currency-metadata": require("../currency-metadata"),
    "./currency-scope": require("../currency-scope"),
    "./customer-group-restore": compileUI("../customer-group-restore", {
      "./projection/field-hlc": fieldHlc,
      "./group-memberships": require("../group-memberships"),
    }),
    "./projection/ingest-row": {
      mapPulledWireToEvent: mapping.mapPulledWireToEvent,
      ingestPulledEvents: async (events: LedgerEvent[]) => {
        assert.equal(
          require("../credit-alert-observation").creditAlertObservationPaused(),
          true,
          "notification observations stay paused throughout restored tail ingestion",
        );
        for (const event of events) {
          received.push(event);
          pending.set(event.event_id, event);
        }
        return events.length;
      },
    },
    "./projection/sweep": {
      sweepVaultNow: async () => {
        assert.equal(
          require("../credit-alert-observation").creditAlertObservationPaused(),
          true,
          "notification observations stay paused throughout restored tail replay",
        );
        const ordered = [...pending.values()].sort((a, b) =>
          require("../hlc").compareHLC(a.hlc, b.hlc),
        );
        pending.clear();
        for (const event of ordered) {
          const result = await f.projection.applyEvent(event, { origin: "remote" });
          assert.ok(result.applied || result.reason === "duplicate", JSON.stringify(result));
        }
      },
    },
    "./sync/cursor": {
      setLastPulledServerSeq: async (_vault: string, seq: number) => {
        cursor = seq;
      },
    },
  });
  f.sql.exec(
    "DELETE FROM event_log; DELETE FROM vault_device_registry; DELETE FROM vault_members_mirror; DELETE FROM vault_settings; DELETE FROM app_meta WHERE key='hlc_last'; UPDATE relationships SET note=NULL,field_hlcs=NULL;",
  );
  f.sql.exec(
    "INSERT INTO app_meta(key,value) VALUES('credit_alert_latch:v1:old-restore','old armed episode'),('restore-preserve-meta','keep')",
  );
  await restore.restoreFromSnapshot(
    {
      vault_id: "v1",
      vault,
      shop_profile: null,
      users: [],
      relationships: [relationship],
      entries: [],
      membership_events: [toWire(genesis)],
      // Deliberately reversed arrival, mixed type, and overlap with the tail.
      person_note_events: [toWire(clear), toWire(set), toWire(genesis)],
      events: [toWire(clear)],
      snapshot_server_seq: 500,
      generated_at_ms: Date.now(),
      hlc_last: f.wire(clear).hlc,
    },
    { localSelfId: "self", setActiveDefault: false },
  );
  assert.equal(cursor, 500);
  assert.equal(
    f.sql.prepare("SELECT value FROM app_meta WHERE key='credit_alert_latch:v1:old-restore'").get(),
    undefined,
    "deliberate restore discards durable old financial alert episodes",
  );
  assert.equal(
    (f.sql.prepare("SELECT value FROM app_meta WHERE key='restore-preserve-meta'").get() as any)
      .value,
    "keep",
  );
  assert.equal(
    require("../credit-alert-observation").creditAlertObservationPaused(),
    false,
    "observer resumes after complete seed and tail replay",
  );
  await assert.rejects(
    restore.restoreFromSnapshot(
      {
        vault_id: "v1",
        vault,
        shop_profile: null,
        users: [],
        relationships: [],
        entries: [],
        membership_events: [],
        events: [],
        snapshot_server_seq: 500,
        generated_at_ms: Date.now(),
        hlc_last: f.wire(clear).hlc,
        credit_alerts: [
          {
            relationship_id: "r1",
            updated_at_ms: 1,
            groups: [
              { direction: "collect", conditions: [{ currency: "USD", threshold_minor: 0 }] },
            ],
          },
        ],
      },
      { localSelfId: "self", setActiveDefault: false },
    ),
    /Invalid credit alert response/,
  );
  assert.equal(
    require("../credit-alert-observation").creditAlertObservationPaused(),
    false,
    "a failed restore also resumes observations after clearing its old baseline",
  );
  assert.equal(f.saved().note, null, "signed clear survives snapshot cursor advancement");
  assert.deepEqual(JSON.parse(f.saved().field_hlcs).note, f.wire(clear).hlc);
  assert.equal(received.filter((event) => event.event_type === "vault_member_added").length, 1);
  for (const row of [set, clear]) {
    const original = f.wire(row);
    const restored = received.find((event) => event.event_id === row.event_id)!;
    for (const key of [
      "payload",
      "hlc",
      "target_id",
      "relationship_id",
      "event_sig_b64",
      "signer_device_pubkey",
      "author_seq",
    ] as const)
      assert.deepEqual(restored[key], original[key], `restore preserves signed ${key}`);
  }
  assert.equal(f.rows().filter((row) => row.event_id === clear.event_id).length, 1);
  await f.persons.applyPersonNoteSet(f.tx, f.wire(set));
  assert.equal(f.saved().note, null, "older notes cannot return after recovery");
}

async function main() {
  assert.equal(isKnownEventType("person_note_set"), true);
  assert.equal(isUserLedgerEventType("person_note_set"), true);
  const corpus = JSON.parse(
    readFileSync(
      resolve(__dirname, "../../../_shared/projection-corpus/08_customer_notes.json"),
      "utf8",
    ),
  );
  const c = await fixture();
  c.sql.exec("DELETE FROM relationships; DELETE FROM users WHERE is_local_self=0;");
  for (const event of corpus.events as LedgerEvent[]) {
    if (event.event_type === "person_added") await c.persons.applyPersonAdded(c.tx, event);
    else if (event.event_type === "person_note_set")
      await c.persons.applyPersonNoteSet(c.tx, event);
  }
  for (const expected of Object.values(corpus.expected_projection.relationships) as any[]) {
    const actual = c.sql.prepare("SELECT * FROM relationships WHERE id=?").get(expected.id) as any;
    for (const key of [
      "id",
      "user_a_id",
      "user_b_id",
      "context",
      "vault_id",
      "created_at",
      "updated_at",
      "archived_at",
    ])
      assert.deepEqual(actual[key], expected[key], `shared Go/TS corpus relationship ${key}`);
    assert.equal(actual.note, expected.note ?? null);
    assert.deepEqual(JSON.parse(actual.field_hlcs).note, expected.note_field_hlc);
  }
  c.sql.close();
  const f = await fixture();
  const oldMoney = f.sql.prepare("SELECT * FROM entries").all();
  const set = await append(f, "  Keep the delivery receipt.\n☎️ با مشتری تماس بگیرید  ");
  assert.equal(f.saved().note, JSON.parse(set.payload_json).note, "replay never trims signed text");
  assert.equal(
    (f.sql.prepare("SELECT note FROM relationships WHERE id='r2'").get() as any).note,
    null,
  );
  assert.deepEqual(f.sql.prepare("SELECT * FROM entries").all(), oldMoney);
  const clear = await append(f, null);
  await f.persons.applyPersonNoteSet(f.tx, f.wire(set));
  assert.equal(f.saved().note, null);
  assert.deepEqual(JSON.parse(f.saved().field_hlcs).note, f.wire(clear).hlc);
  assert.equal(
    (await f.projection.applyEvent(f.wire(clear), { origin: "remote" })).reason,
    "duplicate",
  );
  for (const payload of [
    {},
    { note: undefined },
    { note: 42 },
    { note: {} },
    { note: "😀".repeat(2001) },
  ])
    await assert.rejects(
      f.persons.applyPersonNoteSet(f.tx, { ...f.wire(clear), payload } as any),
      /Invalid/,
    );
  const max = {
    ...f.wire(clear),
    hlc: { pms: f.wire(clear).hlc.pms + 1, l: 0, did: "z" },
    payload: { note: "😀".repeat(2000) },
  };
  await f.persons.applyPersonNoteSet(f.tx, max);
  assert.equal([...f.saved().note].length, 2000);
  await assert.rejects(
    f.persons.applyPersonNoteSet(f.tx, { ...max, relationship_id: "r2" }),
    /own relationship/,
  );
  await assert.rejects(f.persons.applyPersonNoteSet(f.tx, { ...max, vault_id: "v2" }), /missing/);
  await assert.rejects(
    f.persons.applyPersonNoteSet(f.tx, {
      ...max,
      target_id: "missing",
      relationship_id: "missing",
    }),
    /missing/,
  );
  const forged = await f.projection.applyEvent(
    { ...f.wire(set), event_id: randomUUID(), payload: { note: "changed without signing" } },
    { origin: "remote" },
  );
  assert.equal(forged.reason, "role_gate");
  assert.equal(forged.role_gate?.reason, "bad_signature");
  const unsigned = { ...f.wire(set), event_id: randomUUID(), event_sig_b64: null };
  assert.equal((await f.projection.applyEvent(unsigned, { origin: "remote" })).reason, "role_gate");
  for (const role of ["viewer", "clerk", "editor", "manager", "owner"] as const) {
    const r = await fixture();
    r.seedRole(role);
    const result = await r.projection.applyEvent(noteEvent(r, `role ${role}`, "v2", "r2"), {
      origin: "local",
    });
    assert.equal(result.applied, !["viewer", "clerk"].includes(role), `${role} note permission`);
    assert.equal(
      (r.sql.prepare("SELECT note FROM relationships WHERE id='r2'").get() as any).note,
      result.applied ? `role ${role}` : null,
    );
    r.sql.close();
  }
  await snapshotCheck(f, set, clear);
  f.sql.close();
  console.log(
    "PASS customer notes: signed vault-scoped LWW, Unicode limits, roles, financial isolation and cursor-independent snapshot recovery",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
