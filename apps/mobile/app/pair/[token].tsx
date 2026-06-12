// Phase 5.1 — kaata://pair/<token> deep link handler.
//
// Route: kaata://pair/<token>?p=<base64url-PairQrPayload>
//
// The "Send link instead" button on vault/pair.tsx exposes this URL. The
// new phone tapping the link lands here. The base64url-encoded `p` query
// param carries the SAME PairQrPayload that the QR encodes — vault_id,
// vault_name, issuer_account_id, issuer_install_id, issued_at_ms,
// expires_at_ms, shop_mode_token. We decode it, run the same validation
// path as the camera scanner, then run the identical 5-step issuance:
//
//   1. Verify own account_id == payload.issuer_account_id.
//   2. Insert local vaults row.
//   3. POST /v1/vaults/:vault_id/credential with {pair_token,
//      pair_issued_at_ms}.
//   4. verifyAndCacheVMC().
//   5. Flip shop_mode_enabled = '1' + setActiveVaultId.

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
import { getAppMeta, getDb, setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { decodePairDeepLinkPayload, type PairQrPayload } from "../../lib/mesh/pair-qr";
import { verifyAndCacheVMC } from "../../lib/mesh/vmc";
import { issueVaultCredential } from "../../lib/vault-api";

type Stage =
  | { kind: "loading" }
  | { kind: "needs_signin" }
  | { kind: "confirm"; payload: PairQrPayload }
  | { kind: "joining"; payload: PairQrPayload }
  | { kind: "joined"; vault_name: string }
  | { kind: "error"; message: string };

// The hand-off used by /onboarding/auth to re-route here after sign-in.
const PENDING_PAIR_DEEPLINK_KEY = "pending_pair_deeplink";

export default function PairDeepLinkScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const params = useLocalSearchParams<{ token?: string; p?: string }>();
  const blob = typeof params.p === "string" ? params.p : null;

  const [stage, setStage] = useState<Stage>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      if (!blob) {
        setStage({
          kind: "error",
          message: t("pairLink.error.missingData"),
        });
        return;
      }
      const decoded = decodePairDeepLinkPayload(blob);
      if (!decoded.ok) {
        setStage({
          kind: "error",
          message:
            decoded.reason === "expired"
              ? t("pairLink.error.expired")
              : t("pairLink.error.malformed"),
        });
        return;
      }
      // Sign-in gate. The /credential endpoint needs the session JWT and
      // we need account_id to compare against payload.issuer_account_id.
      const jwt = await getSessionJWT();
      if (!jwt) {
        // Stash the full URL (path + query) so /onboarding/auth can
        // re-navigate here after sign-in completes.
        await setAppMeta(
          PENDING_PAIR_DEEPLINK_KEY,
          `kaata://pair/${encodeURIComponent(params.token ?? "x")}?p=${encodeURIComponent(blob)}`,
        );
        setStage({ kind: "needs_signin" });
        return;
      }
      setStage({ kind: "confirm", payload: decoded.payload });
    })();
  }, [blob, params.token]);

  async function onConfirm() {
    if (stage.kind !== "confirm") return;
    const payload = stage.payload;
    setStage({ kind: "joining", payload });
    try {
      const ourAccountId = await getAppMeta("account_id");
      if (!ourAccountId) {
        setStage({
          kind: "error",
          message: t("vaultPairScan.error.signInRequired"),
        });
        return;
      }
      if (ourAccountId !== payload.issuer_account_id) {
        setStage({
          kind: "error",
          message: t("pairLink.error.accountMismatch"),
        });
        return;
      }

      // Insert local vault row so it shows in the picker before /sync/pull.
      const db = await getDb();
      await db.withTransactionAsync(async () => {
        const existing = await db.getFirstAsync<{ id: string }>(
          `SELECT id FROM vaults WHERE id = ? LIMIT 1`,
          payload.vault_id,
        );
        if (!existing) {
          const now = Date.now();
          await db.runAsync(
            `INSERT INTO vaults (
               id, name, currency, created_at, updated_at,
               archived_at, is_default, account_id,
               registered_with_server_at, vault_epoch,
               hlc_logical, hlc_wall_ms
             ) VALUES (?, ?, 'AFN', ?, ?, NULL, 0, ?, ?, 0, 0, 0)`,
            payload.vault_id,
            payload.vault_name,
            now,
            now,
            ourAccountId,
            now,
          );
        }
      });

      // Server-side: consume the pair token + reject clock rollback.
      const issued = await issueVaultCredential(payload.vault_id, {
        pair_token: payload.shop_mode_token,
        pair_issued_at_ms: payload.issued_at_ms,
      });

      await verifyAndCacheVMC(payload.vault_id, issued.vmc_blob);

      await setAppMeta("shop_mode_enabled", "1");
      await setActiveVaultId(payload.vault_id);
      await setAppMeta(PENDING_PAIR_DEEPLINK_KEY, "");

      setStage({ kind: "joined", vault_name: payload.vault_name });
      toast.push(t("vaultPairScan.toast.pairedNearby"), "success");
    } catch (err) {
      // Raw err.message stays in the console for debugging; the user
      // sees the localized fallback only.
      console.warn("[pair/deeplink] join failed", err);
      setStage({
        kind: "error",
        message: t("vaultPairScan.error.generic"),
      });
    }
  }

  function onSignIn() {
    // /onboarding/auth reads PENDING_PAIR_DEEPLINK_KEY after sign-in
    // completes and routes back here.
    router.replace("/onboarding/auth");
  }

  function onDone() {
    router.replace("/");
  }

  function onCancel() {
    router.replace("/");
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={onCancel} hitSlop={8} style={styles.backHit}>
          <Ionicons
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={24}
            color={colors.textEmphasis}
          />
          <Text style={[styles.backLabel, textDir(isRTL)]}>
            {stage.kind === "joined" ? t("common.done") : t("common.cancel")}
          </Text>
        </Pressable>
        <Text style={styles.title}>{t("pairLink.title")}</Text>
        <View style={{ width: 72 }} />
      </View>

      <View style={styles.body}>
        {stage.kind === "loading" ? (
          <View style={styles.fillCenter}>
            <ActivityIndicator color={colors.textDefault} />
          </View>
        ) : null}

        {stage.kind === "needs_signin" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="lock-closed-outline" size={40} color={colors.textMuted} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>{t("common.signInToContinue")}</Text>
            <Text style={[styles.body2, textDir(isRTL)]}>{t("pairLink.signin.body")}</Text>
            <View style={{ height: 20 }} />
            <Button label={t("menu.account.signIn")} onPress={onSignIn} />
            <View style={{ height: 12 }} />
            <Button label={t("common.notNow")} variant="secondary" onPress={onCancel} />
          </View>
        ) : null}

        {stage.kind === "confirm" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="phone-portrait-outline" size={40} color={colors.textEmphasis} />
            <View style={{ height: 12 }} />
            {/* Single key with {name} — the former nested-bold wrapper was a
                visual no-op (styles.bold === styles.heading's font/color), so
                collapsing keeps the rendering identical while letting Persian
                reorder the sentence freely. */}
            <Text style={[styles.heading, textDir(isRTL)]}>
              {t("pairLink.confirm.title", { name: stage.payload.vault_name })}
            </Text>
            <Text style={[styles.body2, textDir(isRTL)]}>{t("pairLink.confirm.body")}</Text>
            {/* Show the first 8 chars of the issuer's account_id so the user
                can spot wrong-account links BEFORE tapping Join — the QR
                schema doesn't carry the issuer's email (it's a v1 wire
                contract), but the account_id slug is at least a stable
                fingerprint. We compare server-side too, so this is purely
                a UX hint. */}
            <Text style={[styles.issuerLine, textDir(isRTL)]}>
              {t("pairLink.confirm.fromAccount", {
                id: stage.payload.issuer_account_id.slice(0, 8),
              })}
            </Text>
            <View style={{ height: 24 }} />
            <Button label={t("vaultPairScan.confirm.join")} onPress={onConfirm} />
            <View style={{ height: 12 }} />
            <Button label={t("common.cancel")} variant="secondary" onPress={onCancel} />
          </View>
        ) : null}

        {stage.kind === "joining" ? (
          <View style={styles.fillCenter}>
            <ActivityIndicator color={colors.textDefault} />
            <View style={{ height: 12 }} />
            <Text style={[styles.body2, textDir(isRTL)]}>
              {t("vaultPairScan.joining", { name: stage.payload.vault_name })}
            </Text>
          </View>
        ) : null}

        {stage.kind === "joined" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="checkmark-circle" size={56} color={colors.textEmphasis} />
            <View style={{ height: 12 }} />
            {/* Single key with an embedded \n + {name} — same no-op-bold
                collapse as the confirm heading above. */}
            <Text style={[styles.heading, textDir(isRTL)]}>
              {t("pairLink.joined.title", { name: stage.vault_name })}
            </Text>
            <Text style={[styles.body2, textDir(isRTL)]}>{t("pairLink.joined.body")}</Text>
            <View style={{ height: 24 }} />
            <Button label={t("common.done")} onPress={onDone} />
          </View>
        ) : null}

        {stage.kind === "error" ? (
          <View style={styles.fillCenter}>
            <Ionicons name="alert-circle-outline" size={40} color={colors.danger} />
            <View style={{ height: 12 }} />
            <Text style={[styles.heading, textDir(isRTL)]}>
              {t("vaultPairScan.error.headline")}
            </Text>
            <Text style={[styles.body2, textDir(isRTL)]}>{stage.message}</Text>
            <View style={{ height: 20 }} />
            <Button label={t("common.backToKaata")} onPress={onCancel} />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
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
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  backHit: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 72,
    paddingHorizontal: 4,
  },
  backLabel: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
    marginLeft: 2,
  },
  title: { fontSize: 16, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  body: { flex: 1, padding: 24 },
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
    marginTop: 8,
  },
  bold: { fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  issuerLine: {
    fontSize: 12,
    fontFamily: fonts.monoBold,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 12,
    letterSpacing: 0.4,
  },
});
