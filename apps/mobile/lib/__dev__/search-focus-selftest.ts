import assert from "node:assert/strict";
import { compileUI, jsx, uiHooks } from "./ui-fixture";

const hooks = uiHooks();
const route = { key: "person-owner", name: "person/[id]" };
type Route = { key: string; name: string; params?: Record<string, unknown> };
let state: { index: number; routes: Route[] } = { index: 0, routes: [route] };
let parentFocused = true;
const listeners = new Map<string, Set<() => void>>();
const emit = (event: string) => {
  for (const listener of [...(listeners.get(event) ?? [])]) listener();
};
const navigation = {
  getState: () => state,
  isFocused: () => parentFocused && state.routes[state.index]?.key === route.key,
  getParent: () => ({ isFocused: () => parentFocused }),
  addListener: (event: string, listener: () => void) => {
    const set = listeners.get(event) ?? new Set();
    listeners.set(event, set);
    set.add(listener);
    return () => set.delete(listener);
  },
};
const { useSearchFocusEffect } = compileUI("../use-search-focus-effect", {
  react: hooks.react,
  "expo-router": { useNavigation: () => navigation, useRoute: () => route },
});
let starts = 0,
  stops = 0,
  running = 0;
const effect = () => {
  starts++;
  running++;
  assert.equal(running, 1, "only one live subscription per focus effect");
  return () => {
    stops++;
    running--;
  };
};
let currentEffect = effect;
hooks.render(() => {
  useSearchFocusEffect(currentEffect);
  return jsx("View", {});
});
assert.equal(starts, 1);

const searchRoute = (ownerKey: unknown = route.key, sessionId: unknown = "search-1"): Route => ({
  key: "search-modal",
  name: "search",
  params: { ownerKey, sessionId },
});
const move = (top: Route, event = "state") => {
  state =
    top.key === route.key ? { index: 0, routes: [route] } : { index: 1, routes: [route, top] };
  emit(event);
};

move(searchRoute(), "blur");
emit("state");
assert.equal(stops, 0, "opening the owner's search must retain data, selection and watchers");
assert.equal(starts, 1);
move(route, "focus");
emit("state");
assert.equal(starts, 1, "returning from search must not duplicate retained subscriptions");
assert.equal(stops, 0);

move(searchRoute("another-person"), "blur");
assert.equal(stops, 1, "another screen's search is a real blur");
emit("blur");
emit("state");
assert.equal(stops, 1, "repeated navigation events clean up once");
move(route, "focus");
assert.equal(starts, 2);
move({ key: "search-modal", name: "search", params: { ownerKey: route.key } }, "blur");
assert.equal(stops, 2);
move(searchRoute(route.key, null));
move(searchRoute(route.key, ""));
assert.equal(starts, 2);
move(searchRoute());
assert.equal(starts, 3);

// Dependency updates while the modal is open replace the old subscription once.
currentEffect = () => effect();
hooks.render();
assert.equal(stops, 3);
assert.equal(starts, 4);
emit("focus");
emit("state");
assert.equal(starts, 4);

parentFocused = false;
emit("blur");
assert.equal(stops, 4, "an inactive parent navigator cannot keep search active");
parentFocused = true;
emit("focus");
assert.equal(starts, 5);
move({ key: "destination", name: "entry/new" });
assert.equal(stops, 5, "leaving search for another route releases live ownership");
move(searchRoute());
assert.equal(starts, 6);
hooks.unmount();
assert.equal(stops, 6);
assert.equal(running, 0);
assert.ok([...listeners.values()].every((set) => set.size === 0));
emit("focus");
assert.equal(starts, 6, "unmounted screens cannot restart stale subscriptions");

console.log("Search focus: owner/modal transitions, live subscription lifetime and cleanup pass.");
