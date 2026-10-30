import { BlurTargetView, BlurView } from "expo-blur";
import { memo, useRef } from "react";
import { Platform, StyleSheet, View, type ViewInstance } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors } from "../lib/colors";
import { useSheetTransparencyPreference } from "./SheetBackdrop";

/** A static frosted backing, below the card's text and touch targets. iOS
 * keeps its native material; Android paints already-soft, opaque decoration. */
export const BalanceCardGlass = memo(function BalanceCardGlass(
  props: { reducedTransparency?: boolean } = {},
) {
  const target = useRef<ViewInstance | null>(null);
  const android = Platform.OS === "android";
  const contextReducedTransparency = useSheetTransparencyPreference();
  const reducedTransparency = props.reducedTransparency ?? contextReducedTransparency;
  const blur = !reducedTransparency && Platform.OS === "ios";
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {android ? <View style={styles.androidBase} /> : null}
      {android && !reducedTransparency ? (
        <Svg
          width="100%"
          height="100%"
          viewBox="0 0 440 180"
          preserveAspectRatio="none"
          style={StyleSheet.absoluteFill}
        >
          <Defs>
            <RadialGradient id="balance-collect" cx="0%" cy="0%" rx="80%" ry="140%">
              <Stop offset="0" stopColor="#BFE5CF" />
              <Stop offset="0.5" stopColor="#BFE5CF" stopOpacity="0.35" />
              <Stop offset="1" stopColor="#BFE5CF" stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="balance-pay" cx="100%" cy="100%" rx="75%" ry="140%">
              <Stop offset="0" stopColor="#FFD3B2" />
              <Stop offset="0.5" stopColor="#FFD3B2" stopOpacity="0.35" />
              <Stop offset="1" stopColor="#FFD3B2" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Rect width="440" height="180" fill="url(#balance-collect)" />
          <Rect width="440" height="180" fill="url(#balance-pay)" />
        </Svg>
      ) : null}
      {blur ? (
        <>
          {/* This sibling's ref attaches before BlurView mounts. The source
              contains decoration only, so the amounts are never blurred. */}
          <BlurTargetView ref={target} collapsable={false} style={styles.source}>
            <View style={[styles.glow, styles.collectGlow]} />
            <View style={[styles.glow, styles.payGlow]} />
          </BlurTargetView>
          <BlurView
            blurTarget={target}
            blurMethod="dimezisBlurViewSdk31Plus"
            intensity={55}
            blurReductionFactor={1}
            tint="light"
            style={StyleSheet.absoluteFill}
          />
        </>
      ) : null}
      <View style={[styles.highlight, android && styles.androidHighlight]} />
    </View>
  );
});

const styles = StyleSheet.create({
  source: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  // Android's decorative source does not need live blur. Painting it over
  // white avoids the native blur's gray veil, also on older Android phones.
  androidBase: { ...StyleSheet.absoluteFill, backgroundColor: "#FFFFFF" },
  glow: { position: "absolute", width: 240, height: 200, borderRadius: 120 },
  collectGlow: { top: -90, left: -55, backgroundColor: colors.entryActionReceived },
  payGlow: { bottom: -140, right: -75, backgroundColor: colors.entryActionGave },
  androidHighlight: { backgroundColor: "#FFFFFF1F" },
  highlight: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#FFFFFF33",
    borderTopWidth: 1,
    borderTopColor: "#FFFFFFCC",
  },
});
