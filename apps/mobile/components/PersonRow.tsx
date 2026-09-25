import { Ionicons } from "@expo/vector-icons";
import { SharedAccountBadge } from "./SharedAccountBadge";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount, formatRelative } from "../lib/format";
import { t } from "../lib/i18n";
import { icon } from "../lib/tokens";
import type { PersonWithBalance } from "../lib/types";

// Stacked-card list row. Designed to live inside a rounded container with
// borderWidth:1 and divider Views between rows.
//
// `balance` is signed at the type level but the row always shows the absolute
// amount — direction is conveyed by the active tab, not by the row.
//
// Memoized, and the callbacks take the person so parents can pass STABLE
// handlers — home renders every person in two lists, and without the memo a
// toast push (which re-renders the whole screen twice via the toast context)
// re-rendered hundreds of rows on low-end devices.
export const PersonRow = memo(function PersonRow(props: {
  person: PersonWithBalance;
  onPress: (person: PersonWithBalance) => void;
  onLongPress?: (person: PersonWithBalance) => void;
}) {
  const isRTL = useIsRTL();
  const { person } = props;
  const abs = Math.abs(person.balance);
  // Deliberately settled (user drew the line, balance zero, nothing since) —
  // NOT the same as a balance that merely sums to zero. Settled rows get a
  // check mark instead of "0 ؋"; zero-but-unsettled rows keep the muted 0.
  const settled = person.is_settled === 1;
  // Every row reads as a plain timeline — no "settled X ago" wording
  // (operator decision 2026-07-27: the check mark carries the state).
  const timeline = !person.last_entry_at
    ? t("person.row.noEntries")
    : formatRelative(person.last_entry_at);
  // Mutual tab (docs/mutual-tab-design.md §4.4): tallies the OTHER party
  // added that this side has not reviewed lead the subtitle. On the sub line,
  // never in the amount column — that column is baseline-aligned between the
  // figure and its currency and switches to the settled tick; a pill stacked
  // there would break both. "{n} to review", not "pending": a tally already
  // counts (D6), so the only thing waiting is the shopkeeper's glance.
  const subtitle =
    person.tab_id && person.tab_pending > 0
      ? `${t("tab.row.pending", { count: person.tab_pending })} · ${timeline}`
      : timeline;

  return (
    <Pressable
      onPress={() => props.onPress(person)}
      onLongPress={props.onLongPress ? () => props.onLongPress?.(person) : undefined}
      delayLongPress={350}
      accessibilityRole="button"
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
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
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
          {person.tab_id && person.tab_closed_at == null ? <SharedAccountBadge /> : null}
        </View>
        <Text style={[styles.sub, textDir(isRTL)]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={[styles.right, rowDir(isRTL), settled && { alignItems: "center" }]}>
        {settled ? (
          // Cleared account: the mark, not a meaningless zero. Grey, not
          // emerald — emerald/garnet are strictly directional (money toward
          // you / away from you) and a settled account has no direction. Grey
          // rather than the ink black used for live amounts, too: a settled
          // row is finished business and shouldn't pull the eye harder than
          // the balances that still need attention.
          //
          // Bare "checkmark", not "checkmark-circle": the tick alone is the
          // tally mark a shopkeeper draws when an account is cleared, and the
          // circle read as a status badge. Sized icon.row (22) rather than the
          // 20 the circled version used — dropping the disc removes most of the
          // glyph's ink, so at the same nominal size it reads visibly lighter
          // than the 15px amount it replaces in this column.
          <Ionicons name="checkmark" size={icon.row} color={colors.textSubtle} />
        ) : (
          <>
            {/* L41: cap the amount's font scaling so it can't grow so wide at
                large OS font that it crushes the flex:1 name column. */}
            <Text
              style={[styles.amount, abs === 0 && { color: colors.textMuted }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.5}
            >
              {formatAmount(abs)}
            </Text>
            <Text style={styles.afn} maxFontSizeMultiplier={1.5}>
              {getCurrentCurrencySymbol()}
            </Text>
          </>
        )}
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
  },
  afn: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
  },
});
