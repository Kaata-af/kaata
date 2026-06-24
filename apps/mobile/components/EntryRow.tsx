import { Ionicons } from "@expo/vector-icons";
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount, formatRelative } from "../lib/format";
import { t } from "../lib/i18n";
import type { Entry } from "../lib/types";

// type='debt'    → value left my hand  → "I gave"   → up arrow
// type='payment' → value came to me    → "I received" → down arrow
// Same in both directions; the row doesn't need to know which tab it lives in.
//
// Memoized with a person-style callback API (callback takes the entry) so
// parents can pass a stable handler — see PersonRow for rationale.
export const EntryRow = memo(function EntryRow(props: {
  entry: Entry;
  // Omitted for a viewer (read-only) — tap-and-hold opens the edit/delete sheet.
  onLongPress?: (entry: Entry) => void;
}) {
  const isRTL = useIsRTL();
  const { entry } = props;
  const isGave = entry.type === "debt";
  const icon = isGave ? "arrow-up-outline" : "arrow-down-outline";
  const verb = isGave ? t("person.action.iGave") : t("person.action.iReceived");

  // Note expansion: clamped to 2 lines; a TAP expands/collapses, but only once
  // we've measured that the note actually overflows (`clipped`). A plain tap on
  // a note-less / short-note row still does nothing (a tally is informational).
  const [measured, setMeasured] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable
      // A plain TAP does nothing (a tally is informational); the edit/delete
      // sheet opens only on TAP-AND-HOLD (Matee) — mirrors the home contact
      // rows. delayLongPress 250ms so a quick tap doesn't accidentally trigger
      // it; Pressable cancels if the finger moves enough to start a scroll, so
      // it doesn't fight the list's vertical scroll.
      onPress={clipped ? () => setExpanded((v) => !v) : undefined}
      onLongPress={props.onLongPress ? () => props.onLongPress?.(entry) : undefined}
      delayLongPress={250}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        rowDir(isRTL),
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <View style={[styles.iconWrap, isRTL ? styles.iconWrapRTL : styles.iconWrapLTR]}>
        <Ionicons name={icon} size={16} color={colors.textDefault} />
      </View>
      <View style={styles.middle}>
        {/* Amount on the leading end, "verb · date" on the trailing end. */}
        <View style={[styles.topRow, rowDir(isRTL)]}>
          <View style={[styles.amountRow, rowDir(isRTL)]}>
            <Text style={styles.amount}>{formatAmount(entry.amount_afn)}</Text>
            <Text style={styles.afn}>{getCurrentCurrencySymbol()}</Text>
          </View>
          <View style={[styles.metaRow, rowDir(isRTL)]}>
            <Text style={styles.verb}>{verb}</Text>
            <Text style={styles.dot}>·</Text>
            <Text style={styles.when}>{formatRelative(entry.created_at)}</Text>
          </View>
        </View>
        {entry.note ? (
          <View>
            <Text
              style={[styles.note, textDir(isRTL)]}
              numberOfLines={!measured ? undefined : expanded ? undefined : 2}
              // Full note for screen readers, regardless of the visual clamp.
              accessibilityLabel={entry.note}
              onTextLayout={(e) => {
                if (!measured) {
                  setClipped(e.nativeEvent.lines.length > 2);
                  setMeasured(true);
                }
              }}
            >
              {entry.note}
            </Text>
            {clipped ? (
              <Text style={[styles.more, textDir(isRTL)]}>
                {expanded ? t("common.less") : t("common.more")}
              </Text>
            ) : null}
          </View>
        ) : null}
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
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.bgSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapLTR: { marginRight: 12 },
  iconWrapRTL: { marginLeft: 12 },
  middle: { flex: 1 },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  amountRow: { flexDirection: "row", alignItems: "baseline", gap: 4 },
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
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },
  verb: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
  },
  dot: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textMuted,
    marginHorizontal: 5,
  },
  when: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },
  note: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    marginTop: 3,
  },
  more: {
    fontSize: 12,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    marginTop: 2,
  },
});
