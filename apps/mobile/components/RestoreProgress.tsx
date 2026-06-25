// RestoreProgress — a real (not faked) progress bar for the cloud-restore
// loading state. It replaces the bare ActivityIndicator that the three restore
// surfaces used to show: the in-app restore screen (app/restore.tsx), the
// onboarding restore step (app/onboarding/restore.tsx), and the home sign-in
// overlay (app/index.tsx). The fraction is driven by recoverAllVaults's
// onProgress callback (lib/recovery.ts), so the bar tracks actual recovery
// stages — prepare → find vaults → restore kaata N of M → finish.
//
// Two modes:
//   - DETERMINATE (fraction is a number in [0,1]): an animated fill grows to
//     the fraction with a short ease, plus an optional rounded percent. The
//     fill width is a percentage-string interpolation, so it needs no layout
//     measurement and paints correctly on the very first frame.
//   - INDETERMINATE (fraction == null): a looping shimmer segment slides across
//     the track, for steps with no measurable progress (e.g. the Google
//     handshake before recovery starts). Uses a measured track width so the
//     transform is in points (RN transforms don't take percentages).
//
// Two tones so one component serves both the white restore screens and the
// inverted (dark) home overlay:
//   - "dark"  → dark fill on a light track (default; for white backgrounds).
//   - "light" → white fill on a translucent track (for the inverted overlay).
//
// Width/translate animate layout, so every Animated value here is JS-driven
// (useNativeDriver:false) — consistent with the rest of the app's layout
// animations (see the long note in app/index.tsx on the swipe rail).

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";

import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import type { RecoveryProgress } from "../lib/recovery";

const TRACK_HEIGHT = 6;
const TRACK_RADIUS = TRACK_HEIGHT / 2;
const FILL_TWEEN_MS = 260;
// Width of the sliding chip in the indeterminate mode, as a fraction of track.
const INDETERMINATE_SEGMENT = 0.4;
const INDETERMINATE_LOOP_MS = 1100;

export type RestoreProgressTone = "dark" | "light";

type Props = {
  /** Determinate fill in [0, 1]; null/undefined renders the indeterminate shimmer. */
  fraction?: number | null;
  /** Status line shown under the bar. */
  label: string;
  /** "dark" = dark UI on a light bg (default); "light" = light UI on the inverted overlay. */
  tone?: RestoreProgressTone;
  /** Content direction for the label + percent alignment. */
  isRTL?: boolean;
  /** Show the rounded percent above the bar (determinate only). Default true. */
  showPercent?: boolean;
};

type Palette = {
  track: string;
  fill: string;
  label: string;
  percent: string;
};

const PALETTES: Record<RestoreProgressTone, Palette> = {
  dark: {
    track: colors.bgSubtle,
    fill: colors.bgInverted,
    label: colors.textSubtle,
    percent: colors.textEmphasis,
  },
  light: {
    track: "rgba(255,255,255,0.18)",
    fill: colors.textInverted,
    label: "rgba(255,255,255,0.85)",
    percent: colors.textInverted,
  },
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Localized status line for a recovery progress event — shared by all three
 * restore surfaces so the copy stays consistent. Single-vault accounts read
 * better without the "1 of 1" count.
 */
export function restoreProgressLabel(p: RecoveryProgress): string {
  switch (p.phase) {
    case "preparing":
      return t("restoreProgress.preparing");
    case "listing":
      return t("restoreProgress.finding");
    case "restoring":
      return p.vaultTotal > 1
        ? t("restoreProgress.vault", { current: p.vaultIndex, total: p.vaultTotal })
        : t("restoreProgress.vaultOne");
    case "finalizing":
    case "done":
      return t("restoreProgress.finishing");
  }
}

export function RestoreProgress({
  fraction,
  label,
  tone = "dark",
  isRTL = false,
  showPercent = true,
}: Props) {
  const palette = PALETTES[tone];
  const determinate = typeof fraction === "number";
  const target = determinate ? clamp01(fraction as number) : 0;

  // Determinate fill: an Animated 0..1 that eases toward `target` on change.
  // Seeded from the first fraction so the bar paints at the right width
  // immediately rather than animating up from empty on mount.
  const fill = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    if (!determinate) return;
    Animated.timing(fill, {
      toValue: target,
      duration: FILL_TWEEN_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [determinate, target, fill]);

  // Indeterminate shimmer: a chip that slides across the measured track width.
  const [trackWidth, setTrackWidth] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (determinate || trackWidth === 0) return;
    slide.setValue(0);
    const loop = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: INDETERMINATE_LOOP_MS,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [determinate, trackWidth, slide]);

  const pct = Math.round(target * 100);
  const segmentWidth = Math.max(0, trackWidth * INDETERMINATE_SEGMENT);
  // The status text is centered under the bar (styles.percent/label set
  // textAlign:"center"), so we apply ONLY the bidi resolution here — NOT
  // textDir(), whose textAlign:"left"/"right" would override the centering.
  const bidi = { writingDirection: isRTL ? "rtl" : "ltr" } as const;

  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={determinate ? { min: 0, max: 100, now: pct } : undefined}
    >
      {determinate && showPercent ? (
        <Text style={[styles.percent, { color: palette.percent }, bidi]}>{pct}%</Text>
      ) : null}

      <View
        // In an RTL locale the fill should grow from the trailing (right) edge to
        // match the right-aligned text; mirror the whole track to flip it.
        style={[styles.track, { backgroundColor: palette.track }, isRTL && styles.mirror]}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
      >
        {determinate ? (
          <Animated.View
            style={[
              styles.fill,
              {
                backgroundColor: palette.fill,
                width: fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
              },
            ]}
          />
        ) : (
          <Animated.View
            style={[
              styles.fill,
              styles.segment,
              {
                backgroundColor: palette.fill,
                width: segmentWidth,
                transform: [
                  {
                    translateX: slide.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-segmentWidth, trackWidth],
                    }),
                  },
                ],
              },
            ]}
          />
        )}
      </View>

      <Text style={[styles.label, { color: palette.label }, bidi]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", maxWidth: 320, alignSelf: "center" },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_RADIUS,
    overflow: "hidden",
  },
  // RTL: flip the fill's growth direction (text right-aligns in fa).
  mirror: {
    transform: [{ scaleX: -1 }],
  },
  fill: {
    height: "100%",
    borderRadius: TRACK_RADIUS,
  },
  segment: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  percent: {
    fontSize: 13,
    fontFamily: fonts.monoMedium,
    marginBottom: 8,
    textAlign: "center",
  },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    marginTop: 12,
    lineHeight: 18,
    textAlign: "center",
  },
});
