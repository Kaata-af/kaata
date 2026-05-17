import { Linking, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";

export default function UpdatePromptScreen() {
  const { update } = useAppMeta();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.inner}>
        <Text style={styles.title}>Update required</Text>
        <Text style={styles.subtitle}>
          Your version of Kaata is too old to continue. Please install the latest update to keep
          using the app.
        </Text>
        {update?.release_notes ? <Text style={styles.notes}>{update.release_notes}</Text> : null}
        <View style={{ height: 24 }} />
        <Button
          label={update?.version ? `Install v${update.version}` : "Install update"}
          onPress={() => {
            const url = update?.apk_url ?? update?.play_store_url;
            if (url) Linking.openURL(url);
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: { flex: 1, padding: 24, justifyContent: "center" },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 8,
  },
  subtitle: { fontSize: 16, color: colors.textSecondary, lineHeight: 22 },
  notes: {
    fontSize: 14,
    color: colors.textPrimary,
    marginTop: 16,
    padding: 12,
    backgroundColor: colors.surface,
    borderRadius: 8,
  },
});
