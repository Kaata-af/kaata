// QR pairing, new-device (joiner) side — chain-native (M4). ONE-WAY scan: the
// joiner scans the HOST's code and joins. No reciprocal owner-scan — the owner
// just shows its code and hosts; admission is on the QR's pair nonce (the owner
// shows it in person for a short window). First contact is fast: the joiner
// dials the host directly by the MAC in the QR and is admitted on its first
// successful handshake.
//
// On scanning the host's QR we PREP locally (no "joined" yet):
//   1. Add the vault row with the owner's trust anchor pubkey pinned (the chain
//      handshake folds membership against it; loadVaultTrustAnchor needs the row
//      BEFORE we dial, so this can't be deferred).
//   2. Write the joiner's own vault_members_mirror row + pin the owner as member
//      so the Members tab + role-gate render correctly once sync lands.
//   3. Persist the QR's shop_mode_token as the local pair_nonce — the joiner
//      echoes it on its handshake; the OWNER matches it to a live pair token and
//      EMITS the joiner's admission into the chain. We mint NO credential.
// Then we dial the host. "Joined" — and shop_mode_enabled = '1' — is set ONLY on
// a real successful handshake, never from the local prep alone, so the UI can't
// claim success for a join that never synced.

import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { setActiveVaultId } from "../../lib/db-tx";
import { getAppMeta, getDb, setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { decodePairQr, type PairQrPayload, type PairQrRole } from "../../lib/mesh/pair-qr";
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
  | { kind: "needs_permission" }
  | { kind: "scanning" }
  // Scanned + prepped; dialing the host. NOT joined until the handshake lands.
  | { kind: "connecting"; payload: PairQrPayload }
  // Dial window elapsed without a successful handshake (host code stopped
  // showing, or out of Bluetooth range). NOT joined — offer a retry.
  | { kind: "awaiting"; payload: PairQrPayload; lastError?: string }
  // Reached ONLY on a real successful handshake (sync happened).
  | { kind: "joined"; vault_id: string; vault_name: string }
  | { kind: "error"; message: string };

// One-way: the host is hosting + discoverable, so the first direct-MAC dial is
// admitted right away. Tight backoff for the rare transport hiccup; bounded so a
// host that walked away doesn't spin forever.
const PAIR_DIAL_BACKOFF_MS = 1500;
const PAIR_DIAL_DEADLINE_MS = 60_000;

export default function VaultPairScanScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<Step>({ kind: "scanning" });
  // Guard against BarCodeScanner firing the callback multiple times before the
  // camera unmounts. First valid scan wins; a garbage code re-arms it.
  const handledRef = useRef(false);
  // Guards setStep after async awaits so a backed-out screen doesn't update
  // state; bumped epoch cancels an in-flight dial loop (unmount OR Retry).
  const mountedRef = useRef(true);
  const dialEpochRef = useRef(0);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      dialEpochRef.current++;
    };
  }, []);

  useEffect(() => {
    if (permission && !permission.granted) {
      setStep({ kind: "needs_permission" });
    } else if (permission?.granted) {
      setStep({ kind: "scanning" });
      handledRef.current = false;
    }
  }, [permission]);

  const onBarcodeScanned = useCallback((result: { data?: string }) => {
    if (handledRef.current) return;
    if (!result?.data) return;
    handledRef.current = true;
    const decoded = decodePairQr(result.data);
    if (!decoded.ok) {
      // Keep the camera live on a garbage/wrong code — toast + re-arm.
      toast.push(pairErrorMessage(decoded.reason), "error");
      setTimeout(() => {
        handledRef.current = false;
      }, 1500);
      return;
    }
    void doJoin(decoded.payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prep the local vault rows (the handshake needs them) then dial. Chain-native:
  // no self-admission, no minted credential.
  async function doJoin(payload: PairQrPayload) {
    setStep({ kind: "connecting", payload });
    try {
      // Chain-native join (M4): every QR carries the owner's trust anchor pubkey
      // (vault_trust_anchor_pubkey). The joiner pins it, then on its handshake
      // presents an EMPTY proof bundle + the QR's shop_mode_token as the mesh
      // pair_nonce. The OWNER matches the nonce to a live pair token and EMITS
      // the joiner's admission into the chain. A QR without an anchor pubkey
      // can't complete a chain join — refuse it.
      if (!payload.vault_trust_anchor_pubkey) {
        setStep({ kind: "error", message: t("vaultPairScan.error.malformed") });
        return;
      }

      // The joining device's effective account_id. When signed in, that's the
      // real account; otherwise synthesize a stable local sentinel from the
      // device pubkey, matching lib/trust/account-id.ts. NOTE: this is only the
      // joiner's LOCAL mirror identity — the account the OWNER actually binds in
      // the chain is derived owner-side from the PoP-proven pubkey, never trusted
      // from here.
      const ourAccountId = await getAppMeta("account_id");

      // Make sure the device key is loaded before reading it (an in-memory cache
      // miss leaves getDevicePubkey() null, which would leave the joiner unable
      // to participate in the handshake).
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

      // Persist the QR's shop_mode_token locally so the joiner's handshake echoes
      // it as HelloMessage.pair_nonce. The owner's pair-admission requires this
      // exact nonce to match a live unconsumed pair token. The TTL matches the
      // QR's expiry; cleared on the first successful handshake.
      try {
        const localPair = await import("../../lib/mesh/local-pair");
        await localPair.setLocalPairNonceForVault(
          payload.vault_id,
          payload.shop_mode_token,
          payload.expires_at_ms,
        );
      } catch (err) {
        console.warn("[vault/pair-scan] setLocalPairNonceForVault failed", err);
        // Non-fatal: the handshake retries the lookup.
      }

      await setActiveVaultId(payload.vault_id);

      if (!mountedRef.current) return;
      void runDialLoop(payload);
    } catch (err) {
      console.warn("[vault/pair-scan] join prep failed", err);
      // M-BTC-3.2: surface the real reason during this milestone (e.g. the
      // membership-chain verdict) — far more useful than generic copy while the
      // Bluetooth pair flow is being stabilized. TODO: localize once stable.
      const reason = (err as Error)?.message ?? "";
      if (!mountedRef.current) return;
      setStep({
        kind: "error",
        message: reason
          ? `${t("vaultPairScan.error.generic")} (${reason})`
          : t("vaultPairScan.error.generic"),
      });
    }
  }

  // Dial the host until the handshake succeeds. One-way: the host admits on the
  // pair nonce, so the first successful dial is admitted — this loop only exists
  // to ride out transport hiccups. The ONLY path to "joined": a refused/failed
  // dial never reports success, so the UI can't claim a join that didn't sync.
  async function runDialLoop(payload: PairQrPayload) {
    const myEpoch = ++dialEpochRef.current;
    const { joinPairOverBtc } = await import("../../lib/mesh/pair-btc");
    const deadline = Date.now() + PAIR_DIAL_DEADLINE_MS;
    let lastError: string | undefined;
    while (Date.now() < deadline) {
      if (dialEpochRef.current !== myEpoch || !mountedRef.current) return;
      try {
        await joinPairOverBtc({
          vaultId: payload.vault_id,
          pairNonce: payload.shop_mode_token,
          hostMac: payload.issuer_bt_mac ?? null,
          hostName: payload.issuer_bt_name ?? null,
        });
        if (dialEpochRef.current !== myEpoch || !mountedRef.current) return;
        await onPairSucceeded(payload);
        return;
      } catch (err) {
        lastError = (err as Error)?.message ?? "first sync did not complete";
        console.warn("[vault/pair-scan] pair dial failed:", lastError);
        await new Promise((r) => setTimeout(r, PAIR_DIAL_BACKOFF_MS));
      }
    }
    if (dialEpochRef.current !== myEpoch || !mountedRef.current) return;
    setStep({ kind: "awaiting", payload, lastError });
  }

  // Real pairing success. Turn on steady-state sync + schedule catch-up sweeps to
  // heal the first batch, then declare "joined". Idempotent.
  async function onPairSucceeded(payload: PairQrPayload) {
    await setAppMeta("shop_mode_enabled", "1");
    try {
      const mesh = await import("../../lib/mesh");
      await mesh.startShopMode();
      await mesh.notifyVaultSetChanged();
    } catch (err) {
      console.warn("[vault/pair-scan] could not start steady sync", err);
    }
    try {
      const { sweepAllQuarantinedVaults } = await import("../../lib/projection/sweep");
      for (const delay of [3000, 8000, 16000]) {
        setTimeout(() => void sweepAllQuarantinedVaults(), delay);
      }
    } catch {
      /* best-effort */
    }
    if (!mountedRef.current) return;
    setStep({ kind: "joined", vault_id: payload.vault_id, vault_name: payload.vault_name });
    toast.push(t("vaultPairScan.toast.pairedNearby"), "success");
  }

  function onRetryConnect(payload: PairQrPayload) {
    setStep({ kind: "connecting", payload });
    void runDialLoop(payload);
  }

  function onRescan() {
    handledRef.current = false;
    setStep({ kind: "scanning" });
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

      {step.kind === "needs_permission" ? (
        <View style={styles.body}>
          <Text style={[styles.headline, textDir(isRTL)]}>
            {t("vaultPairScan.permission.headline")}
          </Text>
          <Text style={[styles.bodyText, textDir(isRTL)]}>
            {t("vaultPairScan.permission.body")}
          </Text>
          <View style={{ height: 20 }} />
          {permission && !permission.canAskAgain ? (
            <Button
              label={t("contacts.permission.button")}
              onPress={() =>
                void Linking.openSettings().catch(() => {
                  /* user can navigate manually */
                })
              }
            />
          ) : (
            <Button
              label={t("vaultPairScan.permission.allow")}
              onPress={() => requestPermission()}
            />
          )}
        </View>
      ) : null}

      {step.kind === "scanning" ? (
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={onBarcodeScanned}
          />
          <View style={styles.scannerReticle} pointerEvents="none" />
          <View style={styles.scannerHint} pointerEvents="none">
            <Text style={styles.scannerHintText}>{t("vaultPairScan.scanning.hint")}</Text>
          </View>
        </View>
      ) : null}

      {step.kind === "connecting" ? (
        <View style={styles.body}>
          <ActivityIndicator color={colors.textEmphasis} size="large" />
          <Text style={[styles.bodyText, { marginTop: 16, textAlign: "center" }]}>
            {t("vaultPairScan.joining", { name: step.payload.vault_name })}
          </Text>
        </View>
      ) : null}

      {step.kind === "awaiting" ? (
        <View style={styles.body}>
          <Ionicons name="bluetooth-outline" size={40} color={colors.textMuted} />
          <Text style={[styles.headline, textDir(isRTL)]}>
            {t("vaultPairScan.awaiting.hostHeadline")}
          </Text>
          <Text style={[styles.bodyText, textDir(isRTL), { textAlign: "center" }]}>
            {t("vaultPairScan.awaiting.hostBody")}
          </Text>
          {step.lastError ? (
            <Text
              style={[
                styles.bodyText,
                textDir(isRTL),
                { opacity: 0.5, fontSize: 12, marginTop: 10, textAlign: "center" },
              ]}
            >
              {step.lastError}
            </Text>
          ) : null}
          <View style={{ height: 20 }} />
          <Button label={t("common.tryAgain")} onPress={() => onRetryConnect(step.payload)} />
          <View style={{ height: 10 }} />
          <Button
            label={t("vaultPairScan.confirm.rescan")}
            variant="secondary"
            onPress={onRescan}
          />
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
            {t("vaultPairScan.joined.body.local")}
          </Text>
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
  cameraWrap: { flex: 1, backgroundColor: "#000" },
  scannerReticle: {
    position: "absolute",
    top: "25%",
    left: "12%",
    right: "12%",
    aspectRatio: 1,
    borderWidth: 3,
    borderColor: "#fff",
    borderRadius: 16,
    backgroundColor: "transparent",
  },
  scannerHint: {
    position: "absolute",
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 24,
  },
  scannerHintText: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: "#fff",
    textAlign: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
});
