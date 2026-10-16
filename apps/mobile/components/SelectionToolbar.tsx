import type { ComponentProps } from "react";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { formatAmount } from "../lib/format";
import { fonts, monoLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import { lift, radius, space, TOUCH_MIN, typography } from "../lib/tokens";
import type { SelectionFinancialSummary } from "../lib/selection-summary";

export type SelectionAction = {
  key: string;
  label: string;
  icon: ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

/** An in-flow panel. The screen owns its placement and safe-area insets. */
export function SelectionToolbar({
  count,
  total,
  onClose,
  onToggleAll,
  actions = [],
  busy = false,
  summary,
  financialSummary,
  allSelected: allSelectedOverride,
}: {
  count: number;
  total: number;
  onClose: () => void;
  onToggleAll: () => void;
  actions?: SelectionAction[];
  busy?: boolean;
  summary?: string;
  financialSummary?: SelectionFinancialSummary;
  allSelected?: boolean;
}) {
  const isRTL = useIsRTL();
  const allSelected = allSelectedOverride ?? (total > 0 && count === total);
  const toggleLabel = t(
    allSelectedOverride !== undefined
      ? allSelected
        ? "selection.clearResults"
        : "selection.allResults"
      : allSelected
        ? "selection.clear"
        : "selection.all",
  );
  const currency = financialSummary ? getCurrentCurrencySymbol() : "";
  const unavailable = !!financialSummary?.pending;
  const unavailableLabel = t("selection.summary.unavailable");
  const remainingKey =
    unavailable || !financialSummary?.net
      ? "selection.summary.remaining"
      : financialSummary.net > 0
        ? "selection.summary.collect"
        : "selection.summary.pay";
  const metric = (label: string, value: number, count: number, color: string, key: string) => {
    const countValue = unavailable ? "—" : count;
    const transactions = t(
      count === 1 && !unavailable
        ? "selection.summary.transaction"
        : "selection.summary.transactions",
      { count: countValue },
    );
    return (
      <View
        key={key}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${label}, ${unavailable ? unavailableLabel : `${formatAmount(value)} ${currency}, ${transactions}`}`}
        style={styles.total}
      >
        <View style={[styles.metricRow, rowDir(isRTL)]}>
          <Text style={[styles.totalLabel, styles.metricLabel, textDir(isRTL)]}>{label}</Text>
          <Text
            style={[
              styles.totalLabel,
              styles.metricEndLabel,
              textDir(isRTL),
              { textAlign: isRTL ? "left" : "right" },
            ]}
          >
            {t("selection.summary.transactionsLabel")}
          </Text>
        </View>
        <View style={[styles.metricRow, rowDir(isRTL)]}>
          <View style={[styles.totalValue, styles.metricValue, rowDir(isRTL)]}>
            <Text style={[styles.totalAmount, { color }]}>
              {unavailable ? "—" : formatAmount(value)}
            </Text>
            <Text style={styles.currency}>{currency}</Text>
          </View>
          <Text
            style={[styles.metricCount, textDir(isRTL), { textAlign: isRTL ? "left" : "right" }]}
          >
            {countValue}
          </Text>
        </View>
      </View>
    );
  };
  return (
    <View style={[styles.panel, lift]} accessibilityState={{ busy }}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("selection.close")}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onClose}
          style={({ pressed }) => [
            styles.close,
            pressed && styles.pressed,
            busy && styles.disabled,
          ]}
        >
          <Ionicons name="close" size={20} color={colors.textEmphasis} />
        </Pressable>
        <View style={[styles.selection, rowDir(isRTL)]}>
          {busy ? <ActivityIndicator size="small" color={colors.actionPrimary} /> : null}
          <Text accessibilityLiveRegion="polite" style={[styles.count, textDir(isRTL)]}>
            {t("selection.count", { count })}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
          accessibilityState={{ disabled: busy || total === 0 }}
          disabled={busy || total === 0}
          onPress={onToggleAll}
          style={({ pressed }) => [
            styles.toggleAll,
            pressed && styles.pressed,
            (busy || total === 0) && styles.disabled,
          ]}
        >
          <Text style={[styles.toggleLabel, textDir(isRTL)]}>{toggleLabel}</Text>
        </Pressable>
      </View>
      {summary || count === 0 ? (
        <Text style={[styles.summary, textDir(isRTL)]}>{summary || t("selection.empty")}</Text>
      ) : null}
      {count > 0 && financialSummary ? (
        <>
          <View style={[styles.totals, rowDir(isRTL)]}>
            {metric(
              t("selection.summary.debt"),
              financialSummary.debt,
              financialSummary.debtCount,
              colors.collectStrong,
              "debt",
            )}
            {metric(
              t("selection.summary.credit"),
              financialSummary.credit,
              financialSummary.creditCount,
              colors.payStrong,
              "credit",
            )}
          </View>
          <View
            accessible
            style={[styles.remaining, rowDir(isRTL)]}
            accessibilityLiveRegion="polite"
            accessibilityLabel={`${t(remainingKey)}, ${unavailable ? unavailableLabel : `${formatAmount(Math.abs(financialSummary.net))} ${currency}`}`}
          >
            <Text style={[styles.remainingLabel, textDir(isRTL)]}>{t(remainingKey)}</Text>
            <View
              style={[
                styles.totalValue,
                styles.remainingValue,
                rowDir(isRTL),
                isRTL ? { marginRight: "auto" } : { marginLeft: "auto" },
              ]}
            >
              <Text
                style={[
                  styles.summaryAmount,
                  {
                    color:
                      unavailable || financialSummary.net === 0
                        ? colors.textSubtle
                        : financialSummary.net > 0
                          ? colors.collectStrong
                          : colors.payStrong,
                  },
                ]}
              >
                {unavailable ? "—" : formatAmount(Math.abs(financialSummary.net))}
              </Text>
              <Text style={styles.currency}>{currency}</Text>
            </View>
          </View>
          {unavailable ? (
            <Text style={[styles.summary, textDir(isRTL)]}>{unavailableLabel}</Text>
          ) : null}
        </>
      ) : null}
      {actions.length > 0 ? (
        <View style={[styles.actions, rowDir(isRTL)]}>
          {actions.map((action) => {
            const disabled = busy || count === 0 || Boolean(action.disabled);
            const color = action.destructive ? colors.danger : colors.textEmphasis;
            return (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                accessibilityState={{ disabled, busy }}
                disabled={disabled}
                onPress={action.onPress}
                style={({ pressed }) => [
                  styles.action,
                  rowDir(isRTL),
                  action.destructive && styles.destructive,
                  pressed && styles.pressed,
                  disabled && styles.disabled,
                ]}
              >
                <Ionicons name={action.icon} size={18} color={color} />
                <Text style={[styles.actionLabel, textDir(isRTL), { color }]}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignSelf: "stretch",
    backgroundColor: colors.bgDefault,
    borderColor: colors.borderDefault,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.sm,
    gap: space.sm,
  },
  header: { alignItems: "center", flexWrap: "wrap", gap: space.sm },
  close: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    borderRadius: radius.pill,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  selection: {
    flex: 1,
    flexBasis: 90,
    minWidth: 0,
    alignItems: "center",
    gap: space.sm,
  },
  count: { ...typography.labelBold, color: colors.textEmphasis, flexShrink: 1 },
  toggleAll: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    maxWidth: "100%",
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleLabel: { ...typography.bodySm, color: colors.textDefault },
  summary: { ...typography.bodySm, color: colors.textSubtle, paddingHorizontal: space.sm },
  summaryAmount: {
    fontFamily: fonts.monoBold,
    fontSize: 17,
    lineHeight: monoLineHeight(17, 24),
    color: colors.textEmphasis,
    writingDirection: "ltr",
    flexShrink: 1,
  },
  remaining: {
    alignItems: "baseline",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space.sm,
    padding: space.sm,
  },
  remainingLabel: {
    ...typography.labelBold,
    color: colors.textDefault,
    flexShrink: 1,
    minWidth: 100,
  },
  remainingValue: { flexShrink: 1, minWidth: 0, justifyContent: "flex-end" },
  totals: { flexWrap: "wrap", gap: space.sm },
  total: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 0,
    padding: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bgMuted,
    gap: space.xs,
  },
  metricRow: { alignItems: "baseline", justifyContent: "space-between", gap: space.sm },
  metricLabel: { flex: 1, minWidth: 0 },
  metricEndLabel: { flexShrink: 1, maxWidth: "55%" },
  metricValue: { flexShrink: 1, minWidth: 0 },
  metricCount: {
    ...typography.numRow,
    color: colors.textSubtle,
    flexShrink: 1,
  },
  totalLabel: { ...typography.bodySm, color: colors.textSubtle },
  totalValue: { alignItems: "baseline", gap: space.xs },
  totalAmount: { ...typography.numRow, writingDirection: "ltr", flexShrink: 1 },
  currency: { ...typography.numMeta, color: colors.textMuted },
  actions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    paddingTop: space.sm,
    flexWrap: "wrap",
    gap: space.sm,
  },
  action: {
    flexGrow: 1,
    flexBasis: 110,
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bgMuted,
    borderColor: colors.bgMuted,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  actionLabel: { ...typography.bodySm, flexShrink: 1 },
  destructive: { backgroundColor: colors.bgDefault, borderColor: colors.borderDefault },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.4 },
});
