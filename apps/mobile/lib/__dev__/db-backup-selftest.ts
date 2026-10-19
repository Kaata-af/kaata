// Execute the real backup/restore code against temporary files and SQLite.
// Only the native File and expo-sqlite boundaries are adapted for Node.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import ts from "typescript";
import { compileUI } from "./ui-fixture";

const DB_NAME = "kaata.db";
const CURRENT = "kaata.backup.db";
const PREVIOUS = "kaata.backup.prev.db";
const generations = [
  CURRENT,
  PREVIOUS,
  "kaata.backup.tmp.db",
  "kaata.restore.tmp.db",
  "kaata.corrupt.db",
];
const sidecars = (name: string) => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`];
const temporaryRoot = path.resolve(mkdtempSync(path.join(tmpdir(), "kaata-db-backup-selftest-")));
const handles = new Set<Database.Database>();

function fixture(name: string, directory: string) {
  const root = path.join(temporaryRoot, name);
  const sqliteRoot = path.join(root, "actual-sqlite");
  const documentRoot = path.join(root, "documents", "SQLite");
  mkdirSync(sqliteRoot, { recursive: true });
  mkdirSync(documentRoot, { recursive: true });
  const sqliteUri = directory.startsWith("file://") ? directory : `file://${directory}`;
  const documentUri = "file:///preview/documents";
  const touchedUris: string[] = [];
  const failures = {
    move: new Set<string>(),
    copy: new Set<string>(),
    delete: new Set<string>(),
    partialCopy: false,
  };

  class NativeFile {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri))
        .map((part) => part.replace(/\/$/, ""))
        .join("/");
      assert.ok(this.uri.startsWith("file://"), "File receives a normalized file URI");
      touchedUris.push(this.uri);
    }
    get filename() {
      for (const [prefix, destination] of [
        [sqliteUri.replace(/\/$/, ""), sqliteRoot],
        [`${documentUri}/SQLite`, documentRoot],
      ]) {
        if (!this.uri.startsWith(`${prefix}/`)) continue;
        const filename = path.resolve(destination, this.uri.slice(prefix.length + 1));
        assert.equal(
          path.dirname(filename),
          destination,
          "fixture files stay in their own directory",
        );
        return filename;
      }
      throw new Error("Unexpected native file location");
    }
    get exists() {
      return existsSync(this.filename);
    }
    get modificationTime() {
      return statSync(this.filename).mtimeMs;
    }
    get size() {
      return statSync(this.filename).size;
    }
    get md5() {
      return createHash("md5").update(readFileSync(this.filename)).digest("hex");
    }
    delete() {
      if (failures.delete.has(path.basename(this.filename)))
        throw new Error("injected delete failure");
      unlinkSync(this.filename);
    }
    moveSync(destination: NativeFile) {
      if (failures.move.has(path.basename(this.filename))) throw new Error("injected move failure");
      renameSync(this.filename, destination.filename);
      this.uri = destination.uri; // Expo updates the receiver after a move.
    }
    copySync(destination: NativeFile) {
      if (failures.copy.has(path.basename(this.filename))) {
        if (failures.partialCopy) writeFileSync(destination.filename, "partial copy");
        throw new Error("injected copy failure");
      }
      copyFileSync(this.filename, destination.filename);
    }
  }

  function open(databaseName: string) {
    const filename = path.join(sqliteRoot, databaseName);
    let db = new Database(filename);
    handles.add(db);
    return {
      get db() {
        return db;
      },
      filename,
      getFirstAsync: async (sql: string) => db.prepare(sql).get(),
      getAllAsync: async (sql: string) => db.prepare(sql).all(),
      closeAsync: async () => {
        db.close();
        handles.delete(db);
      },
      reopen: () => {
        db = new Database(filename);
        handles.add(db);
      },
    };
  }
  type Handle = ReturnType<typeof open>;
  let live: Handle | null = null;
  const getDb = async () => (live ??= open(DB_NAME));
  let resetCount = 0;
  const health = compileUI("../db-health", {});
  const backup = compileUI("../db-backup", {
    "expo-file-system": { File: NativeFile, Paths: { document: { uri: documentUri } } },
    "expo-sqlite": {
      defaultDatabaseDirectory: directory,
      openDatabaseAsync: async (databaseName: string) => open(databaseName),
      backupDatabaseAsync: async ({
        sourceDatabase,
        destDatabase,
      }: {
        sourceDatabase: Handle;
        destDatabase: Handle;
      }) => {
        // better-sqlite3 owns its backup destination connection. Close the
        // placeholder, then reopen it for the production module's real probes.
        await destDatabase.closeAsync();
        await sourceDatabase.db.backup(destDatabase.filename);
        destDatabase.reopen();
      },
    },
    "./db-health": health,
    "./db-tx": {
      DB_NAME,
      getDb,
      getAppMetaInTx: async (handle: Handle, key: string) =>
        (
          handle.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
            | { value: string }
            | undefined
        )?.value ?? null,
      setAppMetaInTx: async (handle: Handle, key: string, value: string) =>
        handle.db.prepare("INSERT OR REPLACE INTO app_meta VALUES (?, ?)").run(key, value),
      _resetDbHandleForReset: () => {
        live = null;
        resetCount++;
      },
      _resetActiveVaultIdCacheForReset: () => {
        resetCount++;
      },
      _resetAccountIdCacheForReset: () => {
        resetCount++;
      },
    },
  });
  const actual = (filename: string) => path.join(sqliteRoot, filename);
  const decoy = (filename: string) => path.join(documentRoot, filename);
  function entries(filename: string) {
    const db = new Database(actual(filename), { readonly: true, fileMustExist: true });
    try {
      return db.prepare("SELECT note FROM entries ORDER BY rowid").all();
    } finally {
      db.close();
    }
  }
  return {
    backup,
    actual,
    decoy,
    getDb,
    entries,
    touchedUris,
    failures,
    sqliteUri,
    resets: () => resetCount,
  };
}

