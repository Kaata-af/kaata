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
        toast.push("Invalid invitation link", "error");
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
          setErrorMsg(
            "This invitation isn't visible on your account. The invite is anchored to a specific email — try signing in with the Google account that received the invitation.",
          );
          setStage("error");
          return;
        }
        if (found.expires_at <= Date.now()) {
          setErrorMsg("This invitation has expired. Ask the inviter for a new one.");
          setStage("error");
          return;
        }
        setInvite(found);
        setStage("confirm");
      } catch (err) {
        console.warn("[invite] lookup failed", err);
        const msg = err instanceof Error ? err.message : "Failed to load invitation";
        setErrorMsg(msg);
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
      setStage("done");
      toast.push(`Joined ${invite.vault_name}`, "success");
      router.replace("/");
    } catch (err) {
      console.warn("[invite] accept failed", err);
      const msg = err instanceof Error ? err.message : "Failed to accept invitation";
      setErrorMsg(msg);
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

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.replace("/")} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Vault invitation</Text>
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
            <Text style={[styles.heading, textDir(isRTL)]}>Sign in to continue</Text>
            <Text style={[styles.body2, textDir(isRTL)]}>
              You need to sign in with Google to accept this invitation. Use the email address that
              received the invite.
            </Text>
            <View style={{ height: 20 }} />
            <Button label="Sign in with Google" onPress={onSignIn} />
            <View style={{ height: 12 }} />
            <Button label="Not now" variant="secondary" onPress={() => router.replace("/")} />
          </View>
        ) : null}

        {stage === "confirm" && invite ? (
          <View style={styles.confirmCard}>
            <Ionicons name="mail-open-outline" size={36} color={colors.textEmphasis} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>Join {invite.vault_name}?</Text>
            <View style={{ height: 8 }} />
            <Text style={[styles.body2, textDir(isRTL)]}>
              {invite.inviter_name ?? invite.inviter_email ?? "Someone"} invited you to join as a{" "}
              <Text style={styles.bold}>{invite.role}</Text>.
            </Text>
            <View style={{ height: 4 }} />
            <Text style={[styles.bodySubtle, textDir(isRTL)]}>
              Expires {formatExpires(invite.expires_at)}.
            </Text>

            <View style={{ height: 28 }} />
            <Button label={`Accept and join`} onPress={onAccept} />
            <View style={{ height: 12 }} />
            <Button label="Decline" variant="secondary" onPress={onDecline} />
          </View>
        ) : null}

        {stage === "accepting" ? (
          <View style={styles.fillCenter}>
            <ActivityIndicator color={colors.textDefault} />
            <View style={{ height: 12 }} />
            <Text style={[styles.body2, textDir(isRTL)]}>Joining vault…</Text>
          </View>
        ) : null}

        {stage === "error" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="alert-circle-outline" size={36} color={colors.danger} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>Something went wrong</Text>
            <Text style={[styles.body2, textDir(isRTL)]}>{errorMsg}</Text>
            <View style={{ height: 20 }} />
            <Button label="Back to Kaata" onPress={() => router.replace("/")} />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function formatExpires(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return "soon";
  const days = Math.ceil(diff / (24 * 3600_000));
  if (days <= 1) return "in less than a day";
  return `in ${days} days`;
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
