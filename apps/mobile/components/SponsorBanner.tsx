import { Ionicons } from "@expo/vector-icons";
import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Image, Linking, Pressable, StyleSheet, Text } from "react-native";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { openSupportWhatsApp } from "../lib/support";
import { gutter, radius, space, TOUCH_MIN, typography } from "../lib/tokens";
import { useToast } from "./Toast";

export function SponsorBanner() {
  const { sponsorBanner } = useAppMeta();
  const isRTL = useIsRTL();
  const toast = useToast();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const opening = useRef(false);
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );
  const imageUrl = sponsorBanner?.image_url;
  const link = sponsorBanner?.cta_url;
  const interactive = !sponsorBanner || Boolean(link);
  const label = sponsorBanner
    ? `${t("sponsorBanner.sponsored")} · ${sponsorBanner.sponsor} · ${sponsorBanner.title}`
    : t("sponsorBanner.promote");

  return (
    <Pressable
      testID="home-sponsor-banner"
      disabled={!interactive}
      accessibilityRole={interactive ? "link" : "text"}
      accessibilityLabel={label}
      accessibilityHint={
        sponsorBanner ? (sponsorBanner.cta_label ?? undefined) : t("sponsorBanner.whatsappHint")
      }
      onPress={async () => {
        if (opening.current || !focused.current) return;
        opening.current = true;
        try {
          if (sponsorBanner && link) {
            await Linking.openURL(link);
          } else if (!sponsorBanner) {
            const result = await openSupportWhatsApp(
              t("sponsorBanner.inquiry"),
              () => focused.current,
            );
            if (result === "failed" && focused.current) {
              toast.push(t("sponsorBanner.whatsappFailed"), "error");
            }
          }
        } catch {
          if (focused.current) toast.push(t("sponsorBanner.openFailed"), "error");
        } finally {
          opening.current = false;
        }
      }}
      style={({ pressed }) => [
        styles.banner,
        rowDir(isRTL),
        pressed && interactive && { opacity: 0.6 },
      ]}
    >
      {imageUrl && imageUrl !== failedImage ? (
        <Image
          key={imageUrl}
          source={{ uri: imageUrl }}
          style={styles.artwork}
          onError={() => setFailedImage(imageUrl)}
          accessible={false}
        />
      ) : (
        <Ionicons
          name={sponsorBanner ? "megaphone-outline" : "logo-whatsapp"}
          size={18}
          color={colors.textSubtle}
          accessible={false}
        />
      )}
      <Text style={[styles.label, textDir(isRTL)]} numberOfLines={1}>
        {label}
      </Text>
      {interactive ? (
        <Ionicons
          name={isRTL ? "chevron-back" : "chevron-forward"}
          size={14}
          color={colors.textSubtle}
          accessible={false}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: gutter.ledger,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    backgroundColor: colors.bgMuted,
  },
  artwork: {
    width: 24,
    height: 24,
    borderRadius: radius.grabber,
    backgroundColor: colors.bgSubtle,
  },
  label: { ...typography.bodySm, flex: 1, color: colors.textSubtle },
});
