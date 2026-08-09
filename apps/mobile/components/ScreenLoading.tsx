// components/ScreenLoading.tsx
//
// The loading / not-found state for a pushed screen, WITH its chrome.
//
// Seven screens used to render a bare centered <ActivityIndicator> inside an
// otherwise empty SafeAreaView while they loaded: app/account.tsx,
// app/vault/{settings,members,audit-log}.tsx, app/person/[id]/edit.tsx and
// app/entry/{new,[id]/edit}.tsx. Three problems, in increasing severity:
//
//   1. A blank white screen with a floating spinner reads as a broken app, not
//      a loading one. Nothing on it says which screen you are on.
//   2. Everything pops in at once when the load resolves — header, title and
//      content arrive in the same frame, so the screen visibly jumps.
//   3. These screens set headerShown:false and draw their own header, so while
//      loading there is NO back affordance at all. On Android the hardware back
//      still works; on iOS the only escape is the edge-swipe, and on a
//      `presentation: "modal"` screen not even that. A slow or failed load was
//      a dead end.
//
// app/person/[id].tsx already fixed exactly this for itself — its comment reads
// "The old empty <View /> here was a dead end with no escape on iOS" — and the
// fix was never carried across. This is that fix, extracted.
//
// Renders the header FIRST and always, so the chrome is stable across the
// load: the title and back chevron are painted before the content resolves and
// do not move when it does.

import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "./SettingsScreen";
import { colors } from "../lib/colors";
import { typography } from "../lib/tokens";

export function ScreenLoading(props: {
  /** Same title the loaded screen will show, so nothing changes when it does. */
  title: string;
  /** Same handler the loaded screen uses. null renders an inert spacer (see
   *  ScreenHeader) for forced-context screens with nowhere to pop back to. */
  onBack: (() => void) | null;
  isRTL: boolean;
  /**
   * When set, render this instead of the spinner — the resolved-but-empty
   * case (not found, load failed). Distinguishing the two matters: telling a
   * shopkeeper a real contact "was not found" on a transient storage error is
   * a false data-loss signal, which is why callers pass different copy for
   * "doesn't exist" and "couldn't read".
   */
  message?: string | null;
  /**
   * Must match the edges the LOADED branch uses. vault/settings.tsx passed
   * none here and ["top","bottom"] when loaded, so the content shifted the
   * moment the load resolved.
   */
  edges?: readonly ("top" | "bottom" | "left" | "right")[];
}) {
  return (
    <SafeAreaView style={styles.root} edges={props.edges ?? ["top"]}>
      <ScreenHeader title={props.title} onBack={props.onBack} isRTL={props.isRTL} />
      <View style={styles.fill}>
        {props.message ? (
          <Text style={styles.message}>{props.message}</Text>
        ) : (
          <ActivityIndicator color={colors.textDefault} />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDefault },
  fill: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  message: { ...typography.body, color: colors.textSubtle, textAlign: "center" },
});
