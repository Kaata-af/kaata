import { useFocusEffect } from "expo-router";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Keyboard,
  Platform,
  StyleSheet,
  TurboModuleRegistry,
  View,
  type KeyboardMetrics,
  type ViewInstance,
  type ViewProps,
} from "react-native";
import { KeyboardProvider, useGenericKeyboardHandler } from "react-native-keyboard-controller";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

type Motion = { height: SharedValue<number>; progress: SharedValue<number> };
const MotionContext = createContext<Motion | null>(null);

function NativeKeyboardMotion({ children }: { children: ReactNode }) {
  const height = useSharedValue(0);
  const progress = useSharedValue(0);
  const update = (event: { height: number; progress: number }) => {
    "worklet";
    height.value = Math.max(0, event.height);
    progress.value = height.value === 0 ? 0 : Math.max(0, Math.min(1, event.progress));
  };
  useGenericKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        // Start contains the destination, not the current keyboard position.
        // Only an instantaneous transition can apply it without a visible jump.
        if (event.duration === 0) update(event);
      },
      onMove: update,
      onInteractive: update,
      onEnd: update,
    },
    [],
  );
  const motion = useMemo(() => ({ height, progress }), [height, progress]);
  return <MotionContext.Provider value={motion}>{children}</MotionContext.Provider>;
}

/** Android keeps its existing native window and keyboard handling. */
export function SearchKeyboardProvider({ children }: { children: ReactNode }) {
  if (Platform.OS !== "ios") return children;
  return (
    <KeyboardProvider preload={false}>
      <NativeKeyboardMotion>{children}</NativeKeyboardMotion>
    </KeyboardProvider>
  );
}

function useMotion() {
  const motion = useContext(MotionContext);
  if (!motion) throw new Error("Search keyboard motion requires SearchKeyboardProvider");
  return motion;
}

function NativeKeyboardFrame({ style, ...props }: ViewProps) {
  const { height } = useMotion();
  const keyboardStyle = useAnimatedStyle(() => ({ paddingBottom: height.value }));
  return <Reanimated.View {...props} style={[style, keyboardStyle]} />;
}

function AndroidKeyboardFrame({ style, onLayout, ...props }: ViewProps) {
  const frame = useRef<ViewInstance>(null);
  const focused = useRef(false);
  const measurement = useRef(0);
  const keyboard = useRef<KeyboardMetrics | undefined>(undefined);
  const [overlap, setOverlap] = useState(0);
  const basePadding = StyleSheet.flatten(style)?.paddingBottom;

  const measure = useCallback(() => {
    if (!focused.current) return;
    const request = ++measurement.current;
    const metrics = keyboard.current;
    if (
      !metrics ||
      !Number.isFinite(metrics.height) ||
      metrics.height <= 0 ||
      !Number.isFinite(metrics.screenY)
    ) {
      setOverlap(0);
      return;
    }
    frame.current?.measureInWindow((_x, y, _width, height) => {
      if (!focused.current || request !== measurement.current) return;
      if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return;
      // Native resize may already have made room. Avoid only the remaining
      // intersection, using window coordinates rather than a whole IME height.
      setOverlap(Math.max(0, Math.min(height, y + height - metrics.screenY)));
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      focused.current = true;
      keyboard.current = Keyboard.metrics() ?? undefined;
      const show = Keyboard.addListener("keyboardDidShow", (event) => {
        if (!active) return;
        keyboard.current = event.endCoordinates;
        measure();
      });
      const hide = Keyboard.addListener("keyboardDidHide", () => {
        if (!active) return;
        keyboard.current = undefined;
        measure();
      });
      measure();
      return () => {
        active = false;
        focused.current = false;
        measurement.current++;
        show.remove();
        hide.remove();
      };
    }, [measure]),
  );

  return (
    <View
      {...props}
      ref={frame}
      collapsable={false}
      style={[
        style,
        { paddingBottom: (typeof basePadding === "number" ? basePadding : 0) + overlap },
      ]}
      onLayout={(event) => {
        onLayout?.(event);
        measure();
      }}
    />
  );
}

type FrameProps = ViewProps & { avoidAndroidKeyboard?: boolean };

/** iOS follows native frames. Edge-to-edge Android screens avoid actual IME overlap. */
export function SearchKeyboardFrame({ avoidAndroidKeyboard = false, ...props }: FrameProps) {
  if (Platform.OS === "ios") return <NativeKeyboardFrame {...props} />;
  const edgeToEdge =
    Platform.OS === "android" &&
    TurboModuleRegistry.get<{
      getConstants(): { isEdgeToEdge?: boolean };
    }>("DeviceInfo")?.getConstants().isEdgeToEdge !== false;
  return avoidAndroidKeyboard && edgeToEdge ? (
    <AndroidKeyboardFrame {...props} />
  ) : (
    <View {...props} />
  );
}

type FooterProps = ViewProps & {
  closedPadding: number;
  openPadding: number;
  keyboardShown: boolean;
};

function NativeKeyboardFooter({
  closedPadding,
  openPadding,
  keyboardShown: _keyboardShown,
  style,
  ...props
}: FooterProps) {
  const { progress } = useMotion();
  const keyboardStyle = useAnimatedStyle(() => ({
    paddingBottom: closedPadding + (openPadding - closedPadding) * progress.value,
  }));
  return <Reanimated.View {...props} style={[style, keyboardStyle]} />;
}

export function SearchKeyboardFooter({
  closedPadding,
  openPadding,
  keyboardShown,
  style,
  ...props
}: FooterProps) {
  return Platform.OS === "ios" ? (
    <NativeKeyboardFooter
      {...props}
      closedPadding={closedPadding}
      openPadding={openPadding}
      keyboardShown={keyboardShown}
      style={style}
    />
  ) : (
    <View
      {...props}
      style={[style, { paddingBottom: keyboardShown ? openPadding : closedPadding }]}
    />
  );
}
