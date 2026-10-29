import type { ViewInstance } from "react-native";
import { BlurTargetView, BlurView } from "expo-blur";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type RefObject,
} from "react";
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View } from "react-native";
import { SHEET_BLUR_METHOD } from "../lib/blur";
import { t } from "../lib/i18n";
import { useReducedMotion } from "../lib/reduced-motion";

type BackdropContext = {
  target: RefObject<ViewInstance | null> | undefined;
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
  const target = useRef<ViewInstance | null>(null);
  const [targetReady, setTargetReady] = useState(false);
  const reducedMotion = useReducedMotion();
  const [reducedTransparency, setReducedTransparency] = useState(false);
  const context = useMemo(
    () => ({ target: targetReady ? target : undefined, reducedMotion, reducedTransparency }),
    [targetReady, reducedMotion, reducedTransparency],
  );
  useEffect(() => {
    // Descendant Modal lifecycle methods can run before the ancestor target's
    // ref attaches. Mount Android BlurViews only after that first commit.
    setTargetReady(true);
    let alive = true;
    let transparencyChanged = false;
    if (Platform.OS !== "ios")
      return () => {
        alive = false;
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
      transparency.remove();
    };
  }, []);
  return (
    <Context.Provider value={context}>
      <BlurTargetView ref={target} collapsable={false} style={{ flex: 1 }}>
        {children}
      </BlurTargetView>
    </Context.Provider>
  );
}

export const useSheetMotionPreference = () => useContext(Context).reducedMotion;
export const useSheetTransparencyPreference = () => useContext(Context).reducedTransparency;

/** The tint is always present: older Android and transparency preferences keep
 * a readable dim backdrop without changing sheet layout or hit testing. */
export function SheetBackdrop({
  onDismiss,
  blurTarget,
  disabled = false,
}: {
  onDismiss: () => void;
  /** A sibling target for overlays that live inside the app's root target. */
  blurTarget?: RefObject<ViewInstance | null>;
  disabled?: boolean;
}) {
  const { target: globalTarget, reducedTransparency, reducedMotion } = useContext(Context);
  // A supplied but unattached local target must not fall back to an ancestor
  // that also contains this overlay and would capture the blur itself.
  const target = blurTarget ?? globalTarget;
  const supportsBlur =
    !reducedTransparency &&
    !reducedMotion &&
    (Platform.OS !== "android" || (Number(Platform.Version) >= 31 && !!target?.current));
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
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        accessibilityState={{ disabled }}
      />
    </View>
  );
}
