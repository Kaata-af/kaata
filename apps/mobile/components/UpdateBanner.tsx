import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useToast } from "./Toast";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { setAppMeta } from "../lib/db";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import { radius } from "../lib/tokens";
import { updateTargetUrl } from "../lib/update-url";

// Both banner variants share the same monochrome chassis. The update banner
// reverses to bgInverted so it asks for attention without breaking the palette;
// announcements stay light + bordered.

// The CTA pill computes to ~31dp tall (6 + 6 padding around a 12px label).
// Raising it to the 44dp floor with minHeight would inflate the banner CHASSIS
// — an update banner with no release notes is only ~55dp overall — so the touch
// floor is bought with slop instead of height: 31 + 8 + 8 = 47. Vertical only,
// because the dismiss "×" sits flush against the CTA's right edge and already
// claims that overlap; horizontally the pill is ~60dp wide and needs nothing.
// 8dp also stays INSIDE the banner's own 12dp padding, so Android still
// delivers the touch (a child's hit area outside its parent's bounds is clipped).
const CTA_HIT_SLOP = { top: 8, bottom: 8 } as const;

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
          hitSlop={CTA_HIT_SLOP}
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
          // 24 + 10 + 10 = 44 exactly. At the old 8 the "×" was a 40dp target;
          // matches components/BackupNagBanner.tsx's identical dismiss.
          hitSlop={10}
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
            hitSlop={CTA_HIT_SLOP}
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
          hitSlop={10} // 24 + 10 + 10 = 44 — see the update branch above
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
    borderRadius: radius.md, // 12, unchanged — now the token
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
    borderRadius: radius.sm, // 6 → 8, the button/chip step
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
