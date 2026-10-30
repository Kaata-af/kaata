// Synthetic SQLite only: no phone, account, network or customer data.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { compileUI } from "./ui-fixture";

const sql = new Database(":memory:");
sql.exec(`
  CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_b_id TEXT,note TEXT,
    field_hlcs TEXT,archived_at INTEGER,created_at INTEGER);
  CREATE TABLE event_log(event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,
    relationship_id TEXT,target_id TEXT,actor_account_id TEXT,device_id TEXT,
    signer_device_pubkey TEXT,origin TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,
    hlc_device_id TEXT,payload_json TEXT,applied_at INTEGER,rejected_at INTEGER,
    quarantine_reason TEXT,tombstone_reason TEXT,appended_at INTEGER);
  CREATE TABLE vault_device_registry(vault_id TEXT,account_id TEXT,device_id TEXT,device_pubkey TEXT);
  CREATE TABLE vault_credentials(vault_id TEXT,account_id TEXT,device_id TEXT,device_pubkey TEXT);
  INSERT INTO relationships VALUES('r1','v1','person',NULL,NULL,NULL,1);
  INSERT INTO relationships VALUES('r2','v2','person',NULL,NULL,NULL,1);
  INSERT INTO relationships VALUES('other-person','v1','other',NULL,NULL,NULL,1);
  INSERT INTO vault_device_registry VALUES('v1','me','mine','my-key');
  INSERT INTO vault_device_registry VALUES('v1','sara','sara-device','sara-key');
  INSERT INTO vault_device_registry VALUES('v1','old-staff','rotated-device','old-key');
  INSERT INTO vault_device_registry VALUES('v1','new-staff','rotated-device','new-key');
  INSERT INTO vault_device_registry VALUES('v2','other-vault','mine','my-key');
  INSERT INTO vault_credentials VALUES('v1','legacy','legacy-device','legacy-key');
`);
const queries: string[] = [];
let failingMetadata = false;
let failingNames = false;
const db = {
  getFirstAsync: async (query: string, ...args: unknown[]) => {
    queries.push(query);
    return sql.prepare(query).get(...args) ?? null;
  },
  getAllAsync: async (query: string, ...args: unknown[]) => {
    queries.push(query);
    if (failingMetadata && query.includes("FROM event_log"))
      throw new Error("Synthetic metadata failure");
    return sql.prepare(query).all(...args);
  },
};
let memberLookups = 0;
const notes = compileUI("../person-note", {
  "./db-tx": { getDb: async () => db },
  "./attribution": {
    loadMemberNames: async (vault: string) => {
      memberLookups++;
      if (failingNames) throw new Error("Synthetic names failure");
      return new Map(
        vault === "v1"
          ? [
              ["me", "Matee"],
              ["sara", "Sara"],
              ["old-staff", "Former staff"],
              ["new-staff", "New staff"],
              ["legacy", "Old clerk"],
            ]
          : [["other-vault", "Another Kaata"]],
      );
    },
  },
  "./customer-note": require("../customer-note"),
}) as typeof import("../person-note");

