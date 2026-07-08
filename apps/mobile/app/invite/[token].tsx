// Invite acceptance — Phase 4 deep-link landing.
//
// Route: kaata://invite/<token>  (configured in app.json scheme handler)
// Web fallback: kaata.af/i/<token> on the marketing site → tries the deep
// link, falls back to download instructions if the app isn't installed.
//
// Lifecycle:
//   1. Extract token from route param. Bail to home with toast if missing.
//   2. Require Google sign-in. If no JWT, route to onboarding/auth with
//      pending_invite_token stashed so the post-sign-in flow returns here.
//   3. Look up the invite details (vault name, role, inviter) via
//      lookupPendingInvite(token) — the local pending_invitations cache —
//      then fall back to the PUBLIC GET /v1/vaults/invites/{token}/info.
//      The fallback is the normal path for link invitees: the server holds
//      only the token hash post-migration, so no local row can exist for a
//      token this device first sees via the deep link. A 404 there means
//      expired / revoked / already used (collapsed by design); network
//      failures land on a retryable error state.
//   4. User confirms → POST /v1/vaults/invites/accept with {token,
//      install_id}. The accept response carries ONLY {vault_id, vault_name,
//      role} — it does NOT seed any local state — so we then materialize the
//      vault locally: recoverJoinedVault() seeds the `vaults` row from
//      GET /v1/vaults and pulls its history (membership chain + ledger).
//      Only then does setActiveVaultId switch to it and we route home; the
//      home screen lists from the local `vaults` table, so without that seed
//      it would not see the joined vault and would revert the active pointer.

