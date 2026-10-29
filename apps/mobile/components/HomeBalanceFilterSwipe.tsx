import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  StyleSheet,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector, type GestureType } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { CustomerBalanceFilter } from "../lib/customer-list";
import { useSheetMotionPreference } from "./SheetBackdrop";

/** Only the customer content moves. The summary keeps its independent currency
 * scroller, while the parent's native gesture continues to own vertical scroll. */
export function HomeBalanceFilterSwipe(props: {
  enabled: boolean;
  contextKey: string;
  currencyKey?: string;
  direction: CustomerBalanceFilter;
  onDirectionChange: (direction: CustomerBalanceFilter) => void;
  nativeGesture?: GestureType;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const reducedMotion = useSheetMotionPreference();
  const currencyKey = props.currencyKey ?? "[]";
  const mounted = useRef(true);
  const latest = useRef({ ...props, currencyKey, width, reducedMotion, epoch: 0 });
  const previous = latest.current;
  const epoch =
    previous.enabled !== props.enabled ||
    previous.contextKey !== props.contextKey ||
    previous.currencyKey !== currencyKey ||
    previous.direction !== props.direction ||
    previous.nativeGesture !== props.nativeGesture ||
    previous.reducedMotion !== reducedMotion ||
    previous.width !== width
      ? previous.epoch + 1
      : previous.epoch;
  latest.current = { ...props, currencyKey, width, reducedMotion, epoch };
  const offset = useSharedValue(0);
  const lease = useSharedValue({ epoch, enabled: props.enabled, width, reducedMotion });
  const stroke = useSharedValue({
    epoch: -1,
    id: 0,
    x: 0,
    y: 0,
    startedAt: 0,
    active: false,
    moving: false,
    blocked: true,
    commitRequested: false,
  });
  const accepted = useRef<{ epoch: number; id: number } | null>(null);
  const incoming = useRef<{
    epoch: number;
    id: number;
    contextKey: string;
    target: CustomerBalanceFilter;
    sign: number;
    width: number;
    nativeGesture: GestureType | undefined;
    reducedMotion: boolean;
  } | null>(null);
  const fallbackFrame = useRef<number | null>(null);

  const complete = useCallback(
    (request: number, id: number, target: CustomerBalanceFilter, sign: number) => {
      const current = latest.current;
      const liveStroke = stroke.value;
      if (
        !mounted.current ||
        !current.enabled ||
        current.epoch !== request ||
        liveStroke.epoch !== request ||
        liveStroke.id !== id ||
        !liveStroke.commitRequested ||
        (accepted.current?.epoch === request && accepted.current.id === id)
      )
        return;
      accepted.current = { epoch: request, id };
      const pending = {
        epoch: request,
        id,
        contextKey: current.contextKey,
        target,
        sign,
        width: current.width,
        nativeGesture: current.nativeGesture,
        reducedMotion: current.reducedMotion,
      };
      incoming.current = pending;
      current.onDirectionChange(target);
      // A repeated-side swipe or rejected parent request may not render a new
      // direction. One bounded fallback cannot leave that content displaced.
      if (incoming.current === pending) {
        fallbackFrame.current = requestAnimationFrame(() => {
          fallbackFrame.current = null;
          if (!mounted.current || incoming.current !== pending) return;
          incoming.current = null;
          const live = stroke.value;
          if (
            latest.current.epoch !== request ||
            live.epoch !== request ||
            live.id !== id ||
            !live.commitRequested
          )
            return;
          cancelAnimation(offset);
          offset.value = latest.current.reducedMotion
            ? 0
            : withTiming(0, {
                duration: 160,
                reduceMotion: ReduceMotion.System,
              });
        });
      }
    },
    [offset, stroke],
  );

  useLayoutEffect(() => {
    lease.value = { epoch, enabled: props.enabled, width, reducedMotion };
    cancelAnimation(offset);
    const pending = incoming.current;
    incoming.current = null;
    if (fallbackFrame.current !== null) cancelAnimationFrame(fallbackFrame.current);
    fallbackFrame.current = null;
    const entering =
      pending &&
      pending.epoch + 1 === epoch &&
      pending.contextKey === props.contextKey &&
      pending.target === props.direction &&
      currencyKey === "[]" &&
      props.enabled &&
      pending.width === width &&
      pending.nativeGesture === props.nativeGesture &&
      pending.reducedMotion === reducedMotion &&
      stroke.value.epoch === pending.epoch &&
      stroke.value.id === pending.id &&
      stroke.value.commitRequested;
    offset.value = entering && !reducedMotion ? -pending.sign * 24 : 0;
    if (entering && !reducedMotion) {
      offset.value = withTiming(0, { duration: 160, reduceMotion: ReduceMotion.System });
    }
  }, [
    epoch,
    props.enabled,
    props.contextKey,
    props.direction,
    currencyKey,
    width,
    reducedMotion,
    lease,
    offset,
    stroke,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      incoming.current = null;
      if (fallbackFrame.current !== null) cancelAnimationFrame(fallbackFrame.current);
      fallbackFrame.current = null;
      lease.value = { ...lease.value, enabled: false, epoch: -1 };
      stroke.value = {
        ...stroke.value,
        epoch: -1,
        id: stroke.value.id + 1,
        active: false,
        blocked: true,
        commitRequested: false,
      };
      cancelAnimation(offset);
      offset.value = 0;
    };
  }, [lease, offset, stroke]);

  const pan = useMemo(() => {
    const settle = () => {
      "worklet";
      cancelAnimation(offset);
      offset.value = lease.value.reducedMotion
        ? 0
        : withTiming(0, {
            duration: 120,
            reduceMotion: ReduceMotion.System,
          });
    };
    const gesture = Gesture.Pan()
      .enabled(props.enabled)
      .maxPointers(1)
      .activeOffsetX([-24, 24])
      .failOffsetY([-16, 16])
      .onBegin((event) => {
        "worklet";
        const owner = lease.value;
        if (owner.epoch !== epoch || !owner.enabled) return;
        cancelAnimation(offset);
        offset.value = 0;
        stroke.value = {
          epoch,
          id: stroke.value.id + 1,
          x: event.absoluteX,
          y: event.absoluteY,
          startedAt: performance.now(),
          active: false,
          moving: false,
          blocked: !Number.isFinite(event.absoluteX) || !Number.isFinite(event.absoluteY),
          commitRequested: false,
        };
      })
      .onTouchesMove((event, manager) => {
        "worklet";
        const current = stroke.value;
        if (current.epoch !== epoch || lease.value.epoch !== epoch) return;
        // A stationary hold belongs to row actions. A deliberately slow stroke
        // may take longer to cross the native activation slop.
        if (
          event.numberOfTouches !== 1 ||
          current.blocked ||
          (!current.active && !current.moving && performance.now() - current.startedAt >= 350)
        ) {
          stroke.value = { ...current, blocked: true };
          settle();
          manager.fail();
          return;
        }
        const touch = event.allTouches[0];
        if (!current.moving && touch) {
          const x = touch.absoluteX - current.x;
          const y = touch.absoluteY - current.y;
          if (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            Math.abs(x) >= 6 &&
            Math.abs(y) <= 16 &&
            Math.abs(x) >= Math.abs(y) * 2
          ) {
            stroke.value = { ...current, moving: true };
          }
        }
      })
      .onStart((event) => {
        "worklet";
        const current = stroke.value;
        if (current.epoch !== epoch || lease.value.epoch !== epoch) return;
        const x = event.absoluteX - current.x;
        const y = event.absoluteY - current.y;
        stroke.value = {
          ...current,
          active: true,
          blocked:
            current.blocked ||
            (!current.moving && performance.now() - current.startedAt >= 350) ||
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            Math.abs(x) < 24 ||
            Math.abs(y) > 16 ||
            (!current.moving && Math.abs(x) < Math.abs(y) * 2),
        };
      })
      .onUpdate((event) => {
        "worklet";
        const current = stroke.value;
        const owner = lease.value;
        if (current.epoch !== epoch || owner.epoch !== epoch) return;
        if (current.blocked || !current.active || current.commitRequested || !owner.enabled) return;
        if (owner.reducedMotion) {
          offset.value = 0;
          return;
        }
        const x = event.absoluteX - current.x;
        // Native activation has already chosen this horizontal drag. Finger
        // drift while holding must not jump the content back to zero. Release
        // still checks distance before applying a filter; the axis stays locked.
        if (Number.isFinite(x)) offset.value = Math.max(-96, Math.min(96, x * 0.65));
      })
      .onEnd((event, success) => {
        "worklet";
        const current = stroke.value;
        const owner = lease.value;
        if (current.epoch !== epoch || owner.epoch !== epoch || current.commitRequested) return;
        stroke.value = { ...current, active: false, blocked: true };
        // Absolute coordinates retain the whole DOWN-to-UP distance on Android,
        // where native translation may restart when the Pan activates.
        const x = event.absoluteX - current.x;
        const y = event.absoluteY - current.y;
        const velocity = event.velocityX;
        const flick = Number.isFinite(velocity) && Math.abs(velocity) >= 450 && x * velocity > 0;
        if (
          !success ||
          current.blocked ||
          !current.active ||
          !owner.enabled ||
          event.numberOfPointers > 1 ||
          !Number.isFinite(owner.width) ||
          owner.width <= 0 ||
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          Math.abs(x) < 24 ||
          (Math.abs(x) < 32 && !flick)
        ) {
          settle();
          return;
        }
        const sign = x < 0 ? -1 : 1;
        const target = x < 0 ? "pay" : "collect";
        stroke.value = { ...current, active: false, blocked: true, commitRequested: true };
        cancelAnimation(offset);
        if (owner.reducedMotion) {
          offset.value = 0;
          scheduleOnRN(complete, epoch, current.id, target, sign);
          return;
        }
        offset.value = withTiming(
          sign * 96,
          { duration: 80, reduceMotion: ReduceMotion.System },
          (finished) => {
            const live = stroke.value;
            if (
              !finished ||
              !lease.value.enabled ||
              lease.value.epoch !== epoch ||
              live.epoch !== epoch ||
              live.id !== current.id ||
              !live.commitRequested
            )
              return;
            scheduleOnRN(complete, epoch, current.id, target, sign);
          },
        );
      })
      .onFinalize(() => {
        "worklet";
        const current = stroke.value;
        if (current.epoch !== epoch || lease.value.epoch !== epoch) return;
        // onEnd already settles rejected releases. Finalization only needs to
        // return an active drag that the native recognizer cancelled instead.
        if (current.active && !current.commitRequested) settle();
        stroke.value = { ...current, active: false, blocked: true };
      });
    return props.nativeGesture
      ? gesture.simultaneousWithExternalGesture(props.nativeGesture)
      : gesture;
  }, [props.enabled, props.nativeGesture, epoch, lease, stroke, offset, complete]);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        testID={props.testID ?? "home-balance-filter-swipe"}
        collapsable={false}
        onLayout={props.onLayout}
        style={[styles.content, props.style, animatedStyle]}
      >
        {props.children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({ content: { flexGrow: 1, minHeight: 0 } });
