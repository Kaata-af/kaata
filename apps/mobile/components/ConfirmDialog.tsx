import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";

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
          Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
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
        Animated.timing(opacity, { toValue: 0, duration: 140, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.95, duration: 140, useNativeDriver: true }),
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
              style={({ pressed }) => [styles.btn, pressed && { backgroundColor: colors.bgMuted }]}
            >
              <Text style={styles.btnText}>{props.cancelLabel ?? "Cancel"}</Text>
            </Pressable>
            <View style={styles.vDivider} />
            <Pressable
              onPress={() => {
                props.onCancel();
                props.onConfirm();
              }}
              style={({ pressed }) => [styles.btn, pressed && { backgroundColor: colors.bgMuted }]}
            >
              <Text
                style={[
                  styles.btnText,
                  { fontFamily: fonts.sansSemi },
                  props.destructive && { color: colors.danger },
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
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.08)" },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: colors.bgDefault,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    overflow: "hidden",
  },
  title: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 18,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  btn: { flex: 1, paddingVertical: 14, alignItems: "center" },
  btnText: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textEmphasis },
  vDivider: { width: 1, backgroundColor: colors.borderDefault },
});
