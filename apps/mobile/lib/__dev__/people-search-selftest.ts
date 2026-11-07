// Synthetic directory and hook fixtures; no real account or network access.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import type { DiscoveredPerson } from "../people-search";

const accountA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const accountB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const person: DiscoveredPerson = { account_id: accountB, name: "John Smith", username: "john" };
let account: string | null = accountA,
  vault: string | null = "vault-a",
  binding = 1,
  focused = true;
const phone = compileUI("../phone", {
  "./db": { getAppMeta: async () => null },
  "./digits": require("../digits"),
  "./phone-countries": require("../phone-countries"),
  "libphonenumber-js/core": require("libphonenumber-js/core"),
  "libphonenumber-js/metadata.min.json": require("libphonenumber-js/metadata.min.json"),
});
let now = 0,
  nextTimer = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
const setTimer = (callback: () => void, delay: number) => {
  const id = ++nextTimer;
  timers.set(id, { at: now + delay, callback });
  return id;
};
function advance(ms: number) {
  now += ms;
  for (const [id, timer] of [...timers])
    if (timer.at <= now) {
      timers.delete(id);
      timer.callback();
    }
}
const pending: Array<{
  url: string;
  signal: AbortSignal;
  reply: ReturnType<typeof deferred<Response>>;
}> = [];
const hooks = uiHooks();
let appStateListener: (state: string) => void = () => {};
const identityListeners = new Set<() => void>();
class SessionChangedError extends Error {}
const api = compileUI(
  "../people-search",
  {
    react: {
      ...hooks.react,
      useSyncExternalStore: (
        subscribe: (notify: () => void) => () => void,
        snapshot: () => unknown,
      ) => {
        hooks.react.useEffect(() => subscribe(() => {}), [subscribe]);
        return snapshot();
      },
    },
    "expo-router": { useIsFocused: () => focused },
    "react-native": {
      AppState: {
        currentState: "active",
        addEventListener: (_event: string, listener: typeof appStateListener) => {
          appStateListener = listener;
          return { remove: () => {} };
        },
      },
    },
    "./api": { getBackendUrl: async () => "https://fixture.invalid" },
    "./auth": {
      SessionChangedError,
      captureCurrentSession: async () => ({
        accountId: account,
        jwt: "fixture-session",
        bindingVersion: binding,
      }),
      applyForCurrentSession: async (
        snapshot: { accountId: string; bindingVersion: number },
        work: () => Promise<unknown>,
      ) => {
        if (snapshot.accountId !== account || snapshot.bindingVersion !== binding)
          throw new SessionChangedError();
        return work();
      },
    },
    "./db-tx": {
      getSessionAccountIdSync: () => account,
      getActiveVaultIdSyncMaybe: () => vault,
      onAccountIdentityChanged: (notify: () => void) => {
        identityListeners.add(notify);
        return () => identityListeners.delete(notify);
      },
      getDb: async () => ({
        getFirstAsync: async (sql: string, _relationship: string, scopedVault: string) => {
          assert.ok(sql.includes("vault_id = ?") && sql.includes("archived_at IS NULL"));
          assert.equal(scopedVault, vault);
          return { id: "server-linked-john" };
        },
      }),
    },
    "./digits": require("../digits"),
    "./phone": phone,
    "./people-connections": { getDiscoveredPersonIds: async () => ({ [accountB]: "local-john" }) },
  },
  {
    setTimeout: setTimer,
    clearTimeout: (id: number) => timers.delete(id),
    fetch: (url: string, options: { signal: AbortSignal }) => {
      const reply = deferred<Response>();
      pending.push({ url, signal: options.signal, reply });
      return reply.promise;
    },
  },
) as typeof import("../people-search");
const response = (people: unknown[], has_more = false) =>
  new Response(JSON.stringify({ people, has_more }), {
    headers: { "Content-Type": "application/json" },
  });

