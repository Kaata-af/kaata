import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet } from "../../components/BottomSheet";
import { Chip } from "../../components/Chip";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { EntryRow } from "../../components/EntryRow";
import { OptionSheet } from "../../components/OptionSheet";
import { useToast, useToastOffset } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import {
  getLocalSelf,
  getPerson,
  getSettlementSummary,
  listEntries,
  listSettlementBoundaries,
  SettledChapterError,
  softDeleteEntry,
} from "../../lib/db";
import { getActiveVaultIdSyncMaybe } from "../../lib/db-tx";
import {
  appendEntrySettled,
  RoleGateRejectionError,
  SettleNotZeroError,
} from "../../lib/event-log";
import { useLedgerRefresh } from "../../lib/ledger-events";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { getLocale, getShareLangPref, resolveShareLang, t, type LocaleCode } from "../../lib/i18n";
import { formatSettlementDate } from "../../lib/jalali";
import { useCalendar } from "../../lib/calendar";
import { shareKaataViaWhatsApp } from "../../lib/share";
import { icon, radius, TOUCH_MIN, typography } from "../../lib/tokens";
import { useActiveVaultWriteCaps } from "../../lib/use-vault-role";
import type { Entry, PersonWithBalance, Self } from "../../lib/types";

export default function PersonDetailScreen() {
  const router = useRouter();
  const toast = useToast();
  const toastOffset = useToastOffset();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Subscribes to locale changes — flipping language in Settings re-renders
  // this screen and all its descendants, so strings via t() refresh too.
  const isRTL = useIsRTL();
  // Repaints the settled-chapter lines when the calendar OR the language
  // changes — the latter matters even at a fixed calendar, because language
  // picks the script ("5 Aug 2026" vs "۵ اگست ۲۰۲۶").
  const calendar = useCalendar();

  const [person, setPerson] = useState<PersonWithBalance | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [self, setSelf] = useState<Self | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sheetFor, setSheetFor] = useState<Entry | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<Entry | null>(null);
  // Settle-up ("rule off the account", 2026-07-27). No persistent buttons:
  // the affordance is a ruled-line row that only exists at balance zero with
  // an open chapter, and settled history collapses behind one quiet row.
  const [settlement, setSettlement] = useState<{ count: number; lastSettledAtMs: number | null }>({
    count: 0,
    lastSettledAtMs: null,
  });
  // Every boundary (oldest→newest) — the full-history view draws each
  // ruled-off line with its settlement date, like a paper khata.
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [showFullHistory, setShowFullHistory] = useState(false);
  const [confirmSettle, setConfirmSettle] = useState(false);
  const settlingRef = useRef(false);
  // L12: synchronous re-entry guard for the WhatsApp ping — the share awaits an
  // up-to-8s snapshot upload before opening WhatsApp, and without this a user
  // tapping repeatedly minted a separate 90-day shared-ledger token per tap.
  const [pinging, setPinging] = useState(false);
  const pingBusyRef = useRef(false);
  // Message-language picker for the ping, shown when share_lang_pref = 'ask'.
  const [askLangVisible, setAskLangVisible] = useState(false);
  // Viewer read-only gate: false only when I'm a viewer on the active (shared)
  // kaata. Hides give/receive, edit-person, and entry edit/delete.
  // Roles v2 split: canCreate gates give/receive (clerks CAN append new
  // entries); canAmend gates person-edit + entry long-press (clerks cannot).
  const { canCreate, canAmend } = useActiveVaultWriteCaps(getActiveVaultIdSyncMaybe());

  // Chapter view: entries after the latest settlement boundary. Boundary
  // compares created_at, which the applier sets to the entry's BUSINESS date
  // (occurred_at) — so a deliberately backdated entry files into the settled
  // chapter it belongs to; the balance (always all-time) is unaffected, and
  // "view all" reveals everything.
  const chapterEntries = useMemo(
    () =>
      settlement.lastSettledAtMs == null
        ? entries
        : entries.filter((e) => e.created_at > settlement.lastSettledAtMs!),
    [entries, settlement.lastSettledAtMs],
  );
  // COHERENCE RULE (review fix — the load-bearing safety property): the
  // collapse only engages while the current chapter's sum EXACTLY explains
  // the balance. Any way the boundary can lie — an offline entry syncing in
  // with a pre-boundary business date, a retro-edit/delete inside settled
  // history from another device, clock skew — makes the view fall OPEN
  // instead of hiding money. Nothing behind the fold can ever account for
  // the number in the header.
  const chapterSum = useMemo(
    () =>
      chapterEntries.reduce(
        (sum, e) => sum + (e.type === "debt" ? e.amount_afn : -e.amount_afn),
        0,
      ),
    [chapterEntries],
  );
  const chapterCoherent = person == null || chapterSum === person.balance;
  const effectiveShowFull = showFullHistory || !chapterCoherent;
  const visibleEntries = effectiveShowFull ? entries : chapterEntries;

  // Full-history render list: entries interleaved with the ruled-off lines,
  // each marker at its chronological position with the settlement date —
  // like the visible lines in a paper khata. Adjacent markers (a concurrent
  // double-settle artifact) collapse to one; markers below the oldest entry
  // have nothing to rule off and are dropped.
  type HistoryItem = { kind: "entry"; entry: Entry } | { kind: "marker"; ms: number };
  const historyItems = useMemo<HistoryItem[]>(() => {
    if (!effectiveShowFull || boundaries.length === 0) {
      return visibleEntries.map((e) => ({ kind: "entry", entry: e }));
    }
    const items: HistoryItem[] = [];
    const desc = [...boundaries].sort((a, b) => b - a);
    let bi = 0;
    for (const e of entries) {
      while (bi < desc.length && desc[bi] >= e.created_at) {
        if (items.length === 0 || items[items.length - 1].kind !== "marker") {
          items.push({ kind: "marker", ms: desc[bi] });
        }
        bi++;
      }
      items.push({ kind: "entry", entry: e });
    }
    return items;
  }, [visibleEntries, effectiveShowFull, boundaries, entries]);
  const canSettle =
    canAmend &&
    chapterCoherent &&
    person != null &&
    person.balance === 0 &&
    chapterEntries.length > 0;

  async function onSettle() {
    setConfirmSettle(false);
    if (!person || settlingRef.current || chapterEntries.length === 0) return;
    settlingRef.current = true;
    try {
      // Boundary = max(now, newest chapter entry + 1): a lagging device
      // clock can never rule a line that excludes entries already visible.
      // The REAL zero check happens inside the append transaction
      // (appendEntrySettled's preflight) — this screen's state can be stale.
      const settledAtMs = Math.max(Date.now(), ...chapterEntries.map((e) => e.created_at + 1));
      await appendEntrySettled({
        relationshipId: chapterEntries[0].relationship_id,
        settledAtMs,
      });
      setShowFullHistory(false);
      toast.push(t("person.settle.done"), "success");
      await load();
    } catch (err) {
      if (err instanceof SettleNotZeroError) {
        toast.push(t("person.settle.notZero"), "error");
        await load(); // refresh — the balance the user saw was stale
      } else if (err instanceof RoleGateRejectionError) {
        toast.push(t("entry.roleDenied"), "error");
      } else {
        console.warn("[person] settle failed", err);
        toast.push(t("person.settle.failed"), "error");
      }
    } finally {
      settlingRef.current = false;
    }
  }

  // Send the WhatsApp ping in the given message language (already resolved
  // from share_lang_pref, or picked in the ask-sheet).
  const sendPing = async (lang: LocaleCode) => {
    if (!person || pingBusyRef.current) return;
    pingBusyRef.current = true;
    setPinging(true);
    try {
      const ok = await shareKaataViaWhatsApp(
        { id: person.id, name: person.name, phone: person.phone },
        person.balance,
        self,
        // Full history on the wire (the web view collapses settled chapters
        // itself); the boundary + count let both the message and the page
        // carry the "N accounts settled together" trust line.
        entries,
        lang,
        {
          settledChapters: settlement.count,
          settledBoundaryMs: settlement.lastSettledAtMs,
          settledBoundaries: boundaries,
        },
      );
      if (!ok) toast.push(t("share.whatsappUnavailable"), "error");
    } finally {
      pingBusyRef.current = false;
      setPinging(false);
    }
  };

  const load = useCallback(async () => {
    if (!id) {
      setLoaded(true);
      return;
    }
    // Guarded — an unhandled rejection here previously left the screen on
    // a permanent blank state with setLoaded never flipping.
    try {
      const [p, list, s, settle, bounds] = await Promise.all([
        getPerson(id),
        listEntries(id),
        getLocalSelf(),
        getSettlementSummary(id),
        listSettlementBoundaries(id),
      ]);
      setPerson(p);
      setEntries(list);
      setSelf(s);
      setSettlement(settle);
      setBoundaries(bounds);
      setLoadFailed(false);
    } catch (err) {
      console.warn("[person] load failed", err);
      setLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Live refresh: re-load when a sync applies events for the active vault, so a
  // remote entry/payment for this person appears without navigating away/back.
  useLedgerRefresh(getActiveVaultIdSyncMaybe(), load);

  if (!person) {
    // Pre-load: spinner. Post-load null (stale id, person archived remotely
    // via mesh): say so — and in both cases keep a working back button.
    // The old empty <View /> here was a dead end with no escape on iOS.
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={[styles.headerNav, rowDir(isRTL)]}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("common.back")}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
          >
            <Ionicons
              name={isRTL ? "chevron-forward" : "chevron-back"}
              size={icon.header}
              color={colors.textEmphasis}
            />
          </Pressable>
        </View>
        <View style={styles.fillCenter}>
          {loaded ? (
            // Distinguish "this person doesn't exist" from "the read
            // failed" — telling a shopkeeper a real person was not found
            // on a transient storage error is a false data-loss signal.
            <Text style={styles.notFoundText}>
              {loadFailed ? t("home.loadFailed") : t("personAdd.personNotFound")}
            </Text>
          ) : (
            <ActivityIndicator color={colors.textDefault} />
          )}
        </View>
      </SafeAreaView>
    );
  }

  const abs = Math.abs(person.balance);
  // Direction is derived from the running net — not from any URL param or
  // person-level property. balance > 0 → they owe me; balance < 0 → I owe them.
  const chipLabel =
    person.balance > 0
      ? t("person.balance.theyOwe")
      : person.balance < 0
        ? t("person.balance.youOwe")
        : null;
  const chipVariant: "collect" | "pay" | null =
    person.balance > 0 ? "collect" : person.balance < 0 ? "pay" : null;
  // The hero balance carries the direction cue: the collect color when they
  // owe me (to collect), the pay color when I owe them (to pay), muted gray
  // when settled.
  const balanceColor =
    person.balance > 0
      ? colors.collectStrong
      : person.balance < 0
        ? colors.payStrong
        : colors.textMuted;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={[styles.headerNav, rowDir(isRTL)]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={icon.header}
            color={colors.textEmphasis}
          />
        </Pressable>
        {canAmend ? (
          <Pressable
            onPress={() =>
              router.push({ pathname: "/person/[id]/edit", params: { id: person.id } })
            }
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("person.sheet.edit")}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
          >
            <Ionicons name="create-outline" size={icon.row} color={colors.textEmphasis} />
          </Pressable>
        ) : (
          <View style={styles.readOnlyChip}>
            {/* Stays 12, NOT icon.trailing (16): this glyph is composed against
                an 11px caption inside a pill — a 16px mark would outweigh its
                own label and force the badge taller than the edit button it
                replaces. Composed graphic, not a row icon. */}
            <Ionicons name="eye-outline" size={12} color={colors.textSubtle} />
            <Text style={styles.readOnlyChipText} allowFontScaling={false}>
              {t("readonly.badge")}
            </Text>
          </View>
        )}
      </View>

      {/* One person's tallies are bounded, so render them as ONE bordered card
          (ScrollView + map), exactly like the home people list. The old
          FlatList + per-row cardRowFirst/cardRowLast emulation caused the
          blank-row bug: adding a 2nd entry shifted the old row from index 0 to
          1, flipping its style, and Android painted it blank until a remount
          ("the old one shows blank text after the second one is added, fixed
          by going back and returning"). A single uniform card has no per-row
          style flip, so it can't happen. */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: (entries.length > 0 ? 96 : 24) + insets.bottom,
        }}
      >
        <View>
          <View style={styles.info}>
            <Text style={[styles.name, textDir(isRTL)]}>{person.name}</Text>
            {person.phone ? (
              <Text style={[styles.phone, textDir(isRTL)]}>{person.phone}</Text>
            ) : null}
            <View style={{ height: 16 }} />
            {chipLabel && chipVariant ? (
              <Chip label={chipLabel} variant={chipVariant} />
            ) : entries.length > 0 &&
              settlement.count > 0 &&
              chapterCoherent &&
              chapterEntries.length === 0 ? (
              // "SETTLED" only when the user actually drew the line and it
              // covers everything.
              <Chip label={t("person.balance.settled")} variant="neutral" />
            ) : entries.length > 0 ? (
              // A tally that merely SUMS to zero (or whose chapter no longer
              // adds up after a sync) is not a settled account — say so
              // rather than leaving the chip slot blank while every other
              // state labels itself. Hollow pill: true, but not an
              // achievement. The settle-row invitation sits below.
              // Contacts with no entries at all keep an empty slot — there
              // is no tally yet to have a state.
              <Chip label={t("person.balance.notSettled")} variant="outline" />
            ) : null}
            <View style={[styles.balanceRow, rowDir(isRTL)]}>
              <Text
                style={[styles.balance, { color: balanceColor, flexShrink: 1 }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.5}
              >
                {formatAmount(abs)}
              </Text>
              <Text style={styles.balanceAfn}>{getCurrentCurrencySymbol()}</Text>
            </View>
          </View>

          {/*
           * INVARIANT: "I gave" on the RIGHT, "I received" on the LEFT.
           * Right-hand-is-giving cultural rule. The actions style below uses
           * `flexDirection: "row"` and relies on the Activity being LTR —
           * that's guaranteed by _layout.tsx's I18nManager neutralization +
           * one-shot migration prompt. If the Activity were RTL, Yoga would
           * auto-reverse children and "I gave" would land on the left
           * (the v0.2.4 bug).
           */}
          {canCreate ? (
            <View style={styles.actions}>
              <View style={styles.actionBtnWrap}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/entry/new",
                      params: { personId: person.id, type: "payment" },
                    })
                  }
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
                >
                  {/* 16 is composed INTO the fixed 26px coin (see
                      actionIconCoin), so the icon scale does not apply here —
                      icon.trailing/row would fill or overflow the well. */}
                  <View style={styles.actionIconCoin}>
                    <Ionicons name="arrow-down-outline" size={16} color={colors.textInverted} />
                  </View>
                  <Text style={[styles.actionText, trackingSafe(isRTL)]}>
                    {t("person.action.iReceived")}
                  </Text>
                </Pressable>
              </View>
              <View style={styles.actionBtnWrap}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/entry/new",
                      params: { personId: person.id, type: "debt" },
                    })
                  }
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
                >
                  {/* 16, composed into the coin — same reason as "I received". */}
                  <View style={styles.actionIconCoin}>
                    <Ionicons name="arrow-up-outline" size={16} color={colors.textInverted} />
                  </View>
                  <Text style={[styles.actionText, trackingSafe(isRTL)]}>
                    {t("person.action.iGave")}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>

        {/* Settle-up affordance — deliberately NOT a button. A ruled line,
            the same mark a paper khata gets when an account is closed. It
            only exists in the exact moment it means something: balance is
            zero AND the current chapter has entries. Tapping it draws the
            line for real. */}
        {canSettle ? (
          <Pressable
            onPress={() => setConfirmSettle(true)}
            accessibilityRole="button"
            accessibilityLabel={t("person.settle.row")}
            style={({ pressed }) => [styles.settleRow, rowDir(isRTL), pressed && { opacity: 0.5 }]}
          >
            <View style={styles.settleRule} />
            <Text style={styles.settleRowText} allowFontScaling={false}>
              {t("person.settle.row")}
            </Text>
            <View style={styles.settleRule} />
          </Pressable>
        ) : null}

        {visibleEntries.length === 0 ? (
          settlement.count > 0 ? (
            // Fresh page after a settlement: not "empty", just a new chapter.
            <EmptyState
              title={t("person.freshChapter.title")}
              subtitle={t("person.freshChapter.subtitle")}
              isRTL={isRTL}
            />
          ) : (
            <EmptyState
              title={t("person.empty.title")}
              subtitle={t("person.empty.subtitle")}
              isRTL={isRTL}
            />
          )
        ) : (
          <View style={styles.entriesCard}>
            {historyItems.map((item, index) => {
              if (item.kind === "marker") {
                // The ruled-off line, dated — a khata page's visible mark.
                return (
                  <View key={`m-${item.ms}-${index}`} style={[styles.chapterLine, rowDir(isRTL)]}>
                    <View style={styles.settleRule} />
                    <Text style={styles.chapterLineText} allowFontScaling={false}>
                      {t("person.history.settledOn", {
                        date: formatSettlementDate(item.ms, getLocale(), calendar),
                      })}
                    </Text>
                    <View style={styles.settleRule} />
                  </View>
                );
              }
              const entry = item.entry;
              // Settled history is READ-ONLY (review fix): editing or
              // deleting a ruled-off entry would un-zero a closed chapter.
              // Remote edits can still arrive — the coherence rule above
              // handles those by falling open — but this device won't offer
              // the footgun.
              const inSettledChapter =
                settlement.lastSettledAtMs != null &&
                entry.created_at <= settlement.lastSettledAtMs;
              return (
                <View key={entry.id}>
                  {index > 0 && historyItems[index - 1].kind !== "marker" ? (
                    <View style={styles.divider} />
                  ) : null}
                  {/* setSheetFor is referentially stable — keeps the memoized
                      EntryRow from re-rendering on unrelated screen renders.
                      Opens the edit/delete sheet on TAP-AND-HOLD only. */}
                  <EntryRow
                    entry={entry}
                    onLongPress={canAmend && !inSettledChapter ? setSheetFor : undefined}
                  />
                </View>
              );
            })}
          </View>
        )}

        {/* Settled history collapse — one quiet row, only when chapters
            exist AND the collapse is coherent (when the chapter can't
            explain the balance, the view is forced open and the toggle
            hides rather than pretend). Nothing was deleted; the book just
            has pages now. */}
        {settlement.count > 0 && chapterCoherent ? (
          <Pressable
            onPress={() => setShowFullHistory((v) => !v)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.historyRow, pressed && { opacity: 0.5 }]}
          >
            <Text style={styles.historyRowText} allowFontScaling={false}>
              {showFullHistory
                ? t("person.history.hide")
                : t("person.history.show", { count: settlement.count })}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {entries.length > 0 ? (
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.pingBar,
            { paddingBottom: 20 + insets.bottom, transform: [{ translateY: toastOffset }] },
          ]}
        >
          <Pressable
            onPress={async () => {
              if (pingBusyRef.current) return;
              const pref = await getShareLangPref();
              if (pref === "ask") {
                setAskLangVisible(true);
                return;
              }
              await sendPing(resolveShareLang(pref));
            }}
            disabled={pinging}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.pingButton,
              pressed && { opacity: 0.85 },
              pinging && { opacity: 0.6 },
            ]}
          >
            {pinging ? (
              <ActivityIndicator size="small" color={colors.textInverted} />
            ) : (
              <Ionicons name="logo-whatsapp" size={icon.row} color={colors.textInverted} />
            )}
            <Text style={styles.pingButtonLabel} numberOfLines={1}>
              {t("person.ping", { name: person.name })}
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}

      <BottomSheet
        visible={sheetFor !== null}
        title={
          sheetFor
            ? `${formatAmount(sheetFor.amount_afn)} ${getCurrentCurrencySymbol()}`
            : undefined
        }
        onDismiss={() => setSheetFor(null)}
        actions={[
          {
            label: t("person.sheet.edit"),
            icon: "create-outline",
            onPress: () => {
              const eid = sheetFor?.id;
              if (eid) router.push({ pathname: "/entry/[id]/edit", params: { id: eid } });
            },
          },
          {
            label: t("person.sheet.delete"),
            icon: "trash-outline",
            destructive: true,
            onPress: () => setConfirmDeleteFor(sheetFor),
          },
        ]}
      />

      {/* Per-send message-language picker (share_lang_pref = 'ask'). Dari
          first — the common pick. No persisted selection: it's per-send. */}
      <OptionSheet
        visible={askLangVisible}
        title={t("share.askLang.title")}
        options={[
          { key: "fa", label: t("settings.language.option.fa") },
          { key: "en", label: t("settings.language.option.en") },
        ]}
        selected=""
        onSelect={(k) => {
          setAskLangVisible(false);
          void sendPing(k as LocaleCode);
        }}
        onDismiss={() => setAskLangVisible(false)}
        isRTL={isRTL}
      />

      <ConfirmDialog
        visible={confirmSettle}
        title={t("person.settle.confirm.title")}
        description={t("person.settle.confirm.body", { name: person.name })}
        confirmLabel={t("person.settle.confirm.cta")}
        onConfirm={onSettle}
        onCancel={() => setConfirmSettle(false)}
      />
      <ConfirmDialog
        visible={confirmDeleteFor !== null}
        title={t("person.delete.title")}
        description={t("person.delete.description")}
        confirmLabel={t("person.delete.confirm")}
        destructive
        onConfirm={async () => {
          // Close the dialog FIRST — ConfirmDialog doesn't self-dismiss, and
          // the success toast renders beneath the dialog's Modal, so leaving
          // it open reads as "the tap did nothing" and invites a second
          // Confirm tap (re-running the delete).
          const target = confirmDeleteFor;
          setConfirmDeleteFor(null);
          if (!target) return;
          try {
            await softDeleteEntry(target.id);
            await load();
            toast.push(t("entry.deleted"), "success");
          } catch (err) {
            if (err instanceof SettledChapterError) {
              toast.push(t("entry.settledLocked"), "error");
              return;
            }
            console.warn("[person] softDeleteEntry failed", err);
            toast.push(t("entry.deleteFailed"), "error");
          }
        }}
        onCancel={() => setConfirmDeleteFor(null)}
      />
    </SafeAreaView>
  );
}

