// Executes the production discovery connection/request helpers and confirmation
// components with synthetic storage/native boundaries. No account or network IO.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import * as errors from "../tabs/errors";
import * as uuid from "../uuid-v5";
import type { SessionSnapshot } from "../auth";
import type { DiscoveredPerson } from "../people-search";

const person: DiscoveredPerson = {
  account_id: "33333333-3333-4333-8333-333333333333",
  name: "John Smith",
  username: "john_smith",
};
const viewer = "11111111-1111-4111-8111-111111111111";
const book = "22222222-2222-4222-8222-222222222222";
class SessionChangedError extends Error {}
const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, run: () => Promise<void> | void) => tests.push([name, run]);

function connectionsFixture() {
  let account: string | null = viewer,
    vault: string | null = book,
    token: string | null = "jwt.first";
  let archived = false,
    roleDenied = false,
    archivedRelationship = false,
    supported = true;
  let beforeRead: (() => Promise<void> | void) | undefined;
  let beforeAppend: (() => Promise<void> | void) | undefined;
  let beforeBase: (() => Promise<void> | void) | undefined;
  const records = new Map<string, any>();
  const metadata = new Map<string, string>();
  const appends: any[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const responses: (() => Promise<Response> | Response)[] = [];
  const session = (): SessionSnapshot => ({ accountId: account, jwt: token, bindingVersion: 1 });
  const api = compileUI(
    "../people-connections",
    {
      "./api": {
        getBackendUrl: async () => {
          await beforeBase?.();
          return "https://backend.invalid";
        },
      },
      "./auth": {
        captureCurrentSession: async () => session(),
        applyForCurrentSession: async (saved: SessionSnapshot, work: () => Promise<unknown>) => {
          if (saved.accountId !== account || saved.jwt !== token) throw new SessionChangedError();
          return work();
        },
        SessionChangedError,
      },
      "./db": {
        getActiveVaultArchivedState: async () => ({ state: archived ? "archived" : "ok" }),
        getPerson: async (id: string) => {
          await beforeRead?.();
          const saved = records.get(id);
          return saved?.archived_at == null ? (saved ?? null) : null;
        },
        setAppMeta: async (key: string, value: string) => {
          metadata.set(key, value);
        },
      },
      "./db-tx": {
        getAccountIdSync: () => account,
        getActiveVaultIdSyncMaybe: () => vault,
        getDb: async () => ({
          getFirstAsync: async (_sql: string, ...args: string[]) => {
            if (archivedRelationship) return { id: "archived" };
            const archivedId = args.find((id) => records.get(id)?.archived_at != null);
            return archivedId ? { id: archivedId } : null;
          },
          getAllAsync: async (_sql: string, prefix: string) =>
            [...metadata]
              .filter(([key]) => key.startsWith(prefix.slice(0, -1)))
              .map(([, value]) => ({ value })),
        }),
      },
      "./event-log": {
        appendPersonAdded: async (args: any) => {
          await beforeAppend?.();
          if (!args.shouldContinue()) throw new Error("scope changed before atomic write");
          appends.push(args);
          records.set(args.userId, { id: args.userId, name: args.name, archived_at: null });
        },
      },
      "./tabs/link": {
        assertVaultAction: async (scope: string, action: string) => {
          assert.equal(scope, book);
          assert.equal(
            action,
            "entry.amend",
            "discovery uses sharing permissions, not clerk create permission",
          );
          if (roleDenied) throw new errors.TabPermissionError();
        },
      },
      "./tabs/errors": errors,
      "./uuid-v5": uuid,
    },
    {
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        if (url.endsWith("/v1/sync/capabilities"))
          return response({ people_discovery: supported })();
        assert.ok(responses.length, "all synthetic network calls are scripted");
        return responses.shift()!();
      },
    },
  ) as typeof import("../people-connections");
  return {
    api,
    records,
    metadata,
    appends,
    requests,
    responses,
    session,
    changeAccount(value: string | null) {
      account = value;
    },
    changeToken(value: string | null) {
      token = value;
    },
    changeVault(value: string | null) {
      vault = value;
    },
    archive() {
      archived = true;
    },
    archiveRelationship() {
      archivedRelationship = true;
    },
    denyRole() {
      roleDenied = true;
    },
    oldServer() {
      supported = false;
    },
    onRead(hook: typeof beforeRead) {
      beforeRead = hook;
    },
    onAppend(hook: typeof beforeAppend) {
      beforeAppend = hook;
    },
    onBase(hook: typeof beforeBase) {
      beforeBase = hook;
    },
  };
}
const response =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status });

