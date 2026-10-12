import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

function restoreFixture(marker = "account-a", options: { expiredSession?: boolean } = {}) {
  const hooks = uiHooks();
  const meta = new Map<string, string>([
    ["account_id", "account-a"],
    ["account_deletion_cancelled", marker],
  ]);
  const routes: string[] = [],
    writes: [string, string][] = [];
  let recoveries = 0,
    listings = 0;
  const strictRecoveries: boolean[] = [];
  const archivedRecoveries: boolean[] = [];
  let result: any = { recovered: ["kaata-a", "kaata-b"], failed: [] };
  let gate: Promise<any> | null = null;
  let generation = 0,
    focused = true;
  const router = { replace: (route: string) => routes.push(route) };
  const session = () => ({
    jwt: options.expiredSession ? null : "session-" + meta.get("account_id"),
    accountId: meta.get("account_id"),
    generation,
    bindingVersion: generation,
  });
  const sameSession = (before: any) =>
    before.accountId === meta.get("account_id") &&
    (before.generation === generation || before.bindingVersion === generation);
  class RestoreSessionExpiredError extends Error {}
  class RestoreTimeoutError extends Error {}
  class SessionChangedError extends Error {}
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const Screen = compileUI(
    "../../app/onboarding/restore",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      react: hooks.react,
      "expo-router": { useRouter: () => router, useIsFocused: () => focused },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": {
        View: "View",
        Text: "Text",
        Pressable: "Pressable",
        ActivityIndicator: "Spinner",
        Platform: { OS: "android", select: (value: any) => value.android },
        StyleSheet: { create: (value: any) => value },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../../components/Button": { Button: "Button" },
      "../../components/ConfirmDialog": { ConfirmDialog: "Confirm" },
      "../../components/RestoreProgress": {
        RestoreProgress: "Progress",
        restoreProgressLabel: () => "normal-progress",
      },
      "../../lib/checkin-trigger": { requestImmediateCheckIn: () => {} },
      "../../lib/colors": { colors: {} },
      "../../lib/db": {
        getAppMeta: async (key: string) => meta.get(key) ?? null,
        setAppMeta: async (key: string, value: string) => {
          writes.push([key, value]);
          meta.set(key, value);
        },
      },
      "../../lib/db-tx": { getAccountIdSync: () => meta.get("account_id") },
      "../../lib/auth": {
        SessionChangedError,
        adoptAccountPhoneToSelf: async () => {},
        captureCurrentSession: async () => session(),
        isCurrentSession: async (before: any) => sameSession(before),
        // Like the real guard, the account guard refuses a missing token.
        applyForCurrentSession: async (before: any, apply: () => Promise<any>) => {
          if (!before.jwt || !sameSession(before)) throw new SessionChangedError();
          return apply();
        },
        applyForUnchangedLocalSession: async (before: any, apply: () => Promise<any>) => {
          if (!sameSession(before)) throw new SessionChangedError();
          return apply();
        },
      },
      "../../lib/direction": {
        useIsRTL: () => false,
        textDir: () => ({}),
        trackingSafe: () => ({}),
      },
      "../../lib/fonts": { fonts: {}, sansLineHeight: (_: number, height: number) => height },
      "../../lib/i18n": { t: (key: string) => key },
      "../../lib/recovery": {
        recoverAllVaults: async ({ onProgress, requireComplete, includeArchived }: any) => {
          recoveries++;
          strictRecoveries.push(requireComplete === true);
          archivedRecoveries.push(includeArchived === true);
          onProgress({ fraction: 0.5 });
          return gate ? gate : result;
        },
      },
      "../../lib/restore": { RestoreSessionExpiredError, RestoreTimeoutError },
      "../../lib/tokens": { icon: {}, radius: {}, typography: {} },
      "../../lib/vault-api": {
        listVaults: async () => {
          listings++;
          if (options.expiredSession) throw new RestoreSessionExpiredError();
          return [
            { vault_id: "kaata-a", archived_at_ms: null },
            { vault_id: "kaata-b", archived_at_ms: null },
          ];
        },
      },
    },
    {
      setTimeout: (fn: () => void) => {
        timers.set(++nextTimer, fn);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  ).default;
  const render = () => hooks.render(() => Screen());
  render();
  return {
    hooks,
    meta,
    routes,
    writes,
    render,
    strictRecoveries,
    archivedRecoveries,
    get recoveries() {
      return recoveries;
    },
    get listings() {
      return listings;
    },
    gate: (value: Promise<any> | null) => {
      gate = value;
    },
    result: (value: any) => {
      result = value;
    },
    switchAccount: (id: string) => {
      meta.set("account_id", id);
      generation++;
    },
    focus: (value: boolean) => {
      focused = value;
      render();
    },
    flush: async () => {
      for (let i = 0; i < 8; i++) {
        await settleUI();
        render();
      }
    },
  };
}

const button = (fixture: ReturnType<typeof restoreFixture>, label: string) =>
  nodes(fixture.hooks.tree).find((node) => node.props.label === label)!;

async function main() {
  const normal = restoreFixture(),
    finished = deferred<any>();
  normal.gate(finished.promise);
  await normal.flush();
  assert.equal(
    normal.recoveries,
    1,
    "proved deletion cancellation automatically restores cloud ledgers",
  );
  assert.deepEqual(
    normal.strictRecoveries,
    [true],
    "deletion recovery requires complete ordinary and shared tallies",
  );
  assert.deepEqual(normal.archivedRecoveries, [true]);
  assert.equal(button(normal, "account.deleteAccount.restoring").type, "Progress");
  assert.equal(
    normal.meta.get("account_deletion_cancelled"),
    "account-a",
    "marker stays until recovery finishes",
  );
  finished.resolve({ recovered: ["kaata-a", "kaata-b"], failed: [] });
  await normal.flush();
  assert.deepEqual(normal.routes, ["/"]);
  assert.equal(normal.meta.get("onboarding_step"), "done");
  assert.equal(normal.meta.get("account_deletion_cancelled"), "");

  const partial = restoreFixture();
  partial.result({ recovered: ["kaata-a"], failed: [{ vaultId: "kaata-b", reason: "timeout" }] });
  await partial.flush();
  assert.equal(partial.recoveries, 1);
  assert.deepEqual(
    partial.routes,
    [],
    "partly restored deletion recovery stays on an actionable error",
  );
  assert.equal(partial.meta.get("account_deletion_cancelled"), "account-a");
  assert.ok(button(partial, "onboardingRestore.tryAgain"));
  partial.result({ recovered: ["kaata-a", "kaata-b"], failed: [] });
  button(partial, "onboardingRestore.tryAgain").props.onPress();
  await partial.flush();
  assert.equal(partial.recoveries, 2, "Try again retries the cancellation recovery after reprobe");
  assert.deepEqual(partial.routes, ["/"]);

  const other = restoreFixture("account-b");
  await other.flush();
  assert.equal(
    other.recoveries,
    0,
    "another account's cancellation marker never auto-restores this one",
  );
  assert.equal(other.meta.get("account_deletion_cancelled"), "account-b");
  const ordinary = restoreFixture("");
  await ordinary.flush();
  assert.equal(ordinary.recoveries, 0, "ordinary sign-in retains the explicit restore choice");
  nodes(ordinary.hooks.tree)
    .find(
      (node) =>
        node.type === "Pressable" &&
        nodes(node).some((child) => child.props.children === "onboardingRestore.restore.title"),
    )!
    .props.onPress();
  await ordinary.flush();
  assert.deepEqual(
    ordinary.strictRecoveries,
    [false],
    "ordinary restore retains its existing best-effort behavior",
  );

  // Audit #8: an expired or missing session token used to dead-end here.
  const expired = restoreFixture("", { expiredSession: true });
  await expired.flush();
  assert.ok(button(expired, "onboardingRestore.signInAgain"), "an expired session offers sign-in");
  assert.equal(button(expired, "onboardingRestore.tryAgain"), undefined);
  button(expired, "onboardingRestore.startFresh").props.onPress();
  await expired.flush();
  assert.deepEqual(expired.routes, ["/onboarding/profile"], "Start fresh escapes without a token");
  const signInAgain = restoreFixture("", { expiredSession: true });
  await signInAgain.flush();
  button(signInAgain, "onboardingRestore.signInAgain").props.onPress();
  await signInAgain.flush();
  assert.deepEqual(signInAgain.routes, ["/onboarding/auth"], "Sign in again opens sign-in");
  assert.equal(signInAgain.meta.get("onboarding_step"), "auth");

  const switched = restoreFixture(),
    oldResult = deferred<any>();
  switched.gate(oldResult.promise);
  await switched.flush();
  switched.switchAccount("account-b");
  switched.meta.set("account_deletion_cancelled", "account-b");
  oldResult.resolve({ recovered: ["kaata-a"], failed: [] });
  await switched.flush();
  assert.equal(
    switched.meta.get("account_deletion_cancelled"),
    "account-b",
    "late recovery cannot clear a new account's marker",
  );
  assert.ok(!switched.writes.some(([key]) => key === "onboarding_step"));
  assert.deepEqual(
    switched.routes,
    [],
    "late old-account recovery never routes the new account home",
  );

  const unmounted = restoreFixture(),
    pending = deferred<any>();
  unmounted.gate(pending.promise);
  await unmounted.flush();
  unmounted.hooks.unmount();
  pending.resolve({ recovered: ["kaata-a"], failed: [] });
  await settleUI();
  assert.deepEqual(unmounted.routes, []);
  assert.equal(unmounted.meta.get("account_deletion_cancelled"), "account-a");
  assert.equal(unmounted.hooks.lateWrites, 0);

  const unfocused = restoreFixture(),
    backgroundResult = deferred<any>();
  unfocused.gate(backgroundResult.promise);
  await unfocused.flush();
  unfocused.focus(false);
  backgroundResult.resolve({ recovered: ["kaata-a"], failed: [] });
  await unfocused.flush();
  assert.deepEqual(
    unfocused.routes,
    [],
    "background recovery does not navigate over the focused screen",
  );
  assert.equal(unfocused.meta.get("account_deletion_cancelled"), "account-a");
  assert.ok(!unfocused.writes.some(([key]) => key === "onboarding_step"));
  console.log(
    "Account deletion restore: automatic recovery, partial retry and account/mount-scoped completion passed.",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
