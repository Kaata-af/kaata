import {
  Stack,
  useIsFocused,
  useLocalSearchParams,
  useNavigation,
  usePreventRemove,
  useRoute,
  useRouter,
} from "expo-router";
import { cloneElement, isValidElement, useEffect, useSyncExternalStore } from "react";
import { BackHandler, View } from "react-native";
import { ToastHost } from "../components/Toast";
import {
  closeNativeSearch,
  getNativeSearch,
  nativeSearchPopAction,
  removeNativeSearch,
  subscribeNativeSearch,
} from "../lib/native-search";

/** Uses the same native Stack modal as person/new; search has no custom shell. */
export default function NativeSearchScreen() {
  const { sessionId, ownerKey } = useLocalSearchParams<{ sessionId?: string; ownerKey?: string }>();
  const id = typeof sessionId === "string" ? sessionId : "";
  const session = useSyncExternalStore(
    subscribeNativeSearch,
    () => getNativeSearch(id),
    () => null,
  );
  const navigation = useNavigation();
  const focused = useIsFocused();
  const route = useRoute();
  const router = useRouter();
  const valid =
    !!session &&
    typeof ownerKey === "string" &&
    session.ownerKey === ownerKey &&
    !!navigation.getState()?.routes.some((item) => item.key === ownerKey);
  const busy = valid && !session?.closing && !!session?.busy;
  const disablePrevention = usePreventRemove(busy);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!navigation.isFocused()) return false;
      if (getNativeSearch(id)?.ownerKey === ownerKey) closeNativeSearch(id);
      return true;
    });
    return () => back.remove();
  }, [id, ownerKey, navigation]);
  useEffect(() => {
    if (valid && !session?.closing) return;
    const state = navigation.getState();
    if (!state?.key || !state.routes.some((item) => item.key === route.key)) return;
    disablePrevention();
    if (state.routes.length > 1) navigation.dispatch(nativeSearchPopAction(state.key, route.key));
    else router.replace("/");
  }, [valid, session?.closing, navigation, route.key, router, disablePrevention]);
  useEffect(
    () => () => {
      if (getNativeSearch(id)?.ownerKey === ownerKey) removeNativeSearch(id);
    },
    [id, ownerKey],
  );

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      {/* Keep a native parent while pointerEvents changes on dismissal. Otherwise
          Fabric unflattens this View during the native exit and reparents content
          still held by ScreenContentWrapper, crashing Android with addViewAt. */}
      <View
        collapsable={false}
        style={{ flex: 1 }}
        pointerEvents={valid && !session?.closing ? "auto" : "none"}
      >
        {valid && isValidElement<{ active?: boolean }>(session.content)
          ? cloneElement(session.content, { active: !session.closing })
          : null}
        {valid && !session.closing && focused ? <ToastHost /> : null}
      </View>
    </>
  );
}
