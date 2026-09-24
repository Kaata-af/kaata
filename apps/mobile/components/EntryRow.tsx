import { Ionicons } from "@expo/vector-icons";
import { memo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { InitialAvatar } from "./InitialAvatar";
import { chipActorFor, initialOf, memberTintFor, type EntryAttribution } from "../lib/attribution";
import { colors } from "../lib/colors";
import { useCalendar } from "../lib/calendar";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { formatAmount, formatRelative, formatTimestamp } from "../lib/format";
import { t } from "../lib/i18n";
import { radius } from "../lib/tokens";
import type { TabEntryMeta } from "../lib/tabs/types";
import type { Entry } from "../lib/types";

// The author chip's diameter. 20 is not a round number pulled from the air:
// it is the line box of the 15px JetBrains Mono amount sitting beside it
// (15 × 1.32 ≈ 19.8), so the chip occupies height the row already had and the
// tally list's vertical rhythm is untouched by turning attribution on.
const AUTHOR_CHIP_SIZE = 20;

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
  // Who wrote / last changed this tally. Undefined in a SOLO kaata, where the
  // answer is always "you" and a chip would be pure noise — the caller decides
  // that (app/person/[id].tsx), so this component stays dumb about membership.
  attribution?: EntryAttribution;
  // Mutual-tab meta (docs/mutual-tab-design.md §4.4), present only on a
  // linked contact's rows. A sibling of `attribution`, not an overload of it:
  // the tab counterparty is not a kaata member, has no account id and no
  // member tint, so nothing in the attribution machinery can describe them.
  // The caller passes `entry.tab` straight through.
  tab?: TabEntryMeta;
  onAccept?: (entry: Entry) => void | Promise<void>;
  onReject?: (entry: Entry) => void | Promise<void>;
}) {
  const isRTL = useIsRTL();
  useCalendar(); // This memoized row must also refresh when its calendar changes.
  const { entry, tab } = props;
  const voided = tab?.voided === true;
  const isGave = entry.type === "debt";
  const icon = isGave ? "arrow-up-outline" : "arrow-down-outline";
  const verb = isGave ? t("person.action.iGave") : t("person.action.iReceived");
  // Direction by color (Khatabook flow): "I gave" = value out → pay side;
  // "I received" = value in → collect side. Same axis as the balance, so one
  // color always means "money toward you".
  const tint = isGave
    ? { bg: colors.payBg, fg: colors.payStrong }
    : { bg: colors.collectBg, fg: colors.collectStrong };

  // ONE open/closed state per row (Matee, 2026-09): a tap anywhere on the
  // tally is the toggle, exactly like the note's more/less. Open shows the
  // exact date and time in the date's own slot (never dropped under the
  // amount) and, when the note is clipped, expands the note in the same tap;
  // closed shows the relative time and the one-line note. The note only
  // expands once we've measured that it actually overflows (`clipped`), so a
  // short note never grows a "less" cue.
  const [measured, setMeasured] = useState(false);
  const [clipped, setClipped] = useState(false);
  const reviewBusy = useRef(false);
  const [reviewing, setReviewing] = useState(false);
  const review = async (action: (entry: Entry) => void | Promise<void>) => {
    if (reviewBusy.current) return;
    reviewBusy.current = true;
    setReviewing(true);
    try {
      await action(entry);
    } finally {
      reviewBusy.current = false;
      setReviewing(false);
    }
  };
  const [open, setOpen] = useState(false);
  const expanded = open && clipped;
  const when = open
    ? formatTimestamp(entry.created_at)
    : formatRelative(entry.created_at, Date.now(), { alwaysRelative: true });
  const toggleLabel = t(open ? "entry.showRelativeTime" : "entry.showExactTime");

  // ATTRIBUTION (shared kaatas only; see the prop's comment).
  //
  // Collapsed, it is one 20px tinted initial in the meta slot and nothing
  // else — the brief was "vivid enough to notice, not big enough to ruin the
  // look". 20px is the exact line box of the 15px mono amount beside it, so
  // the chip adds a hue to the row without adding a pixel of height, and it
  // appears ONLY on rows somebody else touched, so a ledger you keep alone
  // looks exactly as it did before.
  //
  // Opened, the row spells the whole thing out in words. That is where a name
  // belongs: the trailing slot already carries the exact date and time after
  // a tap, and stacking a name in there would squeeze one of the two.
  const chipActor = chipActorFor(props.attribution);
  const chipTint = chipActor ? memberTintFor(chipActor.accountId) : null;
  const nameOf = (actor: { name: string | null; isSelf: boolean }) =>
    actor.isSelf ? t("entry.by.you") : (actor.name ?? t("entry.by.someone"));
  const author = props.attribution?.author ?? null;
  const editor = props.attribution?.editor ?? null;
  const memberByLine = author
    ? t("entry.addedBy", { name: nameOf(author) }) +
      (editor ? ` · ${t("entry.editedBy", { name: nameOf(editor) })}` : "")
    : editor
      ? t("entry.editedByOnly", { name: nameOf(editor) })
      : null;

  // TAB STATUS (linked contacts only). Same two-level design as attribution:
  // collapsed, at most ONE monochrome word in a pill that fits the amount's
  // line box; opened, the full sentence. Accepted rows show nothing — a
  // tally counts the moment it lands (D6), so acknowledgement is the quiet
  // default and only the exceptions speak: "New" is theirs and unreviewed,
  // "Disputed" and "Voided" are the two states that change what the row
  // means, "Sending…" is this phone's own row the server has not acked.
  //
  // Monochrome on purpose: emerald and garnet already mean give/receive on
  // this very row, and danger means destructive. A red "Disputed" next to a
  // red "I gave" arrow would read as one thing when it is two.
  const pill = tab
    ? voided
      ? t("tab.status.voided")
      : tab.local_pending
        ? t("tab.status.sending")
        : tab.status === "disputed"
          ? t("tab.status.disputed")
          : tab.by === "them" && tab.status === "pending"
            ? t("tab.status.new")
            : null
    : null;
  // On a tab row the author is one of exactly two parties, so the by-line is
  // decided here and REPLACES the member by-line (a kaata member who wrote a
  // tab tally still acted as "you", the kaata side of the tab).
  const byLine = tab
    ? tab.by === "me"
      ? t("tab.addedByYou")
      : t("tab.addedBy", { name: tab.other_label || t("tab.them") })
    : memberByLine;
  const disputeLine =
    tab && tab.status === "disputed" && !voided && tab.dispute_reason
      ? t("tab.disputedReason", { reason: tab.dispute_reason })
      : null;

  // An opening entry deliberately carries NO note on the wire: "the balance
  // carried over" is structural, not something the author wrote, so each side
  // labels it in ITS OWN language. (The web page does the same — a Dari
  // customer must not read the shopkeeper's English.) A note the author
  // actually typed always wins.
  const note = entry.note ?? (tab?.kind === "opening" ? t("tab.opening.note") : null);

  return (
    <View>
      <Pressable
        // A row tap toggles the row open/closed (exact time + note). The
        // edit/delete sheet stays on TAP-AND-HOLD — like contact rows.
        // delayLongPress 250ms so a quick tap doesn't accidentally trigger it;
        // Pressable cancels if the finger moves enough to start a scroll, so it
        // doesn't fight the list's vertical scroll.
        onPress={() => setOpen((value) => !value)}
        onLongPress={props.onLongPress ? () => props.onLongPress?.(entry) : undefined}
        delayLongPress={250}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={toggleLabel}
        accessibilityActions={[
          { name: "activate", label: toggleLabel },
          ...(props.onLongPress ? [{ name: "longpress", label: t("entry.options") }] : []),
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "activate") setOpen((value) => !value);
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
            // A voided tally keeps its arrow (the audit trail says what it WAS,
            // D5) at half strength, so the eye reads "cancelled" before "gave".
            voided && styles.voidedTile,
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
          <View style={[styles.topRow, rowDir(isRTL)]}>
            <View style={[styles.amountRow, rowDir(isRTL)]}>
              {/* Struck, not hidden: the number stays legible under the line so
                both parties can still see what was cancelled. */}
              <Text style={[styles.amount, voided && styles.voidedAmount]}>
                {formatAmount(entry.amount_afn)}
              </Text>
              <Text style={styles.afn}>{getCurrentCurrencySymbol()}</Text>
            </View>
            {/* The date stays in its trailing slot in both states; it only
              shrinks (never the amount) if the exact form needs the room. The
              author chip rides in front of it, outside the shrinking text, so
              a long exact timestamp ellipsizes the DATE rather than crushing
              the one element that is a fixed-size graphic. */}
            <View style={[styles.meta, rowDir(isRTL)]}>
              {/* Status pill: a fixed AUTHOR_CHIP_SIZE tall, so like the author
                chip it costs the row no height. Text never scales — a scaled
                word would overflow the fixed box, and this is a one-word
                status the opened row spells out in full anyway. */}
              {pill ? (
                <View style={styles.statusPill} accessible accessibilityLabel={pill}>
                  <Text style={styles.statusPillText} allowFontScaling={false} numberOfLines={1}>
                    {pill}
                  </Text>
                </View>
              ) : null}
              {chipActor && chipTint ? (
                <View
                  accessible
                  accessibilityLabel={
                    author && author.accountId === chipActor.accountId
                      ? t("entry.addedBy", { name: nameOf(chipActor) })
                      : t("entry.editedByOnly", { name: nameOf(chipActor) })
                  }
                >
                  <InitialAvatar
                    label={initialOf(chipActor.name)}
                    size={AUTHOR_CHIP_SIZE}
                    backgroundColor={chipTint.bg}
                    color={chipTint.fg}
                  />
                </View>
              ) : null}
              {/* One line, always. Before the chip existed this could wrap, and
                a wrapped date would now grow the row on every tap — the one
                thing attribution was not allowed to cost. There is room to
                spare for both forms at phone width; the amount never yields
                (flexShrink:0), so only the date can give. */}
              <Text
                numberOfLines={1}
                style={[styles.when, { textAlign: isRTL ? "left" : "right" }]}
              >
                {when}
              </Text>
            </View>
          </View>
          {note ? (
            expanded ? (
              // Expanded: the full note renders as a single text block, with the
              // "less" cue flowing INLINE at the very end of the text. A nested
              // <Text> stays in the text flow, so the cue trails the last word
              // instead of floating in a baseline-aligned column to the right of
              // the first line (which is what a flex sibling did — and a
              // multi-line flex child under alignItems:'baseline' also clipped the
              // text on Android). A plain block <Text> wraps cleanly, every line.
              <Text style={[styles.noteBlock, textDir(isRTL)]} accessibilityLabel={note}>
                {note}
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
                    accessibilityLabel={note}
                    onTextLayout={(e) => {
                      if (!measured) {
                        setClipped(e.nativeEvent.lines.length > 1);
                        setMeasured(true);
                      }
                    }}
                  >
                    {note}
                  </Text>
                </View>
                {measured && clipped ? <Text style={styles.more}>{t("common.more")}</Text> : null}
              </View>
            )
          ) : null}
          {/* The full story, only once the row is open. Rendered even when the
            chip is absent — a tally you wrote that nobody else has touched
            still answers "who wrote this" when you ask it directly, and on a
            shared ledger that reassurance is the other half of the feature. */}
          {open && byLine ? (
            <Text style={[styles.byLine, textDir(isRTL)]} numberOfLines={2}>
              {byLine}
            </Text>
          ) : null}
          {/* The dispute reason is the other party's words about THIS tally,
            so it gets the full width and no clamp: a shopkeeper resolving a
            dispute needs the whole sentence, not its first line. "Voided"
            repeats the pill in prose so the opened row is complete on its own. */}
          {open && disputeLine ? (
            <Text style={[styles.byLine, textDir(isRTL)]}>{disputeLine}</Text>
          ) : null}
          {open && tab?.status === "disputed" && !voided ? (
            <Text style={[styles.byLine, textDir(isRTL)]}>{t("tab.rejectedHint")}</Text>
          ) : null}
          {open && voided ? (
            <Text style={[styles.byLine, textDir(isRTL)]}>{t("tab.status.voided")}</Text>
          ) : null}
        </View>
      </Pressable>
      {tab &&
      tab.by === "them" &&
      !voided &&
      !tab.local_pending &&
      (tab.status === "pending" || open) &&
      (props.onAccept || props.onReject) ? (
        <View style={[styles.reviewRow, rowDir(isRTL)]}>
          {props.onAccept ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("tab.accept")}
              accessibilityState={{ disabled: reviewing || tab.status === "accepted" }}
              disabled={reviewing || tab.status === "accepted"}
              onPress={() => void review(props.onAccept!)}
              style={({ pressed }) => [
                styles.reviewButton,
                rowDir(isRTL),
                (pressed || reviewing) && { opacity: 0.5 },
              ]}
            >
              <Ionicons name="checkmark-outline" size={18} color={colors.textEmphasis} />
              <Text style={styles.reviewLabel}>
                {t(tab.status === "accepted" ? "tab.accepted" : "tab.accept")}
              </Text>
            </Pressable>
          ) : null}
          <View style={styles.reviewDivider} />
          {props.onReject ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("tab.reject")}
              accessibilityState={{ disabled: reviewing || tab.status === "disputed" }}
              disabled={reviewing || tab.status === "disputed"}
              onPress={() => void review(props.onReject!)}
              style={({ pressed }) => [
                styles.reviewButton,
                rowDir(isRTL),
                (pressed || reviewing) && { opacity: 0.5 },
              ]}
            >
              <Ionicons name="close-outline" size={18} color={colors.textEmphasis} />
              <Text style={styles.reviewLabel}>
                {t(tab.status === "disputed" ? "tab.status.disputed" : "tab.reject")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  reviewRow: {
    marginHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    alignItems: "center",
  },
  reviewButton: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 6 },
  reviewDivider: {
    width: StyleSheet.hairlineWidth,
    height: 16,
    backgroundColor: colors.borderDefault,
  },
  reviewLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 17),
    color: colors.textSubtle,
  },
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
  voidedTile: { opacity: 0.5 },
  // textMuted, not textSubtle: the strike already says "gone"; the colour
  // only has to stop the number competing with the live ones around it.
  voidedAmount: { textDecorationLine: "line-through", color: colors.textMuted },
  // Monochrome micro-pill (the person header's readOnlyChip idiom), but with
  // a FIXED height instead of vertical padding: it must fit the 20px line box
  // of the amount beside it, and Vazirmatn's natural line height at 11px
  // already exceeds that on iOS with any padding at all.
  statusPill: {
    height: AUTHOR_CHIP_SIZE,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  statusPillText: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(11, 14),
  },
  middle: { flex: 1, minWidth: 0 },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  // Trailing meta: the author chip (fixed) + the date (shrinks). flexShrink on
  // the WRAPPER, minWidth:0 so it can go below the date's intrinsic width.
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    minWidth: 0,
    justifyContent: "flex-end",
  },
  amountRow: { flexDirection: "row", alignItems: "baseline", gap: 4, flexShrink: 0 },
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
  when: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(12, 17),
    flexShrink: 1,
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
  // One step quieter than the note (textSubtle, not textDefault): it is
  // provenance, not content, and it must never out-weigh the note it sits
  // under.
  byLine: {
    marginTop: 5,
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(12, 17),
  },
});
