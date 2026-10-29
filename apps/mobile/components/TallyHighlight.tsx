import { useEffect, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import { colors } from "../lib/colors";
import { useSheetMotionPreference } from "./SheetBackdrop";

/** A brief, touch-through cue for a notification or a live review decision.
 *  A decision flashes in its outcome's colour (the review dots' green/red);
 *  the neutral grey alone was easy to miss (audit #13). */
export function TallyHighlight({
  requestKey,
  tone = "neutral",
}: {
  requestKey: string;
  tone?: "neutral" | "accepted" | "rejected";
}) {
  const reducedMotion = useSheetMotionPreference();
  const opacity = useRef(new Animated.Value(0)).current;
  const lifetime = useRef<{
    requestKey: string;
    tone: string;
    endsAt: number;
    finished: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const previous = lifetime.current;
    const current =
      previous?.requestKey === requestKey && previous.tone === tone
        ? previous
        : { requestKey, tone, endsAt: Date.now() + 1500, finished: false };
    lifetime.current = current;
    const remaining = Math.max(0, current.endsAt - Date.now());
    if (current.finished || remaining === 0) {
      current.finished = true;
      opacity.setValue(0);
      return;
    }
    let animation: Animated.CompositeAnimation | undefined;
    // Keep the outcome visible in reduced mode, with the original expiry even
    // when the shared motion preference changes while the cue is on screen.
    const timer = setTimeout(() => {
      if (cancelled) return;
      current.finished = true;
      animation?.stop();
      opacity.setValue(0);
    }, remaining);
    opacity.setValue(tone === "neutral" ? 0.4 : 0.22);
    if (!reducedMotion) {
      const delay = Math.min(300, remaining);
      animation = Animated.timing(opacity, {
        toValue: 0,
        duration: remaining - delay,
        delay,
        useNativeDriver: true,
      });
      animation.start();
    }
    return () => {
      cancelled = true;
      animation?.stop();
      clearTimeout(timer);
    };
  }, [opacity, requestKey, tone, reducedMotion]);
  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor:
            tone === "accepted"
              ? colors.reviewAccepted
              : tone === "rejected"
                ? colors.reviewRejected
                : colors.tallyHighlight,
          opacity,
        },
      ]}
    />
  );
}
