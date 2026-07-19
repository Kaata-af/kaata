import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useToast } from "./Toast";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { setAppMeta } from "../lib/db";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import { updateTargetUrl } from "../lib/update-url";

// Both banner variants share the same monochrome chassis. The update banner
// reverses to bgInverted so it asks for attention without breaking the palette;
// announcements stay light + bordered.
export function UpdateBanner() {
  const { update, announcement, refresh } = useAppMeta();
  const isRTL = useIsRTL();
  const toast = useToast();

  // Channel-aware target (lib/update-url.ts): the APK for sideload builds,
  // the store listing for Play/App Store builds. null = the announced
  // release has no target for THIS install's channel (e.g. a Play build
  // told about a sideload-only release) — show nothing rather than offer an
  // APK the install can't apply; the announcement branch below still runs.
  const updateUrl = update ? updateTargetUrl(update) : null;

  if (update && updateUrl) {
    return (
      <View style={[styles.banner, styles.bannerInverted, rowDir(isRTL)]}>
        <View style={[styles.body, isRTL ? styles.bodyRTL : styles.bodyLTR]}>
          <Text style={[styles.title, textDir(isRTL), { color: colors.textInverted }]}>
            {t("updateBanner.title", { version: update.version })}
          </Text>
          {update.release_notes ? (
            <Text
              style={[styles.note, textDir(isRTL), { color: colors.textInverted, opacity: 0.85 }]}
              numberOfLines={2}
            >
              {update.release_notes}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            Linking.openURL(updateUrl).catch(() =>
              toast.push(t("updatePrompt.openFailed"), "error"),
            );
          }}
          accessibilityRole="button"
          style={[styles.cta, styles.ctaInverted]}
        >
          <Text style={[styles.ctaText, { color: colors.textEmphasis }]}>
            {t("updateBanner.cta")}
          </Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            await setAppMeta("dismissed_update_version", update.version);
            await refresh();
          }}
          style={styles.dismiss}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("updateBanner.dismiss")}
        >
          <Text style={[styles.dismissText, { color: colors.textInverted }]}>×</Text>
        </Pressable>
      </View>
    );
  }

  if (announcement) {
    return (
      <View style={[styles.banner, styles.bannerLight, rowDir(isRTL)]}>
        <View style={[styles.body, isRTL ? styles.bodyRTL : styles.bodyLTR]}>
          <Text style={[styles.title, textDir(isRTL), { color: colors.textEmphasis }]}>
            {announcement.title}
          </Text>
          <Text
            style={[styles.note, textDir(isRTL), { color: colors.textSubtle }]}
            numberOfLines={3}
          >
            {announcement.body}
          </Text>
        </View>
        {announcement.cta_url ? (
          <Pressable
            onPress={() =>
              Linking.openURL(announcement.cta_url!).catch(() =>
                toast.push(t("updatePrompt.openFailed"), "error"),
              )
            }
            accessibilityRole="button"
            style={styles.cta}
          >
            <Text style={[styles.ctaText, { color: colors.textEmphasis }]}>
              {announcement.cta_label || t("updateBanner.learnMore")}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={async () => {
            await setAppMeta("dismissed_announcement_id", String(announcement.id));
            await refresh();
          }}
          style={styles.dismiss}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("updateBanner.dismiss")}
        >
          <Text style={[styles.dismissText, { color: colors.textSubtle }]}>×</Text>
        </Pressable>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  bannerInverted: {
    backgroundColor: colors.bgInverted,
    borderColor: colors.bgInverted,
  },
  bannerLight: {
    backgroundColor: colors.bgMuted,
    borderColor: colors.borderDefault,
  },
  body: { flex: 1 },
  bodyLTR: { marginRight: 12 },
  bodyRTL: { marginLeft: 12 },
  title: { fontFamily: fonts.sansSemi, fontSize: 13 },
  note: { fontSize: 12, fontFamily: fonts.sansRegular, marginTop: 2 },
  cta: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.bgDefault,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  ctaInverted: {
    borderColor: colors.bgDefault,
  },
  ctaText: { fontFamily: fonts.sansSemi, fontSize: 12 },
  dismiss: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  dismissText: { fontSize: 20, lineHeight: sansLineHeight(20, 22), fontFamily: fonts.sansRegular },
});
