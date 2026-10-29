import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, type ComponentProps } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { rowDir, textDir } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import {
  DEFAULT_TALLY_LIST_FILTER,
  normalizeTallyCurrencies,
  normalizeTallyListFilter,
  tallyAmountSortAvailable,
  type TallyListFilter,
  type TallySort,
} from "../lib/tally-list-filter";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";
import { HomeFilterPopover } from "./HomeFilterPopover";

type Props = Omit<ComponentProps<typeof HomeFilterPopover>, "children"> & {
  filter: TallyListFilter;
  availableCodes: readonly string[];
  onChange: (filter: TallyListFilter) => void;
  onClear: () => void;
  isRTL: boolean;
};

/** Same content-sized overlay as Home; all changes affect the visible ledger only. */
export function CustomerTallyFilterPopover(props: Props) {
  const {
    filter: _filter,
    availableCodes: _codes,
    onChange: _change,
    onClear: _clear,
    isRTL,
    ...popover
  } = props;
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const session = useRef({ key: props.contextKey, visible: props.visible, version: 0 });
  if (session.current.key !== props.contextKey || session.current.visible !== props.visible)
    session.current = {
      key: props.contextKey,
      visible: props.visible,
      version: session.current.version + 1,
    };
  const version = session.current.version;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    latest.current.visible &&
    !latest.current.disabled &&
    session.current.version === version;
  const change = (update: (filter: TallyListFilter) => TallyListFilter) => {
    if (!current()) return;
    const live = latest.current;
    const next = normalizeTallyListFilter(update(live.filter), live.availableCodes);
    // Consecutive checkbox taps can share one native turn. Do not discard the
    // first selection while the parent is committing its next render.
    latest.current = { ...live, filter: next };
    live.onChange(next);
  };
  const codes = normalizeTallyCurrencies(props.availableCodes);
  const filter = normalizeTallyListFilter(props.filter, codes);
  const amountSort = tallyAmountSortAvailable(filter, codes);
  const choice = (
    id: string,
    label: string,
    selected: boolean,
    onPress: () => void,
    kind: "radio" | "checkbox" = "radio",
    disabled = false,
    code = false,
    fillRow = false,
  ) => (
    <Pressable
      key={id}
      testID={`tally-filter-${id}`}
      accessibilityRole={kind}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, selected, disabled: !!props.disabled || disabled }}
      disabled={!!props.disabled || disabled}
      onPress={() => {
        if (current() && !disabled) onPress();
      }}
      style={({ pressed }) => [
        styles.choice,
        fillRow && styles.rowChoice,
        rowDir(code ? false : isRTL),
        selected && styles.selected,
        (!!props.disabled || disabled) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons
        name={
          kind === "checkbox"
            ? selected
              ? "checkbox"
              : "square-outline"
            : selected
              ? "radio-button-on"
              : "radio-button-off"
        }
        size={18}
        color={selected ? colors.textEmphasis : colors.textMuted}
        accessible={false}
      />
      <Text style={[styles.choiceLabel, textDir(isRTL), code && styles.code]}>{label}</Text>
    </Pressable>
  );
  return (
    <HomeFilterPopover {...popover}>
      <View style={[styles.heading, rowDir(isRTL)]}>
        <Ionicons name="swap-horizontal-outline" size={18} color={colors.textSubtle} />
        <Text accessibilityRole="header" style={[styles.title, textDir(isRTL)]}>
          {t("person.filters.title")}
        </Text>
      </View>
      <View
        style={styles.row}
        accessibilityRole="radiogroup"
        accessibilityLabel={t("person.filters.title")}
      >
        {(["all", "received", "gave"] as const).map((direction) =>
          choice(
            `direction-${direction}`,
            t(
              direction === "all"
                ? "person.filters.all"
                : direction === "received"
                  ? "person.filters.received"
                  : "person.filters.gave",
            ),
            filter.direction === direction,
            () => change((before) => ({ ...before, direction })),
            "radio",
            false,
            false,
            true,
          ),
        )}
      </View>
      {codes.length > 1 ? (
        <>
          <View style={[styles.heading, styles.sectionBreak, rowDir(isRTL)]}>
            <Ionicons name="cash-outline" size={18} color={colors.textSubtle} />
            <Text accessibilityRole="header" style={[styles.title, textDir(isRTL)]}>
              {t("customers.currencyFilter")}
            </Text>
          </View>
          <ScrollView
            horizontal
            style={styles.currencyScroll}
            keyboardShouldPersistTaps="always"
            nestedScrollEnabled
            directionalLockEnabled
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.currencyChoices}
          >
            {choice(
              "currency-all",
              t("customers.currencyFilter.all"),
              !filter.currencies.length,
              () => change((before) => ({ ...before, currencies: [] })),
              "checkbox",
            )}
            {codes.map((code) =>
              choice(
                `currency-${code}`,
                code,
                filter.currencies.includes(code),
                () =>
                  change((before) => ({
                    ...before,
                    currencies: before.currencies.includes(code)
                      ? before.currencies.filter((selected) => selected !== code)
                      : [...before.currencies, code],
                  })),
                "checkbox",
                false,
                true,
              ),
            )}
          </ScrollView>
        </>
      ) : null}
      <View style={[styles.heading, styles.sectionBreak, rowDir(isRTL)]}>
        <Ionicons name="swap-vertical-outline" size={18} color={colors.textSubtle} />
        <Text accessibilityRole="header" style={[styles.title, textDir(isRTL)]}>
          {t("person.filters.sort")}
        </Text>
      </View>
      <View
        style={styles.sortRows}
        accessibilityRole="radiogroup"
        accessibilityLabel={t("person.filters.sort")}
      >
        {(["recent", "date_asc"] as TallySort[]).map((sort) =>
          choice(
            `sort-${sort}`,
            t(sort === "recent" ? "person.filters.newest" : "person.filters.oldest"),
            filter.sort === sort,
            () => change((before) => ({ ...before, sort })),
          ),
        )}
        <View style={styles.row}>
          {(["amount_asc", "amount_desc"] as const).map((sort) =>
            choice(
              `sort-${sort}`,
              t(`customers.sort.${sort}`),
              filter.sort === sort,
              () => change((before) => ({ ...before, sort })),
              "radio",
              !amountSort,
              false,
              true,
            ),
          )}
        </View>
      </View>
      {!amountSort ? (
        <Text style={[styles.help, textDir(isRTL)]}>{t("customers.sort.selectCurrencyHelp")}</Text>
      ) : null}
      <Pressable
        testID="tally-filter-clear"
        accessibilityRole="button"
        accessibilityLabel={t("search.clearAll")}
        accessibilityState={{ disabled: !!props.disabled }}
        disabled={!!props.disabled}
        onPress={() => {
          if (!current()) return;
          const live = latest.current;
          latest.current = { ...live, filter: { ...DEFAULT_TALLY_LIST_FILTER, currencies: [] } };
          live.onClear();
        }}
        style={[styles.clear, props.disabled && styles.disabled]}
      >
        <Text style={styles.clearText}>{t("search.clearAll")}</Text>
      </Pressable>
    </HomeFilterPopover>
  );
}

