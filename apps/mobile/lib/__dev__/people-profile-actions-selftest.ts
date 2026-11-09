import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const person = { account_id: "target", name: "John", username: "john" };
class SessionChangedError extends Error {}
function fixture(
  options: {
    activity?: any;
    vault?: string | null;
    local?: string;
    holdProfile?: boolean;
    canReceiveRequests?: boolean;
  } = {},
) {
  const hooks = uiHooks();
  let vault = options.vault === undefined ? "book-a" : options.vault;
  let binding = 1,
    current = true,
    amend = true,
    invite = true;
  let refresh: () => void = () => {};
  const reads: Array<{ vault: string; session: any; reply: ReturnType<typeof deferred<any>> }> = [];
  const navigations: unknown[] = [],
    opened: string[] = [];
  let changed = 0;
  const props = {
    person,
    disabled: false,
    session: { accountId: "me", jwt: "jwt", bindingVersion: 1 },
    isCurrent: () => current,
    onChanged: () => {
      changed++;
    },
    onOpenLedger: (id: string) => opened.push(id),
  };
  const Component = compileUI("../../components/PeopleProfileActions", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "expo-router": {
      useRouter: () => ({
        push: (route: any) => navigations.push(route),
        dismissTo: (route: any) => navigations.push(route),
      }),
      useFocusEffect: (fn: () => void) => hooks.react.useEffect(fn, [fn]),
    },
    "react-native": { Text: "Text", View: "View" },
    "../lib/auth": {
      SessionChangedError,
      applyForCurrentSession: async (session: any, work: () => Promise<any>) => {
        if (session.bindingVersion !== binding) throw new SessionChangedError();
        return work();
      },
    },
    "../lib/db-tx": {
      getActiveVaultIdSyncMaybe: () => vault,
      getDb: async () => ({
        getFirstAsync: async (sql: string) =>
          sql.includes("FROM vaults")
            ? { name: "My Shop" }
            : options.local
              ? { user_b_id: options.local }
              : null,
      }),
    },
    "../lib/friends-api": {
      getPersonProfile: (id: string, session: any, selectedVault: string, before: () => void) => {
        assert.equal(id, person.account_id);
        before();
        const reply = deferred<any>();
        reads.push({ vault: selectedVault, session, reply });
        if (!options.holdProfile)
          reply.resolve({
            person,
            can_receive_requests: options.canReceiveRequests ?? true,
            friendship: { state: "none" },
            activity: options.activity,
          });
        return reply.promise;
      },
    },
    "../lib/people-connections": {
      getDiscoveredPersonIds: async () => ({}),
      discoveredPersonId: () => "deterministic-local-id",
    },
    "../lib/use-vault-role": {
      useActiveVaultWriteCaps: () => ({ resolved: true, canAmend: amend, canCreate: amend }),
      useVaultPermission: () => invite,
    },
    "../lib/ledger-events": {
      useLedgerRefresh: (_id: string | null, fn: () => void) => {
        refresh = fn;
      },
    },
    "../lib/i18n": {
      t: (key: string, args?: any) => (args ? `${key}:${JSON.stringify(args)}` : key),
    },
    "../lib/colors": { colors: {} },
    "../lib/direction": { textDir: () => ({}), useIsRTL: () => false },
    "../lib/tokens": { typography: {} },
    "./DiscoveredPersonDialog": { DiscoveredPersonDialog: "TallyDialog" },
    "./SettingsScreen": {
      EmptyHint: "EmptyHint",
      NavRow: "NavRow",
      SectionHeader: "SectionHeader",
    },
  }).PeopleProfileActions;
  const render = () => hooks.render(() => Component(props));
  const all = () => nodes(hooks.tree);
  const row = (label: string) => {
    const value = all().find((n) => n.type === "NavRow" && n.props.label === label);
    assert.ok(value, label);
    return value;
  };
  const settle = async () => {
    await settleUI();
    render();
    await settleUI();
    render();
  };
  render();
  return {
    props,
    hooks,
    reads,
    navigations,
    opened,
    render,
    all,
    row,
    settle,
    changed: () => changed,
    setVault: (value: string) => {
      vault = value;
      refresh();
      render();
    },
    invalidate: () => {
      current = false;
    },
    rebind: () => {
      binding++;
    },
    permissions: (value: boolean) => {
      amend = invite = value;
      render();
    },
    ledgerChanged: () => {
      refresh();
      render();
    },
  };
}

