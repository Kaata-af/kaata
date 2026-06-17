// QR pairing, new-device (joiner) side — chain-native (M4), Briar split-screen.
//
// Briar shows BOTH a QR and a camera at once: each phone shows its own code and
// scans the other's, simultaneously. This screen is the joiner half:
//
//   - TOP:    the joiner's identity QR (its device pubkey + display name). The
//             OWNER scans this out-of-band so it can pin our key
//             (bindExpectedJoiner) and admit exactly this device.
//   - BOTTOM: a live camera scanning the OWNER's vault QR.
//
// On scanning the owner's QR we immediately:
//   1. Add the vault row locally with the owner's trust anchor pubkey pinned
//      (so it appears in the picker and the chain handshake can fold membership).
//   2. Write the joiner's own vault_members_mirror row + pin the owner as member
//      so the Members tab and role-gate work immediately.
//   3. Persist the QR's shop_mode_token as the local pair_nonce — the joiner
//      echoes it on its first BLE handshake; the OWNER verifies it against a live
//      pair token (now gated on the key they scanned from our top QR) and EMITS
//      the joiner's admission events into the chain. We mint NO credential.
//   4. Flip shop_mode_enabled = '1' and dial the owner on a short backoff so the
//      first sync lands within seconds of the owner scanning our code.

