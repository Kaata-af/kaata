import { usePathname, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Linking } from "react-native";
import { useAppMeta } from "../lib/app-meta-context";
import { getSessionJWT, readEmailFlowPending, readSetupFlowPending } from "../lib/auth";

// Expo Router can cold-start at / even when Stack.initialRouteName names an
// onboarding screen. Resume from the mounted navigator, including the default
// Home -> onboarding redirect, rather than relying on that Stack back route.
const DEFAULT_START_ROUTES = new Set([
  "/",
  "/onboarding",
  "/onboarding/language",
  "/onboarding/auth",
]);

export function PendingEmailFlowResume({
  hasOnboarded,
  launchNotificationsReady,
  launchNotificationOpened,
}: {
  hasOnboarded: boolean;
  launchNotificationsReady: boolean;
  launchNotificationOpened: boolean;
}) {
  const pathname = usePathname();
  const navigation = useRootNavigationState();
  const router = useRouter();
  const { forceUpdate } = useAppMeta();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || !navigation?.key || !launchNotificationsReady) return;
    if (forceUpdate || launchNotificationOpened || !DEFAULT_START_ROUTES.has(pathname)) {
      handled.current = true;
      return;
    }
    let cancelled = false;
    void (async () => {
      // A native link may target even an onboarding screen: never replace
      // explicit launch intent with a code step left from an earlier visit.
      const initialURL = await Linking.getInitialURL();
      if (cancelled) return;
      if (initialURL) {
        handled.current = true;
        return;
      }
      const pending = await readEmailFlowPending();
      if (cancelled) return;
      if (!pending) {
        handled.current = true;
        return;
      }
      const session = await getSessionJWT();
      if (cancelled) return;
      let target: "/account-password" | "/sign-in" | "/onboarding/auth";
      if (pending.purpose === "setup") {
        // This reader rejects/clears another account's setup record. A cached
        // account_id alone is not a signed-in session after a local sign-out.
        const setup = await readSetupFlowPending();
        if (cancelled) return;
        if (!session || !setup) {
          handled.current = true;
          return;
        }
        target = "/account-password";
      } else {
        // Successful authentication clears the pending record. If a session
        // already exists, keep its normal restore/onboarding/home behavior.
        if (session) {
          handled.current = true;
          return;
        }
        target = hasOnboarded ? "/sign-in" : "/onboarding/auth";
      }
      handled.current = true;
      // Push once from the mounted navigator. Back then leaves the code step
      // without a root-layout replace/remount reopening it again.
      if (pathname !== target) {
        if (target === "/sign-in") router.push({ pathname: target, params: { mode: "email" } });
        else router.push(target);
      }
    })().catch((err: unknown) => {
      if (cancelled) return;
      handled.current = true;
      console.warn("[startup] could not resume the email code step", err);
    });
    return () => {
      cancelled = true;
    };
  }, [
    forceUpdate,
    hasOnboarded,
    launchNotificationOpened,
    launchNotificationsReady,
    navigation?.key,
    pathname,
    router,
  ]);

  return null;
}
