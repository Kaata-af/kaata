import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { CustomerBalanceFilter } from "../lib/customer-list";

/** Only wraps customer content: the balance summary retains its own horizontal
 * currency scrolling, and the existing parent still owns vertical scrolling. */
export function HomeBalanceFilterSwipe(props: {
  enabled: boolean;
  contextKey: string;
  direction: CustomerBalanceFilter;
  onDirectionChange: (direction: CustomerBalanceFilter) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const mounted = useRef(true);
  const latest = useRef({ ...props, width, epoch: 0 });
  const previous = latest.current;
  const epoch =
    previous.enabled !== props.enabled ||
    previous.contextKey !== props.contextKey ||
    previous.direction !== props.direction ||
    previous.width !== width
      ? previous.epoch + 1
      : previous.epoch;
  latest.current = { ...props, width, epoch };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latest.current.epoch++;
    };
  }, []);
  const pan = useMemo(() => {
    let began: number | null = null;
    const current = () =>
      mounted.current &&
      props.enabled &&
      latest.current.enabled &&
      latest.current.epoch === epoch &&
      latest.current.contextKey === props.contextKey &&
      latest.current.direction === props.direction &&
      latest.current.width === width;
    return Gesture.Pan()
      .enabled(props.enabled)
      .activeOffsetX([-24, 24])
      .failOffsetY([-16, 16])
      .runOnJS(true)
      .onBegin(() => {
        began = current() ? epoch : null;
      })
      .onEnd((event, success) => {
        const started = began;
        began = null;
        if (success === false || started !== epoch || !current()) return;
        const { translationX: x, translationY: y, velocityX: velocity } = event;
        if (
          !Number.isFinite(width) ||
          width <= 0 ||
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(velocity) ||
          Math.abs(x) < 24 ||
          Math.abs(x) <= Math.abs(y)
        )
          return;
        const flick = Math.sign(velocity) === Math.sign(x) && Math.abs(velocity) >= 500;
        if (Math.abs(x) < width * 0.3 && !flick) return;
        // Physical directions stay identical in every app language.
        const side = x < 0 ? "pay" : "collect";
        latest.current.onDirectionChange(props.direction === side ? "all" : side);
      })
      .onFinalize(() => {
        began = null;
      });
  }, [props.enabled, props.contextKey, props.direction, width, epoch]);
  return (
    <GestureDetector gesture={pan}>
      <View
        testID={props.testID ?? "home-balance-filter-swipe"}
        collapsable={false}
        style={[styles.content, props.style]}
      >
        {props.children}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({ content: { flexGrow: 1, minHeight: 0 } });
