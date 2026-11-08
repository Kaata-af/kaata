import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TallyNoteAddedEvent, TallyNoteRemovedEvent } from "../events";
import { compile, declaration, fixture } from "./person-currency-selftest";
import { compileUI } from "./ui-fixture";

async function main() {
  const f = await fixture();
  try {
    f.sql.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER)");
    const { runMigration052, runMigration053 } = compile(
      `const MIGRATION_052="052_tally_notes";
       const MIGRATION_053="053_tally_note_number";
       ${declaration("../db", "columnExists")}
       export ${declaration("../db", "runMigration052")}
       export ${declaration("../db", "runMigration053")}`,
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
    f.sql
      .prepare(
        "INSERT INTO tally_notes(vault_id,relationship_id,id,note,created_at) VALUES ('v1',?,?,?,1)",
      )
      .run(ninjaRelationship, randomUUID(), "Note from before the number field");
    await runMigration053(f.tx);
    const [legacy] = await notes.listTallyNotes("v1", "person");
    assert.equal(legacy.note, "Note from before the number field");
    assert.equal(legacy.number, null);
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
    assert.equal(notes.normalizeTallyNoteNumber(" \n"), undefined);
    assert.equal(notes.normalizeTallyNoteNumber("۰۰۱۲٫۵۰"), "12.50");
    assert.equal(notes.normalizeTallyNoteNumber(",25"), "0.25");
    for (const invalid of ["-1", "1e2", "1٬000", "1.0000001", "1234567890123456789", "1.2.3"])
      assert.equal(notes.normalizeTallyNoteNumber(invalid), null, invalid);
    await assert.rejects(notes.addTallyNote("v2", "person", "Bad number", "1e2"), /number/);
    assert.equal(eventCount(), 0);
    const staleSession = await f.auth.captureCurrentSession();
    await f.auth.switchSession(staleSession.accountId, staleSession.jwt);
    await assert.rejects(
      notes.addTallyNote("v2", "person", "Opened before sign-in", undefined, staleSession),
      /session_changed/,
    );
    assert.equal(eventCount(), 0, "a rebound session cannot save an already-open form");
    await notes.addTallyNote("v2", "person", " \u0085I took 10 from Ahmad 🙂\n", "۱۰٫۰۰");
    const [added] = await notes.listTallyNotes("v2", "person");
    assert.equal(added.note, "I took 10 from Ahmad 🙂");
    assert.equal(added.number, "10.00");
    assert.equal(added.authorName, "Viewer");
    assert.equal(added.authorAccountId, "member");
    const written = f.rows().find((row) => row.event_id === added.id);
    assert.equal(written.target_id, written.event_id);
    assert.equal(written.relationship_id, relationship);
    const wire = f.wire(written);
    assert(wire.event_type === "tally_note_added");
    assert.equal(wire.payload.number, "10.00");
    assert.equal(
      f.signature.verifyEventSignature(wire, written.event_sig_b64, f.pubkey).valid,
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
      payload: { note: "Synced history", number: "123456789012345678.001230" },
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
      .prepare("SELECT note,number_text,removed_at,author_account_id FROM tally_notes WHERE id=?")
      .get(noteId);
    assert.deepEqual(tombstone, {
      note: "Synced history",
      number_text: "123456789012345678.001230",
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
    for (const number of ["", "01", ".5", "۲", "1\n", "1e2", 1, null])
      assert.equal(
        f.tallyNotePolicy.validTallyNoteEvent({ ...historyAdd, payload: { note: "Wire", number } }),
        false,
      );
    assert.deepEqual(f.sql.prepare("SELECT * FROM entries").all(), originalMoney);
    console.log(
      "PASS tally notes data: migration, signed optional numbers, active roles, scope, manager removal and sticky replay",
    );
  } finally {
    f.sql.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