import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { useToast } from "../../components/Toast";
import { getSessionJWT } from "../../lib/auth";
import { requestImmediateCheckIn } from "../../lib/checkin-trigger";
import { colors } from "../../lib/colors";
import { setActiveVaultId } from "../../lib/db-tx";
import { setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import {
  acceptVaultInvite,
  ApiError,
  clearVaultMaterializePending,
  declineVaultInviteLocally,
  fetchInviteInfo,
  lookupPendingInvite,
  markVaultMaterializePending,
  retryPendingVaultMaterialize,
  type PendingInvite,
} from "../../lib/vault-api";

type Stage = "loading" | "needs_signin" | "confirm" | "accepting" | "error" | "done";

const PENDING_TOKEN_KEY = "pending_invite_token";

// Confirm-card view model — the common subset of a local pending_invitations
// row (email invites mirrored by fetchPendingInvitations) and the public
// /info endpoint (link invitees, who never have a local row). The screen
// doesn't need vault_id here: the accept response carries it.
type InviteDetails = {
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
  const { token: tokenParam } = useLocalSearchParams<{ token: string }>();
  const token = typeof tokenParam === "string" ? tokenParam : null;

  const [stage, setStage] = useState<Stage>("loading");
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [retryable, setRetryable] = useState(false);
  // L15: synchronous re-entry guard for onAccept (single-use token).
  const acceptingRef = useRef(false);
  // Bumped by the Retry button to re-run the lookup effect after a network
  // failure (the /info fallback is the only throwing step in it).
  const [attempt, setAttempt] = useState(0);

  // Heal a prior accept whose local materialization failed: onAccept stamps
  // VAULT_MATERIALIZE_PENDING before recoverJoinedVault and clears it only on
  // success, so a re-visit of this screen (e.g. re-tapping the link after the
  // "joined" toast but no visible kaata) re-seeds the row. Best-effort.
  useEffect(() => {
    retryPendingVaultMaterialize().catch((err) =>
      console.warn("[invite] pending materialize retry failed", err),
    );
  }, []);

  useEffect(() => {
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
        const jwt = await getSessionJWT();
        if (!jwt) {
          await setAppMeta(PENDING_TOKEN_KEY, token);
          setStage("needs_signin");
          return;
        }

        let found: InviteDetails | null = await lookupPendingInvite(token);
        if (!found) {
          // No local row — the normal case for a link invitee (see the
          // lifecycle comment above). Ask the public /info endpoint; null
          // means 404 (expired / revoked / already used), network failures
          // throw into the retryable catch below.
          const info = await fetchInviteInfo(token);
          if (info) {
            found = {
              vault_name: info.vault_name,
              role: info.role,
              inviter_name: info.inviter_name,
              inviter_email: info.inviter_email_redacted,
              expires_at: info.expires_at,
            };
          }
        }
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
      } catch (err) {
        // Raw err.message stays in the console for debugging; the user
        // sees the localized fallback only.
        console.warn("[invite] lookup failed", err);
        setErrorMsg(t("inviteAccept.error.loadFailed"));
        setRetryable(true);
        setStage("error");
      }
    })();
  }, [token, router, toast, attempt]);

  async function onAccept() {
    // L15: synchronous re-entry guard. setStage is async, so without this two
    // rapid taps both call acceptVaultInvite (a single-use token) — the second
    // 404s and shows an "invite expired" error for a join that actually
    // succeeded, plus races two recoverJoinedVault materializations.
    if (!invite || !token || acceptingRef.current) return;
    acceptingRef.current = true;
    setStage("accepting");
    try {
      const result = await acceptVaultInvite(token);
      // Materialize the joined vault LOCALLY before switching to it. The accept
      // response carries only {vault_id, vault_name, role}; nothing else creates
      // the local `vaults` row, and the home screen lists from that table — so
      // without this it can't see the joined vault and silently reverts the
      // active pointer. recoverJoinedVault seeds the row from the server listing
      // and pulls the history. Best-effort: even if it fails we still set the
      // pointer — but no launch path heals a missing row on its own
      // (recoverAllVaults only runs on restore/sign-in), so mirror the
      // witness_emit_pending pattern below: flag BEFORE the attempt, clear only
      // on confirmed success, and retryPendingVaultMaterialize sweeps it on
      // this screen's next mount.
      try {
        await markVaultMaterializePending(result.vault_id);
        const { recoverJoinedVault } = await import("../../lib/recovery");
        if (await recoverJoinedVault(result.vault_id)) {
          await clearVaultMaterializePending(result.vault_id);
        }
      } catch (err) {
        console.warn("[invite] joined-vault materialization failed (flagged for retry)", err);
      }
      await setActiveVaultId(result.vault_id);
      await setAppMeta(PENDING_TOKEN_KEY, "");

      // M2 membership chain (docs/m2-membership-chain.md §4): after a
      // successful online acceptance, this device fetches the server
      // witness and emits its own witnessed vault_member_added +
      // vault_device_added — the invitee's future handshake proofs.
      // Emission failure must NOT break the accept UX: the pending flag
      // is set BEFORE the attempt and cleared only on success, so
      // ensureChainBackfill retries on the next app session (duplicate
      // admissions are no-ops in the chain fold, so a partial first
      // attempt re-running is safe).
      try {
        const { emitWitnessedSelfAdmission, witnessEmitPendingKey } =
          await import("../../lib/trust/backfill");
        await setAppMeta(witnessEmitPendingKey(result.vault_id), "1");
        await emitWitnessedSelfAdmission(result.vault_id);
        await setAppMeta(witnessEmitPendingKey(result.vault_id), "");
      } catch (err) {
        console.warn("[invite] witness emission failed (backfill path will retry)", err);
      }
      setStage("done");
      // Push the joined-vault membership + onboarded state to the backend now.
      // recoverJoinedVault created the local-self; without an immediate check-in
      // this signed-in user could still read as "not onboarded" on the admin
      // dashboard until their next launch (the only other check-in triggers are
      // cold launch + throttled foreground). Best-effort; no-ops if offline.
      requestImmediateCheckIn();
      toast.push(t("inviteAccept.joinedToast", { name: invite.vault_name }), "success");
      router.replace("/");
    } catch (err) {
      // Reset the guard so the user can retry after a transient failure (on
      // success we've already navigated home, so it stays locked).
      acceptingRef.current = false;
      // Raw err.message stays in the console for debugging; the user sees a
      // localized message chosen from the backend's structured error_code.
      console.warn("[invite] accept failed", err);
      const code = err instanceof ApiError ? err.code : "";
      if (code === "invite_not_found") {
        // Link expired, revoked, or already used (collapsed code, by design).
        setErrorMsg(t("inviteAccept.error.expired"));
      } else if (code === "rate_limited") {
        setErrorMsg(t("inviteAccept.error.rateLimited"));
      } else {
        setErrorMsg(t("inviteAccept.error.acceptFailed"));
      }
      setStage("error");
    }
  }

  async function onDecline() {
    if (!token) return;
    try {
      await declineVaultInviteLocally(token);
    } catch (err) {
      console.warn("[invite] decline failed", err);
    }
    await setAppMeta(PENDING_TOKEN_KEY, "");
    router.replace("/");
  }

  function onSignIn() {
    // The auth screen reads pending_invite_token from app_meta after
    // sign-in completes and routes back to this screen with the token.
    router.replace("/onboarding/auth");
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
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.replace("/")} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("inviteAccept.title")}</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.body}>
        {stage === "loading" ? (
          <View style={styles.fillCenter}>
            <ActivityIndicator color={colors.textDefault} />
          </View>
        ) : null}

        {stage === "needs_signin" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="lock-closed-outline" size={40} color={colors.textMuted} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>{t("common.signInToContinue")}</Text>
            <Text style={[styles.body2, textDir(isRTL)]}>{t("inviteAccept.signin.body")}</Text>
            <View style={{ height: 20 }} />
            <Button label={t("menu.account.signIn")} onPress={onSignIn} />
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
            <Ionicons name="mail-open-outline" size={36} color={colors.textEmphasis} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>
              {t("inviteAccept.confirm.title", { name: invite.vault_name })}
            </Text>
            <View style={{ height: 8 }} />
            <Text style={[styles.body2, textDir(isRTL)]}>
              {confirmBodyParts[0]}
              <Text style={styles.bold}>{roleLabel(invite.role)}</Text>
              {confirmBodyParts[1] ?? ""}
            </Text>
            <View style={{ height: 4 }} />
            <Text style={[styles.bodySubtle, textDir(isRTL)]}>
              {t("members.expiresLabel", { when: formatExpires(invite.expires_at) })}
            </Text>

            <View style={{ height: 28 }} />
            <Button label={t("inviteAccept.confirm.accept")} onPress={onAccept} />
            <View style={{ height: 12 }} />
            <Button
              label={t("inviteAccept.confirm.decline")}
              variant="secondary"
              onPress={onDecline}
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

        {stage === "error" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="alert-circle-outline" size={36} color={colors.danger} />
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

// Map the raw role enum to its translated label (vaultPair.role.* keys).
function roleLabel(role: PendingInvite["role"]): string {
  switch (role) {
    case "owner":
      return t("vaultPair.role.owner");
    case "viewer":
      return t("vaultPair.role.viewer");
    default:
      return t("vaultPair.role.editor");
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
  fillCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  cancel: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    minWidth: 60,
  },
  title: { fontSize: 16, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  body: { flex: 1, padding: 24 },

  confirmCard: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  heading: {
    fontSize: 20,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
  },
  body2: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    textAlign: "center",
    lineHeight: 20,
  },
  bodySubtle: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
  },
  bold: { fontFamily: fonts.sansSemi, color: colors.textEmphasis },
});
