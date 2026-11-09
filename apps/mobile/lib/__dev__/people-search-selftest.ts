// Synthetic directory and hook fixtures; no real account or network access.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
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
  headers: Record<string, string>;
  reply: ReturnType<typeof deferred<Response>>;
}> = [];
let localLookups = 0;
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
    "./people-connections": {
      getDiscoveredPersonIds: async () => {
        localLookups++;
        return { [accountB]: "local-john" };
      },
      discoveredPersonId: (_vaultId: string, accountId: string) => `stable-${accountId}`,
    },
  },
  {
    setTimeout: setTimer,
    clearTimeout: (id: number) => timers.delete(id),
    fetch: (url: string, options: { signal: AbortSignal; headers: Record<string, string> }) => {
      const reply = deferred<Response>();
      pending.push({ url, signal: options.signal, headers: options.headers, reply });
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
  let allowPreview = false;
  const render = () =>
    hooks.render(() => ({
      type: "result",
      props: api.usePeopleSearch(query, enabled, { allowPreview }),
    })).props as ReturnType<typeof api.usePeopleSearch>;
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
    is_friend: true,
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
  assert.deepEqual([...(result.friendPersonIds ?? [])], ["server-linked-john"]);
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
  assert.equal(render().friendPersonIds, undefined, "a different Kaata cannot see an old friend marker");
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
  pending.at(-1)!.reply.resolve(response([{ ...person, is_friend: "true" }]));
  await settleUI();
  await settleUI();
  result = render();
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].is_friend, undefined, "a non-boolean flag cannot mark someone as a friend");
  assert.deepEqual(result.existingPersonIds, {}, "no book means no financial contact associations");
  account = null;
  identityListeners.forEach((notify) => notify());
  result = render();
  assert.equal(result.visible, false, "cached account identity cannot enable signed-out discovery");
  allowPreview = true;
  vault = "ninja-vault";
  const lookupsBeforePreview = localLookups;
  result = render();
  assert.equal(result.visible, true);
  assert.equal(result.requiresSignIn, true);
  advance(350);
  await settleUI();
  const guest = pending.at(-1)!;
  assert.equal(guest.url, "https://fixture.invalid/v1/people/search/preview?q=Joh");
  assert.deepEqual(guest.headers, { Accept: "application/json" });
  guest.reply.resolve(response([{ ...linkedPerson, phone_e164: "+93700123456" }]));
  await settleUI();
  await settleUI();
  const previewPage = render();
  assert.deepEqual(previewPage.people, [person], "a preview only exposes public identity");
  assert.deepEqual(previewPage.existingPersonIds, {});
  assert.equal(previewPage.friendPersonIds, undefined);
  assert.equal(previewPage.vaultId, null);
  assert.equal(localLookups, lookupsBeforePreview, "preview does not resolve financial contacts");

  const requestsBeforePhone = pending.length;
  query = "+93700123456";
  assert.equal(render().visible, false);
  advance(350);
  await settleUI();
  assert.equal(pending.length, requestsBeforePhone, "Ninja mode does not send phone lookups");

  query = "@john";
  render();
  advance(350);
  await settleUI();
  const stalePreview = pending.at(-1)!;
  account = accountA;
  identityListeners.forEach((notify) => notify());
  assert.deepEqual(render().people, []);
  assert.equal(stalePreview.signal.aborted, true);
  stalePreview.reply.resolve(response([person]));
  await settleUI();
  assert.deepEqual(render().people, [], "a late guest reply cannot populate a signed-in search");
  advance(350);
  await settleUI();
  const signedInAgain = pending.at(-1)!;
  assert.ok(signedInAgain.url.includes("/v1/people/search?q=%40john&include_friends=1"));
  assert.equal(signedInAgain.headers.Authorization, "Bearer fixture-session");
  hooks.unmount();
  for (const request of pending) request.reply.resolve(response([person]));
  await settleUI();
  assert.equal(hooks.lateWrites, 0, "unmount leaves no delayed updates");
  let avatarHooks = uiHooks();
  const keyedJsx = (type: any, props: any, key?: string) => ({ ...jsx(type, props), key });
  const section = compileUI("../../components/PeopleSearchSection", {
    react: { useState: (initial: any) => avatarHooks.react.useState(initial) },
    "react/jsx-runtime": { jsx: keyedJsx, jsxs: keyedJsx },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "react-native": {
      ActivityIndicator: "Spinner",
      Image: "Image",
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
      search: { ...search, people: [linkedPerson] },
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
  assert.ok(resultNodes.some((node) => node.type === "Text" && node.props.children === "peopleSearch.friend"));
  assert.match(
    resultNodes.find((node) => node.type === "Pressable")!.props.accessibilityLabel,
    /peopleSearch\.friend/,
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
  assert.ok(!unmappedNodes.some((node) => node.type === "Text" && node.props.children === "peopleSearch.friend"));
  const selectedPreview: DiscoveredPerson[] = [];
  const guestNodes = nodes(
    section.PeopleSearchSection({
      search: previewPage,
      localPeople: [known],
      visiblePeople: [known],
      opensProfile: true,
      actionLabel: "peopleProfile.view",
      onSelect: (chosen) => selectedPreview.push(chosen),
    }),
  );
  assert.ok(
    guestNodes.some((node) => node.type === "Icon" && node.props.name === "lock-closed-outline"),
  );
  const guestRow = guestNodes.find((node) => node.type === "Pressable")!;
  assert.match(guestRow.props.accessibilityLabel, /peopleProfile\.signIn/);
  guestRow.props.onPress();
  assert.deepEqual(selectedPreview, [person]);
  const photoUrl = "https://photos.example.test/john.jpg";
  const picturedPerson = { ...person, picture_url: photoUrl };
  const selected: DiscoveredPerson[] = [];
  const photoRow = (entry: DiscoveredPerson) => {
    const tree = section.PeopleSearchSection({
      search: { ...search, people: [entry] },
      localPeople: [],
      visiblePeople: [],
      onSelect: (chosen) => selected.push(chosen),
    });
    const row = nodes(tree).find((node) => node.type === "Pressable")!;
    const avatar = nodes(row).find((node) => typeof node.type === "function")!;
    assert.ok(avatar, "each remote account renders the actual photo-capable avatar");
    return { row, avatar };
  };
  const renderAvatar = (avatar: ReturnType<typeof photoRow>["avatar"]) => {
    const ownHooks = uiHooks();
    const render = () => {
      avatarHooks = ownHooks;
      return ownHooks.render(() => avatar.type(avatar.props));
    };
    render();
    return { hooks: ownHooks, render, all: () => nodes(ownHooks.tree) };
  };
  const { row: picturedRow, avatar: picturedAvatar } = photoRow(picturedPerson);
  assert.equal(
    (picturedRow as any).key,
    person.account_id,
    "avatar state stays inside an account-keyed row",
  );
  assert.equal(picturedAvatar.props.name, person.name);
  assert.equal(picturedAvatar.props.pictureUrl, photoUrl);
  assert.equal(
    (picturedAvatar as any).key,
    photoUrl,
    "a changed URL gets a fresh avatar load state",
  );
  const photo = renderAvatar(picturedAvatar);
  const image = photo.all().find((node) => node.type === "Image")!;
  const initial = photo.all().find((node) => node.type === "Avatar")!;
  assert.ok(image && initial, "the initials remain under the photo while it loads");
  assert.deepEqual(image.props.source, { uri: photoUrl });
  assert.equal(initial.props.label, "J");
  assert.equal(initial.props.size, 36);
  const photoStyle = flattenStyle(image.props.style);
  assert.equal(photoStyle.width, 36);
  assert.equal(photoStyle.height, 36);
  const photoFrame = photo.all().find((node) => node.type === "View")!;
  assert.equal(flattenStyle(photoFrame.props.style).borderRadius, 18);
  assert.equal(
    flattenStyle(photoFrame.props.style).overflow,
    "hidden",
    "the photo is clipped to the same circular footprint as initials",
  );
  assert.equal(image.props.resizeMode ?? photoStyle.resizeMode, "cover");
  assert.equal(
    image.props.accessible,
    false,
    "the decorative photo does not duplicate the row's accessible name",
  );
  picturedRow.props.onPress();
  assert.equal(selected[0], picturedPerson, "a photo tap still selects the exact account object");
  image.props.onError();
  photo.render();
  assert.equal(
    photo.all().some((node) => node.type === "Image"),
    false,
  );
  assert.ok(
    photo.all().some((node) => node.type === "Avatar" && node.props.label === "J"),
    "a failed image leaves the initials visible",
  );
  picturedRow.props.onPress();
  assert.equal(selected[1], picturedPerson);

  for (const picture_url of [undefined, ""]) {
    const { avatar } = photoRow({ ...person, picture_url });
    const fallback = renderAvatar(avatar);
    assert.equal(
      fallback.all().some((node) => node.type === "Image"),
      false,
    );
    assert.ok(
      fallback.all().some((node) => node.type === "Avatar" && node.props.size === 36),
      "missing photos keep the same initials footprint",
    );
    fallback.hooks.unmount();
  }
  const changed = photoRow({ ...picturedPerson, picture_url: `${photoUrl}?updated=1` });
  assert.notEqual((changed.avatar as any).key, (picturedAvatar as any).key);
  const nextPhoto = renderAvatar(changed.avatar);
  nextPhoto
    .all()
    .find((node) => node.type === "Image")!
    .props.onLoad();
  nextPhoto.render();
  assert.equal(
    nextPhoto.all().some((node) => node.type === "Avatar"),
    false,
    "loaded photos replace the loading initials",
  );
  image.props.onError();
  nextPhoto.render();
  assert.equal(
    nextPhoto.all().find((node) => node.type === "Image")?.props.source.uri,
    `${photoUrl}?updated=1`,
    "an old image failure cannot hide a replacement photo",
  );
  photo.hooks.unmount();
  nextPhoto.hooks.unmount();

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
    [{ ...person, account_id: accountA, is_friend: true }],
    "unscoped results preserve friendship while stripping book-specific relationships",
  );
  const pictureSources = [
    photoUrl,
    "http://photos.example.test/john.jpg",
    "data:image/png;base64,AAAA",
    "file:///private/photo.jpg",
    `https://photos.example.test/${"x".repeat(100_000)}`,
    "",
  ];
  const pictureRequest = pending.length;
  const directoryPhotos = api.searchPeopleDirectory("John", new AbortController().signal, vault);
  await settleUI();
  pending[pictureRequest].reply.resolve(
    response(
      pictureSources.map((picture_url, index) => ({
        ...person,
        account_id: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`,
        picture_url,
      })),
    ),
  );
  const photosResult = await directoryPhotos;
  assert.equal(
    photosResult.people.length,
    pictureSources.length,
    "an unusable photo never hides its account from search",
  );
  assert.equal(photosResult.people[0].picture_url, photoUrl);
  for (const invalid of photosResult.people.slice(1))
    assert.equal(
      Object.hasOwn(invalid, "picture_url"),
      false,
      "transport drops non-HTTPS, empty and oversized photo URLs",
    );
  console.log(
    "people search: account photos and initials fallback, exact row selection, bounded photo URLs, query normalization, bounded results, debounce and session/scope races passed",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