async function checkDirectory(platform: string, directory: string) {
  const listing = fixture(`${platform}-listing`, directory);
  writeFileSync(listing.actual(CURRENT), "actual newest");
  writeFileSync(listing.actual(PREVIOUS), "actual previous backup");
  writeFileSync(listing.decoy(CURRENT), "wrong document-directory backup");
  assert.deepEqual(
    listing.backup
      .listLocalBackups()
      .map(({ name, size }: { name: string; size: number }) => ({ name, size })),
    [
      { name: CURRENT, size: Buffer.byteLength("actual newest") },
      { name: PREVIOUS, size: Buffer.byteLength("actual previous backup") },
    ],
    `${platform}: offer the actual SQLite backups, newest generation first`,
  );
  unlinkSync(listing.actual(CURRENT));
  assert.deepEqual(
    listing.backup.listLocalBackups().map(({ name }: { name: string }) => name),
    [PREVIOUS],
  );
  unlinkSync(listing.actual(PREVIOUS));
  assert.deepEqual(
    listing.backup.listLocalBackups(),
    [],
    "document-directory decoy is not offered",
  );

  const deletion = fixture(`${platform}-deletion`, directory);
  const backupFiles = generations.flatMap(sidecars);
  const liveFiles = sidecars(DB_NAME);
  for (const name of [...backupFiles, ...liveFiles, "unrelated.db"]) {
    writeFileSync(deletion.actual(name), `actual ${name}`);
    writeFileSync(deletion.decoy(name), `decoy ${name}`);
  }
  deletion.backup.deleteLocalBackups();
  assert.ok(
    backupFiles.every((name) => !existsSync(deletion.actual(name))),
    "all backup generations and sidecars removed",
  );
  assert.ok(
    liveFiles.every((name) => existsSync(deletion.actual(name))),
    "backup deletion preserves the live ledger",
  );
  deletion.backup.deleteLiveDatabaseFiles();
  assert.ok(
    liveFiles.every((name) => !existsSync(deletion.actual(name))),
    "explicit live wipe removes its database and sidecars",
  );
  assert.equal(readFileSync(deletion.actual("unrelated.db"), "utf8"), "actual unrelated.db");
  for (const name of [...backupFiles, ...liveFiles, "unrelated.db"]) {
    assert.equal(
      readFileSync(deletion.decoy(name), "utf8"),
      `decoy ${name}`,
      "decoy directory is untouched",
    );
  }

  const rotation = fixture(`${platform}-rotation`, directory);
  const source = await rotation.getDb();
  source.db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE event_log (id TEXT);
    CREATE TABLE entries (note TEXT);
    CREATE TABLE relationships (id TEXT);
    CREATE TABLE users (id TEXT);
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO entries VALUES ('first tally');
  `);
  writeFileSync(rotation.decoy(CURRENT), "document decoy must survive");
  assert.equal(
    await rotation.backup.backupNow(),
    true,
    `${platform}: verified backup promotes from SQLite scratch`,
  );
  assert.deepEqual(rotation.entries(CURRENT), [{ note: "first tally" }]);
  source.db.prepare("INSERT INTO entries VALUES (?)").run("second tally");
  for (const name of sidecars(PREVIOUS))
    writeFileSync(rotation.actual(name), "obsolete generation");
  for (const name of [`${CURRENT}-wal`, `${CURRENT}-shm`])
    writeFileSync(rotation.actual(name), "stale probe sidecar");
  assert.equal(
    await rotation.backup.backupNow(),
    true,
    "second backup rotates without overwriting the new copy",
  );
  assert.ok(
    !existsSync(rotation.actual(`${CURRENT}-wal`)) &&
      !existsSync(rotation.actual(`${CURRENT}-shm`)),
    "stale sidecars cannot attach to the new generation",
  );
  assert.deepEqual(rotation.entries(CURRENT), [{ note: "first tally" }, { note: "second tally" }]);
  assert.deepEqual(rotation.entries(PREVIOUS), [{ note: "first tally" }]);
  assert.ok(!existsSync(rotation.actual("kaata.backup.tmp.db")), "scratch was promoted");
  const stamp = source.db
    .prepare("SELECT value FROM app_meta WHERE key = 'last_local_backup_at'")
    .get() as { value: string };
  assert.ok(Number(stamp.value) > 0, "attempt timestamp remains in the real ledger");
  source.db.prepare("INSERT INTO entries VALUES (?)").run("after backup");
  assert.equal(
    await rotation.backup.restoreFromLocalBackup(),
    "restored",
    "restore stages and lands inside SQLite's directory",
  );
  assert.deepEqual(rotation.entries(DB_NAME), [{ note: "first tally" }, { note: "second tally" }]);
  assert.deepEqual(rotation.entries("kaata.corrupt.db"), [
    { note: "first tally" },
    { note: "second tally" },
    { note: "after backup" },
  ]);
  assert.deepEqual(
    rotation.entries(CURRENT),
    [{ note: "first tally" }, { note: "second tally" }],
    "restore keeps its source backup",
  );
  assert.equal(rotation.resets(), 3, "restore resets the database and identity caches");
  assert.equal(readFileSync(rotation.decoy(CURRENT), "utf8"), "document decoy must survive");
  for (const scenario of [listing, deletion, rotation]) {
    assert.ok(scenario.touchedUris.length > 0);
    assert.ok(
      scenario.touchedUris.every((uri) =>
        uri.startsWith(`${scenario.sqliteUri.replace(/\/$/, "")}/`),
      ),
      "all native file operations share SQLite's normalized URI",
    );
  }
}

async function restoreFixture(name: string) {
  const fixtureResult = fixture(name, "/data/user/0/host.exp.exponent/files/SQLite");
  const source = await fixtureResult.getDb();
  source.db.exec("CREATE TABLE entries (note TEXT); INSERT INTO entries VALUES ('saved tally');");
  await source.db.backup(fixtureResult.actual(CURRENT));
  await source.closeAsync();
  // Synthetic sidecar bytes model commits that a damaged close could not
  // checkpoint. The database/backup remain real SQLite, with no live handles.
  writeFileSync(fixtureResult.actual(`${DB_NAME}-wal`), "only surviving uncheckpointed tally");
  return fixtureResult;
}

function assertPending(fixtureResult: ReturnType<typeof fixture>) {
  assert.equal(
    readFileSync(fixtureResult.actual(`${DB_NAME}-wal`), "utf8"),
    "only surviving uncheckpointed tally",
  );
  assert.ok(existsSync(fixtureResult.actual("kaata.corrupt.db")), "original database is parked");
  assert.ok(
    existsSync(fixtureResult.actual("kaata.restore.tmp.db")),
    "verified staging remains for retry",
  );
  assert.ok(
    !existsSync(fixtureResult.actual(DB_NAME)),
    "staging cannot land beside the original WAL",
  );
}

async function exerciseRestoreFailures() {
  const wal = `${DB_NAME}-wal`;
  const parkedWal = "kaata.corrupt.db-wal";
  const copied = await restoreFixture("copy-fallback");
  copied.failures.move.add(wal);
  assert.equal(
    await copied.backup.restoreFromLocalBackup(),
    "restored",
    "copy fallback preserves the WAL when a move fails",
  );
  assert.equal(
    readFileSync(copied.actual(parkedWal), "utf8"),
    "only surviving uncheckpointed tally",
  );
  assert.ok(!existsSync(copied.actual(wal)));

  const blocked = await restoreFixture("move-and-copy-failure");
  blocked.failures.move.add(wal);
  blocked.failures.copy.add(wal);
  assert.equal(await blocked.backup.restoreFromLocalBackup(), "failed");
  assertPending(blocked);
  assert.equal(
    await blocked.backup.restoreFromLocalBackup(),
    "failed",
    "user retry cannot discard an unparked original WAL",
  );
  assertPending(blocked);
  const failedBoot = await executeRestoreBoot(blocked.backup.finishInterruptedRestore);
  assert.equal(
    failedBoot.databaseCalls,
    0,
    "failed interrupted restore blocks every later database-opening boot step",
  );
  assert.equal(failedBoot.errors[0]?.stage, "init_db");
  assert.equal(
    failedBoot.diagnosticCalls,
    0,
    "SQLite-backed diagnostics cannot open an empty live ledger either",
  );
  assertPending(blocked);
  blocked.failures.copy.clear();
  const resumedBoot = await executeRestoreBoot(blocked.backup.finishInterruptedRestore);
  assert.equal(
    resumedBoot.databaseCalls,
    1,
    "boot resumes only after the staged ledger lands safely",
  );
  assert.deepEqual(resumedBoot.errors, []);
  assert.equal(
    readFileSync(blocked.actual(parkedWal), "utf8"),
    "only surviving uncheckpointed tally",
  );
  assert.ok(!existsSync(blocked.actual(wal)));
  assert.deepEqual(blocked.entries(DB_NAME), [{ note: "saved tally" }]);

  const retained = await restoreFixture("source-delete-failure");
  retained.failures.move.add(wal);
  retained.failures.delete.add(wal);
  assert.equal(await retained.backup.restoreFromLocalBackup(), "failed");
  assertPending(retained);
  assert.equal(
    readFileSync(retained.actual(parkedWal), "utf8"),
    "only surviving uncheckpointed tally",
  );
  assert.throws(() => retained.backup.finishInterruptedRestore(), /injected delete failure/);
  assert.equal(await retained.backup.restoreFromLocalBackup(), "failed");
  assertPending(retained);
  retained.failures.delete.clear();
  assert.equal(
    await retained.backup.restoreFromLocalBackup(),
    "restored",
    "an identical parked copy allows a safe user deletion retry",
  );
  assert.ok(!existsSync(retained.actual(wal)));

  const partial = await restoreFixture("partial-copy-failure");
  partial.failures.move.add(wal);
  partial.failures.copy.add(wal);
  partial.failures.delete.add(parkedWal);
  partial.failures.partialCopy = true;
  assert.equal(await partial.backup.restoreFromLocalBackup(), "failed");
  assertPending(partial);
  assert.equal(readFileSync(partial.actual(parkedWal), "utf8"), "partial copy");
  assert.throws(() => partial.backup.finishInterruptedRestore(), /differs from the parked copy/);
  assert.equal(await partial.backup.restoreFromLocalBackup(), "failed");
  assertPending(partial);

  const journal = await restoreFixture("hot-journal-delete-failure");
  writeFileSync(journal.actual(`${DB_NAME}-journal`), "old hot rollback journal");
  journal.failures.delete.add(`${DB_NAME}-journal`);
  assert.equal(await journal.backup.restoreFromLocalBackup(), "failed");
  assert.ok(!existsSync(journal.actual(DB_NAME)), "hot journal prevents landing");
  assert.ok(existsSync(journal.actual("kaata.restore.tmp.db")));
  assert.equal(
    readFileSync(journal.actual(`${DB_NAME}-journal`), "utf8"),
    "old hot rollback journal",
  );
  assert.equal(
    readFileSync(journal.actual(parkedWal), "utf8"),
    "only surviving uncheckpointed tally",
  );
  assert.deepEqual(journal.entries(CURRENT), [{ note: "saved tally" }]);
  assert.throws(() => journal.backup.finishInterruptedRestore(), /injected delete failure/);
  assert.equal(await journal.backup.restoreFromLocalBackup(), "failed");
  assert.ok(
    existsSync(journal.actual("kaata.restore.tmp.db")),
    "failed journal retries retain staging",
  );
  journal.failures.delete.clear();
  assert.equal(await journal.backup.restoreFromLocalBackup(), "restored");
  assert.ok(!existsSync(journal.actual(`${DB_NAME}-journal`)));

  const parked = await restoreFixture("existing-original-delete-failure");
  writeFileSync(parked.actual("kaata.corrupt.db"), "irreplaceable parked original");
  parked.failures.delete.add(wal);
  assert.equal(await parked.backup.restoreFromLocalBackup(), "failed");
  assertPending(parked);
  assert.equal(
    readFileSync(parked.actual("kaata.corrupt.db"), "utf8"),
    "irreplaceable parked original",
  );
  assert.deepEqual(parked.entries(CURRENT), [{ note: "saved tally" }]);
}

function guardedDatabase(fixtureResult: ReturnType<typeof fixture>) {
  let opens = 0;
  let pragmaCalls = 0;
  const tx = compileUI("../db-tx", {
    "./db-backup": fixtureResult.backup,
    "expo-sqlite": {
      openDatabaseAsync: async (name: string) => {
        assert.equal(name, DB_NAME);
        opens++;
        const db = new Database(fixtureResult.actual(name));
        handles.add(db);
        return {
          execAsync: async (sql: string) => {
            pragmaCalls++;
            db.exec(sql);
          },
          closeAsync: async () => {
            db.close();
            handles.delete(db);
          },
        };
      },
    },
  });
  return { tx, opens: () => opens, pragmas: () => pragmaCalls };
}

async function exerciseDatabaseOpenGuard() {
  const pending = await restoreFixture("headless-open-guard");
  pending.failures.move.add(`${DB_NAME}-wal`);
  pending.failures.copy.add(`${DB_NAME}-wal`);
  assert.equal(await pending.backup.restoreFromLocalBackup(), "failed");
  const direct = guardedDatabase(pending);
  const first = direct.tx.getDb();
  const concurrent = direct.tx.getDb();
  assert.equal(
    first,
    concurrent,
    "concurrent headless callers share their pending opening promise",
  );
  const failed = await Promise.allSettled([first, concurrent]);
  assert.ok(failed.every((result) => result.status === "rejected"));
  assert.equal(direct.opens(), 0, "pending recovery opens zero native SQLite handles");
  assertPending(pending);
  await assert.rejects(direct.tx.getDb(), /injected copy failure/);
  assert.equal(direct.opens(), 0, "a direct retry cannot create an empty ledger");
  pending.failures.copy.clear();
  const recovered = await direct.tx.getDb();
  assert.equal(direct.opens(), 1, "a rejected opening resets so a repaired restore can retry");
  assert.equal(await direct.tx.getDb(), recovered);
  assert.equal(direct.pragmas(), 1, "all callers await one configured connection");
  assert.deepEqual(pending.entries(DB_NAME), [{ note: "saved tally" }]);

  const healthy = guardedDatabase(fixture("healthy-headless-open", "file:///ios/SQLite/"));
  const healthyFirst = healthy.tx.getDb();
  const healthySecond = healthy.tx.getDb();
  assert.equal(healthyFirst, healthySecond);
  assert.equal(await healthyFirst, await healthySecond);
  assert.equal(healthy.opens(), 1, "a healthy database still opens once");
  assert.equal(healthy.pragmas(), 1);
}

async function executeRestoreBoot(finishInterruptedRestore: () => boolean) {
  const text = readFileSync(require.resolve("../../app/_layout"), "utf8");
  const source = ts.createSourceFile(
    "_layout.tsx",
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  let statements: ts.NodeArray<ts.Statement> | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (entry) => ts.isIdentifier(entry.name) && entry.name.text === "step",
      )
    ) {
      assert.ok(ts.isBlock(node.parent));
      statements = node.parent.statements;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(statements, "real boot step wrapper is present");
  const firstDatabaseStep = statements.findIndex((entry) =>
    /await step\("account_deletion_cleanup"/.test(entry.getText(source)),
  );
  assert.ok(firstDatabaseStep > 0, "restore precedes the first database-opening boot step");
  const prefix = statements
    .slice(0, firstDatabaseStep)
    .map((entry) => entry.getText(source))
    .join("\n");
  const code = ts.transpileModule(
    `export async function run() { let aborted = false; ${prefix}\n await nextDatabaseStep(); }`,
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const exports: { run?: () => Promise<void> } = {};
  const errors: Array<{ stage: string }> = [];
  let databaseCalls = 0;
  let diagnosticCalls = 0;
  const health = compileUI("../db-health", {});
  const boot = compileUI("../boot-error", {});
  new Function(
    "require",
    "exports",
    "DB_BOOT_STAGES",
    "asCorruptionError",
    "toBootError",
    "setBootError",
    "setDbCorrupt",
    "setDbReady",
    "nextDatabaseStep",
    "console",
    code,
  )(
    (name: string) => {
      if (name === "../lib/db-backup") return { finishInterruptedRestore };
      if (name === "../lib/crash-report")
        return {
          queueCrashReport: () => {
            diagnosticCalls++;
          },
        };
      throw new Error(`Unexpected boot dependency ${name}`);
    },
    exports,
    new Set(),
    health.asCorruptionError,
    boot.toBootError,
    (error: { stage: string }) => errors.push(error),
    () => {},
    () => {},
    async () => {
      databaseCalls++;
    },
    { error: () => {}, warn: () => {} },
  );
  await exports.run!();
  return { databaseCalls, diagnosticCalls, errors };
}

async function main() {
  try {
    await checkDirectory("android", "/data/user/0/host.exp.exponent/files/SQLite");
    await checkDirectory(
      "ios",
      "file:///var/mobile/Containers/Data/Application/preview/Library/SQLite/",
    );
    await exerciseRestoreFailures();
    await exerciseDatabaseOpenGuard();
    console.log(
      "db-backup selftest: Android/iOS listing, complete wipes, SQLite rotation and restore passed",
    );
  } finally {
    for (const db of handles) if (db.open) db.close();
    // Resolve and validate the exact disposable root before any recursive delete.
    assert.equal(path.dirname(temporaryRoot), path.resolve(tmpdir()));
    assert.ok(path.basename(temporaryRoot).startsWith("kaata-db-backup-selftest-"));
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
