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

// In-app toast notifications. Used for the small confirmations that don't
// deserve a full Alert dialog ("Entry saved") and for inline errors that the
// user shouldn't have to dismiss ("Phone already used by Ahmad").
//
// Rendered through React Native's <Modal> so toasts sit above the rest of the
// app — including modally-presented screens (entry/new, person/new, etc.) so
// errors inside those modals are still visible.

type ToastKind = "success" | "error" | "info";

type Toast = {
  id: string;
  message: string;
  kind: ToastKind;
};

type ToastContextValue = {
  push: (message: string, kind?: ToastKind) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);
const DURATION_MS = 2500;
const ANIM_MS = 220;

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
    <ToastContext.Provider value={{ push }}>
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

function ToastViewport({ toasts }: { toasts: Toast[] }) {
  const insets = useSafeAreaInsets();
  if (toasts.length === 0) return null;
  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      // No dismiss handler — the user shouldn't be able to "back" out of a
      // toast layer. Auto-dismiss after DURATION_MS is the only exit.
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

function ToastItem({ toast }: { toast: Toast }) {
  const translateY = useRef(new Animated.Value(40)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: ANIM_MS,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: ANIM_MS,
        useNativeDriver: true,
      }),
    ]).start();
  }, [translateY, opacity]);

  const containerStyle =
    toast.kind === "error" ? styles.error : toast.kind === "success" ? styles.success : styles.info;
  const textStyle = toast.kind === "error" ? styles.errorText : styles.invertedText;

  return (
    <Animated.View style={[styles.toast, containerStyle, { transform: [{ translateY }], opacity }]}>
      <Text style={textStyle} numberOfLines={2}>
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
    gap: 8,
  },
  toast: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
      },
      android: { elevation: 6 },
    }),
  },
  success: {
    backgroundColor: colors.bgInverted,
    borderColor: colors.bgInverted,
  },
  error: {
    backgroundColor: "#FEF2F2",
    borderColor: "#FECACA",
  },
  info: {
    backgroundColor: colors.bgDefault,
    borderColor: colors.borderEmphasis,
  },
  invertedText: {
    color: colors.textInverted,
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    lineHeight: 20,
  },
  errorText: {
    color: "#7F1D1D",
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    lineHeight: 20,
  },
});
