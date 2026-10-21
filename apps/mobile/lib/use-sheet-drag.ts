import { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Keyboard,
  PanResponder,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PanResponderGestureState,
  type ScrollView,
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
  const latest = useRef({ visible, onDismiss, reducedMotion });
  latest.current = { visible, onDismiss, reducedMotion };
  const mounted = useRef(false);
  const closing = useRef(!visible);
  const generation = useRef(0);
  const scrollOffset = useRef(0);
  const scrollView = useRef<ScrollView | null>(null);
  type Stroke = {
    stateID: number;
    generation: number;
    base: number;
    dy: number;
    ready: boolean;
    release?: { dy: number; vy: number };
  };
  const active = useRef<Stroke | null>(null);

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    active.current = null;
    closing.current = !visible;
    offset.stopAnimation();
    // Keep the released position while the overlay exits, so it doesn't jump
    // back to the top before closing. A reopened sheet starts cleanly.
    if (visible) offset.setValue(0);
    return () => {
      mounted.current = false;
      generation.current++;
      active.current = null;
      offset.stopAnimation();
    };
  }, [visible, offset]);

  const drag = useMemo(() => {
    const enabled = () => mounted.current && latest.current.visible && !closing.current;
    const currentGesture = (state: PanResponderGestureState) =>
      enabled() &&
      active.current?.generation === generation.current &&
      active.current?.stateID === state.stateID;
    const restore = () => {
      active.current = null;
      offset.stopAnimation();
      if (latest.current.reducedMotion) offset.setValue(0);
      else
        Animated.spring(offset, {
          toValue: 0,
          friction: 11,
          tension: 75,
          overshootClamping: true,
          useNativeDriver: true,
        }).start();
    };
    const dismiss = () => {
      if (!enabled()) return;
      closing.current = true;
      active.current = null;
      offset.stopAnimation();
      Keyboard.dismiss();
      latest.current.onDismiss();
    };
    const finish = (stroke: Stroke, end: { dy: number; vy: number }) => {
      if (!enabled() || active.current !== stroke || stroke.generation !== generation.current)
        return;
      const releasedOffset = Math.max(0, stroke.base + end.dy);
      offset.setValue(releasedOffset);
      if (
        releasedOffset >= CLOSE_DISTANCE ||
        (end.dy >= FLICK_DISTANCE && end.vy >= FLICK_VELOCITY)
      )
        dismiss();
      else restore();
    };
    let candidate: { stateID: number; generation: number } | null = null;
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
      if (claimed) candidate = { stateID: state.stateID, generation: generation.current };
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
        candidate = null;
        const stroke: Stroke = {
          stateID: state.stateID,
          generation: generation.current,
          base: 0,
          dy: 0,
          ready: false,
        };
        active.current = stroke;
        // Native spring values arrive asynchronously. Buffer this stroke until
        // its starting position is known; a rapid re-grab never snaps to zero.
        offset.stopAnimation((value) => {
          if (!enabled() || active.current !== stroke || stroke.generation !== generation.current)
            return;
          stroke.base = Math.max(0, value);
          stroke.ready = true;
          offset.setValue(Math.max(0, stroke.base + stroke.dy));
          if (stroke.release) finish(stroke, stroke.release);
        });
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
        stroke.dy = state.dy;
        if (stroke.ready) offset.setValue(Math.max(0, stroke.base + state.dy));
      },
      onPanResponderRelease: (_event: unknown, state: PanResponderGestureState) => {
        if (!currentGesture(state)) return;
        const stroke = active.current!;
        stroke.dy = state.dy;
        const end = { dy: state.dy, vy: state.vy };
        if (stroke.ready) finish(stroke, end);
        else stroke.release = end;
      },
      onPanResponderTerminate: (_event: unknown, state: PanResponderGestureState) => {
        if (currentGesture(state)) restore();
      },
      onPanResponderTerminationRequest: () => true,
    };
    const responder = PanResponder.create({
      ...callbacks,
      onStartShouldSetPanResponder: () => false,
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
        ref: (view: ScrollView | null) => {
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