async function main() {
  assert.equal(api.peopleSearchQuery(" j "), "");
  assert.equal(api.peopleSearchQuery(" @j "), "");
  assert.equal(api.peopleSearchQuery("  John   Smith  "), "John Smith");
  assert.equal(api.peopleSearchQuery("@john"), "@john");
  assert.equal(api.peopleSearchQuery("احمد"), "احمد");
  assert.equal(api.peopleSearchQuery("07"), "");
  assert.equal(api.peopleSearchQuery("0700 123 456", "AF"), "+93700123456");
  assert.equal(api.peopleSearchQuery("۰۰۹۳۷۰۰۱۲۳۴۵۶", "US"), "+93700123456");
  assert.equal(api.peopleSearchQuery("+61 412 345 678", "AF"), "+61412345678");
  assert.equal(api.peopleSearchQuery("j".repeat(81)), "");

  let query = "John";
  let enabled = true;
  const render = () =>
    hooks.render(() => ({ type: "result", props: api.usePeopleSearch(query, enabled) }))
      .props as ReturnType<typeof api.usePeopleSearch>;
  let result = render();
  assert.equal(result.loading, true);
  advance(349);
  await settleUI();
  assert.equal(pending.length, 0, "typing is debounced");
  advance(1);
  await settleUI();
  assert.equal(pending.length, 1);
  assert.ok(pending[0].url.includes("q=John&include_friends=1&vault_id=vault-a"));

  query = "Jane";
  result = render();
  assert.equal(pending[0].signal.aborted, true, "changed queries cancel earlier requests");
  pending[0].reply.resolve(response([person]));
  await settleUI();
  assert.equal(render().people.length, 0, "a slow old reply cannot populate the new query");
  advance(350);
  await settleUI();
  const linkedPerson = {
    ...person,
    existing_relationship_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  pending[1].reply.resolve(
    response(
      [
        linkedPerson,
        person,
        { ...person, account_id: accountA },
        { ...person, account_id: "bad" },
        { ...person, account_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: " " },
      ],
      true,
    ),
  );
  await settleUI();
  await settleUI(); // The authorized relationship lookup follows the directory reply.
  result = render();
  assert.deepEqual(
    result.people,
    [linkedPerson],
    "duplicate, self, malformed and unnamed profiles are excluded",
  );
  assert.equal(result.hasMore, true);
  assert.equal(
    result.existingPersonIds[accountB],
    "server-linked-john",
    "authorized relationship resolves after reinstall, ahead of a local-only mapping",
  );
  assert.equal(result.loading, false);

  query = "Someone";
  render();
  advance(350);
  await settleUI();
  vault = "vault-b";
  render();
  pending[2].reply.resolve(response([person]));
  await settleUI();
  assert.equal(render().people.length, 0, "previous book replies are discarded");
  advance(350);
  await settleUI();
  account = accountB;
  render();
  pending[3].reply.resolve(response([person]));
  await settleUI();
  assert.equal(render().people.length, 0, "previous account replies are discarded");

  advance(350);
  await settleUI();
  pending[4].reply.reject(new Error("offline"));
  await settleUI();
  result = render();
  assert.equal(result.error, true, "network failure does not look like no matches");
  result.retry();
  render();
  advance(350);
  await settleUI();
  pending[5].reply.resolve(response([]));
  await settleUI();
  result = render();
  assert.equal(result.error, false);
  assert.equal(result.people.length, 0);

  query = "Joh";
  render();
  advance(350);
  await settleUI();
  appStateListener("background");
  result = render();
  assert.equal(result.visible, false);
  assert.equal(pending[6].signal.aborted, true, "backgrounding cancels directory work");
  appStateListener("active");
  render();
  advance(350);
  await settleUI();
  focused = false;
  result = render();
  assert.equal(result.visible, false);
  assert.equal(pending[7].signal.aborted, true, "leaving the search screen cancels work");
  focused = true;
  render();
  advance(350);
  await settleUI();
  binding++;
  pending[8].reply.resolve(response([{ ...person, account_id: accountA }]));
  await settleUI();
  assert.equal(
    render().people.length,
    0,
    "replacement sessions cannot receive old directory results",
  );
  enabled = false;
  result = render();
  assert.equal(result.visible, false);
  assert.equal(result.people.length, 0);
  enabled = true;
  account = accountA;
  vault = null;
  result = render();
  assert.equal(result.visible, true, "signed-in people search does not require a financial book");
  advance(350);
  await settleUI();
  const noVaultIndex = pending.length - 1;
  assert.equal(
    pending[noVaultIndex].url,
    "https://fixture.invalid/v1/people/search?q=Joh&include_friends=1",
  );
  // A -> signed out -> A can happen before React paints a new frame.
  account = null;
  identityListeners.forEach((notify) => notify());
  account = accountA;
  identityListeners.forEach((notify) => notify());
  pending[noVaultIndex].reply.resolve(response([person]));
  await settleUI();
  assert.equal(render().people.length, 0, "batched identity changes cannot revive old search rows");
  advance(350);
  await settleUI();
  pending.at(-1)!.reply.resolve(response([person]));
  await settleUI();
  result = render();
  assert.equal(result.people.length, 1);
  assert.deepEqual(result.existingPersonIds, {}, "no book means no financial contact associations");
  account = null;
  identityListeners.forEach((notify) => notify());
  result = render();
  assert.equal(result.visible, false, "cached account identity cannot enable signed-out discovery");
  hooks.unmount();
  for (const request of pending) request.reply.resolve(response([person]));
  await settleUI();
  assert.equal(hooks.lateWrites, 0, "unmount leaves no delayed updates");
  const section = compileUI("../../components/PeopleSearchSection", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "react-native": {
      ActivityIndicator: "Spinner",
      Pressable: "Pressable",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    },
    "../lib/colors": { colors: {} },
    "../lib/direction": {
      ltrIsolate: (text: string) => text,
      rowDir: () => ({}),
      textDir: () => ({}),
      trackingSafe: () => ({}),
      useIsRTL: () => false,
    },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/people-connections": {
      discoveredPersonId: (_vault: string, id: string) => `stable-${id}`,
    },
    "../lib/tokens": { radius: {}, TOUCH_MIN: 44, typography: {} },
    "./InitialAvatar": { InitialAvatar: "Avatar" },
  }) as typeof import("../../components/PeopleSearchSection");
  const known = { id: "local-john" };
  const search = {
    visible: true,
    people: [person],
    existingPersonIds: { [accountB]: known.id },
    vaultId: "vault-a",
    loading: false,
    error: false,
    hasMore: false,
    retry: () => {},
  };
  assert.equal(
    section.PeopleSearchSection({
      search,
      localPeople: [known],
      visiblePeople: [known],
      onSelect: () => {},
    }),
    null,
    "an already visible contact is not repeated in global results",
  );
  const resultNodes = nodes(
    section.PeopleSearchSection({
      search,
      localPeople: [known],
      visiblePeople: [],
      onSelect: () => {},
    }),
  );
  assert.ok(
    resultNodes.some(
      (node) => node.type === "Text" && node.props.children === "peopleSearch.existing",
    ),
    "a username match can still open an existing contact when local name search missed it",
  );
  const unmappedNodes = nodes(
    section.PeopleSearchSection({
      search: { ...search, existingPersonIds: {} },
      localPeople: [known],
      visiblePeople: [known],
      onSelect: () => {},
    }),
  );
  assert.ok(
    unmappedNodes.some((node) => node.type === "Pressable"),
    "matching names never collapse separate identities",
  );
  const firstFallbackRequest = pending.length;
  account = accountB;
  vault = "vault-b";
  const newBookSearch = api.searchPeopleDirectory("John", new AbortController().signal, vault);
  await settleUI();
  assert.ok(pending[firstFallbackRequest].url.includes("&vault_id="));
  pending[firstFallbackRequest].reply.resolve(new Response("book not registered", { status: 404 }));
  await settleUI();
  assert.equal(
    pending[firstFallbackRequest + 1].url,
    "https://fixture.invalid/v1/people/search?q=John&include_friends=1",
  );
  pending[firstFallbackRequest + 1].reply.resolve(
    response([{ ...linkedPerson, account_id: accountA }]),
  );
  const newBookResults = await newBookSearch;
  assert.deepEqual(
    newBookResults.people,
    [{ ...person, account_id: accountA }],
    "a new local book can discover people without trusting unscoped relationship metadata",
  );
  console.log(
    "people search: query normalization, bounded results, debounce and session/scope races passed",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
