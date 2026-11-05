import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { gutter, radius, space, TOUCH_MIN, typography } from "../lib/tokens";
import { useToast } from "./Toast";

const showPreview = __DEV__ && process.env.EXPO_PUBLIC_SPONSOR_PREVIEW === "1";

export function SponsorBanner() {
  const { sponsorBanner } = useAppMeta();
  const isRTL = useIsRTL();
  const toast = useToast();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const creative = showPreview
    ? {
        sponsor: t("sponsorBanner.sampleSponsor"),
        title: t("sponsorBanner.sampleTitle"),
        body: t("sponsorBanner.sampleBody"),
        image_url: null,
        cta_label: t("sponsorBanner.sampleCta"),
        cta_url: null,
      }
    : sponsorBanner;
  if (!creative) return null;

  const imageUrl = creative.image_url;
  const link = creative.cta_url;
  const label = showPreview ? t("sponsorBanner.sampleAd") : t("sponsorBanner.sponsored");

  return (
    <View style={[styles.banner, rowDir(isRTL)]} testID="home-sponsor-banner">
      <View style={styles.artwork} accessibilityElementsHidden importantForAccessibility="no">
        {imageUrl && imageUrl !== failedImage ? (
          <Image
            key={imageUrl}
            source={{ uri: imageUrl }}
            style={styles.image}
            onError={() => setFailedImage(imageUrl)}
          />
        ) : (
          <Ionicons name="cube-outline" size={24} color={colors.textSubtle} />
        )}
      </View>
      <View style={styles.copy}>
        <Text style={[styles.disclosure, textDir(isRTL)]} numberOfLines={1}>
          {label} · {creative.sponsor}
        </Text>
        <Text style={[styles.title, textDir(isRTL)]} numberOfLines={2}>
          {creative.title}
        </Text>
        <Text style={[styles.body, textDir(isRTL)]} numberOfLines={2}>
          {creative.body}
        </Text>
        {creative.cta_label && (link || showPreview) ? (
          <Pressable
            accessibilityRole={link ? "link" : "button"}
            accessibilityLabel={creative.cta_label}
            onPress={() => {
              if (showPreview) {
                toast.push(t("sponsorBanner.previewOnly"));
              } else if (link) {
                Linking.openURL(link).catch(() =>
                  toast.push(t("sponsorBanner.openFailed"), "error"),
                );
              }
            }}
            style={({ pressed }) => [
              styles.cta,
              rowDir(isRTL),
              { alignSelf: isRTL ? "flex-end" : "flex-start" },
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={[styles.ctaText, textDir(isRTL)]}>{creative.cta_label}</Text>
            <Ionicons name="open-outline" size={14} color={colors.textEmphasis} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "flex-start",
    gap: space.md,
    marginHorizontal: gutter.ledger,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    backgroundColor: colors.bgMuted,
  },
  artwork: {
    width: 52,
    height: 52,
    borderRadius: radius.sm,
    backgroundColor: colors.bgSubtle,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: "100%" },
  copy: { flex: 1, minWidth: 0 },
  disclosure: { ...typography.caption, color: colors.textSubtle },
  title: { ...typography.label, color: colors.textEmphasis },
  body: { ...typography.hint, color: colors.textSubtle },
  cta: { minHeight: TOUCH_MIN, alignItems: "center", gap: space.xs, maxWidth: "100%" },
  ctaText: { ...typography.caption, color: colors.textEmphasis, flexShrink: 1 },
});
