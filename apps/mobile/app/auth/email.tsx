import { useLocalSearchParams, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { AuthScreen } from "../onboarding/auth";

/** A native email form above its provider selector, so swiping Back returns
 * to Google/Apple/email choices in both onboarding and settings sign-in. */
export default function EmailAuthScreen() {
  const { redirected } = useLocalSearchParams<{ redirected?: string }>();
  const navigation = useRootNavigationState();
  const router = useRouter();
  const repairing = useRef(false);
  const isRedirected = redirected === "1";
  const providerName = isRedirected ? "sign-in" : "onboarding/auth";
  const index = navigation?.index ?? 0;
  const activeRoute = navigation?.routes[index];
  const providerReady =
    activeRoute?.name === "auth/email" && navigation?.routes[index - 1]?.name === providerName;

  useEffect(() => {
    // A direct link or restored route can start with only Home underneath.
    // Rebuild the same selector -> email stack as a normal button press before
    // enabling a swipe. Ignore this mounted screen once another route is active.
    if (
      !navigation?.key ||
      activeRoute?.name !== "auth/email" ||
      providerReady ||
      repairing.current
    )
      return;
    repairing.current = true;
    router.replace(isRedirected ? "/sign-in" : "/onboarding/auth");
    router.push({ pathname: "/auth/email", params: { redirected: isRedirected ? "1" : "0" } });
  }, [activeRoute?.name, isRedirected, navigation?.key, providerReady, router]);

  return <AuthScreen emailRoute redirected={isRedirected} providerReady={providerReady} />;
}
