// Ownership links are email-bound and do not change any roles until accepted.
// The plaintext link stays in this screen's memory; restored pending status
// deliberately contains only the recipient and expiry.
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Network from "expo-network";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FormField, LTR_INPUT } from "../../components/FormField";
import { ScreenLoading } from "../../components/ScreenLoading";
import {
  EmptyHint,
  NavRow,
  ScreenHeader,
  SectionGap,
  SectionHeader,
} from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import {
  applyForCurrentSession,
  captureCurrentSession,
  type SessionSnapshot,
} from "../../lib/auth";
import { colors } from "../../lib/colors";
import {
  getActiveVaultId,
  getActiveVaultIdSyncMaybe,
  getAccountIdSync,
  getDb,
} from "../../lib/db-tx";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { t } from "../../lib/i18n";
import { useLedgerRefresh } from "../../lib/ledger-events";
import { icon, radius, typography } from "../../lib/tokens";
import { readVaultRole, useVaultRole } from "../../lib/use-vault-role";
import {
  ApiError,
  cancelOwnershipTransferInvite,
  createOwnershipTransferInvite,
  fetchOwnershipTransferInvite,
} from "../../lib/vault-api";

type Scope = { vaultId: string; name: string; session: SessionSnapshot };
type Pending = { recipient_email: string; expires_at: number };
type ReadyLink = Pending & { url: string };
type Blocker = "signedOut" | "offline" | "unavailable" | "loadFailed" | null;
const EMBLEM_SIZE = 56;

