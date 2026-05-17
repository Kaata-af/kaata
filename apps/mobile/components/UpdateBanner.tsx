import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { setAppMeta } from "../lib/db";

export function UpdateBanner() {
  const { update, announcement, refresh } = useAppMeta();

  if (update) {
    return (
      <View style={[styles.banner, { backgroundColor: colors.primaryAction }]}>
        <View style={styles.body}>
          <Text style={styles.title}>Update available — v{update.version}</Text>
          {update.release_notes ? (
            <Text style={styles.note} numberOfLines={2}>
              {update.release_notes}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            const url = update.apk_url || update.play_store_url;
            if (url) Linking.openURL(url);
          }}
          style={styles.cta}
        >
          <Text style={styles.ctaText}>Update</Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            await setAppMeta("dismissed_update_version", update.version);
            await refresh();
          }}
          style={styles.dismiss}
          hitSlop={8}
        >
          <Text style={styles.dismissText}>×</Text>
        </Pressable>
      </View>
    );
  }

  if (announcement) {
    return (
      <View style={[styles.banner, { backgroundColor: colors.accent }]}>
        <View style={styles.body}>
          <Text style={styles.title}>{announcement.title}</Text>
          <Text style={styles.note} numberOfLines={3}>
            {announcement.body}
          </Text>
        </View>
        {announcement.cta_url ? (
          <Pressable onPress={() => Linking.openURL(announcement.cta_url!)} style={styles.cta}>
            <Text style={styles.ctaText}>{announcement.cta_label || "Learn more"}</Text>
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
          <Text style={styles.dismissText}>×</Text>
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
  },
  body: { flex: 1, marginRight: 12 },
  title: { color: "#fff", fontWeight: "700", fontSize: 14 },
  note: { color: "#fff", fontSize: 12, marginTop: 2, opacity: 0.9 },
  cta: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "rgba(255,255,255,0.2)",
    borderRadius: 8,
  },
  ctaText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  dismiss: { marginLeft: 8, width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  dismissText: { color: "#fff", fontSize: 22, lineHeight: 22 },
});
