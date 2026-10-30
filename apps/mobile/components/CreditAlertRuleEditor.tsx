import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { CurrencyPickerSheet } from "./CurrencyPickerSheet";
import { Button } from "./Button";
import { colors } from "../lib/colors";
import { getCurrencyLabel } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { formatAmount } from "../lib/format";
import { t } from "../lib/i18n";
import { fromMinorUnits, normalizeAmountInput, parseAmountInput, toMinorUnits } from "../lib/money";
import {
  evaluateCreditAlertDirection,
  validCreditAlertGroups,
  type CreditAlertBalances,
  type CreditAlertGroup,
} from "../lib/credit-alert-policy";
import { radius, TOUCH_MIN } from "../lib/tokens";

export type CreditAlertDraft = {
  key: number;
  direction: "collect" | "pay";
  conditions: { key: number; currency: string; amount: string }[];
};

export function parseCreditAlertAmount(raw: string): number | null {
  const amount = parseAmountInput(raw);
  if (amount == null) return null;
  const minor = toMinorUnits(amount);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export function creditAlertDraftGroups(drafts: CreditAlertDraft[]): CreditAlertGroup[] | null {
  const result: CreditAlertGroup[] = [];
  for (const draft of drafts) {
    const conditions = draft.conditions.map((c) => ({
      currency: c.currency,
      threshold_minor: parseCreditAlertAmount(c.amount),
    }));
    if (
      conditions.length === 0 ||
      conditions.length > 20 ||
      new Set(conditions.map((c) => c.currency)).size !== conditions.length ||
      conditions.some((c) => c.threshold_minor === null || !/^[A-Z]{3}$/.test(c.currency))
    )
      return null;
    result.push({
      direction: draft.direction,
      conditions: conditions as CreditAlertGroup["conditions"],
    });
  }
  return validCreditAlertGroups(result) ? result : null;
}

/** OR alternatives containing AND currency thresholds; never an exchange rate. */
export function CreditAlertRuleEditor(props: {
  drafts: CreditAlertDraft[];
  currencies: string[];
  disabled: boolean;
  validation: boolean;
  balances: CreditAlertBalances | null;
  onChange: (drafts: CreditAlertDraft[]) => void;
  nextKey: () => number;
}) {
  const isRTL = useIsRTL();
  const [picker, setPicker] = useState<{ group: number; condition: number } | null>(null);
  const selectedGroup = props.drafts.find((g) => g.key === picker?.group);
  const selectedCondition = selectedGroup?.conditions.find((c) => c.key === picker?.condition);
  const available = props.currencies.filter(
    (code) =>
      !selectedGroup?.conditions.some(
        (c) => c.key !== selectedCondition?.key && c.currency === code,
      ),
  );
  const replace = (key: number, change: Partial<CreditAlertDraft>) => {
    if (!props.disabled)
      props.onChange(props.drafts.map((g) => (g.key === key ? { ...g, ...change } : g)));
  };
  return (
    <View testID="credit-alert-rule-editor" style={styles.editor}>
      {props.drafts.length === 0 ? (
        <Text style={[styles.help, textDir(isRTL)]}>{t("creditAlerts.off")}</Text>
      ) : null}
      {props.drafts.map((group, index) => {
        const parsed = creditAlertDraftGroups([group]);
        const match =
          props.balances && parsed
            ? evaluateCreditAlertDirection(
                { relationship_id: "preview", groups: parsed, updated_at_ms: 0 },
                props.balances,
                group.direction,
              )
            : null;
        const unused = props.currencies.find(
          (code) => !group.conditions.some((c) => c.currency === code),
        );
        return (
          <View key={group.key}>
            {index > 0 ? (
              <View style={styles.orRow}>
                <View style={styles.line} />
                <Text style={styles.operator}>{t("creditAlerts.or")}</Text>
                <View style={styles.line} />
              </View>
            ) : null}
            <View testID={`credit-alert-rule-${group.key}`} style={styles.rule}>
              <View style={[styles.heading, rowDir(isRTL)]}>
                <View style={styles.headingText}>
                  <Text style={[styles.ruleTitle, textDir(isRTL)]}>
                    {t("creditAlerts.rule", { n: index + 1 })}
                  </Text>
                  <Text style={[styles.help, textDir(isRTL)]}>
                    {t("creditAlerts.allConditions")}
                  </Text>
                </View>
                <Pressable
                  testID={`credit-alert-remove-rule-${group.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={t("creditAlerts.removeRule")}
                  accessibilityState={{ disabled: props.disabled }}
                  disabled={props.disabled}
                  style={styles.iconButton}
                  onPress={() => {
                    if (!props.disabled)
                      props.onChange(props.drafts.filter((g) => g.key !== group.key));
                  }}
                >
                  <Ionicons
                    name="trash-outline"
                    size={18}
                    color={props.disabled ? colors.textMuted : colors.textSubtle}
                  />
                </Pressable>
              </View>
              <View style={[styles.directions, rowDir(isRTL)]} accessibilityRole="radiogroup">
                {(["collect", "pay"] as const).map((direction) => (
                  <Pressable
                    key={direction}
                    testID={`credit-alert-direction-${group.key}-${direction}`}
                    accessibilityRole="radio"
                    accessibilityState={{
                      checked: group.direction === direction,
                      disabled: props.disabled,
                    }}
                    disabled={props.disabled}
                    style={[
                      styles.direction,
                      group.direction === direction &&
                        (direction === "collect" ? styles.collect : styles.pay),
                      props.disabled && styles.disabled,
                    ]}
                    onPress={() => replace(group.key, { direction })}
                  >
                    <Ionicons
                      name={direction === "collect" ? "arrow-down-outline" : "arrow-up-outline"}
                      size={16}
                      color={
                        direction === "collect"
                          ? colors.entryActionReceivedText
                          : colors.entryActionGaveText
                      }
                    />
                    <Text style={[styles.directionText, textDir(isRTL)]}>
                      {t(direction === "collect" ? "creditAlerts.collect" : "creditAlerts.pay")}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {group.conditions.map((condition, conditionIndex) => {
                const exposure = props.balances?.[condition.currency];
                const invalid =
                  props.validation && parseCreditAlertAmount(condition.amount) === null;
                const canPick = props.currencies.some(
                  (code) =>
                    code !== condition.currency &&
                    !group.conditions.some((c) => c.currency === code),
                );
                return (
                  <View key={condition.key}>
                    {conditionIndex > 0 ? (
                      <Text style={[styles.and, textDir(isRTL)]}>{t("creditAlerts.and")}</Text>
                    ) : null}
                    <View style={[styles.condition, rowDir(isRTL)]}>
                      <Pressable
                        testID={`credit-alert-currency-${condition.key}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${t("creditAlerts.currency")}: ${condition.currency}`}
                        accessibilityState={{ disabled: props.disabled || !canPick }}
                        disabled={props.disabled || !canPick}
                        style={[styles.currency, props.disabled && styles.disabled]}
                        onPress={() => {
                          if (!props.disabled && canPick) {
                            Keyboard.dismiss();
                            setPicker({ group: group.key, condition: condition.key });
                          }
                        }}
                      >
                        <Text style={styles.currencyText}>
                          {getCurrencyLabel(condition.currency)}
                        </Text>
                        {canPick ? (
                          <Ionicons name="chevron-down" size={13} color={colors.textMuted} />
                        ) : null}
                      </Pressable>
                      <View style={styles.amountField}>
                        <Text style={[styles.help, textDir(isRTL)]}>
                          {t("creditAlerts.atLeast")}
                        </Text>
                        <TextInput
                          testID={`credit-alert-amount-${condition.key}`}
                          accessibilityLabel={`${condition.currency} · ${t("creditAlerts.atLeast")}`}
                          accessibilityState={{ disabled: props.disabled }}
                          editable={!props.disabled}
                          keyboardType="decimal-pad"
                          value={condition.amount}
                          onChangeText={(amount) =>
                            replace(group.key, {
                              conditions: group.conditions.map((c) =>
                                c.key === condition.key
                                  ? { ...c, amount: normalizeAmountInput(amount) }
                                  : c,
                              ),
                            })
                          }
                          placeholder={t("creditAlerts.amount")}
                          style={[
                            styles.input,
                            textDir(isRTL),
                            props.disabled && styles.disabled,
                            invalid && styles.invalid,
                          ]}
                        />
                      </View>
                      {group.conditions.length > 1 ? (
                        <Pressable
                          testID={`credit-alert-remove-condition-${condition.key}`}
                          accessibilityRole="button"
                          accessibilityLabel={t("creditAlerts.removeCondition")}
                          accessibilityState={{ disabled: props.disabled }}
                          disabled={props.disabled}
                          style={styles.iconButton}
                          onPress={() =>
                            replace(group.key, {
                              conditions: group.conditions.filter((c) => c.key !== condition.key),
                            })
                          }
                        >
                          <Ionicons name="close" size={18} color={colors.textSubtle} />
                        </Pressable>
                      ) : null}
                    </View>
                    {props.balances && exposure != null ? (
                      <Text style={[styles.current, textDir(isRTL)]}>
                        {t("creditAlerts.current", {
                          amount: formatAmount(
                            fromMinorUnits(
                              Math.max(0, group.direction === "collect" ? exposure : -exposure),
                            ),
                          ),
                          currency: condition.currency,
                        })}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
              <Button
                label={t("creditAlerts.addCondition")}
                icon="add-outline"
                variant="secondary"
                wrapLabel
                disabled={props.disabled || !unused || group.conditions.length >= 20}
                onPress={() => {
                  if (unused)
                    replace(group.key, {
                      conditions: [
                        ...group.conditions,
                        { key: props.nextKey(), currency: unused, amount: "" },
                      ],
                    });
                }}
              />
              {match ? (
                <Text style={[styles.match, textDir(isRTL), match === "matched" && styles.reached]}>
                  {t(
                    match === "matched"
                      ? "creditAlerts.reached"
                      : match === "unknown"
                        ? "creditAlerts.unknown"
                        : "creditAlerts.notReached",
                  )}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
      <Button
        label={t("creditAlerts.addRule")}
        icon="add-outline"
        variant="secondary"
        wrapLabel
        disabled={props.disabled || props.drafts.length >= 20 || props.currencies.length === 0}
        onPress={() => {
          if (!props.disabled && props.currencies[0])
            props.onChange([
              ...props.drafts,
              {
                key: props.nextKey(),
                direction: "collect",
                conditions: [{ key: props.nextKey(), currency: props.currencies[0], amount: "" }],
              },
            ]);
        }}
      />
      <CurrencyPickerSheet
        visible={!!picker && !!selectedCondition}
        selectedCode={selectedCondition?.currency ?? ""}
        allowedCurrencies={available}
        disabled={props.disabled}
        onDismiss={() => setPicker(null)}
        onSelect={(currency) => {
          if (!props.disabled && selectedGroup && selectedCondition && available.includes(currency))
            replace(selectedGroup.key, {
              conditions: selectedGroup.conditions.map((c) =>
                c.key === selectedCondition.key ? { ...c, currency } : c,
              ),
            });
          setPicker(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { gap: 16 },
  rule: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    padding: 14,
    gap: 14,
    backgroundColor: colors.bgMuted,
  },
  heading: { alignItems: "center", gap: 8 },
  headingText: { flex: 1, minWidth: 0, gap: 2 },
  ruleTitle: {
    fontFamily: fonts.sansSemi,
    fontSize: 16,
    lineHeight: sansLineHeight(16, 24),
    color: colors.textEmphasis,
  },
  help: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    color: colors.textSubtle,
  },
  iconButton: {
    width: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
  directions: { gap: 8 },
  direction: {
    flex: 1,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  directionText: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    lineHeight: sansLineHeight(13, 20),
    flexShrink: 1,
    color: colors.textDefault,
  },
  collect: {
    backgroundColor: colors.entryActionReceived,
    borderColor: colors.entryActionReceivedCoin,
  },
  pay: { backgroundColor: colors.entryActionGave, borderColor: colors.entryActionGaveCoin },
  condition: { alignItems: "flex-end", gap: 8 },
  currency: {
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  currencyText: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    writingDirection: "ltr",
  },
  amountField: { flex: 1, minWidth: 0, gap: 4 },
  input: {
    minHeight: 48,
    minWidth: 0,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: fonts.sansRegular,
    fontSize: 15,
    lineHeight: sansLineHeight(15, 23),
    color: colors.textDefault,
  },
  invalid: { borderColor: colors.danger },
  current: {
    fontSize: 11,
    lineHeight: sansLineHeight(11, 17),
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 4,
  },
  and: { fontSize: 11, fontFamily: fonts.sansMedium, color: colors.textSubtle, paddingVertical: 8 },
  orRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 16 },
  line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.borderDefault },
  operator: { fontSize: 12, fontFamily: fonts.sansSemi, color: colors.textSubtle },
  match: {
    fontSize: 12,
    lineHeight: sansLineHeight(12, 18),
    color: colors.textSubtle,
    fontFamily: fonts.sansMedium,
  },
  reached: { color: colors.reviewPending },
  disabled: { opacity: 0.45 },
});