async function main() {
  {
    const f = fixture({ canReceiveRequests: false });
    await f.settle();
    assert.equal(f.row("peopleProfile.shareTally").props.disabled, true);
    assert.equal(f.row("peopleProfile.inviteMember").props.disabled, true);
    assert.equal(f.row("peopleProfile.shareTally").props.hint, "peopleProfile.friendRequired");
    f.row("peopleProfile.shareTally").props.onPress();
    f.row("peopleProfile.inviteMember").props.onPress();
    await f.settle();
    assert.equal(f.navigations.length, 0);
    assert.equal(
      f.all().some((n) => n.type === "TallyDialog"),
      false,
    );
  }
  {
    const f = fixture({
      canReceiveRequests: false,
      activity: { shared_tally: "active" },
      local: "saved-contact",
    });
    await f.settle();
    assert.equal(f.row("peopleProfile.openTally").props.disabled, false);
    f.row("peopleProfile.openTally").props.onPress();
    await f.settle();
    assert.deepEqual(
      f.opened,
      ["saved-contact"],
      "New-request eligibility cannot revoke existing tally access",
    );
  }
  {
    const f = fixture();
    await f.settle();
    assert.equal(f.navigations.length, 0, "Opening a profile performs reads only");
    const share = f.row("peopleProfile.shareTally");
    assert.equal(share.props.disabled, false);
    share.props.onPress();
    share.props.onPress();
    await f.settle();
    const dialog = f.all().find((n) => n.type === "TallyDialog");
    assert.ok(dialog);
    assert.equal(dialog.props.expectedSession, f.props.session);
    assert.equal(dialog.props.expectedVaultId, "book-a");
    const before = f.reads.length;
    f.ledgerChanged();
    await f.settle();
    assert.equal(f.reads.length, before, "Contact preparation cannot close its own consent dialog");
    dialog.props.onDismiss();
    dialog.props.onDelivered("new-contact");
    f.render();
    assert.deepEqual(f.opened, [], "Successful send stays on the profile");
    assert.equal(f.changed(), 1);
    assert.equal(f.row("peopleProfile.tallyPending").props.disabled, true);
  }
  {
    const f = fixture({ activity: { shared_tally: "active" }, local: "saved-contact" });
    await f.settle();
    f.row("peopleProfile.openTally").props.onPress();
    await f.settle();
    assert.deepEqual(f.opened, ["saved-contact"]);
    assert.equal(
      f.all().some((n) => n.type === "TallyDialog"),
      false,
    );
  }
  {
    const f = fixture({ activity: { shared_tally: "pending", kaata_invitation_role: "clerk" } });
    await f.settle();
    assert.equal(f.row("peopleProfile.tallyPending").props.disabled, true);
    const invite = f.row("peopleProfile.memberPending");
    assert.equal(invite.props.disabled, false);
    assert.match(invite.props.hint, /clerk/);
    invite.props.onPress();
    await f.settle();
    assert.deepEqual(f.navigations, [
      { pathname: "/vault/invite", params: { profileAccountId: "target" } },
    ]);
  }
  {
    const f = fixture({
      activity: { shared_tally: "declined" },
      local: "saved-contact",
      canReceiveRequests: false,
    });
    await f.settle();
    const row = f.row("tab.chip.declined");
    assert.equal(row.props.disabled, false);
    assert.equal(row.props.hint, "tab.invite.declinedHint");
    row.props.onPress();
    await f.settle();
    assert.deepEqual(f.opened, ["saved-contact"]);
    assert.ok(!f.all().some((n) => n.type === "TallyDialog"));
  }
  {
    const f = fixture();
    await f.settle();
    f.row("peopleProfile.inviteMember").props.onPress();
    await f.settle();
    assert.deepEqual(f.navigations, [
      { pathname: "/vault/invite", params: { profileAccountId: "target" } },
    ]);
  }
  for (const invalidate of ["scope", "session", "permissions", "disabled"] as const) {
    const f = fixture();
    await f.settle();
    const old = f.row("peopleProfile.shareTally");
    if (invalidate === "scope") f.invalidate();
    if (invalidate === "session") f.rebind();
    if (invalidate === "permissions") f.permissions(false);
    if (invalidate === "disabled") {
      f.props.disabled = true;
      f.render();
    }
    old.props.onPress();
    await f.settle();
    assert.equal(
      f.all().some((n) => n.type === "TallyDialog"),
      false,
      invalidate,
    );
    assert.equal(f.navigations.length, 0);
  }
  {
    const f = fixture({ holdProfile: true });
    await f.settle();
    const old = [...f.reads];
    f.setVault("book-b");
    await f.settle();
    for (const read of old) read.reply.resolve({ person, activity: { shared_tally: "active" } });
    await f.settle();
    assert.equal(f.row("peopleProfile.shareTally").props.disabled, true);
    f.hooks.unmount();
    for (const read of f.reads) read.reply.resolve({ person });
    await settleUI();
    assert.equal(f.hooks.lateWrites, 0);
  }
  {
    const f = fixture({ vault: null });
    await f.settle();
    assert.equal(f.reads.length, 0);
    assert.equal(f.row("peopleProfile.shareTally").props.disabled, true);
    assert.equal(f.row("peopleProfile.inviteMember").props.disabled, true);
  }
  console.log(
    "people-profile-actions selftest: passed (separate consent, current Kaata, pending states, session/vault races and no-vault profile)",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
