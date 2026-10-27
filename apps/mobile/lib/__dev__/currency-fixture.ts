import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type Database from "better-sqlite3";

/** Execute the shipped migration in an isolated fixture without importing Expo. */
export async function applyCurrencyMigration(store: Database.Database): Promise<void> {
  const source = readFileSync(require.resolve("../db"), "utf8");
  const ast = ts.createSourceFile("db.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "runMigration042",
  );
  assert.ok(declaration, "actual migration042");
  const exports: any = {};
  const code = ts.transpileModule("export " + declaration.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("exports", "columnExists", "MIGRATION_042", code)(
    exports,
    async (_db: unknown, table: string, column: string) =>
      store
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row: any) => row.name === column),
    "042_ledger_currencies",
  );
  await exports.runMigration042({
    execAsync: async (sql: string) => store.exec(sql),
    runAsync: async (sql: string, ...args: any[]) => store.prepare(sql).run(...args),
    withTransactionAsync: async (work: () => Promise<void>) => {
      store.exec("BEGIN");
      try {
        await work();
        store.exec("COMMIT");
      } catch (error) {
        store.exec("ROLLBACK");
        throw error;
      }
    },
  });
}
