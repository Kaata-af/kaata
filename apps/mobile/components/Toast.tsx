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
import { Animated, Modal, Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";

// In-app toasts. Calm white card with a single colored icon for state — the
// rest of the chrome stays monochrome, matching the wider kaata design
// vocabulary. Renders through React Native's <Modal> so toasts sit above
// modally-presented screens (entry/new, person/new, etc.) and errors inside
// those modals stay visible.

type ToastKind = "success" | "error" | "info";

type Toast = {
  id: string;
  message: string;
  kind: ToastKind;
};

type ToastContextValue = {
  push: (message: string, kind?: ToastKind) => void;
  // Number of currently-visible toasts. Components with bottom-anchored UI
  // (ping bar, FAB) subscribe via useToastOffset() and slide out of the way.
  visibleCount: number;
};

const ToastContext = createContext<ToastContextValue | null>(null);
const DURATION_MS = 2500;
const ANIM_MS = 240;
// Geometry for useToastOffset() — see notes in the hook for the derivation.
const VIEWPORT_BOTTOM_MARGIN = 24; // matches the viewport's `bottom: 24 + insets.bottom`
const TOAST_HEIGHT_SINGLE = 52; // single-line: 14 + 22 + 14 + (1+1) border
const LIFT_GAP = 8; // breathing room between toast top and lifted UI bottom

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, DURATION_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ push, visibleCount: toasts.length }}>
      {children}
      <ToastViewport toasts={toasts} />
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
// Math:
//   - Toast viewport sits at bottom = (24 + insets.bottom) from the screen bottom.
//   - A single-line toast is ~52px tall, so its TOP edge is at
//     (24 + insets.bottom + 52) = (76 + insets.bottom) from the screen bottom.
//   - For a lifted UI to clear it with a comfortable gap, its lifted bottom edge
//     must sit at (76 + insets.bottom + GAP).
//   - Lifted UI's original bottom is 0, so translateY needs magnitude
//     (76 + insets.bottom + GAP).
// Insets-aware (~24-34px on phones with gesture nav / home indicator) so the
// gap survives the device-to-device variance.
export function useToastOffset(): Animated.Value {
  const ctx = useContext(ToastContext);
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(0)).current;
  const visibleCount = ctx?.visibleCount ?? 0;
  const lift = VIEWPORT_BOTTOM_MARGIN + TOAST_HEIGHT_SINGLE + LIFT_GAP + insets.bottom;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue: visibleCount > 0 ? -lift : 0,
      useNativeDriver: true,
      friction: 10,
      tension: 100,
    }).start();
  }, [visibleCount, lift, translateY]);

  return translateY;
}

function ToastViewport({ toasts }: { toasts: Toast[] }) {
  const insets = useSafeAreaInsets();
  if (toasts.length === 0) return null;
  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => undefined}
    >
      <View pointerEvents="box-none" style={[styles.viewport, { bottom: 24 + insets.bottom }]}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </View>
    </Modal>
  );
}

const ICON_FOR_KIND = {
  success: "checkmark-circle" as const,
  error: "close-circle" as const,
  info: "information-circle" as const,
};

function ToastItem({ toast }: { toast: Toast }) {
  const translateY = useRef(new Animated.Value(40)).current;
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

  const iconColor =
    toast.kind === "error"
      ? colors.danger
      : toast.kind === "success"
        ? colors.textEmphasis
        : colors.textSubtle;

  return (
    <Animated.View style={[styles.toast, { transform: [{ translateY }], opacity }]}>
      <Ionicons name={ICON_FOR_KIND[toast.kind]} size={22} color={iconColor} />
      <Text style={styles.message} numberOfLines={2}>
        {toast.message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    position: "absolute",
    left: 16,
    right: 16,
    gap: 10,
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
    lineHeight: 19,
    letterSpacing: -0.1,
  },
});
