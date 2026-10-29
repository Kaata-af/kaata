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
  StatusBar,
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

export type AndroidKeyboardFrameProps = ViewProps & {
  /** Current-focus receipt after hidden state or a valid overlap measurement. */
  onKeyboardLayout?: (shown: boolean, overlap: number) => void;
};

export function AndroidKeyboardFrame({
  style,
  onLayout,
  onKeyboardLayout,
  ...props
}: AndroidKeyboardFrameProps) {
  const frame = useRef<ViewInstance>(null);
  const focused = useRef(false);
  const measurement = useRef(0);
  const keyboard = useRef<KeyboardMetrics | undefined>(undefined);
  const receipt = useRef(onKeyboardLayout);
  receipt.current = onKeyboardLayout;
  const [overlap, setOverlap] = useState(0);
  const basePadding = StyleSheet.flatten(style)?.paddingBottom;

  const measure = useCallback(() => {
    if (!focused.current) return;
    const request = ++measurement.current;
    const metrics = keyboard.current;
    if (!metrics || (Number.isFinite(metrics.height) && metrics.height <= 0)) {
      setOverlap(0);
      receipt.current?.(false, 0);
      return;
    }
    if (!Number.isFinite(metrics.height) || !Number.isFinite(metrics.screenY)) {
      setOverlap(0);
      return;
    }
    frame.current?.measureInWindow((_x, y, _width, height) => {
      if (!focused.current || request !== measurement.current) return;
      if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return;
      // RN removes status-bar/cutout insets from non-edge window measurements,
      // but keyboard screenY still uses screen coordinates. Restore that top
      // inset before comparing; it describes coordinates, not resize behavior.
      const nonEdgeToEdge =
        TurboModuleRegistry.get<{
          getConstants(): { isEdgeToEdge?: boolean };
        }>("DeviceInfo")?.getConstants().isEdgeToEdge === false;
      const topInset =
        nonEdgeToEdge &&
        typeof StatusBar.currentHeight === "number" &&
        Number.isFinite(StatusBar.currentHeight)
          ? Math.max(0, StatusBar.currentHeight)
          : 0;
      // A native resize or pan may already have made room. Only the actual
      // remaining intersection is ours to avoid, on every Android host.
      const next = Math.max(0, Math.min(height, y + topInset + height - metrics.screenY));
      setOverlap(next);
      receipt.current?.(true, next);
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

/** iOS follows native frames. Opt-in Android screens avoid actual IME overlap. */
export function SearchKeyboardFrame({ avoidAndroidKeyboard = false, ...props }: FrameProps) {
  if (Platform.OS === "ios") return <NativeKeyboardFrame {...props} />;
  return avoidAndroidKeyboard && Platform.OS === "android" ? (
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
