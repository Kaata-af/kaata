import { useNavigation, useRoute } from "expo-router";
import { useEffect } from "react";

type FocusEffect = () => void | (() => void);

/** Keep a screen's live data and selection active while its native search is above it. */
export function useSearchFocusEffect(effect: FocusEffect): void {
  const navigation = useNavigation();
  const route = useRoute();

  useEffect(() => {
    let active = false;
    let cleanup: void | (() => void);

    const stop = () => {
      active = false;
      const previous = cleanup;
      cleanup = undefined;
      previous?.();
    };
    const sync = () => {
      const state = navigation.getState();
      const top = state?.routes[state.index];
      const params = top?.params as { ownerKey?: unknown; sessionId?: unknown } | undefined;
      const ownsSearch =
        top?.name === "search" &&
        params?.ownerKey === route.key &&
        typeof params.sessionId === "string" &&
        params.sessionId.length > 0 &&
        (navigation.getParent()?.isFocused() ?? true);
      const focused = navigation.isFocused() || ownsSearch;
      if (focused === active) return;
      if (!focused) {
        stop();
        return;
      }
      active = true;
      cleanup = effect();
    };

    const unsubscribeFocus = navigation.addListener("focus", sync);
    const unsubscribeBlur = navigation.addListener("blur", sync);
    const unsubscribeState = navigation.addListener("state", sync);
    sync();

    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
      unsubscribeState();
      stop();
    };
  }, [effect, navigation, route.key]);
}