// Fixed-size "coin" behind the give/receive arrow. Named so the radius can be
// size/2 (a true circle) instead of a literal that silently stops being one
// when the diameter changes.
const ACTION_COIN_SIZE = 26;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 14, fontFamily: fonts.sansRegular, color: colors.textSubtle },
  headerNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  iconBtn: {
    // 40 + the hitSlop={8} on every consumer = a 56px target, so the visible
    // box stays 40 (growing it would push the header chrome down 4px).
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  // Read-only chip shown in place of the edit button for a viewer.
  readOnlyChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.bgMuted,
  },
  readOnlyChipText: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  info: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 },
  // 22 → typography.heading (20): 22 was one of the scale's two orphan display
  // sizes and sat 2px from `heading`, which every other screen headline already
  // uses. The BOLD weight is kept (heading ships sansSemi) — this is a person's
  // name, the anchor of the screen, and dropping a weight step here would read
  // as a demotion rather than a scale fix. Same fontFamily-override idiom as
  // Button's `textPill`.
  name: { ...typography.heading, fontFamily: fonts.sansBold, color: colors.textEmphasis },
  phone: {
    fontSize: 13,
    fontFamily: fonts.monoRegular,
    color: colors.textSubtle,
    marginTop: 4,
  },
  balanceRow: { flexDirection: "row", alignItems: "baseline", marginTop: 10, gap: 6 },
  // 40 → typography.numHero (36). This was the app's ONLY 40px value, and the
  // home screen's total — the other hero balance — was already 36. The 4px gap
  // was never the hierarchy signal between the two screens; the COLOUR is (both
  // tint inline from the running net, and this one falls back to a muted grey
  // when settled while home never renders a settled state). So the size
  // collapses and the colour is left exactly as it was.
  //
  // letterSpacing STAYS: formatAmount() goes through lib/format.ts, which
  // hardcodes toLocaleString("en-US"), so this string is Latin digits in both
  // languages and tracking can't sever any Arabic-script joining. Deliberately
  // NOT trackingSafe(isRTL) for the same reason.
  balance: {
    ...typography.numHero,
    color: colors.textEmphasis,
    letterSpacing: -0.5,
  },
  balanceAfn: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textMuted },
  actions: {
    // INVARIANT: "I received" stays physical LEFT, "I gave" stays physical
    // RIGHT. Right-hand-is-giving cultural rule. Yoga WOULD auto-reverse
    // `flexDirection: 'row'` children if the Activity were RTL — that's
    // exactly the bug v0.2.4 shipped, with "I gave" landing on the left
    // for Persian users. We avoid it by ensuring the Activity is LTR via
    // _layout.tsx's I18nManager neutralization + one-shot migration
    // prompt. Internal direction (lib/direction.ts) does NOT touch this
    // row.
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 10,
    marginBottom: 20,
  },
  // Wrap View just exists to hang a ref for the tour spotlight. flex:1
  // so it behaves identically to the bare Pressable did before.
  actionBtnWrap: { flex: 1 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    paddingVertical: 13,
    borderRadius: radius.md,
    // Solid primary-button fill — same high-affordance language as the FAB and
    // the share button, deliberately NOT the red/green direction color. These
    // are the two most-used actions, so they must read as obvious, tappable
    // buttons; direction is carried by the arrow, the label, and the
    // left/right position (I received LEFT, I gave RIGHT). The arrow rides in a
    // soft inner "coin" and the lift is a soft, diffuse shadow — refined and
    // premium rather than a flat black slab. Height (~52) matches the share bar.
    backgroundColor: colors.bgInverted,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.16,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 5 },
      },
      android: { elevation: 4 },
    }),
  },
  // Subtle scale + dim on press — a tactile, considered feel for a button
  // tapped all day, instead of a flat opacity blink.
  actionBtnPressed: { opacity: 0.9, transform: [{ scale: 0.985 }] },
  // Soft translucent circle that gives the arrow a deliberate home on the dark
  // fill — the key "refined" detail vs a bare floating arrow.
  actionIconCoin: {
    width: ACTION_COIN_SIZE,
    height: ACTION_COIN_SIZE,
    borderRadius: ACTION_COIN_SIZE / 2,
    backgroundColor: "rgba(255,255,255,0.13)",
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
    letterSpacing: 0.2,
  },
  // One bordered card around all tallies (same as the home people list). No
  // per-row corner emulation, so no blank-row-on-reorder bug.
  entriesCard: {
    marginHorizontal: 16,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  // Settle-up ruled line — ledger furniture, not a button. Sits between the
  // action row and the entries card only when settlement is possible.
  settleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 24,
    marginTop: 16,
    marginBottom: 4,
    // Was 32 — the one control that rules off an account was under the HIG
    // floor with no hitSlop. Grown rather than hitSlop'd because this row
    // stands alone between the action buttons and the entries card (nothing
    // tappable within 20px), and alignItems:"center" keeps the ruled line
    // optically where it was; only the surrounding air changes.
    minHeight: TOUCH_MIN,
  },
  settleRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.textSubtle,
    opacity: 0.5,
  },
  settleRowText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  // Dated ruled-off line between chapters in the full-history view.
  chapterLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.bgMuted,
  },
  chapterLineText: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  // Settled-history collapse row — one quiet line under the entries card.
  historyRow: {
    alignItems: "center",
    paddingVertical: 14,
  },
  historyRowText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },
  pingBar: {
    // Transparent container — NO opaque white background. The old
    // backgroundColor: colors.bgDefault painted a big white rectangle behind the
    // button. The button floats over the content (the ScrollView reserves
    // paddingBottom so entries never sit under it); pointerEvents="box-none" lets
    // touches in the empty area pass through.
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  pingButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.bgInverted,
    paddingHorizontal: 16,
    // Subtle lift so the floating button reads cleanly without a backing bar.
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      },
      android: { elevation: 6 },
    }),
  },
  pingButtonLabel: {
    color: colors.textInverted,
    fontFamily: fonts.sansSemi,
    fontSize: 15,
  },
});
