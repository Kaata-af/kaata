// Vault members — Phase 8 (offline-first member management).
//
// Reads from vault_members_mirror (the local cache that sync keeps fresh via
// vault_member_added / role_changed / removed events). Pending invites
// come from pending_invitations (migration 009), refreshed on pull-to-
// refresh against GET /v1/vaults/invites/pending — pull-to-refresh is the
// ONLY network-dependent operation on this screen.
//
// Owner-only mutations (ALL offline-capable as of Phase 8):
//   - Add member         → routes to vault/invite (online invite link). The
//                          in-person QR pair (vault/pair) is PARKED with the
//                          rest of the offline mesh — see the parked row below;
//                          re-add it when mesh ships again.
//   - Send invite link   → routes to vault/invite (online-only; cross-acct)
//   - Change role        → appendVaultMemberRoleChanged event
//   - Remove member      → appendVaultMemberRemoved event
//   - Transfer ownership → two role-change events emitted in sequence
//
// NO API calls fire from action handlers. Server is a sync destination.
// Self-row is non-interactive; last-owner protection enforced at sheet build.

import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BottomSheet, type SheetAction } from "../../components/BottomSheet";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ScreenLoading } from "../../components/ScreenLoading";
import {
  EmptyHint,
  NavRow,
  ScreenHeader,
  SectionGap,
  SectionHeader,
} from "../../components/SettingsScreen";
import { queuePendingToast, useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getActiveVaultId, getDb } from "../../lib/db-tx";
import { getAppMeta, getLocalSelf } from "../../lib/db";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { isPlaceholderSelfName, t } from "../../lib/i18n";
import { radius } from "../../lib/tokens";
import { useVaultRole } from "../../lib/use-vault-role";
import { VAULT_ROLE_RANK } from "../../lib/vault-roles";
import { subscribePresence, isPeerOnline } from "../../lib/mesh/presence";
import { fetchPendingInvitations } from "../../lib/vault-api";
import { appendVaultMemberRemoved, appendVaultMemberRoleChanged } from "../../lib/event-log";
import { transferVaultOwnership } from "../../lib/vault-router";
import type { VaultRole } from "../../lib/events";

type MemberRow = {
  account_id: string;
  role: VaultRole;
  accepted_at: number | null;
  revoked_at: number | null;
  display_name: string | null;
  email: string | null;
};

type PendingInviteRow = {
  invite_token: string;
  invite_email: string;
  role: VaultRole;
  expires_at: number;
};

/** Member avatar + the presence dot pinned to its corner. Both are circles,
 *  so their radii are size/2 rather than literals that can drift from the
 *  diameter (lib/tokens rule 3). */
const AVATAR_SIZE = 44;
const PRESENCE_DOT_SIZE = 12;