test("identity is stable across retries and separates people and books", () => {
  const { api } = connectionsFixture();
  const id = api.discoveredPersonId(book, person.account_id);
  assert.match(id, /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(connectionsFixture().api.discoveredPersonId(book, person.account_id), id);
  assert.notEqual(api.discoveredPersonId("another-book", person.account_id), id);
  assert.notEqual(api.discoveredPersonId(book, "another-person"), id);
});

test("confirmed creation retries reuse the same contact without name-based merging", async () => {
  const f = connectionsFixture();
  f.records.set("unrelated-john", { name: person.name, id: "unrelated-john", archived_at: null });
  const id = await f.api.prepareDiscoveredContact(person, f.session(), book);
  assert.equal(f.appends.length, 1);
  assert.equal(
    f.appends[0].phoneE164,
    null,
    "directory profile never fabricates or imports a phone",
  );
  assert.equal(f.appends[0].vaultId, book);
  assert.notEqual(id, "unrelated-john", "a shared name is not account identity");
  assert.equal(await f.api.prepareDiscoveredContact(person, f.session(), book), id);
  assert.equal(f.appends.length, 1, "lost reply/reopened dialog creates no duplicate person");
  assert.deepEqual(await f.api.getDiscoveredPersonIds(book), { [person.account_id]: id });
  f.changeAccount("other-viewer");
  assert.deepEqual(
    await f.api.getDiscoveredPersonIds(book),
    {},
    "local association is account-scoped",
  );
});

test("choosing an existing contact preserves its name, phone and records", async () => {
  const f = connectionsFixture();
  const existing = {
    id: "saved-john",
    name: "John at the market",
    phone: "+93700000000",
    balance: 500,
    archived_at: null,
  };
  f.records.set(existing.id, existing);
  assert.equal(
    await f.api.prepareDiscoveredContact(person, f.session(), book, existing.id),
    existing.id,
  );
  assert.equal(f.appends.length, 0);
  assert.deepEqual(f.records.get(existing.id), existing);
  assert.deepEqual(await f.api.getDiscoveredPersonIds(book), { [person.account_id]: existing.id });
  await assert.rejects(
    f.api.prepareDiscoveredContact(person, f.session(), book, "missing"),
    errors.TabInputError,
  );
  assert.equal(f.appends.length, 0, "a vanished chosen contact is never silently replaced");
});

test("saved existing-contact identity survives retries and an archive never creates a replacement", async () => {
  const f = connectionsFixture();
  const existing = {
    id: "previously-selected-john",
    name: "John at the market",
    archived_at: null,
  };
  f.records.set(existing.id, existing);
  await f.api.prepareDiscoveredContact(person, f.session(), book, existing.id);
  assert.equal(
    await f.api.prepareDiscoveredContact(person, f.session(), book),
    existing.id,
    "retry recovers the explicit saved identity instead of a different deterministic person",
  );
  f.records.set(existing.id, { ...existing, archived_at: 100 });
  await assert.rejects(
    f.api.prepareDiscoveredContact(person, f.session(), book),
    (error: unknown) => error instanceof errors.TabApiError && error.code === "contact_archived",
  );
  assert.equal(
    f.appends.length,
    0,
    "archiving never silently creates another financial relationship",
  );
  assert.deepEqual(await f.api.getDiscoveredPersonIds(book), { [person.account_id]: existing.id });
});

test("self, insufficient role, archived books and archived contacts never create a relationship", async () => {
  for (const kind of ["self", "role", "book", "relationship", "server"] as const) {
    const f = connectionsFixture();
    if (kind === "role") f.denyRole();
    if (kind === "book") f.archive();
    if (kind === "relationship") f.archiveRelationship();
    if (kind === "server") f.oldServer();
    await assert.rejects(
      f.api.prepareDiscoveredContact(
        kind === "self" ? { ...person, account_id: viewer } : person,
        f.session(),
        book,
      ),
    );
    assert.equal(f.appends.length, 0, kind);
    assert.equal(f.metadata.size, 0, kind);
  }
});

test("session and vault changes during reads/atomic admission never write to the new scope", async () => {
  for (const stage of ["before", "read", "append"] as const) {
    const f = connectionsFixture();
    const captured = f.session();
    const switchVault = () => {
      f.changeVault("another-book");
    };
    if (stage === "before") f.changeAccount("another-account");
    if (stage === "read") f.onRead(switchVault);
    if (stage === "append") f.onAppend(switchVault);
    await assert.rejects(f.api.prepareDiscoveredContact(person, captured, book));
    assert.equal(f.appends.length, 0, stage);
    assert.equal(f.metadata.size, 0, stage);
  }
});

test("request API is authenticated, exact and never retries an ambiguous send", async () => {
  const f = connectionsFixture();
  f.responses.push(response({}));
  await f.api.sendPeopleRequest("group-id", person.account_id);
  assert.equal(f.requests[0].url, "https://backend.invalid/v1/people/requests");
  assert.equal(f.requests[0].init.method, "POST");
  assert.equal(new Headers(f.requests[0].init.headers).get("Authorization"), "Bearer jwt.first");
  assert.deepEqual(JSON.parse(String(f.requests[0].init.body)), {
    group_id: "group-id",
    recipient_account_id: person.account_id,
  });
  f.responses.push(() => new Response(null, { status: 204 }));
  await f.api.declinePeopleRequest("request/id");
  assert.equal(f.requests[1].url, "https://backend.invalid/v1/people/requests/request%2Fid");
  assert.equal(f.requests[1].init.method, "DELETE");
  f.responses.push(() => {
    throw new TypeError("connection lost");
  });
  await assert.rejects(f.api.sendPeopleRequest("group-id", person.account_id), errors.TabApiError);
  assert.equal(f.requests.length, 3, "one attempt, because the lost response may have committed");
  f.changeToken(null);
  await assert.rejects(f.api.listPeopleRequests(), errors.TabAuthUnavailableError);
  assert.equal(f.requests.length, 3);
});

test("request session is checked before sending and again before returning a reply", async () => {
  const f = connectionsFixture();
  const saved = f.session();
  f.onBase(() => f.changeAccount("other-account"));
  await assert.rejects(f.api.peopleRequest("GET", "/v1/people/requests", undefined, saved));
  assert.equal(f.requests.length, 0);

  const fresh = connectionsFixture();
  const held = deferred<Response>();
  fresh.responses.push(() => held.promise);
  const reading = fresh.api.listPeopleRequests();
  await settleUI();
  fresh.changeAccount("other-account");
  held.resolve(response({ requests: [{ id: "private-invitation" }] })());
  await assert.rejects(reading, "old session response is never returned to the new account");
});

function confirmationFixture(restored = false) {
  const hooks = uiHooks();
  let vault = book,
    account = viewer;
  const deliveries: unknown[][] = [],
    preparations: number[] = [],
    creations: unknown[] = [];
  let failure = true;
  let prepareGate: Promise<string> | null = null;
  const fresh = {
    group_id: "group",
    tab_id: "tab",
    invite_url: "https://kaata.af/t/invitation",
    currency: "AFN",
    recording_mode: "notify",
    role: "a",
  };
  const props = {
    visible: true,
    person: { id: "new-person", name: person.name, phone: null },
    myLabel: "My name",
    link: restored ? { ...fresh, invite_url: null } : null,
    recipientAccountId: person.account_id,
    preparePerson: async () => {
      preparations.push(1);
      return prepareGate ? await prepareGate : "new-person";
    },
    onLinked() {},
    onDismiss() {},
    onDelivered() {},
    onAuthRequired() {},
  };
  const ui = compileUI("../../components/LinkAccountDialog", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      KeyboardAvoidingView: "KeyboardAvoidingView",
      Platform: { OS: "ios" },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (s: unknown) => s },
    },
    "@expo/vector-icons": { Ionicons: "Icon", MaterialCommunityIcons: "Icon" },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "expo-clipboard": {
      setStringAsync: async () => assert.fail("discovery never copies an external link"),
    },
    "./ProtectedModal": { ProtectedModal: "Modal" },
    "./SheetBackdrop": { SheetBackdrop: "Backdrop" },
    "./Button": { Button: "Button" },
    "./Toast": { useToast: () => ({ push() {} }) },
    "../lib/colors": { colors: {} },
    "../lib/direction": {
      useIsRTL: () => false,
      rowDir: () => ({}),
      textDir: () => ({}),
      ltrIsolate: (text: string) => text,
    },
    "../lib/i18n": {
      t: (key: string) => key,
      tIn: (key: string) => key,
      getLocale: () => "en",
      getShareLangPref: async () => "auto",
      resolveShareLang: () => "en",
    },
    "../lib/tabs/db": { listOpenTabLinksForPerson: async () => [fresh] },
    "../lib/tabs/link": {
      getPendingContactGroupSettings: async () => null,
      linkContactGroup: async (...args: unknown[]) => {
        creations.push(args);
        return { link: fresh, group: { currencies: ["AFN"] } };
      },
      shareTabLinkOnWhatsApp: async () => assert.fail("discovery never opens WhatsApp"),
    },
    "../lib/tabs/errors": errors,
    "../lib/tokens": { radius: {}, TOUCH_MIN: 44, typography: {} },
    "../lib/currency": { getCurrentCurrencyCode: () => "AFN", getCurrencyLabel: (c: string) => c },
    "../lib/db-tx": { getAccountIdSync: () => account, getActiveVaultIdSyncMaybe: () => vault },
    "../lib/auth": {
      captureCurrentSession: async () => ({ accountId: account, jwt: "jwt", bindingVersion: 1 }),
    },
    "../lib/people-connections": {
      getDiscoveredPersonIds: async () => ({}),
      sendPeopleRequest: async (group: string, recipient: string) => {
        deliveries.push([group, recipient]);
        if (failure) throw new errors.TabApiError(0, "network", "Lost reply");
      },
    },
  });
  const render = () => hooks.render(() => ui.LinkAccountDialog(props));
  const send = () =>
    nodes(render()).find(
      (node) => node.type === "Button" && node.props.label === "peopleSearch.send",
    )!;
  return {
    hooks,
    render,
    send,
    props,
    preparations,
    creations,
    deliveries,
    allowDelivery() {
      failure = false;
    },
    holdPreparation(gate: Promise<string>) {
      prepareGate = gate;
    },
    changeVault() {
      vault = "other-book";
    },
    changeAccount() {
      account = "other-account";
    },
  };
}

