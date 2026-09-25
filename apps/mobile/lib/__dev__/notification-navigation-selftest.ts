import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const TAB = "00000000-0000-4000-8000-000000000001";
const ENTRY = "00000000-0000-4000-8000-000000000002";
let account: string | null = "account",
  accessible = true,
  cached = true,
  switchAccount = false;
const calls: string[] = [];
const routes: any[] = [];
const mocks: Record<string, any> = {
  "expo-router": {
    router: {
      push: (r: any) => {
        calls.push("route");
        routes.push(r);
      },
    },
  },
  "../db-tx": {
    getAccountIdSync: () => account,
    setActiveVaultId: async (id: string) => {
      calls.push(id);
    },
  },
  "../currency": {
    applyVaultCurrency: async () => {
      calls.push("currency");
    },
  },
  "./db": {
    getTabLink: async () =>
      cached ? { relationship_id: "relationship", vault_id: "correct-vault" } : null,
    getPersonIdForRelationship: async () => {
      if (switchAccount) account = "another-account";
      return "person";
    },
  },
  "./sync": {
    reconcileTabsFromServer: async () => {
      cached = true;
      calls.push("recover");
    },
    syncTab: async () => {
      calls.push("sync");
      return { ok: accessible };
    },
  },
};
const out: any = {};
new Function(
  "require",
  "exports",
  ts.transpileModule(readFileSync(require.resolve("../tabs/open-notification"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)((key: string) => {
  assert.ok(key in mocks, key);
  return mocks[key];
}, out);
async function main() {
  await out.openTabNotification(TAB, ENTRY);
  assert.deepEqual(calls, ["sync", "correct-vault", "currency", "route"]);
  assert.equal(routes[0].params.entryId, ENTRY);
  const key = routes[0].params.notificationKey;
  await out.openTabNotification(TAB, ENTRY);
  assert.notEqual(routes[1].params.notificationKey, key, "repeat tap must replay the highlight");
  calls.length = 0;
  cached = false;
  await out.openTabNotification(TAB, ENTRY);
  assert.equal(calls[0], "recover");
  await out.openTabNotification(TAB, "../../untrusted");
  assert.equal(routes.at(-1).params.entryId, undefined);
  const before = routes.length;
  accessible = false;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  accessible = true;
  switchAccount = true;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  account = null;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  assert.equal(routes.length, before, "revoked/signed-out/switched users never navigate");
  console.log(
    "PASS: notification entry target, repeated taps, cold recovery, vault-before-route ordering, invalid payload and access checks",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
