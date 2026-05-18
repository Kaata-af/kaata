import { Linking, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";

export default function UpdatePromptScreen() {
  const { update } = useAppMeta();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.inner}>
        <Text style={styles.title}>Update required</Text>
        <Text style={styles.subtitle}>
          Your version of Kaata is too old to continue. Install the latest update to keep using the
          app.
        </Text>
        {update?.release_notes ? (
          <View style={styles.notesWrap}>
            <Text style={styles.notes}>{update.release_notes}</Text>
          </View>
        ) : null}
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
  container: { flex: 1, backgroundColor: colors.bgDefault },
  inner: { flex: 1, padding: 24, justifyContent: "center" },
  title: {
    fontSize: 28,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: 22,
  },
  notesWrap: {
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.bgMuted,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  notes: { fontSize: 13, fontFamily: fonts.sansRegular, color: colors.textDefault, lineHeight: 19 },
});
