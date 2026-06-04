import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

// shadcn-style confirmation dialog. Left-aligned title + optional description,
// right-aligned footer with a ghost Cancel and a filled Confirm. Destructive
// variant paints the Confirm button red on a white card; the rest of the chrome
// stays calm.

export function ConfirmDialog(props: {
  visible: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const isRTL = useIsRTL();
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.96)).current;

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
        Animated.timing(scale, { toValue: 0.96, duration: 140, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  if (!rendered) return null;

  const confirmStyle = props.destructive ? styles.confirmDestructive : styles.confirmPrimary;
  const confirmTextStyle = props.destructive
    ? styles.confirmDestructiveText
    : styles.confirmPrimaryText;

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
          <View style={styles.body}>
            <Text style={[styles.title, textDir(isRTL)]}>{props.title}</Text>
            {props.description ? (
              <Text style={[styles.description, textDir(isRTL)]}>{props.description}</Text>
            ) : null}
          </View>

          <View style={[styles.footer, rowDir(isRTL)]}>
            <Pressable
              onPress={props.onCancel}
              style={({ pressed }) => [
                styles.btnGhost,
                pressed && { backgroundColor: colors.bgMuted },
              ]}
            >
              <Text style={styles.btnGhostText}>{props.cancelLabel ?? t("common.cancel")}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                props.onCancel();
                props.onConfirm();
              }}
              style={({ pressed }) => [confirmStyle, pressed && { opacity: 0.85 }]}
            >
              <Text style={confirmTextStyle}>{props.confirmLabel ?? "OK"}</Text>
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
    maxWidth: 380,
    backgroundColor: colors.bgDefault,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    overflow: "hidden",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 12 },
      },
      android: { elevation: 12 },
    }),
  },
  body: {
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 8,
  },
  title: {
    fontSize: 17,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    letterSpacing: -0.2,
  },
  description: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 16,
  },
  btnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  btnGhostText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textDefault,
  },
  confirmPrimary: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: colors.bgInverted,
  },
  confirmPrimaryText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
  },
  confirmDestructive: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: colors.danger,
  },
  confirmDestructiveText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: "#FFFFFF",
  },
});