test("discovery confirmation is inert until Send, and retry does not duplicate contact/group", async () => {
  const f = confirmationFixture();
  f.render();
  await settleUI();
  f.render();
  assert.equal(f.preparations.length, 0);
  assert.equal(f.creations.length, 0);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.send().props.disabled, false);
  await f.send().props.onPress();
  await settleUI();
  f.render();
  assert.equal(f.preparations.length, 1);
  assert.equal(f.creations.length, 1);
  assert.deepEqual(f.deliveries, [["group", person.account_id]]);
  f.allowDelivery();
  await f.send().props.onPress();
  await settleUI();
  f.render();
  assert.equal(f.preparations.length, 1, "retry reuses the confirmed contact");
  assert.equal(f.creations.length, 1, "retry reuses the saved group");
  assert.equal(f.deliveries.length, 2);
  f.hooks.unmount();
});

test("restored pending invitations remember their contact on confirmed resend without recreating a group", async () => {
  const f = confirmationFixture(true);
  f.allowDelivery();
  f.render();
  await settleUI();
  assert.equal(f.preparations.length, 0, "opening a restored invitation remains read-only");
  await f.send().props.onPress();
  await settleUI();
  assert.equal(f.preparations.length, 1, "confirmation repairs the local identity mapping");
  assert.equal(f.creations.length, 0, "the immutable existing agreement is reused");
  assert.deepEqual(f.deliveries, [["group", person.account_id]]);
  f.hooks.unmount();
});

