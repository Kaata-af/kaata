import { useEffect, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import { colors } from "../lib/colors";

/** A brief, touch-through cue after a notification opens a particular tally. */
export function TallyHighlight({ requestKey }: { requestKey: string }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    opacity.setValue(0.4);
    const animation = Animated.timing(opacity, {
      toValue: 0,
      duration: 1200,
      delay: 300,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity, requestKey]);
  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.tallyHighlight, opacity }]}
    />
  );
}
