// The edit route reads only the active book and must discard late reads.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

function fixture(stage?: "entry" | "database" | "relationship" | "link") {
  const hooks = uiHooks();
  const gate = deferred<void>();
  let vault = "book",
    account: string | null = "account",
    install = "phone",
    id = "entry";
  let exists = true,
    relationship = true,
    linked = false;
  const reads: unknown[][] = [],
    routes: string[] = [];
  const pause = async (at: typeof stage) => {
    if (stage === at) await gate.promise;
  };
  const Screen = compileUI("../../app/entry/[id]/edit", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: hooks.react,
    "expo-router": {
      useLocalSearchParams: () => ({ id }),
      useRouter: () => ({ back: () => routes.push("back") }),
      useFocusEffect: (fn: () => void | (() => void)) => hooks.react.useEffect(fn, [fn]),
    },
    "../new": { __esModule: true, default: "EntryFormScreen" },
    "../../../components/ScreenLoading": { ScreenLoading: "ScreenLoading" },
    "../../../lib/db": {
      getEntry: async (entryId: string) => {
        reads.push(["entry", entryId]);
        await pause("entry");
        return exists
          ? { id: entryId, relationship_id: "relationship", currency: "USD", type: "payment" }
          : null;
      },
    },
    "../../../lib/db-tx": {
      getActiveVaultIdSyncMaybe: () => vault,
      getAccountIdSync: () => account,
      getInstallIdSync: () => install,
      getDb: async () => {
        reads.push(["database"]);
        await pause("database");
        return {
          getFirstAsync: async (sql: string, ...args: unknown[]) => {
            reads.push(["relationship", ...args]);
            assert.match(sql, /vault_id=\? AND archived_at IS NULL/);
            await pause("relationship");
            return relationship ? { person_id: "customer" } : null;
          },
        };
      },
    },
    "../../../lib/direction": { useIsRTL: () => true },
    "../../../lib/i18n": { t: (key: string) => key },
    "../../../lib/tabs/db": {
      getTabLinkForRelationship: async (...args: unknown[]) => {
        reads.push(["link", ...args]);
        await pause("link");
        return linked ? { tab_id: "shared" } : null;
      },
    },
  }).default;
  const render = () => hooks.render(Screen);
  return {
    hooks,
    reads,
    routes,
    render,
    release: () => gate.resolve(),
    ready: async () => {
      render();
      await settleUI();
      render();
    },
    setMissing: () => {
      exists = false;
    },
    setArchived: () => {
      relationship = false;
    },
    setLinked: () => {
      linked = true;
    },
    change: (kind: string) => {
      if (kind === "vault") vault = "other-book";
      if (kind === "account") account = "other-account";
      if (kind === "install") install = "other-phone";
      if (kind === "route") id = "other-entry";
      if (kind === "unmount") hooks.unmount();
    },
  };
}

async function main() {
  const good = fixture();
  await good.ready();
  assert.equal(good.hooks.tree.type, "EntryFormScreen");
  assert.equal(good.hooks.tree.props.editingEntry.id, "entry");
  assert.equal(good.hooks.tree.props.editingEntry.currency, "USD");
  assert.equal(good.hooks.tree.props.editPersonId, "customer");
  assert.deepEqual(
    good.reads.find((read) => read[0] === "relationship"),
    ["relationship", "relationship", "book"],
  );
  assert.deepEqual(
    good.reads.find((read) => read[0] === "link"),
    ["link", "relationship", "USD"],
  );
  good.hooks.unmount();

  for (const kind of ["missing", "archived", "linked"]) {
    const f = fixture();
    if (kind === "missing") f.setMissing();
    if (kind === "archived") f.setArchived();
    if (kind === "linked") f.setLinked();
    await f.ready();
    assert.equal(f.hooks.tree.type, "ScreenLoading");
    assert.equal(
      f.hooks.tree.props.message,
      kind === "linked" ? "tab.editLocked" : "entry.notFound",
    );
    f.hooks.tree.props.onBack();
    assert.deepEqual(f.routes, ["back"]);
    f.hooks.unmount();
  }
  for (const stage of ["entry", "database", "relationship", "link"] as const)
    for (const change of ["vault", "account", "install", "route", "unmount"]) {
      const f = fixture(stage);
      f.render();
      await settleUI();
      f.change(change);
      // Route changes are visible on the next render; its new read stays held.
      if (change === "route") {
        f.setMissing();
        f.render();
      }
      f.release();
      await settleUI();
      if (change !== "unmount") f.render();
      assert.equal(
        nodes(f.hooks.tree).some((node) => node.type === "EntryFormScreen"),
        false,
        `${stage}/${change}: late reads cannot expose an obsolete edit form`,
      );
      assert.equal(f.hooks.lateWrites, 0);
      if (change !== "unmount") f.hooks.unmount();
    }
  console.log(
    "PASS edit route: saved-currency context, active relationship, shared lock and 20 late-read scope cases",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
