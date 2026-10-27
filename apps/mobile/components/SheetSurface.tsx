import type { ComponentProps } from "react";
import {
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

type PaddingKey =
  | "padding"
  | "paddingHorizontal"
  | "paddingVertical"
  | "paddingTop"
  | "paddingRight"
  | "paddingBottom"
  | "paddingLeft";

// Sheet chrome uses concrete padding so its safe spacing is available before
// any native measurement, including the first frame of an entrance animation.
type SurfaceStyle = Omit<ViewStyle, PaddingKey> & Partial<Record<PaddingKey, number>>;
type SheetSurfaceProps = Omit<ComponentProps<typeof View>, "style"> & {
  style?: StyleProp<SurfaceStyle>;
  maxHeightRatio?: number;
};

/** Native SafeAreaView measures itself when a Modal separates it from the
 * native provider. A translated panel can then measure zero on first attach.
 * React context crosses that boundary: apply its live insets to a plain View
 * on iOS. Android keeps native insets relative to its separate dialog window. */
export function SheetSurface({ style, maxHeightRatio, ...props }: SheetSurfaceProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const padding = StyleSheet.flatten(style) ?? {};
  const surfaceStyle = [
    styles.surface,
    style,
    maxHeightRatio == null
      ? undefined
      : { maxHeight: Math.max(0, Math.min(height * maxHeightRatio, height - insets.top - 12)) },
  ];
  if (Platform.OS !== "ios") {
    return <SafeAreaView {...props} edges={["bottom"]} style={surfaceStyle} />;
  }
  return (
    <View
      {...props}
      style={[
        surfaceStyle,
        {
          paddingBottom:
            (padding.paddingBottom ?? padding.paddingVertical ?? padding.padding ?? 0) +
            insets.bottom,
          paddingLeft:
            (padding.paddingLeft ?? padding.paddingHorizontal ?? padding.padding ?? 0) +
            insets.left,
          paddingRight:
            (padding.paddingRight ?? padding.paddingHorizontal ?? padding.padding ?? 0) +
            insets.right,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({ surface: { flexShrink: 1, minHeight: 0 } });
