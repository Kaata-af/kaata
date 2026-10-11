import { useEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import { useSheetMotionPreference } from "../components/SheetBackdrop";

/** Cancel every scheduled frame and stale close callback when an overlay is
 * reopened or unmounted. Reduced Motion presents/dismisses without movement. */
export function useOverlayAnimation(visible: boolean, from = 600, scale = false) {
  const reducedMotion = useSheetMotionPreference();
  const [rendered, setRendered] = useState(visible);
  const opacity = useRef(new Animated.Value(0)).current;
  const position = useRef(new Animated.Value(from)).current;
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    let frame: number | undefined;
    let animation: Animated.CompositeAnimation | undefined;
    opacity.stopAnimation();
    position.stopAnimation();
    if (reducedMotion) {
      opacity.setValue(visible ? 1 : 0);
      position.setValue(visible ? (scale ? 1 : 0) : from);
      setRendered(visible);
    } else if (visible) {
      setRendered(true);
      frame = requestAnimationFrame(() => {
        if (request !== generation.current) return;
        animation = Animated.parallel([
          Animated.timing(opacity, {
            toValue: 1,
            duration: scale ? 180 : 220,
            useNativeDriver: true,
          }),
          Animated.spring(position, {
            toValue: scale ? 1 : 0,
            useNativeDriver: true,
            friction: 11,
            tension: 75,
          }),
        ]);
        animation.start();
      });
    } else {
      animation = Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: scale ? 140 : 160,
          useNativeDriver: true,
        }),
        Animated.timing(position, {
          toValue: from,
          duration: scale ? 140 : 180,
          useNativeDriver: true,
        }),
      ]);
      animation.start(({ finished }) => {
        if (finished && request === generation.current) setRendered(false);
      });
    }
    return () => {
      generation.current++;
      if (frame !== undefined) cancelAnimationFrame(frame);
      animation?.stop();
    };
  }, [visible, reducedMotion, opacity, position, from, scale]);
  return { rendered, opacity, position };
}
