import { Ionicons } from "@expo/vector-icons";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, Animated, Platform, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";

// In-app toasts. Calm white card with a single colored icon for state — the
// rest of the chrome stays monochrome, matching the wider kaata design
// vocabulary.
//
// Rendered as a regular absolute-positioned View at the root of the app
// (not inside a <Modal>) so taps on the rest of the UI still go through.
// `pointerEvents="box-none"` on the wrapper lets touches outside the toast
// items fall through to whatever is behind. Trade-off: toasts won't render
// above natively-presented stack modals (entry/new, person/new) — errors
// fired from those screens are queued and shown when the user returns to
// the parent. For now we accept this; if it becomes a problem, the affected
// in-modal forms can surface validation inline next to the offending field.

type ToastKind = "success" | "error" | "info";

type Toast = {
  id: string;
  message: string;
  kind: ToastKind;
};

// Cross-screen pending-toast queue. Used by call sites that fire
// router.replace("/") right after a success — the navigation happens
// before the toast viewport renders the push, so the toast never
// appears. queuePendingToast() stores the message in module memory; the
// ToastProvider drains the queue on mount AND whenever a new toast is
// pushed (so the next mount on the destination screen surfaces it).
//
// In-memory only — survives a synchronous router.replace but not a
// process restart. That's the right scope: a queued success message
// from an archive flow doesn't need to survive a force-quit.
type PendingToast = { message: string; kind: ToastKind };
const pendingToasts: PendingToast[] = [];
const pendingListeners = new Set<() => void>();

export function queuePendingToast(message: string, kind: ToastKind = "info"): void {
  pendingToasts.push({ message, kind });
  for (const fn of pendingListeners) {
    try {
      fn();
    } catch {
      /* */
    }
  }
}

function drainPendingToasts(): PendingToast[] {
  const drained = pendingToasts.splice(0, pendingToasts.length);
  return drained;
}

