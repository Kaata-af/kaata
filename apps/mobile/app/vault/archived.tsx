// Archived Kaatas — Phase 7 D-ARCHIVED-SCREEN.
//
// Dedicated landing for all archived vaults, moved out of VaultPickerSheet
// and ProfileSettingsSheet so the main switching surfaces stay focused
// on active Kaatas. Entered from a small "Archived (N) >" row in either
// sheet (only rendered when N >= 1).
//
// Data model: SELECT id, name, archived_at FROM vaults WHERE archived_at
// IS NOT NULL ORDER BY archived_at DESC. Restore is routed through
// vault-router.unarchiveVault() which, for local-CA vaults, emits a
// vault_setting_set event with key="archived_at" and an empty value;
// the applier parses "" as null and clears the flag (see
// lib/projection/vault_settings.ts). Server-anchored vaults currently
// have no /unarchive endpoint — see unarchiveVault() for the error path.
//
// "Restore if there is no active vault" rule: if the user archived
// their last Kaata and is now restoring one from this screen, set it
// as the active vault before returning to home. Home's load() would
// otherwise leave activeVaultId null and prompt the user to create one.

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getActiveVaultIdSyncMaybe, getDb, setActiveVaultId } from "../../lib/db-tx";
import { SETTINGS_ROW_MIN_HEIGHT, SETTINGS_ROW_PADDING_X } from "../../lib/design-tokens";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { icon } from "../../lib/tokens";
import { unarchiveVault, UnarchiveNotSupportedError } from "../../lib/vault-router";

type ArchivedRow = {
  id: string;
  name: string;
  archived_at: number;
  // UX-fix #2: server-anchored rows can't be unarchived from the client
  // (no backend endpoint). We surface this in-row with a "Restore from
  // cloud" label + disabled state instead of letting the user tap-and-
  // fail. Computed from vaults.vault_trust_anchor_pubkey IS NULL during
  // the initial SELECT so we don't have to round-trip per-row at render
  // time.
  serverAnchored: boolean;
};

