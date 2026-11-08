import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TallyNoteAddedEvent, TallyNoteRemovedEvent } from "../events";
import { compile, declaration, fixture } from "./person-currency-selftest";
import { compileUI } from "./ui-fixture";

async function main() {
  const f = await fixture();
  try {
    f.sql.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER)");
    const { runMigration052 } = compile(
      `const MIGRATION_052="052_tally_notes";export ${declaration("../db", "runMigration052")}`,
      () => ({}),
    );
    await runMigration052(f.tx);
    const relationship = randomUUID();
    f.sql.prepare("UPDATE relationships SET id=? WHERE id='r2'").run(relationship);
    const notes = compileUI("../tally-notes", {
      "expo-crypto": { randomUUID },
      "./attribution": { loadMemberNames: async () => new Map([["member", "Viewer"]]) },
      "./auth": f.auth,
      "./db-tx": f.dbTx,
      "./event-log": f.eventLog,
      "./projection": f.projection,
      "./tally-note-policy": f.tallyNotePolicy,
    }) as typeof import("../tally-notes");
    const originalMoney = f.sql.prepare("SELECT * FROM entries").all();
    const ninjaRelationship = randomUUID();
    f.sql.prepare("UPDATE relationships SET id=? WHERE id='r1'").run(ninjaRelationship);
    await notes.addTallyNote("v1", "person", "A Ninja note");
    const ninja = f.rows().find((row) => row.event_type === "tally_note_added");
    assert.equal(ninja.actor_account_id, null);
    assert.equal(
      f.signature.verifyEventSignature(f.wire(ninja), ninja.event_sig_b64, f.pubkey).valid,
      true,
    );
    assert.equal((await notes.listTallyNotes("v1", "person"))[0].note, "A Ninja note");
    f.seedRole("viewer");
    f.sql.exec("INSERT INTO vault_members_mirror VALUES('v2','member','viewer',1,NULL,'Viewer')");
    const eventCount = () =>
      f.rows().filter((row) => row.vault_id === "v2" && row.event_type.startsWith("tally_note_"))
        .length;
    assert.equal(notes.normalizeTallyNote("🙂".repeat(500))?.length, 1000);
    assert.equal(notes.normalizeTallyNote("🙂".repeat(501)), null);
    assert.equal(notes.normalizeTallyNote("\u0085  "), null);
    assert.equal(notes.normalizeTallyNote("bad\u0000note"), null);
    await notes.addTallyNote("v2", "person", " \u0085I took 10 from Ahmad 🙂\n");
    const [added] = await notes.listTallyNotes("v2", "person");
    assert.equal(added.note, "I took 10 from Ahmad 🙂");
    assert.equal(added.authorName, "Viewer");
    assert.equal(added.authorAccountId, "member");
    const written = f.rows().find((row) => row.event_id === added.id);
    assert.equal(written.target_id, written.event_id);
    assert.equal(written.relationship_id, relationship);
    assert.equal(
      f.signature.verifyEventSignature(f.wire(written), written.event_sig_b64, f.pubkey).valid,
      true,
    );
    await assert.rejects(notes.removeTallyNote("v2", "person", added.id), /role_gate_rejected/);
    assert.equal(eventCount(), 1, "a refused removal leaves no queued event");
    assert.equal((await notes.listTallyNotes("v2", "person")).length, 1);

    f.sql.exec("UPDATE vault_members_mirror SET revoked_at=2 WHERE account_id='member'");
    await assert.rejects(notes.addTallyNote("v2", "person", "No access"), /role_gate_rejected/);
    assert.deepEqual(await notes.listTallyNotes("v2", "person"), []);
    f.sql.exec(
      "UPDATE vault_members_mirror SET revoked_at=NULL,accepted_at=NULL WHERE account_id='member'",
    );
    await assert.rejects(
      notes.addTallyNote("v2", "person", "Pending invitation"),
      /role_gate_rejected/,
    );
    f.sql.exec("UPDATE vault_members_mirror SET accepted_at=1 WHERE account_id='member'");
    f.afterSigner(() => f.active("v1"));
    await assert.rejects(notes.addTallyNote("v2", "person", "Stale form"), /session_changed/);
    f.afterSigner(null);
    f.active("v2");
    assert.equal(eventCount(), 1);
    await assert.rejects(notes.listTallyNotes("v1", "person"), /session_changed/);

    f.sql.exec(`UPDATE vault_members_mirror SET role='manager' WHERE account_id='member';
      UPDATE event_log SET payload_json='{"role":"manager","account_id":"member"}'
        WHERE vault_id='v2' AND event_type='vault_member_added'`);
    f.roleGate.invalidateRoleGateCache("v2");
    await notes.removeTallyNote("v2", "person", added.id);
    await notes.removeTallyNote("v2", "person", added.id);
    assert.equal(eventCount(), 2, "duplicate dismissal is a no-op");
    assert.deepEqual(await notes.listTallyNotes("v2", "person"), []);

    const noteId = randomUUID();
    const historyAdd = {
      ...f.wire(written),
      event_id: noteId,
      target_id: noteId,
      payload: { note: "Synced history" },
    } as TallyNoteAddedEvent;
    const historyRemove: TallyNoteRemovedEvent = {
      ...historyAdd,
      event_type: "tally_note_removed",
      event_id: randomUUID(),
      payload: {},
      hlc: { ...historyAdd.hlc, pms: historyAdd.hlc.pms + 1 },
    };
    await f.tallyProjection.applyTallyNote(f.tx, historyRemove);
    await f.tallyProjection.applyTallyNote(f.tx, historyAdd, "verified-member");
    const tombstone = f.sql
      .prepare("SELECT note,removed_at,author_account_id FROM tally_notes WHERE id=?")
      .get(noteId);
    assert.deepEqual(tombstone, {
      note: "Synced history",
      removed_at: historyRemove.hlc.pms,
      author_account_id: "verified-member",
    });
    assert.deepEqual(await notes.listTallyNotes("v2", "person"), []);
    await assert.rejects(
      f.tallyProjection.applyTallyNote(f.tx, { ...historyAdd, relationship_id: randomUUID() }),
      /has not arrived/,
    );
    await assert.rejects(
      f.tallyProjection.applyTallyNote(f.tx, { ...historyAdd, target_id: randomUUID() }),
      /Invalid tally note/,
    );
    assert.deepEqual(f.sql.prepare("SELECT * FROM entries").all(), originalMoney);
    console.log(
      "PASS tally notes data: migration, signatures, viewer-only notes, active roles, scope, manager removal and sticky replay",
    );
  } finally {
    f.sql.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
