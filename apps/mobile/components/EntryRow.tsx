import { Ionicons } from "@expo/vector-icons";
import { memo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { InitialAvatar } from "./InitialAvatar";
import { chipActorFor, initialOf, memberTintFor, type EntryAttribution } from "../lib/attribution";
import { colors } from "../lib/colors";
import { useCalendar } from "../lib/calendar";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../lib/direction";
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

// The review state's only colour: a dot inside the opened row's neutral pill.
const STATUS_DOT_SIZE = 6;

// The action pills reach up and down only. Button's default pill slop also
// reaches 8 sideways, so Reject's and Accept's slop would BOTH cover the 8px
// gap between them, and iOS and Android both hit-test the last sibling first:
// every tap in that gap would land on Accept, which is final and asks for no
// confirmation. With no sideways reach the gap belongs to neither pill, as it
// did before the pills, and the pill's 84px minWidth already clears 44pt.
const ACTION_HIT_SLOP = { top: 6, bottom: 6, left: 0, right: 0 } as const;

// Keep each language's word order while giving only the name semibold weight
// and body ink, one quiet step above the textSubtle line it sits in.
function namedByLine(
  key:
    | "entry.addedBy"
    | "entry.editedBy"
    | "entry.editedByOnly"
    | "tab.addedBy"
    | "tab.reviewedBy"
    | "tab.cancelledBy",
  name: string,
) {
  const [before, after] = t(key, { name: "\uFFFC" }).split("\uFFFC");
  return (
    <>
      {before}
      <Text style={styles.byName}>{name}</Text>
      {after}
    </>
  );
}

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
  // tab rows carry their server-recorded writer independently of local-vault
  // membership and its member tints.
  // The caller passes `entry.tab` straight through.
  tab?: TabEntryMeta;
  selfAccountId?: string | null;
  onAccept?: (entry: Entry) => void | Promise<void>;
  onReject?: (entry: Entry) => void | Promise<void>;
  onCancel?: (entry: Entry) => void | Promise<void>;
}) {
  const isRTL = useIsRTL();
  useCalendar(); // This memoized row must also refresh when its calendar changes.
  const { entry } = props;
  const tab = props.tab ?? entry.tab;
  const voided = tab?.voided === true;
  const excluded = voided || tab?.status === "disputed";
  const isGave = entry.type === "debt";
  const icon = isGave ? "arrow-up-outline" : "arrow-down-outline";
  const verb = isGave ? t("person.action.iGave") : t("person.action.iReceived");
  // Direction by color (Khatabook flow): "I gave" = value out → pay side;
  // "I received" = value in → collect side. Same axis as the balance, so one
  // color always means "money toward you".
  const tint = excluded
    ? { bg: colors.bgSubtle, fg: colors.textMuted }
    : isGave
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
  // Keep cancellations in storage and exports, but never in the visible list.
  // This follows every hook so a live cancellation does not change hook order.
  if (voided) return null;
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
    actor.isSelf
      ? actor.name?.trim()
        ? t("entry.by.self", { name: actor.name })
        : t("entry.by.you")
      : actor.name || t("entry.by.someone");
  const author = props.attribution?.author ?? null;
  const editor = props.attribution?.editor ?? null;
  const memberByLine = author ? (
    <>
      {namedByLine("entry.addedBy", nameOf(author))}
      {editor ? <> · {namedByLine("entry.editedBy", nameOf(editor))}</> : null}
    </>
  ) : editor ? (
    namedByLine("entry.editedByOnly", nameOf(editor))
  ) : null;

  // Review state is separate from money direction. Every synced tally has a
  // status, and it is QUIET (design "A · Quiet", 2026-10-03): no row tint and
  // no coloured button. A closed row carries it as ONE 6px dot before the time
  // (Matee: without it the state was "completely unknown unless I tap"); an
  // opened row spells it out in a neutral pill whose dot is the same colour.
  // The label and the dot come from ONE lookup so they can never disagree.
  const pending = tab?.status === "pending";
  const status = !tab
    ? null
    : tab.local_pending
      ? { label: t("tab.status.sending"), dot: colors.textMuted }
      : tab.status === "disputed"
        ? { label: t("tab.status.disputed"), dot: colors.reviewRejected }
        : tab.status === "accepted"
          ? { label: t("tab.status.accepted"), dot: colors.reviewAccepted }
          : { label: t("tab.status.pending"), dot: colors.reviewPending };
  const statusLabel = status?.label ?? null;
  // Visibility rules for the inline actions (docs/mutual-tab-design.md):
  // the other party's pending tally offers Accept/Reject even while collapsed;
  // your own pending tally offers Cancel only once opened. The two never meet.
  const showReview =
    !!tab &&
    tab.by === "them" &&
    !voided &&
    !tab.local_pending &&
    tab.status === "pending" &&
    !!(props.onAccept || props.onReject);
  const showCancel = open && tab?.by === "me" && pending && !!props.onCancel;
  // Side A/B is not authorship: a store can have several writers.
  const byLine = tab
    ? namedByLine(
        "tab.addedBy",
        nameOf({
          name: tab.author_name ?? null,
          // Party membership is not authorship: a colleague is not "you".
          isSelf: !!props.selfAccountId && tab.author_account_id === props.selfAccountId,
        }),
      )
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
    // White whatever the review state; an OPEN row turns bgMuted, actions
    // included. That grey ground is the open cue, never a review colour.
    <View style={[styles.container, open && styles.containerOpen]}>
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
        accessibilityValue={statusLabel ? { text: statusLabel } : undefined}
        accessibilityHint={toggleLabel}
        accessibilityActions={[
          { name: "activate", label: toggleLabel },
          ...(props.onLongPress ? [{ name: "longpress", label: t("entry.options") }] : []),
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "activate") setOpen((value) => !value);
          else if (event.nativeEvent.actionName === "longpress") props.onLongPress?.(entry);
        }}
        style={({ pressed }) => [pressed && { backgroundColor: "#17171708" }]}
      >
        {/* The status pill is the opened row's FIRST line, centred above the
          amount. It lives inside the Pressable, so tapping it closes the row
          like any other part of the tally. */}
        {open && status ? (
          <View style={styles.statusRow}>
            <View style={[styles.statusPill, rowDir(isRTL), isRTL && styles.statusPillRTL]}>
              <View style={[styles.statusDot, { backgroundColor: status.dot }]} />
              {/* Tracking severs Persian joining: trackingSafe drops it in Dari. */}
              <Text style={[styles.statusText, trackingSafe(isRTL)]} numberOfLines={1}>
                {status.label}
              </Text>
            </View>
          </View>
        ) : null}
        <View style={[styles.row, rowDir(isRTL), open && status && styles.rowUnderStatus]}>
          <View
            style={[
              styles.iconWrap,
              { backgroundColor: tint.bg },
              isRTL ? styles.iconWrapRTL : styles.iconWrapLTR,
              // A rejected tally remains readable without competing with live amounts.
              excluded && styles.voidedTile,
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
                {/* Rejected amounts stay visible with zero balance contribution. */}
                <Text style={[styles.amount, excluded && styles.voidedAmount]}>
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
                {/* Closed, the review state is this one dot before the time;
                  opened, the pill above says it in words, so the dot steps
                  aside. Screen readers get the state from the row's
                  accessibilityValue, so the dot itself stays silent. */}
                {!open && status ? (
                  <View
                    testID="status-dot"
                    style={[styles.closedStatusDot, { backgroundColor: status.dot }]}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  />
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
                <Text
                  style={[styles.noteBlock, textDir(isRTL), excluded && styles.voidedAmount]}
                  accessibilityLabel={note}
                >
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
                      style={[styles.note, textDir(isRTL), excluded && styles.voidedAmount]}
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
              shared ledger that reassurance is the other half of the feature.
              Start-aligned like every meta line under the note: the trailing
              edge belongs to the date. */}
            {open && byLine ? (
              <Text style={[styles.byLine, textDir(isRTL)]} numberOfLines={2}>
                {byLine}
              </Text>
            ) : null}
            {/* The dispute reason is the other party's words about THIS tally,
              so it gets the full width and no clamp: a shopkeeper resolving a
              dispute needs the whole sentence, not its first line. */}
            {open && disputeLine ? (
              <Text style={[styles.byLine, textDir(isRTL)]}>{disputeLine}</Text>
            ) : null}
            {open && tab && !tab.local_pending && tab.status !== "pending" ? (
              <Text style={[styles.byLine, textDir(isRTL)]}>
                {namedByLine("tab.reviewedBy", tab.reviewer_name || t("export.record.unknown"))}
                {tab.status_at != null ? ` · ${formatTimestamp(tab.status_at)}` : ""}
              </Text>
            ) : null}
            {open && tab?.status === "disputed" && !voided ? (
              <Text style={[styles.byLine, textDir(isRTL)]}>{t("tab.rejectedHint")}</Text>
            ) : null}
          </View>
        </View>
      </Pressable>
      {/* Compact pill CTAs on the row's trailing edge (the shared in-list
        Button: a 34px box whose vertical hitSlop restores the 44pt target;
        see ACTION_HIT_SLOP for why it never reaches sideways). Source order
        is [Reject, Accept] under rowDir + flex-end, so Accept is the
        outermost pill in both scripts. Accept is the black primary, NEVER the
        collect green: green and red mean money direction in this app. */}
      {showReview || showCancel ? (
        <View style={[styles.actions, rowDir(isRTL)]}>
          {showCancel ? (
            <Button
              size="pill"
              variant="secondary"
              icon="close-outline"
              label={t("tab.cancel")}
              accessibilityLabel={t("tab.cancel")}
              hitSlop={ACTION_HIT_SLOP}
              disabled={reviewing}
              onPress={() => void review(props.onCancel!)}
            />
          ) : null}
          {showReview && props.onReject ? (
            <Button
              size="pill"
              variant="secondary"
              icon="close-outline"
              label={t("tab.reject")}
              accessibilityLabel={t("tab.reject")}
              hitSlop={ACTION_HIT_SLOP}
              disabled={reviewing}
              onPress={() => void review(props.onReject!)}
            />
          ) : null}
          {showReview && props.onAccept ? (
            <Button
              size="pill"
              variant="primary"
              icon="checkmark-outline"
              label={t("tab.accept")}
              accessibilityLabel={t("tab.accept")}
              hitSlop={ACTION_HIT_SLOP}
              disabled={reviewing}
              onPress={() => void review(props.onAccept!)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bgDefault },
  containerOpen: { backgroundColor: colors.bgMuted },
  // The opened row's first line: the status pill, centred.
  statusRow: { alignItems: "center", paddingHorizontal: 14, paddingTop: 12 },
  // Neutral on purpose: white, hairline border, body ink. Only the dot is
  // coloured, so the pill never competes with the amount's direction colour.
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 22,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  // The Dari mockup gives the Persian label two more pixels of pill.
  statusPillRTL: { minHeight: 24 },
  statusDot: {
    width: STATUS_DOT_SIZE,
    height: STATUS_DOT_SIZE,
    borderRadius: STATUS_DOT_SIZE / 2,
  },
  // The same dot on a closed row, in the time slot. The meta row's gap spaces it.
  closedStatusDot: {
    width: STATUS_DOT_SIZE,
    height: STATUS_DOT_SIZE,
    borderRadius: STATUS_DOT_SIZE / 2,
  },
  statusText: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    lineHeight: sansLineHeight(11, 15),
    color: colors.textDefault,
    // Latin only: the label is Persian in Dari, where trackingSafe() zeroes it.
    letterSpacing: 0.2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  // Under the pill the amount line sits a little closer (12 above the pill
  // already separates the row from the one before it).
  rowUnderStatus: { paddingTop: 10 },
  // Trailing-edge action pills. A child's hitSlop is only reliably
  // hit-tested inside its parent's bounds, so this vertical padding is what
  // keeps the 44pt target: 4 above + the 34px pill + 6 of the 10 below = 44.
  // The pills never shrink, so at very large text sizes the pair WRAPS
  // (Accept drops under Reject, still on the trailing edge) instead of
  // spilling past the card's clipped edge. rowGap 12 is the two 6px vertical
  // slops end to end, so wrapped pills share no touch area either.
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    columnGap: 8,
    rowGap: 12,
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 10,
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
  byName: { fontFamily: fonts.sansSemi, color: colors.textDefault },
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
  // under. Every meta line (added by, reviewed by, the rejection reason and
  // hint) shares it and starts at the script's start edge.
  byLine: {
    marginTop: 6,
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(12, 17),
  },
});
