import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, View, type StyleProp, type ViewStyle } from "react-native";
import { useSheetMotionPreference } from "./SheetBackdrop";

/** Only search controls move: input identity and ledger rows stay untouched.
 * Fixed slots reserve Clear's space; collapsed slots grow with their row gap. */
export function SearchControlSlot({
  visible,
  width,
  height,
  collapse = false,
  gap = 0,
  isRTL = false,
  style,
  children,
}: {
  visible: boolean;
  width: number;
  height: number;
  collapse?: boolean;
  gap?: number;
  isRTL?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reducedMotion = useSheetMotionPreference();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    const next = visible ? 1 : 0;
    if (reducedMotion) {
      progress.setValue(next);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: next,
      duration: 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // Width, opacity and gap move as one local control.
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, reducedMotion, progress]);
  return (
    <Animated.View
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      style={[
        style,
        {
          width: collapse
            ? progress.interpolate({ inputRange: [0, 1], outputRange: [0, width + gap] })
            : width,
          height,
          flexShrink: 0,
          overflow: "hidden",
          opacity: progress,
          alignItems: isRTL ? "flex-start" : "flex-end",
        },
        // The surrounding row owns `gap`. Cancel it once, then reveal it as
        // part of the slot's width: an empty slot leaves no orphan gap.
        collapse ? (isRTL ? { marginRight: -gap } : { marginLeft: -gap }) : null,
      ]}
    >
      {visible ? <View style={{ width, height }}>{children}</View> : null}
    </Animated.View>
  );
}