test("double taps and scope changes during confirmation never send twice or link in another book", async () => {
  const f = confirmationFixture();
  const gate = deferred<string>();
  f.holdPreparation(gate.promise);
  f.render();
  await settleUI();
  f.render();
  const button = f.send();
  const first = button.props.onPress(),
    second = button.props.onPress();
  await settleUI();
  assert.equal(f.preparations.length, 1, "synchronous guard wins before rerender");
  f.changeVault();
  gate.resolve("new-person");
  await Promise.all([first, second]);
  await settleUI();
  assert.equal(f.creations.length, 0);
  assert.equal(f.deliveries.length, 0);
  f.hooks.unmount();
});

function discoveryDialogFixture(
  options: { mapped?: boolean; joined?: boolean; link?: Record<string, unknown> } = {},
) {
  const hooks = uiHooks();
  const prepared: unknown[][] = [];
  const added: string[] = [];
  const ui = compileUI("../../components/DiscoveredPersonDialog", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "expo-router": { useRouter: () => ({ push() {} }) },
    "react-native": { Pressable: "Pressable", Text: "Text", TextInput: "TextInput", View: "View" },
    "../lib/auth": {
      captureCurrentSession: async () => ({ accountId: viewer, jwt: "jwt", bindingVersion: 1 }),
    },
    "../lib/db": {
      getLocalSelf: async () => ({ name: "My Name" }),
      listAllPeopleForSearch: async (vault: string, currency: undefined, readOptions: unknown) => {
        assert.equal(vault, book);
        assert.equal(currency, undefined);
        assert.deepEqual(
          readOptions,
          { allCurrencies: true },
          "joined state must include every currency",
        );
        return [
          {
            id: "saved-john",
            name: "Saved John",
            tab_id: options.joined ? "joined-tab" : null,
            tab_closed_at: null,
            tab_other_joined: options.joined ? 1 : 0,
          },
        ];
      },
    },
    "../lib/db-tx": { getAccountIdSync: () => viewer, getActiveVaultIdSyncMaybe: () => book },
    "../lib/people-connections": {
      discoveredPersonId: connectionsFixture().api.discoveredPersonId,
      getDiscoveredPersonIds: async () =>
        options.mapped ? { [person.account_id]: "saved-john" } : {},
      prepareDiscoveredContact: async (...args: unknown[]) => {
        prepared.push(args);
        return "saved-john";
      },
    },
    "../lib/i18n": { t: (key: string) => key },
    "./LinkAccountDialog": { LinkAccountDialog: "LinkDialog" },
    "../lib/colors": { colors: {} },
    "../lib/direction": { useIsRTL: () => false, textDir: () => ({}) },
    "../lib/tokens": { typography: {}, TOUCH_MIN: 44, radius: {} },
    "../lib/search": { searchPeople: (_query: string, contacts: unknown[]) => contacts },
    "../lib/tabs/db": {
      getTabGroupLinkForPerson: async (personId: string) => {
        assert.equal(personId, "saved-john");
        return options.link ?? null;
      },
    },
  });
  const props = { person, onDismiss() {}, onAdded: (id: string) => added.push(id) };
  const render = () => hooks.render(() => ui.DiscoveredPersonDialog(props));
  return { hooks, render, added, prepared };
}

