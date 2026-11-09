// Real temporary SQLite databases/files. Native I/O and auth are adapted only
// at their boundaries; the production backup/restore implementation executes.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  unlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sha256 } from "@noble/hashes/sha256";
import { createDriveBackup, openDriveBackup } from "../drive-backup";
import { compileUI } from "./ui-fixture";
const temporaryParent = path.resolve(__dirname, "../../../../build");
const temporaryRoot = path.resolve(
  mkdtempSync(path.join(temporaryParent, "personal-backup-test-")),
);
const ACCOUNT = "11111111-1111-4111-8111-111111111111",
  OTHER = "22222222-2222-4222-8222-222222222222";
const VAULT = "33333333-3333-4333-8333-333333333333",
  INSTALL = "44444444-4444-4444-8444-444444444444";
const TARGET = "55555555-5555-4555-8555-555555555555";
const PUB = Buffer.alloc(32, 7).toString("base64");
const localAccount = (key: string) =>
  "local:" + Buffer.from(key, "base64").toString("base64url").slice(0, 16);
const jwt = (account: string) =>
  "header." +
  Buffer.from(JSON.stringify({ account_id: account })).toString("base64url") +
  ".signature";
const handles = new Set<Database.Database>();
const tallyNotesMigration = "052_tally_notes";
const tallyNoteNumbersMigration = "053_tally_note_number";
const sharedInvitationDeclineMigration = "054_shared_invitation_decline";
const migrationNames = [
  ...readFileSync(require.resolve("../db"), "utf8").matchAll(/const MIGRATION_\d+ = "([^"]+)"/g),
].map((match) => match[1]);
let checks = 0;
function ok(condition: unknown, message: string) {
  checks++;
  assert.ok(condition, message);
}
const schema = `CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER);
${migrationNames.map((name) => `INSERT INTO schema_migrations VALUES('${name}',1);`).join("\n")}
CREATE TABLE users(id TEXT PRIMARY KEY,account_id TEXT,is_local_self INTEGER);
CREATE TABLE vaults(id TEXT PRIMARY KEY,account_id TEXT,registered_with_server_at INTEGER,vault_trust_anchor_pubkey TEXT,is_default INTEGER,archived_at INTEGER);
CREATE TABLE vault_members_mirror(vault_id TEXT REFERENCES vaults(id),account_id TEXT,role TEXT,accepted_at INTEGER,revoked_at INTEGER);
CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id),user_a_id TEXT REFERENCES users(id),user_b_id TEXT REFERENCES users(id));
CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id),note TEXT);
CREATE TABLE event_log(event_id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id),event_type TEXT,payload_json TEXT,server_acked_at INTEGER,tombstone_reason TEXT);
CREATE TABLE shop_profile(vault_id TEXT REFERENCES vaults(id),name TEXT);
CREATE TABLE pending_invitations(token TEXT);
CREATE TABLE vault_credentials(vmc_blob TEXT);
CREATE TABLE sync_state(vault_id TEXT,last_pulled_server_seq INTEGER);
CREATE TABLE tab_links(tab_id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id),party_token TEXT,invite_url TEXT,last_error TEXT,last_synced_at INTEGER,rev INTEGER);
CREATE TABLE tab_entries(id TEXT PRIMARY KEY,tab_id TEXT REFERENCES tab_links(tab_id),note TEXT);
CREATE TABLE tab_outbox(id TEXT PRIMARY KEY,tab_id TEXT,attempts INTEGER,next_at INTEGER,last_error TEXT,payload TEXT);
CREATE TABLE tab_failed_ops(id TEXT PRIMARY KEY,tab_id TEXT,last_error TEXT);
CREATE TABLE customer_groups(id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id));`;
function fixture(name: string, account: string | null = null, schemaVersion = 54) {
  const dir = path.join(temporaryRoot, name);
  mkdirSync(dir);
  const dbPath = path.join(dir, "kaata.db");
  const raw = new Database(dbPath);
  raw.exec(schema);
  if (schemaVersion < 54)
    raw.prepare("DELETE FROM schema_migrations WHERE name=?").run(sharedInvitationDeclineMigration);
  else raw.exec("ALTER TABLE tab_links ADD COLUMN invitation_declined_at INTEGER");
  if (schemaVersion < 53) {
    raw.prepare("DELETE FROM schema_migrations WHERE name=?").run(tallyNoteNumbersMigration);
  }
  if (schemaVersion < 52) {
    raw.prepare("DELETE FROM schema_migrations WHERE name=?").run(tallyNotesMigration);
  } else {
    raw.exec(`CREATE TABLE tally_notes(id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id),relationship_id TEXT REFERENCES relationships(id),note TEXT);
CREATE INDEX idx_tally_notes_relationship ON tally_notes(vault_id,relationship_id);`);
    if (schemaVersion >= 53) raw.exec("ALTER TABLE tally_notes ADD COLUMN number_text TEXT");
  }
  raw.close();
  let cached: ReturnType<typeof open> | null = null;
  let version = 0,
    currentAccount = account,
    currentJWT = account ? jwt(account) : null;
  const failMove = new Set<string>();
  let fetchCount = 0,
    beforeFetch: (() => void) | null = null,
    cloudAllowed = true;
  const remote: Array<{
    vault_id: string;
    role: string;
    vault_trust_anchor_pubkey: string;
  }> = [{ vault_id: VAULT, role: "owner", vault_trust_anchor_pubkey: PUB }];
  class File {
    uri: string;
    constructor(
      ...parts: Array<
        | string
        | {
            uri: string;
          }
      >
    ) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get filename() {
      const candidate = path.resolve(this.uri.replace(/^file:\/\//, ""));
      assert.equal(path.dirname(candidate), dir);
      return candidate;
    }
    get exists() {
      return existsSync(this.filename);
    }
    get size() {
      return this.exists ? statSync(this.filename).size : 0;
    }
    bytesSync() {
      return new Uint8Array(readFileSync(this.filename));
    }
    textSync() {
      return readFileSync(this.filename, "utf8");
    }
    writeSync(value: string | Uint8Array) {
      writeFileSync(this.filename, value);
    }
    delete() {
      unlinkSync(this.filename);
    }
    moveSync(to: File) {
      if (failMove.has(path.basename(this.filename))) throw new Error("injected rename failure");
      renameSync(this.filename, to.filename);
      this.uri = to.uri;
    }
  }
  function open(name: string) {
    const filename = path.join(dir, name);
    let db = new Database(filename);
    handles.add(db);
    return {
      get db() {
        return db;
      },
      filename,
      getAllAsync: async (sql: string, ...args: any[]) => db.prepare(sql).all(...args),
      getFirstAsync: async (sql: string, ...args: any[]) => db.prepare(sql).get(...args) ?? null,
      runAsync: async (sql: string, ...args: any[]) => db.prepare(sql).run(...args),
      execAsync: async (sql: string) => {
        db.exec(sql);
      },
      isInTransactionAsync: async () => db.inTransaction,
      closeAsync: async () => {
        if (db.open) {
          db.close();
          handles.delete(db);
        }
      },
      reopen: () => {
        db = new Database(filename);
        handles.add(db);
      },
    };
  }
  const getDb = async () => (cached ??= open("kaata.db"));
  class SessionChangedError extends Error {}
  const auth = {
    SessionChangedError,
    captureCurrentSession: async () => ({
      bindingVersion: version,
      jwt: currentJWT,
      accountId: currentAccount,
    }),
    applyForUnchangedLocalSession: async (s: any, work: () => Promise<any>) => {
      if (s.bindingVersion !== version || s.jwt !== currentJWT || s.accountId !== currentAccount)
        throw new SessionChangedError();
      return work();
    },
  };
  const createModule = () =>
    compileUI(
      "../personal-backup-db",
      {
        "expo-file-system": { File },
        "expo-sqlite": {
          defaultDatabaseDirectory: dir,
          openDatabaseAsync: async (name: string) => open(name),
          backupDatabaseAsync: async ({ sourceDatabase, destDatabase }: any) => {
            await destDatabase.closeAsync();
            await sourceDatabase.db.backup(destDatabase.filename);
            destDatabase.reopen();
          },
        },
        "@noble/hashes/sha256": { sha256 },
        "../constants/env": { BACKEND_URL_FALLBACK: "https://trusted.example" },
        "./auth": auth,
        "./db-tx": { DB_NAME: "kaata.db", getDb },
        "./drive-backup": require("../drive-backup"),
        "./db-backup": {
          PERSONAL_BACKUP_EXPORT: "kaata.personal.export.db",
          PERSONAL_BACKUP_RESTORE_STAGE: "kaata.personal.restore.db",
          PERSONAL_BACKUP_RESTORE_MARKER: "kaata.personal.restore.json",
          PERSONAL_BACKUP_RESTORE_MARKER_SCRATCH: "kaata.personal.restore.json.tmp",
          PERSONAL_BACKUP_RESTORE_PARKED: "kaata.personal.original.db",
          PERSONAL_BACKUP_JOINED_RECOVERY_KEY: "personal_backup_joined_recovery_account",
        },
        "./trust/account-id": { buildLocalAccountId: localAccount },
      },
      {
        fetch: async (url: string, options: any) => {
          fetchCount++;
          assert.equal(url, "https://trusted.example/v1/vaults", "never use imported backend URL");
          assert.equal(options.headers.Authorization, `Bearer ${currentJWT}`);
          beforeFetch?.();
          return { ok: cloudAllowed, json: async () => ({ vaults: remote }) };
        },
      },
    );
  const module = createModule();
  function sql(query: string, ...args: any[]) {
    const db = new Database(dbPath);
    try {
      return db.prepare(query).run(...args);
    } finally {
      db.close();
    }
  }
  function rows(query: string) {
    const db = new Database(dbPath);
    try {
      return db.prepare(query).all();
    } finally {
      db.close();
    }
  }
  function metadata(key: string, value: string) {
    sql("INSERT OR REPLACE INTO app_meta VALUES(?,?)", key, value);
  }
  metadata("install_id", INSTALL);
  metadata("installed_at_unix_ms", "1234");
  metadata("mesh_device_ed25519_pubkey", PUB);
  if (account) metadata("account_id", account);
  function seed(ledger = true) {
    sql("INSERT INTO users VALUES('self',?,1)", account);
    sql("INSERT INTO vaults VALUES(?,?,?,?,1,NULL)", VAULT, account, account ? 1 : null, PUB);
    sql(
      "INSERT INTO vault_members_mirror VALUES(?,?,'owner',1,NULL)",
      VAULT,
      account ?? localAccount(PUB),
    );
    sql(
      "INSERT INTO event_log VALUES('genesis',?,'vault_member_added',?,NULL,NULL)",
      VAULT,
      JSON.stringify({ role: "owner", account_id: account ?? localAccount(PUB) }),
    );
    sql(
      "INSERT INTO event_log VALUES('currency',?,'vault_setting_set',?,NULL,NULL)",
      VAULT,
      JSON.stringify({ key: "enabled_currencies", value: '["AFN"]' }),
    );
    sql("INSERT INTO event_log VALUES('profile',?,'shop_profile_updated','{}',NULL,NULL)", VAULT);
    if (ledger) {
      sql("INSERT INTO relationships VALUES('person',?,'self',NULL)", VAULT);
      sql("INSERT INTO entries VALUES('tally',?,'Keep this tally')", VAULT);
    }
  }
  async function close() {
    if (cached) {
      await cached.closeAsync();
      cached = null;
    }
  }
  async function boot() {
    await close();
    return createModule().finishPendingPersonalBackupRestore();
  }
  return {
    module,
    sql,
    rows,
    metadata,
    seed,
    boot,
    close,
    dir,
    failMove,
    remote,
    get fetchCount() {
      return fetchCount;
    },
    switchAccount: (value: string | null) => {
      version++;
      currentAccount = value;
      currentJWT = value ? jwt(value) : null;
    },
    expireSession: () => {
      version++;
      currentJWT = null;
    },
    onFetch: (fn: () => void) => {
      beforeFetch = fn;
    },
    denyCloud: () => {
      cloudAllowed = false;
    },
    allowCloud: () => {
      cloudAllowed = true;
    },
    read: (name: string) => new Uint8Array(readFileSync(path.join(dir, name))),
    exists: (name: string) => existsSync(path.join(dir, name)),
  };
}
async function errorCode(work: () => Promise<unknown>, code: string) {
  let caught: any;
  try {
    await work();
  } catch (error) {
    caught = error;
  }
  checks++;
  assert.equal(caught?.code, code);
}
async function exported(f: ReturnType<typeof fixture>, { localOnly = false } = {}) {
  const result = await f.module.createPersonalBackupSnapshot(false, { localOnly });
  try {
    return result.file.bytesSync() as Uint8Array;
  } finally {
    result.dispose();
  }
}
async function main() {
  const source = fixture("ninja-source");
  source.seed();
  source.metadata("pending_pair_tokens", "PAIR_SECRET_123");
  source.metadata("backend_url_override", "https://untrusted.example");
  source.metadata("pending_join:secret", "JOIN_SECRET_456");
  source.sql("INSERT INTO pending_invitations VALUES('INVITE_SECRET_789')");
  source.sql("INSERT INTO vault_credentials VALUES('VMC_SECRET_987')");
  source.sql(
    "INSERT INTO tab_links(tab_id,vault_id,party_token,invite_url,last_synced_at,rev,invitation_declined_at) VALUES('shared',?,'TOKEN_SECRET_654','URL_SECRET_321',1,99,1234)",
    VAULT,
  );
  source.sql("INSERT INTO tab_entries VALUES('shared-tally','shared','Shared history')");
  source.sql("INSERT INTO tally_notes VALUES('note-1',?,'person','Review this','12.500')", VAULT);
  const bytes = await exported(source, { localOnly: true });
  assert.equal(source.fetchCount, 0, "a Ninja file export makes no request");
  for (const secret of [
    "PAIR_SECRET_123",
    "JOIN_SECRET_456",
    "INVITE_SECRET_789",
    "VMC_SECRET_987",
    "TOKEN_SECRET_654",
    "URL_SECRET_321",
    "untrusted.example",
  ])
    ok(!Buffer.from(bytes).includes(Buffer.from(secret)), `portable bytes remove ${secret}`);
  ok(
    source.rows("SELECT token FROM pending_invitations").length === 1,
    "source invitations remain untouched",
  );
  ok(source.rows("SELECT note FROM entries").length === 1, "source ledger untouched");
  const target = fixture("ninja-target");
  target.seed(false);
  await errorCode(
    () => target.module.createPersonalBackupSnapshot(true, { requireData: true }),
    "empty",
  );
  target.metadata("install_id", TARGET);
  target.metadata("installed_at_unix_ms", "5678");
  await target.module.stagePersonalBackupRestore(bytes);
  ok(target.rows("SELECT * FROM entries").length === 0, "staging never changes live ledger");
  await target.boot();
  ok(
    (target.rows("SELECT note FROM entries")[0] as any).note === "Keep this tally",
    "Ninja restore retains data",
  );
  ok(
    (target.rows("SELECT number_text FROM tally_notes WHERE note='Review this'")[0] as any)
      .number_text === "12.500",
    "portable restore retains tally notes and their optional number",
  );
  ok(
    (target.rows("SELECT value FROM app_meta WHERE key='install_id'")[0] as any).value === TARGET,
    "target install identity survives",
  );
  ok(
    (target.rows("SELECT value FROM app_meta WHERE key='installed_at_unix_ms'")[0] as any).value ===
      "5678",
    "target install time survives",
  );
  ok(
    (target.rows("SELECT value FROM app_meta WHERE key='mesh_device_ed25519_pubkey'")[0] as any)
      .value === PUB,
    "public mirror remains for normal retirement",
  );
  ok(
    (target.rows("SELECT party_token,invite_url FROM tab_links")[0] as any).party_token === null,
    "bearer token not restored",
  );
  ok(
    (target.rows("SELECT invitation_declined_at FROM tab_links")[0] as any)
      .invitation_declined_at === 1234,
    "portable restore retains the declined invitation status",
  );
  ok(!target.exists("kaata.personal.restore.json"), "successful restore clears pending receipt");
  await errorCode(() => target.module.stagePersonalBackupRestore(bytes), "notEmpty");
  const oldSource = fixture("before-tally-notes", null, 51);
  oldSource.seed();
  const oldBackup = await exported(oldSource);
  const updated = fixture("after-tally-notes");
  await updated.module.stagePersonalBackupRestore(oldBackup);
  await updated.boot();
  ok(updated.rows("SELECT * FROM entries").length === 1, "pre-notes backup restores on update");
  const textOnly = fixture("text-only-tally-notes", null, 52);
  textOnly.seed();
  textOnly.sql("INSERT INTO tally_notes VALUES('note-2',?,'person','A text-only note')", VAULT);
  const upgraded = fixture("after-tally-note-numbers");
  await upgraded.module.stagePersonalBackupRestore(await exported(textOnly));
  await upgraded.boot();
  ok(
    (upgraded.rows("SELECT note FROM tally_notes")[0] as any).note === "A text-only note",
    "text-only tally note backups restore on update",
  );
  const beforeDecline = fixture("before-invitation-decline", null, 53);
  beforeDecline.seed();
  beforeDecline.sql("INSERT INTO tab_links(tab_id,vault_id,rev) VALUES('old-tab',?,0)", VAULT);
  const afterDecline = fixture("after-invitation-decline");
  await afterDecline.module.stagePersonalBackupRestore(await exported(beforeDecline));
  await afterDecline.boot();
  ok(
    afterDecline.rows("SELECT * FROM tab_links WHERE tab_id='old-tab'").length === 1,
    "shared links from a backup without decline metadata restore on update",
  );
  const signed = fixture("signed-source", ACCOUNT);
  signed.seed();
  const signedBytes = await exported(signed);
  ok(signed.fetchCount === 2, "export verifies current server ownership before and after snapshot");
  const offlineSource = fixture("signed-offline-file-source", ACCOUNT);
  offlineSource.seed();
  offlineSource.denyCloud();
  offlineSource.sql("INSERT INTO vaults VALUES(?,?,?,?,0,NULL)", TARGET, OTHER, 1, PUB);
  offlineSource.sql("INSERT INTO vault_members_mirror VALUES(?,?,'editor',1,NULL)", TARGET, ACCOUNT);
  offlineSource.sql("INSERT INTO entries VALUES('joined',?,'PRIVATE_JOINED_OFFLINE')", TARGET);
  offlineSource.sql(
    "INSERT INTO event_log VALUES('joined-pending',?,'entry_created','{}',NULL,NULL)",
    TARGET,
  );
  offlineSource.sql(
    "INSERT INTO event_log VALUES('owned-pending',?,'entry_created','{}',NULL,NULL)",
    VAULT,
  );
  const offline = await offlineSource.module.createPersonalBackupSnapshot(false, {
    localOnly: true,
    requireData: true,
  });
  let offlineBytes: Uint8Array;
  try {
    assert.deepEqual(offline.coverage, { included: 1, skipped: 1, skippedPending: 1 });
    offlineBytes = openDriveBackup(createDriveBackup(offline.file.bytesSync(), {}));
  } finally {
    offline.dispose();
  }
  ok(offlineSource.fetchCount === 0, "signed local export never calls Kaata Cloud");
  ok(
    !Buffer.from(offlineBytes).includes("PRIVATE_JOINED_OFFLINE") &&
      offlineSource.rows("SELECT * FROM entries WHERE id='joined'").length === 1,
    "skipped data is absent from the ZIP and retained on the phone",
  );
  const offlineTarget = fixture("signed-offline-file-target", ACCOUNT);
  offlineTarget.denyCloud();
  await errorCode(
    () => offlineTarget.module.stagePersonalBackupRestore(offlineBytes),
    "ownershipUnavailable",
  );
  assert(!offlineTarget.exists("kaata.personal.restore.json"));
  offlineTarget.allowCloud();
  await offlineTarget.module.stagePersonalBackupRestore(offlineBytes);
  await offlineTarget.boot();
  assert.deepEqual(offlineTarget.rows("SELECT id FROM vaults"), [{ id: VAULT }]);
  assert.deepEqual(offlineTarget.rows("SELECT id FROM entries"), [{ id: "tally" }]);
  ok(
    offlineTarget.rows(
      "SELECT * FROM event_log WHERE event_id='owned-pending' AND server_acked_at IS NULL",
    ).length === 1,
    "the offline ZIP restores to the same account with pending changes intact",
  );
  await errorCode(
    () =>
      offlineSource.module.createPersonalBackupSnapshot(false, {
        localOnly: true,
        expectedSession: { bindingVersion: -1, jwt: jwt(ACCOUNT), accountId: ACCOUNT },
      }),
    "sessionChanged",
  );
  offlineSource.sql("INSERT INTO vaults VALUES(?,?,?,?,0,NULL)", OTHER, ACCOUNT, 1, PUB);
  await errorCode(
    () => offlineSource.module.createPersonalBackupSnapshot(false, { localOnly: true }),
    "ownership",
  );
  assert.equal(offlineSource.fetchCount, 0, "an ambiguous local book fails without using the network");
  const staleOwner = fixture("stale-export-owner", ACCOUNT);
  staleOwner.seed();
  staleOwner.remote[0].role = "editor";
  await errorCode(() => exported(staleOwner), "noOwnedVaults");
  const localOnly = fixture("signed-local-only", ACCOUNT);
  localOnly.seed();
  localOnly.sql("UPDATE vaults SET account_id=NULL,registered_with_server_at=NULL");
  localOnly.sql("UPDATE vault_members_mirror SET account_id=?", localAccount(PUB));
  localOnly.remote.length = 0;
  const localBytes = await exported(localOnly);
  const localTarget = fixture("signed-local-target", ACCOUNT);
  localTarget.remote.length = 0;
  await localTarget.module.stagePersonalBackupRestore(localBytes);
  await localTarget.boot();
  ok(
    localTarget.rows("SELECT * FROM entries").length === 1,
    "signed unregistered local-owner book survives",
  );
  const boundSetup = fixture("signed-pristine-after-ninja", ACCOUNT);
  boundSetup.seed(false);
  boundSetup.sql(
    "INSERT INTO vault_members_mirror VALUES(?,?,'owner',1,2)",
    VAULT,
    localAccount(PUB),
  );
  await boundSetup.module.stagePersonalBackupRestore(signedBytes);
  await boundSetup.boot();
  ok(
    boundSetup.rows("SELECT * FROM entries").length === 1,
    "ordinary sign-in retired owner sentinel is still pristine",
  );
  const signedTarget = fixture("signed-target", ACCOUNT);
  signedTarget.metadata("install_id", TARGET);
  await signedTarget.module.stagePersonalBackupRestore(signedBytes);
  ok(signedTarget.fetchCount === 1, "signed restore checks authoritative owner");
  await signedTarget.boot();
  ok(signedTarget.fetchCount === 2, "boot repeats owner verification");
  const wrong = fixture("wrong-account", OTHER);
  await errorCode(() => wrong.module.stagePersonalBackupRestore(signedBytes), "differentAccount");
  const signedOut = fixture("signed-out", ACCOUNT);
  signedOut.expireSession();
  await errorCode(
    () => signedOut.module.stagePersonalBackupRestore(signedBytes),
    "differentAccount",
  );
  const foreign = fixture("foreign-member", ACCOUNT);
  foreign.seed();
  foreign.sql("UPDATE vaults SET account_id=?", OTHER);
  await errorCode(() => foreign.module.createPersonalBackupSnapshot(), "ownership");
  const member = fixture("member-not-owner", ACCOUNT);
  member.seed();
  member.sql("UPDATE vault_members_mirror SET role='editor'");
  member.remote[0].role = "editor";
  await errorCode(() => member.module.createPersonalBackupSnapshot(), "noOwnedVaults");

  const mixed = fixture("mixed-owner-and-member", ACCOUNT);
  mixed.seed();
  mixed.sql("INSERT INTO vaults VALUES(?,?,?,?,0,NULL)", TARGET, ACCOUNT, 1, PUB);
  mixed.sql("INSERT INTO vaults VALUES(?,?,?,?,0,100)", OTHER, ACCOUNT, 1, PUB);
  mixed.remote.push(
    { vault_id: TARGET, role: "manager", vault_trust_anchor_pubkey: PUB },
    { vault_id: OTHER, role: "viewer", vault_trust_anchor_pubkey: PUB },
  );
  // Simulate one missing local membership mirror and one explicit joined seat.
  mixed.sql("INSERT INTO vault_members_mirror VALUES(?,?,'viewer',1,NULL)", OTHER, ACCOUNT);
  mixed.metadata("active_vault_id", TARGET);
  mixed.metadata("default_vault_id", TARGET);
  mixed.sql("INSERT INTO users VALUES('PRIVATE_JOINED_CONTACT',NULL,0)");
  mixed.sql("INSERT INTO users VALUES('shared-contact',NULL,0)");
  mixed.sql("UPDATE relationships SET user_b_id='shared-contact' WHERE id='person'");
  mixed.sql("INSERT INTO relationships VALUES('joined-only',?,'self','PRIVATE_JOINED_CONTACT')", TARGET);
  mixed.sql("INSERT INTO relationships VALUES('joined-shared',?,'self','shared-contact')", OTHER);
  mixed.sql("INSERT INTO entries VALUES('joined-tally',?,'PRIVATE_JOINED_TALLY')", TARGET);
  mixed.sql(
    "INSERT INTO event_log VALUES('joined-event',?,'entry_created',?,NULL,NULL)",
    TARGET,
    JSON.stringify({ note: "PRIVATE_JOINED_EVENT" }),
  );
  mixed.sql(
    "INSERT INTO tab_links(tab_id,vault_id,party_token,last_synced_at,rev) VALUES('joined-tab',?,'PRIVATE_JOINED_TOKEN',1,1)",
    TARGET,
  );
  mixed.sql("INSERT INTO tab_entries VALUES('joined-tab-entry','joined-tab','PRIVATE_JOINED_SHARED_TALLY')");
  mixed.sql(
    "INSERT INTO tab_outbox VALUES('joined-op','joined-tab',0,NULL,NULL,?)",
    JSON.stringify({ note: "PRIVATE_JOINED_OP" }),
  );
  const mixedBackup = await mixed.module.createPersonalBackupSnapshot();
  let mixedBytes: Uint8Array;
  try {
    assert.deepEqual(mixedBackup.coverage, { included: 1, skipped: 2, skippedPending: 1 });
    mixedBytes = mixedBackup.file.bytesSync();
    ok(!Buffer.from(mixedBytes).includes("PRIVATE_JOINED_"), "no skipped data remains in SQLite bytes");
    ok(!Buffer.from(mixedBytes).includes(TARGET), "skipped active/default metadata is replaced");
  } finally {
    mixedBackup.dispose();
  }
  ok(mixed.rows("SELECT * FROM vaults").length === 3, "pruning never touches live Kaatas");
  ok(mixed.rows("SELECT * FROM tab_outbox").length === 1, "joined pending edits remain on the phone");
  const mixedTarget = fixture("mixed-restore-target", ACCOUNT);
  await mixedTarget.module.stagePersonalBackupRestore(mixedBytes);
  await mixedTarget.boot();
  assert.deepEqual(mixedTarget.rows("SELECT id FROM vaults"), [{ id: VAULT }]);
  assert.deepEqual(mixedTarget.rows("SELECT id FROM users ORDER BY id"), [{ id: "self" }, { id: "shared-contact" }]);
  assert.deepEqual(mixedTarget.rows("SELECT value FROM app_meta WHERE key IN ('active_vault_id','default_vault_id')"), [{ value: VAULT }, { value: VAULT }]);
  assert.deepEqual(mixedTarget.rows("SELECT value FROM app_meta WHERE key='personal_backup_joined_recovery_account'"), [{ value: ACCOUNT }]);

  const verificationUnavailable = fixture("owner-verification-unavailable", ACCOUNT);
  verificationUnavailable.seed();
  verificationUnavailable.denyCloud();
  await errorCode(() => verificationUnavailable.module.createPersonalBackupSnapshot(), "ownershipUnavailable");
  const denied = fixture("server-denial", ACCOUNT);
  denied.denyCloud();
  await errorCode(() => denied.module.stagePersonalBackupRestore(signedBytes), "ownershipUnavailable");
  const demoted = fixture("server-role", ACCOUNT);
  demoted.remote[0].role = "editor";
  await errorCode(() => demoted.module.stagePersonalBackupRestore(signedBytes), "ownership");
  const anchor = fixture("server-anchor", ACCOUNT);
  anchor.remote[0].vault_trust_anchor_pubkey = Buffer.alloc(32, 9).toString("base64");
  await errorCode(() => anchor.module.stagePersonalBackupRestore(signedBytes), "ownership");
  const race = fixture("session-race", ACCOUNT);
  race.onFetch(() => race.switchAccount(OTHER));
  await errorCode(() => race.module.stagePersonalBackupRestore(signedBytes), "sessionChanged");
  ok(
    !race.exists("kaata.personal.restore.json"),
    "late response cannot stage into changed session",
  );
  const late = fixture("late-tally");
  await late.module.stagePersonalBackupRestore(bytes);
  late.seed();
  await errorCode(() => late.boot(), "notEmpty");
  ok(late.rows("SELECT * FROM entries").length === 1, "late live edits preserved");
  ok(!late.exists("kaata.personal.restore.json"), "refused boot does not repeat forever");
  const secondary = fixture("secondary");
  secondary.seed(false);
  secondary.sql("INSERT INTO vaults VALUES(?,NULL,NULL,?,0,NULL)", OTHER, PUB);
  await errorCode(() => secondary.module.stagePersonalBackupRestore(bytes), "notEmpty");
  const edited = fixture("edited-setup");
  edited.seed(false);
  edited.sql("INSERT INTO event_log VALUES('profile2',?,'shop_profile_updated','{}',NULL,NULL)", VAULT);
  await errorCode(() => edited.module.stagePersonalBackupRestore(bytes), "notEmpty");
  const revoked = fixture("revoked-after-stage", ACCOUNT);
  await revoked.module.stagePersonalBackupRestore(signedBytes);
  revoked.remote[0].role = "viewer";
  await errorCode(() => revoked.boot(), "ownership");
  ok(
    revoked.rows("SELECT * FROM entries").length === 0,
    "revoked restore leaves original empty ledger",
  );
  const failed = fixture("rename-failure");
  await failed.module.stagePersonalBackupRestore(bytes);
  failed.failMove.add("kaata.personal.restore.db");
  await errorCode(() => failed.boot(), "invalid");
  ok(failed.exists("kaata.db"), "rename failure restores original path");
  ok(failed.rows("SELECT * FROM entries").length === 0, "rename failure never partly imports");
  const parked = fixture("crash-before-landing");
  await parked.module.stagePersonalBackupRestore(bytes);
  await parked.close();
  renameSync(
    path.join(parked.dir, "kaata.db"),
    path.join(parked.dir, "kaata.personal.original.db"),
  );
  await parked.boot();
  ok(parked.rows("SELECT * FROM entries").length === 0, "interrupted parking rolls original back");
  const landed = fixture("crash-after-landing");
  await landed.module.stagePersonalBackupRestore(bytes);
  await landed.close();
  renameSync(
    path.join(landed.dir, "kaata.db"),
    path.join(landed.dir, "kaata.personal.original.db"),
  );
  renameSync(path.join(landed.dir, "kaata.personal.restore.db"), path.join(landed.dir, "kaata.db"));
  await landed.boot();
  ok(landed.rows("SELECT * FROM entries").length === 1, "completed landing survives interruption");
  const malformed = fixture("malformed");
  await errorCode(
    () => malformed.module.stagePersonalBackupRestore(new Uint8Array(120)),
    "invalid",
  );
  const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
  await errorCode(() => malformed.module.stagePersonalBackupRestore(oversized), "tooLarge");
  const tampered = fixture("tampered-staging");
  await tampered.module.stagePersonalBackupRestore(bytes);
  writeFileSync(path.join(tampered.dir, "kaata.personal.restore.db"), "wrong");
  await errorCode(() => tampered.boot(), "invalid");
  ok(
    tampered.rows("SELECT * FROM entries").length === 0,
    "staged hash mismatch preserves live ledger",
  );
  const damagedReceipt = fixture("damaged-receipt");
  await damagedReceipt.module.stagePersonalBackupRestore(bytes);
  writeFileSync(path.join(damagedReceipt.dir, "kaata.personal.restore.json"), "{");
  await errorCode(() => damagedReceipt.boot(), "invalid");
  ok(!damagedReceipt.exists("kaata.personal.restore.json"), "damaged pre-swap receipt is cleared");
  await damagedReceipt.boot();
  const noReceipt = fixture("parked-without-receipt");
  await noReceipt.module.stagePersonalBackupRestore(bytes);
  await noReceipt.close();
  renameSync(
    path.join(noReceipt.dir, "kaata.db"),
    path.join(noReceipt.dir, "kaata.personal.original.db"),
  );
  unlinkSync(path.join(noReceipt.dir, "kaata.personal.restore.json"));
  await noReceipt.boot();
  ok(
    noReceipt.rows("SELECT * FROM entries").length === 0 &&
      !noReceipt.exists("kaata.personal.original.db"),
    "missing receipt still rolls parked original back",
  );
  const partial = fixture("partial-landing");
  await partial.module.stagePersonalBackupRestore(bytes);
  await partial.close();
  renameSync(
    path.join(partial.dir, "kaata.db"),
    path.join(partial.dir, "kaata.personal.original.db"),
  );
  writeFileSync(path.join(partial.dir, "kaata.db"), "partial bytes");
  await errorCode(() => partial.boot(), "invalid");
  ok(partial.rows("SELECT * FROM entries").length === 0, "partial landing rolls original back");
  const legacy = fixture("legacy-source");
  legacy.seed();
  legacy.sql("CREATE TABLE _old_shopkeeper(name TEXT)");
  legacy.sql("INSERT INTO _old_shopkeeper VALUES('OLD_SECRET')");
  const legacyBytes = await exported(legacy);
  ok(
    !Buffer.from(legacyBytes).includes(Buffer.from("OLD_SECRET")),
    "legacy migration source is removed from portable copy",
  );
  const alterBytes = (sql: string) => {
    const filename = path.join(temporaryRoot, "altered.db");
    writeFileSync(filename, bytes);
    const db = new Database(filename);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    const result = new Uint8Array(readFileSync(filename));
    unlinkSync(filename);
    return result;
  };
  const missingSchema = fixture("missing-schema");
  await errorCode(
    () =>
      missingSchema.module.stagePersonalBackupRestore(alterBytes("DROP TABLE pending_invitations")),
    "unsupported",
  );
  const missingMigration = fixture("missing-migration");
  await errorCode(
    () =>
      missingMigration.module.stagePersonalBackupRestore(
        alterBytes("DELETE FROM schema_migrations WHERE name LIKE '001_%'"),
      ),
    "unsupported",
  );
  const inconsistentTallyMigration = fixture("inconsistent-tally-migration");
  await errorCode(
    () =>
      inconsistentTallyMigration.module.stagePersonalBackupRestore(
        alterBytes("DELETE FROM schema_migrations WHERE name='052_tally_notes'"),
      ),
    "unsupported",
  );
  const missingNumberColumn = fixture("missing-note-number-column");
  await errorCode(
    () =>
      missingNumberColumn.module.stagePersonalBackupRestore(
        alterBytes("ALTER TABLE tally_notes DROP COLUMN number_text"),
      ),
    "unsupported",
  );
  const inconsistentDecline = fixture("inconsistent-invitation-decline");
  await errorCode(
    () =>
      inconsistentDecline.module.stagePersonalBackupRestore(
        alterBytes("ALTER TABLE tab_links DROP COLUMN invitation_declined_at"),
      ),
    "unsupported",
  );
  await errorCode(
    () =>
      inconsistentDecline.module.stagePersonalBackupRestore(
        alterBytes("DELETE FROM schema_migrations WHERE name='054_shared_invitation_decline'"),
      ),
    "unsupported",
  );
  const reordered = fixture("upgraded-column-order");
  await reordered.module.stagePersonalBackupRestore(
    alterBytes(
      "DROP TABLE customer_groups; CREATE TABLE customer_groups(vault_id TEXT REFERENCES vaults(id),id TEXT PRIMARY KEY);",
    ),
  );
  ok(
    reordered.exists("kaata.personal.restore.json"),
    "semantically equivalent upgrade column order is accepted",
  );
  const weakened = fixture("weakened-constraint");
  await errorCode(
    () =>
      weakened.module.stagePersonalBackupRestore(
        alterBytes(
          "CREATE TABLE replacement(id TEXT PRIMARY KEY,vault_id TEXT,note TEXT); INSERT INTO replacement SELECT * FROM entries; DROP TABLE entries; ALTER TABLE replacement RENAME TO entries;",
        ),
      ),
    "unsupported",
  );
  console.log(`personal-backup-db: ${checks} checks passed`);
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const db of handles) if (db.open) db.close();
    assert.equal(path.dirname(temporaryRoot), temporaryParent);
    assert.ok(path.basename(temporaryRoot).startsWith("personal-backup-test-"));
    rmSync(temporaryRoot, { recursive: true, force: true });
  });
