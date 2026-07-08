import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount, formatRelative } from "../lib/format";
import { t } from "../lib/i18n";
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
  const subtitle = !person.last_entry_at
    ? t("person.row.noEntries")
    : person.balance === 0
      ? // Settled rows keep their relative date too ("settled 3d ago") so the
        // list still reads as a timeline and a freshly-cleared tally is obvious.
        t("person.row.settledAgo", { time: formatRelative(person.last_entry_at) })
      : formatRelative(person.last_entry_at);

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
        <Text style={[styles.name, textDir(isRTL)]} numberOfLines={1}>
          {person.name}
        </Text>
        <Text style={[styles.sub, textDir(isRTL)]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={[styles.right, rowDir(isRTL)]}>
        {/* L41: cap the amount's font scaling so it can't grow so wide at large
            OS font that it crushes the flex:1 name column to a few characters. */}
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
