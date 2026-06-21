import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  type ListRenderItemInfo,
  Pressable,
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
import { queuePendingToast, useToast, useToastOffset } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { archivePerson, getLocalSelf, getPerson, listEntries, softDeleteEntry } from "../../lib/db";
import { getActiveVaultIdSyncMaybe } from "../../lib/db-tx";
import { useLedgerRefresh } from "../../lib/ledger-events";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { t } from "../../lib/i18n";
import { shareKaataViaWhatsApp } from "../../lib/share";
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

  const [person, setPerson] = useState<PersonWithBalance | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [self, setSelf] = useState<Self | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sheetFor, setSheetFor] = useState<Entry | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<Entry | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setLoaded(true);
      return;
    }
    // Guarded — an unhandled rejection here previously left the screen on
    // a permanent blank state with setLoaded never flipping.
    try {
      const [p, list, s] = await Promise.all([getPerson(id), listEntries(id), getLocalSelf()]);
      setPerson(p);
      setEntries(list);
      setSelf(s);
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

  // Virtualized entry rows — power users accumulate hundreds of entries,
  // and the old ScrollView + .map mounted all of them. Card-edge emulation
  // per row, same approach as home's TabPage.
  const renderEntryRow = useCallback(
    ({ item, index }: ListRenderItemInfo<Entry>) => (
      <View
        style={[
          styles.cardRow,
          index === 0 && styles.cardRowFirst,
          index === entries.length - 1 && styles.cardRowLast,
        ]}
      >
        {index > 0 ? <View style={styles.divider} /> : null}
        {/* setSheetFor is referentially stable — keeps the memoized
            EntryRow from re-rendering on unrelated screen renders. */}
        <EntryRow entry={item} onPress={setSheetFor} />
      </View>
    ),
    [entries.length],
  );

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
              size={22}
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
  const hasBalance = person.balance !== 0;
  const chipLabel =
    person.balance > 0
      ? t("person.balance.theyOwe")
      : person.balance < 0
        ? t("person.balance.youOwe")
        : null;
  const chipVariant: "collect" | "pay" | null =
    person.balance > 0 ? "collect" : person.balance < 0 ? "pay" : null;

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
            size={22}
            color={colors.textEmphasis}
          />
        </Pressable>
        <Pressable
          onPress={() => router.push({ pathname: "/person/[id]/edit", params: { id: person.id } })}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("person.sheet.edit")}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="create-outline" size={20} color={colors.textEmphasis} />
        </Pressable>
      </View>

      <FlatList
        data={entries}
        renderItem={renderEntryRow}
        keyExtractor={(e) => e.id}
        initialNumToRender={12}
        windowSize={7}
        // Android-only blank-row bug: with removeClippedSubviews defaulting to
        // true, a row wrapped in an overflow:"hidden" card (cardRowFirst/Last,
        // needed for the rounded corners) gets its subviews detached and never
        // repainted when the list reorders — e.g. adding a 2nd entry pushes the
        // old row from index 0 to 1, flipping its style, and it renders blank
        // but still takes space. Same fix + same cardRow pattern as the home
        // person list (app/index.tsx). The list is bounded by windowSize so
        // disabling clipping costs effectively nothing here.
        removeClippedSubviews={false}
        contentContainerStyle={{
          paddingBottom: (entries.length > 0 ? 96 : 24) + insets.bottom,
        }}
        ListHeaderComponent={
          <>
            <View style={styles.info}>
              <Text style={[styles.name, textDir(isRTL)]}>{person.name}</Text>
              {person.phone ? (
                <Text style={[styles.phone, textDir(isRTL)]}>{person.phone}</Text>
              ) : null}
              <View style={{ height: 16 }} />
              {chipLabel && chipVariant ? (
                <Chip label={chipLabel} variant={chipVariant} />
              ) : entries.length > 0 ? (
                <Chip label={t("person.balance.settled")} variant="neutral" />
              ) : null}
              <View style={[styles.balanceRow, rowDir(isRTL)]}>
                <Text style={[styles.balance, !hasBalance && { color: colors.textMuted }]}>
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
            <View style={styles.actions}>
              <View style={styles.actionBtnWrap}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/entry/new",
                      params: { personId: person.id, type: "payment" },
                    })
                  }
                  style={({ pressed }) => [
                    styles.actionBtn,
                    pressed && { backgroundColor: colors.bgMuted },
                  ]}
                >
                  <Ionicons name="arrow-down-outline" size={16} color={colors.textEmphasis} />
                  <Text style={styles.actionText}>{t("person.action.iReceived")}</Text>
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
                  style={({ pressed }) => [
                    styles.actionBtn,
                    pressed && { backgroundColor: colors.bgMuted },
                  ]}
                >
                  <Ionicons name="arrow-up-outline" size={16} color={colors.textEmphasis} />
                  <Text style={styles.actionText}>{t("person.action.iGave")}</Text>
                </Pressable>
              </View>
            </View>

            {entries.length === 0 ? (
              <EmptyState title={t("person.empty.title")} subtitle={t("person.empty.subtitle")} />
            ) : null}
          </>
        }
        ListFooterComponent={
          // Remove (soft-archive) the contact. iOS-Contacts-style: a quiet
          // destructive action at the very bottom of the person's page — hard
          // to hit by accident, easy to find on purpose.
          <Pressable
            onPress={() => setConfirmRemove(true)}
            disabled={removing}
            accessibilityRole="button"
            accessibilityLabel={t("person.remove.action")}
            style={({ pressed }) => [
              styles.removeBtn,
              rowDir(isRTL),
              (pressed || removing) && { opacity: 0.6 },
            ]}
          >
            <Ionicons name="trash-outline" size={16} color={colors.danger} />
            <Text style={styles.removeText}>{t("person.remove.action")}</Text>
          </Pressable>
        }
      />

      {entries.length > 0 ? (
        <Animated.View
          style={[
            styles.pingBar,
            { paddingBottom: 20 + insets.bottom, transform: [{ translateY: toastOffset }] },
          ]}
        >
          <Pressable
            onPress={async () => {
              const ok = await shareKaataViaWhatsApp(
                { name: person.name, phone: person.phone },
                person.balance,
                self,
              );
              if (!ok) toast.push(t("share.whatsappUnavailable"), "error");
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.pingButton, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="logo-whatsapp" size={20} color={colors.textInverted} />
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
            console.warn("[person] softDeleteEntry failed", err);
            toast.push(t("entry.deleteFailed"), "error");
          }
        }}
        onCancel={() => setConfirmDeleteFor(null)}
      />

      {/* Remove-contact confirm. Soft-archive (recoverable, frees the phone for
          re-adding); the copy is stronger when there's still an unsettled
          balance so the user can't hide money owed without noticing. */}
      <ConfirmDialog
        visible={confirmRemove}
        title={t("person.remove.title", { name: person.name })}
        description={
          person.balance !== 0
            ? t("person.remove.descriptionBalance", { name: person.name })
            : t("person.remove.description", { name: person.name })
        }
        confirmLabel={t("person.remove.confirm")}
        destructive
        onConfirm={async () => {
          if (removing) return;
          setRemoving(true);
          setConfirmRemove(false);
          try {
            await archivePerson(person.id);
            // Toast survives the navigation by riding the pending queue; the
            // person screen below is now invalid (archived), so land on home.
            queuePendingToast(t("person.remove.done", { name: person.name }), "success");
            router.replace("/");
          } catch (err) {
            console.warn("[person] archivePerson failed", err);
            setRemoving(false);
            toast.push(t("person.remove.failed"), "error");
          }
        }}
        onCancel={() => setConfirmRemove(false)}
      />
    </SafeAreaView>
  );
}

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
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  info: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 },
  name: { fontSize: 22, fontFamily: fonts.sansBold, color: colors.textEmphasis },
  removeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 28,
    marginHorizontal: 16,
    paddingVertical: 12,
  },
  removeText: { fontSize: 14, fontFamily: fonts.sansMedium, color: colors.danger },
  phone: {
    fontSize: 13,
    fontFamily: fonts.monoRegular,
    color: colors.textSubtle,
    marginTop: 4,
  },
  balanceRow: { flexDirection: "row", alignItems: "baseline", marginTop: 10, gap: 6 },
  balance: {
    fontSize: 40,
    fontFamily: fonts.monoBold,
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
    gap: 6,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  actionText: { fontSize: 14, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  // Per-row card-edge emulation for the virtualized list — together the
  // rows render identically to the old single bordered-card container.
  cardRow: {
    marginHorizontal: 16,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  cardRowFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: "hidden",
  },
  cardRowLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    overflow: "hidden",
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  pingBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bgDefault,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  pingButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 52,
    borderRadius: 12,
    backgroundColor: colors.bgInverted,
    paddingHorizontal: 16,
  },
  pingButtonLabel: {
    color: colors.textInverted,
    fontFamily: fonts.sansSemi,
    fontSize: 15,
  },
});
