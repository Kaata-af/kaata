import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

export default function UpdatePromptScreen() {
  const { update } = useAppMeta();
  const isRTL = useIsRTL();
  // Inline (this is a fullScreenModal — toasts can't render above it).
  const [openFailed, setOpenFailed] = useState(false);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.inner}>
        <Text style={[styles.title, textDir(isRTL)]}>{t("updatePrompt.title")}</Text>
        <Text style={[styles.subtitle, textDir(isRTL)]}>{t("updatePrompt.body")}</Text>
        {update?.release_notes ? (
          <View style={styles.notesWrap}>
            <Text style={[styles.notes, textDir(isRTL)]}>{update.release_notes}</Text>
          </View>
        ) : null}
        {openFailed ? (
          <Text style={[styles.openFailed, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {t("updatePrompt.openFailed")}
          </Text>
        ) : null}
        <View style={{ height: 24 }} />
        <Button
          label={
            update?.version
              ? t("updatePrompt.install", { version: update.version })
              : t("updatePrompt.installGeneric")
          }
          onPress={() => {
            // This is the ONLY affordance on a blocking screen — it must
            // never silently do nothing. Fall back to the website when the
            // release row carries no URL, and surface openURL rejections.
            const url = update?.apk_url ?? update?.play_store_url ?? "https://kaata.af/download";
            Linking.openURL(url).catch(() => setOpenFailed(true));
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
  openFailed: {
    marginTop: 12,
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
  },
});