export default function VaultTransferScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const [scope, setScope] = useState<Scope | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [blocker, setBlocker] = useState<Blocker>(null);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [link, setLink] = useState<ReadyLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [createConfirm, setCreateConfirm] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const focused = useRef(false);
  const generation = useRef(0);
  const working = useRef(false);
  const sharing = useRef(false);
  const scopeRef = useRef<Scope | null>(null);
  const role = useVaultRole(scope?.vaultId ?? "", scope?.session.accountId ?? null);
  const roleRef = useRef(role);
  roleRef.current = role;

  const isCurrent = useCallback(
    (target: Scope, request?: number) =>
      focused.current &&
      (request === undefined || request === generation.current) &&
      getActiveVaultIdSyncMaybe() === target.vaultId &&
      getAccountIdSync() === target.session.accountId,
    [],
  );

  // Repeat the actual session and role checks immediately before a request,
  // and before exposing its reply. A covered screen or changed account must
  // never publish an old owner's link or send a request for another kaata.
  const authorized = useCallback(
    async (target: Scope, request?: number) => {
      if (!isCurrent(target, request) || roleRef.current !== "owner") return false;
      try {
        return await applyForCurrentSession(target.session, async () => {
          const currentRole = await readVaultRole(target.vaultId, target.session.accountId);
          return (
            currentRole === "owner" && roleRef.current === "owner" && isCurrent(target, request)
          );
        });
      } catch {
        return false;
      }
    },
    [isCurrent],
  );

  const load = useCallback(async () => {
    if (!focused.current || working.current) return;
    const request = ++generation.current;
    let target: Scope | null = null;
    try {
      const [vaultId, session] = await Promise.all([getActiveVaultId(), captureCurrentSession()]);
      if (!focused.current || request !== generation.current) return;
      if (!vaultId) {
        router.back();
        return;
      }
      const changed =
        scopeRef.current?.vaultId !== vaultId ||
        scopeRef.current?.session.bindingVersion !== session.bindingVersion ||
        scopeRef.current?.session.accountId !== session.accountId;
      if (changed) {
        setBusy(false);
        setLink(null);
        setPending(null);
        setEmail("");
        setEmailError(null);
        setCreateConfirm(false);
        setCancelConfirm(false);
        setLoaded(false);
      }
      const db = await getDb();
      const row = await db.getFirstAsync<{ name: string; archived_at: number | null }>(
        "SELECT name, archived_at FROM vaults WHERE id = ? LIMIT 1",
        vaultId,
      );
      target = { vaultId, session, name: row?.name ?? "" };
      if (!isCurrent(target, request)) return;
      scopeRef.current = target;
      setScope(target);
      if (!session.jwt || !session.accountId) {
        setBlocker("signedOut");
        return;
      }
      if (!row || row.archived_at !== null) {
        setBlocker("unavailable");
        return;
      }
      if (!(await authorized(target, request))) {
        if (isCurrent(target, request)) setBlocker("unavailable");
        return;
      }
      const network = await Network.getNetworkStateAsync();
      if (!isCurrent(target, request)) return;
      if (!network.isConnected || network.isInternetReachable === false) {
        setBlocker("offline");
        return;
      }
      const current = await fetchOwnershipTransferInvite(vaultId, target.session);
      if (!(await authorized(target, request))) return;
      setBlocker(null);
      setPending(current);
      setLink((previous) =>
        current &&
        previous &&
        previous.recipient_email === current.recipient_email &&
        previous.expires_at === current.expires_at
          ? previous
          : null,
      );
    } catch (error) {
      if (target && isCurrent(target, request)) {
        setLink(null);
        setBlocker(
          error instanceof ApiError && [403, 404, 409].includes(error.status)
            ? "unavailable"
            : "loadFailed",
        );
      } else if (!target && focused.current && request === generation.current) {
        toast.push(t("ownershipTransfer.loadFailed"), "error");
        router.back();
      }
    } finally {
      if (focused.current && request === generation.current) setLoaded(true);
    }
  }, [authorized, isCurrent, router, toast]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      const sub = AppState.addEventListener("change", (state) => {
        if (state === "active") void load();
      });
      return () => {
        focused.current = false;
        generation.current++;
        sub.remove();
      };
    }, [load]),
  );

  useLedgerRefresh(null, () => {
    void load();
  });
  useEffect(() => {
    if (role === "owner") return;
    setLink(null);
    setPending(null);
    setCreateConfirm(false);
    setCancelConfirm(false);
  }, [role]);

  function showCreateConfirmation() {
    if (working.current || blocker || pending || role !== "owner") return;
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setEmailError(t(value ? "invite.email.invalid" : "invite.email.required"));
      return;
    }
    setEmailError(null);
    setCreateConfirm(true);
  }

  function errorMessage(error: unknown): string {
    const code = error instanceof ApiError ? error.code : "";
    const status = error instanceof ApiError ? error.status : 0;
    if (status === 401) return t("ownershipTransfer.signedOut");
    if (status === 429) return t("inviteAccept.error.rateLimited");
    if (code === "invalid_email") return t("invite.email.invalid");
    if (code === "self_transfer") return t("ownershipTransfer.selfTransfer");
    if (code === "owner_only") return t("ownershipTransfer.ownerOnly");
    if (code === "invite_pending") return t("ownershipTransfer.alreadyPending");
    if (status === 403 || status === 404 || code === "ownership_transfer_unavailable")
      return t("ownershipTransfer.unavailable");
    return t("ownershipTransfer.failed");
  }

  async function create() {
    const target = scopeRef.current;
    if (!target || working.current || pending || blocker) return;
    working.current = true;
    setBusy(true);
    setCreateConfirm(false);
    setLink(null);
    const request = ++generation.current;
    try {
      if (!(await authorized(target, request))) return;
      const result = await createOwnershipTransferInvite(
        target.vaultId,
        email.trim(),
        target.session,
      );
      if (!(await authorized(target, request))) return;
      const next = { recipient_email: result.invite_email, expires_at: result.expires_at };
      setPending(next);
      setLink({ ...next, url: result.invite_url });
      toast.push(t("ownershipTransfer.created"), "success");
    } catch (error) {
      if (await authorized(target, request)) toast.push(errorMessage(error), "error");
    } finally {
      working.current = false;
      if (isCurrent(target, request)) setBusy(false);
      else if (focused.current) void load();
    }
  }

  async function cancel() {
    const target = scopeRef.current;
    if (!target || working.current || !pending) return;
    working.current = true;
    setBusy(true);
    setCancelConfirm(false);
    setLink(null);
    const request = ++generation.current;
    try {
      if (!(await authorized(target, request))) return;
      await cancelOwnershipTransferInvite(target.vaultId, target.session);
      if (!(await authorized(target, request))) return;
      setPending(null);
      toast.push(t("ownershipTransfer.cancelled"), "success");
    } catch (error) {
      if (await authorized(target, request)) toast.push(errorMessage(error), "error");
    } finally {
      working.current = false;
      if (isCurrent(target, request)) setBusy(false);
      else if (focused.current) void load();
    }
  }

  async function share(destination: "copy" | "email" | "whatsapp") {
    const target = scopeRef.current;
    if (!target || !link || sharing.current || working.current || link.expires_at <= Date.now())
      return;
    sharing.current = true;
    const request = generation.current;
    try {
      if (!(await authorized(target, request)) || working.current) return;
      const message = t("ownershipTransfer.shareMessage", { name: target.name, url: link.url });
      if (destination === "copy") {
        await Clipboard.setStringAsync(link.url);
        if (await authorized(target, request)) toast.push(t("invite.copy.done"), "success");
      } else if (destination === "email") {
        await Linking.openURL(
          `mailto:${encodeURIComponent(link.recipient_email)}?subject=${encodeURIComponent(t("ownershipTransfer.emailSubject", { name: target.name }))}&body=${encodeURIComponent(message)}`,
        );
      } else {
        await Linking.openURL(`whatsapp://send?text=${encodeURIComponent(message)}`);
      }
    } catch {
      if (await authorized(target, request))
        toast.push(
          t(
            destination === "copy"
              ? "invite.copy.unavailable"
              : "ownershipTransfer.shareUnavailable",
          ),
          "error",
        );
    } finally {
      sharing.current = false;
    }
  }

  const visible =
    scope &&
    getActiveVaultIdSyncMaybe() === scope.vaultId &&
    getAccountIdSync() === scope.session.accountId;
  if (!loaded || !visible)
    return (
      <ScreenLoading
        title={t("ownershipTransfer.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        edges={["top", "bottom"]}
      />
    );

  const canUse = role === "owner";
  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("ownershipTransfer.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={styles.intro}>
            <View style={styles.emblem}>
              <Ionicons name="key-outline" size={28} color={colors.textEmphasis} />
            </View>
            <Text style={[styles.title, textDir(isRTL)]}>{scope.name}</Text>
            <Text style={[styles.body, textDir(isRTL)]}>{t("ownershipTransfer.intro")}</Text>
          </View>
          {!canUse ? <EmptyHint label={t("ownershipTransfer.ownerOnly")} isRTL={isRTL} /> : null}
          {canUse && blocker ? (
            <>
              <EmptyHint label={t(`ownershipTransfer.${blocker}`)} isRTL={isRTL} />
              <NavRow
                icon="refresh-outline"
                label={t("ownershipTransfer.refresh")}
                onPress={() => void load()}
                isRTL={isRTL}
                disabled={busy}
                isLast
              />
            </>
          ) : null}
          {canUse && !blocker ? (
            pending ? (
              <>
                <SectionHeader label={t("ownershipTransfer.pending")} isRTL={isRTL} />
                <View style={[styles.pendingCard, rowDir(isRTL)]}>
                  <Ionicons name="time-outline" size={icon.row} color={colors.textSubtle} />
                  <View style={styles.pendingText}>
                    <Text style={[styles.recipient, LTR_INPUT]} selectable>
                      {pending.recipient_email}
                    </Text>
                    <Text style={[styles.body, textDir(isRTL)]}>
                      {t("ownershipTransfer.expires", {
                        when: new Date(pending.expires_at).toLocaleString(),
                      })}
                    </Text>
                  </View>
                </View>
                <View style={styles.inset}>
                  <Text style={[styles.body, textDir(isRTL)]}>
                    {t("ownershipTransfer.pendingHint")}
                  </Text>
                </View>
                {link ? (
                  <>
                    <SectionGap />
                    <SectionHeader label={t("invite.section.shareLink")} isRTL={isRTL} />
                    <NavRow
                      icon="mail-outline"
                      label={t("ownershipTransfer.shareEmail")}
                      onPress={() => void share("email")}
                      isRTL={isRTL}
                      disabled={busy}
                    />
                    <NavRow
                      icon="logo-whatsapp"
                      label={t("invite.shareWhatsapp")}
                      onPress={() => void share("whatsapp")}
                      isRTL={isRTL}
                      disabled={busy}
                    />
                    <NavRow
                      icon="copy-outline"
                      label={t("invite.copy")}
                      onPress={() => void share("copy")}
                      isRTL={isRTL}
                      disabled={busy}
                      isLast
                    />
                  </>
                ) : (
                  <EmptyHint label={t("ownershipTransfer.linkNotStored")} isRTL={isRTL} />
                )}
                <SectionGap />
                <NavRow
                  icon="refresh-outline"
                  label={t("ownershipTransfer.refresh")}
                  onPress={() => void load()}
                  isRTL={isRTL}
                  disabled={busy}
                />
                <NavRow
                  icon="close-circle-outline"
                  label={t("ownershipTransfer.cancel")}
                  onPress={() => setCancelConfirm(true)}
                  isRTL={isRTL}
                  disabled={busy}
                  danger
                  isLast
                />
              </>
            ) : (
              <>
                <SectionHeader label={t("ownershipTransfer.recipient")} isRTL={isRTL} />
                <View style={styles.inset}>
                  <FormField
                    label={t("invite.email.label")}
                    required
                    value={email}
                    onChangeText={(value) => {
                      setEmail(value);
                      setEmailError(null);
                    }}
                    placeholder={t("invite.email.placeholder")}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    autoComplete="email"
                    textContentType="emailAddress"
                    style={LTR_INPUT}
                    error={emailError}
                    editable={!busy}
                    onSubmitEditing={showCreateConfirmation}
                  />
                  <Text style={[styles.body, styles.emailHint, textDir(isRTL)]}>
                    {t("ownershipTransfer.emailHint")}
                  </Text>
                  <Button
                    label={t("ownershipTransfer.create")}
                    onPress={showCreateConfirmation}
                    loading={busy}
                    disabled={busy}
                  />
                </View>
              </>
            )
          ) : null}
          {canUse && !pending ? (
            <>
              <SectionGap />
              <NavRow
                icon="people-outline"
                label={t("ownershipTransfer.existingMember")}
                hint={t("ownershipTransfer.existingMemberHint")}
                onPress={() =>
                  router.push({ pathname: "/vault/members", params: { action: "transfer" } })
                }
                isRTL={isRTL}
                disabled={busy}
                isLast
              />
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <ConfirmDialog
        visible={createConfirm && canUse && visible}
        title={t("ownershipTransfer.confirmTitle")}
        description={t("ownershipTransfer.confirmBody", { email: email.trim() })}
        confirmLabel={t("ownershipTransfer.create")}
        onConfirm={() => void create()}
        onCancel={() => setCreateConfirm(false)}
      />
      <ConfirmDialog
        visible={cancelConfirm && canUse && visible}
        title={t("ownershipTransfer.cancelTitle")}
        description={t("ownershipTransfer.cancelBody")}
        confirmLabel={t("ownershipTransfer.cancel")}
        destructive
        onConfirm={() => void cancel()}
        onCancel={() => setCancelConfirm(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  content: { paddingBottom: 40 },
  intro: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 28, gap: 12 },
  emblem: {
    width: EMBLEM_SIZE,
    height: EMBLEM_SIZE,
    borderRadius: EMBLEM_SIZE / 2,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { ...typography.title, color: colors.textEmphasis },
  body: { ...typography.body, color: colors.textSubtle },
  inset: { paddingHorizontal: 20, paddingBottom: 20 },
  emailHint: { marginTop: -8, marginBottom: 24 },
  pendingCard: {
    marginHorizontal: 20,
    marginBottom: 16,
    padding: 16,
    gap: 12,
    borderRadius: radius.md,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
  },
  pendingText: { flex: 1, gap: 4 },
  recipient: { ...typography.label, color: colors.textEmphasis },
});