test("opening discovery and choosing a saved contact are read-only until confirmation", async () => {
  const { hooks, render, added, prepared } = discoveryDialogFixture();
  render();
  await settleUI();
  let dialog = render();
  assert.equal(dialog.type, "LinkDialog");
  assert.equal(prepared.length + added.length, 0);
  let choices = nodes(dialog.props.contactChoice(false));
  choices.find((node) => node.type === "Pressable")!.props.onPress();
  dialog = render();
  choices = nodes(dialog.props.contactChoice(false));
  choices
    .find(
      (node) =>
        node.type === "Pressable" &&
        nodes(node).some((child) => child.props.children === "Saved John"),
    )!
    .props.onPress();
  dialog = render();
  assert.equal(dialog.props.person.id, "saved-john");
  assert.equal(prepared.length, 0, "selecting an existing contact changes only the draft choice");
  await dialog.props.preparePerson();
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0][3], "saved-john");
  assert.equal(added.length, 0, "preparing the contact is not delivery success");
  dialog.props.onDelivered();
  assert.deepEqual(added, ["saved-john"]);
  hooks.unmount();
});

test("reopening a pending discovery preserves its original recording mode, while joined contacts open directly", async () => {
  const known = {
    group_id: "group",
    tab_id: "pending",
    recording_mode: "review",
    invite_url: null,
  };
  const pending = discoveryDialogFixture({ mapped: true, link: known });
  pending.render();
  await settleUI();
  const dialog = pending.render();
  assert.equal(dialog.props.person.id, "saved-john");
  assert.equal(
    dialog.props.link,
    known,
    "retry receives the immutable review-mode link before rendering any default mode",
  );
  assert.equal(dialog.props.recipientUsername, person.username);
  assert.equal(pending.prepared.length + pending.added.length, 0);
  pending.hooks.unmount();
  const joined = discoveryDialogFixture({ mapped: true, joined: true });
  joined.render();
  await settleUI();
  assert.equal(
    joined.render(),
    null,
    "an existing joined account does not reopen sharing confirmation",
  );
  assert.deepEqual(joined.added, ["saved-john"]);
  assert.equal(joined.prepared.length, 0);
  joined.hooks.unmount();
});

