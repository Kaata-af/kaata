// Vault invite — Phase 7 redesigned to match the settings design language.
//
// This is the add-member affordance: an online invite link the recipient
// opens (deep link kaata://invite/<token>) and accepts after signing in.
// It works cross-account and not-physically-present (shopkeeper adds an
// accountant in another city). Requires sign-in + internet (the server
// holds the invite token until the recipient signs in to accept). When
// offline, the form is rendered in a disabled state with a clear
// disclosure so the user isn't left to hit an opaque API error on submit.
//
// (The old in-person QR pair, vault/pair.tsx, was the former primary
// affordance; it is PARKED with the rest of the offline mesh — which is why
// no copy on this screen points at it any more.)
//
// Owners and admins can find a Kaata account and send an account-bound
// invitation, or create the existing shareable link. Selecting an account
// stages a recipient; only confirming their role sends the invitation.

import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Network from "expo-network";
import { useFocusEffect, useIsFocused, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PeopleSearchSection } from "../../components/PeopleSearchSection";
import { OptionSheet, SHEET_EXIT_MS } from "../../components/OptionSheet";
import {
  EmptyHint,
  NavRow,
  ScreenHeader,
  SectionGap,
  SectionHeader,
} from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import {
  applyForCurrentSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../lib/auth";
import {
  getSessionAccountIdSync,
  getActiveVaultId,
  getActiveVaultIdSyncMaybe,
  onAccountIdentityChanged,
} from "../../lib/db-tx";
import { ltrIsolate, rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { getShareLangPref, resolveShareLang, t, tIn, type LocaleCode } from "../../lib/i18n";
import { icon, radius } from "../../lib/tokens";
import { useVaultPermission } from "../../lib/use-vault-role";
import { useLedgerRefresh } from "../../lib/ledger-events";
import { usePeopleSearch, type DiscoveredPerson } from "../../lib/people-search";
import { createVaultMemberRequest } from "../../lib/vault-member-requests";
import { ApiError, createVaultInvite, listVaults } from "../../lib/vault-api";
import type { VaultRole } from "../../lib/events";

type InviteResult = {
  invite_url: string;
  invite_email: string;
  expires_at: number;
};
type RecipientChoice = {
  person: DiscoveredPerson;
  role: "editor" | "clerk" | "viewer";
  vaultId: string;
  accountId: string;
  identity: string;
  generation: number;
};
type SentInvitation = { person: DiscoveredPerson; role: VaultRole; expires_at: number };

/** Result-row avatar well. Named so its radius is size/2 rather than a
 *  literal 22 that can drift from the diameter (lib/tokens rule 3). */
const AVATAR_SIZE = 44;

export default function VaultInviteScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();

  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const mountedRef = useRef(true);
  const scopeGeneration = useRef(0);
  const screenSession = useRef<SessionSnapshot | null>(null);
  const [vaultId, setVaultId] = useState<string>(getActiveVaultIdSyncMaybe() ?? "");
  // Signing out retains the local ledger's account ID. Use the live signed-in
  // identity and count notifications so a batched A -> out -> A also resets.
  const identityRevision = useRef(0);
  const subscribeIdentity = useCallback(
    (notify: () => void) =>
      onAccountIdentityChanged(() => {
        identityRevision.current++;
        notify();
      }),
    [],
  );
  const identitySnapshot = useCallback(
    () => `${identityRevision.current}:${getSessionAccountIdSync() ?? ""}`,
    [],
  );
  const identity = useSyncExternalStore(subscribeIdentity, identitySnapshot, identitySnapshot);
  const accountId = getSessionAccountIdSync();
  const [attempt, setAttempt] = useState(0);
  const viewIdentity = JSON.stringify([vaultId, identity, focused, attempt]);
  const latestViewIdentity = useRef(viewIdentity);
  latestViewIdentity.current = viewIdentity;
  const [loadedViewIdentity, setLoadedViewIdentity] = useState<string | null>(null);
  const viewCurrent = loadedViewIdentity === viewIdentity;
  // The actual "can call the API" gate: do we hold a valid JWT? Cached
  // app_meta.account_id can be stale (e.g. legacy install written it but
  // never bound, or a sign-in race where vault loaded before account_id
  // landed in app_meta). The JWT is the only thing httpThrowing actually
  // checks via requireJwt(), so we mirror that contract in the UI gate.
  // `null` = unknown until the effect resolves.
  const [hasJwt, setHasJwt] = useState<boolean | null>(null);
  const [role, setRole] = useState<"editor" | "clerk" | "viewer">("editor");
  const [busy, setBusy] = useState(false);
  const [storedResult, setResult] = useState<InviteResult | null>(null);
  const [storedQuery, setQuery] = useState("");
  const [storedRecipient, setRecipient] = useState<DiscoveredPerson | null>(null);
  const [storedConfirmation, setConfirmation] = useState<RecipientChoice | null>(null);
  const [storedSent, setSent] = useState<SentInvitation | null>(null);
  // Hide old account/vault content during render, before effect cleanup runs.
  const result = viewCurrent ? storedResult : null;
  const query = viewCurrent ? storedQuery : "";
  const recipient = viewCurrent ? storedRecipient : null;
  const confirmation = viewCurrent ? storedConfirmation : null;
  const sent = viewCurrent ? storedSent : null;
  const [sendError, setSendError] = useState<string | null>(null);
  // Message-language picker for the invite share, when share_lang_pref = 'ask'.
  const [askLangVisible, setAskLangVisible] = useState(false);
  // Re-entry guard: the ask-sheet rows stay tappable through the 220ms exit
  // animation, so a double-tap would otherwise fire Share.share twice.
  const shareBusyRef = useRef(false);
  // Live connectivity keeps both invitation actions disabled while offline.
  // Unknown connectivity waits for the first network result.
  const network = Network.useNetworkState();
  const online =
    network.isConnected === undefined || network.isInternetReachable === undefined
      ? null
      : !!network.isConnected && !!network.isInternetReachable;
  // Pre-flight: is this kaata registered on the server yet? A local-CA kaata
  // that hasn't synced can't be shared (the API 404s). null = checking/unknown
  // (optimistic — allow, the 404 toast is the backstop); false = confirmed not
  // synced → disable Create + show a banner instead of a post-tap error.
  const [vaultOnServer, setVaultOnServer] = useState<boolean | null>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx. Double-submit
  // here mints duplicate server links.
  const submittingRef = useRef(false);

  const canInvite = useVaultPermission(vaultId, accountId, "vault.invite_member");
  const canInviteRef = useRef(canInvite);
  canInviteRef.current = canInvite;
  const currentScope = !!vaultId && getActiveVaultIdSyncMaybe() === vaultId;
  const canSend =
    canInvite &&
    viewCurrent &&
    focused &&
    !!accountId &&
    currentScope &&
    hasJwt === true &&
    online === true &&
    vaultOnServer !== false;
  const canSendRef = useRef(canSend);
  canSendRef.current = canSend;
  const peopleSearch = usePeopleSearch(query, canSend && !busy && !recipient && !result && !sent);
  const viewSession = screenSession.current;
  const currentView = () =>
    mountedRef.current &&
    focusedRef.current &&
    latestViewIdentity.current === viewIdentity &&
    getActiveVaultIdSyncMaybe() === vaultId &&
    identitySnapshot() === identity;

  const scopeCurrent = (target: {
    vaultId: string;
    accountId: string;
    identity: string;
    generation: number;
  }) =>
    mountedRef.current &&
    focusedRef.current &&
    canInviteRef.current &&
    target.generation === scopeGeneration.current &&
    getActiveVaultIdSyncMaybe() === target.vaultId &&
    getSessionAccountIdSync() === target.accountId &&
    identitySnapshot() === target.identity;
  const refreshVault = useCallback(() => {
    setVaultId(getActiveVaultIdSyncMaybe() ?? "");
  }, []);
  useFocusEffect(refreshVault);
  useLedgerRefresh(null, refreshVault);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeGeneration.current++;
    };
  }, []);

  // What (if anything) stops a link from being created right now. Checked in
  // the order the user can act on: sign in, then get online, then wait for the
  // kaata to reach the server. null while the probes are still resolving, and
  // when everything is fine — the screen shows no banner at all then.
  const blocker: "signedOut" | "offline" | "notSynced" | null =
    hasJwt === false
      ? "signedOut"
      : online === false
        ? "offline"
        : vaultOnServer === false
          ? "notSynced"
          : null;

  useEffect(() => {
    const generation = ++scopeGeneration.current;
    let alive = true;
    screenSession.current = null;
    setLoadedViewIdentity(viewIdentity);
    setQuery("");
    setRecipient(null);
    setConfirmation(null);
    setSent(null);
    setSendError(null);
    setResult(null);
    setAskLangVisible(false);
    setHasJwt(null);
    setVaultOnServer(null);
    if (!focused)
      return () => {
        alive = false;
      };
    (async () => {
      const vid = await getActiveVaultId();
      if (!alive || generation !== scopeGeneration.current) return;
      if (!vid) {
        toast.push(t("invite.toast.noActive"), "error");
        router.back();
        return;
      }
      setVaultId(vid);
      const session = await captureCurrentSession();
      if (
        alive &&
        generation === scopeGeneration.current &&
        getActiveVaultIdSyncMaybe() === vid &&
        getSessionAccountIdSync() === accountId &&
        identitySnapshot() === identity
      ) {
        screenSession.current = session;
        setHasJwt(!!session.jwt && session.accountId === accountId);
      }
    })().catch(() => {
      if (alive && generation === scopeGeneration.current) setHasJwt(false);
    });
    return () => {
      alive = false;
    };
  }, [viewIdentity, router, toast]);

  useEffect(() => {
    if (!canInvite) {
      setRecipient(null);
      setConfirmation(null);
    }
  }, [canInvite]);

  // Pre-flight vault-on-server check: once we have a vault + JWT + connectivity,
  // confirm the kaata is registered server-side so we can disable Create + warn
  // BEFORE the owner picks a role and taps (instead of a post-submit 404 toast).
  // Best-effort — on any error we leave it null (optimistic, 404 is the backstop).
  useEffect(() => {
    if (!vaultId || !hasJwt || online === false || !focused) return;
    let alive = true;
    const generation = scopeGeneration.current;
    (async () => {
      try {
        const vaults = await listVaults();
        if (
          alive &&
          generation === scopeGeneration.current &&
          getActiveVaultIdSyncMaybe() === vaultId
        )
          setVaultOnServer(vaults.some((v) => v.vault_id === vaultId));
      } catch {
        if (alive && generation === scopeGeneration.current) setVaultOnServer(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [vaultId, accountId, hasJwt, online, focused]);

  function changeQuery(value: string) {
    if (submittingRef.current) return;
    setQuery(value);
    setRecipient(null);
    setConfirmation(null);
    setSent(null);
    setSendError(null);
  }

  function selectRecipient(person: DiscoveredPerson) {
    if (!canSendRef.current || submittingRef.current || !currentView()) return;
    Keyboard.dismiss();
    setRecipient(person);
    setConfirmation(null);
    setSendError(null);
  }

  function confirmRecipient() {
    if (!recipient || !accountId || !canSendRef.current || submittingRef.current || !currentView())
      return;
    setConfirmation({
      person: recipient,
      role,
      vaultId,
      accountId,
      identity,
      generation: scopeGeneration.current,
    });
  }

  async function sendToRecipient() {
    const choice = confirmation;
    const session = screenSession.current;
    if (
      !choice ||
      !session ||
      submittingRef.current ||
      !canSendRef.current ||
      !scopeCurrent(choice)
    )
      return;
    submittingRef.current = true;
    setConfirmation(null);
    setBusy(true);
    setSendError(null);
    try {
      await applyForCurrentSession(session, async () => {});
      if (!scopeCurrent(choice) || !canSendRef.current) return;
      const response = await createVaultMemberRequest(
        choice.vaultId,
        {
          recipientAccountId: choice.person.account_id,
          role: choice.role,
        },
        session,
      );
      await applyForCurrentSession(session, async () => {
        if (!scopeCurrent(choice)) return;
        setSent({ person: choice.person, role: choice.role, expires_at: response.expires_at });
        setRecipient(null);
        setQuery("");
      });
    } catch (error) {
      if (!scopeCurrent(choice)) return;
      if (error instanceof SessionChangedError) {
        setAttempt((value) => value + 1);
        return;
      }
      // Keep the chosen account and role available for an explicit retry.
      // A transient response failure must never create or share a wildcard link.
      const code = error instanceof ApiError ? error.code : "";
      const status = error instanceof ApiError ? error.status : 0;
      const key =
        code === "already_member"
          ? "invite.people.alreadyMember"
          : code === "recipient_unavailable"
            ? "invite.people.unavailable"
            : code === "member_readmission_required"
              ? "invite.people.readmission"
              : code === "invite_role_conflict"
                ? "invite.people.roleConflict"
                : code === "rate_limited" || code === "too_many_invites" || status === 429
                  ? "invite.tooMany"
                  : "invite.people.failed";
      setSendError(t(key));
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  async function onSubmit() {
    const session = screenSession.current;
    if (!session || !accountId || !canSendRef.current || busy || submittingRef.current || recipient)
      return;
    const target = { vaultId, accountId, identity, generation: scopeGeneration.current };
    submittingRef.current = true;
    setBusy(true);
    try {
      await applyForCurrentSession(session, async () => {});
      if (!scopeCurrent(target) || !canSendRef.current) return;
      // Empty email mints a LINK invite: the token is the secret, and whoever
      // opens the link + signs in (with any Google account) claims this role.
      const r = await createVaultInvite(vaultId, { email: "", role }, session);
      await applyForCurrentSession(session, async () => {
        if (!scopeCurrent(target)) return;
        setResult(r);
        toast.push(t("invite.created"), "success");
      });
    } catch (e) {
      if (!scopeCurrent(target)) return;
      if (e instanceof SessionChangedError) {
        setAttempt((value) => value + 1);
        return;
      }
      // Branch on the backend's structured error_code / status, not prose.
      const code = e instanceof ApiError ? e.code : "";
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401 || (e instanceof Error && e.message.includes("not signed in"))) {
        toast.push(t("invite.signInRequired"), "error");
      } else if (code === "too_many_invites" || code === "rate_limited" || status === 429) {
        toast.push(t("invite.tooMany"), "error");
      } else if (
        code === "vault_not_found" ||
        code === "not_member" ||
        code === "owner_only" ||
        status === 404 ||
        status === 403
      ) {
        // local-CA vault not yet registered server-side — must sync first.
        // Same message as the not-synced banner (the old separate key said the
        // same thing and then pointed at the parked in-person flow).
        toast.push(t("invite.link.notOnServer"), "error");
      } else {
        toast.push(t("invite.failed"), "error");
        if (__DEV__) console.warn("[vault/invite] create link failed:", e);
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  async function onCopy() {
    if (!result || !viewSession || !currentView()) return;
    try {
      await applyForCurrentSession(viewSession, async () => {
        if (!currentView()) return;
        await Clipboard.setStringAsync(result.invite_url);
        if (currentView()) toast.push(t("invite.copy.done"), "success");
      });
    } catch {
      if (currentView()) toast.push(t("invite.copy.unavailable"), "error");
    }
  }

  async function shareInvite(lang: LocaleCode) {
    if (!result || !viewSession || !currentView() || shareBusyRef.current) return;
    shareBusyRef.current = true;
    try {
      await applyForCurrentSession(viewSession, async () => {});
      if (!currentView()) return;
      await Share.share({
        message: tIn(lang, "invite.shareMessage", { url: result.invite_url }),
      });
    } catch (e) {
      console.warn("[vault/invite] share failed", e);
    } finally {
      shareBusyRef.current = false;
    }
  }

  async function onShare() {
    if (!result || !viewSession || !currentView()) return;
    try {
      const pref = await getShareLangPref();
      await applyForCurrentSession(viewSession, async () => {
        if (currentView() && pref === "ask") setAskLangVisible(true);
      });
      if (!currentView() || pref === "ask") return;
      await shareInvite(resolveShareLang(pref));
    } catch (error) {
      if (!(error instanceof SessionChangedError) && currentView())
        toast.push(t("invite.failed"), "error");
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("invite.title")}
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
          {!canInvite ? <EmptyHint label={t("invite.ownerOnly")} isRTL={isRTL} /> : null}

          {/* Blocker banner — ONLY when something actually prevents creating a
              link (signed out / offline / kaata not yet synced), because that
              is what explains the disabled button.

              It used to render unconditionally: the happy path showed a
              permanent grey box whose whole message was "to add staff you're
              with right now, use Add member" — a second, in-person QR flow
              that was parked with the offline mesh and is commented out on
              every screen. Every variant of this banner pointed at it, so the
              copy has been rewritten to describe only the blocker itself. */}
          {!result && !sent && blocker ? (
            <View style={styles.disclosure}>
              <Ionicons
                name={
                  blocker === "signedOut"
                    ? "person-circle-outline"
                    : blocker === "offline"
                      ? "cloud-offline-outline"
                      : "sync-outline"
                }
                size={icon.row}
                color={colors.danger}
                style={isRTL ? { marginLeft: 10 } : { marginRight: 10 }}
              />
              <Text style={[styles.disclosureText, textDir(isRTL)]}>
                {blocker === "signedOut"
                  ? t("invite.signInRequired")
                  : blocker === "offline"
                    ? t("invite.offline.banner")
                    : t("invite.link.notOnServer")}
              </Text>
            </View>
          ) : null}

          {sent ? (
            <>
              <View style={[styles.identityRow, rowDir(isRTL)]}>
                <View
                  style={[styles.identityAvatar, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}
                >
                  <Ionicons name="checkmark" size={icon.row} color={colors.textEmphasis} />
                </View>
                <View style={{ flex: 1 }} accessibilityLiveRegion="polite">
                  <Text style={[styles.identityName, textDir(isRTL)]}>
                    {t("invite.people.sent")}
                  </Text>
                  <Text style={[styles.identitySub, textDir(isRTL)]}>
                    {t("invite.people.sentHint", {
                      name: sent.person.name,
                      role: roleLabel(sent.role),
                      when: formatExpires(sent.expires_at),
                    })}
                  </Text>
                </View>
              </View>
              <View style={styles.formInset}>
                <Button
                  label={t("invite.people.sendAnother")}
                  variant="secondary"
                  onPress={() => {
                    setSent(null);
                    setRole("editor");
                    changeQuery("");
                  }}
                />
              </View>
            </>
          ) : !result ? (
            <>
              <View style={styles.formInset}>
                <Text style={[styles.intro, textDir(isRTL)]}>{t("invite.people.intro")}</Text>
                <View style={[styles.searchField, rowDir(isRTL)]}>
                  <Ionicons name="search" size={icon.row} color={colors.textMuted} />
                  <TextInput
                    testID="member-invite-search"
                    value={query}
                    onChangeText={changeQuery}
                    placeholder={t("peopleSearch.placeholder")}
                    placeholderTextColor={colors.textMuted}
                    accessibilityLabel={t("invite.people.searchLabel")}
                    style={[styles.searchInput, textDir(isRTL)]}
                    maxLength={80}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    onSubmitEditing={() => Keyboard.dismiss()}
                    editable={canSend && !busy}
                  />
                </View>
              </View>

              {recipient ? (
                <View style={[styles.identityRow, rowDir(isRTL)]} testID="member-invite-recipient">
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.identityName, textDir(isRTL)]} numberOfLines={2}>
                      {recipient.name}
                    </Text>
                    {recipient.username ? (
                      <Text style={[styles.identitySub, textDir(isRTL)]}>
                        {ltrIsolate(`@${recipient.username}`)}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("invite.people.change")}
                    disabled={busy}
                    onPress={() => changeQuery(query)}
                    style={styles.changeButton}
                  >
                    <Text style={styles.changeLabel}>{t("invite.people.change")}</Text>
                  </Pressable>
                </View>
              ) : (
                <PeopleSearchSection
                  search={peopleSearch}
                  onSelect={selectRecipient}
                  disabled={!canSend || busy}
                  actionLabel={t("invite.people.action")}
                  localPeople={[]}
                  visiblePeople={[]}
                />
              )}

              <SectionGap />
              <SectionHeader label={t("invite.section.role")} isRTL={isRTL} />
              {/* Full-width rows, one role per line (roles v2 took this from
                  two to three, and side-by-side pills squeezed each label
                  into a third of the screen with its hint clipped). Same
                  radio idiom as the vault switcher: filled check = chosen. */}
              <View accessibilityRole="radiogroup">
                <RoleOption
                  value="editor"
                  label={t("invite.role.editor")}
                  hint={t("invite.role.editor.hint")}
                  selected={role === "editor"}
                  isRTL={isRTL}
                  onSelect={setRole}
                  disabled={busy}
                />
                <RoleOption
                  value="clerk"
                  label={t("invite.role.clerk")}
                  hint={t("invite.role.clerk.hint")}
                  selected={role === "clerk"}
                  isRTL={isRTL}
                  onSelect={setRole}
                  disabled={busy}
                />
                <RoleOption
                  value="viewer"
                  label={t("invite.role.viewer")}
                  hint={t("invite.role.viewer.hint")}
                  selected={role === "viewer"}
                  isRTL={isRTL}
                  onSelect={setRole}
                  disabled={busy}
                  isLast
                />
              </View>

              <View style={styles.formInset}>
                {/* Disclosure: a viewer can READ the entire ledger (every
                    customer balance + phone number). The owner should know
                    what the link grants before sharing it. */}
                <Text style={[styles.fieldHint, styles.roleDisclosure, textDir(isRTL)]}>
                  {role === "viewer"
                    ? t("invite.link.viewerDisclosure")
                    : role === "clerk"
                      ? t("invite.link.clerkDisclosure")
                      : t("invite.link.editorDisclosure")}
                </Text>
                {/* Invites never mint a manager (the server caps them below it);
                    say where that role is granted instead of leaving it hidden. */}
                <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("invite.managerNote")}</Text>

                {sendError ? (
                  <Text accessibilityRole="alert" style={[styles.sendError, textDir(isRTL)]}>
                    {sendError}
                  </Text>
                ) : null}

                <View style={{ height: 24 }} />
                <Button
                  label={t(recipient ? "invite.people.send" : "invite.link.create")}
                  onPress={recipient ? confirmRecipient : onSubmit}
                  loading={busy}
                  disabled={!canSend || busy}
                />
                {!recipient ? (
                  <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("invite.link.intro")}</Text>
                ) : null}
              </View>
            </>
          ) : (
            <>
              {/* Result: the shareable link is ready. */}
              <View style={[styles.identityRow, rowDir(isRTL)]}>
                <View
                  style={[styles.identityAvatar, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}
                >
                  <Ionicons name="link" size={icon.row} color={colors.textEmphasis} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.identityName, textDir(isRTL)]} numberOfLines={1}>
                    {t("invite.link.ready")}
                  </Text>
                  <Text style={[styles.identitySub, textDir(isRTL)]} numberOfLines={2}>
                    {t("invite.link.readySub", {
                      role: t(
                        role === "viewer"
                          ? "invite.role.viewer"
                          : role === "clerk"
                            ? "invite.role.clerk"
                            : "invite.role.editor",
                      ),
                      when: formatExpires(result.expires_at),
                    })}
                  </Text>
                </View>
              </View>

              <SectionGap />
              <SectionHeader label={t("invite.section.shareLink")} isRTL={isRTL} />
              <View style={styles.formInset}>
                <View style={styles.urlBox}>
                  <Text style={styles.urlText} numberOfLines={3}>
                    {result.invite_url}
                  </Text>
                </View>
              </View>
              <NavRow
                icon="logo-whatsapp"
                label={t("invite.shareWhatsapp")}
                onPress={onShare}
                isRTL={isRTL}
                emphasis
              />
              <NavRow
                icon="copy-outline"
                label={t("invite.copy")}
                onPress={onCopy}
                isRTL={isRTL}
                isLast
              />

              <SectionGap />
              <View style={styles.formInset}>
                <Button
                  label={t("invite.link.createAnother")}
                  variant="secondary"
                  onPress={() => {
                    setResult(null);
                    setRole("editor");
                  }}
                />
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={confirmation !== null}
        title={t("invite.people.confirmTitle")}
        description={
          confirmation
            ? t("invite.people.confirmBody", {
                name: confirmation.person.name,
                role: roleLabel(confirmation.role),
              })
            : undefined
        }
        confirmLabel={t("invite.people.send")}
        onConfirm={sendToRecipient}
        onCancel={() => setConfirmation(null)}
      />

      {/* Per-send message-language picker (share_lang_pref = 'ask'). */}
      <OptionSheet
        visible={viewCurrent && askLangVisible}
        title={t("share.askLang.title")}
        options={[
          { key: "fa", label: t("settings.language.option.fa") },
          { key: "ps", label: t("settings.language.option.ps") },
          { key: "en", label: t("settings.language.option.en") },
        ]}
        selected=""
        onSelect={(k) => {
          setAskLangVisible(false);
          // Defer past the sheet's exit animation: Share.share on iOS presents
          // on the topmost VC — the still-mounted sheet Modal — and would be
          // torn down when it unmounts. +80ms covers the unmount commit.
          setTimeout(() => void shareInvite(k as LocaleCode), SHEET_EXIT_MS + 80);
        }}
        onDismiss={() => setAskLangVisible(false)}
        isRTL={isRTL}
      />
    </SafeAreaView>
  );
}

function RoleOption(props: {
  value: "editor" | "clerk" | "viewer";
  label: string;
  hint: string;
  selected: boolean;
  isRTL: boolean;
  isLast?: boolean;
  disabled?: boolean;
  onSelect: (r: "editor" | "clerk" | "viewer") => void;
}) {
  return (
    <Pressable
      onPress={() => props.onSelect(props.value)}
      disabled={props.disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      style={({ pressed }) => [
        styles.roleOption,
        rowDir(props.isRTL),
        !props.isLast && styles.roleOptionDivider,
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <Ionicons
        name={props.selected ? "checkmark-circle" : "ellipse-outline"}
        size={icon.row}
        color={props.selected ? colors.actionPrimary : colors.textMuted}
        style={props.isRTL ? { marginLeft: 14 } : { marginRight: 14 }}
      />
      <View style={styles.roleOptionTextCol}>
        <Text
          style={[
            styles.roleOptionLabel,
            props.selected && styles.roleOptionLabelSelected,
            textDir(props.isRTL),
          ]}
        >
          {props.label}
        </Text>
        <Text style={[styles.roleOptionHint, textDir(props.isRTL)]}>{props.hint}</Text>
      </View>
    </Pressable>
  );
}

function roleLabel(role: VaultRole): string {
  return t(
    role === "viewer"
      ? "invite.role.viewer"
      : role === "clerk"
        ? "invite.role.clerk"
        : "invite.role.editor",
  );
}

function formatExpires(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return t("invite.expiresIn.soon");
  const hours = Math.floor(diff / 3600_000);
  if (hours < 24) return t("invite.expiresIn.hours", { hours: Math.max(1, hours) });
  return t("invite.expiresIn.days", { days: Math.floor(hours / 24) });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },

  scrollContent: { paddingBottom: 48 },
  formInset: { paddingHorizontal: 20, paddingTop: 4 },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 16,
    paddingHorizontal: 12,
    minHeight: 48,
    backgroundColor: colors.bgMuted,
    borderRadius: radius.sm,
  },
  searchInput: {
    flex: 1,
    minHeight: 48,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
  },
  changeButton: { minHeight: 44, paddingHorizontal: 12, justifyContent: "center" },
  changeLabel: { color: colors.actionPrimary, fontFamily: fonts.sansMedium, fontSize: 14 },
  sendError: { color: colors.danger, fontFamily: fonts.sansRegular, fontSize: 13, marginTop: 16 },

  intro: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: sansLineHeight(14, 20),
  },

  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
    lineHeight: sansLineHeight(12, 18),
  },

  // IdentityRow-style invitation result -----------------------------------
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 64,
  },
  identityAvatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
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

  // Role picker — one full-width row per role (was a 3-up pill row; the
  // roles v2 third option left each pill a third of the screen wide with
  // its hint clipped). Row metrics + divider match the settings NavRow so
  // the picker reads as part of the same list grammar. -------------------
  roleOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 56,
  },
  roleOptionDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  roleOptionTextCol: { flex: 1 },
  roleOptionLabel: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
  },
  roleOptionLabelSelected: {
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  roleOptionHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
    lineHeight: sansLineHeight(12, 18),
  },
  // The role blurb sits under the list, so it needs real separation from
  // the last row's divider (fieldHint's 6px is tuned for under an input).
  roleDisclosure: { marginTop: 14 },

  urlBox: {
    padding: 14,
    backgroundColor: colors.bgMuted,
    borderRadius: radius.sm,
  },
  urlText: {
    fontSize: 13,
    fontFamily: fonts.monoRegular,
    color: colors.textEmphasis,
  },

  // Blocker banner — only rendered when a link genuinely can't be created.
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: colors.bgMuted,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  disclosureText: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    flex: 1,
  },
});
