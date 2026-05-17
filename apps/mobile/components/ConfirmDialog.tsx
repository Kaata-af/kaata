import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";

export function ConfirmDialog(props: {
  visible: boolean;
  title: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.95)).current;

  useEffect(() => {
    if (props.visible) {
      setRendered(true);
      requestAnimationFrame(() => {
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 1,
            duration: 180,
            useNativeDriver: true,
          }),
          Animated.spring(scale, {
            toValue: 1,
            useNativeDriver: true,
            friction: 10,
            tension: 90,
          }),
        ]).start();
      });
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 140,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 0.95,
          duration: 140,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  if (!rendered) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={props.onCancel}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <BlurView
          intensity={20}
          tint="light"
          experimentalBlurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.tint} />
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onCancel} />
      </Animated.View>

      <View style={styles.center} pointerEvents="box-none">
        <Animated.View
          style={[styles.card, { opacity, transform: [{ scale }] }]}
          onStartShouldSetResponder={() => true}
        >
          <Text style={styles.title}>{props.title}</Text>
          <View style={styles.actions}>
            <Pressable
              onPress={props.onCancel}
              style={({ pressed }) => [
                styles.btn,
                pressed && { backgroundColor: colors.background },
              ]}
            >
              <Text style={styles.btnText}>{props.cancelLabel ?? "Cancel"}</Text>
            </Pressable>
            <View style={styles.vDivider} />
            <Pressable
              onPress={() => {
                props.onCancel();
                props.onConfirm();
              }}
              style={({ pressed }) => [
                styles.btn,
                pressed && { backgroundColor: colors.background },
              ]}
            >
              <Text
                style={[
                  styles.btnText,
                  { fontWeight: "600" },
                  props.destructive && { color: colors.debt },
                ]}
              >
                {props.confirmLabel ?? "OK"}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(245,245,245,0.1)" },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: 16,
    overflow: "hidden",
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.textPrimary,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 20,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  btn: { flex: 1, paddingVertical: 16, alignItems: "center" },
  btnText: { fontSize: 16, color: colors.textPrimary },
  vDivider: { width: StyleSheet.hairlineWidth, backgroundColor: colors.border },
});
