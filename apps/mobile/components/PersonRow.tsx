import { Ionicons } from "@expo/vector-icons";
import { SharedAccountBadge } from "./SharedAccountBadge";
import { CreditStatusBadge, type CreditStatus } from "./CreditStatusBadge";
import { memo, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencyCode, getCurrencyLabel } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount, formatRelative } from "../lib/format";
import { t } from "../lib/i18n";
import { icon } from "../lib/tokens";
import type { PersonWithBalance } from "../lib/types";
import { SelectionMark } from "./SelectionMark";
import { personCurrencyRows } from "../lib/multi-currency-view";
import { personSharedAccountStatus } from "../lib/tabs/link-status";

// Stacked-card list row. Designed to live inside a rounded container with
// borderWidth:1 and divider Views between rows.
//
// Direction comes from the containing tab on home. Mixed search results use a
// signed amount so balances from both directions stay clear in the same list.
//
// Memoized, and the callbacks take the person so parents can pass STABLE
// handlers — home can show hundreds of customers, and without the memo a
// toast push (which re-renders the whole screen twice via the toast context)
// re-rendered hundreds of rows on low-end devices.
export const PersonRow = memo(function PersonRow(props: {
  person: PersonWithBalance;
  onPress: (person: PersonWithBalance) => void;
  onLongPress?: (person: PersonWithBalance) => void;
  creditStatus?: CreditStatus;
  sharedStatus?: ReturnType<typeof personSharedAccountStatus>;
  showDirection?: boolean;
  selecting?: boolean;
  selected?: boolean;
  disabled?: boolean;
}) {
  const isRTL = useIsRTL();
  const { person } = props;
  const sharedStatus = props.sharedStatus ?? personSharedAccountStatus(person);
  const activePress = useRef<{ personId: string } | null>(null);
  // Deliberately settled (user drew the line, balance zero, nothing since) —
  // NOT the same as a balance that merely sums to zero. Settled rows get a
  // check mark instead of "0 ؋"; zero-but-unsettled rows keep the muted 0.
  // Every row reads as a plain timeline — no "settled X ago" wording
  // (operator decision 2026-07-27: the check mark carries the state).
  const timeline = !person.last_entry_at
    ? t("person.row.noEntries")
    : formatRelative(person.last_entry_at);
  // Mutual tab (docs/mutual-tab-design.md §4.4): tallies the OTHER party
  // added that this side has not reviewed lead the subtitle. On the sub line,
  // never in the amount column — that column is baseline-aligned between the
  // figure and its currency and switches to the settled tick; a pill stacked
  // there would break both. Pending changes never contribute to the confirmed
  // amount. Both sides can see that an acknowledgement is still outstanding.
  // A shared account found on this phone but not downloaded yet has no known
  // balance: say so rather than show a false 0.
  const unsynced = person.tab_unsynced === 1;
  const activitySubtitle = unsynced
    ? t("tab.row.notDownloaded")
    : person.tab_id && person.tab_pending > 0
      ? `${t("tab.row.pending", { count: person.tab_pending })} · ${timeline}`
      : (person.tab_pending_count ?? 0) > 0
        ? `${t("tab.row.awaiting", { count: person.tab_pending_count ?? 0 })} · ${timeline}`
        : timeline;
  const subtitle =
    sharedStatus === "waiting"
      ? `${t("tab.chip.waiting")} · ${activitySubtitle}`
      : activitySubtitle;

  return (
    <Pressable
      onPressIn={() => {
        activePress.current = { personId: person.id };
      }}
      onPressOut={() => {
        const press = activePress.current;
        // Pressability can call onPress immediately after onPressOut. Keep
        // that release bound to its original customer until this turn ends.
        queueMicrotask(() => {
          if (activePress.current === press) activePress.current = null;
        });
      }}
      onPress={() => {
        if (activePress.current && activePress.current.personId !== person.id) return;
        props.onPress(person);
      }}
      // Pressability checks the CURRENT handler on release. Entering selection
      // removes the parent's start handler, so keep one installed while selecting
      // or that same hold becomes an onPress and immediately deselects the row.
      onLongPress={
        props.onLongPress || props.selecting
          ? () => {
              if (activePress.current && activePress.current.personId !== person.id) return;
              if (props.selecting) props.onPress(person);
              else props.onLongPress?.(person);
            }
          : undefined
      }
      delayLongPress={350}
      disabled={props.disabled}
      accessibilityRole={props.selecting ? "checkbox" : "button"}
      accessibilityState={
        props.selecting ? { checked: !!props.selected, disabled: !!props.disabled } : undefined
      }
      // The long-press edit/remove sheet is invisible to assistive tech
      // without an explicit action — TalkBack exposes this as a custom
      // action ("activate" stays the plain tap).
      accessibilityActions={
        props.onLongPress ? [{ name: "longpress", label: t("common.remove") }] : undefined
      }
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "longpress") props.onLongPress?.(person);
      }}
      style={({ pressed }) => [
        styles.row,
        rowDir(isRTL),
        props.selected && { backgroundColor: colors.bgSubtle },
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      {props.selecting ? (
        <View style={isRTL ? styles.selectionRTL : styles.selectionLTR}>
          <SelectionMark selected={!!props.selected} />
        </View>
      ) : null}
      <View
        style={[
          styles.left,
          // Mirror the spacing side that pushes the amount away when row
          // direction flips. In LTR, marginRight gives name-block space
          // before the amount on the right. In RTL, the amount is on the
          // left, so we need that gap on the marginLeft.
          isRTL ? styles.leftRTL : styles.leftLTR,
        ]}
      >
        <View style={[styles.nameRow, rowDir(isRTL)]}>
          <Text style={[styles.name, styles.nameText, textDir(isRTL)]} numberOfLines={1}>
            {person.name}
          </Text>
          {sharedStatus === "joined" ? (
            <SharedAccountBadge name={person.name} fontSize={styles.name.fontSize} />
          ) : null}
        </View>
        <Text style={[styles.sub, textDir(isRTL)]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={{ alignItems: isRTL ? "flex-start" : "flex-end" }}>
        {personCurrencyRows(person).map((row) => {
          const code = row.currency ?? getCurrentCurrencyCode();
          const value = formatAmount(Math.abs(row.balance));
          const tone =
            row.balance > 0
              ? colors.collectStrong
              : row.balance < 0
                ? colors.payStrong
                : colors.textMuted;
          return (
            <View key={code} style={[styles.right, { direction: "ltr", marginTop: 3 }]}>
              {row.is_settled === 1 ? (
                <Ionicons
                  name="checkmark"
                  size={icon.row}
                  color={colors.textSubtle}
                  accessibilityLabel={`${t("person.balance.settled")}, ${getCurrencyLabel(code)}`}
                />
              ) : (
                <Text
                  style={[styles.amount, { color: tone }]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.5}
                  accessibilityLabel={
                    row.tab_unsynced === 1
                      ? t("tab.notDownloaded")
                      : `${row.balance === 0 ? "" : t(row.balance > 0 ? "home.tab.collect" : "home.tab.pay") + ", "}${value} ${getCurrencyLabel(code)}`
                  }
                >
                  {row.tab_unsynced === 1
                    ? "…"
                    : (props.showDirection && row.balance !== 0
                        ? row.balance > 0
                          ? "+"
                          : "−"
                        : "") + value}
                </Text>
              )}
              {row.is_settled !== 1 ? (
                <Text style={styles.afn} maxFontSizeMultiplier={1.5}>
                  {code}
                </Text>
              ) : null}
            </View>
          );
        })}
        <CreditStatusBadge status={props.creditStatus ?? "none"} />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.bgDefault,
  },
  left: { flex: 1 },
  selectionLTR: { marginRight: 12 },
  selectionRTL: { marginLeft: 12 },
  leftLTR: { marginRight: 12 },
  leftRTL: { marginLeft: 12 },
  // Name + optional link glyph on one line. The glyph is fixed; the name
  // shrinks (flexShrink + minWidth:0) so a long name ellipsizes BEFORE the
  // mark that says the account is shared is pushed out of the row.
  nameRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  nameText: { flexShrink: 1, minWidth: 0 },
  name: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  sub: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
  },
  right: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  amount: {
    fontSize: 15,
    fontFamily: fonts.monoSemi,
    color: colors.textEmphasis,
    writingDirection: "ltr",
  },
  afn: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
  },
});
