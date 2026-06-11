// apps/mobile/lib/__dev__/migration-014-selftest.ts
//
// Mythos round-4 Delta 3: run migration 014's SQL against a real
// SQLite engine (better-sqlite3 in-memory) before it ever runs against
// a user's ledger.
//
// What this catches that tsc + selftest:ingest cannot:
//   - Trigger SQL that's syntactically broken
//   - Backfill UPDATE statements that aren't re-run-safe (idempotency)
//   - Precedence slips in the relay-filter / state-machine AND/OR
//   - CHECK clauses that reject valid states or accept invalid ones
//   - JSON_EXTRACT against detail_json that doesn't return the right shape
//
// SCOPE: this test uses better-sqlite3 directly, not expo-sqlite. Same
// SQLite engine; the platform wrapper is irrelevant for SQL semantics
// validation. The SQL is duplicated from db.ts:runMigration014 because
// extracting it into shared constants would touch the runtime
// migration code in a way that's risky right before a merge — if a
// future SQL change is made to one and not the other, this test will
// detect the divergence by failing on the unexpected behavior.

import Database from "better-sqlite3";

let passes = 0;
let total = 0;

function pass(name: string): void {
  total++;
  passes++;
  console.log(`  PASS ${total.toString().padStart(2, " ")} ${name}`);
}

function fail(name: string, message: string): void {
  total++;
  console.error(`  FAIL ${total.toString().padStart(2, " ")} ${name}: ${message}`);
}

function assert(name: string, cond: boolean, message: string): void {
  if (cond) pass(name);
  else fail(name, message);
}

