// Run with: npm run selftest:tabs
// Synthetic fixtures only: never opens kaata.db, a device, or a user backup.
//
// Pins the mutual-tab data layer (docs/mutual-tab-design.md §4):
//   - direction mapping for both roles and the balance rule, against
//     apps/_shared/tab-vectors.json — the SAME vectors the Go service test
//     loads. tabBalanceSql is pinned twice: by exact text, and by EXECUTING
//     it on the migration-028 tables and comparing with the JS oracle.
//   - wire ⇄ hundredths conversion without floats ("0.10" + "0.20" = "0.30",
//     the MAX_ENTRY_AMOUNT edge, sign, trailing-zero trimming).
//   - migration 028's DDL, extracted from lib/db.ts source so the fixture is
//     the shipped schema (like money-selftest pins FIELD_HLC_INIT).
//   - upsertTabFromWire merge semantics: full vs incremental, optimistic-row
//     survival and clearing, the notifier counts, cursor monotonicity.
//   - the outbox: order, backoff ladder, verdict-vs-transient handling — by
//     running the REAL lib/tabs/sync.ts against an in-memory fake of the
//     /v1/tabs server (global fetch), including the authenticated legacy-party claim,
//     per-tab coalescing, the 300 ms debounce and /mine reconcile.
//   - the read-site integration in the REAL lib/db.ts (people balance CASE,
//     listEntries routing, the immutability guards, the export UNION).
// Native Expo adapters are replaced at the Node module boundary, exactly as
// person-save-selftest does; lib/tabs/link.ts (react-native Linking, the
// role hook) is deliberately out of scope here.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { SQLiteTx } from "../db-tx";
import type { Entry } from "../types";
import type { TabLink, TabResponse, TabRole, WireEntry, WireTab } from "../tabs/types";

// App code guards dev logging with the bundler-provided __DEV__; Node has none.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// ---------------------------------------------------------------------------
// Fixture database + Expo SQLite adapter (person-save-selftest shape)

let fixture: Database.Database;

const sqlite = {
  execAsync: async (sql: string) => {
    fixture.exec(sql);
  },
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
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
  closeAsync: async () => {},
} as unknown as SQLiteTx;

const savedModules = new Map<string, NodeJS.Module | undefined>();
function stub(name: string, exports: unknown): void {
  const filename = require.resolve(name);
  savedModules.set(filename, require.cache[filename]);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: { __esModule: true, ...(exports as object) },
  } as NodeJS.Module;
}

const session = { jwt: null as string | null };
const net = { connected: true };
const ledgerEmits: Array<{ vaultId: string; origin: string }> = [];

stub("expo-crypto", { randomUUID, getRandomBytes: (n: number) => randomBytes(n) });
stub("expo-sqlite", { openDatabaseAsync: async () => sqlite });
stub("react-native", {
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Linking: { openURL: async () => {} },
  Platform: { OS: "android" },
});
stub("expo-network", { getNetworkStateAsync: async () => ({ isConnected: net.connected }) });
stub("../auth", { getSessionJWT: async () => session.jwt });
stub("../api", { getBackendUrl: async () => "http://tabs.fixture" });
stub("../ledger-events", {
  emitLedgerApplied: (vaultId: string, origin: string) => {
    ledgerEmits.push({ vaultId, origin });
  },
});
// The rest is what loading the real lib/db.ts + lib/event-log.ts needs.
const publicKey = "c3ludGhldGljLXB1YmtleQ==";
stub("../mesh/device-key", {
  DeviceKeyUnavailableError: class extends Error {},
  getDevicePubkey: () => publicKey,
  ensureDeviceKey: async () => ({ pubkey_b64: publicKey }),
  readOwnDevicePubkeys: async () => ({ current: publicKey, retired: [] }),
  isOwnDevicePubkey: async (pub: string | null) => pub === publicKey,
  getDeviceSigner: async () => ({ pubkey_b64: publicKey, sign: async () => new Uint8Array(64) }),
  signWithDeviceKey: async () => new Uint8Array(64),
});
stub("../projection/role-gate", { checkRoleForEvent: async () => ({ ok: true }) });
stub("../contacts-sync", {
  joinName: (first: string, last: string | null) =>
    [first.trim(), last?.trim()].filter(Boolean).join(" "),
  upsertPersonInPhoneBook: async () => {},
});
stub("../db-health", { assertLedgerReadable: () => {} });
stub("../db-backup", { deleteLocalBackups: async () => {} });
stub("../checkin-trigger", { requestImmediateCheckIn: () => {} });
stub("../projection-conflicts", { notifyProjectionConflictsChanged: () => {} });
stub("../use-vault-role", { invalidateVaultRoleCache: () => {} });
stub("../projection/sweep", { scheduleSweep: () => {} });

const direction = require("../tabs/direction") as typeof import("../tabs/direction");
const wire = require("../tabs/wire") as typeof import("../tabs/wire");
const errors = require("../tabs/errors") as typeof import("../tabs/errors");
const events = require("../tabs/events") as typeof import("../tabs/events");
const tabsDb = require("../tabs/db") as typeof import("../tabs/db");
const sync = require("../tabs/sync") as typeof import("../tabs/sync");
const db = require("../db") as typeof import("../db");
const eventLog = require("../event-log") as typeof import("../event-log");
const dbTx = require("../db-tx") as typeof import("../db-tx");

// The shipped DDL, lifted from the migration itself so this fixture cannot
// drift from what initDb() creates.
const dbSource = readFileSync(require.resolve("../db"), "utf8");
const MIGRATION_028_DDL = /execAsync\(`([^`]*CREATE TABLE IF NOT EXISTS tab_links[^`]*)`\)/.exec(
  dbSource,
)?.[1];
assert.ok(MIGRATION_028_DDL, "migration 028 DDL is one execAsync block in lib/db.ts");
const MIGRATION_029_DDL =
  /execAsync\(`([^`]*CREATE TABLE IF NOT EXISTS tab_failed_ops[^`]*)`\)/.exec(dbSource)?.[1];
assert.ok(MIGRATION_029_DDL, "migration 029 preserves refused offline intent");

const VAULT = "fixture-vault";
const SELF = "fixture-self";
const CONTACT = "fixture-contact";
const REL = "fixture-rel";
const TAB = "fixture-tab";

