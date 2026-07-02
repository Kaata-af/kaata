import { useRouter } from "expo-router";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KaataConceptCard } from "../components/KaataConceptCard";
import { ScreenHeader } from "../components/SettingsScreen";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

// Permanent "How kaata works" guide — linked from the settings sheet's Help
// section. Re-readable any time (useful when the phone is handed to staff).
// Static content only: the concept diagram + four short paragraphs covering
// kaata → tally → entries → multiple kaatas. Deliberately not an overlay
// tour (docs/tour-redesign.md) and deliberately short — shopkeepers read
// this once, standing behind a counter.

export default function GuideScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("guide.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <KaataConceptCard />
        <Text style={[styles.para, textDir(isRTL)]}>{t("guide.p1")}</Text>
        <Text style={[styles.para, textDir(isRTL)]}>{t("guide.p2")}</Text>
        <Text style={[styles.para, textDir(isRTL)]}>{t("guide.p3")}</Text>
        <Text style={[styles.para, textDir(isRTL)]}>{t("guide.p4")}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  scrollContent: { padding: 16, paddingBottom: 48 },
  para: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: 21,
    marginTop: 16,
  },
});