import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import QRCode from "react-native-qrcode-svg";
import { Button } from "../../components/Button";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { setActiveVaultId } from "../../lib/db-tx";
import { getAppMeta, getDb, getLocalSelf, setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import {
  decodePairQr,
  encodeJoinerIdentityQr,
  type PairQrPayload,
  type PairQrRole,
} from "../../lib/mesh/pair-qr";
import { ensureDeviceKey, getDevicePubkey } from "../../lib/mesh/device-key";
import { buildLocalAccountId } from "../../lib/trust/account-id";

/**
 * D-PAIR-WITH-ROLE: derive the role offered by a scanned QR.
 * Returns { role, missing } so the join writes use the right role; default is
 * "editor" — safer than the legacy implicit "owner" — when the field is absent
 * (legacy v=1 QR or buggy issuer).
 */
function deriveOfferedRole(payload: PairQrPayload): { role: PairQrRole; missing: boolean } {
  if (payload.role === "owner" || payload.role === "editor" || payload.role === "viewer") {
    return { role: payload.role, missing: false };
  }
  return { role: "editor", missing: true };
}

type Step =
  // Briar split-screen: our identity QR (top) + live camera (bottom), both at
  // once. Stays here until the owner's QR is scanned.
  | { kind: "pairing" }
  | { kind: "joining"; payload: PairQrPayload }
  | {
      kind: "joined";
      vault_id: string;
      vault_name: string;
      /** Set when the immediate first-sync didn't complete — you're still joined
       *  (pinned from the QR) and steady-sync retries in the background. Shown as
       *  a small note (also carries the phase diagnostic). */
      syncNote?: string;
    }
  | { kind: "error"; message: string };

export default function VaultPairScanScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<Step>({ kind: "pairing" });
  // Our own identity QR, built once on mount from the device key + display name.
  const [identityQr, setIdentityQr] = useState<string | null>(null);
  // Guard against BarCodeScanner firing the callback multiple times before the
  // camera unmounts. First valid scan wins; a garbage/wrong code re-arms it.
  const handledRef = useRef(false);

  // Build our identity QR once: the OWNER scans this to pin our device key, so it
  // must be live alongside the camera (Briar's split). Loads the device key first
  // (an in-memory cache miss leaves getDevicePubkey() null).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureDeviceKey();
        const devicePubkeyB64 = getDevicePubkey();
        if (!devicePubkeyB64) return;
        const self = await getLocalSelf();
        const joinerName = (self?.name ?? "").trim();
        const qr = encodeJoinerIdentityQr({
          v: 1,
          kind: "joiner_identity",
          device_pubkey: devicePubkeyB64,
          display_name: joinerName,
        });
        if (!cancelled) setIdentityQr(qr);
      } catch (err) {
        console.warn("[vault/pair-scan] identity QR build failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-request the camera as soon as we're on the split, so both halves (our
  // code + their camera) are live together with no extra tap.
  useEffect(() => {
    if (step.kind === "pairing" && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind, permission?.granted]);

  async function onRequestCamera() {
    let perm = permission;
    if (!perm?.granted) perm = await requestPermission();
    if (!perm?.granted && perm && !perm.canAskAgain) {
      void Linking.openSettings().catch(() => {
        /* user can navigate manually */
      });
    }
  }

  // Scanned the OWNER's vault QR. Briar auto-joins (no separate confirm step):
  // decode → join writes → dial. The camera stays live on a garbage/wrong code,
  // re-armed after a short debounce so it keeps scanning.
  const onBarcodeScanned = useCallback((result: { data?: string }) => {
    if (handledRef.current) return;
    if (!result?.data) return;
    handledRef.current = true;
    const decoded = decodePairQr(result.data);
    if (!decoded.ok) {
      toast.push(pairErrorMessage(decoded.reason), "error");
      setTimeout(() => {
        handledRef.current = false;
      }, 1500);
      return;
    }
    void doJoin(decoded.payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The whole join: local writes (chain-native — no self-admission, no minted
  // credential) then dial + steady sync. Idempotent + non-fatal — steady-sync
  // keeps retrying in the background even if the first dial doesn't land.
  async function doJoin(payload: PairQrPayload) {
    setStep({ kind: "joining", payload });
    try {
      // Chain-native join (M4): every QR carries the owner's trust anchor pubkey
      // (vault_trust_anchor_pubkey). The joiner pins it, then on its first BLE
      // handshake presents an EMPTY proof bundle + the QR's shop_mode_token as
      // the mesh pair_nonce. The OWNER verifies the nonce against a live pair
      // token and EMITS the joiner's admission (vault_member_added +
      // vault_device_added) into the chain. The joiner mints NO credential and
      // does NOT self-admit. A QR without an anchor pubkey can't complete a chain
      // join — refuse it.
      if (!payload.vault_trust_anchor_pubkey) {
        setStep({ kind: "error", message: t("vaultPairScan.error.malformed") });
        return;
      }

      // The joining device's effective account_id. When signed in, that's the
      // real account; otherwise synthesize a stable local sentinel from the
      // device pubkey, matching lib/trust/account-id.ts. NOTE: this is only the
      // joiner's LOCAL mirror identity — the account the OWNER actually binds in
      // the chain is derived owner-side from the PoP-proven pubkey
      // (verifyPeerChain FIX A), never trusted from here.
      const ourAccountId = await getAppMeta("account_id");

      // Make sure the device key is loaded before reading it (an in-memory cache
      // miss leaves getDevicePubkey() null, which would leave the joiner unable
      // to participate in the BLE handshake).
      await ensureDeviceKey();
      const offered = deriveOfferedRole(payload);
      const devicePubkeyB64 = getDevicePubkey();
      if (!devicePubkeyB64) {
        setStep({
          kind: "error",
          message:
            "Couldn't finish pairing — your device key isn't ready. Force-close the app and try again.",
        });
        return;
      }
      const effectiveAccountId = ourAccountId ?? buildLocalAccountId(devicePubkeyB64);

      const db = await getDb();
      await db.withTransactionAsync(async () => {
        const existing = await db.getFirstAsync<{ id: string }>(
          `SELECT id FROM vaults WHERE id = ? LIMIT 1`,
          payload.vault_id,
        );
        const now = Date.now();
        if (!existing) {
          await db.runAsync(
            `INSERT INTO vaults (
               id, name, currency, created_at, updated_at,
               archived_at, is_default, account_id,
               registered_with_server_at, vault_epoch,
               hlc_logical, hlc_wall_ms,
               vault_trust_anchor_pubkey
             ) VALUES (?, ?, 'AFN', ?, ?, NULL, 0, ?, ?, 0, 0, 0, ?)`,
            payload.vault_id,
            payload.vault_name,
            now,
            now,
            // account_id is left null when the scanner is signed out; sign-in
            // later reconciles. registered_with_server_at stays null — the joiner
            // isn't server-registered for this vault (the owner's pushed
            // admission events are how the server learns membership).
            ourAccountId ?? null,
            null,
            payload.vault_trust_anchor_pubkey ?? null,
          );
        } else if (payload.vault_trust_anchor_pubkey) {
          // Backfill the trust anchor on an existing row (idempotent — only
          // writes when the column is currently NULL).
          await db.runAsync(
            `UPDATE vaults
                SET vault_trust_anchor_pubkey = COALESCE(vault_trust_anchor_pubkey, ?)
              WHERE id = ?`,
            payload.vault_trust_anchor_pubkey,
            payload.vault_id,
          );
        }

        // Create the local shop_profile so the home header (which reads
        // getLocalSelf → shop_profile.shop_name) shows the kaata name instead of
        // falling back to the user's display name. Without this, joining a kaata
        // silently leaves shop_profile empty and the header looks broken.
        await db.runAsync(
          `INSERT OR IGNORE INTO shop_profile
             (vault_id, owner_name, shop_name, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?)`,
          payload.vault_id,
          payload.vault_name,
          now,
          now,
        );

        // Create the vault_members_mirror row for self so the Members tab and
        // useVaultRole hook recognize this device as a member. INSERT OR REPLACE
        // so re-joining (e.g. after a re-pair) refreshes the role/accepted_at
        // cleanly.
        await db.runAsync(
          `INSERT OR REPLACE INTO vault_members_mirror
             (vault_id, account_id, role, accepted_at, revoked_at)
           VALUES (?, ?, ?, ?, NULL)`,
          payload.vault_id,
          effectiveAccountId,
          offered.role,
          now,
        );

        // Also add the OWNER (the issuer of this QR) to the mirror so the Members
        // tab shows "Owner: <issuer>" alongside self immediately. Without this
        // row, the joining device only sees itself in the Members list until a
        // mesh handshake propagates the owner's identity. INSERT OR IGNORE keeps
        // this idempotent and additive (doesn't overwrite a later role change
        // applied via mesh events).
        if (payload.issuer_account_id && payload.issuer_account_id !== effectiveAccountId) {
          // Mythos Issue 1: persist the owner's display name from the QR
          // (issuer_display_name, v=3 field) into the display_name column so the
          // Members tab can show the owner's real name instead of the "Owner"
          // role-label fallback.
          await db.runAsync(
            `INSERT OR IGNORE INTO vault_members_mirror
               (vault_id, account_id, role, accepted_at, revoked_at, display_name)
             VALUES (?, ?, 'owner', ?, NULL, ?)`,
            payload.vault_id,
            payload.issuer_account_id,
            now,
            payload.issuer_display_name ?? null,
          );
        }
      });

      // Persist the QR's shop_mode_token locally so the joiner's first BLE
      // handshake echoes it as HelloMessage.pair_nonce. The owner's
      // pair-admission path requires this exact nonce to match a live unconsumed
      // pair token, binding "this handshake came from the QR we just scanned" vs
      // "any stranger in BLE range during the window." The TTL matches the QR's
      // expiry; cleared on the first successful handshake.
      try {
        const localPair = await import("../../lib/mesh/local-pair");
        await localPair.setLocalPairNonceForVault(
          payload.vault_id,
          payload.shop_mode_token,
          payload.expires_at_ms,
        );
      } catch (err) {
        console.warn("[vault/pair-scan] setLocalPairNonceForVault failed", err);
        // Non-fatal: the handshake retries the lookup. If it's missing, the owner
        // refuses the pair handshake loudly until re-paired.
      }

      await setActiveVaultId(payload.vault_id);

      // Dial + sync. The owner claims our pair_nonce (gated on the key they
      // scanned from our top QR) and emits our admission, then streams the ledger
      // delta.
      //
      // BRIAR-STRICT LIVENESS: with the strict gate, our first dial is often
      // refused — the owner may not have finished scanning our identity QR yet,
      // so claimPairNonce defers (expected_joiner_pubkey not yet bound). A
      // refused dial throws INSIDE the handshake, so we never cache the owner's
      // MAC and steady-sync could only re-reach the owner via the slow classic
      // inquiry fallback — a multi-minute stall. So we RE-DIAL the owner's pair
      // listener (still up, dialed directly by issuer_bt_mac → fast) on a short
      // backoff. As soon as the owner's scan binds our key, the next attempt is
      // admitted — within seconds, regardless of who scanned first.
      let syncNote: string | undefined;
      const { joinPairOverBtc } = await import("../../lib/mesh/pair-btc");
      const PAIR_DIAL_ATTEMPTS = 6;
      const PAIR_DIAL_BACKOFF_MS = 5000;
      let paired = false;
      for (let attempt = 0; attempt < PAIR_DIAL_ATTEMPTS && !paired; attempt++) {
        try {
          await joinPairOverBtc({
            vaultId: payload.vault_id,
            pairNonce: payload.shop_mode_token,
            hostMac: payload.issuer_bt_mac ?? null,
            hostName: payload.issuer_bt_name ?? null,
          });
          paired = true;
        } catch (err) {
          syncNote = (err as Error)?.message ?? "first sync did not complete";
          console.warn(
            `[vault/pair-scan] pair dial ${attempt + 1}/${PAIR_DIAL_ATTEMPTS} failed (` +
              `owner may not have scanned yet):`,
            syncNote,
          );
          if (attempt < PAIR_DIAL_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, PAIR_DIAL_BACKOFF_MS));
          }
        }
      }
      // Cleared on success so the "joined" screen shows the clean (not "syncing")
      // copy; left set on exhaustion so steady-sync keeps retrying in the bg.
      if (paired) syncNote = undefined;

      // Start steady-state sync REGARDLESS of the first attempt — the reliable,
      // self-retrying path (inquiry fallback; cached owner MAC). Idempotent.
      await setAppMeta("shop_mode_enabled", "1");
      try {
        const mesh = await import("../../lib/mesh");
        await mesh.startShopMode();
        await mesh.notifyVaultSetChanged();
      } catch (err) {
        console.warn("[vault/pair-scan] could not start steady sync", err);
      }

      // HEAL the owner's first batch within THIS session (no relaunch needed).
      // A couple of delayed catch-up sweeps re-run the role-gate once genesis has
      // applied. Fire-and-forget; idempotent.
      try {
        const { sweepAllQuarantinedVaults } = await import("../../lib/projection/sweep");
        for (const delay of [3000, 8000, 16000]) {
          setTimeout(() => void sweepAllQuarantinedVaults(), delay);
        }
      } catch {
        /* best-effort */
      }

      setStep({
        kind: "joined",
        vault_id: payload.vault_id,
        vault_name: payload.vault_name,
        syncNote,
      });
      toast.push(
        syncNote ? t("vaultPairScan.toast.joinedSyncing") : t("vaultPairScan.toast.pairedNearby"),
        syncNote ? "info" : "success",
      );
    } catch (err) {
      console.warn("[vault/pair-scan] join failed", err);
      // M-BTC-3.2: surface the real reason during this milestone (e.g. the
      // membership-chain verdict) — far more useful than generic copy while the
      // Bluetooth pair flow is being stabilized. TODO: localize once stable.
      const reason = (err as Error)?.message ?? "";
      setStep({
        kind: "error",
        message: reason
          ? `${t("vaultPairScan.error.generic")} (${reason})`
          : t("vaultPairScan.error.generic"),
      });
    }
  }

  function onRescan() {
    handledRef.current = false;
    setStep({ kind: "pairing" });
  }

  function onDone() {
    router.replace("/");
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("vaultPairScan.title")}
        onBack={() => (step.kind === "joined" ? router.replace("/") : router.back())}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      {step.kind === "pairing" ? (
        // Briar-style split: YOUR code (top) + THEIR camera (bottom), both live
        // at once. The owner's screen shows the same kind of split; you each scan
        // the other's code simultaneously.
        <ScrollView contentContainerStyle={styles.splitBody} showsVerticalScrollIndicator={false}>
          <Text style={[styles.splitHint, textDir(isRTL)]}>{t("vaultPair.twoWay.splitHint")}</Text>

          <Text style={[styles.splitLabel, textDir(isRTL)]}>{t("vaultPair.twoWay.yourCode")}</Text>
          <View style={styles.qrCardSm}>
            {identityQr ? (
              <QRCode
                value={identityQr}
                size={170}
                backgroundColor={colors.bgDefault}
                color={colors.textEmphasis}
              />
            ) : (
              <View style={styles.qrPlaceholderSm}>
                <ActivityIndicator color={colors.textMuted} />
                <Text style={[styles.bodyText, { marginTop: 8, textAlign: "center" }]}>
                  {t("vaultPair.generating")}
                </Text>
              </View>
            )}
          </View>

          <Text style={[styles.splitLabel, textDir(isRTL), { marginTop: 18 }]}>
            {t("vaultPair.twoWay.theirCode")}
          </Text>
          <View style={styles.splitCamera}>
            {permission?.granted ? (
              <>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={onBarcodeScanned}
                />
                <View style={styles.scannerReticle} pointerEvents="none" />
              </>
            ) : (
              <View style={styles.cameraOverlay}>
                <Ionicons name="camera-outline" size={40} color={colors.textMuted} />
                <Text style={[styles.bodyText, { textAlign: "center", marginTop: 8 }]}>
                  {t("vaultPair.twoWay.camera.body")}
                </Text>
                <View style={{ height: 10 }} />
                <Button label={t("vaultPair.twoWay.camera.allow")} onPress={onRequestCamera} />
              </View>
            )}
          </View>

          <View style={{ height: 18 }} />
          <Button label={t("common.cancel")} variant="secondary" onPress={() => router.back()} />
        </ScrollView>
      ) : null}

      {step.kind === "joining" ? (
        <View style={styles.body}>
          <ActivityIndicator color={colors.textEmphasis} size="large" />
          <Text style={[styles.bodyText, { marginTop: 16, textAlign: "center" }]}>
            {t("vaultPairScan.joining", { name: step.payload.vault_name })}
          </Text>
        </View>
      ) : null}

      {step.kind === "joined" ? (
        <View style={styles.body}>
          <Ionicons name="checkmark-circle" size={48} color={colors.textEmphasis} />
          <Text style={[styles.headline, textDir(isRTL)]}>
            {t("vaultPairScan.joined.headline")}
            {"\n"}
            <Text style={styles.emph}>{step.vault_name}</Text>
          </Text>
          <Text style={[styles.bodyText, textDir(isRTL)]}>
            {step.syncNote
              ? t("vaultPairScan.joined.body.syncing")
              : t("vaultPairScan.joined.body.local")}
          </Text>
          {step.syncNote ? (
            <Text style={[styles.bodyText, textDir(isRTL), { opacity: 0.55, fontSize: 12 }]}>
              {step.syncNote}
            </Text>
          ) : null}
          <View style={{ height: 24 }} />
          <Button label={t("common.done")} onPress={onDone} />
        </View>
      ) : null}

      {step.kind === "error" ? (
        <View style={styles.body}>
          <Ionicons name="alert-circle" size={40} color={colors.danger} />
          <Text style={[styles.headline, textDir(isRTL)]}>{t("vaultPairScan.error.headline")}</Text>
          <Text style={[styles.bodyText, textDir(isRTL)]}>{step.message}</Text>
          <View style={{ height: 20 }} />
          <Button label={t("common.tryAgain")} onPress={onRescan} />
          <View style={{ height: 10 }} />
          <Button label={t("common.cancel")} variant="secondary" onPress={() => router.back()} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function pairErrorMessage(
  reason: "malformed" | "unsupported_version" | "expired" | "missing_field" | "payload_too_large",
): string {
  switch (reason) {
    case "expired":
      return t("vaultPairScan.error.expired");
    case "unsupported_version":
      return t("vaultPairScan.error.unsupported");
    case "payload_too_large":
    case "malformed":
    case "missing_field":
    default:
      return t("vaultPairScan.error.malformed");
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  body: { padding: 24, alignItems: "center" },
  bodyText: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: 22,
    alignSelf: "stretch",
  },
  headline: {
    marginTop: 14,
    fontSize: 22,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
    lineHeight: 30,
    marginBottom: 12,
  },
  emph: { fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  // Briar split-screen pairing (mirrors apps/mobile/app/vault/pair.tsx).
  splitBody: { padding: 20, alignItems: "center", paddingBottom: 32 },
  splitHint: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
    marginBottom: 14,
    alignSelf: "stretch",
  },
  splitLabel: {
    fontSize: 13,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    alignSelf: "stretch",
    marginBottom: 8,
  },
  qrCardSm: {
    padding: 14,
    backgroundColor: colors.bgDefault,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    alignItems: "center",
    justifyContent: "center",
  },
  qrPlaceholderSm: {
    width: 170,
    height: 170,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgMuted,
    borderRadius: 12,
  },
  splitCamera: {
    width: 240,
    height: 240,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
  cameraOverlay: { alignItems: "center", justifyContent: "center", padding: 16 },
  scannerReticle: {
    position: "absolute",
    top: "12%",
    left: "12%",
    right: "12%",
    aspectRatio: 1,
    borderWidth: 3,
    borderColor: "#fff",
    borderRadius: 16,
    backgroundColor: "transparent",
  },
});