export default function VaultMembersScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const params = useLocalSearchParams<{ action?: string }>();

  const [vaultId, setVaultId] = useState<string>("");
  const [accountId, setAccountId] = useState<string | null>(null);
  // Local-self display name. For local-CA mode the `users` table doesn't
  // have a row matching the synthesized account_id (`local:R%...`), so the
  // existing LEFT JOIN returns NULL display_name and the UI fell back to
  // the raw account_id. Use this self-name for the self row regardless.
  const [selfName, setSelfName] = useState<string | null>(null);
  // Local-CA self account id. In local-only mode getAppMeta("account_id")
  // is null, so the standard `m.account_id === accountId` self-detection
  // never matches — every row falls into the "unknown peer" branch and
  // the user's own row shows the generic role label instead of their
  // name. Computing buildLocalAccountId(devicePubkey) lets us match the
  // mirror row that's actually self.
  const [localSelfAccountId, setLocalSelfAccountId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  // account_ids whose device is reachable over the mesh right now (presence).
  const [onlineAccounts, setOnlineAccounts] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingInviteRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetTarget, setSheetTarget] = useState<MemberRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MemberRow | null>(null);
  const [transferTarget, setTransferTarget] = useState<MemberRow | null>(null);

  const role: VaultRole = useVaultRole(vaultId, accountId);
  const isOwner = role === "owner";
  // Roles v2 Phase B: managers manage members too, strictly below manager
  // rank — and their mutations go through REST (server-arbitrated), not
  // offline chain events, per docs/roles-v2-design.md's Phase B blocker:
  // an offline manager acting on a stale view of the target's role would
  // author events the server refuses (permanent local divergence). Owners
  // keep the offline event path unchanged.
  const isManager = role === "manager";

  const loadAll = useCallback(async () => {
    const activeVaultId = await getActiveVaultId();
    if (!activeVaultId) {
      toast.push(t("members.toast.noActive"), "error");
      router.back();
      return;
    }
    setVaultId(activeVaultId);

    const accId = await getAppMeta("account_id");
    setAccountId(accId);

    // Lookup self's display name + local-CA self account id (see state
    // comments above for why both are needed).
    try {
      // Mythos Issue 1 Fix 3: WARM the device-key cache before reading the
      // pubkey. getDevicePubkey() returns only the in-memory cache; on a
      // cold mount it's null, so localSelfAccountId stayed null, the self
      // row failed its isSelf match, and the owner's own row rendered the
      // "Owner" role label instead of their name. ensureDeviceKey()
      // populates the cache (idempotent, cheap on the warm path).
      const deviceKeyMod = await import("../../lib/mesh/device-key");
      await deviceKeyMod.ensureDeviceKey();
      const [self, accountIdMod] = await Promise.all([
        getLocalSelf(),
        import("../../lib/trust/account-id"),
      ]);
      setSelfName(self?.name ?? null);
      const devicePubkey = deviceKeyMod.getDevicePubkey();
      if (devicePubkey) {
        setLocalSelfAccountId(accountIdMod.buildLocalAccountId(devicePubkey));
      }
    } catch {
      setSelfName(null);
    }

    const db = await getDb();
    const rows = await db.getAllAsync<{
      account_id: string;
      role: VaultRole;
      accepted_at: number | null;
      revoked_at: number | null;
      display_name: string | null;
      email: string | null;
    }>(
      // Mythos Issue 1 Fix 2: prefer the mirror's own display_name
      // (persisted from the QR's issuer_display_name at pair time, and
      // from getLocalSelf at vault-create time) over the users LEFT JOIN,
      // which only resolves for the Google-signed-in local-self. This is
      // what lets a paired peer's real name show instead of "Owner".
      `SELECT vmm.account_id   AS account_id,
              vmm.role         AS role,
              vmm.accepted_at  AS accepted_at,
              vmm.revoked_at   AS revoked_at,
              COALESCE(vmm.display_name, u.display_name) AS display_name,
              NULL             AS email
         FROM vault_members_mirror vmm
         LEFT JOIN users u ON u.account_id = vmm.account_id
        WHERE vmm.vault_id = ?
          AND vmm.revoked_at IS NULL
        ORDER BY
          CASE vmm.role
            WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'editor' THEN 2
            WHEN 'clerk' THEN 3 ELSE 4 END,
          vmm.accepted_at ASC`,
      activeVaultId,
    );
    setMembers(rows);

    const inv = await db.getAllAsync<PendingInviteRow>(
      `SELECT token            AS invite_token,
              invited_by_email AS invite_email,
              role,
              expires_at
         FROM pending_invitations
        WHERE vault_id = ? AND declined_at IS NULL
        ORDER BY invited_at DESC`,
      activeVaultId,
    );
    setPending(inv);
  }, [router, toast]);

  // Presence: map online device_ids → account_ids via the device registry so the
  // members list can show a "reachable now" dot. Recomputed on every mesh sync
  // (subscribePresence) and on an interval (to age peers OUT of the window).
  const refreshPresence = useCallback(async () => {
    try {
      const activeVaultId = await getActiveVaultId();
      if (!activeVaultId) {
        setOnlineAccounts(new Set());
        return;
      }
      const db = await getDb();
      const devices = await db.getAllAsync<{ account_id: string; device_id: string }>(
        `SELECT account_id, device_id FROM vault_device_registry
          WHERE vault_id = ? AND removed_at_ms IS NULL`,
        activeVaultId,
      );
      const now = Date.now();
      const online = new Set<string>();
      for (const d of devices) {
        if (d.account_id && d.device_id && isPeerOnline(d.device_id, now)) {
          online.add(d.account_id);
        }
      }
      setOnlineAccounts(online);
    } catch (err) {
      if (__DEV__) console.warn("[vault/members] presence refresh failed", err);
    }
  }, []);

  useEffect(() => {
    void refreshPresence();
    const unsub = subscribePresence(() => void refreshPresence());
    const interval = setInterval(() => void refreshPresence(), 15_000);
    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [refreshPresence]);

  // Re-runs on every focus, not just mount: a member added via vault/pair
  // or an invite sent via vault/invite lands in the mirror while this
  // screen sits beneath them on the stack — popping back must re-query.
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        try {
          await loadAll();
        } catch (err) {
          console.warn("[vault/members] load failed", err);
          toast.push(t("members.toast.loadFailed"), "error");
        } finally {
          setLoaded(true);
        }
      })();
    }, [loadAll, toast]),
  );

  const transferModeHint = params.action === "transfer";

  async function onRefresh() {
    setRefreshing(true);
    let failed = false;
    try {
      // The network fetch gets its own guard: it throws for offline AND
      // local-CA (no JWT) users, and an unguarded throw here used to skip
      // loadAll entirely — pull-to-refresh spun and changed nothing even
      // when the local mirror had new rows.
      try {
        await fetchPendingInvitations();
      } catch (err) {
        failed = true;
        console.warn("[vault/members] invite fetch failed", err);
      }
      // Member display names ride the vaults listing (server accounts.name);
      // fold them into the mirror so rows show people, not role labels.
      // Same offline/local-CA guard rationale as above; a name-heal failure
      // is cosmetic, so it doesn't flip `failed`.
      try {
        const { listVaults } = await import("../../lib/vault-api");
        const { healMemberNamesFromListing } = await import("../../lib/recovery");
        const listing = (await listVaults()).find((v) => v.vault_id === vaultId);
        if (listing) await healMemberNamesFromListing(listing);
      } catch (err) {
        console.warn("[vault/members] member-name heal failed", err);
      }
      await loadAll();
    } catch (err) {
      failed = true;
      console.warn("[vault/members] refresh failed", err);
    } finally {
      setRefreshing(false);
    }
    // Silent refresh failures are indistinguishable from "nothing new".
    if (failed) toast.push(t("common.refreshFailed"), "info");
  }

  function openMemberSheet(m: MemberRow) {
    if (!isOwner && !isManager) return;
    if (m.account_id === accountId) return;
    // Manager cap: owners and peer managers are out of a manager's reach.
    if (isManager && VAULT_ROLE_RANK[m.role] >= VAULT_ROLE_RANK.manager) return;
    setSheetTarget(m);
  }

  // Last-owner guard: derived once per render. Cheap O(n) scan over the
  // members array, no memo needed (render frequency is bounded by row taps).
  const ownerCount = members.filter((m) => m.role === "owner").length;

  // OFFLINE-FIRST mutations: emit the event, optimistically reload the
  // mirror (the projection applier runs synchronously inside applyEvent's
  // transaction so the mirror row is already current by the time
  // loadAll() runs). Sync propagates to peers/server via the existing
  // push/pull infra (Phase 4 Part G).
  //
  // We intentionally DO NOT show a busy overlay on the local-only paths
  // — they're SQLite writes that complete in microseconds. The legacy
  // spinner existed only because the action awaited a network round-trip.

  async function onChangeRole(targetRole: VaultRole) {
    if (!sheetTarget) return;
    const target = sheetTarget;
    setSheetTarget(null);
    // Refuse self-demotion: the role picker is hidden for self (openMemberSheet
    // returns early when target === self), but we double-gate in case a
    // future affordance routes through this function directly.
    if (target.account_id === accountId) {
      toast.push(t("members.toast.cannotChangeSelf"), "error");
      return;
    }
    try {
      if (isManager) {
        // Manager path: REST-first so the SERVER arbitrates the cap against
        // its live state (no stale-view offline events). The local mirror is
        // then stamped for immediate visibility (non-chain-writer precedent:
        // healSelfMembershipFromListing); the target's own device re-heals
        // its role from the vaults listing.
        const { setMemberRole } = await import("../../lib/vault-api");
        await setMemberRole(vaultId, target.account_id, targetRole);
        const db = await getDb();
        await db.runAsync(
          `UPDATE vault_members_mirror SET role = ? WHERE vault_id = ? AND account_id = ?`,
          targetRole,
          vaultId,
          target.account_id,
        );
        const { invalidateVaultRoleCache } = await import("../../lib/use-vault-role");
        invalidateVaultRoleCache(vaultId);
      } else {
        await appendVaultMemberRoleChanged({
          targetVaultId: vaultId,
          accountId: target.account_id,
          role: targetRole,
        });
      }
      toast.push(t("members.toast.roleUpdated"), "success");
      await loadAll();
    } catch (err) {
      console.warn("[vault/members] change role failed", err);
      // Localized copy only — err.message is HTTP/internal jargon.
      toast.push(t("members.toast.roleFailed"), "error");
    }
  }

  async function onRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    try {
      if (isManager) {
        // Manager path: REST-first (see onChangeRole).
        const { revokeMember } = await import("../../lib/vault-api");
        await revokeMember(vaultId, target.account_id);
        const db = await getDb();
        await db.runAsync(
          `UPDATE vault_members_mirror SET revoked_at = ? WHERE vault_id = ? AND account_id = ?`,
          Date.now(),
          vaultId,
          target.account_id,
        );
        const { invalidateVaultRoleCache } = await import("../../lib/use-vault-role");
        invalidateVaultRoleCache(vaultId);
      } else {
        await appendVaultMemberRemoved({
          targetVaultId: vaultId,
          accountId: target.account_id,
        });
      }
      toast.push(t("members.toast.removed"), "success");
      await loadAll();
    } catch (err) {
      console.warn("[vault/members] revoke failed", err);
      toast.push(t("members.toast.removeFailed"), "error");
    }
  }

  // Transfer = "promote target, then demote self" emitted as two
  // sequential events via vault-router. Local-CA vaults stamp two
  // vault_member_role_changed events; server-anchored vaults hit
  // POST /transfer-ownership. The router enforces self-target /
  // not-member / no-account guards AND handles partial-failure recovery
  // (engineering critique 1.e), returning a typed error union we map to
  // specific toasts.
  async function onTransfer() {
    if (!transferTarget) return;
    const target = transferTarget;
    setTransferTarget(null);
    const displayName =
      target.display_name ?? target.email ?? t("members.confirm.transfer.fallback");
    try {
      const res = await transferVaultOwnership(vaultId, target.account_id, accountId);
      if (!res.ok) {
        console.warn("[vault/members] transfer rejected:", res.error.kind);
        // UX critique #2 / #6: map error kinds to specific toasts.
        //   - not_member         → "{name} is no longer a member" (the
        //                          target was removed concurrently via
        //                          mesh propagation between sheet-open
        //                          and tap).
        //   - partial_recovered  → first event committed, second failed,
        //                          we rolled the first back. Vault is in
        //                          its starting state; surface a specific
        //                          message so the user knows nothing
        //                          half-landed.
        //   - partial_unrecovered → both the second event AND the
        //                          rollback failed. Vault has two owners
        //                          until the user resolves it manually.
        //                          Stay on screen so /members can be
        //                          re-loaded with the new state.
        //   - self_target / no_account / noop_demotion → caller bugs the
        //                          sheet's guards already prevent. Fall
        //                          through to generic transferFailed.
        if (res.error.kind === "not_member") {
          toast.push(t("members.toast.transferNotMember", { name: displayName }), "error");
          await loadAll();
          return;
        }
        if (res.error.kind === "partial_recovered") {
          toast.push(t("members.toast.transferPartialRecovered"), "error");
          await loadAll();
          return;
        }
        if (res.error.kind === "partial_unrecovered") {
          toast.push(t("members.toast.transferPartialUnrecovered"), "error");
          await loadAll();
          return; // intentionally do NOT router.back — user must resolve
        }
        toast.push(t("members.toast.transferFailed"), "error");
        return;
      }
      // UX critique #2: name the recipient in the toast AND post via
      // queuePendingToast so the ToastProvider drain on the parent screen
      // surfaces it after router.back() unmounts this screen. push()ing
      // first then back()ing in the same tick can race the unmount on
      // some Android frame schedules; queuePendingToast is the documented
      // pattern (see vault-settings' archive flow).
      queuePendingToast(t("members.toast.transferred", { name: displayName }), "success");
      await loadAll();
      router.back();
    } catch (err) {
      console.warn("[vault/members] transfer failed", err);
      toast.push(t("members.toast.transferFailed"), "error");
    }
  }

  const sheetActions: SheetAction[] = sheetTarget
    ? buildSheetActions(sheetTarget, ownerCount, isOwner ? "owner" : "manager", {
        onChangeRole,
        onRevoke: () => setRevokeTarget(sheetTarget),
        onTransfer: () => setTransferTarget(sheetTarget),
      })
    : [];

  if (!loaded) {
    // Same title / onBack / edges as the loaded branch, so the header is
    // painted (and escapable) before the mirror query resolves and nothing
    // shifts when it does.
    return (
      <ScreenLoading
        title={t("members.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        edges={["top", "bottom"]}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("members.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {transferModeHint && isOwner ? (
          <View style={styles.banner}>
            <Text style={[styles.bannerText, textDir(isRTL)]}>{t("members.transferBanner")}</Text>
          </View>
        ) : null}

        <SectionHeader
          label={t("members.section.members", { count: members.length })}
          isRTL={isRTL}
        />
        {members.length === 0 ? (
          <EmptyHint label={t("members.empty")} isRTL={isRTL} />
        ) : (
          members.map((m, i) => {
            // Self detection: match the signed-in account_id (server-anchored
            // path) OR the local-CA self id derived from the device pubkey
            // (local-only path). Without the second branch, local-only
            // users' own row gets the generic role label instead of their
            // name.
            const isSelf = m.account_id === accountId || m.account_id === localSelfAccountId;
            const last = i === members.length - 1;
            // Display name fallback (local-CA aware). The `users` LEFT
            // JOIN can't resolve synthesized `local:R%abc…` account ids,
            // so display_name comes back NULL for paired peers. Order:
            //   1. users.display_name (server-anchored path)
            //   2. users.email
            //   3. selfName from getLocalSelf — only for the self row
            //   4. role label ("Owner" / "Editor" / "Viewer") — better
            //      than raw "local:R%…" for unknown peers
            // Nameless-peer fallback label — humanizeRole covers all five
            // roles (review fix: the old three-way ternary showed a nameless
            // manager/clerk as "Viewer").
            const roleLabel = humanizeRole(m.role);
            // Self row: a restore-minted placeholder ("You") must not render
            // as "You (You)" — when no REAL name resolves, show the localized
            // "You" once, without the suffix. Real names get the suffix.
            const resolved = m.display_name ?? m.email ?? (isSelf ? selfName : null);
            const realName = resolved && !isPlaceholderSelfName(resolved) ? resolved : null;
            const displayName = isSelf
              ? realName
                ? realName + t("members.youSuffix")
                : t("recovery.selfPlaceholderName")
              : (realName ?? roleLabel);
            return (
              <MemberIdentityRow
                key={m.account_id}
                name={displayName}
                sub={m.email}
                role={m.role}
                isRTL={isRTL}
                online={!isSelf && onlineAccounts.has(m.account_id)}
                onPress={() => openMemberSheet(m)}
                disabled={!isOwner || isSelf}
                isLast={last}
              />
            );
          })
        )}

        {isOwner || isManager ? (
          <>
            {/* PARKED (mesh): the in-person QR pair flow (vault/pair) is parked
                with the rest of the offline mesh. The online invite link is the
                supported way to add a member, so it is now the single primary
                action below. Re-add this row when mesh ships again.
            <NavRow
              icon="qr-code-outline"
              label={t("members.row.addMember")}
              hint={t("members.row.addMember.hint")}
              onPress={() => router.push("/vault/pair")}
              isRTL={isRTL}
              emphasis
            />
            */}
            {/* Online invite link. Requires sign-in + internet; the destination
                screen renders a disabled state when offline so users get clear
                feedback rather than an opaque API error. */}
            <NavRow
              icon="mail-outline"
              label={t("members.row.sendInvite")}
              hint={t("members.row.sendInvite.hint")}
              onPress={() => router.push("/vault/invite")}
              isRTL={isRTL}
              emphasis
              isLast
            />
          </>
        ) : null}

        {pending.length > 0 ? (
          <>
            <SectionGap />
            <SectionHeader
              label={t("members.section.pending", { count: pending.length })}
              isRTL={isRTL}
            />
            {pending.map((p, i) => (
              <MemberIdentityRow
                key={p.invite_token}
                name={p.invite_email}
                sub={t("members.expiresLabel", {
                  when: formatRelative(p.expires_at),
                })}
                role={p.role}
                isRTL={isRTL}
                disabled
                pending
                isLast={i === pending.length - 1}
              />
            ))}
          </>
        ) : null}
      </ScrollView>

      <BottomSheet
        visible={sheetTarget !== null}
        title={
          sheetTarget
            ? t("members.sheet.title", {
                name:
                  sheetTarget.display_name ??
                  sheetTarget.email ??
                  t("members.confirm.transfer.fallback"),
              })
            : ""
        }
        actions={sheetActions}
        onDismiss={() => setSheetTarget(null)}
      />

      <ConfirmDialog
        visible={revokeTarget !== null}
        title={t("members.confirm.remove.title")}
        description={t("members.confirm.remove.body")}
        confirmLabel={t("members.confirm.remove.cta")}
        destructive
        onConfirm={onRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
      <ConfirmDialog
        visible={transferTarget !== null}
        title={
          transferTarget
            ? t("members.confirm.transfer.title", {
                name:
                  transferTarget.display_name ??
                  transferTarget.email ??
                  t("members.confirm.transfer.fallback"),
              })
            : ""
        }
        description={
          transferTarget
            ? t("members.confirm.transfer.body", {
                name:
                  transferTarget.display_name ??
                  transferTarget.email ??
                  t("members.confirm.transfer.fallback"),
              })
            : ""
        }
        // UX critique #1: ownership transfer is irreversible from the
        // demoted side — only the new owner can transfer it back. Mark
        // destructive so the CTA gets the same visual weight as Remove.
        confirmLabel={
          transferTarget
            ? t("members.confirm.transfer.cta", {
                name:
                  transferTarget.display_name ??
                  transferTarget.email ??
                  t("members.confirm.transfer.fallback"),
              })
            : t("members.confirm.transfer.cta.fallback")
        }
        destructive
        onConfirm={onTransfer}
        onCancel={() => setTransferTarget(null)}
      />
    </SafeAreaView>
  );
}

// IdentityRow-style member entry: avatar (initial) + name + email/sub +
// role pill. Matches ProfileSettingsSheet's identity-row proportions.
function MemberIdentityRow(props: {
  name: string;
  sub: string | null;
  role: VaultRole;
  isRTL: boolean;
  online?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  pending?: boolean;
  isLast?: boolean;
}) {
  const initial = (props.name.trim()[0] ?? "?").toUpperCase();
  const body = (
    <View
      style={[styles.identityRow, rowDir(props.isRTL), !props.isLast && styles.identityRowDivider]}
    >
      <View
        style={[
          styles.identityAvatar,
          props.pending && { opacity: 0.55 },
          props.isRTL ? { marginLeft: 14 } : { marginRight: 14 },
        ]}
      >
        <Text style={styles.identityAvatarLetter}>{initial}</Text>
        {/* Presence dot — this member's device synced over the mesh recently. */}
        {props.online ? (
          <View style={[styles.presenceDot, props.isRTL ? { left: -1 } : { right: -1 }]} />
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.identityName, textDir(props.isRTL)]} numberOfLines={1}>
          {props.name}
        </Text>
        {props.sub ? (
          <Text style={[styles.identitySub, textDir(props.isRTL)]} numberOfLines={1}>
            {props.sub}
          </Text>
        ) : null}
      </View>
      <View style={[styles.rolePill, rolePillStyle(props.role)]}>
        <Text
          style={[styles.rolePillText, rolePillTextStyle(props.role), trackingSafe(props.isRTL)]}
        >
          {humanizeRole(props.role)}
        </Text>
      </View>
    </View>
  );
  if (!props.onPress || props.disabled) return body;
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => (pressed ? { backgroundColor: colors.bgMuted } : null)}
    >
      {body}
    </Pressable>
  );
}

function buildSheetActions(
  member: MemberRow,
  ownerCount: number,
  actorRole: "owner" | "manager",
  handlers: {
    onChangeRole: (r: VaultRole) => void;
    onRevoke: () => void;
    onTransfer: () => void;
  },
): SheetAction[] {
  const actions: SheetAction[] = [];

  // Last-owner protection. If the target IS the last owner, hide every
  // action that would demote them or remove them — leaving the vault
  // ownerless is unrecoverable without server intervention. The sheet
  // still opens (controlled by the caller) but the action list is empty.
  const isLastOwner = member.role === "owner" && ownerCount <= 1;
  if (isLastOwner) return actions;

  // Roles v2 Phase B: managers grant strictly below manager (openMemberSheet
  // already caps their TARGETS below manager); only owners mint managers,
  // and only owners transfer ownership.
  if (actorRole === "owner" && member.role !== "manager") {
    actions.push({
      label: t("members.sheet.makeManager"),
      icon: "briefcase-outline",
      onPress: () => handlers.onChangeRole("manager"),
    });
  }
  if (member.role !== "editor") {
    actions.push({
      label: t("members.sheet.makeEditor"),
      icon: "create-outline",
      onPress: () => handlers.onChangeRole("editor"),
    });
  }
  if (member.role !== "clerk") {
    actions.push({
      label: t("members.sheet.makeClerk"),
      icon: "pencil-outline",
      onPress: () => handlers.onChangeRole("clerk"),
    });
  }
  if (member.role !== "viewer") {
    actions.push({
      label: t("members.sheet.makeViewer"),
      icon: "eye-outline",
      onPress: () => handlers.onChangeRole("viewer"),
    });
  }
  if (actorRole === "owner" && member.role !== "owner") {
    actions.push({
      label: t("members.sheet.transfer"),
      icon: "key-outline",
      onPress: handlers.onTransfer,
    });
  }
  actions.push({
    label: t("members.sheet.remove"),
    icon: "person-remove-outline",
    destructive: true,
    onPress: handlers.onRevoke,
  });
  return actions;
}

// UX critique #12: `id.slice(0, 8)` reads like a complete value. Suffix an
// ellipsis so users see it as a truncated identifier.
function shortAccount(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

function formatRelative(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return t("members.expiresIn.soon");
  const hours = Math.floor(diff / 3600_000);
  if (hours < 24) return t("members.expiresIn.hours", { hours });
  const days = Math.floor(hours / 24);
  return t("members.expiresIn.days", { days });
}

function humanizeRole(role: VaultRole): string {
  if (role === "owner") return t("vaultSettings.role.owner");
  if (role === "manager") return t("vaultSettings.role.manager");
  if (role === "editor") return t("vaultSettings.role.editor");
  if (role === "clerk") return t("vaultSettings.role.clerk");
  return t("vaultSettings.role.viewer");
}

// Subtle pill style — much lighter than the previous high-contrast
// badges to match the flat ProfileSettingsSheet language.
function rolePillStyle(role: VaultRole) {
  if (role === "owner") return { backgroundColor: colors.bgInverted };
  return { backgroundColor: colors.bgMuted };
}
function rolePillTextStyle(role: VaultRole) {
  if (role === "owner") return { color: colors.textInverted };
  return { color: colors.textSubtle };
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  scrollContent: { paddingBottom: 48 },

  banner: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: colors.payBg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  bannerText: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.payText,
  },

  // IdentityRow-style member row ------------------------------------------
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 64,
  },
  identityRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  identityAvatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  presenceDot: {
    position: "absolute",
    bottom: -1,
    width: PRESENCE_DOT_SIZE,
    height: PRESENCE_DOT_SIZE,
    borderRadius: PRESENCE_DOT_SIZE / 2,
    // Kept as a literal: lib/colors has no bright-green token, and the
    // nearest (collectStrong #0C745A) is a deep emerald that reads as a
    // balance color, not a live-presence indicator. Don't "tokenize" this
    // by swapping the hue.
    backgroundColor: "#22c55e", // green — reachable over the mesh right now
    borderWidth: 2,
    borderColor: colors.bgDefault,
  },
  identityAvatarLetter: {
    fontSize: 20,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
  },
  identityName: {
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  identitySub: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 1,
  },

  // Role pill -------------------------------------------------------------
  rolePill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    marginLeft: 8,
  },
  rolePillText: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
