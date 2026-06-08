// Vault members — Phase 8 (offline-first member management).
//
// Reads from vault_members_mirror (the local cache that sync keeps fresh via
// vault_member_added / role_changed / removed events). Pending invites
// come from pending_invitations (migration 009), refreshed on pull-to-
// refresh against GET /v1/vaults/invites/pending — pull-to-refresh is the
// ONLY network-dependent operation on this screen.
//
// Owner-only mutations (ALL offline-capable as of Phase 8):
//   - Add member         → routes to vault/pair (in-person QR, with role)
//   - Send invite link   → routes to vault/invite (online-only; cross-acct)
//   - Change role        → appendVaultMemberRoleChanged event
//   - Remove member      → appendVaultMemberRemoved event
//   - Transfer ownership → two role-change events emitted in sequence
//
// NO API calls fire from action handlers. Server is a sync destination.
// Self-row is non-interactive; last-owner protection enforced at sheet build.

import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BottomSheet, type SheetAction } from "../../components/BottomSheet";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  EmptyHint,
  NavRow,
  ScreenHeader,
  SectionGap,
  SectionHeader,
} from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getActiveVaultId, getDb } from "../../lib/db-tx";
import { getAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { useVaultRole } from "../../lib/use-vault-role";
import { fetchPendingInvitations } from "../../lib/vault-api";
import { appendVaultMemberRemoved, appendVaultMemberRoleChanged } from "../../lib/event-log";
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

export default function VaultMembersScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const params = useLocalSearchParams<{ action?: string }>();

  const [vaultId, setVaultId] = useState<string>("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [pending, setPending] = useState<PendingInviteRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetTarget, setSheetTarget] = useState<MemberRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MemberRow | null>(null);
  const [transferTarget, setTransferTarget] = useState<MemberRow | null>(null);

  const role: VaultRole = useVaultRole(vaultId, accountId);
  const isOwner = role === "owner";

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

    const db = await getDb();
    const rows = await db.getAllAsync<{
      account_id: string;
      role: VaultRole;
      accepted_at: number | null;
      revoked_at: number | null;
      display_name: string | null;
      email: string | null;
    }>(
      `SELECT vmm.account_id   AS account_id,
              vmm.role         AS role,
              vmm.accepted_at  AS accepted_at,
              vmm.revoked_at   AS revoked_at,
              u.display_name   AS display_name,
              NULL             AS email
         FROM vault_members_mirror vmm
         LEFT JOIN users u ON u.account_id = vmm.account_id
        WHERE vmm.vault_id = ?
          AND vmm.revoked_at IS NULL
        ORDER BY
          CASE vmm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
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

  useEffect(() => {
    (async () => {
      try {
        await loadAll();
      } catch (err) {
        console.warn("[vault/members] load failed", err);
        toast.push(t("members.toast.loadFailed"), "error");
      } finally {
        setLoaded(true);
      }
    })();
  }, [loadAll, toast]);

  const transferModeHint = params.action === "transfer";

  async function onRefresh() {
    setRefreshing(true);
    try {
      await fetchPendingInvitations();
      await loadAll();
    } catch (err) {
      console.warn("[vault/members] refresh failed", err);
    } finally {
      setRefreshing(false);
    }
  }

  function openMemberSheet(m: MemberRow) {
    if (!isOwner) return;
    if (m.account_id === accountId) return;
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
      await appendVaultMemberRoleChanged({
        targetVaultId: vaultId,
        accountId: target.account_id,
        role: targetRole,
      });
      toast.push(t("members.toast.roleUpdated"), "success");
      await loadAll();
    } catch (err) {
      console.warn("[vault/members] change role failed", err);
      toast.push(err instanceof Error ? err.message : t("members.toast.roleFailed"), "error");
    }
  }

  async function onRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    try {
      await appendVaultMemberRemoved({
        targetVaultId: vaultId,
        accountId: target.account_id,
      });
      toast.push(t("members.toast.removed"), "success");
      await loadAll();
    } catch (err) {
      console.warn("[vault/members] revoke failed", err);
      toast.push(err instanceof Error ? err.message : t("members.toast.removeFailed"), "error");
    }
  }

  // Transfer = atomic "promote target, demote self". applyVaultMemberRoleChanged
  // is LWW per-account, so the within-tick ordering doesn't matter; peers
  // see both events together.
  async function onTransfer() {
    if (!transferTarget || !accountId) return;
    const target = transferTarget;
    setTransferTarget(null);
    try {
      await appendVaultMemberRoleChanged({
        targetVaultId: vaultId,
        accountId: target.account_id,
        role: "owner",
      });
      await appendVaultMemberRoleChanged({
        targetVaultId: vaultId,
        accountId,
        role: "editor",
      });
      toast.push(t("members.toast.transferred"), "success");
      await loadAll();
      router.back();
    } catch (err) {
      console.warn("[vault/members] transfer failed", err);
      toast.push(err instanceof Error ? err.message : t("members.toast.transferFailed"), "error");
    }
  }

  const sheetActions: SheetAction[] = sheetTarget
    ? buildSheetActions(sheetTarget, ownerCount, {
        onChangeRole,
        onRevoke: () => setRevokeTarget(sheetTarget),
        onTransfer: () => setTransferTarget(sheetTarget),
      })
    : [];

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
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
            const isSelf = m.account_id === accountId;
            const last = i === members.length - 1;
            return (
              <MemberIdentityRow
                key={m.account_id}
                name={
                  (m.display_name ?? m.email ?? shortAccount(m.account_id)) +
                  (isSelf ? t("members.youSuffix") : "")
                }
                sub={m.email}
                role={m.role}
                isRTL={isRTL}
                onPress={() => openMemberSheet(m)}
                disabled={!isOwner || isSelf}
                isLast={last}
              />
            );
          })
        )}

        {isOwner ? (
          <>
            {/* PRIMARY: in-person QR pair flow — works fully offline.
                Carries an explicit role so the owner picks what the
                new device gets at QR-gen time (Phase 8 D-PAIR-WITH-ROLE). */}
            <NavRow
              icon="qr-code-outline"
              label={t("members.row.addMember")}
              hint={t("members.row.addMember.hint")}
              onPress={() => router.push("/vault/pair")}
              isRTL={isRTL}
              emphasis
            />
            {/* SECONDARY: legacy email invite. Requires sign-in +
                internet; the destination screen renders a disabled
                state when offline so users get clear feedback rather
                than an opaque API error. */}
            <NavRow
              icon="mail-outline"
              label={t("members.row.sendInvite")}
              hint={t("members.row.sendInvite.hint")}
              onPress={() => router.push("/vault/invite")}
              isRTL={isRTL}
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
        title={t("members.confirm.transfer.title")}
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
        confirmLabel={t("members.confirm.transfer.cta")}
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
        <Text style={[styles.rolePillText, rolePillTextStyle(props.role)]}>
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

  if (member.role !== "editor") {
    actions.push({
      label: t("members.sheet.makeEditor"),
      icon: "create-outline",
      onPress: () => handlers.onChangeRole("editor"),
    });
  }
  if (member.role !== "viewer") {
    actions.push({
      label: t("members.sheet.makeViewer"),
      icon: "eye-outline",
      onPress: () => handlers.onChangeRole("viewer"),
    });
  }
  if (member.role !== "owner") {
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
  if (role === "editor") return t("vaultSettings.role.editor");
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
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
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
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
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
    borderRadius: 999,
    marginLeft: 8,
  },
  rolePillText: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