function openFixture(): void {
  fixture = new Database(":memory:");
  fixture.pragma("foreign_keys = ON");
  fixture.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE vaults (id TEXT PRIMARY KEY, currency TEXT NOT NULL DEFAULT 'AFN');
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
      is_deleted INTEGER NOT NULL DEFAULT 0, is_settled INTEGER NOT NULL DEFAULT 0,
      accepted_at INTEGER, disputed_at INTEGER, disputed_reason TEXT,
      settled_at INTEGER, deleted_at INTEGER, field_hlcs TEXT
    );
    CREATE TABLE settlements (
      id TEXT PRIMARY KEY, vault_id TEXT, relationship_id TEXT NOT NULL,
      settled_at_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    -- The real thing (person-save-selftest's copy): the guards are asserted by
    -- counting it while empty, but the post-unlink case actually appends
    -- through applyEvent, which needs every column including author_seq.
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
    ${MIGRATION_028_DDL}
    ${MIGRATION_029_DDL}
    INSERT INTO vaults VALUES ('${VAULT}', 'AFN');
    INSERT INTO users VALUES ('${SELF}', '+93700111222', 'Synthetic Owner', 1, NULL, NULL, 1, 1, NULL, NULL);
    INSERT INTO users VALUES ('${CONTACT}', '+93700333444', 'Synthetic Contact', 0, NULL, NULL, 1, 1, NULL, NULL);
    INSERT INTO relationships VALUES ('${REL}', '${SELF}', '${CONTACT}', 'peer', '${VAULT}', 1, 1, NULL, NULL);
  `);
  dbTx._resetDbHandleForReset();
  dbTx.setInstallIdCache("fixture-device");
  dbTx.setLocalSelfUserIdCache(SELF);
  dbTx.setActiveVaultIdCache(VAULT);
  dbTx.setAccountIdCache(null);
  session.jwt = "jwt-1";
  net.connected = true;
  ledgerEmits.length = 0;
  server.reset();
}

function count(table: string, where = ""): number {
  return (fixture.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// In-memory /v1/tabs server behind global fetch.

type ServerEntry = WireEntry;
type FailNext = { status: number; code: string } | { network: true } | null;

const server = {
  rev: 0,
  closedAt: null as number | null,
  entries: [] as ServerEntry[],
  parties: {
    a: { label: "Synthetic Shop", joined_at_ms: 1_000, bound: false },
    b: { label: "", joined_at_ms: null as number | null, bound: false },
  },
  tokens: { a: "tok-a", b: "tok-b" },
  /** Which party a Bearer JWT resolves to; null = the account is not bound. */
  jwtRole: null as TabRole | null,
  calls: [] as string[],
  failNext: null as FailNext,
  mine: [] as Array<{
    tab: WireTab;
    role: TabRole;
    vault_id: string | null;
    relationship_id: string | null;
  }>,
  reset() {
    this.rev = 0;
    this.closedAt = null;
    this.entries = [];
    this.parties = {
      a: { label: "Synthetic Shop", joined_at_ms: 1_000, bound: false },
      b: { label: "", joined_at_ms: null, bound: false },
    };
    this.jwtRole = "a";
    this.calls = [];
    this.failNext = null;
    this.mine = [];
  },
  seed(
    entry: Partial<ServerEntry> & Pick<ServerEntry, "created_by" | "direction" | "amount">,
  ): ServerEntry {
    const e: ServerEntry = {
      id: entry.id ?? randomUUID(),
      seq: this.entries.length + 1,
      rev: ++this.rev,
      kind: "entry",
      note: null,
      occurred_at_ms: 10_000 + this.entries.length,
      created_at_ms: 10_000 + this.entries.length,
      status: "pending",
      status_at_ms: null,
      dispute_reason: null,
      voids_entry_id: null,
      voided_by_entry_id: null,
      ...entry,
    };
    this.entries.push(e);
    return e;
  },
  view(you: TabRole): WireTab {
    const bal = (role: TabRole) =>
      wire.minorToWire(
        direction.tabBalanceMinor(
          role,
          this.entries.map((e) => ({ ...e, amount_minor: wire.wireToMinor(e.amount) })),
        ),
      );
    const other = direction.otherRole(you);
    return {
      id: TAB,
      currency: "AFN",
      rev: this.rev,
      created_at_ms: 1_000,
      closed_at_ms: this.closedAt,
      closed_by: this.closedAt ? "a" : null,
      you,
      parties: { a: { ...this.parties.a }, b: { ...this.parties.b } },
      balance: { a: bal("a"), b: bal("b") },
      pending_for_you: this.entries.filter(
        (e) =>
          e.created_by === other &&
          e.status === "pending" &&
          !e.voided_by_entry_id &&
          e.kind !== "void",
      ).length,
    };
  },
};

type FakeResponse = {
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

function reply(status: number, body: unknown): FakeResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function errorReply(status: number, code: string): FakeResponse {
  return reply(status, { error: code, error_code: code });
}

const fakeFetch = async (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FakeResponse> => {
  const method = init.method ?? "GET";
  const u = new URL(url);
  server.calls.push(`${method} ${u.pathname}${u.search}`);
  if (server.failNext) {
    const f = server.failNext;
    server.failNext = null;
    if ("network" in f) throw new TypeError("Network request failed");
    return errorReply(f.status, f.code);
  }
  const authz = init.headers?.Authorization ?? "";
  let role: TabRole | null = null;
  if (authz === `Tab ${server.tokens.a}`) role = "a";
  else if (authz === `Tab ${server.tokens.b}`) role = "b";
  else if (authz === "Bearer jwt-1") role = server.jwtRole;
  const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};

  if (u.pathname === "/v1/tabs/mine") {
    if (!authz.startsWith("Bearer ")) return errorReply(401, "unauthorized");
    return reply(200, { tabs: server.mine });
  }
  if (u.pathname.endsWith("/bind") && authz === "Bearer jwt-1" && body.token === server.tokens.a) {
    server.jwtRole = "a";
    return reply(200, { tab: server.view("a"), entries: server.entries, full: true });
  }
  if (!role) return errorReply(404, "tab_not_found");
  const m = /^\/v1\/tabs\/([^/]+)(?:\/(.*))?$/.exec(u.pathname);
  if (!m || m[1] !== TAB) return errorReply(404, "tab_not_found");
  const action = m[2] ?? "";

  if (method === "GET" && !action) {
    const after = Number(u.searchParams.get("after_rev") ?? "0");
    const resp: TabResponse = {
      tab: server.view(role),
      entries: server.entries.filter((e) => e.rev > after).sort((x, y) => x.rev - y.rev),
      full: after === 0,
    };
    return reply(200, resp);
  }
  if (server.closedAt != null && action !== "") return errorReply(409, "tab_closed");
  if (action === "entries") {
    const existing = server.entries.find((e) => e.id === body.id);
    if (existing)
      return reply(200, { entry: existing, tab: server.view(role), duplicate_hint: null });
    const entry = server.seed({
      id: String(body.id),
      created_by: role,
      direction: body.direction as ServerEntry["direction"],
      amount: String(body.amount),
      note: (body.note as string | null) ?? null,
      occurred_at_ms: Number(body.occurred_at_ms),
      created_at_ms: Number(body.occurred_at_ms),
    });
    const twin = server.entries.find(
      (e) =>
        e.id !== entry.id &&
        e.created_by !== role &&
        e.kind !== "void" &&
        !e.voided_by_entry_id &&
        e.amount === entry.amount &&
        // SAME absolute direction: B pays A 500 → both sides write b_to_a
        // (mirrors duplicateHint in internal/tabs/service.go).
        e.direction === entry.direction &&
        Math.abs(e.occurred_at_ms - entry.occurred_at_ms) <= 24 * 3_600_000,
    );
    return reply(201, {
      entry,
      tab: server.view(role),
      duplicate_hint: twin
        ? { entry_id: twin.id, by: twin.created_by, at_ms: twin.occurred_at_ms }
        : null,
    });
  }
  const em = /^entries\/([^/]+)\/(accept|dispute|void)$/.exec(action);
  if (em) {
    const target = server.entries.find((e) => e.id === em[1]);
    if (!target) return errorReply(404, "tab_not_found");
    if (target.voided_by_entry_id) return errorReply(409, "already_voided");
    if (em[2] === "void") {
      if (target.created_by !== role) return errorReply(403, "not_author");
      const voidRow = server.seed({
        created_by: role,
        direction: target.direction === "a_to_b" ? "b_to_a" : "a_to_b",
        amount: target.amount,
        kind: "void",
        status: "accepted",
        voids_entry_id: target.id,
      });
      target.voided_by_entry_id = voidRow.id;
      target.rev = ++server.rev;
      return reply(201, { voided: target, void: voidRow });
    }
    if (target.created_by === role) return errorReply(403, "own_entry");
    const status = em[2] === "accept" ? "accepted" : "disputed";
    const reason = em[2] === "dispute" ? String(body.reason ?? "").trim() : null;
    if (target.status === status && (reason == null || target.dispute_reason === reason))
      return reply(200, { entry: target, tab: server.view(role) });
    if (target.status !== "pending") return errorReply(409, "review_final");
    if (body.expected_rev && body.expected_rev !== target.rev)
      return errorReply(409, "stale_review");
    target.status = status;
    target.status_at_ms = 20_000;
    target.dispute_reason = reason;
    target.rev = ++server.rev;
    return reply(200, { entry: target, tab: server.view(role), duplicate_hint: null });
  }
  if (action === "label") {
    server.parties[role].label = String(body.label);
    server.rev++;
    return reply(200, { tab: server.view(role), entries: [], full: false });
  }
  if (action === "close") {
    server.closedAt = 30_000;
    server.rev++;
    return reply(200, { tab: server.view(role), entries: [], full: false });
  }
  return errorReply(404, "tab_not_found");
};
(globalThis as { fetch: unknown }).fetch = fakeFetch;

// ---------------------------------------------------------------------------
// Helpers

function link(over: Partial<TabLink> = {}): TabLink {
  return {
    tab_id: TAB,
    vault_id: VAULT,
    relationship_id: REL,
    role: "a",
    currency: "AFN",
    party_token: "tok-a",
    my_label: "Synthetic Shop",
    other_label: "",
    other_joined_at: null,
    invite_url: "https://kaata.af/t/tok-b",
    rev: 0,
    closed_at: null,
    linked_at: 5_000,
    last_synced_at: null,
    last_error: null,
    ...over,
  };
}

function storedLink(): TabLink {
  return fixture.prepare("SELECT * FROM tab_links WHERE tab_id = ?").get(TAB) as TabLink;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let passed = 0;
let failed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
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

type Vector = {
  name: string;
  role: TabRole;
  entries: Array<{
    direction: "a_to_b" | "b_to_a";
    amount: string;
    kind: "entry" | "opening" | "void";
    voided: boolean;
    status: "pending" | "accepted" | "disputed";
  }>;
  expected: string;
};
const vectors = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "_shared", "tab-vectors.json"), "utf8"),
) as { cases: Vector[] };

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await test("direction: the same wire row reads as I-gave on one phone and I-received on the other", () => {
    assert.equal(direction.entryTypeFor("a", "a_to_b"), "debt");
    assert.equal(direction.entryTypeFor("b", "a_to_b"), "payment");
    assert.equal(direction.entryTypeFor("a", "b_to_a"), "payment");
    assert.equal(direction.entryTypeFor("b", "b_to_a"), "debt");
    assert.equal(direction.directionFor("a", "debt"), "a_to_b");
    assert.equal(direction.directionFor("a", "payment"), "b_to_a");
    assert.equal(direction.directionFor("b", "debt"), "b_to_a");
    assert.equal(direction.directionFor("b", "payment"), "a_to_b");
    for (const role of ["a", "b"] as const)
      for (const type of ["debt", "payment"] as const)
        assert.equal(direction.entryTypeFor(role, direction.directionFor(role, type)), type);
    const live = {
      direction: "a_to_b" as const,
      amount_minor: 500,
      kind: "entry" as const,
      voided_by_entry_id: null,
    };
    assert.equal(direction.signedMinorFor("a", live), 500);
    assert.equal(direction.signedMinorFor("b", live), -500);
    assert.equal(direction.signedMinorFor("a", { ...live, kind: "void" }), 0);
    assert.equal(direction.signedMinorFor("a", { ...live, voided_by_entry_id: "x" }), 0);
    assert.equal(direction.signedMinorFor("b", { ...live, kind: "opening" }), -500);
  });

  await test("shared vectors: JS oracle and the SQL fragment agree with Go on every case", async () => {
    assert.ok(vectors.cases.length >= 9, "vectors loaded");
    // Exact text: the fragment is pasted into lib/db.ts joins, so a change
    // here must be a deliberate one on both sides.
    assert.equal(
      direction.tabBalanceSql("tl.role", "te"),
      `COALESCE(SUM(CASE
    WHEN te.kind IN ('entry','opening') AND te.voided_by_entry_id IS NULL AND te.status <> 'disputed' AND te.direction = CASE WHEN tl.role = 'a' THEN 'a_to_b' ELSE 'b_to_a' END THEN te.amount_minor
    WHEN te.kind IN ('entry','opening') AND te.voided_by_entry_id IS NULL AND te.status <> 'disputed' THEN -te.amount_minor
    ELSE 0 END), 0)`,
    );
    assert.throws(() => direction.tabBalanceSql("tl.role", "te; DROP TABLE te"));
    assert.throws(() => direction.tabBalanceSql("'a' OR 1=1", "te"));
    for (const c of vectors.cases) {
      const rows = c.entries.map((e) => ({
        direction: e.direction,
        amount_minor: wire.wireToMinor(e.amount),
        kind: e.kind,
        status: e.status,
        voided_by_entry_id: e.voided ? "void-row" : null,
      }));
      const minor = direction.tabBalanceMinor(c.role, rows);
      assert.equal(wire.minorToWire(minor), c.expected, `oracle: ${c.name}`);
      // Execute the fragment on the shipped tables, both call shapes db.ts uses.
      const tabId = `vec-${randomUUID()}`;
      fixture
        .prepare(
          `INSERT INTO tab_links (tab_id, vault_id, relationship_id, role, currency, linked_at)
           VALUES (?, ?, ?, ?, 'AFN', 1)`,
        )
        .run(tabId, VAULT, `rel-${tabId}`, c.role);
      const insert = fixture.prepare(
        `INSERT INTO tab_entries (id, tab_id, seq, rev, created_by, direction, amount_minor, kind,
           occurred_at, created_at, status, voided_by_entry_id, local_pending)
         VALUES (?, ?, ?, ?, 'a', ?, ?, ?, 1, 1, ?, ?, 0)`,
      );
      rows.forEach((r, i) =>
        insert.run(
          randomUUID(),
          tabId,
          i + 1,
          i + 1,
          r.direction,
          r.amount_minor,
          r.kind,
          c.entries[i].status,
          r.voided_by_entry_id,
        ),
      );
      const literal = fixture
        .prepare(
          `SELECT ${direction.tabBalanceSql(`'${c.role}'`, "te")} AS bal FROM tab_entries te WHERE te.tab_id = ?`,
        )
        .get(tabId) as { bal: number };
      assert.equal(literal.bal, minor, `sql literal role: ${c.name}`);
      const joined = fixture
        .prepare(
          `SELECT (SELECT ${direction.tabBalanceSql("tl.role", "te")} FROM tab_entries te WHERE te.tab_id = tl.tab_id) AS bal
             FROM tab_links tl WHERE tl.tab_id = ?`,
        )
        .get(tabId) as { bal: number };
      assert.equal(joined.bal, minor, `sql joined role: ${c.name}`);
    }
  });

  await test("wire money: string surgery only, both directions, both edges", () => {
    assert.equal(wire.wireToMinor("0.10"), 10);
    assert.equal(wire.wireToMinor("0.20"), 20);
    // No trailing zero: Go's formatMinor writes "0.3" and the vectors carry
    // "-10" / "0.25"; both sides must agree byte for byte.
    assert.equal(wire.minorToWire(wire.wireToMinor("0.10") + wire.wireToMinor("0.20")), "0.3");
    assert.equal(wire.wireToMinor("9999999999.99"), 999_999_999_999);
    assert.equal(wire.minorToWire(999_999_999_999), "9999999999.99");
    assert.equal(wire.wireToMinor("100"), 10_000);
    assert.equal(wire.wireToMinor("12.5"), 1_250);
    assert.equal(wire.wireToMinor("12.50"), 1_250);
    assert.equal(wire.wireToMinor("-1250"), -125_000);
    assert.equal(wire.wireToMinor(".5".padStart(3, "0")), 50);
    assert.equal(wire.minorToWire(1_250), "12.5");
    assert.equal(wire.minorToWire(-1_000), "-10");
    assert.equal(wire.minorToWire(25), "0.25");
    assert.equal(wire.minorToWire(0), "0");
    assert.equal(wire.minorToWire(-5), "-0.05");
    for (const bad of ["", "-", "1e2", "12.345", "1,250", "10000000000", "abc", " 1 2", "0x10"]) {
      assert.throws(() => wire.wireToMinor(bad), RangeError, bad);
    }
    assert.throws(() => wire.minorToWire(1_000_000_000_000), RangeError);
    assert.throws(() => wire.minorToWire(0.5), RangeError);
    // Floats would say 0.30000000000000004; the whole test is that they never appear.
    assert.doesNotMatch(wire.minorToWire(30), /0000/);
  });

  await test("migration 028 DDL: shipped columns, cascade, and one open tab per contact", () => {
    const cols = (t: string) =>
      (fixture.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    assert.deepEqual(cols("tab_links"), [
      "tab_id",
      "vault_id",
      "relationship_id",
      "role",
      "currency",
      "party_token",
      "my_label",
      "other_label",
      "other_joined_at",
      "invite_url",
      "rev",
      "closed_at",
      "linked_at",
      "last_synced_at",
      "last_error",
    ]);
    assert.deepEqual(cols("tab_entries"), [
      "id",
      "tab_id",
      "seq",
      "rev",
      "created_by",
      "direction",
      "amount_minor",
      "kind",
      "note",
      "occurred_at",
      "created_at",
      "status",
      "status_at",
      "dispute_reason",
      "voids_entry_id",
      "voided_by_entry_id",
      "local_pending",
    ]);
    assert.deepEqual(cols("tab_outbox"), [
      "id",
      "tab_id",
      "op",
      "payload",
      "created_at",
      "attempts",
      "next_at",
      "last_error",
    ]);
    const ins = fixture.prepare(
      `INSERT INTO tab_links (tab_id, vault_id, relationship_id, role, currency, linked_at, closed_at) VALUES (?, ?, ?, 'a', 'AFN', 1, ?)`,
    );
    ins.run("t-open", VAULT, REL, null);
    assert.throws(
      () => ins.run("t-open-2", VAULT, REL, null),
      /UNIQUE/,
      "second OPEN link on the contact",
    );
    ins.run("t-closed", VAULT, REL, 99); // a closed one may coexist as history
    assert.throws(
      () =>
        fixture
          .prepare(
            "INSERT INTO tab_outbox VALUES ('o', 't-open', 'append', 'not json', 1, 0, NULL, NULL)",
          )
          .run(),
      /CHECK/,
    );
    assert.throws(
      () =>
        fixture
          .prepare("INSERT INTO tab_outbox VALUES ('o', 't-open', 'edit', '{}', 1, 0, NULL, NULL)")
          .run(),
      /CHECK/,
    );
    fixture
      .prepare(
        `INSERT INTO tab_entries (id, tab_id, seq, rev, created_by, direction, amount_minor, kind, occurred_at, created_at, status) VALUES ('e', 't-open', 1, 1, 'a', 'a_to_b', 100, 'entry', 1, 1, 'pending')`,
      )
      .run();
    fixture.prepare("DELETE FROM tab_links WHERE tab_id = 't-open'").run();
    assert.equal(count("tab_entries"), 0, "ON DELETE CASCADE");
    // resetAllLocalData must take the new tables AND the long-missing settlements.
    const drop = dbSource.slice(dbSource.indexOf("export async function resetAllLocalData"));
    for (const t of ["tab_entries", "tab_outbox", "tab_links", "settlements"]) {
      assert.match(drop, new RegExp(`DROP TABLE IF EXISTS ${t};`), `reset drops ${t}`);
    }
  });

  await test("upsertTabFromWire: full replace, optimistic survival, counts, cursor monotonic, notifiers", async () => {
    const applied: Array<{ newFromThem: number; statusChangedOnMine: number; origin: string }> = [];
    const off = events.onTabApplied((ev) =>
      applied.push({
        newFromThem: ev.newFromThem,
        statusChangedOnMine: ev.statusChangedOnMine,
        origin: ev.origin,
      }),
    );
    try {
      await tabsDb.upsertTabLink(link());
      server.parties.b = { label: "Synthetic Customer", joined_at_ms: 2_000, bound: true };
      const opening = server.seed({
        id: "op",
        created_by: "a",
        direction: "a_to_b",
        amount: "70",
        kind: "opening",
      });
      const theirs1 = server.seed({
        id: "b1",
        created_by: "b",
        direction: "b_to_a",
        amount: "20.50",
      });
      const mine1 = server.seed({ id: "a1", created_by: "a", direction: "a_to_b", amount: "5" });
      const full: TabResponse = {
        tab: server.view("a"),
        entries: [opening, theirs1, mine1],
        full: true,
      };
      const c1 = await tabsDb.upsertTabFromWire(link(), full);
      assert.deepEqual(c1, { newFromThem: 1, statusChangedOnMine: 0 });
      let stored = storedLink();
      assert.equal(stored.rev, 3);
      assert.equal(stored.other_label, "Synthetic Customer");
      assert.equal(stored.other_joined_at, 2_000);
      assert.equal(stored.last_error, null);
      assert.ok(stored.last_synced_at, "last_synced_at stamped");
      assert.equal(
        fixture.prepare("SELECT amount_minor FROM tab_entries WHERE id = 'b1'").pluck().get(),
        2_050,
      );
      assert.deepEqual(applied.at(-1), { newFromThem: 1, statusChangedOnMine: 0, origin: "pull" });
      assert.deepEqual(ledgerEmits.at(-1), { vaultId: VAULT, origin: "remote" });

      // An optimistic row the server has not seen survives a FULL pull…
      await tabsDb.insertOptimisticEntry(link(), {
        id: "opt",
        type: "payment",
        amount: 1.25,
        note: null,
        occurred_at: 12_000,
      });
      assert.equal(
        fixture.prepare("SELECT direction FROM tab_entries WHERE id = 'opt'").pluck().get(),
        "b_to_a",
      );
      assert.deepEqual(applied.at(-1)?.origin, "local");
      await tabsDb.upsertTabFromWire(link(), { ...full, tab: server.view("a") });
      assert.equal(count("tab_entries", "WHERE id = 'opt' AND local_pending = 1"), 1);
      // …and is replaced (local_pending cleared) once the server carries its id.
      // The server keeps the business date the client sent, so the acked copy
      // sorts where the optimistic row sat.
      const acked = server.seed({
        id: "opt",
        created_by: "a",
        direction: "b_to_a",
        amount: "1.25",
        occurred_at_ms: 12_000,
      });
      const c2 = await tabsDb.upsertTabFromWire(link(), {
        tab: server.view("a"),
        entries: [acked],
        full: false,
      });
      assert.deepEqual(c2, { newFromThem: 0, statusChangedOnMine: 0 });
      assert.equal(count("tab_entries", "WHERE id = 'opt' AND local_pending = 0 AND seq = 4"), 1);

      // Incremental: they accepted my row, disputed nothing, added one; I voided one.
      const emitsBefore = ledgerEmits.length;
      mine1.status = "accepted";
      mine1.status_at_ms = 20_000;
      mine1.rev = ++server.rev;
      const theirs2 = server.seed({ id: "b2", created_by: "b", direction: "b_to_a", amount: "3" });
      const voidRow = server.seed({
        id: "v1",
        created_by: "a",
        direction: "b_to_a",
        amount: "70",
        kind: "void",
        status: "accepted",
        voids_entry_id: "op",
      });
      opening.voided_by_entry_id = "v1";
      opening.rev = ++server.rev;
      const c3 = await tabsDb.upsertTabFromWire(link(), {
        tab: server.view("a"),
        entries: [mine1, theirs2, voidRow, opening].sort((x, y) => x.rev - y.rev),
        full: false,
      });
      assert.deepEqual(
        c3,
        { newFromThem: 1, statusChangedOnMine: 2 },
        "accepted + voided on mine; b2 from them; void row never counted",
      );
      assert.equal(ledgerEmits.length, emitsBefore + 1);
      stored = storedLink();
      assert.equal(stored.rev, server.rev);

      // A stale (older-rev) full response can neither rewind the cursor…
      const staleRev = stored.rev - 3;
      await tabsDb.upsertTabFromWire(link(), {
        tab: { ...server.view("a"), rev: staleRev },
        entries: [],
        full: false,
      });
      assert.equal(storedLink().rev, stored.rev);
      // …and a no-op poll (same rev, no rows, same meta) notifies nobody.
      const quiet = { applied: applied.length, ledger: ledgerEmits.length };
      await tabsDb.upsertTabFromWire(link(), { tab: server.view("a"), entries: [], full: false });
      assert.equal(applied.length, quiet.applied);
      assert.equal(ledgerEmits.length, quiet.ledger);

      // The Entry mapping every screen reads.
      const list = await tabsDb.listTabEntriesAsEntries(storedLink());
      assert.deepEqual(
        list.map((e) => e.id),
        ["opt", "b2", "a1", "b1", "op"],
        "newest first, void row omitted",
      );
      const byId = new Map(list.map((e) => [e.id, e]));
      assert.equal(byId.get("op")?.tab?.voided, true);
      assert.equal(byId.get("op")?.tab?.kind, "opening");
      assert.equal(byId.get("b1")?.type, "payment");
      assert.equal(byId.get("b1")?.amount_afn, 20.5);
      assert.equal(byId.get("b1")?.tab?.by, "them");
      assert.equal(byId.get("b1")?.tab?.other_label, "Synthetic Customer");
      assert.equal(byId.get("a1")?.type, "debt");
      assert.equal(byId.get("a1")?.accepted_at, 20_000);
      assert.equal(byId.get("a1")?.tab?.by, "me");
      assert.equal(byId.get("opt")?.tab?.local_pending, false);
      assert.equal(await tabsDb.countPendingForMe(storedLink()), 2, "b1 and b2 await me");

      // Party b sees the same rows mirrored.
      const asB = link({ tab_id: "tab-b", role: "b", party_token: "tok-b" });
      await tabsDb.upsertTabLink({ ...asB, relationship_id: "rel-b" });
      await tabsDb.upsertTabFromWire(
        { ...asB, relationship_id: "rel-b" },
        { tab: { ...server.view("b"), id: "tab-b" }, entries: [theirs1], full: true },
      );
      const bList = await tabsDb.listTabEntriesAsEntries({ ...asB, relationship_id: "rel-b" });
      assert.equal(bList[0].type, "debt");
      assert.equal(bList[0].tab?.by, "me");
    } finally {
      off();
    }
  });

  await test("outbox: order, backoff ladder, verdict table", async () => {
    await tabsDb.upsertTabLink(link());
    const base = { tab_id: TAB, payload: "{}", attempts: 0, next_at: null, last_error: null };
    await tabsDb.enqueueTabOp({ ...base, id: "op1", op: "append", created_at: 100 });
    await tabsDb.enqueueTabOp({ ...base, id: "op2", op: "accept", created_at: 100 });
    await tabsDb.enqueueTabOp({ ...base, id: "op3", op: "close", created_at: 200 });
    assert.deepEqual(
      (await tabsDb.listDueTabOps(TAB)).map((o) => o.id),
      ["op1", "op2", "op3"],
      "same-ms ties keep insertion order",
    );
    await tabsDb.failTabOp("op1", "500 http_500", sync.tabOpBackoffMs(1));
    const deferred = fixture
      .prepare("SELECT attempts, next_at, last_error FROM tab_outbox WHERE id = 'op1'")
      .get() as { attempts: number; next_at: number; last_error: string };
    assert.equal(deferred.attempts, 1);
    assert.ok(deferred.next_at > Date.now() + 25_000, "due in ~30 s");
    assert.equal(deferred.last_error, "500 http_500");
    assert.deepEqual(
      (await tabsDb.listDueTabOps(TAB)).map((o) => o.id),
      [],
    );
    await tabsDb.completeTabOp("op2");
    assert.deepEqual(
      (await tabsDb.listDueTabOps()).map((o) => o.id),
      [],
    );
    assert.deepEqual(await tabsDb.listTabIdsWithQueuedOps(), [TAB]);
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map(sync.tabOpBackoffMs),
      [
        30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
        3_600_000,
      ],
      "30 s doubling, capped at 1 h",
    );
    const e = (status: number, code = "x") => new errors.TabApiError(status, code, code);
    assert.equal(errors.isRetryableTabError(e(0, "network")), true);
    assert.equal(errors.isRetryableTabError(e(0, "timeout")), true);
    assert.equal(errors.isRetryableTabError(e(408)), true);
    assert.equal(errors.isRetryableTabError(e(401)), true);
    assert.equal(errors.isRetryableTabError(e(429, "rate_limited")), true);
    assert.equal(errors.isRetryableTabError(e(500)), true);
    assert.equal(errors.isRetryableTabError(e(503)), true);
    for (const [status, code] of [
      [404, "tab_not_found"],
      [409, "tab_closed"],
      [403, "not_author"],
      [403, "own_entry"],
      [409, "already_voided"],
      [409, "id_taken"],
      [400, "invalid_amount"],
    ] as const) {
      assert.equal(errors.isRetryableTabError(e(status, code)), false, code);
    }
    assert.equal(errors.isRetryableTabError(new Error("plain")), false);
  });

  await test("syncTab: append flushes in order, acks clear local_pending, cursor advances, hint surfaces", async () => {
    await tabsDb.upsertTabLink(link());
    server.parties.b.joined_at_ms = 2_000;
    server.seed({
      id: "b-cash",
      created_by: "b",
      direction: "b_to_a",
      amount: "500",
      occurred_at_ms: 40_000,
    });
    await tabsDb.insertOptimisticEntry(link(), {
      id: "my-1",
      type: "payment",
      amount: 500,
      note: "cash",
      occurred_at: 41_000,
    });
    await tabsDb.enqueueTabOp({
      id: "my-1",
      tab_id: TAB,
      op: "append",
      created_at: 1,
      attempts: 0,
      next_at: null,
      last_error: null,
      payload: JSON.stringify({
        id: "my-1",
        direction: "b_to_a",
        amount: "500",
        note: "cash",
        occurred_at_ms: 41_000,
      }),
    });
    const r = await sync.syncTab(TAB);
    assert.deepEqual(
      { ok: r.ok, flushed: r.flushed, failed: r.failed, error: r.error },
      { ok: true, flushed: 1, failed: 0, error: null },
    );
    assert.equal(r.newFromThem, 1, "the pull brought b-cash");
    assert.equal(count("tab_outbox"), 0);
    assert.equal(count("tab_entries", "WHERE id = 'my-1' AND local_pending = 0 AND seq = 2"), 1);
    assert.deepEqual(
      sync.takeAppendOutcome("my-1"),
      { hint: { entry_id: "b-cash", by: "b", at_ms: 40_000 }, rejected: null },
      "D17: same transfer from the other side",
    );
    assert.equal(sync.takeAppendOutcome("my-1"), null, "collected once");
    // The ack (rev 2) must NOT move the cursor: b-cash sits at rev 1, between
    // the old cursor and the ack, and only a pull from the old cursor sees it.
    assert.deepEqual(
      server.calls,
      [`POST /v1/tabs/${TAB}/entries`, `GET /v1/tabs/${TAB}?after_rev=0`],
      "the pull reads from the untouched cursor, not the ack's rev",
    );
    assert.equal(storedLink().rev, 2);
    server.calls.length = 0;
    const again = await sync.syncTab(TAB);
    assert.equal(again.pulled, 0);
    assert.deepEqual(server.calls, [`GET /v1/tabs/${TAB}?after_rev=2`]);
    // Replaying an already-acked append (a lost ack) is a 200 and still an ack.
    await tabsDb.enqueueTabOp({
      id: "my-1",
      tab_id: TAB,
      op: "append",
      created_at: 2,
      attempts: 0,
      next_at: null,
      last_error: null,
      payload: JSON.stringify({
        id: "my-1",
        direction: "b_to_a",
        amount: "500",
        note: "cash",
        occurred_at_ms: 41_000,
      }),
    });
    assert.equal((await sync.syncTab(TAB)).flushed, 1);
    assert.equal(server.entries.length, 2, "idempotent: no duplicate row server-side");
  });

  await test("syncTab: a transient failure backs the op off, blocks later ops, and keeps the optimistic row", async () => {
    await tabsDb.upsertTabLink(link());
    server.seed({ id: "b1", created_by: "b", direction: "b_to_a", amount: "9" });
    await tabsDb.insertOptimisticEntry(link(), {
      id: "my-1",
      type: "debt",
      amount: 12.34,
      note: null,
      occurred_at: 41_000,
    });
    await tabsDb.enqueueTabOp({
      id: "my-1",
      tab_id: TAB,
      op: "append",
      created_at: 1,
      attempts: 0,
      next_at: null,
      last_error: null,
      payload: JSON.stringify({
        id: "my-1",
        direction: "a_to_b",
        amount: "12.34",
        note: null,
        occurred_at_ms: 41_000,
      }),
    });
    await tabsDb.enqueueTabOp({
      id: "acc",
      tab_id: TAB,
      op: "accept",
      created_at: 2,
      attempts: 0,
      next_at: null,
      last_error: null,
      payload: JSON.stringify({ entry_id: "b1" }),
    });
    server.failNext = { status: 503, code: "http_503" };
    const r = await sync.syncTab(TAB);
    assert.equal(r.ok, true, "the pull still ran");
    assert.equal(r.failed, 1);
    assert.equal(r.flushed, 0);
    assert.match(r.error ?? "", /append: 503/);
    assert.equal(count("tab_outbox"), 2, "nothing dropped");
    const op = fixture
      .prepare("SELECT attempts, next_at FROM tab_outbox WHERE id = 'my-1'")
      .get() as { attempts: number; next_at: number };
    assert.equal(op.attempts, 1);
    assert.ok(op.next_at > Date.now() + 25_000);
    assert.equal(count("tab_entries", "WHERE id = 'my-1' AND local_pending = 1"), 1);
    assert.equal(
      server.calls.filter((c) => c.includes("/accept")).length,
      0,
      "the accept waited its turn",
    );
    assert.match(storedLink().last_error ?? "", /append: 503/);
    assert.equal(server.entries[0].status, "pending");
    // A network throw is the same class of failure.
    fixture.prepare("UPDATE tab_outbox SET next_at = NULL").run();
    server.failNext = { network: true };
    const r2 = await sync.syncTab(TAB);
    assert.match(r2.error ?? "", /append: network/);
    assert.equal(
      (
        fixture.prepare("SELECT attempts FROM tab_outbox WHERE id = 'my-1'").get() as {
          attempts: number;
        }
      ).attempts,
      2,
    );
    // Back on line: both flush, in order, and last_error clears.
    fixture.prepare("UPDATE tab_outbox SET next_at = NULL").run();
    server.calls.length = 0;
    const r3 = await sync.syncTab(TAB);
    assert.deepEqual(
      { flushed: r3.flushed, failed: r3.failed, error: r3.error },
      { flushed: 2, failed: 0, error: null },
    );
    assert.deepEqual(server.calls.slice(0, 2), [
      `POST /v1/tabs/${TAB}/entries`,
      `POST /v1/tabs/${TAB}/entries/b1/accept`,
    ]);
    assert.equal(storedLink().last_error, null);
    assert.equal(server.entries[0].status, "accepted");
  });

  await test("syncTab: a verdict drops the op, removes the optimistic row, and forces a full pull", async () => {
    await tabsDb.upsertTabLink(link());
    server.seed({ id: "b1", created_by: "b", direction: "b_to_a", amount: "9" });
    await sync.syncTab(TAB); // cache warm, cursor at 1
    assert.equal(storedLink().rev, 1);
    // I accept their row optimistically; the server says it was already voided.
    await tabsDb.applyOptimisticStatus(link(), "b1", "accepted", null);
    await tabsDb.enqueueTabOp({
      id: "acc",
      tab_id: TAB,
      op: "accept",
      created_at: 1,
      attempts: 0,
      next_at: null,
      last_error: null,
      payload: JSON.stringify({ entry_id: "b1" }),
    });
    server.entries[0].voided_by_entry_id = "gone";
    await tabsDb.insertOptimisticEntry(link(), {
      id: "my-1",
      type: "debt",
      amount: 1,
      note: null,
      occurred_at: 41_000,
    });
    await tabsDb.enqueueTabOp({
      id: "my-1",
      tab_id: TAB,
      op: "append",
      created_at: 2,
      attempts: 0,
      next_at: null,
      last_error: null,
      payload: JSON.stringify({
        id: "my-1",
        direction: "a_to_b",
        amount: "1",
        note: null,
        occurred_at_ms: 41_000,
      }),
    });
    server.closedAt = 30_000; // …and meanwhile the other side closed the tab.
    server.calls.length = 0;
    const r = await sync.syncTab(TAB);
    assert.equal(r.failed, 2);
    assert.equal(count("tab_outbox"), 0, "verdicts are not retried");
    assert.equal(count("tab_failed_ops"), 2, "refused intents retained, not erased");
    const kept = await tabsDb.listFailedTabEntries(REL);
    assert.equal(kept.length, 1, "refused tally stays visible in its separate fold");
    assert.equal(kept[0].amount_afn, 1);
    assert.equal(count("tab_entries", "WHERE id = 'my-1'"), 0, "refused append is gone");
    assert.deepEqual(sync.takeAppendOutcome("my-1"), { hint: null, rejected: "tab_closed" });
    assert.equal(
      server.calls.at(-1),
      `GET /v1/tabs/${TAB}?after_rev=0`,
      "full pull after a verdict",
    );
    assert.equal(
      fixture.prepare("SELECT status FROM tab_entries WHERE id = 'b1'").pluck().get(),
      "pending",
      "optimistic accept overwritten by the truth",
    );
    const stored = storedLink();
    assert.equal(stored.closed_at, 30_000);
    assert.match(stored.last_error ?? "", /append: 409 tab_closed/);
    server.calls.length = 0;
    await sync.syncTab(TAB);
    assert.equal(
      server.calls.at(-1),
      `GET /v1/tabs/${TAB}?after_rev=${stored.rev}`,
      "one full pull, then incremental again",
    );
  });

  await test("syncTab: JWT only, claim an unbound legacy party when necessary; offline and no credential recorded", async () => {
    await tabsDb.upsertTabLink(link());
    server.seed({ id: "b1", created_by: "b", direction: "b_to_a", amount: "9" });
    session.jwt = "jwt-1";
    server.jwtRole = null; // bind never happened
    const r = await sync.syncTab(TAB);
    assert.equal(r.ok, true);
    assert.equal(r.pulled, 1);
    assert.equal(
      server.calls.length,
      3,
      "404 on Bearer, claim unbound legacy party, retry session",
    );
    // Once bound, the JWT alone works and no stored token is needed.
    server.jwtRole = "a";
    server.calls.length = 0;
    await tabsDb.upsertTabLink(link({ party_token: null }));
    assert.equal((await sync.syncTab(TAB)).ok, true);
    assert.equal(server.calls.length, 1);
    // Signed out with no token: recorded, skipped, nothing dialled.
    session.jwt = null;
    server.calls.length = 0;
    const r2 = await sync.syncTab(TAB);
    assert.deepEqual({ ok: r2.ok, error: r2.error }, { ok: false, error: "auth_unavailable" });
    assert.equal(storedLink().last_error, "auth_unavailable");
    assert.equal(server.calls.length, 0);
    // Offline is normal, not an error to record.
    await tabsDb.upsertTabLink(link());
    net.connected = false;
    const r3 = await sync.syncTab(TAB);
    assert.deepEqual({ ok: r3.ok, error: r3.error }, { ok: false, error: "offline" });
    assert.equal(storedLink().last_error, null);
    assert.equal(server.calls.length, 0);
    assert.deepEqual(
      {
        ok: (await sync.syncTab("no-such-tab")).ok,
        error: (await sync.syncTab("no-such-tab")).error,
      },
      { ok: false, error: "no_link" },
    );
  });

  await test("syncTab coalesces per tab and requestTabSync debounces", async () => {
    await tabsDb.upsertTabLink(link());
    const burst = await Promise.all([
      sync.syncTab(TAB),
      sync.syncTab(TAB),
      sync.syncTab(TAB),
      sync.syncTab(TAB),
    ]);
    assert.ok(burst.every((r) => r.ok));
    assert.equal(server.calls.length, 2, "one in flight + one trailing");
    server.calls.length = 0;
    sync.requestTabSync(TAB);
    sync.requestTabSync(TAB);
    sync.requestTabSync(TAB);
    await sleep(450);
    assert.equal(server.calls.length, 1, "300 ms debounce → one pull");
  });

  await test("reconcileTabsFromServer inserts missing links from /mine, marks closes, never deletes", async () => {
    session.jwt = "jwt-1";
    server.jwtRole = "a";
    server.mine = [
      { tab: server.view("a"), role: "a", vault_id: VAULT, relationship_id: REL },
      {
        tab: { ...server.view("a"), id: "elsewhere" },
        role: "b",
        vault_id: VAULT,
        relationship_id: "rel-not-restored-yet",
      },
      {
        tab: { ...server.view("a"), id: "web-only" },
        role: "b",
        vault_id: null,
        relationship_id: null,
      },
    ];
    await sync.reconcileTabsFromServer();
    assert.equal(count("tab_links"), 1, "only the tab whose contact exists locally");
    const stored = storedLink();
    assert.equal(stored.party_token, null, "JWT is the credential");
    assert.equal(stored.rev, 0, "next syncTab pulls it whole");
    assert.equal(stored.my_label, "Synthetic Shop");
    // Local link kept even when /mine stops listing it; a server close lands.
    server.seed({ id: "just-before-close", created_by: "b", direction: "b_to_a", amount: "17" });
    server.closedAt = 77;
    server.rev++;
    server.mine = [
      {
        tab: { ...server.view("a"), closed_at_ms: 77 },
        role: "a",
        vault_id: VAULT,
        relationship_id: REL,
      },
    ];
    await sync.reconcileTabsFromServer();
    assert.equal(storedLink().closed_at, 77);
    assert.equal(
      count("tab_entries", "WHERE id = 'just-before-close'"),
      1,
      "closing must pull the last peer tally before freezing the cache",
    );
    server.mine = [];
    await sync.reconcileTabsFromServer();
    assert.equal(count("tab_links"), 1);
    // Signed out → no call at all; a failing /mine → swallowed.
    session.jwt = null;
    server.calls.length = 0;
    await sync.reconcileTabsFromServer();
    assert.equal(server.calls.length, 0);
    session.jwt = "jwt-1";
    server.failNext = { status: 500, code: "http_500" };
    await sync.reconcileTabsFromServer();
  });

  await test("syncAllTabs sweeps open links and still flushes a closed link's close op", async () => {
    await tabsDb.upsertTabLink(link());
    await tabsDb.upsertTabLink({
      ...link({ tab_id: "closed-one", relationship_id: "rel-2", closed_at: 50 }),
    });
    await tabsDb.enqueueTabOp({
      id: "cl",
      tab_id: "closed-one",
      op: "close",
      created_at: 1,
      attempts: 0,
      next_at: null,
      last_error: null,
      payload: "{}",
    });
    await sync.syncAllTabs();
    assert.ok(
      server.calls.some((c) => c === `GET /v1/tabs/${TAB}?after_rev=0`),
      "open link pulled",
    );
    assert.ok(
      server.calls.some((c) => c.startsWith("POST /v1/tabs/closed-one/close")),
      "closed link's op flushed",
    );
    assert.equal(
      count("tab_outbox", "WHERE id = 'cl'"),
      0,
      "the fake 404s the unknown tab id: a verdict, dropped",
    );
  });

  await test("read sites in the real lib/db.ts: linked contact reads the tab, unlinked stays byte-identical", async () => {
    const insertEntry = fixture.prepare(
      `INSERT INTO entries (id, vault_id, relationship_id, type, amount_afn, note, created_at, updated_at, is_deleted, is_settled)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0, 0)`,
    );
    insertEntry.run("l1", VAULT, REL, "debt", 100, 1_000, 1_000);
    insertEntry.run("l2", VAULT, REL, "payment", 30, 2_000, 2_000);
    const before = await db.getPerson(CONTACT);
    assert.ok(before);
    assert.deepEqual(
      {
        balance: before.balance,
        last: before.last_entry_at,
        tab_id: before.tab_id,
        pending: before.tab_pending,
        joined: before.tab_other_joined,
      },
      { balance: 70, last: 2_000, tab_id: null, pending: 0, joined: 0 },
    );
    const homeBefore = await db.listAllPeople();
    assert.equal(homeBefore.length, 1);
    assert.equal(homeBefore[0].last_entry_type, "payment");
    assert.equal(homeBefore[0].is_settled, 0);
    assert.equal((await db.listEntries(CONTACT)).map((e) => e.id).join(","), "l2,l1");
    assert.equal(await tabsDb.vaultHasOpenTab(VAULT), false);

    // Link: opening carries the 70; they record 20 received; I add 5 (pending ack).
    await tabsDb.upsertTabLink(link());
    server.parties.b = { label: "Synthetic Customer", joined_at_ms: 6_000, bound: true };
    server.seed({
      id: "op",
      created_by: "a",
      direction: "a_to_b",
      amount: "70",
      kind: "opening",
      occurred_at_ms: 5_000,
      created_at_ms: 5_000,
    });
    server.seed({
      id: "b1",
      created_by: "b",
      direction: "b_to_a",
      amount: "20",
      occurred_at_ms: 7_000,
      created_at_ms: 7_000,
    });
    await sync.syncTab(TAB);
    await tabsDb.insertOptimisticEntry(storedLink(), {
      id: "my-opt",
      type: "debt",
      amount: 5,
      note: null,
      occurred_at: 8_000,
    });

    const after = await db.getPerson(CONTACT);
    assert.ok(after);
    assert.deepEqual(
      {
        balance: after.balance,
        last: after.last_entry_at,
        tab_id: after.tab_id,
        pending: after.tab_pending,
        joined: after.tab_other_joined,
      },
      { balance: 55, last: 8_000, tab_id: TAB, pending: 1, joined: 1 },
      "tab balance 70 - 20 + 5 (optimistic counts), local rows excluded",
    );
    const home = await db.listAllPeople();
    assert.equal(home[0].balance, 55);
    assert.equal(home[0].last_entry_at, 8_000);
    assert.equal(home[0].last_entry_type, "debt", "newest is my a_to_b tally");
    assert.equal(home[0].is_settled, 0);
    const listed = await db.listEntries(CONTACT);
    assert.deepEqual(
      listed.map((e) => e.id),
      ["my-opt", "b1", "op"],
      "tab rows only, newest first",
    );
    assert.equal(listed[0].tab?.local_pending, true);
    assert.equal(listed[1].type, "payment");
    assert.equal(listed[1].amount_afn, 20);
    assert.deepEqual(
      (await tabsDb.listPreLinkEntries(storedLink())).map((e: Entry) => e.id),
      ["l2", "l1"],
    );
    assert.equal(await tabsDb.vaultHasOpenTab(VAULT), true);

    // Immutability guards, for a tab row AND a frozen pre-link local row.
    await assert.rejects(db.updateEntry("b1", 21, null), errors.TabLinkedEntryError);
    await assert.rejects(db.updateEntry("l1", 101, null), errors.TabLinkedEntryError);
    await assert.rejects(db.softDeleteEntry("my-opt"), errors.TabLinkedEntryError);
    await assert.rejects(db.softDeleteEntry("l2"), errors.TabLinkedEntryError);
    await assert.rejects(
      eventLog.appendEntrySettled({ relationshipId: REL }),
      errors.TabLinkedEntryError,
    );
    assert.equal(count("event_log"), 0);

    // Whole-kaata export: tab rows in, pre-link local rows out, types from my seat.
    const journal = await db.listEntriesForExport(VAULT);
    assert.deepEqual(
      journal.map((r) => [r.id, r.type, r.amount_afn, r.created_at]),
      [
        ["op", "debt", 70, 5_000],
        ["b1", "payment", 20, 7_000],
        ["my-opt", "debt", 5, 8_000],
      ],
    );

    // Unlink FREEZES the shared period, it does not undo it (D8). Reverting
    // to the bare local book here would lose every tally of the shared months
    // AND put the stale pre-link 70 back on the home screen as if it were
    // today's number — the balance stays 55, the rows stay, the pre-link rows
    // stay excluded (the opening entry still carries them).
    await tabsDb.markTabClosedLocally(TAB, 9_000);
    const closed = await db.getPerson(CONTACT);
    assert.deepEqual(
      {
        balance: closed?.balance,
        tab_id: closed?.tab_id,
        closed_at: closed?.tab_closed_at,
        pending: closed?.tab_pending,
        last: closed?.last_entry_at,
      },
      { balance: 55, tab_id: TAB, closed_at: 9_000, pending: 0, last: 8_000 },
      "frozen, still counted; nothing left to review on a closed tab",
    );
    assert.deepEqual(
      (await db.listEntries(CONTACT)).map((e) => e.id),
      ["my-opt", "b1", "op"],
    );
    assert.deepEqual(
      (await tabsDb.listPreLinkEntries(storedLink())).map((e: Entry) => e.id),
      ["l2", "l1"],
      "the pre-link fold survives the close",
    );
    assert.equal(await tabsDb.vaultHasOpenTab(VAULT), false, "the currency lock lifts");
    assert.equal(
      (await db.listEntriesForExport(VAULT)).map((r) => r.id).join(","),
      "op,b1,my-opt",
      "the journal still explains the balance it prints",
    );
    // A frozen pre-link row stays immutable forever — its sum lives inside the
    // opening entry, so an edit here would silently move a number nobody sees.
    await assert.rejects(db.updateEntry("l1", 101, null), errors.TabLinkedEntryError);
    // …but the contact is an ordinary local book again for NEW tallies, and
    // they add on top of the frozen balance rather than replacing it.
    await db.createEntry(CONTACT, "debt", 45, "after unlink");
    const afterUnlink = await db.getPerson(CONTACT);
    assert.equal(afterUnlink?.balance, 100, "55 carried over + 45 new");
    const merged = await db.listEntries(CONTACT);
    assert.equal(merged.length, 4);
    assert.equal(merged[0].note, "after unlink", "newest first across both sources");
    assert.equal(merged[0].tab, undefined, "a post-unlink tally is a plain local row");
    // And that new row edits and deletes like any other local entry.
    await db.updateEntry(merged[0].id, 46, "fixed");
    assert.equal((await db.getPerson(CONTACT))?.balance, 101);
    await db.softDeleteEntry(merged[0].id);
    assert.equal((await db.getPerson(CONTACT))?.balance, 55);
  });

  await test("re-link: only the LATEST tab counts, and the journal agrees with the balance", async () => {
    // A contact can hold several tabs over time — idx_tab_links_open_rel only
    // forbids two OPEN ones, and the person screen re-offers linking once a
    // tab is closed. Each new tab's opening entry carries the balance AS
    // DISPLAYED (lib/tabs/link.ts), which already contains the previous tab,
    // so counting an earlier tab again double-counts the whole account. Every
    // read site must therefore resolve exactly ONE link — the open one, else
    // the newest closed one — and the export journal has to end where the
    // person's balance is, or a shopkeeper's PDF contradicts their screen.
    const localEntry = fixture.prepare(
      `INSERT INTO entries (id, vault_id, relationship_id, type, amount_afn, note, created_at, updated_at, is_deleted, is_settled)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0, 0)`,
    );
    const tabRow = fixture.prepare(
      `INSERT INTO tab_entries (id, tab_id, seq, rev, created_by, direction, amount_minor, kind,
                                note, occurred_at, created_at, status, status_at, dispute_reason,
                                voids_entry_id, voided_by_entry_id, local_pending)
       VALUES (?, ?, ?, ?, 'a', ?, ?, ?, NULL, ?, ?, 'pending', NULL, NULL, NULL, NULL, 0)`,
    );

    // Before any link: one local tally of 500.
    localEntry.run("e1", VAULT, REL, "debt", 500, 1_000, 1_000);
    // Tab one: opening 500 (carried), they pay 200 -> 300. Closed at 3000.
    await tabsDb.upsertTabLink(
      link({ tab_id: "tab-1", linked_at: 2_000, closed_at: 3_000, rev: 9 }),
    );
    tabRow.run("t1", "tab-1", 1, 1, "a_to_b", 50_000, "opening", 2_000, 2_000);
    tabRow.run("t2", "tab-1", 2, 2, "b_to_a", 20_000, "entry", 2_500, 2_500);
    // Frozen: the contact still reads 300, not the stale local 500.
    assert.equal((await db.getPerson(CONTACT))?.balance, 300, "tab 1 frozen, still counted");
    // A local tally after the close adds on top.
    localEntry.run("e2", VAULT, REL, "debt", 70, 4_000, 4_000);
    assert.equal((await db.getPerson(CONTACT))?.balance, 370);
    // Re-link: tab two opens carrying 370, then a tally of 100.
    await tabsDb.upsertTabLink(link({ tab_id: "tab-2", linked_at: 5_000, rev: 7 }));
    tabRow.run("t3", "tab-2", 1, 1, "a_to_b", 37_000, "opening", 5_000, 5_000);
    tabRow.run("t4", "tab-2", 2, 2, "a_to_b", 10_000, "entry", 5_500, 5_500);

    const person = await db.getPerson(CONTACT);
    assert.equal(person?.balance, 470, "tab 2 only: 370 carried + 100");
    assert.equal(person?.tab_id, "tab-2", "the newest link wins");
    assert.equal((await db.listAllPeople())[0].balance, 470, "home agrees with the person screen");
    assert.deepEqual(
      (await db.listEntries(CONTACT)).map((e) => e.id),
      ["t4", "t3"],
      "only the latest tab's rows; tab 1 lives inside t3",
    );

    // The journal: no row twice, and its sum is the balance it explains.
    const journal = await db.listEntriesForExport(VAULT);
    assert.deepEqual(
      journal.map((r) => r.id),
      ["t3", "t4"],
      "no rows from the superseded tab",
    );
    const sum = journal.reduce((n, r) => n + (r.type === "debt" ? r.amount_afn : -r.amount_afn), 0);
    assert.equal(sum, 470, "the journal ends where the balance is");

    // A local tally written after BOTH links must appear exactly once — an
    // unscoped join would emit it once per link row.
    localEntry.run("e3", VAULT, REL, "debt", 5, 7_000, 7_000);
    const journal2 = await db.listEntriesForExport(VAULT);
    assert.deepEqual(
      journal2.map((r) => r.id),
      ["t3", "t4", "e3"],
    );
    assert.equal((await db.getPerson(CONTACT))?.balance, 475);

    // The opening entry stores no note; the exporters label it per document.
    assert.equal(journal2.find((r) => r.id === "t3")?.kind, "opening");
    assert.equal(journal2.find((r) => r.id === "e3")?.kind, "entry");

    // Party b may not join a contact that already holds a tab, open or frozen:
    // it mints no opening entry, so the balance would vanish without a word.
    assert.equal((await tabsDb.getAnyTabLinkForRelationship(REL))?.tab_id, "tab-2");
  });

  await test("atomic queue: a failed outbox insert rolls back the tally and concurrent saves serialize", async () => {
    const l = link();
    await tabsDb.upsertTabLink(l);
    const op = (id: string) => ({
      id,
      tab_id: TAB,
      op: "append" as const,
      payload: JSON.stringify({
        id,
        direction: "a_to_b",
        amount: "0.10",
        note: null,
        occurred_at_ms: 1001,
      }),
      created_at: 1001,
      attempts: 0,
      next_at: null,
      last_error: null,
    });
    fixture.exec(
      `CREATE TRIGGER fail_queue BEFORE INSERT ON tab_outbox BEGIN SELECT RAISE(ABORT, 'disk failure'); END`,
    );
    await assert.rejects(tabsDb.queueTabMutation(l, op("failed")), /disk failure/);
    assert.equal(count("tab_entries"), 0);
    assert.equal(count("tab_outbox"), 0);
    fixture.exec(`DROP TRIGGER fail_queue`);
    await Promise.all([
      tabsDb.queueTabMutation(l, op("one")),
      tabsDb.queueTabMutation(l, op("two")),
    ]);
    assert.equal(count("tab_entries"), 2);
    assert.equal(count("tab_outbox"), 2);
    await tabsDb.rejectTabOp(op("one"));
    assert.equal(count("tab_entries", "WHERE id='one'"), 0);
    assert.equal(storedLink().rev, 0, "full repair survives a process restart");
  });

  await test("late full response cannot erase a newer cached balance", async () => {
    const l = link();
    await tabsDb.upsertTabLink(l);
    const row = server.seed({ id: "newer", created_by: "b", direction: "b_to_a", amount: "25" });
    await tabsDb.upsertTabFromWire(l, { tab: server.view("a"), entries: [row], full: true });
    await tabsDb.upsertTabFromWire(l, {
      tab: { ...server.view("a"), rev: 0 },
      entries: [],
      full: true,
    });
    assert.equal(count("tab_entries", "WHERE id='newer'"), 1);
    assert.equal(storedLink().rev, 1);
  });

  await test("signed-in invitation sends BOTH proofs; anonymous invitation is refused", async () => {
    const api = require("../tabs/api") as typeof import("../tabs/api");
    const previous = globalThis.fetch;
    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push({
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : {},
      });
      return reply(200, { tab: server.view("b"), entries: [], full: true });
    }) as typeof fetch;
    try {
      session.jwt = "jwt-1";
      await api.joinTab({ token: "invitation" }, TAB, {
        label: "B",
        vault_id: VAULT,
        relationship_id: REL,
      });
      assert.equal(seen[0].headers.Authorization, "Bearer jwt-1");
      assert.equal(seen[0].body.token, "invitation");
      session.jwt = null;
      await assert.rejects(() =>
        api.joinTab({ token: "invitation" }, TAB, {
          label: "B",
          vault_id: null,
          relationship_id: null,
        }),
      );
      assert.equal(seen.length, 1, "no anonymous request");
      session.jwt = "jwt-1";
      const auth = await api.resolveTabAuth(link({ role: "b" }));
      await api.fetchTab(auth, TAB, 0);
      assert.equal(
        seen[1].headers["X-Kaata-Party"],
        "b",
        "shared-vault membership cannot switch the authoring side",
      );
    } finally {
      globalThis.fetch = previous;
    }
  });

  await test("notification action: validate IDs, queue once, keep receipt after acknowledgement", async () => {
    const { parseTabReview, TAB_ACCEPT, TAB_REJECT } = require("../tabs/notification-data");
    const data = {
      tab_id: randomUUID(),
      entry_id: randomUUID(),
      role: "b",
      rev: 12,
      kind: "entry_created",
    };
    assert.equal(parseTabReview(TAB_ACCEPT, data).action, "accept");
    assert.equal(parseTabReview(TAB_REJECT, data).action, "dispute");
    for (const bad of [
      { ...data, rev: -1 },
      { ...data, rev: Infinity },
      { ...data, role: "owner" },
      { ...data, entry_id: "../other" },
      { ...data, kind: "entry_accepted" },
      null,
    ]) {
      assert.equal(parseTabReview(TAB_ACCEPT, bad), null);
    }
    assert.equal(parseTabReview("default", data), null);
    const tl = link();
    await tabsDb.upsertTabLink(tl);
    await Promise.all([
      tabsDb.queueNotificationReview(tl, "their-entry", 12, "accept"),
      tabsDb.queueNotificationReview(tl, "their-entry", 12, "dispute"),
    ]);
    const ops = await tabsDb.listDueTabOps(TAB);
    assert.equal(ops.length, 1, "first tap wins across duplicate OS callbacks");
    assert.deepEqual(JSON.parse(ops[0].payload), {
      entry_id: "their-entry",
      expected_rev: 12,
      reason: "",
    });
    await tabsDb.completeTabOp(ops[0].id);
    await tabsDb.queueNotificationReview(tl, "their-entry", 12, "accept");
    assert.equal(
      (await tabsDb.listDueTabOps(TAB)).length,
      0,
      "cold-start replay cannot repeat a completed action",
    );
  });

  await test("rejected history stays excluded; only a fresh tally can count again", async () => {
    const tl = link();
    await tabsDb.upsertTabLink(tl);
    server.seed({ id: "goods", created_by: "b", direction: "a_to_b", amount: "100" });
    await sync.syncTab(TAB);
    assert.equal((await db.getPerson(CONTACT))?.balance, 100);
    const before = await tabsDb.listTabEntriesAsEntries(tl);
    assert.equal(before.length, 1);
    await tabsDb.applyOptimisticStatus(tl, "goods", "disputed", null);
    assert.equal((await db.getPerson(CONTACT))?.balance, 0);
    const rows = await tabsDb.listTabEntriesAsEntries(tl);
    assert.equal(rows.length, 1, "history kept");
    assert.equal(rows[0].tab?.status, "disputed");
    assert.equal(
      (await db.listEntriesForExport(VAULT)).filter((e: any) => e.id === "goods").length,
      0,
    );
    await assert.rejects(
      tabsDb.applyOptimisticStatus(tl, "goods", "accepted", null),
      errors.TabReviewFinalError,
    );
    assert.equal((await db.getPerson(CONTACT))?.balance, 0);
    // Mirror the committed rejection, then send a distinct correction.
    const original = server.entries.find((e) => e.id === "goods")!;
    original.status = "disputed";
    original.rev = ++server.rev;
    server.seed({ id: "corrected", created_by: "b", direction: "a_to_b", amount: "100" });
    await sync.syncTab(TAB);
    await tabsDb.applyOptimisticStatus(tl, "corrected", "accepted", null);
    assert.equal((await db.getPerson(CONTACT))?.balance, 100);
    assert.equal(
      (await tabsDb.listTabEntriesAsEntries(tl)).length,
      2,
      "original history preserved",
    );
  });

  await test("concurrent local reviews queue only the first decision", async () => {
    const tl = link();
    await tabsDb.upsertTabLink(tl);
    server.seed({ id: "review-once", created_by: "b", direction: "a_to_b", amount: "10" });
    await sync.syncTab(TAB);
    const reviewOp = (op: "accept" | "dispute") => ({
      id: randomUUID(),
      tab_id: TAB,
      op,
      payload: JSON.stringify({ entry_id: "review-once", reason: "" }),
      created_at: Date.now(),
      attempts: 0,
      next_at: null,
      last_error: null,
    });
    const results = await Promise.allSettled([
      tabsDb.queueTabMutation(tl, reviewOp("accept")),
      tabsDb.queueTabMutation(tl, reviewOp("dispute")),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(failure.reason instanceof errors.TabReviewFinalError);
    assert.equal(count("tab_outbox"), 1);
    const before = (await tabsDb.listTabEntriesAsEntries(tl))[0].tab!.status;
    const opposite = before === "accepted" ? "dispute" : "accept";
    await assert.rejects(
      tabsDb.queueTabMutation(tl, reviewOp(opposite)),
      errors.TabReviewFinalError,
    );
    assert.equal(count("tab_outbox"), 1, "refused review creates no durable operation");
    await sync.syncTab(TAB);
    assert.equal(count("tab_outbox"), 0);
    assert.equal(server.entries[0].status, before);
  });

  await test("another phone's committed review wins over an offline optimistic decision", async () => {
    const tl = link();
    await tabsDb.upsertTabLink(tl);
    const target = server.seed({
      id: "offline-review",
      created_by: "b",
      direction: "a_to_b",
      amount: "10",
    });
    await sync.syncTab(TAB);
    await tabsDb.queueTabMutation(tl, {
      id: randomUUID(),
      tab_id: TAB,
      op: "accept",
      payload: JSON.stringify({ entry_id: target.id }),
      created_at: Date.now(),
      attempts: 0,
      next_at: null,
      last_error: null,
    });
    assert.equal((await db.getPerson(CONTACT))?.balance, 10);
    // Other phone rejected while this one had not yet uploaded its accept.
    target.status = "disputed";
    target.dispute_reason = "Wrong amount";
    target.rev = ++server.rev;
    const outcome = await sync.syncTab(TAB);
    assert.equal(outcome.failed, 1);
    assert.equal(count("tab_outbox"), 0);
    assert.equal(count("tab_failed_ops"), 1, "keep the refused offline intent for diagnostics");
    assert.equal((await tabsDb.listTabEntriesAsEntries(tl))[0].tab!.status, "disputed");
    assert.equal(
      (await db.getPerson(CONTACT))?.balance,
      0,
      "authoritative rejected balance restored",
    );
    assert.equal(count("tab_entries"), 1, "no history lost");
  });

  await test("notification amounts use recipient perspective, currency and exact cents", async () => {
    const { notificationVars } = await import("../tabs/notification-text");
    const { ltrIsolate } = await import("../bidi");
    const entry = {
      direction: "a_to_b",
      amount_minor: 50025,
      status: "disputed",
    } as import("../tabs/types").TabEntryRow;
    for (const currency of ["AFN", "USD", "AED"]) {
      const tl = {
        ...link(),
        role: "a",
        currency,
        other_label: "احمد",
      } as import("../tabs/types").TabLink;
      assert.deepEqual(notificationVars(tl, entry, "Other"), {
        name: "\u2068احمد\u2069",
        amount: `\u2066+500.25 ${currency}\u2069`,
      });
      assert.equal(
        notificationVars({ ...tl, role: "b" }, entry, "Other").amount,
        `\u2066−500.25 ${currency}\u2069`,
      );
    }
    assert.equal(
      notificationVars({ ...link(), other_label: "\n\u202e" }, entry, "Other").name,
      "\u2068Other\u2069",
    );
    assert.equal(ltrIsolate("+93781696644"), "\u2066+93781696644\u2069");
  });

  console.log(`\n${passed} tab regressions passed; ${failed} failed.`);
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