export default function VaultArchivedScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();

  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<ArchivedRow[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const db = await getDb();
    const res = await db.getAllAsync<{
      id: string;
      name: string;
      archived_at: number;
      vault_trust_anchor_pubkey: string | null;
    }>(
      `SELECT id, name, archived_at, vault_trust_anchor_pubkey
         FROM vaults
        WHERE archived_at IS NOT NULL
        ORDER BY archived_at DESC`,
    );
    setRows(
      res.map((r) => ({
        id: r.id,
        name: r.name,
        archived_at: r.archived_at,
        serverAnchored: r.vault_trust_anchor_pubkey == null || r.vault_trust_anchor_pubkey === "",
      })),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await load();
      } catch (err) {
        if (__DEV__) console.warn("[vault/archived] load failed", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function onRestore(row: ArchivedRow) {
    if (restoringId) return;
    setRestoringId(row.id);
    try {
      await unarchiveVault(row.id);

      // Optimistic re-filter — drop the row from the local list without
      // waiting for a re-query. The applier has already mirrored
      // vaults.archived_at = NULL inside the same transaction as the
      // event append, so a fresh SELECT would return the same result.
      setRows((prev) => prev.filter((r) => r.id !== row.id));

      // Edge case: user archived their only Kaata, walked into this
      // screen, and is now restoring the same row. Home's load() runs
      // on focus and will pick a fallback when activeVaultId is in the
      // active set; if it's currently null, prime it here so the home
      // header has something to render immediately on pop.
      const activeId = getActiveVaultIdSyncMaybe();
      if (!activeId) {
        await setActiveVaultId(row.id);
      }

      toast.push(t("vaultArchived.restoredToast", { name: row.name }), "success");
    } catch (err) {
      if (__DEV__) console.warn("[vault/archived] restore failed", err);
      // vault-router throws a typed error for server-anchored vaults
      // that have no unarchive endpoint; surface the i18n string. Use
      // instanceof rather than a message regex so a future error-
      // message rewrite doesn't silently break the branch.
      if (err instanceof UnarchiveNotSupportedError) {
        toast.push(t("vaultArchived.unarchiveUnsupported"), "error");
      } else {
        toast.push(t("vaultArchived.restoreFailed"), "error");
      }
    } finally {
      setRestoringId(null);
    }
  }

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <ScreenHeader
          title={t("vaultArchived.title")}
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
        title={t("vaultArchived.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      {rows.length === 0 ? (
        // UX-fix #3: the user lands here either by restoring the last
        // archived Kaata (success!) or by deep-link with nothing to
        // restore. The bare "No archived Kaatas yet." copy stranded the
        // user — add a small subtitle + an explicit "Back to Kaatas" CTA
        // so they have a forward path without hunting for the header
        // chevron. Tap dismisses this screen (router.back which lands on
        // the entry point: home, ProfileSettingsSheet, or VaultPickerSheet).
        <View style={styles.emptyWrap}>
          <EmptyState
            title={t("vaultArchived.empty")}
            subtitle={t("vaultArchived.emptySubtitle")}
            // The escape hatch keeps its bgInverted pill shape via primary+pill.
            // Button announces `label` as its a11y label, which is the same
            // string the explicit accessibilityLabel used to pass.
            action={
              <Button
                label={t("vaultArchived.emptyCta")}
                onPress={() => router.back()}
                size="pill"
              />
            }
            isRTL={isRTL}
            icon="archive-outline"
          />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <ArchivedListRow
              row={item}
              isRTL={isRTL}
              busy={restoringId === item.id}
              anyBusy={restoringId !== null}
              onRestore={() => onRestore(item)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ArchivedListRow(props: {
  row: ArchivedRow;
  isRTL: boolean;
  busy: boolean;
  anyBusy: boolean;
  onRestore: () => void;
}) {
  const { row, isRTL, busy, anyBusy, onRestore } = props;
  const subLabel = t("vaultArchived.archivedAt", {
    relative: formatRelative(row.archived_at),
  });
  // UX-fix #2: server-anchored rows surface a "Restore from cloud"
  // affordance instead of a "Restore" button that always fails. Disabled
  // until the cloud-restore flow exists; the inline subtitle below
  // doubles as the explanation so the user doesn't have to tap and
  // see a toast to learn why nothing happens. Local-CA rows behave
  // exactly as before — primary Restore action, optimistic dropout
  // from the list on success.
  const restoreDisabled = anyBusy || row.serverAnchored;
  const restoreLabel = row.serverAnchored
    ? t("vaultArchived.restoreFromCloud")
    : t("vaultArchived.restoreButton");
  return (
    <View style={[styles.row, rowDir(isRTL)]}>
      <Ionicons
        name="archive-outline"
        size={icon.row}
        color={colors.textMuted}
        style={isRTL ? { marginLeft: 14 } : { marginRight: 14 }}
      />
      <View style={styles.rowTextCol}>
        <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={1}>
          {row.serverAnchored ? t("vaultArchived.serverAnchoredHint") : subLabel}
        </Text>
      </View>
      {/* The list CTA. The fill/outline split is LOAD-BEARING and survives the
          migration: a restorable kaata keeps its filled bgMuted pill (`muted`),
          a server-anchored one renders as the bordered outline (`secondary`) —
          "not available from this phone", said by shape rather than by greying
          it out like a broken control. Collapsing both into one variant plus
          opacity made the two states indistinguishable. The in-row spinner is
          `loading`; Button's a11y label defaults to the same restoreLabel. */}
      <Button
        label={restoreLabel}
        onPress={onRestore}
        variant={row.serverAnchored ? "secondary" : "muted"}
        size="pill"
        disabled={restoreDisabled}
        loading={busy}
      />
    </View>
  );
}

// Humanized relative formatter — uses the standard wall-clock millisecond
// call directly per the task contract. Kept local rather than hoisted
// because audit-log uses its own i18n key namespace (auditLog.*) while
// this screen uses vaultArchived.* — sharing would just shove a
// key-switching parameter through the helper.
function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return t("vaultArchived.relative.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("vaultArchived.relative.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("vaultArchived.relative.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("vaultArchived.relative.daysAgo", { n: days });
  const months = Math.floor(days / 30);
  return t("vaultArchived.relative.monthsAgo", { n: months });
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
  // Centering box only. The horizontal padding and 12px gap moved into
  // EmptyState (which pads 24/56 itself) — keeping them here would double up.
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
});
