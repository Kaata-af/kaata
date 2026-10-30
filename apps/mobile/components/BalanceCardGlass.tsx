import { BlurTargetView, BlurView } from "expo-blur";
import { memo, useRef } from "react";
import { Platform, StyleSheet, View, type ViewInstance } from "react-native";
import { colors } from "../lib/colors";
import { useSheetTransparencyPreference } from "./SheetBackdrop";

/** A static frosted backing, below the card's text and touch targets. Never
 * capture the app-wide sheet target here: it also contains this card. */
export const BalanceCardGlass = memo(function BalanceCardGlass(
  props: { reducedTransparency?: boolean } = {},
) {
  const target = useRef<ViewInstance | null>(null);
  const android = Platform.OS === "android";
  const contextReducedTransparency = useSheetTransparencyPreference();
  const reducedTransparency = props.reducedTransparency ?? contextReducedTransparency;
  // Older Android uses an opaque pearl surface, without a RenderScript blur.
  const blur =
    !reducedTransparency &&
    (Platform.OS === "ios" || (Platform.OS === "android" && Number(Platform.Version) >= 31));
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {blur ? (
        <>
          {/* This sibling's ref attaches before BlurView mounts. The source
              contains decoration only, so the amounts are never blurred. */}
          <BlurTargetView ref={target} collapsable={false} style={styles.source}>
            {/* Android records the target's children, not its host background.
                An opaque base keeps the sharp source shapes from showing
                through the blurred copy. iOS keeps its existing material. */}
            {android ? <View style={styles.androidBase} /> : null}
            <View style={[styles.glow, styles.collectGlow]} />
            <View style={[styles.glow, styles.payGlow]} />
          </BlurTargetView>
          <BlurView
            blurTarget={target}
            blurMethod="dimezisBlurViewSdk31Plus"
            // Android derives both its white tint and radius from intensity.
            // Reduce the veil while retaining roughly the same blur radius.
            intensity={android ? 38 : 55}
            blurReductionFactor={android ? 0.7 : 1}
            tint="light"
            style={StyleSheet.absoluteFill}
          />
        </>
      ) : null}
      <View style={styles.highlight} />
    </View>
  );
});

const styles = StyleSheet.create({
  source: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  androidBase: { ...StyleSheet.absoluteFill, backgroundColor: colors.bgBalanceGlass },
  glow: { position: "absolute", width: 240, height: 200, borderRadius: 120 },
  collectGlow: { top: -90, left: -55, backgroundColor: colors.entryActionReceived },
  payGlow: { bottom: -140, right: -75, backgroundColor: colors.entryActionGave },
  highlight: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#FFFFFF33",
    borderTopWidth: 1,
    borderTopColor: "#FFFFFFCC",
  },
});
