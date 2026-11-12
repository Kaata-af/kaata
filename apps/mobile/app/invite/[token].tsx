// Invite acceptance — Phase 4 deep-link landing.
//
// Route: kaata://invite/<token>  (configured in app.json scheme handler)
// Web fallback: kaata.af/i/<token> on the marketing site → tries the deep
// link, falls back to download instructions if the app isn't installed.
//
// Lifecycle:
//   1. Extract token from route param. Bail to home with toast if missing.
//   2. Require sign-in. If no JWT, route to onboarding/auth with
//      pending_invite_token stashed so the post-sign-in flow returns here.
//   3. Look up the invite details (vault name, role, inviter) via
//      lookupPendingInvite(token) — the local pending_invitations cache —
//      then fall back to the PUBLIC GET /v1/vaults/invites/{token}/info.
//      The fallback is the normal path for link invitees: the server holds
//      only the token hash post-migration, so no local row can exist for a
//      token this device first sees via the deep link. A 404 there means
//      expired / revoked / already used (collapsed by design); network
//      failures land on a retryable error state.
//      Account-targeted v_ selectors bypass that cache and use an
//      authenticated preview bound to the recipient's current session.
//   4. User confirms → POST /v1/vaults/invites/accept with {token,
//      install_id}. The accept response carries ONLY {vault_id, vault_name,
//      role} — it does NOT seed any local state — so we then materialize the
//      vault locally: recoverJoinedVault() seeds the `vaults` row from
//      GET /v1/vaults and pulls its history (membership chain + ledger).
//      Only then does setActiveVaultId switch to it and we route home; the
//      home screen lists from the local `vaults` table, so without that seed
//      it would not see the joined vault and would revert the active pointer.

