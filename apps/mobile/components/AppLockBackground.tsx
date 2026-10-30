import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet } from "react-native";
import { BalanceCardGlass } from "./BalanceCardGlass";
import { colors } from "../lib/colors";
import { useReducedMotion } from "../lib/reduced-motion";

/** Move the decorative surface as one layer; text, borders and controls stay put. */
export function AppLockBackground({ active }: { active: boolean }) {
  // The privacy gate sits outside SheetBlurProvider, so its OS preferences
  // cannot come from that provider's default context values.
  const reducedMotion = useReducedMotion();
  const [reducedTransparency, setReducedTransparency] = useState(false);
  const phase = useRef(new Animated.Value(0.5)).current;
  const supportsGlass =
    Platform.OS === "ios" || (Platform.OS === "android" && Number(Platform.Version) >= 31);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let alive = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (value) => {
        if (!alive || typeof value !== "boolean") return;
        changed = true;
        setReducedTransparency(value);
      },
    );
    void Promise.resolve()
      .then(() => (alive ? AccessibilityInfo.isReduceTransparencyEnabled() : undefined))
      .then((value) => {
        if (alive && !changed && typeof value === "boolean") setReducedTransparency(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reducedMotion || reducedTransparency || !supportsGlass) {
      phase.setValue(0.5);
      return;
    }
    if (!active) return;
    const settings = {
      duration: 10_000,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: true,
      // An ambient loop must not hold up list rendering or navigation work.
      isInteraction: false,
    };
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(phase, { ...settings, toValue: 1 }),
        Animated.timing(phase, { ...settings, toValue: 0 }),
      ]),
      { iterations: -1, resetBeforeIteration: false },
    );
    loop.start();
    // Preserve the native phase when authentication makes the app inactive.
    // A new sequence resumes from there, without snapping to the first frame.
    return () => loop.stop();
  }, [active, reducedMotion, reducedTransparency, supportsGlass, phase]);

  return (
    <Animated.View
      testID="app-lock-background"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.surface,
        {
          transform: [
            { translateX: phase.interpolate({ inputRange: [0, 1], outputRange: [-10, 10] }) },
            { translateY: phase.interpolate({ inputRange: [0, 1], outputRange: [12, -12] }) },
            { scale: phase.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] }) },
          ],
        },
      ]}
    >
      <BalanceCardGlass reducedTransparency={reducedTransparency} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Larger than the full translation in either direction, including the pause
  // endpoints. The stationary card clips this layer, so no edges can show.
  surface: {
    position: "absolute",
    top: -24,
    right: -24,
    bottom: -24,
    left: -24,
    backgroundColor: colors.bgBalanceGlass,
  },
});
