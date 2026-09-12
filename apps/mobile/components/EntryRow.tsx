import { Ionicons } from "@expo/vector-icons";
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { useCalendar } from "../lib/calendar";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { formatAmount, formatRelative, formatTimestamp } from "../lib/format";
import { t } from "../lib/i18n";
import { radius } from "../lib/tokens";
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
  useCalendar(); // This memoized row must also refresh when its calendar changes.
  const { entry } = props;
  const isGave = entry.type === "debt";
  const icon = isGave ? "arrow-up-outline" : "arrow-down-outline";
  const verb = isGave ? t("person.action.iGave") : t("person.action.iReceived");
  // Direction by color (Khatabook flow): "I gave" = value out → pay side;
  // "I received" = value in → collect side. Same axis as the balance, so one
  // color always means "money toward you".
  const tint = isGave
    ? { bg: colors.payBg, fg: colors.payStrong }
    : { bg: colors.collectBg, fg: colors.collectStrong };

  // Note expansion: clamped to 1 line; a TAP expands/collapses, but only once
  // we've measured that the note actually overflows (`clipped`). A plain tap on
  // a note-less / short-note row still does nothing (a tally is informational).
  const [measured, setMeasured] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showTimestamp, setShowTimestamp] = useState(false);
  const when = showTimestamp
    ? formatTimestamp(entry.created_at)
    : formatRelative(entry.created_at, Date.now(), { alwaysRelative: true });
  const timestampAction = t(showTimestamp ? "entry.showRelativeTime" : "entry.showExactTime");

  return (
    <Pressable
      // A row tap expands a clipped note; the date has its own independent
      // toggle below. The edit/delete sheet stays on TAP-AND-HOLD — like contact
      // rows. delayLongPress 250ms so a quick tap doesn't accidentally trigger
      // it; Pressable cancels if the finger moves enough to start a scroll, so
      // it doesn't fight the list's vertical scroll.
      onPress={clipped ? () => setExpanded((v) => !v) : undefined}
      onLongPress={props.onLongPress ? () => props.onLongPress?.(entry) : undefined}
      delayLongPress={250}
      accessibilityRole="button"
      // VoiceOver may group nested controls into this row. Expose the date
      // toggle as an explicit action as well as its visual touch target.
      accessibilityActions={[
        { name: "toggleTimestamp", label: timestampAction },
        ...(clipped
          ? [{ name: "activate", label: t(expanded ? "common.less" : "common.more") }]
          : []),
        ...(props.onLongPress ? [{ name: "longpress", label: t("entry.options") }] : []),
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "toggleTimestamp") setShowTimestamp((value) => !value);
        else if (event.nativeEvent.actionName === "activate" && clipped)
          setExpanded((value) => !value);
        else if (event.nativeEvent.actionName === "longpress") props.onLongPress?.(entry);
      }}
      style={({ pressed }) => [
        styles.row,
        rowDir(isRTL),
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: tint.bg },
          isRTL ? styles.iconWrapRTL : styles.iconWrapLTR,
        ]}
        // Direction is shown by the arrow's shape AND its color (red = I gave /
        // money out, green = I received / money in) — there's no text label —
        // so carry it for screen readers here.
        accessible
        accessibilityLabel={verb}
      >
        {/* 16 inside the 32×32 well is a composed graphic (half the tile), not
            a token slot — icon.trailing happens to be 16 but means "chevron in
            a row". Left as a literal so the arrow's ratio to its well stays. */}
        <Ionicons name={icon} size={16} color={tint.fg} />
      </View>
      <View style={styles.middle}>
        {/* Amount on the leading end, date on the trailing end — the arrow
            carries direction, so the verb label is gone. */}
        <View style={[styles.topRow, rowDir(isRTL), showTimestamp && styles.topRowExpanded]}>
          <View style={[styles.amountRow, rowDir(isRTL)]}>
            <Text style={styles.amount}>{formatAmount(entry.amount_afn)}</Text>
            <Text style={styles.afn}>{getCurrentCurrencySymbol()}</Text>
          </View>
          <Pressable
            onPress={(event) => {
              event.stopPropagation();
              setShowTimestamp((value) => !value);
            }}
            onLongPress={props.onLongPress ? () => props.onLongPress?.(entry) : undefined}
            delayLongPress={250}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`${when}. ${timestampAction}`}
            accessibilityState={{ expanded: showTimestamp }}
            style={[
              styles.whenToggle,
              {
                alignSelf: showTimestamp ? (isRTL ? "flex-start" : "flex-end") : "auto",
                marginLeft: isRTL ? 0 : "auto",
                marginRight: isRTL ? "auto" : 0,
              },
            ]}
          >
            <Text style={[styles.when, { textAlign: isRTL ? "left" : "right" }]}>{when}</Text>
          </Pressable>
        </View>
        {entry.note ? (
          expanded ? (
            // Expanded: the full note renders as a single text block, with the
            // "less" cue flowing INLINE at the very end of the text. A nested
            // <Text> stays in the text flow, so the cue trails the last word
            // instead of floating in a baseline-aligned column to the right of
            // the first line (which is what a flex sibling did — and a
            // multi-line flex child under alignItems:'baseline' also clipped the
            // text on Android). A plain block <Text> wraps cleanly, every line.
            <Text style={[styles.noteBlock, textDir(isRTL)]} accessibilityLabel={entry.note}>
              {entry.note}
              {"  "}
              <Text style={styles.more}>{t("common.less")}</Text>
            </Text>
          ) : (
            // Collapsed: the note clamps to ONE line and the "more" cue trails
            // it on the SAME line — shown only once we've measured the note
            // overflows. The first paint renders unclamped so onTextLayout can
            // count the true line span, then it clamps to 1.
            //
            // The flex:1 lives on a wrapping <View>, NOT on the <Text> itself:
            // on iOS a flex:1 <Text numberOfLines={1}> computes its full
            // (untruncated) width during layout and won't cede room to a row
            // sibling, which bumped the cue onto its own line below. A View
            // wrapper gives the <Text> a definite width to ellipsize within and
            // keeps the cue inline at the end of the truncated line.
            <View style={[styles.noteRow, rowDir(isRTL)]}>
              <View style={styles.noteFlex}>
                <Text
                  style={[styles.note, textDir(isRTL)]}
                  numberOfLines={measured ? 1 : undefined}
                  // Full note for screen readers, regardless of the visual clamp.
                  accessibilityLabel={entry.note}
                  onTextLayout={(e) => {
                    if (!measured) {
                      setClipped(e.nativeEvent.lines.length > 1);
                      setMeasured(true);
                    }
                  }}
                >
                  {entry.note}
                </Text>
              </View>
              {measured && clipped ? <Text style={styles.more}>{t("common.more")}</Text> : null}
            </View>
          )
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
    borderRadius: radius.sm, // 8, unchanged — the small icon-tile step
    backgroundColor: colors.bgSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapLTR: { marginRight: 12 },
  iconWrapRTL: { marginLeft: 12 },
  middle: { flex: 1, minWidth: 0 },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  topRowExpanded: { flexDirection: "column", alignItems: "stretch", gap: 2 },
  amountRow: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  amount: {
    fontSize: 15,
    // Bold (not semibold) so the number is unmistakably the row's anchor,
    // a clear step above the date beside it.
    fontFamily: fonts.monoBold,
    color: colors.textEmphasis,
  },
  afn: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
  },
  whenToggle: {
    maxWidth: "100%",
    flexShrink: 1,
    minHeight: 28, // Compact ledger control; hitSlop adds padding within the row.
    justifyContent: "center",
  },
  when: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(12, 17),
    textDecorationLine: "underline",
  },
  // Note + cue share one line; the cue trails the single-line (truncating) note.
  // alignItems:'center', NOT 'baseline' — a flex:1 child (the note wrapper)
  // under baseline alignment is mis-measured by Yoga and shoves the trailing
  // cue onto its own line below. This mirrors the proven home PersonRow row
  // (center-aligned, flex:1 text wrapper + trailing amount on one line).
  noteRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 5,
    gap: 6,
  },
  note: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: sansLineHeight(13, 18),
  },
  // The flex lives on this wrapper (see the collapsed branch), not on the
  // truncating <Text>, so the cue stays inline at the end of the clamped line.
  // minWidth:0 lets it shrink below the note's intrinsic width on every engine.
  noteFlex: { flex: 1, minWidth: 0 },
  // Expanded note: a free-flowing block (no flex / no baseline row), so a
  // multi-line note renders every line and the inline "less" cue trails the
  // last word. Same type as `note` minus the flex:1 (which would stretch a
  // child of the column-direction `middle` view vertically).
  noteBlock: {
    marginTop: 5,
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: sansLineHeight(13, 18),
  },
  more: {
    fontSize: 12,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
});