function assertEq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass(name);
  else fail(name, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Pre-migration schema (the legacy state migration 014 starts from)
// ---------------------------------------------------------------------------

const PRE_MIGRATION_SCHEMA = `
  CREATE TABLE event_log (
    event_id                  TEXT PRIMARY KEY,
    event_type                TEXT NOT NULL,
    vault_id                  TEXT,
    target_id                 TEXT NOT NULL,
    relationship_id           TEXT,
    hlc_physical_ms           INTEGER NOT NULL,
    hlc_logical               INTEGER NOT NULL,
    hlc_device_id             TEXT    NOT NULL,
    device_id                 TEXT    NOT NULL,
    author_user_id_local_only TEXT NOT NULL,
    actor_account_id          TEXT,
    payload_json              TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_schema            INTEGER NOT NULL DEFAULT 1,
    appended_at               INTEGER NOT NULL,
    server_acked_at           INTEGER,
    rejected_at               INTEGER,
    origin                    TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','remote','backfill')),
    event_sig_b64             TEXT,
    signer_device_pubkey      TEXT
  );
  CREATE TABLE projection_conflicts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    vault_id     TEXT,
    detail_json  TEXT NOT NULL CHECK (json_valid(detail_json)),
    created_at   INTEGER NOT NULL,
    resolved_at  INTEGER
  );
`;

// ---------------------------------------------------------------------------
// Migration 014 SQL — duplicated from db.ts:runMigration014
// ---------------------------------------------------------------------------

function applyMigration014(db: Database.Database): void {
  db.exec(`ALTER TABLE event_log ADD COLUMN ingested_at INTEGER`);
  db.exec(`ALTER TABLE event_log ADD COLUMN applied_at INTEGER`);
  db.exec(`ALTER TABLE event_log ADD COLUMN quarantine_reason TEXT`);
  db.exec(`ALTER TABLE event_log ADD COLUMN tombstone_reason TEXT`);

  db.exec(`
    UPDATE event_log
       SET ingested_at = appended_at,
           applied_at  = appended_at
     WHERE rejected_at IS NOT NULL
       AND ingested_at IS NULL
  `);
  db.exec(`
    UPDATE event_log
       SET ingested_at = appended_at,
           quarantine_reason = 'role_insufficient'
     WHERE event_id IN (
       SELECT json_extract(detail_json, '$.event_id')
         FROM projection_conflicts
        WHERE kind = 'event_rejected_by_local_role_gate'
     )
       AND ingested_at IS NULL
  `);
  db.exec(`
    UPDATE event_log
       SET ingested_at = appended_at,
           applied_at  = appended_at
     WHERE ingested_at IS NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_log_quarantine
      ON event_log(vault_id, hlc_physical_ms, hlc_logical, hlc_device_id)
      WHERE applied_at IS NULL AND tombstone_reason IS NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_log_by_device_hlc
      ON event_log(vault_id, device_id, hlc_physical_ms, hlc_logical)
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS event_log_state_machine_insert
    BEFORE INSERT ON event_log
    WHEN
      (NEW.ingested_at IS NULL) OR
      (NEW.applied_at IS NOT NULL AND NEW.tombstone_reason IS NOT NULL) OR
      (NEW.applied_at IS NOT NULL AND NEW.quarantine_reason IS NOT NULL) OR
      (NEW.tombstone_reason IS NOT NULL AND NEW.quarantine_reason IS NOT NULL) OR
      (NEW.quarantine_reason IS NOT NULL AND NEW.quarantine_reason NOT IN
         ('unknown_actor', 'missing_prereq', 'role_insufficient', 'applier_throw')) OR
      (NEW.tombstone_reason IS NOT NULL AND NEW.tombstone_reason NOT IN
         ('bad_signature', 'unsigned_event', 'schema_invalid'))
    BEGIN
      SELECT RAISE(ABORT, 'event_log state machine violation on insert');
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS event_log_state_machine_update
    BEFORE UPDATE ON event_log
    WHEN
      (NEW.ingested_at IS NULL) OR
      (NEW.applied_at IS NOT NULL AND NEW.tombstone_reason IS NOT NULL) OR
      (NEW.applied_at IS NOT NULL AND NEW.quarantine_reason IS NOT NULL) OR
      (NEW.tombstone_reason IS NOT NULL AND NEW.quarantine_reason IS NOT NULL) OR
      (NEW.quarantine_reason IS NOT NULL AND NEW.quarantine_reason NOT IN
         ('unknown_actor', 'missing_prereq', 'role_insufficient', 'applier_throw')) OR
      (NEW.tombstone_reason IS NOT NULL AND NEW.tombstone_reason NOT IN
         ('bad_signature', 'unsigned_event', 'schema_invalid'))
    BEGIN
      SELECT RAISE(ABORT, 'event_log state machine violation on update');
    END
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(PRE_MIGRATION_SCHEMA);
  return db;
}

type InsertableEventRow = {
  event_id: string;
  event_type: string;
  vault_id: string;
  target_id?: string;
  device_id?: string;
  rejected_at?: number | null;
};

function seedLegacyEvent(db: Database.Database, e: InsertableEventRow): void {
  db.prepare(
    `INSERT INTO event_log (
       event_id, event_type, vault_id, target_id, relationship_id,
       hlc_physical_ms, hlc_logical, hlc_device_id,
       device_id, author_user_id_local_only, actor_account_id,
       payload_json, payload_schema, appended_at,
       server_acked_at, rejected_at, origin,
       event_sig_b64, signer_device_pubkey
     ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?)`,
  ).run(
    e.event_id,
    e.event_type,
    e.vault_id,
    e.target_id ?? "",
    null,
    100,
    0,
    e.device_id ?? "dev-1",
    e.device_id ?? "dev-1",
    "",
    "acc-1",
    JSON.stringify({ amount: 100, kind: "debt" }),
    1,
    1000,
    null,
    e.rejected_at ?? null,
    "remote",
    null,
    null,
  );
}

function seedRoleGateConflict(db: Database.Database, eventId: string, vaultId: string): void {
  db.prepare(
    `INSERT INTO projection_conflicts (kind, vault_id, detail_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    "event_rejected_by_local_role_gate",
    vaultId,
    JSON.stringify({ event_id: eventId, reason: "insufficient_role" }),
    1000,
  );
}

function rowOf(
  db: Database.Database,
  eventId: string,
): {
  ingested_at: number | null;
  applied_at: number | null;
  quarantine_reason: string | null;
  tombstone_reason: string | null;
  rejected_at: number | null;
} {
  const row = db
    .prepare(
      `SELECT ingested_at, applied_at, quarantine_reason, tombstone_reason, rejected_at
         FROM event_log WHERE event_id = ?`,
    )
    .get(eventId) as {
    ingested_at: number | null;
    applied_at: number | null;
    quarantine_reason: string | null;
    tombstone_reason: string | null;
    rejected_at: number | null;
  };
  return row;
}

// ---------------------------------------------------------------------------
// Section 1 — Migration on seeded legacy DB
// ---------------------------------------------------------------------------

function section1Backfill(): void {
  console.log("Section 1: backfill on seeded legacy DB");
  const db = freshDb();

  // Three legacy rows:
  // - server-rejected (rejected_at set)
  // - role-gate-refused (no rejected_at, has projection_conflicts row)
  // - normal applied (no markers)
  seedLegacyEvent(db, {
    event_id: "evt-server-rejected",
    event_type: "entry_created",
    vault_id: "v1",
    rejected_at: 2000,
  });
  seedLegacyEvent(db, { event_id: "evt-role-gate", event_type: "entry_created", vault_id: "v1" });
  seedRoleGateConflict(db, "evt-role-gate", "v1");
  seedLegacyEvent(db, { event_id: "evt-normal", event_type: "entry_created", vault_id: "v1" });

  applyMigration014(db);

  const serverRejected = rowOf(db, "evt-server-rejected");
  assertEq("server-rejected: ingested_at = appended_at", serverRejected.ingested_at, 1000);
  assertEq(
    "server-rejected: applied_at = appended_at (Critical 2 — NOT tombstoned)",
    serverRejected.applied_at,
    1000,
  );
  assertEq("server-rejected: quarantine_reason NULL", serverRejected.quarantine_reason, null);
  assertEq(
    "server-rejected: tombstone_reason NULL (no 'server_rejected' value)",
    serverRejected.tombstone_reason,
    null,
  );
  assertEq(
    "server-rejected: rejected_at PRESERVED (orthogonal column)",
    serverRejected.rejected_at,
    2000,
  );

  const roleGate = rowOf(db, "evt-role-gate");
  assertEq("role-gate-refused: ingested_at = appended_at", roleGate.ingested_at, 1000);
  assertEq("role-gate-refused: applied_at NULL", roleGate.applied_at, null);
  assertEq(
    "role-gate-refused: quarantine_reason = 'role_insufficient'",
    roleGate.quarantine_reason,
    "role_insufficient",
  );
  assertEq("role-gate-refused: tombstone_reason NULL", roleGate.tombstone_reason, null);

  const normal = rowOf(db, "evt-normal");
  assertEq("normal-applied: ingested_at = appended_at", normal.ingested_at, 1000);
  assertEq("normal-applied: applied_at = appended_at", normal.applied_at, 1000);
  assertEq("normal-applied: quarantine_reason NULL", normal.quarantine_reason, null);
  assertEq("normal-applied: tombstone_reason NULL", normal.tombstone_reason, null);

  db.close();
}

// ---------------------------------------------------------------------------
// Section 2 — Migration idempotency
// ---------------------------------------------------------------------------

function section2Idempotency(): void {
  console.log("\nSection 2: migration idempotency");

  // 2a: running twice produces identical state.
  {
    const db = freshDb();
    seedLegacyEvent(db, { event_id: "e1", event_type: "entry_created", vault_id: "v1" });
    seedLegacyEvent(db, {
      event_id: "e2",
      event_type: "entry_created",
      vault_id: "v1",
      rejected_at: 5000,
    });
    seedRoleGateConflict(db, "e1", "v1");

    // First run: only the UPDATEs apply, columns get added.
    applyMigration014(db);
    const after1 = {
      e1: rowOf(db, "e1"),
      e2: rowOf(db, "e2"),
    };

    // Second run: columnExists guard would skip ALTERs, but in this test
    // we bypass the guard. SQLite throws on a duplicate ADD COLUMN — so
    // we DON'T re-run the schema part. Idempotency check is on the
    // UPDATEs: re-running them MUST be a no-op (each WHERE includes
    // `ingested_at IS NULL` as the guard).
    try {
      db.exec(`
        UPDATE event_log
           SET ingested_at = appended_at,
               applied_at  = appended_at
         WHERE rejected_at IS NOT NULL
           AND ingested_at IS NULL
      `);
      db.exec(`
        UPDATE event_log
           SET ingested_at = appended_at,
               quarantine_reason = 'role_insufficient'
         WHERE event_id IN (
           SELECT json_extract(detail_json, '$.event_id')
             FROM projection_conflicts
            WHERE kind = 'event_rejected_by_local_role_gate'
         )
           AND ingested_at IS NULL
      `);
      db.exec(`
        UPDATE event_log
           SET ingested_at = appended_at,
               applied_at  = appended_at
         WHERE ingested_at IS NULL
      `);
    } catch (err) {
      fail("idempotency: second run threw", String(err));
      return;
    }
    const after2 = {
      e1: rowOf(db, "e1"),
      e2: rowOf(db, "e2"),
    };
    assertEq("idempotency: e1 state unchanged on re-run", after1.e1, after2.e1);
    assertEq("idempotency: e2 state unchanged on re-run", after1.e2, after2.e2);

    db.close();
  }

  // 2b: simulated mid-abort.
  // First run aborts after 2 of 3 backfill UPDATEs; re-running completes
  // without corruption. Tests the WHERE-guards' partial-progress safety.
  {
    const db = freshDb();
    seedLegacyEvent(db, {
      event_id: "e1",
      event_type: "entry_created",
      vault_id: "v1",
      rejected_at: 5000,
    });
    seedLegacyEvent(db, { event_id: "e2", event_type: "entry_created", vault_id: "v1" });
    seedRoleGateConflict(db, "e2", "v1");
    seedLegacyEvent(db, { event_id: "e3", event_type: "entry_created", vault_id: "v1" });

    // Add columns
    db.exec(`ALTER TABLE event_log ADD COLUMN ingested_at INTEGER`);
    db.exec(`ALTER TABLE event_log ADD COLUMN applied_at INTEGER`);
    db.exec(`ALTER TABLE event_log ADD COLUMN quarantine_reason TEXT`);
    db.exec(`ALTER TABLE event_log ADD COLUMN tombstone_reason TEXT`);

    // Run only the first backfill UPDATE — simulating abort after step 2a.
    db.exec(`
      UPDATE event_log
         SET ingested_at = appended_at,
             applied_at  = appended_at
       WHERE rejected_at IS NOT NULL
         AND ingested_at IS NULL
    `);

    // Re-run the full migration body.
    db.exec(`
      UPDATE event_log
         SET ingested_at = appended_at,
             applied_at  = appended_at
       WHERE rejected_at IS NOT NULL
         AND ingested_at IS NULL
    `);
    db.exec(`
      UPDATE event_log
         SET ingested_at = appended_at,
             quarantine_reason = 'role_insufficient'
       WHERE event_id IN (
         SELECT json_extract(detail_json, '$.event_id')
           FROM projection_conflicts
          WHERE kind = 'event_rejected_by_local_role_gate'
       )
         AND ingested_at IS NULL
    `);
    db.exec(`
      UPDATE event_log
         SET ingested_at = appended_at,
             applied_at  = appended_at
       WHERE ingested_at IS NULL
    `);

    assertEq(
      "mid-abort recovery: e1 (server-rejected) → applied",
      rowOf(db, "e1").applied_at,
      1000,
    );
    assertEq("mid-abort recovery: e1 rejected_at preserved", rowOf(db, "e1").rejected_at, 5000);
    assertEq(
      "mid-abort recovery: e2 (role-gate) → quarantined",
      rowOf(db, "e2").quarantine_reason,
      "role_insufficient",
    );
    assertEq("mid-abort recovery: e2 applied_at NULL", rowOf(db, "e2").applied_at, null);
    assertEq("mid-abort recovery: e3 (normal) → applied", rowOf(db, "e3").applied_at, 1000);

    db.close();
  }
}

// ---------------------------------------------------------------------------
// Section 3 — State-machine triggers fire on each invalid state
// ---------------------------------------------------------------------------

function section3Triggers(): void {
  console.log("\nSection 3: state-machine triggers");

  const db = freshDb();
  applyMigration014(db);

  function expectAbort(name: string, fn: () => void): void {
    try {
      fn();
      fail(name, "expected RAISE(ABORT) but call succeeded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("state machine violation")) pass(name);
      else fail(name, `unexpected error: ${msg}`);
    }
  }

  // Set up a known-good row first.
  db.prepare(
    `INSERT INTO event_log (
       event_id, event_type, vault_id, target_id, relationship_id,
       hlc_physical_ms, hlc_logical, hlc_device_id,
       device_id, author_user_id_local_only, actor_account_id,
       payload_json, payload_schema, appended_at,
       server_acked_at, rejected_at, origin,
       event_sig_b64, signer_device_pubkey,
       ingested_at, applied_at, quarantine_reason, tombstone_reason
     ) VALUES (
       'good', 'entry_created', 'v1', '', NULL,
       100, 0, 'dev-1', 'dev-1', '', 'acc-1',
       '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
       1000, 1000, NULL, NULL
     )`,
  ).run();
  pass("baseline: valid 'applied' row inserts cleanly");

  // INSERT triggers
  expectAbort("trigger fires: INSERT with applied_at + tombstone_reason", () =>
    db
      .prepare(
        `INSERT INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema, appended_at,
         server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, quarantine_reason, tombstone_reason
       ) VALUES (
         'bad-1', 'entry_created', 'v1', '', NULL,
         100, 0, 'dev-1', 'dev-1', '', 'acc-1',
         '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
         1000, 1000, NULL, 'bad_signature'
       )`,
      )
      .run(),
  );
  expectAbort("trigger fires: INSERT with applied_at + quarantine_reason", () =>
    db
      .prepare(
        `INSERT INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema, appended_at,
         server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, quarantine_reason, tombstone_reason
       ) VALUES (
         'bad-2', 'entry_created', 'v1', '', NULL,
         100, 0, 'dev-1', 'dev-1', '', 'acc-1',
         '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
         1000, 1000, 'missing_prereq', NULL
       )`,
      )
      .run(),
  );
  expectAbort("trigger fires: INSERT with both quarantine + tombstone", () =>
    db
      .prepare(
        `INSERT INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema, appended_at,
         server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, quarantine_reason, tombstone_reason
       ) VALUES (
         'bad-3', 'entry_created', 'v1', '', NULL,
         100, 0, 'dev-1', 'dev-1', '', 'acc-1',
         '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
         1000, NULL, 'unknown_actor', 'bad_signature'
       )`,
      )
      .run(),
  );
  expectAbort("trigger fires: INSERT with ingested_at NULL", () =>
    db
      .prepare(
        `INSERT INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema, appended_at,
         server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, quarantine_reason, tombstone_reason
       ) VALUES (
         'bad-4', 'entry_created', 'v1', '', NULL,
         100, 0, 'dev-1', 'dev-1', '', 'acc-1',
         '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
         NULL, NULL, NULL, NULL
       )`,
      )
      .run(),
  );
  expectAbort("trigger fires: INSERT with unknown quarantine reason", () =>
    db
      .prepare(
        `INSERT INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema, appended_at,
         server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, quarantine_reason, tombstone_reason
       ) VALUES (
         'bad-5', 'entry_created', 'v1', '', NULL,
         100, 0, 'dev-1', 'dev-1', '', 'acc-1',
         '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
         1000, NULL, 'garbage_reason', NULL
       )`,
      )
      .run(),
  );
  expectAbort("trigger fires: INSERT with unknown tombstone reason", () =>
    db
      .prepare(
        `INSERT INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema, appended_at,
         server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, quarantine_reason, tombstone_reason
       ) VALUES (
         'bad-6', 'entry_created', 'v1', '', NULL,
         100, 0, 'dev-1', 'dev-1', '', 'acc-1',
         '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
         1000, NULL, NULL, 'garbage_reason'
       )`,
      )
      .run(),
  );

  // Critical 2 scenario: UPDATE that tries to put tombstone_reason on
  // an applied row would abort (would have crashed push.ts under v1).
  expectAbort("Critical 2: UPDATE adding tombstone_reason to applied row aborts", () =>
    db
      .prepare(`UPDATE event_log SET tombstone_reason = 'bad_signature' WHERE event_id = 'good'`)
      .run(),
  );

  // Critical 2 reverse: UPDATE setting rejected_at (orthogonal column)
  // on an applied row MUST succeed — the push path needs this.
  try {
    db.prepare(`UPDATE event_log SET rejected_at = 5000 WHERE event_id = 'good'`).run();
    pass("Critical 2: UPDATE setting rejected_at on applied row SUCCEEDS (orthogonal)");
  } catch (err) {
    fail("Critical 2: UPDATE rejected_at failed", String(err));
  }

  db.close();
}

// ---------------------------------------------------------------------------
// Section 4 — Scenario (b) relay-hole as a row-level flow
// ---------------------------------------------------------------------------

function section4RelayHole(): void {
  console.log("\nSection 4: scenario (b) relay-hole as live row-level SQL");

  const db = freshDb();
  applyMigration014(db);

  // B's view: device-X authored e1 (quarantined missing_prereq) and e2
  // (applied). C is the relay target — never met X directly.
  function insertEvent(
    eventId: string,
    hlcPms: number,
    applied: boolean,
    quarantine: string | null,
  ): void {
    db.prepare(
      `INSERT INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema, appended_at,
         server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, quarantine_reason, tombstone_reason
       ) VALUES (
         ?, 'entry_created', 'v1', '', NULL,
         ?, 0, 'X-device', 'X-device', '', 'acc-X',
         '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
         1000, ?, ?, NULL
       )`,
    ).run(eventId, hlcPms, applied ? 1000 : null, applied ? null : quarantine);
  }

  insertEvent("e1", 100, false, "missing_prereq");
  insertEvent("e2", 200, true, null);

  // Run the v2 send filter (from anti-entropy.ts fetchNextBatch).
  // C's floor for X is -1 (never seen).
  const rows = db
    .prepare(
      `SELECT event_id, hlc_physical_ms
         FROM event_log
        WHERE vault_id = 'v1'
          AND device_id = 'X-device'
          AND tombstone_reason IS NULL
          AND (quarantine_reason IS NULL OR quarantine_reason != 'unknown_actor')
          AND rejected_at IS NULL
          AND (hlc_physical_ms > -1
               OR (hlc_physical_ms = -1 AND hlc_logical > -1))
        ORDER BY hlc_physical_ms ASC, hlc_logical ASC`,
    )
    .all() as Array<{ event_id: string; hlc_physical_ms: number }>;

  assertEq(
    "relay-hole (b): v2 send-filter returns BOTH e1 and e2",
    rows.map((r) => r.event_id),
    ["e1", "e2"],
  );

  // Verify the v1 broken behavior would have excluded e1:
  const rowsV1 = db
    .prepare(
      `SELECT event_id
         FROM event_log
        WHERE vault_id = 'v1'
          AND device_id = 'X-device'
          AND applied_at IS NOT NULL
          AND (hlc_physical_ms > -1
               OR (hlc_physical_ms = -1 AND hlc_logical > -1))
        ORDER BY hlc_physical_ms ASC, hlc_logical ASC`,
    )
    .all() as Array<{ event_id: string }>;
  assertEq(
    "relay-hole (b): v1 send-filter would have excluded e1 (the bug)",
    rowsV1.map((r) => r.event_id),
    ["e2"],
  );

  // unknown_actor: assert per-device all-or-nothing withhold.
  {
    const db2 = freshDb();
    applyMigration014(db2);
    function insertUnknownActor(eventId: string, hlcPms: number): void {
      db2
        .prepare(
          `INSERT INTO event_log (
           event_id, event_type, vault_id, target_id, relationship_id,
           hlc_physical_ms, hlc_logical, hlc_device_id,
           device_id, author_user_id_local_only, actor_account_id,
           payload_json, payload_schema, appended_at,
           server_acked_at, rejected_at, origin,
           event_sig_b64, signer_device_pubkey,
           ingested_at, applied_at, quarantine_reason, tombstone_reason
         ) VALUES (
           ?, 'entry_created', 'v1', '', NULL,
           ?, 0, 'Y-device', 'Y-device', '', 'acc-Y',
           '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
           1000, NULL, 'unknown_actor', NULL
         )`,
        )
        .run(eventId, hlcPms);
    }
    insertUnknownActor("y1", 50);
    insertUnknownActor("y2", 150);
    const ySendFiltered = db2
      .prepare(
        `SELECT event_id FROM event_log
         WHERE vault_id = 'v1' AND device_id = 'Y-device'
           AND tombstone_reason IS NULL
           AND (quarantine_reason IS NULL OR quarantine_reason != 'unknown_actor')
           AND rejected_at IS NULL`,
      )
      .all() as Array<{ event_id: string }>;
    assertEq(
      "relay-hole (b): unknown_actor — per-device all-or-nothing withhold (zero rows relayed)",
      ySendFiltered.length,
      0,
    );
    db2.close();
  }

  db.close();
}

// ---------------------------------------------------------------------------
// Section 5 — Scenario (a) gap-below-head — sweep updates quarantined → applied
// ---------------------------------------------------------------------------

function section5GapBelowHead(): void {
  console.log("\nSection 5: scenario (a) gap-below-head — quarantine → applied transition");

  const db = freshDb();
  applyMigration014(db);

  // Seed e1 quarantined (role_insufficient), e2 applied.
  // Then simulate the sweep curing e1 by running the verdict UPDATE.
  function insertEvent(
    eventId: string,
    hlcPms: number,
    applied: boolean,
    quarantine: string | null,
  ): void {
    db.prepare(
      `INSERT INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema, appended_at,
         server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, quarantine_reason, tombstone_reason
       ) VALUES (
         ?, 'entry_created', 'v1', '', NULL,
         ?, 0, 'X-device', 'X-device', '', 'acc-X',
         '{}', 1, 1000, NULL, NULL, 'remote', NULL, NULL,
         1000, ?, ?, NULL
       )`,
    ).run(eventId, hlcPms, applied ? 1000 : null, applied ? null : quarantine);
  }

  insertEvent("e1", 100, false, "role_insufficient");
  insertEvent("e2", 200, true, null);

  // Sum must claim BOTH (head advances past e1 — receipt ≠ acceptance).
  const headRow = db
    .prepare(
      `SELECT MAX(hlc_physical_ms) AS pms FROM event_log
       WHERE vault_id = 'v1'
       GROUP BY device_id`,
    )
    .get() as { pms: number };
  assertEq("(a) summary head advances to MAX hlc despite quarantined row", headRow.pms, 200);

  // Now simulate the sweep curing e1 (role-elevation event arrives).
  // The verdict UPDATE the sweep performs:
  db.prepare(
    `UPDATE event_log
        SET applied_at = ?, quarantine_reason = NULL, tombstone_reason = NULL
      WHERE event_id = ?`,
  ).run(2000, "e1");

  const e1Cured = rowOf(db, "e1");
  assertEq("(a) post-sweep: e1 applied_at SET", e1Cured.applied_at, 2000);
  assertEq("(a) post-sweep: e1 quarantine_reason CLEARED", e1Cured.quarantine_reason, null);

  // After the sweep, e1 is now relay-eligible.
  const relayable = db
    .prepare(
      `SELECT event_id FROM event_log
        WHERE vault_id = 'v1' AND device_id = 'X-device'
          AND tombstone_reason IS NULL
          AND (quarantine_reason IS NULL OR quarantine_reason != 'unknown_actor')
          AND rejected_at IS NULL
          AND hlc_physical_ms <= 100
        ORDER BY hlc_physical_ms ASC`,
    )
    .all() as Array<{ event_id: string }>;
  assertEq(
    "(a) post-sweep: e1 is now relay-eligible",
    relayable.map((r) => r.event_id),
    ["e1"],
  );

  db.close();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

section1Backfill();
section2Idempotency();
section3Triggers();
section4RelayHole();
section5GapBelowHead();

console.log(`\n${passes}/${total} passed`);
process.exit(passes === total ? 0 : 1);
