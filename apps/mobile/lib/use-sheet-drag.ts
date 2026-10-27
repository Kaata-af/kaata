import type { ScrollViewInstance } from "react-native";
import { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Keyboard,
  PanResponder,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PanResponderGestureState,
} from "react-native";
import { useSheetMotionPreference } from "../components/SheetBackdrop";

const CLOSE_DISTANCE = 72;
const FLICK_DISTANCE = 20;
const FLICK_VELOCITY = 0.65;
const SCROLL_TOP_SLOP = 1;

/** The handle and panel share dismissal motion. Content can pull the panel down
 * only from the top; a stroke begun in a scrolled list remains a scroll. A
 * separate offset leaves the existing modal exit/defer intact. */
export function useSheetDrag(visible: boolean, entrance: Animated.Value, onDismiss: () => void) {
  const reducedMotion = useSheetMotionPreference();
  const offset = useRef(new Animated.Value(0)).current;
  const offsetPosition = useRef(0);
  const restoring = useRef(false);
  const latest = useRef({ visible, onDismiss, reducedMotion });
  latest.current = { visible, onDismiss, reducedMotion };
  const mounted = useRef(false);
  const closing = useRef(!visible);
  const generation = useRef(0);
  const scrollOffset = useRef(0);
  const scrollView = useRef<ScrollViewInstance | null>(null);
  type Stroke = {
    stateID: number;
    generation: number;
    base: number;
    dragging: boolean;
  };
  const active = useRef<Stroke | null>(null);

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    active.current = null;
    closing.current = !visible;
    restoring.current = false;
    offset.stopAnimation();
    // Keep the released position while the overlay exits, so it doesn't jump
    // back to the top before closing. A reopened sheet starts cleanly.
    if (visible) {
      offsetPosition.current = 0;
      offset.setValue(0);
    }
    const presentation = generation.current;
    const listener = offset.addListener(({ value }) => {
      if (
        mounted.current &&
        generation.current === presentation &&
        restoring.current &&
        Number.isFinite(value)
      )
        offsetPosition.current = Math.max(0, value);
    });
    return () => {
      mounted.current = false;
      generation.current++;
      active.current = null;
      restoring.current = false;
      offset.removeListener(listener);
      offset.stopAnimation();
    };
  }, [visible, offset]);

  const drag = useMemo(() => {
    const enabled = () => mounted.current && latest.current.visible && !closing.current;
    const setOffset = (value: number) => {
      offsetPosition.current = value;
      offset.setValue(value);
    };
    const currentGesture = (state: PanResponderGestureState) =>
      enabled() &&
      active.current?.generation === generation.current &&
      active.current?.stateID === state.stateID;
    const restore = () => {
      active.current = null;
      restoring.current = false;
      offset.stopAnimation();
      if (latest.current.reducedMotion) setOffset(0);
      else {
        restoring.current = true;
        Animated.spring(offset, {
          toValue: 0,
          friction: 11,
          tension: 75,
          overshootClamping: true,
          useNativeDriver: true,
        }).start();
      }
    };
    const dismiss = () => {
      if (!enabled()) return;
      closing.current = true;
      active.current = null;
      restoring.current = false;
      offset.stopAnimation();
      Keyboard.dismiss();
      latest.current.onDismiss();
    };
    const finish = (stroke: Stroke, end: { dy: number; vy: number }) => {
      if (!enabled() || active.current !== stroke || stroke.generation !== generation.current)
        return;
      const releasedOffset = Math.max(0, stroke.base + end.dy);
      setOffset(releasedOffset);
      if (
        releasedOffset >= CLOSE_DISTANCE ||
        (end.dy >= FLICK_DISTANCE && end.vy >= FLICK_VELOCITY)
      )
        dismiss();
      else restore();
    };
    let candidate: { stateID: number; generation: number; dragging: boolean } | null = null;
    let surfaceStart: {
      stateID: number;
      generation: number;
      inScroll: boolean;
      atTop: boolean;
      blocked: boolean;
    } | null = null;
    const shouldDrag = (_event: unknown, state: PanResponderGestureState) => {
      const claimed =
        enabled() &&
        state.numberActiveTouches === 1 &&
        state.dy > 6 &&
        state.dy > Math.abs(state.dx) * 1.2;
      if (claimed)
        candidate = { stateID: state.stateID, generation: generation.current, dragging: true };
      return claimed;
    };
    const callbacks = {
      onPanResponderGrant: (_event: unknown, state: PanResponderGestureState) => {
        if (
          !enabled() ||
          candidate?.stateID !== state.stateID ||
          candidate.generation !== generation.current
        )
          return;
        const stroke: Stroke = {
          stateID: state.stateID,
          generation: generation.current,
          base: offsetPosition.current,
          dragging: candidate.dragging,
        };
        candidate = null;
        active.current = stroke;
        // Native getValue callbacks can be absent on Android. Track the spring
        // with its listener so a new drag never waits for that round trip.
        restoring.current = false;
        offset.stopAnimation();
        setOffset(stroke.base);
        Keyboard.dismiss();
      },
      onPanResponderStart: (_event: unknown, state: PanResponderGestureState) => {
        if (currentGesture(state) && state.numberActiveTouches > 1) restore();
      },
      onPanResponderMove: (_event: unknown, state: PanResponderGestureState) => {
        if (!currentGesture(state)) return;
        if (state.numberActiveTouches > 1) {
          restore();
          return;
        }
        const stroke = active.current!;
        if (!stroke.dragging) {
          if (!(state.dy > 6 && state.dy > Math.abs(state.dx) * 1.2)) return;
          stroke.dragging = true;
        }
        setOffset(Math.max(0, stroke.base + state.dy));
      },
      onPanResponderRelease: (_event: unknown, state: PanResponderGestureState) => {
        if (!currentGesture(state)) return;
        const stroke = active.current!;
        if (stroke.dragging) finish(stroke, { dy: state.dy, vy: state.vy });
        else restore();
      },
      onPanResponderTerminate: (_event: unknown, state: PanResponderGestureState) => {
        if (currentGesture(state)) restore();
      },
      onPanResponderTerminationRequest: () => true,
    };
    const responder = PanResponder.create({
      ...callbacks,
      // Plain Android header views need an initial responder to keep receiving
      // moves. Bubble phase leaves child Pressables (including Close) first.
      onStartShouldSetPanResponder: (_event, state) => {
        if (!enabled() || state.numberActiveTouches !== 1) return false;
        candidate = { stateID: state.stateID, generation: generation.current, dragging: false };
        return true;
      },
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: shouldDrag,
      onMoveShouldSetPanResponderCapture: shouldDrag,
    });
    const shouldDragSurface = (event: unknown, state: PanResponderGestureState) =>
      surfaceStart?.stateID === state.stateID &&
      surfaceStart.generation === generation.current &&
      !surfaceStart.blocked &&
      (!surfaceStart.inScroll || (surfaceStart.atTop && scrollOffset.current <= SCROLL_TOP_SLOP)) &&
      shouldDrag(event, state);
    const surface = PanResponder.create({
      ...callbacks,
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: (_event, state) => {
        surfaceStart =
          enabled() && state.numberActiveTouches === 1
            ? {
                stateID: state.stateID,
                generation: generation.current,
                inScroll: false,
                atTop: scrollOffset.current <= SCROLL_TOP_SLOP,
                blocked: false,
              }
            : null;
        return false;
      },
      onMoveShouldSetPanResponder: shouldDragSurface,
      onMoveShouldSetPanResponderCapture: shouldDragSurface,
    });
    return {
      panHandlers: responder.panHandlers,
      surfacePanHandlers: surface.panHandlers,
      controlProps: {
        // Native wheels own vertical movement too. Their touch start bubbles
        // before the scroll container's, which must preserve this exclusion.
        onTouchStart: () => {
          if (surfaceStart?.generation === generation.current) surfaceStart.blocked = true;
        },
      },
      scrollProps: {
        ref: (view: ScrollViewInstance | null) => {
          // A newly mounted list starts at zero; a rapid reopen keeps the
          // actual position of its still-mounted list.
          if (scrollView.current !== view) {
            scrollView.current = view;
            scrollOffset.current = 0;
          }
        },
        onTouchStart: () => {
          if (surfaceStart?.generation === generation.current) surfaceStart.inScroll = true;
        },
        onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          const y = event.nativeEvent.contentOffset.y;
          if (enabled() && Number.isFinite(y)) scrollOffset.current = Math.max(0, y);
        },
        scrollEventThrottle: 16,
      },
      dismiss,
    };
  }, [offset]);
  const translateY = useMemo(() => Animated.add(entrance, offset), [entrance, offset]);
  return { ...drag, translateY };
}
