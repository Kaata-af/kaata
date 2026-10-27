import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol, getCurrencyLabel } from "../lib/currency";
import { rowDir } from "../lib/direction";
import { formatAmount } from "../lib/format";
import { fonts, monoLineHeight, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import type { TallyFlowSummary as FlowSummary } from "../lib/tally-summary";

/** Confirmed handovers, kept separate from the customer's net balance.
 *  Inline stays within half the balance header; footer uses two columns. */
export function TallyFlowSummary({
  summary,
  isRTL,
  allTime = false,
  currency: currencyCode,
  variant = "inline",
}: {
  summary: FlowSummary;
  isRTL: boolean;
  /** A search or date filter is on, but these totals cover all time (#31). */
  allTime?: boolean;
  currency?: string;
  variant?: "inline" | "footer";
}) {
  if (summary.gave.count === 0 && summary.received.count === 0) return null;
  const currency = currencyCode ? getCurrencyLabel(currencyCode) : getCurrentCurrencySymbol();
  if (variant === "footer") {
    return (
      <View style={styles.footer}>
        {allTime ? (
          <Text style={[styles.caption, { textAlign: isRTL ? "right" : "left" }]}>
            {t("person.flows.allTime")}
          </Text>
        ) : null}
        <View style={styles.footerColumns}>
          {(["received", "gave"] as const).map((direction) => {
            const flow = summary[direction];
            const label = t(direction === "gave" ? "person.flows.gave" : "person.flows.received", {
              count: flow.count,
            });
            return (
              <View
                key={direction}
                accessible
                accessibilityLabel={`${label}, ${formatAmount(flow.amount)} ${currency}`}
                accessibilityHint={t("person.flows.hint")}
                style={[
                  styles.footerColumn,
                  direction === "received" ? styles.footerReceived : styles.footerGave,
                ]}
              >
                <Text style={[styles.footerLabel, { writingDirection: isRTL ? "rtl" : "ltr" }]}>
                  {label}
                </Text>
                <Text
                  style={styles.footerAmount}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.1}
                  maxFontSizeMultiplier={1.3}
                >
                  {formatAmount(flow.amount)}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    );
  }
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
  footer: {
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  footerColumns: { direction: "ltr", flexDirection: "row", alignItems: "stretch" },
  footerColumn: { flex: 1, minWidth: 0, gap: 4 },
  footerReceived: { paddingRight: 14 },
  footerGave: { paddingLeft: 14, borderLeftWidth: 1, borderLeftColor: colors.borderDefault },
  footerLabel: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    color: colors.textSubtle,
    textAlign: "left",
  },
  footerAmount: {
    width: "100%",
    minWidth: 0,
    fontFamily: fonts.monoMedium,
    fontSize: 15,
    lineHeight: monoLineHeight(15, 20),
    color: colors.textEmphasis,
    writingDirection: "ltr",
    textAlign: "left",
  },
});
