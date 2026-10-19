import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir } from "../lib/direction";
import { formatAmount } from "../lib/format";
import { fonts, monoLineHeight, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import type { TallyFlowSummary as FlowSummary } from "../lib/tally-summary";

/** Two lines on the other side of the balance header. No new card or graph.
 *  Matee asked for this side to be no taller or wider than the balance side
 *  (audit #23): one line per direction, at most half the row, and nothing at
 *  all for a contact with no tallies (it used to be two rows of zeros). */
export function TallyFlowSummary({
  summary,
  isRTL,
  allTime = false,
}: {
  summary: FlowSummary;
  isRTL: boolean;
  /** A search or date filter is on, but these totals cover all time (#31). */
  allTime?: boolean;
}) {
  if (summary.gave.count === 0 && summary.received.count === 0) return null;
  const currency = getCurrentCurrencySymbol();
  return (
    <View style={styles.summary}>
      {allTime ? (
        <Text style={[styles.caption, { textAlign: isRTL ? "right" : "left" }]}>
          {t("person.flows.allTime")}
        </Text>
      ) : null}
      {(["gave", "received"] as const).map((direction) => {
        const flow = summary[direction];
        // Keep the translated label and parentheses, with Latin digits matching
        // the amounts in every language.
        const label = t(direction === "gave" ? "person.flows.gave" : "person.flows.received", {
          count: flow.count,
        });
        return (
          <View
            key={direction}
            accessible
            accessibilityLabel={`${label}, ${formatAmount(flow.amount)} ${currency}`}
            // On each row: a hint on the non-accessible container was never read.
            accessibilityHint={t("person.flows.hint")}
            style={[styles.line, rowDir(isRTL)]}
          >
            <Text
              style={[styles.label, { writingDirection: isRTL ? "rtl" : "ltr" }]}
              numberOfLines={1}
            >
              {label}
            </Text>
            <Text
              style={styles.amount}
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
  // Content-sized up to half the row, so a large balance keeps its room.
  summary: { flexShrink: 1, maxWidth: "50%", minWidth: 0, justifyContent: "center", gap: 6 },
  line: { alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  caption: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
    lineHeight: sansLineHeight(11, 14),
    color: colors.textSubtle,
  },
  label: {
    flexShrink: 1,
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    color: colors.textSubtle,
  },
  amount: {
    flexShrink: 0,
    fontFamily: fonts.monoMedium,
    fontSize: 15,
    lineHeight: monoLineHeight(15, 20),
    color: colors.textEmphasis,
  },
});
