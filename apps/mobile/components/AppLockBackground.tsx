import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors } from "../lib/colors";
import { useReducedMotion } from "../lib/reduced-motion";

// Soft edges are painted once. Only their native view transforms move, without
// recapturing a live blur or redrawing an SVG from JavaScript on every frame.
// Keep the pools inside the surface and smaller than it: an oversized radial
// painted mostly outside the card looks like a static tint even while moving.
const BLOOMS = [
  {
    name: "mint",
    color: "#31C997",
    cx: "24%",
    cy: "28%",
    rx: "36%",
    ry: "32%",
    opacity: 0.72,
    x: [-96, 96],
    y: [76, -76],
    scale: [1.02, 1.06],
  },
  {
    name: "blue",
    color: "#7AA8F5",
    cx: "78%",
    cy: "44%",
    rx: "34%",
    ry: "30%",
    opacity: 0.5,
    x: [80, -80],
    y: [-104, 104],
    scale: [1.05, 1],
  },
  {
    name: "warm",
    color: "#FFA864",
    cx: "74%",
    cy: "78%",
    rx: "42%",
    ry: "34%",
    opacity: 0.78,
    x: [104, -104],
    y: [-88, 88],
    scale: [1, 1.06],
  },
] as const;

/** A lock-only, slowly shifting pearl surface; text and controls stay put. */
export function AppLockBackground({ active }: { active: boolean }) {
  // The privacy gate sits outside SheetBlurProvider, so its OS preferences
  // cannot come from that provider's default context values.
  const reducedMotion = useReducedMotion();
  const [reducedTransparency, setReducedTransparency] = useState(false);
  const phase = useRef(new Animated.Value(0.5)).current;
  const supportsMotion =
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
    if (reducedMotion || reducedTransparency || !supportsMotion) {
      phase.setValue(0.5);
      return;
    }
    if (!active) return;
    const settings = {
      duration: 6_000,
      easing: Easing.inOut(Easing.sin),
      useNativeDriver: true,
      // An ambient loop must not hold up list rendering or navigation work.
      isInteraction: false,
    };
    let alive = true;
    let loop: Animated.CompositeAnimation | undefined;
    phase.stopAnimation((value) => {
      if (!alive) return;
      // An authentication prompt can pause close to an endpoint. Read the
      // native position and head toward the farther end, rather than spending
      // an entire new leg barely moving through its last fraction.
      const firstTarget = value >= 0.5 ? 0 : 1;
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(phase, { ...settings, toValue: firstTarget }),
          Animated.timing(phase, { ...settings, toValue: 1 - firstTarget }),
        ]),
        { iterations: -1, resetBeforeIteration: false },
      );
      loop.start();
    });
    // Preserve the native phase when authentication makes the app inactive.
    // A new sequence resumes from there, without snapping to the first frame.
    return () => {
      alive = false;
      loop?.stop();
    };
  }, [active, reducedMotion, reducedTransparency, supportsMotion, phase]);

  return (
    <Animated.View
      testID="app-lock-background"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.surface}
    >
      {!reducedTransparency
        ? BLOOMS.map((bloom) => (
            <Animated.View
              key={bloom.name}
              testID={`app-lock-glow-${bloom.name}`}
              style={[
                StyleSheet.absoluteFill,
                {
                  transform: [
                    { translateX: phase.interpolate({ inputRange: [0, 1], outputRange: bloom.x }) },
                    { translateY: phase.interpolate({ inputRange: [0, 1], outputRange: bloom.y }) },
                    { scale: phase.interpolate({ inputRange: [0, 1], outputRange: bloom.scale }) },
                  ],
                },
              ]}
            >
              <Svg width="100%" height="100%" viewBox="0 0 440 620" preserveAspectRatio="none">
                <Defs>
                  <RadialGradient
                    id={`lock-${bloom.name}`}
                    cx={bloom.cx}
                    cy={bloom.cy}
                    rx={bloom.rx}
                    ry={bloom.ry}
                  >
                    <Stop offset="0" stopColor={bloom.color} stopOpacity={bloom.opacity} />
                    <Stop
                      offset="0.46"
                      stopColor={bloom.color}
                      stopOpacity={bloom.opacity * 0.48}
                    />
                    <Stop offset="1" stopColor={bloom.color} stopOpacity="0" />
                  </RadialGradient>
                </Defs>
                <Rect width="440" height="620" fill={`url(#lock-${bloom.name})`} />
              </Svg>
            </Animated.View>
          ))
        : null}
      {/* Keep a luminous, readable center as the richer edge colors move. */}
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 440 620"
        preserveAspectRatio="none"
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <RadialGradient id="lock-pearl" cx="48%" cy="48%" rx="65%" ry="60%">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.86" />
            <Stop offset="0.4" stopColor="#FFFFFF" stopOpacity="0.58" />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect width="440" height="620" fill="url(#lock-pearl)" />
      </Svg>
      <View style={styles.highlight} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Larger than the full translation in either direction, including the pause
  // endpoints. The stationary card clips this layer, so no edges can show.
  surface: {
    position: "absolute",
    top: -112,
    right: -112,
    bottom: -112,
    left: -112,
    backgroundColor: colors.bgBalanceGlass,
  },
  highlight: {
    ...StyleSheet.absoluteFill,
    borderTopWidth: 1,
    borderTopColor: "#FFFFFFCC",
  },
});
