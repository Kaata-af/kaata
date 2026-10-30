import { BlurTargetView, BlurView } from "expo-blur";
import { memo, useRef } from "react";
import { Platform, StyleSheet, View, type ViewInstance } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors } from "../lib/colors";
import { useSheetTransparencyPreference } from "./SheetBackdrop";

const PAY_GLOW = "#F8DCE2";

/** A static frosted backing, below the card's text and touch targets. iOS
 * keeps its native material; Android paints already-soft, opaque decoration. */
export const BalanceCardGlass = memo(function BalanceCardGlass(
  props: { reducedTransparency?: boolean; tone?: "collect" | "pay" | "neutral" } = {},
) {
  const target = useRef<ViewInstance | null>(null);
  const android = Platform.OS === "android";
  const pay = props.tone === "pay";
  const neutral = props.tone === "neutral";
  // Soft rose light complements cherry pay controls and amounts. Customer
  // owed balances use it in both corners, without a green ray.
  const primary = pay ? PAY_GLOW : "#BFE5CF";
  const secondary = PAY_GLOW;
  const contextReducedTransparency = useSheetTransparencyPreference();
  const reducedTransparency = props.reducedTransparency ?? contextReducedTransparency;
  const blur = !reducedTransparency && !neutral && Platform.OS === "ios";
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {android || neutral ? <View style={styles.whiteBase} /> : null}
      {android && !reducedTransparency && !neutral ? (
        <Svg
          width="100%"
          height="100%"
          viewBox="0 0 440 180"
          preserveAspectRatio="none"
          // Customer cards are taller than the homepage board. Soften their
          // full-card tint to match iOS's fixed-size, more localized glows.
          opacity={props.tone ? 0.85 : 1}
          style={StyleSheet.absoluteFill}
        >
          <Defs>
            <RadialGradient id="balance-collect" cx="0%" cy="0%" rx="80%" ry="140%">
              <Stop offset="0" stopColor={primary} />
              <Stop offset="0.5" stopColor={primary} stopOpacity="0.35" />
              <Stop offset="1" stopColor={primary} stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="balance-pay" cx="100%" cy="100%" rx="75%" ry="140%">
              <Stop offset="0" stopColor={secondary} />
              <Stop offset="0.5" stopColor={secondary} stopOpacity="0.35" />
              <Stop offset="1" stopColor={secondary} stopOpacity="0" />
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
            <View style={[styles.glow, styles.collectGlow, pay && styles.owedGlow]} />
            <View style={[styles.glow, styles.payGlow, pay && styles.owedGlow]} />
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
  whiteBase: { ...StyleSheet.absoluteFill, backgroundColor: "#FFFFFF" },
  glow: { position: "absolute", width: 240, height: 200, borderRadius: 120 },
  collectGlow: { top: -90, left: -55, backgroundColor: colors.entryActionReceived },
  payGlow: { bottom: -140, right: -75, backgroundColor: PAY_GLOW },
  owedGlow: { backgroundColor: PAY_GLOW },
  androidHighlight: { backgroundColor: "#FFFFFF1F" },
  highlight: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#FFFFFF33",
    borderTopWidth: 1,
    borderTopColor: "#FFFFFFCC",
  },
});
