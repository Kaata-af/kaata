import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, StyleSheet } from "react-native";
import { colors } from "../lib/colors";

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
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let cancelled = false;
    let finished = false;
    let preferenceChanged = false;
    let endsAt = 0;
    let animation: Animated.CompositeAnimation | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (reduced: boolean) => {
      if (cancelled || finished) return;
      animation?.stop();
      // A preference change may stop the fade, but must neither replay an old
      // notification highlight nor extend this request's brief lifetime.
      if (timer == null) {
        endsAt = Date.now() + 1500;
        timer = setTimeout(() => {
          if (cancelled) return;
          finished = true;
          animation?.stop();
          opacity.setValue(0);
        }, 1500);
      }
      opacity.setValue(tone === "neutral" ? 0.4 : 0.22);
      if (!reduced) {
        const remaining = Math.max(0, endsAt - Date.now());
        const delay = Math.min(300, remaining);
        animation = Animated.timing(opacity, {
          toValue: 0,
          duration: remaining - delay,
          delay,
          useNativeDriver: true,
        });
        animation.start();
      }
    };
    opacity.setValue(0);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (reduced) => {
      preferenceChanged = true;
      show(reduced);
    });
    const initialPreference = (reduced: boolean) => {
      // The bridge query describes an earlier moment than a delivered event.
      if (!preferenceChanged) show(reduced);
    };
    void AccessibilityInfo.isReduceMotionEnabled().then(initialPreference, () =>
      initialPreference(true),
    );
    return () => {
      cancelled = true;
      subscription.remove();
      animation?.stop();
      if (timer) clearTimeout(timer);
    };
  }, [opacity, requestKey, tone]);
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