import { Ionicons } from "@expo/vector-icons";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import {
  applyForCurrentSession,
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../lib/auth";
import { requestImmediateCheckIn } from "../../lib/checkin-trigger";
import { colors } from "../../lib/colors";
import {
  getSessionAccountIdSync,
  onAccountIdentityChanged,
  setActiveVaultId,
} from "../../lib/db-tx";
import { getLocalSelf, setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { gutter, icon, typography } from "../../lib/tokens";
import {
  isSelfAdmissionPublished,
  JoinAdmissionBlockedError,
  JoinProofPendingError,
} from "../../lib/trust/backfill";
import {
  acceptVaultInvite,
  ApiError,
  clearVaultMaterializePending,
  clearPendingVaultInvite,
  declineVaultInviteLocally,
  fetchInviteInfo,
  lookupPendingInvite,
  retryPendingVaultMaterialize,
  resumePendingVaultInvite,
  isOwnershipTransferApplied,
  type PendingInvite,
  type AcceptInviteResult,
} from "../../lib/vault-api";
import { consumeVaultMemberInviteAcceptance } from "../../lib/vault-member-invite-intent";

type Stage =
  | "loading"
  | "needs_signin"
  | "confirm"
  | "accepting"
  | "pending"
  | "waiting_owner"
  | "blocked"
  | "error"
  | "done";

const PENDING_TOKEN_KEY = "pending_invite_token";
class InviteRouteChangedError extends Error {}

// Confirm-card view model — the common subset of a local pending_invitations
// row (email invites mirrored by fetchPendingInvitations) and the public
// /info endpoint (link invitees, who never have a local row). The screen
// doesn't need vault_id here: the accept response carries it.
type InviteDetails = {
  kind?: "ownership_transfer" | "member_readmission";
  vault_name: string;
  role: PendingInvite["role"];
  inviter_name: string | null;
  inviter_email: string | null;
  expires_at: number;
};

export default function InviteAcceptScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, []);
  const { token: tokenParam, acceptance: acceptanceParam } = useLocalSearchParams<{
    token: string;
    acceptance?: string;
  }>();
  const token = typeof tokenParam === "string" ? tokenParam : null;
  const acceptance = typeof acceptanceParam === "string" ? acceptanceParam : null;

  // Count notifications as well as account IDs: A -> signed out -> A may be
  // batched into one render, but it must still discard A's old session work.
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
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([token, acceptance, identity, attempt, focused, foreground]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const currentScope = () =>
    latestScope.current === scope &&
    identitySnapshot() === identity &&
    focusedRef.current &&
    AppState.currentState === "active";
  const [viewScope, setViewScope] = useState<string | null>(null);
  const [storedStage, setStage] = useState<Stage>("loading");
  const [storedInvite, setInvite] = useState<InviteDetails | null>(null);
  // Hide the previous card during render, before the new scope's effect runs.
  const stage = viewScope === scope ? storedStage : "loading";
  const invite = viewScope === scope ? storedInvite : null;
  const previewSession = useRef<{ scope: string; session: SessionSnapshot } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [retryable, setRetryable] = useState(false);
  const [declining, setDeclining] = useState(false);
  // L15: synchronous re-entry guard for onAccept (single-use token).
  const acceptingRef = useRef(false);
  // A consumed link must never be posted again just to finish its local setup.
  const acceptedRef = useRef<{ result: AcceptInviteResult; session: SessionSnapshot } | null>(null);
  const routeGeneration = useRef(0);

  // Heal a prior accept whose local materialization failed: onAccept stamps
  // VAULT_MATERIALIZE_PENDING before recoverJoinedVault and clears it only on
  // success, so a re-visit of this screen (e.g. re-tapping the link after the
  // "joined" toast but no visible kaata) re-seeds the row. Best-effort.
  useEffect(() => {
    if (!focused || !foreground) return;
    retryPendingVaultMaterialize().catch((err) =>
      console.warn("[invite] pending materialize retry failed", err),
    );
  }, [focused, foreground]);

  useEffect(() => {
    const generation = ++routeGeneration.current;
    const current = () => generation === routeGeneration.current && currentScope();
    acceptedRef.current = null;
    previewSession.current = null;
    acceptingRef.current = false;
    setViewScope(scope);
    setInvite(null);
    setDeclining(false);
    setStage("loading");
    if (!focused || !foreground) return;
    (async () => {
      if (!token) {
        toast.push(t("inviteAccept.invalidLink"), "error");
        router.replace("/");
        return;
      }
      setRetryable(false);
      try {
        // Sign-in gate. Accepting needs a session JWT (and so does the
        // authed /info fallback below). Stash the token so the auth flow
        // returns here after sign-in.
        const session = await captureCurrentSession();
        if (!current()) return;
        if (!session.jwt || !session.accountId || !getSessionAccountIdSync()) {
          await applyForUnchangedLocalSession(session, async () => {
            if (!current()) return;
            await setAppMeta(PENDING_TOKEN_KEY, token);
            if (current()) setStage("needs_signin");
          });
          return;
        }

        const resumed = await resumePendingVaultInvite(token, session);
        if (!current()) return;
        if (resumed) {
          await applyForCurrentSession(session, async () => {
            if (!current()) return;
            previewSession.current = { scope, session };
            acceptedRef.current = { result: resumed, session };
            setInvite({
              ...(resumed.ownership_transferred ? { kind: "ownership_transfer" as const } : {}),
              ...(resumed.member_readmission ? { kind: "member_readmission" as const } : {}),
              vault_name: resumed.vault_name,
              role: resumed.role,
              inviter_name: null,
              inviter_email: null,
              expires_at: 0,
            });
            setStage(resumed.member_readmission ? "waiting_owner" : "pending");
          });
          return;
        }

        // Account-targeted selectors are not share-link secrets. Their preview
        // must always be authorized by the server, never a local token cache.
        let found: InviteDetails | null = token.startsWith("v_")
          ? null
          : await lookupPendingInvite(token);
        if (!current()) return;
        if (!found) {
          // The API chooses the authenticated request preview for v_ selectors
          // or ordinary link info otherwise. Null means unavailable; network
          // failures remain retryable instead of looking like expiry.
          const info = await fetchInviteInfo(token, session);
          if (!current()) return;
          if (info) {
            found = {
              ...(info.kind ? { kind: info.kind } : {}),
              vault_name: info.vault_name,
              role: info.role,
              inviter_name: info.inviter_name,
              inviter_email: info.inviter_email_redacted,
              expires_at: info.expires_at,
            };
          }
        }
        await applyForCurrentSession(session, async () => {
          if (!current()) return;
          previewSession.current = { scope, session };
          if (!found) {
            setErrorMsg(t("inviteAccept.error.expired"));
            setStage("error");
            return;
          }
          if (found.expires_at <= Date.now()) {
            setErrorMsg(t("inviteAccept.error.expired"));
            setStage("error");
            return;
          }
          setInvite(found);
          setStage("confirm");
        });
      } catch (err) {
        if (!current()) return;
        if (err instanceof SessionChangedError) {
          setAttempt((value) => value + 1);
          return;
        }
        // Raw err.message stays in the console for debugging; the user
        // sees the localized fallback only.
        console.warn("[invite] lookup failed", err);
        setErrorMsg(t("inviteAccept.error.loadFailed"));
        setRetryable(true);
        setStage("error");
      }
    })();
    return () => {
      routeGeneration.current++;
    };
  }, [scope, router, toast]);

  async function onAccept() {
    // L15: synchronous re-entry guard. setStage is async, so without this two
    // rapid taps both call acceptVaultInvite (a single-use token) — the second
    // 404s and shows an "invite expired" error for a join that actually
    // succeeded, plus races two recoverJoinedVault materializations.
    const owner = previewSession.current;
    if (!invite || !token || acceptingRef.current || owner?.scope !== scope || !currentScope())
      return;
    const session = owner.session;
    acceptingRef.current = true;
    const generation = routeGeneration.current;
    const assertRoute = () => {
      if (generation !== routeGeneration.current || !currentScope())
        throw new InviteRouteChangedError();
    };
    setStage("accepting");
    setErrorMsg("");
    try {
      await applyForCurrentSession(session, async () => assertRoute());
      const result =
        invite.kind === "member_readmission"
          ? await acceptVaultInvite(token, session, invite.kind)
          : (acceptedRef.current?.result ?? (await acceptVaultInvite(token, session, invite.kind)));
      const needsOwnerProof = !!(result.ownership_transferred || result.admin_invite_event_id);
      assertRoute();
      await applyForCurrentSession(session, async () => {
        assertRoute();
        acceptedRef.current = { result, session };
      });
      if (result.member_readmission) {
        if (result.readmission_pending) {
          acceptingRef.current = false;
          setStage("waiting_owner");
          return;
        }
        const { recoverMemberReadmission } = await import("../../lib/member-readmission-guest");
        const recovered = await recoverMemberReadmission(result, session);
        assertRoute();
        if (!recovered.ready) {
          acceptingRef.current = false;
          setStage("waiting_owner");
          return;
        }
        await applyForCurrentSession(session, async () => {
          assertRoute();
          if (!recovered.archived) await setActiveVaultId(result.vault_id);
          await setAppMeta(PENDING_TOKEN_KEY, "");
        });
        await clearPendingVaultInvite(token, session);
        assertRoute();
        setStage("done");
        requestImmediateCheckIn();
        toast.push(t("inviteAccept.joinedToast", { name: result.vault_name }), "success");
        router.replace("/");
        return;
      }
      const publishedBeforeSetup = await isSelfAdmissionPublished(result.vault_id, session);
      assertRoute();
      if (!publishedBeforeSetup || needsOwnerProof) {
        // FIRST: the offline-proof minimal seed straight from the accept
        // response (vault row + our membership mirror, no network). This is
        // what guarantees the kaata is visible and switchable from the first
        // frame even if every enrichment step below fails — the fix for the
        // "joined kaata flashed then vanished from the switcher" bug, where a
        // failed recoverJoinedVault left NO local row and healActiveVaultId
        // promptly moved the active pointer off the void.
        try {
          const { seedJoinedVaultMinimal } = await import("../../lib/recovery");
          await applyForCurrentSession(session, () =>
            seedJoinedVaultMinimal(result.vault_id, result.vault_name, result.role, result),
          );
          assertRoute();
        } catch (err) {
          assertRoute();
          if (err instanceof SessionChangedError || err instanceof InviteRouteChangedError)
            throw err;
          console.warn("[invite] minimal seed failed (materialize retry still covers it)", err);
        }
        // THEN the full materialization (anchor, history, other members) —
        // best-effort with the pending-flag heal: flag BEFORE the attempt,
        // clear only on confirmed success. retryPendingVaultMaterialize sweeps
        // the flag from the sync scheduler's session start, the home screen's
        // load, and this screen's next mount.
        try {
          const { recoverJoinedVault } = await import("../../lib/recovery");
          if (await recoverJoinedVault(result.vault_id, session)) {
            await applyForCurrentSession(session, () =>
              clearVaultMaterializePending(result.vault_id),
            );
          }
          assertRoute();
        } catch (err) {
          assertRoute();
          if (err instanceof SessionChangedError || err instanceof InviteRouteChangedError)
            throw err;
          console.warn("[invite] joined-vault materialization failed (flagged for retry)", err);
        }
      }
      await applyForCurrentSession(session, async () => {
        assertRoute();
        await setActiveVaultId(result.vault_id);
        await setAppMeta(PENDING_TOKEN_KEY, needsOwnerProof ? token : "");
      });

      if (needsOwnerProof && !(await isOwnershipTransferApplied(result, session))) {
        assertRoute();
        acceptingRef.current = false;
        setStage("pending");
        return;
      }

      // M2 membership chain (docs/m2-membership-chain.md §4): after a
      // successful online acceptance, this device fetches the server
      // witness and emits its own witnessed vault_member_added +
      // vault_device_added — the invitee's future handshake proofs.
      // Emission failure must NOT break the accept UX: the pending flag
      // is set BEFORE the attempt and cleared only on success, so
      // ensureChainBackfill retries on the next app session (duplicate
      // admissions are no-ops in the chain fold, so a partial first
      // attempt re-running is safe).
      let proofPublished = false;
      try {
        const { emitWitnessedSelfAdmission, witnessEmitPendingKey } =
          await import("../../lib/trust/backfill");
        // The invite-info card's inviter gets their real name stamped on the
        // joiner's Members tab instead of a generic role label.
        await emitWitnessedSelfAdmission(result.vault_id, {
          inviterName: invite.inviter_name ?? null,
          session,
        });
        assertRoute();
        await applyForCurrentSession(session, () =>
          setAppMeta(witnessEmitPendingKey(result.vault_id), ""),
        );
        proofPublished = true;
      } catch (err) {
        assertRoute();
        if (err instanceof SessionChangedError || err instanceof InviteRouteChangedError) throw err;
        if (err instanceof JoinAdmissionBlockedError) {
          acceptingRef.current = false;
          setStage("blocked");
          return;
        }
        if (!(err instanceof JoinProofPendingError))
          console.warn("[invite] witness emission failed (backfill path will retry)", err);
      }
      if (!proofPublished) {
        acceptingRef.current = false;
        setStage("pending");
        return;
      }
      // The joined kaata's shared accounts must be known before the first
      // tally, or that tally lands in the private book and never reaches the
      // other side (audit #7). Bounded; the tab sync loop keeps retrying.
      try {
        const { syncAllTabs } = await import("../../lib/tabs/sync");
        await Promise.race([
          syncAllTabs({ discover: true }),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch (err) {
        console.warn("[invite] shared-account discovery after join failed", err);
      }
      assertRoute();
      await clearPendingVaultInvite(token, session);
      assertRoute();
      await applyForCurrentSession(session, async () => {
        assertRoute();
        if (needsOwnerProof) await setAppMeta(PENDING_TOKEN_KEY, "");
        setStage("done");
      });
      assertRoute();
      // Push the joined-vault membership + onboarded state to the backend now.
      // recoverJoinedVault created the local-self; without an immediate check-in
      // this signed-in user could still read as "not onboarded" on the admin
      // dashboard until their next launch (the only other check-in triggers are
      // cold launch + throttled foreground). Best-effort; no-ops if offline.
      requestImmediateCheckIn();
      toast.push(
        t(result.ownership_transferred ? "ownershipAccept.done" : "inviteAccept.joinedToast", {
          name: invite.vault_name,
        }),
        "success",
      );
      router.replace("/");
    } catch (err) {
      if (
        generation !== routeGeneration.current ||
        !currentScope() ||
        err instanceof InviteRouteChangedError
      )
        return;
      if (err instanceof SessionChangedError) {
        previewSession.current = null;
        acceptedRef.current = null;
        setInvite(null);
        setAttempt((value) => value + 1);
        return;
      }
      // Reset the guard so the user can retry after a transient failure (on
      // success we've already navigated home, so it stays locked).
      acceptingRef.current = false;
      // Raw err.message stays in the console for debugging; the user sees a
      // localized message chosen from the backend's structured error_code.
      console.warn("[invite] accept failed", err);
      const code = err instanceof ApiError ? err.code : "";
      if (
        invite.kind === "member_readmission" &&
        !(
          err instanceof ApiError &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 408 &&
          err.status !== 429
        )
      ) {
        setErrorMsg(t("inviteAccept.error.acceptFailed"));
        // An uncertain first consent is kept in the durable journal, but it
        // must not enter the fast status poll until a result is known.
        const confirmed = acceptedRef.current?.result.member_readmission === true;
        setRetryable(!confirmed);
        setStage(confirmed ? "waiting_owner" : "error");
        return;
      }
      if (code === "invite_not_found") {
        // Link expired, revoked, or already used (collapsed code, by design).
        setErrorMsg(
          t(
            invite.kind === "ownership_transfer"
              ? "ownershipAccept.unavailable"
              : "inviteAccept.error.expired",
          ),
        );
      } else if (code === "rate_limited") {
        setErrorMsg(t("inviteAccept.error.rateLimited"));
      } else {
        setErrorMsg(t("inviteAccept.error.acceptFailed"));
      }
      setStage("error");
    }
  }

  useEffect(() => {
    const preview = previewSession.current;
    if (
      stage !== "confirm" ||
      !invite ||
      !token ||
      !acceptance ||
      preview?.scope !== scope ||
      !currentScope()
    )
      return;
    const confirmed = consumeVaultMemberInviteAcceptance(token, acceptance, preview.session);
    // Return and ownership invitations have their own consent disclosures.
    if (confirmed && !invite.kind) void onAccept();
  }, [stage, scope, invite]);

  // Ordinary sync uploads the proof and retries interrupted setup. Re-check
  // while this screen is visible, without consuming the invite a second time.
  useEffect(() => {
    if (stage !== "pending") return;
    const timer = setTimeout(() => {
      void onAccept();
    }, 60_000);
    let cancelled = false,
      checking = false;
    // Upload normally finishes within seconds. Observe its local ack without
    // another witness request or snapshot download while the user waits.
    const poll = setInterval(() => {
      const accepted = acceptedRef.current;
      if (checking || !accepted) return;
      checking = true;
      void isSelfAdmissionPublished(accepted.result.vault_id, accepted.session)
        .then(async (ready) => {
          if (
            !cancelled &&
            ready &&
            (!(accepted.result.ownership_transferred || accepted.result.admin_invite_event_id) ||
              (await isOwnershipTransferApplied(accepted.result, accepted.session)))
          ) {
            if (!cancelled) void onAccept();
          }
        })
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [stage, scope]);

  // A saved return consent uses read-only status for this exact phone. Never
  // repeat registration/consent or run ordinary witness admission while waiting.
  useEffect(() => {
    if (stage !== "waiting_owner") return;
    const timer = setTimeout(() => {
      void onAccept();
    }, 15_000);
    return () => clearTimeout(timer);
  }, [stage, scope]);

  async function onDecline() {
    const owner = previewSession.current;
    if (!token || !invite || acceptingRef.current || owner?.scope !== scope || !currentScope())
      return;
    const session = owner.session;
    acceptingRef.current = true;
    setDeclining(true);
    const generation = routeGeneration.current;
    const current = () => generation === routeGeneration.current && currentScope();
    try {
      await applyForCurrentSession(session, async () => {
        if (!current()) throw new InviteRouteChangedError();
      });
      await declineVaultInviteLocally(token, session);
      await applyForCurrentSession(session, async () => {
        if (!current()) throw new InviteRouteChangedError();
        await setAppMeta(PENDING_TOKEN_KEY, "");
      });
      if (current()) router.replace("/");
    } catch (err) {
      if (!current() || err instanceof InviteRouteChangedError) return;
      if (err instanceof SessionChangedError) {
        previewSession.current = null;
        setInvite(null);
        setAttempt((value) => value + 1);
        return;
      }
      console.warn("[invite] decline failed", err);
      toast.push(t("inbox.failed"), "error");
    } finally {
      if (current()) {
        acceptingRef.current = false;
        setDeclining(false);
      }
    }
  }

  async function onSignIn() {
    const generation = routeGeneration.current;
    // The auth screen reads pending_invite_token from app_meta after
    // sign-in completes and routes back to this screen with the token.
    // A phone that was never set up goes through onboarding instead, so the
    // invitee still chooses language and date format; its sign-in step
    // consumes the same stash (audit #22).
    const set = await getLocalSelf().catch(() => null);
    if (generation !== routeGeneration.current || !currentScope()) return;
    router.replace(set ? "/sign-in" : "/onboarding");
  }

  // Confirm-stage body is ONE i18n sentence with {inviter} + {role}
  // placeholders (never split across keys — Persian word order differs).
  // t() substitutes {inviter}; we then split on the literal "{role}"
  // token so the role label can keep its bold style inline.
  const inviterLabel = invite
    ? (invite.inviter_name ?? invite.inviter_email ?? t("inviteAccept.confirm.someone"))
    : "";
  const confirmBodyParts = invite
    ? t("inviteAccept.confirm.body", { inviter: inviterLabel }).split("{role}")
    : [];

  return (
    <SafeAreaView style={styles.container}>
      {/* Was a hand-rolled row: the dismiss was a bare 15px line box (~39px
          tall) grown by hitSlop, and the title floated off-centre between a
          60px label and a 60px spacer. ScreenHeader's back is a real 44×44
          target and applies its own rowDir() + chevron flip, so the direction
          handling moves into the atom rather than disappearing. The word
          "Cancel" is no longer painted — backLabel carries it to the screen
          reader, which is what ScreenHeader's chevron contract asks for. */}
      <ScreenHeader
        title={t(
          invite?.kind === "ownership_transfer" ? "ownershipAccept.title" : "inviteAccept.title",
        )}
        onBack={() => router.replace("/")}
        isRTL={isRTL}
        backLabel={t("common.cancel")}
      />

      <View style={styles.body}>
        {stage === "loading" ? (
          <View style={styles.fillCenter}>
            <ActivityIndicator color={colors.textDefault} />
          </View>
        ) : null}

        {stage === "needs_signin" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="lock-closed-outline" size={icon.hero} color={colors.textMuted} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>{t("common.signInToContinue")}</Text>
            <Text style={[styles.body2, textDir(isRTL)]}>{t("inviteAccept.signin.body")}</Text>
            <View style={{ height: 20 }} />
            {/* /sign-in offers every way in (Google, Apple, email). */}
            <Button label={t("inviteAccept.signin.cta")} onPress={onSignIn} />
            <View style={{ height: 12 }} />
            <Button
              label={t("common.notNow")}
              variant="secondary"
              onPress={() => router.replace("/")}
            />
          </View>
        ) : null}

        {stage === "confirm" && invite ? (
          <View style={styles.confirmCard}>
            {/* 36 → icon.hero (40): this stage's glyph now matches the
                needs_signin and error stages of the same screen. */}
            <Ionicons name="mail-open-outline" size={icon.hero} color={colors.textEmphasis} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>
              {t(
                invite.kind === "ownership_transfer"
                  ? "ownershipAccept.heading"
                  : "inviteAccept.confirm.title",
                { name: invite.vault_name },
              )}
            </Text>
            <View style={{ height: 8 }} />
            <Text style={[styles.body2, textDir(isRTL)]}>
              {invite.kind === "member_readmission" ? (
                t("inviteAccept.readmission.body", {
                  inviter: inviterLabel,
                  role: roleLabel(invite.role),
                })
              ) : invite.kind === "ownership_transfer" ? (
                t("ownershipAccept.body", { inviter: inviterLabel })
              ) : (
                <>
                  {confirmBodyParts[0]}
                  <Text style={styles.bold}>{roleLabel(invite.role)}</Text>
                  {confirmBodyParts[1] ?? ""}
                </>
              )}
            </Text>
            <View style={{ height: 4 }} />
            <Text style={[styles.bodySubtle, textDir(isRTL)]}>
              {t("members.expiresLabel", { when: formatExpires(invite.expires_at) })}
            </Text>

            <View style={{ height: 28 }} />
            <Button
              label={t(
                invite.kind === "ownership_transfer"
                  ? "ownershipAccept.accept"
                  : invite.kind === "member_readmission"
                    ? "inviteAccept.readmission.accept"
                    : "inviteAccept.confirm.accept",
              )}
              onPress={onAccept}
              disabled={declining}
            />
            <View style={{ height: 12 }} />
            <Button
              label={t("inviteAccept.confirm.decline")}
              variant="secondary"
              onPress={onDecline}
              loading={declining}
            />
          </View>
        ) : null}

        {stage === "accepting" ? (
          <View style={styles.fillCenter}>
            <ActivityIndicator color={colors.textDefault} />
            <View style={{ height: 12 }} />
            <Text style={[styles.body2, textDir(isRTL)]}>{t("inviteAccept.joining")}</Text>
          </View>
        ) : null}

        {stage === "pending" || stage === "blocked" || stage === "waiting_owner" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="time-outline" size={icon.hero} color={colors.textMuted} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>
              {t(
                stage === "waiting_owner"
                  ? "inviteAccept.readmission.waitingTitle"
                  : stage === "blocked"
                    ? "inviteAccept.blocked.title"
                    : "inviteAccept.pending.title",
              )}
            </Text>
            <Text style={[styles.body2, textDir(isRTL)]}>
              {t(
                stage === "waiting_owner"
                  ? "inviteAccept.readmission.waitingBody"
                  : stage === "blocked"
                    ? "inviteAccept.blocked.body"
                    : "inviteAccept.pending.body",
              )}
            </Text>
            {stage === "waiting_owner" && errorMsg ? (
              <Text style={[styles.body2, textDir(isRTL)]}>{errorMsg}</Text>
            ) : null}
            <View style={{ height: 20 }} />
            {stage !== "blocked" ? <Button label={t("common.retry")} onPress={onAccept} /> : null}
            <View style={{ height: 12 }} />
            <Button
              label={t("common.backToKaata")}
              variant="secondary"
              onPress={() => router.replace("/")}
            />
          </View>
        ) : null}

        {stage === "error" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="alert-circle-outline" size={icon.hero} color={colors.danger} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>{t("inviteAccept.error.title")}</Text>
            <Text style={[styles.body2, textDir(isRTL)]}>{errorMsg}</Text>
            <View style={{ height: 20 }} />
            {retryable ? (
              <>
                <Button
                  label={t("common.retry")}
                  onPress={() => {
                    setStage("loading");
                    setAttempt((a) => a + 1);
                  }}
                />
                <View style={{ height: 12 }} />
              </>
            ) : null}
            <Button
              label={t("common.backToKaata")}
              variant={retryable ? "secondary" : undefined}
              onPress={() => router.replace("/")}
            />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

// Map the raw role enum to its translated label. Roles v2 review fix: all
// five roles map explicitly — a clerk invitee must not be told "Editor".
// Unknown/absent still falls back to the editor label (legacy invites).
function roleLabel(role: PendingInvite["role"]): string {
  switch (role) {
    case "owner":
      return t("vaultSettings.role.owner");
    case "manager":
      return t("vaultSettings.role.manager");
    case "clerk":
      return t("vaultSettings.role.clerk");
    case "viewer":
      return t("vaultSettings.role.viewer");
    default:
      return t("vaultSettings.role.editor");
  }
}

// Relative expiry phrase, rendered inside members.expiresLabel
// ("Expires {when}"). Reuses the invite.expiresIn.* keys.
function formatExpires(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return t("invite.expiresIn.soon");
  const hours = Math.floor(diff / 3600_000);
  if (hours < 24) return t("invite.expiresIn.hours", { hours: Math.max(1, hours) });
  return t("invite.expiresIn.days", { days: Math.floor(hours / 24) });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  // ONE gutter, applied once — see `body`. These two are the stage wrappers
  // that sit inside it; both used to add a second horizontal inset of their own
  // (fillCenter 24, confirmCard 8), so the same screen rendered its copy at 48px
  // from the edge on the loading / sign-in / error stages and 32px on the
  // confirm stage, against the 24px every other hero screen uses. The narrower
  // measure is why this landing read as cramped next to onboarding and restore.
  // Padding does NOT go on `container`: ScreenHeader must stay full-bleed or its
  // bottom hairline stops reaching the screen edges.
  fillCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, padding: gutter.hero },

  confirmCard: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  // 20 / sansSemi written out by hand was heading exactly; the token adds the
  // routed line height it was missing. Same for body2 (= body) and bodySubtle
  // (= bodySm) below — identical pixels, minus three chances to forget the
  // iOS line-height floor.
  heading: {
    ...typography.heading,
    color: colors.textEmphasis,
    textAlign: "center",
  },
  body2: {
    ...typography.body,
    color: colors.textDefault,
    textAlign: "center",
  },
  bodySubtle: {
    ...typography.bodySm,
    color: colors.textSubtle,
    textAlign: "center",
  },
  bold: { fontFamily: fonts.sansSemi, color: colors.textEmphasis },
});
