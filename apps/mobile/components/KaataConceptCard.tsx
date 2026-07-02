import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

// KaataConceptCard — the one-glance "kaata vs tally" mental-model diagram.
//
// Born from real usage data: most early users created a tally CONTACT where
// they should have created (or named) their kaata — they read "kaata" as one
// person's tab instead of the whole shop's book. This card shows the
// containment visually: a shop (the kaata) holding example customer tallies.
//
// Shared by three surfaces (keep it dependency-light and self-contained):
//   1. onboarding/kaata.tsx — teaching at the exact moment of naming the shop
//   2. KaataGuideSheet — the one-time explainer for already-onboarded users
//   3. app/guide.tsx — the permanent "How kaata works" screen in settings
//
// Deliberately NOT an overlay/tour — see docs/tour-redesign.md postmortem.
// This is a plain View: no coordinate math, no measure timing, no Modal.
// Example amounts use the app-wide direction colors (emerald = money toward
// you, garnet = money away) so the card also primes the color language the
// user will see on the home rail.

export function KaataConceptCard() {
  const isRTL = useIsRTL();
  return (
    <View style={styles.card}>
      <View style={[styles.headerRow, rowDir(isRTL)]}>
        <Ionicons
          name="storefront-outline"
          size={22}
          color={colors.textEmphasis}
          style={isRTL ? { marginLeft: 10 } : { marginRight: 10 }}
        />
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, textDir(isRTL)]}>{t("kaataConcept.title")}</Text>
          <Text style={[styles.headerSub, textDir(isRTL)]}>{t("kaataConcept.subtitle")}</Text>
        </View>
      </View>

      <View style={styles.divider} />

      <ExampleRow name={t("kaataConcept.exampleA")} amount="+500" tone="collect" isRTL={isRTL} />
      <ExampleRow name={t("kaataConcept.exampleB")} amount="−200" tone="pay" isRTL={isRTL} />

      <Text style={[styles.caption, textDir(isRTL)]}>{t("kaataConcept.caption")}</Text>
    </View>
  );
}

function ExampleRow(props: {
  name: string;
  amount: string;
  tone: "collect" | "pay";
  isRTL: boolean;
}) {
  return (
    <View style={[styles.exampleRow, rowDir(props.isRTL)]}>
      <Ionicons
        name="person-circle-outline"
        size={18}
        color={colors.textSubtle}
        style={props.isRTL ? { marginLeft: 8 } : { marginRight: 8 }}
      />
      <Text style={[styles.exampleName, textDir(props.isRTL)]}>{props.name}</Text>
      <Text
        style={[
          styles.exampleAmount,
          { color: props.tone === "collect" ? colors.collectStrong : colors.payStrong },
        ]}
      >
        {props.amount}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 14,
    backgroundColor: colors.bgMuted,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
  },
  headerRow: { flexDirection: "row", alignItems: "center" },
  headerTitle: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  headerSub: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderEmphasis,
    marginTop: 12,
    marginBottom: 6,
  },
  exampleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
  },
  exampleName: {
    flex: 1,
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
  },
  exampleAmount: {
    fontSize: 14,
    fontFamily: fonts.monoMedium,
  },
  caption: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: 17,
    marginTop: 8,
  },
});
