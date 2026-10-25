import assert from "node:assert/strict";
import { pickInitialRoute, type InitialRoute } from "../onboarding-route";
import { compileUI, jsx, uiHooks } from "./ui-fixture";

function fixture(initialPath = "/", initialReady = false) {
  const hooks = uiHooks();
  let pathname = initialPath;
  let ready = initialReady;
  let route: InitialRoute = "index";
  const replacements: string[] = [];
  const router = { replace: (path: string) => replacements.push(path) };
  const { InitialRouteRedirect } = compileUI("../../components/InitialRouteRedirect", {
    react: hooks.react,
    "expo-router": {
      usePathname: () => pathname,
      useRootNavigationState: () => (ready ? { key: "root" } : undefined),
      useRouter: () => router,
    },
  });
  const render = (nextRoute = route) => {
    route = nextRoute;
    return hooks.render(() => {
      InitialRouteRedirect({ route });
      return jsx("Root", {});
    });
  };
  return {
    render,
    replacements,
    setReady: () => {
      ready = true;
    },
    setPath: (path: string) => {
      pathname = path;
    },
  };
}

for (const route of [
  "onboarding/language",
  "onboarding/calendar",
  "onboarding/auth",
  "onboarding/profile",
  "onboarding/kaata",
  "onboarding/restore",
] satisfies InitialRoute[]) {
  const launch = fixture();
  launch.render(route);
  assert.deepEqual(launch.replacements, [], "root navigator must be ready before replacement");
  launch.setReady();
  launch.render();
  assert.deepEqual(launch.replacements, [`/${route}`]);
  launch.setPath("/");
  launch.render("onboarding/language");
  assert.equal(launch.replacements.length, 1, "ordinary home navigation cannot restart setup");
}

const home = fixture("/", true);
home.render("index");
assert.deepEqual(home.replacements, []);

for (const path of ["/t/invitation", "/person/customer", "/onboarding/auth"]) {
  const link = fixture(path, true);
  link.render("onboarding/restore");
  assert.deepEqual(link.replacements, [], "incoming destinations remain intact");
  link.setPath("/");
  link.render();
  assert.deepEqual(link.replacements, [], "later home navigation is not a launch redirect");
}
const delayedLink = fixture();
delayedLink.render("onboarding/restore");
delayedLink.setPath("/t/invitation");
delayedLink.setReady();
delayedLink.render();
assert.deepEqual(delayedLink.replacements, [], "a link resolved during boot keeps its destination");

const cancelledDeletion = pickInitialRoute({
  hasOnboarded: true,
  onboardingStep: "done",
  deviceIsPersian: false,
  accountId: "account",
  restoreSkipped: false,
  cancelledDeletionAccountId: "account",
});
assert.equal(cancelledDeletion, "onboarding/restore");
const restored = fixture("/", true);
restored.render(cancelledDeletion);
assert.deepEqual(restored.replacements, ["/onboarding/restore"]);
console.log(
  "PASS SDK 58 launch waits for navigation, resumes setup/restore once, and preserves links",
);
