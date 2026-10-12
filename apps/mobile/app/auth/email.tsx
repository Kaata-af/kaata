import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AuthScreen } from "../onboarding/auth";

type StackRoutes = { key?: string; index: number; routes: { name: string }[] } | undefined;

/** A native email form above its provider selector, so swiping Back returns
 * to Google/Apple/email choices in both onboarding and settings sign-in. */
export default function EmailAuthScreen() {
  const { redirected } = useLocalSearchParams<{ redirected?: string }>();
  // Read the root Stack that actually holds this screen. useRootNavigationState()
  // returns expo-router's outer slot navigator, whose only route is "__root",
  // so it never showed auth/email on top: the swipe stayed disabled and the
  // stack repair below never ran.
  const navigation = useNavigation();
  const [stack, setStack] = useState<StackRoutes>(() => navigation.getState());
  useEffect(() => {
    setStack(navigation.getState());
    return navigation.addListener("state", () => setStack(navigation.getState()));
  }, [navigation]);
  const router = useRouter();
  const repairing = useRef(false);
  const isRedirected = redirected === "1";
  const providerName = isRedirected ? "sign-in" : "onboarding/auth";
  const index = stack?.index ?? 0;
  const activeRoute = stack?.routes[index];
  const providerReady =
    activeRoute?.name === "auth/email" && stack?.routes[index - 1]?.name === providerName;

  useEffect(() => {
    // A direct link or restored route can start with only Home underneath.
    // Rebuild the same selector -> email stack as a normal button press before
    // enabling a swipe. Ignore this mounted screen once another route is active.
    if (!stack?.key || activeRoute?.name !== "auth/email" || providerReady || repairing.current)
      return;
    repairing.current = true;
    router.replace(isRedirected ? "/sign-in" : "/onboarding/auth");
    router.push({ pathname: "/auth/email", params: { redirected: isRedirected ? "1" : "0" } });
  }, [activeRoute?.name, isRedirected, stack?.key, providerReady, router]);

  return <AuthScreen emailRoute redirected={isRedirected} providerReady={providerReady} />;
}
