// Removed people — the surface that makes the remove dialog's promise real.
//
// archivePerson keeps a removed person's entries on the device (archive
// semantics), but until this screen existed there was NO way to see them
// again: the home list and search only show active relationships, and
// re-adding the person mints a brand-new user + relationship, so the old
// book stayed orphaned forever while the remove dialog said "entries are
// kept". This screen closes that loop: it lists archived people for the
// ACTIVE vault (name, outstanding balance, entry count, when removed) with
// a Restore action that clears the archive flag via person_unarchived
// events — full history and settlement chapters return intact.
//
// Modeled on app/vault/archived.tsx (the archived-KAATAS screen) so the two
// "removed things live here, restorable" surfaces read identically. Entered
// from a "Removed people" row in vault settings, rendered only when the
// active vault has >= 1 removed person — zero clutter for everyone else.
//
// Restore is gated on the person_unarchived role tier (editor+, same as
// remove) via useActiveVaultWriteCaps; viewers/clerks see a read-only list.

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { listArchivedPeople, unarchivePerson, type ArchivedPersonRow } from "../../lib/db";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../lib/event-log";
import { getActiveVaultId, getActiveVaultIdSyncMaybe } from "../../lib/db-tx";
import { SETTINGS_ROW_MIN_HEIGHT, SETTINGS_ROW_PADDING_X } from "../../lib/design-tokens";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { t } from "../../lib/i18n";
import { useActiveVaultWriteCaps } from "../../lib/use-vault-role";

export default function RemovedPeopleScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  // entry.amend maps to the same editor tier as person_unarchived — a member
  // who can amend the book can restore into it.
  const { canAmend } = useActiveVaultWriteCaps(getActiveVaultIdSyncMaybe());

  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<ArchivedPersonRow[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const vaultId = await getActiveVaultId();
    if (!vaultId) {
      setRows([]);
      return;
    }
    setRows(await listArchivedPeople(vaultId));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await load();
      } catch (err) {
        if (__DEV__) console.warn("[vault/removed-people] load failed", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function onRestore(row: ArchivedPersonRow) {
    if (restoringId) return;
    setRestoringId(row.id);
    try {
      const vaultId = await getActiveVaultId();
      if (!vaultId) throw new Error("no active vault");
      await unarchivePerson(row.id, vaultId);
      // Optimistic dropout — the applier cleared archived_at inside the same
      // transaction as the event append, so a re-query would agree.
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      toast.push(t("peopleRemoved.restoredToast", { name: row.name }), "success");
    } catch (err) {
      if (__DEV__) console.warn("[vault/removed-people] restore failed", err);
      // Same typed-error split as entry/new.tsx: "try again" is WRONG advice
      // for a cold signing cache (only an app reopen cures it) and for a role
      // demotion that synced in after the Restore button rendered.
      if (err instanceof RoleGateRejectionError) {
        toast.push(t("projectionConflicts.toast.roleGate"), "error");
      } else if (err instanceof EventSigningUnavailableError) {
        toast.push(t("entry.signingUnavailable"), "error");
      } else {
        toast.push(t("peopleRemoved.restoreFailed"), "error");
      }
    } finally {
      setRestoringId(null);
    }
  }

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <ScreenHeader
          title={t("peopleRemoved.title")}
          onBack={() => router.back()}
          isRTL={isRTL}
          backLabel={t("common.back")}
        />
        <View style={styles.fillCenter}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("peopleRemoved.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      {rows.length === 0 ? (
        // Same stranded-user fix as vault/archived: the last restore leaves
        // an empty screen, so give a forward path instead of bare copy.
        <View style={styles.emptyWrap}>
          <Ionicons name="person-remove-outline" size={40} color={colors.textMuted} />
          <Text style={[styles.emptyTitle, textDir(isRTL)]}>{t("peopleRemoved.empty")}</Text>
          <Text style={[styles.emptySubtitle, textDir(isRTL)]}>
            {t("peopleRemoved.emptySubtitle")}
          </Text>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel={t("peopleRemoved.emptyCta")}
            style={({ pressed }) => [styles.emptyCta, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.emptyCtaText}>{t("peopleRemoved.emptyCta")}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <RemovedPersonRow
              row={item}
              isRTL={isRTL}
              busy={restoringId === item.id}
              anyBusy={restoringId !== null}
              canRestore={canAmend}
              onRestore={() => onRestore(item)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function RemovedPersonRow(props: {
  row: ArchivedPersonRow;
  isRTL: boolean;
  busy: boolean;
  anyBusy: boolean;
  canRestore: boolean;
  onRestore: () => void;
}) {
  const { row, isRTL, busy, anyBusy, canRestore, onRestore } = props;
  const subBits = [t("peopleRemoved.removedAt", { relative: formatRelative(row.archived_at) })];
  if (row.entry_count === 1) {
    subBits.push(t("peopleRemoved.entryCount.one"));
  } else if (row.entry_count > 1) {
    subBits.push(t("peopleRemoved.entryCount", { n: row.entry_count }));
  }
  // Outstanding balance at removal time, colored by direction — the thing a
  // shopkeeper actually checks here ("how much was Ahmad's page at?").
  const balColor =
    row.balance > 0 ? colors.collectStrong : row.balance < 0 ? colors.payStrong : colors.textMuted;
  return (
    <View style={[styles.row, rowDir(isRTL)]}>
      <Ionicons
        name="person-outline"
        size={22}
        color={colors.textMuted}
        style={isRTL ? { marginLeft: 14 } : { marginRight: 14 }}
      />
      <View style={styles.rowTextCol}>
        <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={1}>
          {subBits.join(" · ")}
        </Text>
      </View>
      {row.balance !== 0 ? (
        <Text style={[styles.rowBalance, { color: balColor }]} numberOfLines={1}>
          {formatAmount(row.balance)} {getCurrentCurrencySymbol()}
        </Text>
      ) : null}
      {canRestore ? (
        <Pressable
          onPress={anyBusy ? undefined : onRestore}
          disabled={anyBusy}
          accessibilityRole="button"
          accessibilityLabel={t("peopleRemoved.restoreButton")}
          accessibilityState={{ disabled: anyBusy }}
          style={({ pressed }) => [
            styles.restoreBtn,
            pressed && !anyBusy && { opacity: 0.55 },
            anyBusy && { opacity: 0.45 },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.textEmphasis} />
          ) : (
            <Text style={styles.restoreText} numberOfLines={1}>
              {t("peopleRemoved.restoreButton")}
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

// Same local relative formatter pattern as vault/archived.tsx — per-screen
// key namespace by design, sharing would shove a key-prefix parameter
// through a helper.
function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return t("peopleRemoved.relative.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("peopleRemoved.relative.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("peopleRemoved.relative.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("peopleRemoved.relative.daysAgo", { n: days });
  const months = Math.floor(days / 30);
  return t("peopleRemoved.relative.monthsAgo", { n: months });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },

  listContent: { paddingBottom: 32 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: 12,
    minHeight: SETTINGS_ROW_MIN_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  rowTextCol: { flex: 1 },
  rowName: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
  },
  rowSub: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
  },
  rowBalance: {
    fontSize: 13,
    fontFamily: fonts.monoMedium,
    marginHorizontal: 8,
  },
  restoreBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.bgMuted,
    borderRadius: 999,
    minWidth: 84,
    alignItems: "center",
    justifyContent: "center",
  },
  restoreText: {
    fontSize: 13,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },

  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: -4,
    marginBottom: 8,
  },
  emptyCta: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: colors.bgInverted,
    borderRadius: 999,
    minWidth: 140,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyCtaText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
  },
});
