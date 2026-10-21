import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import type { Direction } from "./types";

/** One page, with a small native slide before replacing its contents. */
export function useHomePageTransition(
  direction: Direction,
  enabled: boolean,
  resetKey: string,
  isCurrent: () => boolean,
) {
  const [renderedDirection, setRenderedDirection] = useState(direction);
  const [switching, setSwitching] = useState(false);
  const translateX = useRef(new Animated.Value(0)).current;
  const target = useRef(direction);
  target.current = direction;
  const latestResetKey = useRef(resetKey);
  latestResetKey.current = resetKey;
  const generation = useRef(0);
  const previousResetKey = useRef(resetKey);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const incoming = useRef<{ generation: number; offset: number } | null>(null);

  const stop = useCallback(() => {
    generation.current++;
    incoming.current = null;
    animation.current?.stop();
    animation.current = null;
    translateX.setValue(0);
  }, [translateX]);
  const cancel = useCallback(() => {
    stop();
    setRenderedDirection(target.current);
    setSwitching(false);
  }, [stop]);

  useEffect(() => {
    const reset = previousResetKey.current !== resetKey;
    previousResetKey.current = resetKey;
    stop();
    if (!enabled || reset || renderedDirection === direction) {
      setRenderedDirection(direction);
      setSwitching(false);
      return stop;
    }
    setSwitching(true);
    const request = generation.current;
    const offset = direction === "pay" ? -24 : 24;
    const exit = Animated.timing(translateX, {
      toValue: offset,
      duration: 100,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.current = exit;
    exit.start(({ finished }) => {
      if (
        !finished ||
        generation.current !== request ||
        target.current !== direction ||
        latestResetKey.current !== resetKey ||
        !isCurrent()
      )
        return;
      // The old page is still largely visible if rendering takes a moment;
      // there is no full-width offscreen state or hidden initial page.
      incoming.current = { generation: request, offset };
      setRenderedDirection(direction);
    });
    return stop;
    // renderedDirection changes only after the exit, not a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, enabled, resetKey, stop, translateX]);

  useLayoutEffect(() => {
    const pending = incoming.current;
    if (
      pending === null ||
      pending.generation !== generation.current ||
      !enabled ||
      renderedDirection !== direction ||
      previousResetKey.current !== resetKey ||
      !isCurrent()
    )
      return;
    incoming.current = null;
    // Position the destination after its React commit, so a slow render
    // cannot move the old page to the incoming edge.
    translateX.setValue(-pending.offset);
    const enter = Animated.timing(translateX, {
      toValue: 0,
      duration: 160,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.current = enter;
    enter.start(() => {
      if (
        generation.current !== pending.generation ||
        target.current !== renderedDirection ||
        latestResetKey.current !== resetKey ||
        !isCurrent()
      )
        return;
      translateX.setValue(0);
      animation.current = null;
      setSwitching(false);
    });
  }, [renderedDirection, translateX]);

  return { renderedDirection, switching, translateX, cancel };
}