type Change = {
  id: string;
  at: number;
  note: string | null;
  logical?: number;
  did?: string;
  vault?: string;
  relationship?: string;
  target?: string;
  actor?: string | null;
  device?: string;
  signer?: string | null;
  origin?: string;
  applied?: number | null;
  rejected?: number | null;
  quarantine?: string | null;
  tombstone?: string | null;
};
function add(change: Change) {
  sql
    .prepare(`INSERT INTO event_log VALUES(?, 'person_note_set', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      change.id,
      change.vault ?? "v1",
      change.relationship ?? "r1",
      change.target ?? change.relationship ?? "r1",
      change.actor === undefined ? "me" : change.actor,
      change.device ?? "mine",
      change.signer === undefined ? "my-key" : change.signer,
      change.origin ?? "remote",
      change.at,
      change.logical ?? 0,
      change.did ?? "a",
      JSON.stringify({ note: change.note }),
      change.applied === undefined ? 1 : change.applied,
      change.rejected ?? null,
      change.quarantine ?? null,
      change.tombstone ?? null,
      9_999_999,
    );
}
function project(change: Change) {
  sql
    .prepare("UPDATE relationships SET note=?,field_hlcs=? WHERE id=?")
    .run(
      change.note,
      JSON.stringify({ note: { pms: change.at, l: change.logical ?? 0, did: change.did ?? "a" } }),
      change.relationship ?? "r1",
    );
}
function reset() {
  sql.exec(
    "DELETE FROM event_log; UPDATE relationships SET note=NULL,field_hlcs=NULL,archived_at=NULL;",
  );
}
async function details() {
  return notes.getPersonNoteDetails("v1", "person", ["me", "local:old-self"]);
}

async function main() {
  const never = await details();
  assert.equal(never.note, null);
  assert.equal(never.updated, null);
  assert.deepEqual(never.history, []);
  assert.equal(memberLookups, 0, "never-noted customers avoid member/device scans");

  sql.prepare("UPDATE relationships SET note='Legacy snapshot text' WHERE id='r1'").run();
  assert.equal(await notes.getPersonNote("v1", "person"), "Legacy snapshot text");
  const legacy = await details();
  assert.equal(legacy.note, "Legacy snapshot text");
  assert.equal(legacy.author, null);
  assert.equal(
    legacy.updated,
    null,
    "snapshots without original signed history never get an invented time",
  );
  reset();

  const first = { id: "first", at: 100, note: "Ask before delivery" };
  const edit = {
    id: "edit",
    at: 200,
    note: "Call before delivery",
    actor: "forged-actor",
    device: "sara-device",
    signer: "sara-key",
  };
  add(edit);
  add(first);
  project(edit);
  let value = await details();
  assert.equal(value.author?.eventId, "first");
  assert.equal(value.author?.actor?.name, "Matee");
  assert.equal(value.author?.actor?.isSelf, true);
  assert.equal(value.updated?.eventId, "edit");
  const otherVault = {
    id: "v2-note",
    at: 700,
    note: "Private instructions in another Kaata",
    vault: "v2",
    relationship: "r2",
  };
  add(otherVault);
  project(otherVault);
  const otherDetails = await notes.getPersonNoteDetails("v2", "person", ["me"]);
  assert.equal(otherDetails.note, otherVault.note);
  assert.equal(otherDetails.updated?.actor?.accountId, "other-vault");
  assert.equal(otherDetails.updated?.actor?.name, "Another Kaata");
  assert.equal(
    (await details()).note,
    edit.note,
    "same customer and signer remain scoped to their own Kaata",
  );
  assert.equal(
    value.updated?.actor?.accountId,
    "sara",
    "trusted signer binding beats claimed actor",
  );
  assert.equal(value.updated?.at, 200, "date is writer HLC, not receiver appended_at");
  assert.deepEqual(
    value.history.map((row) => row.eventId),
    ["edit", "first"],
  );
  assert.deepEqual(
    value.history.map((row) => row.note),
    [edit.note, first.note],
  );

  for (const state of [
    { id: "ingested", applied: null },
    { id: "rejected", rejected: 1 },
    { id: "quarantined", quarantine: "role_insufficient" },
    { id: "tombstoned", tombstone: "bad_signature" },
    { id: "foreign-vault", vault: "v2" },
    { id: "foreign-relationship", relationship: "other-person" },
    { id: "wrong-target", target: "other-person" },
  ])
    add({ at: 900, note: "Must not appear", ...state });
  value = await details();
  assert.deepEqual(
    value.history.map((row) => row.eventId),
    ["edit", "first"],
  );
  assert.equal(value.updated?.eventId, "edit");

  sql.prepare("UPDATE relationships SET note='Unmatched projection' WHERE id='r1'").run();
  assert.equal((await details()).updated, null, "text must match exact field clock too");
  project(edit);
  add({ ...edit, id: "same-clock", note: "Ambiguous duplicate clock" });
  assert.equal(
    (await details()).updated,
    null,
    "equal HLCs are not resolved using random event UUIDs",
  );
  sql.prepare("DELETE FROM event_log WHERE event_id='same-clock'").run();

  const clear = { id: "clear", at: 300, note: null, signer: "sara-key", device: "sara-device" };
  add(clear);
  project(clear);
  value = await details();
  assert.equal(value.note, null);
  assert.equal(value.author, null);
  assert.equal(value.updated?.eventId, "clear");
  assert.equal(value.history[0].note, null, "a clear remains a real dated revision");
  const again = {
    id: "again",
    at: 400,
    note: "New instructions",
    signer: "sara-key",
    device: "sara-device",
  };
  add(again);
  project(again);
  value = await details();
  assert.equal(
    value.author?.eventId,
    "again",
    "creation attribution starts a new cycle after a clear",
  );
  assert.equal(value.updated?.eventId, "again");
  assert.equal(value.author?.actor?.name, "Sara");
  failingNames = true;
  const unnamed = await details();
  assert.equal(unnamed.note, again.note);
  assert.equal(unnamed.updated?.actor?.accountId, "sara");
  assert.equal(
    unnamed.updated?.actor?.name,
    null,
    "name lookup failure preserves trusted identity and note",
  );
  failingNames = false;
  failingMetadata = true;
  const stillReadable = await details();
  assert.equal(
    stillReadable.note,
    again.note,
    "history failure must never hide or break current note",
  );
  assert.equal(stillReadable.updated, null);
  failingMetadata = false;

  reset();
  for (const change of [
    {
      id: "rotation",
      signer: "new-key",
      device: "rotated-device",
      actor: "old-staff",
      expected: "new-staff",
    },
    {
      id: "legacy-binding",
      signer: "legacy-key",
      device: "legacy-device",
      actor: "wrong",
      expected: "legacy",
    },
    {
      id: "wrong-legacy-key",
      signer: "alien-key",
      device: "legacy-device",
      actor: "legacy",
      expected: null,
    },
    { id: "unknown-remote", signer: "unknown-key", actor: "me", expected: null },
    { id: "ambiguous-device", signer: null, device: "rotated-device", actor: "me", expected: null },
    {
      id: "local-stamp",
      signer: "not-yet-bound",
      actor: "local:old-self",
      origin: "local",
      expected: "local:old-self",
    },
  ]) {
    const entry = { at: 100, note: "Instructions", ...change };
    sql.exec("DELETE FROM event_log");
    add(entry);
    project(entry);
    const current = (await details()).updated;
    assert.equal(current?.actor?.accountId ?? null, change.expected, change.id);
    if (change.expected === "local:old-self") assert.equal(current?.actor?.isSelf, true);
  }

  reset();
  for (let i = 0; i < 123; i++)
    add({
      id: `event-${String(i).padStart(3, "0")}`,
      at: 100 + Math.floor(i / 3),
      logical: i % 3,
      note: `Version ${i}`,
    });
  project({ id: "event-122", at: 140, logical: 2, note: "Version 122" });
  const firstPage = await details();
  assert.equal(firstPage.history.length, 50);
  assert.equal(firstPage.hasMoreHistory, true);
  assert.ok(firstPage.historyCursor);
  const secondPage = await notes.getPersonNoteHistory(
    "v1",
    "person",
    ["me"],
    firstPage.historyCursor,
  );
  assert.equal(secondPage.entries.length, 50);
  assert.equal(secondPage.hasMore, true);
  const lastPage = await notes.getPersonNoteHistory("v1", "person", ["me"], secondPage.nextCursor);
  assert.equal(lastPage.entries.length, 23);
  assert.equal(lastPage.hasMore, false);
  assert.equal(lastPage.nextCursor, null);
  const all = [...firstPage.history, ...secondPage.entries, ...lastPage.entries];
  assert.equal(
    new Set(all.map((row) => row.eventId)).size,
    123,
    "no missing or duplicate paged revisions",
  );
  assert.deepEqual(
    all.map((row) => row.note),
    Array.from({ length: 123 }, (_, i) => `Version ${122 - i}`),
  );
  await assert.rejects(
    notes.getPersonNoteHistory("v2", "person", [], firstPage.historyCursor),
    /cursor/,
  );
  await assert.rejects(
    notes.getPersonNoteHistory("v1", "other", [], firstPage.historyCursor),
    /cursor/,
  );
  await assert.rejects(notes.getPersonNoteHistory("v1", "person", [], "bad"), /cursor/);
  sql.prepare("UPDATE relationships SET archived_at=1 WHERE id='r1'").run();
  assert.deepEqual(
    (await details()).history,
    [],
    "archived relationships do not leak staff history",
  );
  assert.equal((await notes.getPersonNoteDetails("v2", "person")).note, null);
  assert.ok(
    queries.every((query) => !/\b(entries|tabs|bill)\b/.test(query)),
    "private note reads never join public financial records",
  );
  sql.close();
  console.log(
    "PASS customer note attribution: original writer/editor time, trusted identity, signed winning text, clears, legacy unknowns, privacy and complete bounded pagination",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
