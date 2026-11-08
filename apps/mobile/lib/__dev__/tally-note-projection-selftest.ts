import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LedgerEvent } from "../events";
import { compile, declaration, fixture } from "./person-currency-selftest";
import { compileUI } from "./ui-fixture";

const corpus = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../_shared/projection-corpus/09_tally_notes.json"),
    "utf8",
  ),
) as {
  events: LedgerEvent[];
  expected_projection: {
    entries: Record<string, { id: string; amount_afn: number; note: string }>;
  };
  expected_tally_notes: Array<{ id: string; vault_id: string; relationship_id: string }>;
};

const migration = compile(
  `const MIGRATION_052 = "052_tally_notes";
   const MIGRATION_053 = "053_tally_note_number";
   ${declaration("../db", "columnExists")}
   export ${declaration("../db", "runMigration052")}
   export ${declaration("../db", "runMigration053")}`,
  (name) => {
    throw new Error(`Unexpected note migration dependency ${name}`);
  },
);
const policy = compileUI("../tally-note-policy", {
  "./digits": require("../digits"),
  "./effective-account": {},
  "./events": require("../events"),
  "./vault-roles": require("../vault-roles"),
});
const { applyTallyNote } = compileUI("../projection/tally_notes", {
  "../tally-note-policy": policy,
  "./errors": require("../projection/errors"),
}) as typeof import("../projection/tally_notes");

async function main() {
  const f = await fixture();
  try {
    f.sql.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER)");
    await migration.runMigration052(f.tx);
    await migration.runMigration053(f.tx);
    const [person, tally, ...notes] = corpus.events;
    assert.equal(person.event_type, "person_added");
    assert.equal(tally.event_type, "entry_created");
    f.sql.prepare("INSERT INTO vaults(id,currency) VALUES(?,'AFN')").run(person.vault_id);
    await f.persons.applyPersonAdded(f.tx, person);
    await f.entries.applyEntryCreated(f.tx, tally);

    const moneyBefore = f.sql.prepare("SELECT * FROM entries ORDER BY id").all();
    for (const entry of Object.values(corpus.expected_projection.entries)) {
      assert.deepEqual(
        f.sql.prepare("SELECT id,amount_afn,note FROM entries WHERE id=?").get(entry.id),
        { id: entry.id, amount_afn: entry.amount_afn, note: entry.note },
      );
    }

    // Apply in delivery order, including a removal before its note arrives.
    for (const event of [...notes, ...notes]) {
      await applyTallyNote(f.tx, event, event.actor_account_id);
    }
    assert.deepEqual(f.sql.prepare("SELECT * FROM entries ORDER BY id").all(), moneyBefore);
    for (const expected of corpus.expected_tally_notes) {
      const actual = f.sql
        .prepare("SELECT * FROM tally_notes WHERE vault_id=? AND relationship_id=? AND id=?")
        .get(expected.vault_id, expected.relationship_id, expected.id) as Record<string, unknown>;
      assert.ok(actual, `Projected note ${expected.id}`);
      for (const [field, value] of Object.entries(expected))
        assert.equal(actual[field], value, field);
    }
    assert.deepEqual(f.sql.prepare("SELECT id FROM tally_notes WHERE removed_at IS NULL").all(), [
      { id: notes[0].target_id },
    ]);
    await assert.rejects(
      applyTallyNote(f.tx, { ...notes[0], vault_id: "v2" }),
      /relationship has not arrived/,
    );
    console.log("PASS shared tally note corpus: attribution, sticky deletion and unchanged money");
  } finally {
    f.sql.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
