// Run with: npm run selftest:person-save
// Synthetic fixtures only: never opens kaata.db, a device, or a user backup.
//
// Uses ACTUAL db.createPerson/createEntry, phone normalization, append helpers,
// HLC/event signing, applyEvent transactions, projection appliers, and usage
// counter SQL. Native SQLite is adapted to installed better-sqlite3 in memory.
// OS contacts, backup/health, role authorization, and background notifications
// are stubbed; this is a save-transaction regression, not an authorization or
// native-contact-permission test. No migrations are run or duplicated here.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import type { SQLiteTx } from "../db-tx";

let fixture: Database.Database;
let failUsageKey: string | null = null;
let failedUsageWrites = 0;
let failEventType: string | null = null;
let failRelationshipProjection = false;
let failDiagnosticWrite = false;
let contactWrites = 0;
const usageFailure = new Error("synthetic usage-counter write failure");
const appendFailure = new Error("synthetic event-log write failure");
const projectionFailure = new Error("synthetic relationship projection failure");

const sqlite = {
  execAsync: async (sql: string) => {
    fixture.exec(sql);
  },
  runAsync: async (sql: string, ...args: unknown[]) => {
    if (
      failDiagnosticWrite &&
      /INSERT INTO app_meta/i.test(sql) &&
      args[0] === "last_person_save_error"
    ) {
      throw new Error("synthetic diagnostic storage failure");
    }
    if (/INSERT INTO app_meta/i.test(sql) && args[0] === failUsageKey) {
      assert.equal(fixture.inTransaction, false, "counter fails after ledger commit");
      assert.ok(count("event_log") > 0, "a durable event precedes the counter");
      failedUsageWrites++;
      throw usageFailure;
    }
    if (/INSERT OR IGNORE INTO event_log/i.test(sql) && args[1] === failEventType) {
      throw appendFailure;
    }
    if (failRelationshipProjection && /INSERT OR IGNORE INTO relationships/i.test(sql)) {
      throw projectionFailure;
    }
    return fixture.prepare(sql).run(...args);
  },
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
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
} as unknown as SQLiteTx;

const savedModules = new Map<string, NodeJS.Module | undefined>();
function stub(name: string, exports: unknown): void {
  const filename = require.resolve(name);
  savedModules.set(filename, require.cache[filename]);
  // __esModule so a dynamic import() of the stubbed path sees the named
  // exports instead of wrapping the whole object as `default`.
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: { __esModule: true, ...(exports as object) },
  } as NodeJS.Module;
}

// Keep stubs installed for lazy post-commit imports too. Each selftest runs in
// its own Node process; restore the module cache before exiting nevertheless.
stub("expo-crypto", { randomUUID, getRandomBytes: (n: number) => randomBytes(n) });
stub("expo-sqlite", { openDatabaseAsync: async () => sqlite });
// Loading the real signature module initializes Noble's synchronous hash shim.
require("../event-sig");
const privateKey = new Uint8Array(32).fill(9); // Public synthetic test key.
const publicKey = Buffer.from(ed.getPublicKey(privateKey)).toString("base64");
// Mirrors the real module's typed failure so applyEvent's instanceof check
// (imported from the stubbed module path) sees the same class.
class DeviceKeyUnavailableError extends Error {
  readonly kind = "device_key_unavailable" as const;
  constructor(readonly reason: string) {
    super(`synthetic device key unavailable (${reason})`);
    this.name = "DeviceKeyUnavailableError";
  }
}
let signerUnavailable: string | null = null;
stub("../mesh/device-key", {
  DeviceKeyUnavailableError,
  getDevicePubkey: () => publicKey,
  ensureDeviceKey: async () => ({ pubkey_b64: publicKey }),
  readOwnDevicePubkeys: async () => ({ current: publicKey, retired: [] }),
  isOwnDevicePubkey: async (pub: string | null) => pub === publicKey,
  getDeviceSigner: async () => {
    // The whole repair story depends on the signer being taken OUTSIDE the
    // SQLite transaction (device-key.ts refuses to repair inside one).
    assert.equal(fixture.inTransaction, false, "signer snapshot must be taken outside the tx");
    if (signerUnavailable) throw new DeviceKeyUnavailableError(signerUnavailable);
    return { pubkey_b64: publicKey, sign: async (bytes: Uint8Array) => ed.sign(bytes, privateKey) };
  },
  signWithDeviceKey: async (bytes: Uint8Array) => {
    assert.equal(
      fixture.inTransaction,
      false,
      "SecureStore-backed signing must stay outside the tx",
    );
    return ed.sign(bytes, privateKey);
  },
});
stub("../projection/role-gate", { checkRoleForEvent: async () => ({ ok: true }) });
stub("../contacts-sync", {
  joinName: (first: string, last: string | null) =>
    [first.trim(), last?.trim()].filter(Boolean).join(" "),
  upsertPersonInPhoneBook: async () => {
    contactWrites++;
  },
});
stub("../db-health", { assertLedgerReadable: () => {} });
stub("../db-backup", { deleteLocalBackups: async () => {} });
stub("../checkin-trigger", { requestImmediateCheckIn: () => {} });
stub("../projection-conflicts", { notifyProjectionConflictsChanged: () => {} });
stub("../use-vault-role", { invalidateVaultRoleCache: () => {} });
stub("../projection/sweep", { scheduleSweep: () => {} });
stub("../ledger-events", { emitLedgerApplied: () => {} });

