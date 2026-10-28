import { Ionicons } from "@expo/vector-icons";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type FlatListInstance,
  type ScrollViewInstance,
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
  SETTINGS_SHEET_TOP_RADIUS,
} from "../lib/design-tokens";

const MAX_ENABLED_CURRENCIES = 64;
type CurrencyOption = { code: string; label: string; symbol: string };
const currencyKey = (option: CurrencyOption) => option.code;

const CurrencyChoiceRow = memo(function CurrencyChoiceRow(props: {
  code: string;
  label: string;
  checked: boolean;
  isDefault: boolean;
  disabled: boolean;
  isRTL: boolean;
  defaultLabel: string;
  defaultActionLabel: string;
  onToggle: (code: string) => void;
  onSetDefault: (code: string) => void;
}) {
  const label = props.label === props.code ? props.code : `${props.code} ${props.label}`;
  return (
    <View
      style={[
        styles.choice,
        rowDir(props.isRTL),
        props.disabled && { backgroundColor: colors.bgMuted },
      ]}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`${label}${props.isDefault ? `, ${props.defaultLabel}` : ""}`}
        accessibilityState={{ checked: props.checked, disabled: props.disabled }}
        disabled={props.disabled}
        onPress={() => props.onToggle(props.code)}
        style={[styles.choiceToggle, rowDir(props.isRTL)]}
      >
        <Ionicons
          name={props.checked ? "checkbox" : "square-outline"}
          size={icon.row}
          color={
            props.disabled
              ? colors.textMuted
              : props.checked
                ? colors.actionPrimary
                : colors.textSubtle
          }
        />
        <View style={styles.choiceText}>
          <Text
            style={[
              styles.label,
              textDir(props.isRTL),
              props.disabled && { color: colors.textMuted },
            ]}
          >
            {props.label}
          </Text>
          {props.code !== props.label ? (
            <Text style={[styles.code, textDir(props.isRTL)]}>{ltrIsolate(props.code)}</Text>
          ) : null}
        </View>
      </Pressable>
      {props.checked ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.defaultActionLabel}
          accessibilityState={{ selected: props.isDefault, disabled: props.disabled }}
          disabled={props.disabled}
          onPress={() => props.onSetDefault(props.code)}
          style={styles.defaultButton}
        >
          <Ionicons
            name={props.isDefault ? "star" : "star-outline"}
            size={icon.row}
            color={
              props.disabled
                ? colors.textMuted
                : props.isDefault
                  ? colors.actionPrimary
                  : colors.textSubtle
            }
          />
        </Pressable>
      ) : null}
    </View>
  );
});

/** A controlled draft: the parent persists only the explicit Save action. */
export function EnabledCurrenciesSheet(props: {
  visible: boolean;
  options: readonly CurrencyOption[];
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
  const listRef = useRef<FlatListInstance | null>(null);
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
  const selectedCodes = useMemo(() => new Set(props.selected), [props.selected]);
  const atLimit = selectedCodes.size >= MAX_ENABLED_CURRENCIES;
  const blocked = props.saving || !!props.conflicted;
  const toggle = useCallback((code: string) => {
    const current = latest.current;
    if (
      !current.visible ||
      current.saving ||
      current.conflicted ||
      code === selection.current.defaultCurrency
    )
      return;
    const codes = selection.current.codes;
    if (!codes.has(code) && codes.size >= MAX_ENABLED_CURRENCIES) {
      setLimitAttempted(true);
      return;
    }
    // Reserve a slot before the parent's next render for rapid taps at the limit.
    if (codes.has(code)) codes.delete(code);
    else codes.add(code);
    setLimitAttempted(false);
    current.onToggle(code);
  }, []);
  const setDefault = useCallback((code: string) => {
    const current = latest.current;
    if (
      !current.visible ||
      current.saving ||
      current.conflicted ||
      !selection.current.codes.has(code) ||
      selection.current.defaultCurrency === code
    )
      return;
    // Protect the new default before the parent's next render.
    selection.current.defaultCurrency = code;
    current.onSetDefault(code);
  }, []);
  const defaultLabel = t("vaultSettings.currencies.default");
  const renderChoice = useCallback(
    ({ item }: { item: CurrencyOption }) => {
      const checked = selectedCodes.has(item.code);
      const isDefault = item.code === props.defaultCurrency;
      return (
        <CurrencyChoiceRow
          code={item.code}
          label={item.label}
          checked={checked}
          isDefault={isDefault}
          disabled={blocked || isDefault || (!checked && atLimit)}
          isRTL={props.isRTL}
          defaultLabel={defaultLabel}
          defaultActionLabel={t("vaultSettings.currencies.setDefault", { currency: item.label })}
          onToggle={toggle}
          onSetDefault={setDefault}
        />
      );
    },
    [
      selectedCodes,
      props.defaultCurrency,
      props.isRTL,
      blocked,
      atLimit,
      defaultLabel,
      locale,
      toggle,
      setDefault,
    ],
  );
  useEffect(() => {
    setQuery("");
    setLimitAttempted(false);
  }, [props.visible]);
  const { rendered, opacity, position } = useOverlayAnimation(props.visible, 600);
  const dismiss = useCallback(() => {
    const current = latest.current;
    if (!current.saving) current.onDismiss();
  }, []);
  const drag = useSheetDrag(props.visible && !props.saving, position, dismiss);
  const setListRef = useCallback(
    (list: FlatListInstance | null) => {
      listRef.current = list;
      drag.scrollProps.ref((list?.getNativeScrollRef() ?? null) as ScrollViewInstance | null);
    },
    [drag.scrollProps.ref],
  );
  useEffect(() => {
    if (props.visible) listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [props.visible, query]);
  if (!rendered) return null;
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <SheetBackdrop onDismiss={dismiss} />
      </Animated.View>
      <SearchKeyboardFrame style={styles.frame} pointerEvents="box-none">
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
                accessibilityState={{ disabled: blocked }}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.searchInput,
                  textDir(props.isRTL),
                  blocked && { color: colors.textMuted },
                ]}
              />
            </View>
            <FlatList
              {...drag.scrollProps}
              ref={setListRef}
              data={choices}
              renderItem={renderChoice}
              keyExtractor={currencyKey}
              extraData={props.selected}
              style={styles.choices}
              keyboardShouldPersistTaps="always"
              bounces={false}
              initialNumToRender={10}
              maxToRenderPerBatch={8}
              windowSize={5}
              removeClippedSubviews={false}
              ListHeaderComponent={
                <>
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
                </>
              }
              ListEmptyComponent={
                <Text style={[styles.hint, textDir(props.isRTL)]}>{t("currency.noMatch")}</Text>
              }
            />
            <View style={[styles.footer, rowDir(props.isRTL)]}>
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
          </SheetSurface>
        </Animated.View>
      </SearchKeyboardFrame>
    </Modal>
  );
}
const styles = StyleSheet.create({
  frame: { flex: 1, minHeight: 0, justifyContent: "flex-end" },
  container: { flexShrink: 1, maxHeight: "100%" },
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
  },
  hint: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    color: colors.textSubtle,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: 4,
    paddingBottom: 8,
  },
  choices: { flexShrink: 1, minHeight: 0 },
  search: {
    marginHorizontal: SETTINGS_ROW_PADDING_X,
    marginTop: 8,
    marginBottom: 4,
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
    paddingVertical: 10,
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
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
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
