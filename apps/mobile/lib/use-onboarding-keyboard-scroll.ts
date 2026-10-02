import { useCallback, useEffect, useRef } from "react";
import { Keyboard, Platform, ScrollView, TextInput, type ScrollViewProps } from "react-native";

// Onboarding keeps its own safe-area/header outside the form. Measure both
// native views in window coordinates instead of assuming the scroll view starts
// at screen y=0. Keyboard avoidance alone never reveals the next focused field.
export function useOnboardingKeyboardScroll() {
  const scrollRef = useRef<ScrollView>(null);
  const focusedInput = useRef<TextInput | null>(null);
  const scrollY = useRef(0);
  const frame = useRef<number | null>(null);

  const revealFocusedInput = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const scroll = scrollRef.current;
      const input = focusedInput.current;
      if (!scroll || !input?.isFocused()) return;

      scroll.getNativeScrollRef()?.measureInWindow((_x, top, _width, height) => {
        input.measureInWindow((_inputX, inputTop, _inputWidth, inputHeight) => {
          // Native measurements are asynchronous; focus may have moved to
          // another field or into the country picker in the meantime.
          if (focusedInput.current !== input || !input.isFocused() || height <= 0) return;
          const keyboard = Keyboard.metrics();
          const bottom = Math.min(
            top + height,
            keyboard && keyboard.height > 0 ? keyboard.screenY : Number.POSITIVE_INFINITY,
          );
          if (bottom <= top) return;
          const upperEdge = top + 32; // Keep the field's label visible too.
          const lowerEdge = bottom - 24;
          let delta = 0;
          if (inputTop < upperEdge) delta = inputTop - upperEdge;
          else if (inputTop + inputHeight > lowerEdge) delta = inputTop + inputHeight - lowerEdge;
          if (Math.abs(delta) > 1) {
            scroll.scrollTo({ y: Math.max(0, scrollY.current + delta), animated: false });
          }
        });
      });
    });
  }, []);

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", revealFocusedInput);
    const changed =
      Platform.OS === "ios"
        ? Keyboard.addListener("keyboardDidChangeFrame", revealFocusedInput)
        : null;
    return () => {
      shown.remove();
      changed?.remove();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      focusedInput.current = null;
    };
  }, [revealFocusedInput]);

  const focusInput = useCallback(
    (input: TextInput | null) => {
      focusedInput.current = input;
      revealFocusedInput();
    },
    [revealFocusedInput],
  );

  const blurInput = useCallback((input: TextInput | null) => {
    if (focusedInput.current === input) focusedInput.current = null;
  }, []);

  const scrollProps = {
    ref: scrollRef,
    // iOS grows native scroll insets. Android draws edge-to-edge, where
    // adjustResize no longer shrinks the window, so the onboarding screens
    // wrap this ScrollView in a KeyboardAvoidingView ("height") enabled on
    // Android only. Never enable it on iOS: it would compensate twice.
    automaticallyAdjustKeyboardInsets: Platform.OS === "ios",
    contentInsetAdjustmentBehavior: "never",
    keyboardShouldPersistTaps: "handled",
    keyboardDismissMode: Platform.OS === "ios" ? "interactive" : "on-drag",
    scrollEventThrottle: 16,
    onScroll: (event) => {
      scrollY.current = event.nativeEvent.contentOffset.y;
    },
    // On Android keyboardDidShow can land before the KeyboardAvoidingView has
    // shrunk this viewport, when the scroll is still clamped; this re-reveal
    // on the new layout finishes it.
    onLayout: revealFocusedInput,
    onContentSizeChange: revealFocusedInput,
  } satisfies ScrollViewProps & { ref: typeof scrollRef };

  return { scrollProps, focusInput, blurInput };
}
