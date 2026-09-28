import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { tallyScrollTarget } from "../tally-viewport";

const viewport = { offset: 100, viewport: 700, bottomInset: 100, height: 80 };
assert.equal(tallyScrollTarget({ ...viewport, top: 250 }), null, "upper-middle tally stays put");
assert.equal(tallyScrollTarget({ ...viewport, top: 420 }), null, "middle tally stays put");
assert.equal(
  tallyScrollTarget({ ...viewport, top: 550 }),
  null,
  "fully visible lower tally stays put",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 900 }),
  640,
  "offscreen tally centered, not pinned to top",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 40 }),
  0,
  "above viewport: clamp to content start",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 660 }),
  400,
  "reveal tally covered by floating actions",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 550, bottomInset: 250 }),
  365,
  "account for toast-raised footer",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 250, height: 800 }),
  null,
  "visible long note does not jump",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 900, height: 800 }),
  884,
  "offscreen long note reveals its beginning",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 900, viewport: 0 }),
  null,
  "wait for measured viewport",
);

const TAB = "00000000-0000-4000-8000-000000000001";
const ENTRY = "00000000-0000-4000-8000-000000000002";
let account: string | null = "account",
  accessible = true,
  cached = true,
  switchAccount = false;
const calls: string[] = [];
const routes: any[] = [];
const handled: unknown[] = [];
let markThrows = false;
const mocks: Record<string, any> = {
  "./inbox-reads": {
    markInboxHandled: (spec: unknown) => {
      handled.push(spec);
      if (markThrows) throw new Error("queue unavailable");
      return Promise.resolve();
    },
  },
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
  // Landing on the tally reads its notice — by inbox id (with tray hints)
  // from the bell, by the exact rev an OS payload announced (the entry as a
  // tray hint), by entry only when no rev is known, never with an entry id
  // that failed validation, and never at all when the tap named nothing. A
  // failing mark cannot undo the navigation.
  assert.deepEqual(handled, [
    { tab_id: TAB, entry_id: ENTRY },
    { tab_id: TAB, entry_id: ENTRY },
    { tab_id: TAB, entry_id: ENTRY },
  ]);
  handled.length = 0;
  await out.openTabNotification(TAB, ENTRY, { notificationId: "77", rev: 3 });
  await out.openTabNotification(TAB, ENTRY, { rev: 4 });
  await out.openTabNotification(TAB, null, { rev: 3 });
  await out.openTabNotification(TAB, "../../untrusted", { notificationId: "78" });
  await out.openTabNotification(TAB, "../../untrusted", { rev: 0 });
  await out.openTabNotification(TAB);
  assert.deepEqual(handled, [
    { id: "77", tab_id: TAB, entry_id: ENTRY, rev: 3 },
    { tab_id: TAB, rev: 4, entry_id: ENTRY },
    { tab_id: TAB, rev: 3 },
    { id: "78", tab_id: TAB },
  ]);
  markThrows = true;
  const routed = routes.length;
  await out.openTabNotification(TAB, ENTRY);
  assert.equal(routes.length, routed + 1, "a failing read mark must not fail the navigation");
  markThrows = false;
  handled.length = 0;
  const before = routes.length;
  accessible = false;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  accessible = true;
  switchAccount = true;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  account = null;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  assert.equal(routes.length, before, "revoked/signed-out/switched users never navigate");
  assert.equal(handled.length, 0, "a refused open must not read the notice either");
  console.log(
    "PASS: notification entry target, repeated taps, cold recovery, vault-before-route ordering, invalid payload, access checks and handled-means-read marks",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
