import { usePathname, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import type { InitialRoute } from "../lib/onboarding-route";

/** Resume setup only on the ordinary launch path; an incoming link keeps its destination. */
export function InitialRouteRedirect({ route }: { route: InitialRoute }) {
  const pathname = usePathname();
  const handled = useRef(false);
  const router = useRouter();
  const navigationReady = !!useRootNavigationState()?.key;
  useEffect(() => {
    if (handled.current || !navigationReady) return;
    handled.current = true;
    if (pathname === "/" && route !== "index") router.replace(`/${route}`);
  }, [route, pathname, router, navigationReady]);
  return null;
}
