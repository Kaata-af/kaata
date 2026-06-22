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
//      lookupPendingInvite(token). The /v1/vaults/invites/pending endpoint
//      returns ALL pending invites for the caller; we filter for this
//      token. If not found (different email account, expired, revoked),
//      surface the error and offer to switch accounts.
//   4. User confirms → POST /v1/vaults/invites/accept with {token,
//      install_id}. On success, the new vault is added to the local
//      vaults table + vault_members_mirror is seeded, setActiveVaultId
//      switches to it, and we route home.

import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { useToast } from "../../components/Toast";
import { getSessionJWT } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { setActiveVaultId } from "../../lib/db-tx";
import { setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import {
  acceptVaultInvite,
  declineVaultInviteLocally,
  lookupPendingInvite,
  type PendingInvite,
} from "../../lib/vault-api";

type Stage = "loading" | "needs_signin" | "confirm" | "accepting" | "error" | "done";

const PENDING_TOKEN_KEY = "pending_invite_token";

export default function InviteAcceptScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const { token: tokenParam } = useLocalSearchParams<{ token: string }>();
  const token = typeof tokenParam === "string" ? tokenParam : null;

  const [stage, setStage] = useState<Stage>("loading");
  const [invite, setInvite] = useState<PendingInvite | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    (async () => {
      if (!token) {
        toast.push(t("inviteAccept.invalidLink"), "error");
        router.replace("/");
        return;
      }
      try {
        // Sign-in gate. We need a session JWT to call
        // /v1/vaults/invites/pending. Stash the token so the auth flow
        // returns here after sign-in.
        const jwt = await getSessionJWT();
        if (!jwt) {
          await setAppMeta(PENDING_TOKEN_KEY, token);
          setStage("needs_signin");
          return;
        }

        const found = await lookupPendingInvite(token);
        if (!found) {
          setErrorMsg(t("inviteAccept.error.notVisible"));
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
        setStage("error");
      }
    })();
  }, [token, router, toast]);

  async function onAccept() {
    if (!invite || !token) return;
    setStage("accepting");
    try {
      const result = await acceptVaultInvite(token);
      // The accept call has already seeded vaults + vault_members_mirror
      // for the new vault locally (via the response payload). Switch to
      // it so the home screen lands in the freshly-joined vault.
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
      toast.push(t("inviteAccept.joinedToast", { name: invite.vault_name }), "success");
      router.replace("/");
    } catch (err) {
      // Raw err.message stays in the console for debugging; the user
      // sees the localized fallback only.
      console.warn("[invite] accept failed", err);
      setErrorMsg(t("inviteAccept.error.acceptFailed"));
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
            <Button label={t("common.backToKaata")} onPress={() => router.replace("/")} />
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