function requestHookFixture() {
  const hooks = uiHooks();
  let account = viewer;
  let listCalls = 0,
    declineCalls = 0;
  const reads: Array<Promise<any[]>> = [];
  let declineGate: Promise<void> = Promise.resolve();
  const intervals = new Map<number, () => void>();
  let timerId = 0;
  const ui = compileUI(
    "../use-people-requests",
    {
      react: {
        ...hooks.react,
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
      },
      "expo-router": { useFocusEffect: (fn: () => void) => hooks.react.useEffect(fn, [fn]) },
      "react-native": {
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
      },
      "./db-tx": {
        getSessionAccountIdSync: () => account,
        onAccountIdentityChanged: () => () => {},
      },
      "./people-connections": {
        listPeopleRequests: async () => {
          listCalls++;
          assert.ok(reads.length);
          return reads.shift()!;
        },
        declinePeopleRequest: async () => {
          declineCalls++;
          await declineGate;
        },
      },
      "./tabs/errors": errors,
    },
    {
      setInterval: (fn: () => void) => {
        intervals.set(++timerId, fn);
        return timerId;
      },
      clearInterval: (id: number) => intervals.delete(id),
    },
  );
  const render = (): ReturnType<typeof import("../use-people-requests").usePeopleRequests> =>
    hooks.render(() => ui.usePeopleRequests()) as any;
  return {
    hooks,
    reads,
    render,
    intervals,
    calls: () => ({ listCalls, declineCalls }),
    changeAccount() {
      account = "other-account";
    },
    holdDecline(gate: Promise<void>) {
      declineGate = gate;
    },
  };
}

test("inbox receipt is read-only and old-account requests disappear before a new fetch finishes", async () => {
  const f = requestHookFixture();
  f.reads.push(Promise.resolve([{ id: "first-account-request" }]));
  f.render();
  await settleUI();
  assert.equal(f.render().rows.length, 1);
  assert.deepEqual(f.calls(), { listCalls: 1, declineCalls: 0 });
  const next = deferred<any[]>();
  f.reads.push(next.promise);
  f.changeAccount();
  assert.deepEqual(
    f.render().rows,
    [],
    "account change cannot briefly show the old person's requests",
  );
  next.resolve([{ id: "new-account-request" }]);
  await settleUI();
  assert.equal(f.render().rows[0].id, "new-account-request");
  f.hooks.unmount();
  assert.equal(f.intervals.size, 0);
});

test("a late inbox fetch cannot resurrect a declined invitation", async () => {
  const f = requestHookFixture();
  const row: any = { id: "request-id" };
  f.reads.push(Promise.resolve([row]));
  f.render();
  await settleUI();
  f.render();
  const decline = deferred<void>(),
    reload = deferred<any[]>();
  f.holdDecline(decline.promise);
  f.reads.push(reload.promise);
  const dropping = f.render().decline(row.id);
  const reading = f.render().reload();
  decline.resolve();
  await dropping;
  await settleUI();
  assert.deepEqual(f.render().rows, []);
  reload.resolve([row]);
  await reading;
  await settleUI();
  assert.deepEqual(f.render().rows, []);
  assert.equal(f.calls().declineCalls, 1);
  f.hooks.unmount();
});

async function main() {
  let failed = 0;
  for (const [name, run] of tests) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}`, error);
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`${tests.length} people-connection regressions passed`);
}
void main();
