import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Button } from "./Button";
import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";
import { SheetSurface } from "./SheetSurface";
import { SearchKeyboardFrame } from "./SearchKeyboardMotion";
import { useOverlayAnimation } from "../lib/use-overlay-animation";
import { useSheetDrag } from "../lib/use-sheet-drag";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";
import { ltrIsolate, rowDir, textDir } from "../lib/direction";
import { getLocale, t } from "../lib/i18n";
import { searchCurrencies } from "../lib/currency-catalog";
import { icon } from "../lib/tokens";
import {
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_ROW_PADDING_X,
  SETTINGS_ROW_PADDING_Y,
  SETTINGS_SHEET_TOP_RADIUS,
} from "../lib/design-tokens";

const MAX_ENABLED_CURRENCIES = 64;

/** A controlled draft: the parent persists only the explicit Save action. */
export function EnabledCurrenciesSheet(props: {
  visible: boolean;
  options: readonly { code: string; label: string; symbol: string }[];
  selected: readonly string[];
  defaultCurrency: string;
  onToggle: (code: string) => void;
  onSetDefault: (code: string) => void;
  onSave: () => void;
  onDismiss: () => void;
  saving: boolean;
  conflicted?: boolean;
  error?: string | null;
  isRTL: boolean;
}) {
  const [query, setQuery] = useState("");
  const [limitAttempted, setLimitAttempted] = useState(false);
  const selection = useRef({
    source: props,
    codes: new Set(props.selected),
    defaultCurrency: props.defaultCurrency,
  });
  // A parent may decline a same-frame edit after Save starts. Reconcile on
  // every new controlled prop snapshot, including unchanged selected values.
  if (selection.current.source !== props)
    selection.current = {
      source: props,
      codes: new Set(props.selected),
      defaultCurrency: props.defaultCurrency,
    };
  const latest = useRef(props);
  latest.current = props;
  const locale = getLocale();
  const choices = useMemo(() => {
    if (!query.trim()) return props.options;
    const catalogMatches = new Set(searchCurrencies(query, locale).map((item) => item.code));
    const terms = query.trim().toLowerCase().split(/\s+/);
    return props.options.filter(
      (option) =>
        catalogMatches.has(option.code) ||
        terms.every((term) =>
          `${option.code} ${option.label} ${option.symbol}`.toLowerCase().includes(term),
        ),
    );
  }, [query, locale, props.options]);
  const atLimit = new Set(props.selected).size >= MAX_ENABLED_CURRENCIES;
  useEffect(() => {
    setQuery("");
    setLimitAttempted(false);
  }, [props.visible]);
  const { rendered, opacity, position } = useOverlayAnimation(props.visible, 600);
  const dismiss = () => {
    if (!props.saving) props.onDismiss();
  };
  const drag = useSheetDrag(props.visible && !props.saving, position, dismiss);
  if (!rendered) return null;
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <SheetBackdrop onDismiss={dismiss} />
      </Animated.View>
      <SearchKeyboardFrame style={styles.frame} pointerEvents="box-none">
        <View style={styles.frame} pointerEvents="box-none">
          <Animated.View
            style={[styles.container, { transform: [{ translateY: drag.translateY }] }]}
            pointerEvents={props.visible ? "box-none" : "none"}
          >
            <SheetSurface {...drag.surfacePanHandlers} maxHeightRatio={0.82} style={styles.sheet}>
              <SheetHandle panHandlers={drag.panHandlers} onDismiss={dismiss} />
              <Text style={[styles.title, textDir(props.isRTL)]}>
                {t("vaultSettings.currencies.label")}
              </Text>
              <View style={[styles.search, rowDir(props.isRTL)]}>
                <Ionicons name="search-outline" size={icon.row} color={colors.textSubtle} />
                <TextInput
                  accessibilityLabel={t("vaultSettings.currencies.search")}
                  placeholder={t("vaultSettings.currencies.search")}
                  placeholderTextColor={colors.textMuted}
                  value={query}
                  onChangeText={setQuery}
                  editable={!props.saving && !props.conflicted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.searchInput, textDir(props.isRTL)]}
                />
              </View>
              <ScrollView
                {...drag.scrollProps}
                style={styles.choices}
                keyboardShouldPersistTaps="always"
                bounces={false}
              >
                {props.error ? (
                  <Text style={[styles.error, textDir(props.isRTL)]} accessibilityRole="alert">
                    {props.error}
                  </Text>
                ) : null}
                <Text style={[styles.hint, textDir(props.isRTL)]}>
                  {t("vaultSettings.currencies.hint")}
                </Text>
                {atLimit || limitAttempted ? (
                  <Text
                    style={[styles.hint, textDir(props.isRTL)]}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                  >
                    {t("vaultSettings.currencies.limit")}
                  </Text>
                ) : null}
                {choices.length === 0 ? (
                  <Text style={[styles.hint, textDir(props.isRTL)]}>{t("currency.noMatch")}</Text>
                ) : null}
                {choices.map((option) => {
                  const checked = props.selected.includes(option.code);
                  const isDefault = option.code === props.defaultCurrency;
                  const symbol = option.symbol.trim();
                  const codeLabel =
                    symbol && symbol !== option.code ? `${option.code} · ${symbol}` : option.code;
                  const disabled =
                    props.saving || props.conflicted || isDefault || (!checked && atLimit);
                  return (
                    <View key={option.code} style={[styles.choice, rowDir(props.isRTL)]}>
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityLabel={`${option.code} ${option.label}${isDefault ? `, ${t("vaultSettings.currencies.default")}` : ""}`}
                        accessibilityState={{ checked, disabled: !!disabled }}
                        disabled={!!disabled}
                        onPress={() => {
                          const current = latest.current;
                          if (
                            !current.visible ||
                            current.saving ||
                            current.conflicted ||
                            option.code === selection.current.defaultCurrency
                          )
                            return;
                          const codes = selection.current.codes;
                          if (!codes.has(option.code) && codes.size >= MAX_ENABLED_CURRENCIES) {
                            setLimitAttempted(true);
                            return;
                          }
                          // Reserve the slot before the parent's next render so two
                          // rapid taps at 63 cannot forward a 65th choice.
                          if (codes.has(option.code)) codes.delete(option.code);
                          else codes.add(option.code);
                          setLimitAttempted(false);
                          current.onToggle(option.code);
                        }}
                        style={[styles.choiceToggle, rowDir(props.isRTL)]}
                      >
                        <Ionicons
                          name={checked ? "checkbox" : "square-outline"}
                          size={icon.row}
                          color={checked ? colors.actionPrimary : colors.textSubtle}
                        />
                        <View style={styles.choiceText}>
                          <Text style={[styles.label, textDir(props.isRTL)]}>{option.label}</Text>
                          {codeLabel !== option.label ? (
                            <Text style={[styles.code, textDir(props.isRTL)]}>
                              {ltrIsolate(codeLabel)}
                            </Text>
                          ) : null}
                          {isDefault ? (
                            <Text style={[styles.defaultHint, textDir(props.isRTL)]}>
                              {t("vaultSettings.currencies.default")}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                      {checked ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={t("vaultSettings.currencies.setDefault", {
                            currency: option.label,
                          })}
                          accessibilityState={{
                            selected: isDefault,
                            disabled: !!(props.saving || props.conflicted || isDefault),
                          }}
                          disabled={!!(props.saving || props.conflicted || isDefault)}
                          onPress={() => {
                            const current = latest.current;
                            if (
                              !current.visible ||
                              current.saving ||
                              current.conflicted ||
                              !selection.current.codes.has(option.code) ||
                              selection.current.defaultCurrency === option.code
                            )
                              return;
                            // Protect the new default immediately, including taps
                            // received before the parent's next render.
                            selection.current.defaultCurrency = option.code;
                            current.onSetDefault(option.code);
                          }}
                          style={styles.defaultButton}
                        >
                          <Ionicons
                            name={isDefault ? "star" : "star-outline"}
                            size={icon.row}
                            color={isDefault ? colors.actionPrimary : colors.textSubtle}
                          />
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
              <View style={styles.footer}>
                <View style={[styles.buttons, rowDir(props.isRTL)]}>
                  <View style={styles.button}>
                    <Button
                      label={t("common.cancel")}
                      variant="secondary"
                      fullWidth
                      disabled={props.saving}
                      onPress={dismiss}
                    />
                  </View>
                  <View style={styles.button}>
                    <Button
                      label={t("vaultSettings.name.save")}
                      fullWidth
                      loading={props.saving}
                      disabled={
                        props.saving ||
                        props.conflicted ||
                        props.selected.length === 0 ||
                        props.selected.length > MAX_ENABLED_CURRENCIES
                      }
                      onPress={() => {
                        if (
                          !props.saving &&
                          !props.conflicted &&
                          props.selected.length > 0 &&
                          props.selected.length <= MAX_ENABLED_CURRENCIES
                        )
                          props.onSave();
                      }}
                    />
                  </View>
                </View>
              </View>
            </SheetSurface>
          </Animated.View>
        </View>
      </SearchKeyboardFrame>
    </Modal>
  );
}
const styles = StyleSheet.create({
  frame: { flex: 1, minHeight: 0 },
  container: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "100%" },
  sheet: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopRightRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
    minHeight: 0,
  },
  title: {
    fontFamily: fonts.sansSemi,
    fontSize: 17,
    color: colors.textEmphasis,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: 8,
  },
  hint: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    color: colors.textSubtle,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: 8,
    paddingBottom: 12,
  },
  choices: { flexShrink: 1, minHeight: 0 },
  search: {
    marginHorizontal: SETTINGS_ROW_PADDING_X,
    marginTop: 12,
    marginBottom: 8,
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 12,
    fontFamily: fonts.sansRegular,
    fontSize: 15,
    color: colors.textDefault,
  },
  choice: {
    minHeight: SETTINGS_ROW_MIN_HEIGHT,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    alignItems: "center",
  },
  choiceToggle: {
    flex: 1,
    minWidth: 0,
    paddingVertical: SETTINGS_ROW_PADDING_Y,
    alignItems: "center",
    gap: 12,
  },
  defaultButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginStart: 8,
  },
  choiceText: { flex: 1, minWidth: 0 },
  label: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.textDefault },
  code: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    color: colors.textSubtle,
    marginTop: 2,
  },
  defaultHint: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    color: colors.textSubtle,
    marginTop: 3,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    padding: 16,
  },
  buttons: { gap: 12 },
  button: { flex: 1 },
  error: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    color: colors.danger,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: 8,
    paddingBottom: 4,
  },
});
