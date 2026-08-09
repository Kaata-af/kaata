// Vault settings — "Manage this Kaata". Phase 7 design language shared across
// ProfileSettingsSheet + the other vault/* surfaces. Settings are split into
// three: Account (ProfileSettingsSheet) + USER preferences (/preferences:
// language, default country, app health) + Kaata (THIS screen: name, currency
// (per-kaata), members, danger zone). Language/country/diagnostics are NOT here.
// Owner-only writes; editors/viewers see read-only surface with
// inline "View only" hints rather than hidden controls.
//
// Permission gates: every action consults useVaultPermission(). Non-owners
// see the surfaces but the actionable rows are disabled with an inline
// "View only" hint instead of being hidden, because hiding actions would
// mislead a member into thinking the vault has no owner-level affordances
// at all.
//
// Currency changes emit a vault_setting_set event AFTER the server PATCH
// returns 2xx so the local projection mirrors what the backend
// authoritatively accepted; name changes go through PATCH only (the vault
// name is not event-sourced — it lives in the vaults table directly,
// mirrored to the server-side vaults row by the same PATCH).

import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BottomSheet } from "../../components/BottomSheet";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FormField } from "../../components/FormField";
import { OptionSheet } from "../../components/OptionSheet";
import { ScreenLoading } from "../../components/ScreenLoading";
import {
  EmptyHint,
  NavRow,
  ScreenHeader,
  SectionGap,
  SectionHeader,
} from "../../components/SettingsScreen";
import { queuePendingToast, useToast } from "../../components/Toast";
import { appendVaultSettingSet } from "../../lib/event-log";
import {
  archiveVaultRouted,
  changeVaultCurrency,
  changeVaultName,
  isLocalCAVault,
  leaveVaultRouted,
} from "../../lib/vault-router";
import { colors } from "../../lib/colors";
import {
  clearActiveVaultId,
  getActiveVaultId,
  getActiveVaultIdSyncMaybe,
  getDb,
  setActiveVaultId,
} from "../../lib/db-tx";
import { CURRENCIES, getCurrencyName, setCurrentCurrency } from "../../lib/currency";
import {
  countArchivedPeople,
  getAppMeta,
  listActiveVaults,
  listAllVaultsIncludingArchived,
  setAppMeta,
} from "../../lib/db";
import { resolveAccountIdCandidates } from "../../lib/effective-account";
import { exportVaultReport, type ExportDestination, type ExportFormat } from "../../lib/export";
import { bidiIsolate, rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { icon } from "../../lib/tokens";
import { useVaultPermission, useVaultRole } from "../../lib/use-vault-role";
import { SOLO_STORE_MODE } from "../../constants/env";
import type { VaultRole } from "../../lib/events";

type VaultRow = {
  id: string;
  name: string;
  currency: string;
  archived_at: number | null;
};

/** Vault-summary glyph well. Named so its radius is size/2 rather than a
 *  literal 22 that can drift from the diameter (lib/tokens rule 3). */
const AVATAR_SIZE = 44;

export default function VaultSettingsScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  // D-ARCHIVED-VAULT-FILTER: optional `?id=<vaultId>` route param so the
  // archived-restore affordance can target a specific (non-active) vault.
  // Default falls back to getActiveVaultId() — pre-existing behavior.
  const params = useLocalSearchParams<{ id?: string }>();

  const [loaded, setLoaded] = useState(false);
  const [vault, setVault] = useState<VaultRow | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [memberCount, setMemberCount] = useState<number>(0);
  // Removed-people count. Only loaded (and the row only rendered) when this
  // screen is showing the ACTIVE vault — the removed-people screen operates
  // on the active vault, and settings can target a non-active one (?id=).
  const [removedPeopleCount, setRemovedPeopleCount] = useState<number>(0);

  // Owner-editable fields. Auto-commit on blur.
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string>("AFN");
  const [currencySheetVisible, setCurrencySheetVisible] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [savingCurrency, setSavingCurrency] = useState(false);

  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [transferConfirm, setTransferConfirm] = useState(false);
  // D-LAST-OWNER: when an owner taps Leave on a vault where they are the
  // only remaining owner, we surface an inline "Archive instead?" dialog
  // instead of letting the call go through and produce a backend 4xx
  // (server-anchored) or silently break the vault (local-CA).
  const [lastOwnerConfirm, setLastOwnerConfirm] = useState(false);
  const [busy, setBusy] = useState<"archive" | "leave" | "transfer" | "export" | null>(null);
  const [exportSheetVisible, setExportSheetVisible] = useState(false);

  const vaultId = vault?.id ?? "";
  const role: VaultRole = useVaultRole(vaultId, accountId);
  const canRename = useVaultPermission(vaultId, accountId, "vault.rename");
  const canArchive = useVaultPermission(vaultId, accountId, "vault.archive");
  // Roles v2 review fix: consult the matrix, not a 'viewer' literal — a
  // clerk must not see the Activity row either (clerk: false in PERMISSIONS).
  const canViewAudit = useVaultPermission(vaultId, accountId, "vault.view_audit_log");

  // Read-only, so no permission gate: any member may export what they can
  // already see on screen. The ref is the real re-entry guard — BottomSheet
  // defers actions 220ms and keeps its rows tappable through the exit
  // animation, so a double-tap schedules TWO deferred calls whose closures
  // both captured busy === null; only a call-time ref read stops the second.
  const exportingRef = useRef(false);
  async function onExport(format: ExportFormat, destination: ExportDestination) {
    if (!vault || exportingRef.current || busy !== null) return;
    exportingRef.current = true;
    setBusy("export");
    try {
      // Normalized shape, not the raw row: a blank currency column is an
      // anticipated state (the load path does the same || "AFN") and would
      // render a financial document with unlabeled figures.
      const savedAs = await exportVaultReport(
        { id: vault.id, name: vault.name, currency: vault.currency || "AFN" },
        format,
        destination,
      );
      // Non-null only on a completed save — a share needs no confirmation
      // (the OS sheet is its own feedback) and a cancelled picker is silent.
      if (savedAs) toast.push(t("export.saved", { name: bidiIsolate(savedAs) }), "success");
    } catch (e) {
      console.warn("[vault/settings] export failed", e);
      toast.push(t("vaultSettings.toast.exportFailed"), "error");
    } finally {
      exportingRef.current = false;
      setBusy(null);
    }
  }

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        try {
          // Prefer the explicit route param (archived-restore case) and
          // fall back to the active vault. The param is a single string from
          // expo-router's typed params (could be string | string[]); narrow
          // it conservatively.
          const paramId = typeof params.id === "string" ? params.id : undefined;
          const targetVaultId = paramId ?? (await getActiveVaultId());
          if (!targetVaultId) {
            toast.push(t("vaultSettings.toast.noActive"), "error");
            router.back();
            return;
          }
          const db = await getDb();
          const row = await db.getFirstAsync<VaultRow>(
            `SELECT id, name, currency, archived_at FROM vaults WHERE id = ? LIMIT 1`,
            targetVaultId,
          );
          if (!row) {
            toast.push(t("vaultSettings.toast.notFound"), "error");
            router.back();
            return;
          }
          setVault(row);
          setName(row.name);
          setCurrency(row.currency || "AFN");

          const accId = await getAppMeta("account_id");
          setAccountId(accId);

          const count = await db.getFirstAsync<{ n: number }>(
            `SELECT COUNT(*) AS n FROM vault_members_mirror
            WHERE vault_id = ? AND revoked_at IS NULL`,
            targetVaultId,
          );
          // Same floor logic as useMembersCount in use-vault-summary.ts —
          // an empty mirror in Phase 2 / local-only mode means "no rows yet"
          // but the user IS a member of their own vault. Without this floor,
          // settings shows "0 people" while the picker shows "1 member" and
          // the two surfaces disagree.
          const raw = count?.n ?? 0;
          setMemberCount(raw === 0 ? 1 : raw);

          // Removed-people row: active vault only (see state comment).
          const activeId = getActiveVaultIdSyncMaybe();
          setRemovedPeopleCount(
            activeId === targetVaultId ? await countArchivedPeople(targetVaultId) : 0,
          );
        } catch (err) {
          console.warn("[vault/settings] load failed", err);
          toast.push(t("vaultSettings.toast.loadFailed"), "error");
          // Leave like the noActive/notFound branches above do — loaded=true
          // with vault=null strands the user on a header-less spinner.
          router.back();
        } finally {
          setLoaded(true);
        }
      })();
      // Re-runs on focus (not mount-only): popping back from members/
      // invite/pair must re-read role, member count and vault row, or a
      // transfer completed on the members screen leaves this screen
      // showing stale owner-only rows.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params.id]),
  );

  async function commitName() {
    const trimmed = name.trim();
    if (!vault) return;
    if (!canRename) return;
    if (!trimmed) {
      setNameError(t("vaultSettings.name.required"));
      return;
    }
    if (trimmed === vault.name) return;
    setNameError(null);
    setSavingName(true);
    try {
      // changeVaultName branches: local-CA emits vault_setting_set (the
      // applier mirrors to vaults.name); server-anchored does PATCH and we
      // mirror locally below since PATCH doesn't trip our projection.
      const result = await changeVaultName(vault.id, trimmed);
      if (result.kind === "server") {
        const db = await getDb();
        await db.runAsync(
          `UPDATE vaults SET name = ?, updated_at = ? WHERE id = ?`,
          trimmed,
          Date.now(),
          vault.id,
        );
      }
      setVault({ ...vault, name: trimmed });
      toast.push(t("vaultSettings.toast.saved"), "success");
    } catch (err) {
      console.warn("[vault/settings] patch name failed", err);
      toast.push(t("vaultSettings.toast.saveFailed"), "error");
      setName(vault.name);
    } finally {
      setSavingName(false);
    }
  }

  async function commitCurrency(next: string) {
    if (!vault) return;
    if (!canRename) return;
    if (next === vault.currency) return;
    setSavingCurrency(true);
    try {
      // changeVaultCurrency: local-CA emits one event (the applier mirrors
      // to vaults.currency). Server-anchored does PATCH first then emits the
      // event so the local projection records it.
      await changeVaultCurrency(vault.id, next);
      setVault({ ...vault, currency: next });
      setCurrency(next);
      // The active kaata's currency is also what amounts render in
      // (getCurrentCurrencySymbol reads the global default). Mirror it so
      // changing currency here actually changes what the shopkeeper sees —
      // otherwise the per-vault picker silently had no visible effect. (Solo:
      // one kaata = one display currency.) Guard on the ACTIVE vault: this
      // screen can be opened for a non-active (e.g. archived) vault via the
      // ?id= param, and editing THAT vault must not repaint the home screen's
      // currency.
      if (vault.id === getActiveVaultIdSyncMaybe()) {
        setCurrentCurrency(next);
        await setAppMeta("default_currency", next);
      }
      toast.push(t("vaultSettings.toast.currencyUpdated"), "success");
    } catch (err) {
      console.warn("[vault/settings] patch currency failed", err);
      toast.push(t("vaultSettings.toast.currencyFailed"), "error");
      setCurrency(vault.currency);
    } finally {
      setSavingCurrency(false);
    }
  }

  async function onArchive() {
    if (!vault || !canArchive) return;
    setArchiveConfirm(false);
    setBusy("archive");
    try {
      await archiveVaultRouted(vault.id);

      // Promptly + durably push the just-authored archive event (a
      // vault_setting_set) so the server learns the vault is archived even if the
      // user closes the app right after — otherwise it resurrects as a live kaata
      // on reinstall+restore. FIRE-AND-FORGET (void, not awaited) so a slow link
      // never holds the user on this screen; the per-write kick + background flush
      // are the backstops. Offline / transient just falls back to those.
      void (async () => {
        try {
          const { syncOnce } = await import("../../lib/sync");
          await syncOnce({ vaultId: vault.id });
        } catch (err) {
          if (__DEV__) console.warn("[vault/settings] archive flush failed", err);
        }
      })();

      // D-POST-ARCHIVE-SWITCH: the applier has updated vaults.archived_at
      // synchronously via archiveVaultRouted. Decide what the active
      // vault should be now and where to route:
      //   1. If the just-archived vault was NOT the active one, just
      //      toast + return home — the user's active context is intact.
      //   2. If it WAS the active vault, pick the most-recently-updated
      //      remaining non-archived vault and switch to it.
      //   3. If no non-archived vaults remain, clear the active pointer
      //      and route to /vault/new with an explanatory toast.
      const activeId = getActiveVaultIdSyncMaybe();
      if (activeId !== vault.id) {
        queuePendingToast(t("vaultSettings.archive.success"), "success");
        router.replace("/");
        return;
      }

      // Re-query active vaults ranked by most-recent activity. We sort
      // by vaults.updated_at because listActiveVaults() orders
      // alphabetically; for the "next vault to land on" decision
      // recency is the better heuristic (matches what the user was last
      // working in). One LIMIT 1 query — no dead double-fetch.
      const db = await getDb();
      const next = await db.getFirstAsync<{ id: string; name: string }>(
        `SELECT id, name
           FROM vaults
          WHERE archived_at IS NULL
          ORDER BY updated_at DESC, name COLLATE NOCASE
          LIMIT 1`,
      );
      if (next) {
        await setActiveVaultId(next.id);
        queuePendingToast(
          t("vaultSettings.archive.successSwitched", {
            old: vault.name,
            name: next.name,
          }),
          "success",
        );
        router.replace("/");
        return;
      }

      // No surviving active vault. Clear the active pointer atomically
      // (DELETE FROM app_meta + cache null) so subsequent reads correctly
      // return null. UX-fix #1: if archived vaults exist, route to
      // /vault/archived first (restoring is faster than re-creating, and
      // the user just intentionally archived this vault). Only land on
      // /vault/new when the archived list is empty too.
      await clearActiveVaultId();
      const archivedCount = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM vaults WHERE archived_at IS NOT NULL`,
      );
      const archivedAvailable = (archivedCount?.n ?? 0) > 0;
      if (archivedAvailable) {
        queuePendingToast(t("vaultSettings.archive.successNeedRestore"), "success");
        router.replace("/vault/archived");
        return;
      }
      queuePendingToast(t("vaultSettings.archive.successNeedNew"), "success");
      // No kaatas left → home's "no kaatas yet" screen (deliberate create/join,
      // no silent auto-create). (Matee.)
      router.replace("/");
    } catch (err) {
      console.warn("[vault/settings] archive failed", err);
      // Localized copy only — err.message is HTTP/internal jargon.
      toast.push(t("vaultSettings.toast.archiveFailed"), "error");
    } finally {
      setBusy(null);
    }
  }

  // Unarchive a previously-archived vault. For local-CA vaults, emit a
  // vault_setting_set event with key="archived_at" and value="" (the
  // applier parses "" as null → clears archived_at). For server-anchored
  // vaults, the operation is presently not supported by the backend so we
  // surface a clear error toast instead of failing silently.
  async function onUnarchive() {
    if (!vault || !canArchive) return;
    setBusy("archive");
    try {
      const local = await isLocalCAVault(vault.id);
      if (!local) {
        // Server-anchored vaults can't be unarchived from the client
        // without a backend endpoint that doesn't exist yet. Surface
        // the limitation rather than failing silently.
        toast.push(t("vaultSettings.toast.unarchiveFailed"), "error");
        return;
      }
      await appendVaultSettingSet({
        targetVaultId: vault.id,
        key: "archived_at",
        value: "",
      });
      setVault({ ...vault, archived_at: null });
      toast.push(t("vaultSettings.toast.unarchived"), "success");
    } catch (err) {
      console.warn("[vault/settings] unarchive failed", err);
      toast.push(t("vaultSettings.toast.unarchiveFailed"), "error");
    } finally {
      setBusy(null);
    }
  }

  // D-LAST-OWNER: returns true iff the current user is the sole remaining
  // owner of the vault. Reads from vault_members_mirror, which is the
  // authoritative projection on both local-CA and server-anchored vaults.
  // Also treats the 0-owner edge case (data corruption / replay glitch) as
  // last-owner so we don't accidentally allow the user to "complete" a
  // last-owner-leaves transition that would leave the vault ownerless.
  async function isLastOwner(): Promise<boolean> {
    if (!vault) return false;
    // "Can't just leave" = there is no OTHER active owner to hold the kaata.
    //
    // We count active owner rows that are NOT me — me being ANY of my account
    // ids (the Google account_id AND the local device-key id; see
    // resolveAccountIdCandidates). A plain "count < 2" broke on a corrupted
    // solo store that had BOTH a device-key owner row and a Google-id owner row
    // (both me) → count 2 → looked like a co-owned vault → fell through to
    // leaveVaultRouted → "Failed to leave". Excluding all of my ids means: if
    // nobody ELSE owns this kaata, leaving ends it → route to "Archive
    // instead?" and never error. (Matee: "leave still says failed to leave".)
    const candidates = await resolveAccountIdCandidates(accountId);
    if (candidates.length === 0) return true; // no identity → lone local owner
    const db = await getDb();
    const placeholders = candidates.map(() => "?").join(",");
    const otherOwners = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM vault_members_mirror
        WHERE vault_id = ? AND role = 'owner' AND revoked_at IS NULL
          AND account_id NOT IN (${placeholders})`,
      vault.id,
      ...candidates,
    );
    return (otherOwners?.n ?? 0) === 0;
  }

  async function onLeave() {
    if (!vault) return;
    setLeaveConfirm(false);

    // Client-side last-owner gate runs first on BOTH local-CA and
    // server-anchored vaults. For local-CA we have no server to bounce
    // off — a vault with zero owners is unrecoverable. For server-
    // anchored we still check first so the user sees a helpful inline
    // dialog instead of a generic "Failed to leave" toast from a 4xx.
    if (role === "owner") {
      try {
        if (await isLastOwner()) {
          setLastOwnerConfirm(true);
          return;
        }
      } catch (err) {
        console.warn("[vault/settings] last-owner check failed", err);
        // Fall through and let the leave attempt fail loudly — better
        // than silently allowing a leave on a last-owner vault.
      }
    }

    setBusy("leave");
    try {
      const res = await leaveVaultRouted(vault.id, accountId);
      if (!res.ok) {
        if (res.error.kind === "last_owner") {
          // Race: between isLastOwner() and leaveVaultRouted's own check
          // some other event landed. Surface the same dialog.
          setLastOwnerConfirm(true);
          return;
        }
        // Both no_account and not_member surface the same toast (the user
        // doesn't need to know whether they're missing an account binding
        // or a membership row — either way "leaving" failed). The
        // previous ternary mapped both branches to the SAME string;
        // collapsing it removes the dead code without losing copy.
        toast.push(t("vaultSettings.toast.leaveFailed"), "error");
        return;
      }
      // Queue the success toast for the destination screen — toast.push
      // here would not survive the router.replace below (the toast
      // viewport unmounts before the queue tick fires).
      queuePendingToast(t("vaultSettings.toast.left"), "success");

      // D-POST-LEAVE-SWITCH: the kaata I just left must stop being the active
      // one (it's gone from the switcher list too). If it was active, move to
      // another kaata I'm still in; if none remain, clear the pointer and route
      // to restore/create. Mirrors D-POST-ARCHIVE-SWITCH. (Matee: "I leave a
      // kaata ... but it still shows in the switcher and still opened.")
      if (getActiveVaultIdSyncMaybe() === vault.id) {
        // listActiveVaults already excludes the just-left vault (revoked
        // membership) + archived; filter the id too for belt-and-suspenders
        // (server-anchored leaves don't update the local mirror immediately).
        const remaining = (await listActiveVaults()).filter((v) => v.id !== vault.id);
        if (remaining.length > 0) {
          await setActiveVaultId(remaining[0].id);
          router.replace("/");
        } else {
          await clearActiveVaultId();
          const anyArchived = (await listAllVaultsIncludingArchived()).some((v) => v.archived);
          if (anyArchived) {
            router.replace("/vault/archived");
          } else {
            // No kaatas left → home's "no kaatas yet" screen.
            router.replace("/");
          }
        }
      } else {
        router.replace("/");
      }
    } catch (err) {
      console.warn("[vault/settings] leave failed", err);
      toast.push(t("vaultSettings.toast.leaveFailed"), "error");
    } finally {
      setBusy(null);
    }
  }

  // User accepted "Archive instead" from the last-owner dialog. Routes
  // through the same onArchive path so server-vs-local branching stays
  // in one place.
  async function onArchiveFromLastOwner() {
    setLastOwnerConfirm(false);
    await onArchive();
  }

  // User picked "Transfer ownership" from the last-owner dialog — gives
  // them a forward path to actually leave (transfer + then leave) without
  // having to dismiss this dialog manually and hunt for the row in
  // settings. Routes through the existing onTransfer path so the
  // member-picker flow doesn't fork.
  function onTransferFromLastOwner() {
    setLastOwnerConfirm(false);
    onTransfer();
  }

  function onTransfer() {
    if (!vault) return;
    setTransferConfirm(false);
    // Transfer-ownership UX needs a target picker; for Phase 4 v1 we route
    // through the members screen which has the picker. This is just a
    // convenience entry point — the actual call happens there.
    router.push({
      pathname: "/vault/members",
      params: { action: "transfer" },
    });
  }

  if (!loaded || !vault) {
    // Same title / onBack / edges as the loaded branch below. The old bare
    // spinner had no header (no escape while a slow load hung) AND no `edges`,
    // so the whole screen jumped by the top inset the instant it resolved.
    return (
      <ScreenLoading
        title={t("vaultSettings.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        edges={["top", "bottom"]}
      />
    );
  }

  const currencyValue =
    `${CURRENCIES.find((c) => c.code === currency)?.symbol ?? ""}  ${getCurrencyName(currency)}`.trim();

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("vaultSettings.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
        >
          {/* Identity-style vault summary row — mirrors ProfileSettingsSheet's
              identity row (avatar + name + email) but uses a folder glyph +
              role instead of an avatar. Flat layout, no bordered card. */}
          <View style={[styles.summaryRow, rowDir(isRTL)]}>
            <View style={[styles.summaryAvatar, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}>
              <Ionicons name="folder-outline" size={icon.row} color={colors.textEmphasis} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.summaryName, textDir(isRTL)]} numberOfLines={1}>
                {vault.name}
              </Text>
              <Text style={[styles.summaryRole, textDir(isRTL)]} numberOfLines={1}>
                {humanizeRole(role)}
              </Text>
            </View>
          </View>

          <SectionGap />

          {/* ============ DETAILS ============ */}
          <SectionHeader label={t("vaultSettings.section.details")} isRTL={isRTL} />
          <View style={styles.formInset}>
            <FormField
              label={t("vaultSettings.name.label")}
              required
              value={name}
              editable={canRename && !savingName}
              onChangeText={(s) => {
                setName(s);
                if (nameError) setNameError(null);
              }}
              onBlur={commitName}
              error={nameError}
            />
            {!canRename ? (
              <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("vaultSettings.viewOnly")}</Text>
            ) : null}
          </View>
          {/* Currency is PER-KAATA. Row→sheet picker so it matches the default-
              country picker in user Preferences (Matee: "currency options and
              default country options should match"). Language + default country +
              app health are USER preferences and live in /preferences, NOT here. */}
          <NavRow
            icon="cash-outline"
            label={t("vaultSettings.currency.label")}
            trailing={currencyValue}
            onPress={() => setCurrencySheetVisible(true)}
            disabled={!canRename || savingCurrency}
            isRTL={isRTL}
            isLast
          />

          <SectionGap />

          {/* ============ MEMBERS ============
              Shown in solo mode too: sharing the ledger (adding a family member
              or a second phone) is a solo-store feature, and the lone owner
              needs to find where to add people. (Matee: "where did the members
              settings go? where I added members".) */}
          <SectionHeader label={t("vaultSettings.section.members")} isRTL={isRTL} />
          <NavRow
            icon="people-outline"
            label={t("vaultSettings.row.members")}
            hint={
              memberCount === 1
                ? t("vaultSettings.row.members.hint.one")
                : t("vaultSettings.row.members.hint.many", {
                    count: memberCount,
                  })
            }
            onPress={() => router.push("/vault/members")}
            isRTL={isRTL}
            isLast
          />
          <SectionGap />

          {/* ============ ACTIVITY ============ */}
          <SectionHeader label={t("vaultSettings.section.activity")} isRTL={isRTL} />
          {canViewAudit ? (
            <NavRow
              icon="time-outline"
              label={t("vaultSettings.row.audit")}
              hint={
                role === "owner"
                  ? t("vaultSettings.row.audit.hint.owner")
                  : t("vaultSettings.row.audit.hint.editor")
              }
              onPress={() => router.push("/vault/audit-log")}
              isRTL={isRTL}
              isLast
            />
          ) : (
            <EmptyHint label={t("vaultSettings.row.audit.viewerEmpty")} isRTL={isRTL} />
          )}

          <SectionGap />

          {/* ============ EXPORT ============ */}
          <SectionHeader label={t("vaultSettings.section.export")} isRTL={isRTL} />
          <NavRow
            icon="download-outline"
            label={t("vaultSettings.row.export")}
            hint={t("vaultSettings.row.export.hint")}
            onPress={() => setExportSheetVisible(true)}
            isRTL={isRTL}
            disabled={busy !== null}
            trailing={busy === "export" ? <ActivityIndicator size="small" /> : undefined}
            isLast
          />

          <SectionGap />

          {/* ============ PEOPLE (removed) ============
              Rendered only when the ACTIVE vault has removed people — the
              row is the sole doorway to their kept entries, and hiding it
              at zero keeps settings clutter-free (same only-when-nonempty
              rule as the switcher's "Archived (n)" row). */}
          {removedPeopleCount > 0 ? (
            <>
              <SectionHeader label={t("vaultSettings.section.people")} isRTL={isRTL} />
              <NavRow
                icon="person-remove-outline"
                label={t("vaultSettings.row.removedPeople")}
                trailing={String(removedPeopleCount)}
                onPress={() => router.push("/vault/removed-people")}
                isRTL={isRTL}
                isLast
              />
              <SectionGap />
            </>
          ) : null}

          {/* ============ DANGER / MEMBERSHIP ============
              Phase 7 UX critique #5: BOTH branches' "Leave Kaata" now
              carry the danger color — losing vault access is destructive
              regardless of role. Previously the owner-branch row used
              the default color while the non-owner branch used danger,
              creating an inconsistent visual signal for the same action. */}
          {role === "owner" ? (
            <>
              <SectionHeader label={t("vaultSettings.section.danger")} isRTL={isRTL} />
              {/* Transfer ownership is a multi-account action — hidden in solo. */}
              {/* NO Leave row for owners (operator decision 2026-07-27): an
                  owner's exit path is Transfer ownership, whose flow already
                  offers "transfer and leave" — a sole owner tapping Leave
                  could only ever hit the last-owner refusal. */}
              {!SOLO_STORE_MODE ? (
                <NavRow
                  icon="key-outline"
                  label={t("vaultSettings.row.transfer")}
                  onPress={() => setTransferConfirm(true)}
                  isRTL={isRTL}
                  disabled={busy !== null}
                />
              ) : null}
              {/* D-ARCHIVED-VAULT-FILTER: if the vault is already
                  archived, surface "Unarchive" instead of "Archive". This
                  closes the dead-end where tapping an archived row in
                  VaultPickerSheet routed here but the only danger-zone
                  affordance was Archive (a no-op on an archived vault).
                  Unarchive is non-destructive so we drop the `danger`
                  prop. */}
              {vault.archived_at == null ? (
                <NavRow
                  icon="archive-outline"
                  label={t("vaultSettings.row.archive")}
                  onPress={() => setArchiveConfirm(true)}
                  isRTL={isRTL}
                  disabled={busy !== null}
                  danger
                  trailing={busy === "archive" ? <ActivityIndicator size="small" /> : undefined}
                  isLast
                />
              ) : (
                <NavRow
                  icon="archive-outline"
                  label={t("vaultSettings.row.unarchive")}
                  onPress={onUnarchive}
                  isRTL={isRTL}
                  disabled={busy !== null}
                  trailing={busy === "archive" ? <ActivityIndicator size="small" /> : undefined}
                  isLast
                />
              )}
            </>
          ) : (
            <>
              <SectionHeader label={t("vaultSettings.section.membership")} isRTL={isRTL} />
              <NavRow
                icon="exit-outline"
                label={t("vaultSettings.row.leave")}
                onPress={() => setLeaveConfirm(true)}
                isRTL={isRTL}
                disabled={busy !== null}
                danger
                trailing={busy === "leave" ? <ActivityIndicator size="small" /> : undefined}
                isLast
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={archiveConfirm}
        title={t("vaultSettings.confirm.archive.title")}
        description={t("vaultSettings.confirm.archive.body")}
        confirmLabel={t("vaultSettings.confirm.archive.cta")}
        destructive
        onConfirm={onArchive}
        onCancel={() => setArchiveConfirm(false)}
      />
      <ConfirmDialog
        visible={leaveConfirm}
        title={t("vaultSettings.confirm.leave.title")}
        description={
          role === "owner"
            ? t("vaultSettings.confirm.leave.body.owner")
            : t("vaultSettings.confirm.leave.body.member")
        }
        confirmLabel={t("vaultSettings.confirm.leave.cta")}
        destructive
        onConfirm={onLeave}
        onCancel={() => setLeaveConfirm(false)}
      />
      {/* D-LAST-OWNER protection — surfaced when an owner taps Leave on a
          vault where they are the sole remaining owner. The Archive
          affordance is the only forward action; Cancel returns the user
          to the settings screen unchanged. Replaces the previous backend-
          error toast ("only owner cannot leave") which read as a system
          failure rather than guidance. */}
      <ConfirmDialog
        visible={lastOwnerConfirm}
        title={t("vaultSettings.leave.lastOwner.title")}
        description={t("vaultSettings.leave.lastOwner.body")}
        // Primary confirm = Archive (destructive); tertiary = Transfer
        // (non-destructive primary, sits between Cancel and Archive). The
        // tertiary slot gives the user a forward path that doesn't end the
        // Kaata's life — most last-owners actually want "promote Ahmad to
        // owner and then I leave", not "kill it".
        confirmLabel={t("vaultSettings.leave.lastOwner.archive")}
        cancelLabel={t("vaultSettings.leave.lastOwner.cancel")}
        tertiaryLabel={memberCount > 1 ? t("vaultSettings.leave.lastOwner.transfer") : undefined}
        onTertiary={memberCount > 1 ? onTransferFromLastOwner : undefined}
        destructive
        onConfirm={onArchiveFromLastOwner}
        onCancel={() => setLastOwnerConfirm(false)}
      />
      <ConfirmDialog
        visible={transferConfirm}
        title={t("vaultSettings.confirm.transfer.title")}
        description={t("vaultSettings.confirm.transfer.body")}
        confirmLabel={t("vaultSettings.confirm.transfer.cta")}
        onConfirm={onTransfer}
        onCancel={() => setTransferConfirm(false)}
      />

      {/* Per-kaata currency picker — row→sheet, matching the country picker. */}
      <OptionSheet
        visible={currencySheetVisible}
        title={t("vaultSettings.currency.label")}
        options={CURRENCIES.map((c) => ({
          key: c.code,
          label: getCurrencyName(c.code),
          leading: c.symbol,
        }))}
        selected={currency}
        onSelect={(code) => {
          setCurrencySheetVisible(false);
          void commitCurrency(code);
        }}
        onDismiss={() => setCurrencySheetVisible(false)}
        isRTL={isRTL}
      />

      {/* Export chooser. BottomSheet's 220ms action defer doubles as
          clearance for the OS share sheet that follows generation — the
          sheet's Modal is fully unmounted before shareAsync presents. */}
      <BottomSheet
        visible={exportSheetVisible}
        title={t("vaultSettings.export.sheetTitle")}
        onDismiss={() => setExportSheetVisible(false)}
        actions={[
          {
            label: t("export.action.sharePdf"),
            icon: "share-outline",
            onPress: () => void onExport("pdf", "share"),
          },
          {
            label: t("export.action.shareCsv"),
            icon: "share-outline",
            onPress: () => void onExport("csv", "share"),
          },
          {
            label: t("export.action.savePdf"),
            icon: "download-outline",
            onPress: () => void onExport("pdf", "save"),
          },
          {
            label: t("export.action.saveCsv"),
            icon: "download-outline",
            onPress: () => void onExport("csv", "save"),
          },
        ]}
      />
    </SafeAreaView>
  );
}

function humanizeRole(role: VaultRole): string {
  if (role === "owner") return t("vaultSettings.role.owner");
  if (role === "manager") return t("vaultSettings.role.manager");
  if (role === "editor") return t("vaultSettings.role.editor");
  if (role === "clerk") return t("vaultSettings.role.clerk");
  return t("vaultSettings.role.viewer");
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },

  scrollContent: { paddingBottom: 48 },

  // Vault summary (replaces the v0 vaultHeaderCard pattern) ---------------
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 64,
  },
  summaryAvatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryName: {
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  summaryRole: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 1,
  },

  // Form inset for the name FormField.
  formInset: { paddingHorizontal: 20, paddingTop: 4 },

  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 0,
    marginBottom: 12,
  },
});