type ToastContextValue = {
  push: (message: string, kind?: ToastKind) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

// Visible-count channel for useToastOffset — a module-level subscription
// (same pattern as pendingToasts above), NOT context state. The old
// `{ push, visibleCount }` context value was a fresh object whose count
// changed on every toast push AND auto-expire, so every useToast()/
// useToastOffset() consumer — including home with its two full people
// lists — did a complete re-render twice per toast. The offset is an
// Animated.Value driven imperatively, so subscribers need zero re-renders.
let currentVisibleCount = 0;
const visibleCountListeners = new Set<(count: number) => void>();

function publishVisibleCount(count: number): void {
  if (count === currentVisibleCount) return;
  currentVisibleCount = count;
  for (const fn of visibleCountListeners) {
    try {
      fn(count);
    } catch {
      /* */
    }
  }
}
const DURATION_MS = 2500;
const ANIM_MS = 240;
// Swipe-to-dismiss thresholds. Either condition triggers commit on release:
//   - drag distance ≥ 80px (about a quarter of a typical phone width)
//   - velocity ≥ 600 px/s (a clear flick, in either direction)
// Below both → spring back to zero translation.
const SWIPE_DISMISS_DISTANCE = 80;
const SWIPE_DISMISS_VELOCITY = 600;
const SWIPE_DISMISS_TRAVEL = 400; // px the toast slides off-screen on commit
const SWIPE_DISMISS_DURATION = 180;
// Geometry for useToastOffset() — see notes in the hook for the derivation.
const VIEWPORT_BOTTOM_MARGIN = 24; // matches the viewport's `bottom: 24 + insets.bottom`
const TOAST_HEIGHT_SINGLE = 52; // single-line: 14 + 22 + 14 + (1+1) border
// Distance from the safe-area bottom to the *visible* bottom edge of the lifted
// UI. Ping bar uses paddingBottom = 20 + insets.bottom; FAB uses
// bottom = 20 + insets.bottom. Both anchor at the same 20px offset, so a single
// constant works for both.
const BUTTON_OFFSET_ABOVE_SAFE_AREA = 20;
const LIFT_GAP = 16; // breathing room between toast top and lifted UI bottom
// iOS line-box growth of the toast message text: styles.message is
// fontSize 14 / tight 19, floored to 22 on iOS by sansLineHeight (0 on
// Android). The lift math below was sized so a TWO-line toast sat exactly
// flush against the lifted UI; a 2-line toast grows by 2× this delta on
// iOS, so the delta must ride the lift or the toast overlaps the FAB /
// ping bar by that much. (Single-line height is icon-dominated at 22px —
// TOAST_HEIGHT_SINGLE is unaffected on both platforms.)
const TOAST_TEXT_LINE_DELTA = sansLineHeight(14, 19) - 19;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Removal helper used by both the auto-dismiss timer and the user's swipe.
  // Calls to remove an already-gone id are a no-op (idempotent filter), so a
  // swipe-then-timer or timer-then-swipe race never causes a crash.
  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((prev) => [...prev, { id, message, kind }]);
      // M39: toasts are the app's ONLY transient-feedback channel (Alert is
      // banned), but accessibilityLiveRegion is Android-only and role="alert"
      // does not announce on iOS VoiceOver — so announce explicitly here so
      // screen-reader users (who can't see a "saved"/"failed" toast) hear it.
      AccessibilityInfo.announceForAccessibility(message);
      setTimeout(() => remove(id), DURATION_MS);
    },
    [remove],
  );

  // Cross-screen pending-toast drain. When a caller fires
  // queuePendingToast() right before navigating, the queue holds the
  // message until the next ToastProvider mount (or, if the provider is
  // already mounted, until the listener fires inside the same JS tick).
  // This is how vault-settings' "Kaata archived" toast survives
  // router.replace("/") to home.
  useEffect(() => {
    const drain = () => {
      const items = drainPendingToasts();
      for (const item of items) push(item.message, item.kind);
    };
    drain();
    pendingListeners.add(drain);
    return () => {
      pendingListeners.delete(drain);
    };
  }, [push]);

  // Feed the offset subscription (see publishVisibleCount above).
  useEffect(() => {
    publishVisibleCount(toasts.length);
  }, [toasts.length]);

  // Stable context value — `push` is a stable useCallback, so consumers
  // (every screen calling useToast()) never re-render from toast lifecycle.
  const ctxValue = useRef<ToastContextValue>({ push }).current;

  return (
    <ToastContext.Provider value={ctxValue}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={remove} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

// Returns an animated translateY value that components with bottom-anchored
// UI can apply to their transform — slides up when a toast appears, settles
// back when the queue is empty. Spring physics keep the motion alive.
//
// Math (insets-bottom cancels out — see below):
//   - Toast viewport's bottom edge sits at (24 + insets.bottom) above the screen.
//   - Single-line toast is 52px tall → toast TOP at (76 + insets.bottom) above the screen.
//   - The consuming UI's visible bottom sits at (12 + insets.bottom) above the
//     screen (ping bar paddingBottom; the FAB's similar). Same insets term.
//   - For the lifted bottom to clear the toast top by GAP, we need translateY
//     such that:
//         (12 + insets.bottom) + lift  =  (76 + insets.bottom) + GAP
//     → lift = 64 + GAP. The insets.bottom on each side cancels.
// This is the bug we had before: an extra insets.bottom term that snuck in
// added 24-34px of phantom gap depending on device.
// The 2×TOAST_TEXT_LINE_DELTA term budgets the iOS line-box growth of a
// TWO-line toast (see the constant's comment); it is 0 on Android, so the
// tuned Android geometry is untouched.
const BASE_LIFT =
  VIEWPORT_BOTTOM_MARGIN +
  TOAST_HEIGHT_SINGLE -
  BUTTON_OFFSET_ABOVE_SAFE_AREA +
  2 * TOAST_TEXT_LINE_DELTA;

export function useToastOffset(): Animated.Value {
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const lift = BASE_LIFT + LIFT_GAP; // constant — no insets dependence
    let animation: Animated.CompositeAnimation | null = null;
    // Dampened spring: higher friction prevents overshoot/oscillation that
    // previously left the button hanging mid-screen when rapid toast pushes
    // interrupted the animation mid-flight. We explicitly stop the in-flight
    // animation before a new one starts, otherwise the native-driver
    // animation can run concurrently with its successor and the value can
    // settle anywhere along the path.
    const apply = (count: number) => {
      animation?.stop();
      animation = Animated.spring(translateY, {
        toValue: count > 0 ? -lift : 0,
        useNativeDriver: true,
        friction: 14, // was 10 — kill the overshoot
        tension: 110,
      });
      animation.start();
    };
    // Catch up if a toast is already visible when this consumer mounts.
    if (currentVisibleCount > 0) apply(currentVisibleCount);
    visibleCountListeners.add(apply);
    return () => {
      visibleCountListeners.delete(apply);
      animation?.stop();
    };
  }, [translateY]);

  return translateY;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  if (toasts.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={[styles.viewport, { bottom: 24 + insets.bottom }]}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

const ICON_FOR_KIND = {
  success: "checkmark-circle" as const,
  error: "close-circle" as const,
  info: "information-circle" as const,
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const isRTL = useIsRTL();
  const translateY = useRef(new Animated.Value(40)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        friction: 10,
        tension: 120,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: ANIM_MS,
        useNativeDriver: true,
      }),
    ]).start();
  }, [translateY, opacity]);

  // Horizontal swipe-to-dismiss. Follow the finger via translateX.setValue
  // during the drag (matches the home-rail pattern), commit on release if
  // distance OR velocity crosses the threshold, otherwise spring back. The
  // commit animation fades opacity and slides off-screen in parallel; on
  // completion, we call onDismiss(id) which removes the toast from the
  // queue. The 2.5s auto-dismiss timer keeps running independently — its
  // call to remove(id) is a no-op if we beat it to it.
  const pan = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .onUpdate((e) => {
      translateX.setValue(e.translationX);
    })
    .onEnd((e) => {
      const shouldDismiss =
        Math.abs(e.translationX) > SWIPE_DISMISS_DISTANCE ||
        Math.abs(e.velocityX) > SWIPE_DISMISS_VELOCITY;
      if (shouldDismiss) {
        const direction =
          e.translationX === 0 ? Math.sign(e.velocityX) || 1 : Math.sign(e.translationX);
        Animated.parallel([
          Animated.timing(translateX, {
            toValue: direction * SWIPE_DISMISS_TRAVEL,
            duration: SWIPE_DISMISS_DURATION,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0,
            duration: SWIPE_DISMISS_DURATION,
            useNativeDriver: true,
          }),
        ]).start(() => onDismiss(toast.id));
      } else {
        Animated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          friction: 9,
          tension: 110,
        }).start();
      }
    });

  const iconColor =
    toast.kind === "error"
      ? colors.danger
      : toast.kind === "success"
        ? colors.textEmphasis
        : colors.textSubtle;

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        // Toasts are the app's ONLY feedback channel (Alert is banned), and
        // they auto-dismiss in 2.5s — without a live region TalkBack users
        // get zero confirmation for any action they take.
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={[
          styles.toast,
          rowDir(isRTL),
          { transform: [{ translateX }, { translateY }], opacity },
        ]}
      >
        <Ionicons name={ICON_FOR_KIND[toast.kind]} size={22} color={iconColor} />
        <Text style={[styles.message, textDir(isRTL)]} numberOfLines={2}>
          {toast.message}
        </Text>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  viewport: {
    position: "absolute",
    left: 16,
    right: 16,
    gap: 10,
    zIndex: 100,
    elevation: 100,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.22,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 14 },
      },
      android: { elevation: 10 },
    }),
  },
  message: {
    flex: 1,
    color: colors.textEmphasis,
    fontFamily: fonts.sansSemi,
    fontSize: 14,
    lineHeight: sansLineHeight(14, 19),
    letterSpacing: -0.1,
  },
});
