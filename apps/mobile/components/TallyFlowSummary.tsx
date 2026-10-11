import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { formatAmount } from "../lib/format";
import { fonts, monoLineHeight, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import { faDigits } from "../lib/jalali";
import type { TallyFlowSummary as FlowSummary } from "../lib/tally-summary";

/** Two rows occupy the other half of the balance header. No new card or graph. */
export function TallyFlowSummary({ summary, isRTL }: { summary: FlowSummary; isRTL: boolean }) {
  const currency = getCurrentCurrencySymbol();
  const aligned = { textAlign: isRTL ? ("left" as const) : ("right" as const) };
  return (
    <View style={styles.summary} accessibilityHint={t("person.flows.hint")}>
      {(["gave", "received"] as const).map((direction) => {
        const flow = summary[direction];
        const label = t(direction === "gave" ? "person.flows.gave" : "person.flows.received", {
          count: isRTL ? faDigits(String(flow.count)) : flow.count,
        });
        return (
          <View
            key={direction}
            accessible
            accessibilityLabel={`${label}, ${formatAmount(flow.amount)} ${currency}`}
          >
            <Text style={[styles.label, aligned, { writingDirection: isRTL ? "rtl" : "ltr" }]}>
              {label}
            </Text>
            <Text
              style={[styles.amount, aligned]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
            >
              {formatAmount(flow.amount)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flex: 1, minWidth: 0, justifyContent: "center", gap: 8 },
  label: {
    fontFamily: fonts.sansRegular,
    fontSize: 11,
    lineHeight: sansLineHeight(11, 16),
    color: colors.textSubtle,
  },
  amount: {
    fontFamily: fonts.monoMedium,
    fontSize: 16,
    lineHeight: monoLineHeight(16, 21),
    color: colors.textEmphasis,
  },
});