const styles = StyleSheet.create({
  heading: { alignItems: "center", gap: 8, paddingHorizontal: 4, paddingVertical: 4 },
  title: { ...typography.bodySm, fontFamily: fonts.sansSemi, color: colors.textEmphasis, flex: 1 },
  sectionBreak: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    marginTop: 4,
    paddingTop: 12,
  },
  row: { flexDirection: "row", direction: "ltr", gap: 8, alignItems: "stretch" },
  choice: {
    minHeight: TOUCH_MIN,
    minWidth: 0,
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  rowChoice: { flex: 1 },
  choiceLabel: { ...typography.bodySm, color: colors.textDefault, flexShrink: 1 },
  selected: { borderColor: colors.textEmphasis, backgroundColor: colors.bgSubtle },
  code: { writingDirection: "ltr", textAlign: "left", fontFamily: fonts.monoMedium },
  disabled: { opacity: 0.4 },
  pressed: { backgroundColor: colors.bgMuted },
  currencyChoices: { flexDirection: "row", direction: "ltr", gap: 8 },
  currencyScroll: { flexGrow: 0, maxWidth: "100%", direction: "ltr" },
  sortRows: { gap: 8 },
  help: { ...typography.hint, color: colors.textSubtle, paddingHorizontal: 4 },
  clear: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    marginTop: 4,
  },
  clearText: { ...typography.bodySm, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
});
