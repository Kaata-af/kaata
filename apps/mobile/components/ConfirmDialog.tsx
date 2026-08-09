import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { SHEET_BLUR_METHOD } from "../lib/blur";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";

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
  // Phase 4.1: optional third action. When present, appears between Cancel
  // and Confirm in the footer. Used by the "different account on this
  // phone?" prompt to surface a destructive "wipe & start fresh" option
  // alongside the primary "keep my data" action.
  tertiaryLabel?: string;
  tertiaryDestructive?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onTertiary?: () => void;
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
          blurMethod={SHEET_BLUR_METHOD}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.tint} />
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={props.onCancel}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </Animated.View>

      <View style={styles.center} pointerEvents="box-none">
        <Animated.View
          style={[styles.card, { opacity, transform: [{ scale }] }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.body}>
            <Text style={[styles.title, textDir(isRTL), trackingSafe(isRTL)]}>{props.title}</Text>
            {props.description ? (
              <Text style={[styles.description, textDir(isRTL)]}>{props.description}</Text>
            ) : null}
          </View>

          <View style={[styles.footer, rowDir(isRTL)]}>
            <Pressable
              onPress={props.onCancel}
              accessibilityRole="button"
              accessibilityLabel={props.cancelLabel ?? t("common.cancel")}
              style={({ pressed }) => [
                styles.btnGhost,
                pressed && { backgroundColor: colors.bgMuted },
              ]}
            >
              <Text style={styles.btnGhostText}>{props.cancelLabel ?? t("common.cancel")}</Text>
            </Pressable>
            {props.onTertiary && props.tertiaryLabel ? (
              <Pressable
                onPress={() => {
                  props.onTertiary?.();
                }}
                accessibilityRole="button"
                accessibilityLabel={props.tertiaryLabel}
                style={({ pressed }) => [
                  props.tertiaryDestructive ? styles.confirmDestructive : styles.confirmPrimary,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text
                  style={
                    props.tertiaryDestructive
                      ? styles.confirmDestructiveText
                      : styles.confirmPrimaryText
                  }
                >
                  {props.tertiaryLabel}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                props.onConfirm();
              }}
              accessibilityRole="button"
              accessibilityLabel={props.confirmLabel ?? "OK"}
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
  tint: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.08)" },
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: colors.bgDefault,
    // Floating inset surface, not a screen-anchored sheet → radius.lg (16),
    // the same value this card already carried.
    borderRadius: radius.lg,
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
  // 17 → title (16). Same step the in-screen ScreenHeader title uses, so the
  // dialog's headline and the header it interrupts now read at one size. The
  // existing -0.2 tracking survives untouched (it is cancelled for Persian by
  // the trackingSafe() already applied at the JSX).
  title: {
    ...typography.title,
    color: colors.textEmphasis,
    letterSpacing: -0.2,
  },
  // Was 13 / sansRegular / sansLineHeight(13, 19) written out by hand — which
  // is bodySm exactly. Same pixels, one fewer place that has to remember to
  // route its line height.
  description: {
    ...typography.bodySm,
    marginTop: 8,
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
  // 9 + 9 padding around a 14px label computed to ~40 — the whole app's
  // destructive flows (archive, delete, sign out, wipe) funnel through this
  // one button pair, so it was the most-tapped sub-44 target we had. The
  // padding stays as designed; minHeight only raises the floor and the
  // content re-centers inside it.
  btnGhost: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  btnGhostText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textDefault,
  },
  confirmPrimary: {
    minHeight: TOUCH_MIN, // see btnGhost — same 40 → 44 floor, kept in step
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.bgInverted,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmPrimaryText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
  },
  confirmDestructive: {
    minHeight: TOUCH_MIN, // see btnGhost — same 40 → 44 floor, kept in step
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmDestructiveText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted, // was "#FFFFFF" — identical value, now the token
  },
});
