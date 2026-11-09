import { Ionicons } from "@expo/vector-icons";
import { useCallback, useRef } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { gutter, radius, space, TOUCH_MIN, typography } from "../lib/tokens";
import { useToast } from "./Toast";

export function SponsorButton({
  enabled,
  label,
  interactive = true,
}: {
  enabled: boolean;
  label: string;
  interactive?: boolean;
}) {
  const isRTL = useIsRTL();
  const toast = useToast();
  const router = useRouter();
  const opening = useRef(false);
  const focused = useRef(false);
  const canOpen = useRef(interactive);
  canOpen.current = interactive;
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      opening.current = false;
      return () => {
        focused.current = false;
      };
    }, []),
  );
  if (!enabled) return null;

  return (
    <Pressable
      testID="home-sponsor-button"
      accessibilityRole="button"
      accessibilityLabel={label || t("sponsorBanner.promote")}
      accessibilityHint={t("sponsorBanner.formHint")}
      disabled={!interactive}
      onPress={() => {
        if (opening.current || !focused.current || !canOpen.current) return;
        opening.current = true;
        try {
          router.push("/promote");
        } catch {
          opening.current = false;
          if (focused.current) toast.push(t("sponsorBanner.openFailed"), "error");
        }
      }}
      style={({ pressed }) => [styles.button, rowDir(isRTL), pressed && { opacity: 0.6 }]}
    >
      <Ionicons name="megaphone-outline" size={18} color={colors.textInverted} accessible={false} />
      <Text style={[styles.label, textDir(isRTL)]} numberOfLines={1}>
        {label || t("sponsorBanner.promote")}
      </Text>
      <Ionicons
        name={isRTL ? "chevron-back" : "chevron-forward"}
        size={14}
        color={colors.textInverted}
        accessible={false}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: gutter.ledger,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.actionPrimary,
    borderRadius: radius.md,
    backgroundColor: colors.actionPrimary,
  },
  label: { ...typography.bodySm, flex: 1, color: colors.textInverted },
});
