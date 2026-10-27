import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Platform, View, type ViewProps } from "react-native";
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

/** UI-thread layout follows actual keyboard frames, with no second animation. */
export function SearchKeyboardFrame(props: ViewProps) {
  return Platform.OS === "ios" ? <NativeKeyboardFrame {...props} /> : <View {...props} />;
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
