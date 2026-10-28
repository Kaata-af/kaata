import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CURRENCIES, getCurrencyLabel, getCurrencyName, getCurrencySymbol } from "../lib/currency";
import { colors } from "../lib/colors";
import { ltrIsolate, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";
import { OptionSheet } from "./OptionSheet";

type CurrencySelectorProps = {
  value: string;
  onChange?: (code: string) => void;
  onOpen?: () => void | boolean;
  disabled?: boolean;
  compact?: boolean;
  symbolOnly?: boolean;
  allowedCurrencies?: readonly string[];
  label?: string;
};

function canChooseCurrency(props: CurrencySelectorProps): boolean {
  if (!props.onChange) return false;
  const codes = new Set(props.allowedCurrencies ?? CURRENCIES.map((currency) => currency.code));
  // Keep an explicit way to repair a draft whose currency was disabled while
  // it was open. Changing its denomination must remain the user's choice.
  return codes.size > 1 || (codes.size === 1 && !codes.has(props.value));
}

/** A sole currency is a label; multiple available currencies are selectable. */
export function CurrencySelector(props: CurrencySelectorProps) {
  const [visible, setVisible] = useState(false);
  const open = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const readOnly = !canChooseCurrency(props);
  useEffect(() => {
    if (props.disabled || readOnly) {
      open.current = false;
      setVisible(false);
    }
    return () => {
      open.current = false;
    };
  }, [props.disabled, readOnly]);
  const isRTL = useIsRTL();
  const label = props.label ?? t("entry.currency.label");
  const options = [...new Set(props.allowedCurrencies ?? CURRENCIES.map((c) => c.code))].map(
    (code) => {
      const name = getCurrencyName(code);
      return {
        key: code,
        label: name,
        hint: code === name ? undefined : ltrIsolate(code),
      };
    },
  );

  const value = (
    <Text style={[styles.value, props.symbolOnly && styles.symbol]}>
      {props.symbolOnly ? getCurrencySymbol(props.value) : getCurrencyLabel(props.value)}
    </Text>
  );
  if (readOnly && props.compact && props.symbolOnly) {
    return (
      <Text
        accessibilityRole="text"
        accessibilityLabel={label}
        accessibilityValue={{ text: getCurrencyLabel(props.value) }}
        style={[styles.staticSymbol, props.disabled && { opacity: 0.5 }]}
      >
        {getCurrencySymbol(props.value)}
      </Text>
    );
  }
  return (
    <View style={props.compact ? undefined : styles.field}>
      {!props.compact ? <Text style={[styles.label, textDir(isRTL)]}>{label}</Text> : null}
      {readOnly ? (
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={label}
          accessibilityValue={{ text: getCurrencyLabel(props.value) }}
          style={[styles.staticValue, props.disabled && { opacity: 0.5 }]}
        >
          {value}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityValue={{ text: getCurrencyLabel(props.value) }}
          accessibilityState={{ disabled: !!props.disabled }}
          disabled={props.disabled || readOnly}
          onPress={() => {
            const current = latest.current;
            if (current.disabled || !canChooseCurrency(current)) return;
            if (current.onOpen?.() === false) return;
            open.current = true;
            setVisible(true);
          }}
          style={({ pressed }) => [
            props.compact ? styles.compact : styles.input,
            { flexDirection: "row", direction: "ltr" },
            props.disabled && { opacity: 0.5 },
            pressed && { backgroundColor: colors.bgMuted },
          ]}
        >
          {props.compact && !props.symbolOnly ? (
            <Text style={[styles.caption, textDir(isRTL)]}>{label}</Text>
          ) : null}
          {value}
          {!readOnly ? <Ionicons name="chevron-down" size={16} color={colors.textSubtle} /> : null}
        </Pressable>
      )}
      {!readOnly ? (
        <OptionSheet
          visible={visible}
          title={label}
          options={options}
          selected={props.value}
          onSelect={(code) => {
            const current = latest.current;
            if (
              !open.current ||
              current.disabled ||
              !canChooseCurrency(current) ||
              !(current.allowedCurrencies ?? CURRENCIES.map((c) => c.code)).includes(code)
            )
              return;
            open.current = false;
            setVisible(false);
            current.onChange?.(code);
          }}
          onDismiss={() => {
            open.current = false;
            setVisible(false);
          }}
          isRTL={isRTL}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 8 },
  staticSymbol: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    lineHeight: sansLineHeight(13, 20),
    color: colors.textSubtle,
  },
  staticValue: {
    minHeight: TOUCH_MIN,
    justifyContent: "center",
    paddingVertical: 6,
  },
  label: { ...typography.bodySm, fontFamily: fonts.sansMedium, color: colors.textDefault },
  input: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  compact: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.pill,
  },
  caption: { ...typography.bodySm, color: colors.textSubtle },
  value: { ...typography.label, color: colors.textEmphasis, writingDirection: "ltr" },
  symbol: { fontSize: 18 },
});