const db = require("../db") as typeof import("../db");
const dbTx = require("../db-tx") as typeof import("../db-tx");
const { normalizePhone } = require("../phone") as typeof import("../phone");

function count(table: "users" | "relationships" | "entries" | "event_log"): number {
  const where = table === "users" ? " WHERE is_local_self = 0" : "";
  return (fixture.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get() as { n: number }).n;
}

function openFixture(): void {
  fixture = new Database(":memory:");
  fixture.pragma("foreign_keys = ON");
  // Only columns touched by the actual save path. Keeping real FK constraints
  // lets the projection rollback test catch partial user/relationship writes.
  fixture.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE vaults (id TEXT PRIMARY KEY);
    CREATE TABLE users (
      id TEXT PRIMARY KEY, phone_e164 TEXT, display_name TEXT NOT NULL,
      is_local_self INTEGER NOT NULL, google_sub TEXT, account_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      archived_at INTEGER, field_hlcs TEXT
    );
    CREATE TABLE relationships (
      id TEXT PRIMARY KEY, user_a_id TEXT NOT NULL REFERENCES users(id),
      user_b_id TEXT NOT NULL REFERENCES users(id), context TEXT NOT NULL,
      vault_id TEXT NOT NULL REFERENCES vaults(id), created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, archived_at INTEGER, field_hlcs TEXT
    );
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id),
      relationship_id TEXT NOT NULL REFERENCES relationships(id),
      type TEXT NOT NULL, amount_afn INTEGER NOT NULL, note TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      proposed_by_user_id TEXT REFERENCES users(id), current_event_id TEXT,
      is_deleted INTEGER NOT NULL, is_settled INTEGER NOT NULL,
      accepted_at INTEGER, disputed_at INTEGER, disputed_reason TEXT,
      settled_at INTEGER, deleted_at INTEGER, field_hlcs TEXT
    );
    CREATE TABLE event_log (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, vault_id TEXT,
      target_id TEXT NOT NULL, relationship_id TEXT,
      hlc_physical_ms INTEGER NOT NULL, hlc_logical INTEGER NOT NULL,
      hlc_device_id TEXT NOT NULL, device_id TEXT NOT NULL,
      author_user_id_local_only TEXT NOT NULL, actor_account_id TEXT,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_schema INTEGER NOT NULL,
      appended_at INTEGER NOT NULL, server_acked_at INTEGER, rejected_at INTEGER,
      origin TEXT NOT NULL, event_sig_b64 TEXT, signer_device_pubkey TEXT,
      ingested_at INTEGER NOT NULL, applied_at INTEGER, author_seq INTEGER,
      quarantine_reason TEXT, UNIQUE(vault_id, device_id, author_seq)
    );
    -- createEntry asks whether the contact is linked to a mutual tab before it
    -- appends (lib/db.ts → lib/tabs/db.ts getTabLinkForPerson); only the
    -- columns that lookup reads. Nothing here ever inserts a link, so every
    -- save below takes the local path exactly as before migration 028.
    CREATE TABLE tab_links (
      tab_id TEXT PRIMARY KEY, relationship_id TEXT NOT NULL, closed_at INTEGER
    );
    INSERT INTO vaults VALUES ('fixture-vault');
    INSERT INTO users VALUES ('fixture-self', '+93700111222', 'Synthetic Owner', 1,
      NULL, NULL, 1, 1, NULL, NULL);
  `);
  failUsageKey = null;
  failedUsageWrites = 0;
  failEventType = null;
  failRelationshipProjection = false;
  failDiagnosticWrite = false;
  contactWrites = 0;
  signerUnavailable = null;
  dbTx._resetDbHandleForReset();
  dbTx.setInstallIdCache("fixture-device");
  dbTx.setLocalSelfUserIdCache("fixture-self");
  dbTx.setActiveVaultIdCache("fixture-vault");
  dbTx.setAccountIdCache(null);
}

function savedPhone(id: string): string | null {
  return (
    fixture.prepare("SELECT phone_e164 FROM users WHERE id = ?").get(id) as {
      phone_e164: string | null;
    }
  ).phone_e164;
}

function eventPayload(type: string): Record<string, unknown> {
  const row = fixture
    .prepare("SELECT payload_json, event_sig_b64, applied_at FROM event_log WHERE event_type = ?")
    .get(type) as {
    payload_json: string;
    event_sig_b64: string;
    applied_at: number;
  };
  assert.ok(row.event_sig_b64, "actual append signs the event");
  assert.ok(row.applied_at > 0, "event and projection are committed together");
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

function freshDiagnostics(): typeof import("../person-save-error") {
  // Simulate another app process so read tests do not see a prior RAM fallback.
  delete require.cache[require.resolve("../person-save-error")];
  return require("../person-save-error") as typeof import("../person-save-error");
}

let passed = 0;
let failed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  openFixture();
  try {
    await run();
    console.log(`PASS ${++passed}: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`, error);
  } finally {
    fixture.close();
  }
}

async function main(): Promise<void> {
  for (const input of [
    "0412345678",
    "412345678",
    "+61412345678",
    "0061412345678",
    "+61 (0) 412 345 678",
    "۰۴۱۲۳۴۵۶۷۸",
  ]) {
    await test(`AU synthetic phone preserves canonical identity: ${input}`, async () => {
      assert.equal(normalizePhone(input, "AU"), "+61412345678");
      const result = await db.createPerson("Synthetic", "Contact", input, "AU");
      assert.equal(result.ok, true);
      assert.equal(savedPhone(result.id), "+61412345678");
      assert.equal(eventPayload("person_added").phone_e164, "+61412345678");
      assert.equal(count("users"), 1);
      assert.equal(count("relationships"), 1);
      assert.equal(count("event_log"), 1);
    });
  }
  await test("AF national input and explicit foreign prefix with AF selected remain supported", async () => {
    assert.equal(normalizePhone("0701234567", "AF"), "+93701234567");
    assert.equal(normalizePhone("۰۷۰۱۲۳۴۵۶۷", "AF"), "+93701234567");
    const af = await db.createPerson("Synthetic", "Afghan", "0701234567", "AF");
    assert.ok(af.ok);
    assert.equal(savedPhone(af.id), "+93701234567");
    const au = await db.createPerson("Synthetic", "Australian", "+61 412 345 678", "AF");
    assert.ok(au.ok);
    assert.equal(savedPhone(au.id), "+61412345678");
  });
  await test("invalid and self phones return structured errors without a write", async () => {
    assert.deepEqual(await db.createPerson("Synthetic", null, "123", "AU"), {
      ok: false,
      error: "phone_invalid",
    });
    assert.deepEqual(await db.createPerson("Synthetic", null, "0700111222", "AF"), {
      ok: false,
      error: "phone_is_self",
    });
    assert.equal(count("users"), 0);
    assert.equal(count("relationships"), 0);
    assert.equal(count("event_log"), 0);
    assert.equal(contactWrites, 0);
  });
  await test("phone conflict identifies the existing person without creating duplicates", async () => {
    const first = await db.createPerson("Synthetic", "Existing", "0412345678", "AU");
    assert.ok(first.ok);
    const retry = await db.createPerson("Synthetic", "Retry", "412345678", "AU");
    assert.deepEqual(retry, {
      ok: false,
      error: "phone_conflict",
      existing: { id: first.id, name: "Synthetic Existing" },
    });
    assert.equal(count("users"), 1);
    assert.equal(count("event_log"), 1);
  });
  await test("post-commit contact usage failure still returns success with phone and event preserved", async () => {
    failUsageKey = "usage_pending_customers_added";
    const result = await db.createPerson("Synthetic", "Saved", "0412345678", "AU");
    assert.ok(result.ok);
    assert.equal(failedUsageWrites, 1, "exact usage SQL was exercised");
    assert.equal(savedPhone(result.id), "+61412345678");
    assert.equal(eventPayload("person_added").phone_e164, "+61412345678");
    assert.equal(count("users"), 1);
    assert.equal(count("relationships"), 1);
    assert.equal(count("event_log"), 1);
    const retry = await db.createPerson("Synthetic", "Retry", "+61412345678", "AU");
    assert.deepEqual(retry, {
      ok: false,
      error: "phone_conflict",
      existing: { id: result.id, name: "Synthetic Saved" },
    });
    assert.equal(failedUsageWrites, 1);
    assert.equal(count("event_log"), 1);
  });
  await test("actual person append failure rejects and leaves no success or partial rows", async () => {
    failEventType = "person_added";
    await assert.rejects(
      db.createPerson("Synthetic", "Failed", "0412345678", "AU"),
      (error) => error === appendFailure,
    );
    assert.equal(count("users"), 0);
    assert.equal(count("relationships"), 0);
    assert.equal(count("event_log"), 0);
    assert.equal(contactWrites, 0);
    assert.equal(await db.getAppMeta("usage_pending_customers_added"), null);
  });
  await test("actual relationship projection failure rolls back the person and signed event", async () => {
    failRelationshipProjection = true;
    await assert.rejects(
      db.createPerson("Synthetic", "Failed", "0412345678", "AU"),
      (error) => error === projectionFailure,
    );
    assert.equal(count("users"), 0);
    assert.equal(count("relationships"), 0);
    assert.equal(count("event_log"), 0);
    assert.equal(await db.getAppMeta("hlc_last"), null);
  });
  await test("missing device signing key surfaces as EventSigningUnavailableError with no rows", async () => {
    // The restored-phone shape: app_meta still mirrors a pubkey, SecureStore
    // has no seed. Before the fix this reached the generic "Couldn't save.
    // Try again." branch; now the typed error names it and nothing is written.
    const { EventSigningUnavailableError } =
      require("../projection/index") as typeof import("../projection/index");
    signerUnavailable = "missing";
    await assert.rejects(
      db.createPerson("Synthetic", "Unsigned", "0412345678", "AU"),
      (error) => error instanceof EventSigningUnavailableError && /missing/.test(String(error)),
    );
    assert.equal(count("users"), 0);
    assert.equal(count("relationships"), 0);
    assert.equal(count("event_log"), 0);
    assert.equal(contactWrites, 0);
    assert.equal(await db.getAppMeta("usage_pending_customers_added"), null);
    assert.equal(await db.getAppMeta("hlc_last"), null);
    // Same device, key repaired (the pre-warm heals outside the tx): the very
    // next tap succeeds — no relaunch, no reinstall.
    signerUnavailable = null;
    const saved = await db.createPerson("Synthetic", "Unsigned", "0412345678", "AU");
    assert.ok(saved.ok);
    assert.equal(count("event_log"), 1);
  });
  await test("post-commit entry usage failure returns its durable decimal entry id", async () => {
    const person = await db.createPerson("Synthetic", "Entry", "0412345678", "AU");
    assert.ok(person.ok);
    failUsageKey = "usage_pending_entries_created";
    const entryId = await db.createEntry(person.id, "debt", 12.34, "Synthetic tally");
    assert.equal(failedUsageWrites, 1);
    assert.equal(count("entries"), 1);
    assert.equal(count("event_log"), 2);
    assert.deepEqual(fixture.prepare("SELECT id, amount_afn, note FROM entries").get(), {
      id: entryId,
      amount_afn: 12.34,
      note: "Synthetic tally",
    });
    assert.equal(eventPayload("entry_created").amount_afn, 12.34);
  });
  await test("actual entry append failure rejects without creating an entry", async () => {
    const person = await db.createPerson("Synthetic", "Entry", "0412345678", "AU");
    assert.ok(person.ok);
    failEventType = "entry_created";
    await assert.rejects(
      db.createEntry(person.id, "debt", 12.34, null),
      (error) => error === appendFailure,
    );
    assert.equal(count("entries"), 0);
    assert.equal(count("event_log"), 1);
    assert.equal(await db.getAppMeta("usage_pending_entries_created"), null);
  });
  await test("save diagnostics classify storage and identity errors without persisting contact content", async () => {
    const diagnostic = freshDiagnostics();
    for (const [message, expected] of [
      ["SQLITE_FULL: database or disk is full", "storage_full"],
      ["database is locked", "storage_busy"],
      ["cannot start a transaction within a transaction", "storage_busy"],
      ["SQLITE_CONSTRAINT: UNIQUE constraint failed", "storage_constraint"],
      ["disk I/O error", "storage_io"],
      ["no such column: fixture_column", "schema"],
      ["active_vault_id not cached", "identity_not_ready"],
      ["local user not yet created", "identity_not_ready"],
      [
        "cannot append event: no local-self user — onboarding must complete before any entry write",
        "identity_not_ready",
      ],
      ["Unclassified synthetic failure", "unknown"],
    ] as const)
      assert.equal(diagnostic.classifyPersonSaveError(new Error(message)), expected);
    assert.equal(diagnostic.classifyPersonSaveError({ private: "Synthetic Contact" }), "unknown");
    const malformedError = Object.defineProperty(new Error(), "message", {
      value: { private: "Synthetic Contact" },
    });
    assert.equal(diagnostic.classifyPersonSaveError(malformedError), "unknown");
    const code = diagnostic.classifyPersonSaveError(
      new Error("Synthetic Contact +61412345678: SQLITE_BUSY"),
    );
    await diagnostic.recordPersonSaveError(code, "create_person");
    const raw = await db.getAppMeta("last_person_save_error");
    assert.ok(raw);
    const stored = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored).sort(), ["at", "code", "stage"]);
    assert.equal(stored.code, "storage_busy");
    assert.equal(stored.stage, "create_person");
    assert.equal(typeof stored.at, "number");
    assert.doesNotMatch(raw, /Synthetic|61412345678|SQLITE_BUSY/);
    assert.deepEqual(await freshDiagnostics().getLastPersonSaveError(), stored);
  });
  await test("save diagnostics reject corrupt stored shapes and discard unrelated fields", async () => {
    for (const raw of [
      "not-json",
      "null",
      "[]",
      '{"code":"arbitrary secret","stage":"create_person","at":1}',
      '{"code":"storage_busy","stage":"arbitrary secret","at":1}',
      '{"code":"storage_busy","stage":"create_person","at":"1"}',
    ]) {
      await db.setAppMeta("last_person_save_error", raw);
      assert.equal(await freshDiagnostics().getLastPersonSaveError(), null);
    }
    await db.setAppMeta(
      "last_person_save_error",
      JSON.stringify({
        code: "storage_busy",
        stage: "create_person",
        at: 1,
        contact: "Synthetic Contact",
        phone: "+61412345678",
      }),
    );
    assert.deepEqual(await freshDiagnostics().getLastPersonSaveError(), {
      code: "storage_busy",
      stage: "create_person",
      at: 1,
    });
  });
  await test("save diagnostics retain a safe in-memory fallback when storage fails", async () => {
    const diagnostic = freshDiagnostics();
    failDiagnosticWrite = true;
    await diagnostic.recordPersonSaveError("storage_full", "create_person");
    assert.equal(await db.getAppMeta("last_person_save_error"), null);
    const fallback = await diagnostic.getLastPersonSaveError();
    assert.ok(fallback);
    assert.equal(fallback.code, "storage_full");
    assert.equal(fallback.stage, "create_person");
    assert.equal(typeof fallback.at, "number");
    assert.deepEqual(Object.keys(fallback).sort(), ["at", "code", "stage"]);
  });
  console.log(`\n${passed} person-save regressions passed; ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const [filename, previous] of savedModules) {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    }
  });
