import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { setAppMeta } from "../lib/db";
import { fonts } from "../lib/fonts";

// Both banner variants share the same monochrome chassis. The update banner
// reverses to bgInverted so it asks for attention without breaking the palette;
// announcements stay light + bordered.
export function UpdateBanner() {
  const { update, announcement, refresh } = useAppMeta();

  if (update) {
    return (
      <View style={[styles.banner, styles.bannerInverted]}>
        <View style={styles.body}>
          <Text style={[styles.title, { color: colors.textInverted }]}>
            Update available · v{update.version}
          </Text>
          {update.release_notes ? (
            <Text
              style={[styles.note, { color: colors.textInverted, opacity: 0.85 }]}
              numberOfLines={2}
            >
              {update.release_notes}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            const url = update.apk_url || update.play_store_url;
            if (url) Linking.openURL(url);
          }}
          style={[styles.cta, styles.ctaInverted]}
        >
          <Text style={[styles.ctaText, { color: colors.textEmphasis }]}>Update</Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            await setAppMeta("dismissed_update_version", update.version);
            await refresh();
          }}
          style={styles.dismiss}
          hitSlop={8}
        >
          <Text style={[styles.dismissText, { color: colors.textInverted }]}>×</Text>
        </Pressable>
      </View>
    );
  }

  if (announcement) {
    return (
      <View style={[styles.banner, styles.bannerLight]}>
        <View style={styles.body}>
          <Text style={[styles.title, { color: colors.textEmphasis }]}>{announcement.title}</Text>
          <Text style={[styles.note, { color: colors.textSubtle }]} numberOfLines={3}>
            {announcement.body}
          </Text>
        </View>
        {announcement.cta_url ? (
          <Pressable onPress={() => Linking.openURL(announcement.cta_url!)} style={styles.cta}>
            <Text style={[styles.ctaText, { color: colors.textEmphasis }]}>
              {announcement.cta_label || "Learn more"}
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
  body: { flex: 1, marginRight: 12 },
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
  dismiss: { marginLeft: 6, width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  dismissText: { fontSize: 20, lineHeight: 22, fontFamily: fonts.sansRegular },
});
