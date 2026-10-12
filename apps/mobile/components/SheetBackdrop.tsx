import { BlurTargetView, BlurView } from "expo-blur";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type RefObject,
} from "react";
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View } from "react-native";
import { SHEET_BLUR_METHOD } from "../lib/blur";
import { t } from "../lib/i18n";

type BackdropContext = {
  target: RefObject<View | null> | undefined;
  reducedMotion: boolean;
  reducedTransparency: boolean;
};
const Context = createContext<BackdropContext>({
  target: undefined,
  reducedMotion: false,
  reducedTransparency: false,
});

/** One native target for all overlays, mounted before any sheet. Native
 * Modal hosts are separate from this view, so the blur never captures itself. */
export function SheetBlurProvider({ children }: PropsWithChildren) {
  const target = useRef<View | null>(null);
  const [targetReady, setTargetReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [reducedTransparency, setReducedTransparency] = useState(false);
  useEffect(() => {
    // Descendant Modal lifecycle methods can run before the ancestor target's
    // ref attaches. Mount Android BlurViews only after that first commit.
    setTargetReady(true);
    let alive = true;
    let motionChanged = false;
    let transparencyChanged = false;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive && !motionChanged) setReducedMotion(value);
      })
      .catch(() => undefined);
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      motionChanged = true;
      setReducedMotion(value);
    });
    if (Platform.OS !== "ios")
      return () => {
        alive = false;
        motion.remove();
      };
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (alive && !transparencyChanged) setReducedTransparency(value);
      })
      .catch(() => undefined);
    const transparency = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (value) => {
        transparencyChanged = true;
        setReducedTransparency(value);
      },
    );
    return () => {
      alive = false;
      motion.remove();
      transparency.remove();
    };
  }, []);
  return (
    <Context.Provider
      value={{ target: targetReady ? target : undefined, reducedMotion, reducedTransparency }}
    >
      <BlurTargetView ref={target} collapsable={false} style={{ flex: 1 }}>
        {children}
      </BlurTargetView>
    </Context.Provider>
  );
}

export const useSheetMotionPreference = () => useContext(Context).reducedMotion;

/** The tint is always present: older Android and transparency preferences keep
 * a readable dim backdrop without changing sheet layout or hit testing. */
export function SheetBackdrop({ onDismiss }: { onDismiss: () => void }) {
  const { target, reducedTransparency } = useContext(Context);
  const supportsBlur =
    !reducedTransparency &&
    (Platform.OS !== "android" || (Number(Platform.Version) >= 31 && !!target));
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {supportsBlur ? (
          <BlurView
            intensity={20}
            tint="light"
            blurTarget={target}
            blurMethod={SHEET_BLUR_METHOD}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        ) : null}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: supportsBlur ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.24)" },
          ]}
        />
      </View>
      {/* The tap-outside target is a labelled button for screen readers: short
          menus and pickers have no close control of their own, and hiding it
          left VoiceOver and TalkBack users no way out (audit #28). */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
      />
    </View>
  );
}
