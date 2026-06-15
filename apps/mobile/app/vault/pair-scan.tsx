// QR pairing, new-device (joiner) side — chain-native (M4).
//
// Mounts the camera (expo-camera), parses the QR, validates it, then:
//   1. Adds the vault row locally with the owner's trust anchor pubkey
//      pinned from the QR (so it appears in the vault picker and the chain
//      handshake can fold membership against it).
//   2. Writes the joiner's own vault_members_mirror row + pins the owner's
//      identity locally so the Members tab and role-gate work immediately.
//   3. Persists the QR's shop_mode_token as the local pair_nonce — the
//      joiner echoes it on its first BLE handshake; the OWNER verifies it
//      against a live pair token and EMITS the joiner's admission events
//      (vault_member_added + vault_device_added) into the chain. The
//      joiner does NOT self-admit and does NOT mint any credential.
//   4. Flips shop_mode_enabled = '1' so mesh starts immediately.

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
 * Returns { role, missing } so the UI can show a small warning when
 * the field was absent (legacy v=1 QR or buggy issuer). Default is
 * "editor" — safer than the legacy implicit "owner".
 */
function deriveOfferedRole(payload: PairQrPayload): { role: PairQrRole; missing: boolean } {
  if (payload.role === "owner" || payload.role === "editor" || payload.role === "viewer") {
    return { role: payload.role, missing: false };
  }
  return { role: "editor", missing: true };
}

function humanizeRoleForUI(role: PairQrRole): string {
  if (role === "owner") return t("vaultPair.role.owner");
  if (role === "editor") return t("vaultPair.role.editor");
  return t("vaultPair.role.viewer");
}

type Step =
  | { kind: "needs_permission" }
  | { kind: "scanning" }
  | { kind: "confirming"; payload: PairQrPayload }
  | { kind: "joining"; payload: PairQrPayload }
  | {
      kind: "joined";
      vault_id: string;
      vault_name: string;
    }
  | { kind: "error"; message: string };

export default function VaultPairScanScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<Step>({ kind: "scanning" });
  // Guard against BarCodeScanner firing the callback multiple times before
  // the camera unmounts. First valid scan wins.
  const handledRef = useRef(false);

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
      setStep({ kind: "error", message: pairErrorMessage(decoded.reason) });
      return;
    }
    setStep({ kind: "confirming", payload: decoded.payload });
  }, []);

  async function onConfirmJoin() {
    if (step.kind !== "confirming") return;
    const payload = step.payload;
    setStep({ kind: "joining", payload });
    try {
      // Chain-native join (M4): every QR carries the owner's trust anchor
      // pubkey (vault_trust_anchor_pubkey). The joiner pins it, then on its
      // first BLE handshake presents an EMPTY proof bundle + the QR's
      // shop_mode_token as the mesh pair_nonce. The OWNER verifies the
      // nonce against a live pair token and EMITS the joiner's admission
      // (vault_member_added + vault_device_added) into the chain. The
      // joiner mints NO credential and does NOT self-admit. A QR without
      // an anchor pubkey can't complete a chain join — refuse it.
      if (!payload.vault_trust_anchor_pubkey) {
        setStep({
          kind: "error",
          message: t("vaultPairScan.error.malformed"),
        });
        return;
      }

      // The joining device's effective account_id. When signed in, that's
      // the real account; otherwise synthesize a stable local sentinel from
      // the device pubkey, matching lib/trust/account-id.ts. NOTE: this is
      // only the joiner's LOCAL mirror identity — the account the OWNER
      // actually binds in the chain is derived owner-side from the
      // PoP-proven pubkey (verifyPeerChain FIX A), never trusted from here.
      const ourAccountId = await getAppMeta("account_id");

      // Make sure the device key is loaded before reading it (same reason
      // as pair.tsx: an in-memory cache miss leaves getDevicePubkey()
      // returning null, which would leave the joiner unable to participate
      // in the BLE handshake).
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
            // account_id is left null when the scanner is signed out;
            // sign-in later reconciles. registered_with_server_at stays
            // null — the joiner isn't server-registered for this vault
            // (the owner's pushed admission events are how the server
            // learns membership).
            ourAccountId ?? null,
            null,
            payload.vault_trust_anchor_pubkey ?? null,
          );
        } else if (payload.vault_trust_anchor_pubkey) {
          // Backfill the trust anchor on an existing row (idempotent
          // — only writes when the column is currently NULL).
          await db.runAsync(
            `UPDATE vaults
                SET vault_trust_anchor_pubkey = COALESCE(vault_trust_anchor_pubkey, ?)
              WHERE id = ?`,
            payload.vault_trust_anchor_pubkey,
            payload.vault_id,
          );
        }

        // Create the local shop_profile so the home header (which reads
        // getLocalSelf → shop_profile.shop_name) shows the kaata name
        // instead of falling back to the user's display name. Without
        // this, joining a kaata silently leaves shop_profile empty and
        // the header looks broken.
        await db.runAsync(
          `INSERT OR IGNORE INTO shop_profile
             (vault_id, owner_name, shop_name, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?)`,
          payload.vault_id,
          payload.vault_name,
          now,
          now,
        );

        // Create the vault_members_mirror row for self so the Members
        // tab and useVaultRole hook recognize this device as a member.
        // INSERT OR REPLACE so re-joining (e.g. after a re-pair) refreshes
        // the role/accepted_at cleanly.
        await db.runAsync(
          `INSERT OR REPLACE INTO vault_members_mirror
             (vault_id, account_id, role, accepted_at, revoked_at)
           VALUES (?, ?, ?, ?, NULL)`,
          payload.vault_id,
          effectiveAccountId,
          offered.role,
          now,
        );

        // Also add the OWNER (the issuer of this QR) to the mirror so the
        // Members tab shows "Owner: <issuer>" alongside self immediately.
        // Without this row, the joining device only sees itself in the
        // Members list until a mesh handshake propagates the owner's
        // identity — which the user may never get to see.
        // INSERT OR IGNORE keeps this idempotent and additive (doesn't
        // overwrite a later role change applied via mesh events).
        if (payload.issuer_account_id && payload.issuer_account_id !== effectiveAccountId) {
          // Mythos Issue 1: persist the owner's display name from the QR
          // (issuer_display_name, v=3 field) into the new display_name
          // column so the Members tab can show the owner's real name
          // instead of the "Owner" role-label fallback.
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

      // CHAIN-NATIVE JOIN (M4): the joiner does NOT emit its own
      // vault_member_added and does NOT mint any credential. The mirror
      // rows above make the joiner's LOCAL UI correct immediately; the
      // OWNER emits the joiner's admission (vault_member_added +
      // vault_device_added, owner-signed) during the BLE handshake
      // (verifyPeerChain's pair path), and those events are what the
      // server learns membership from when they're pushed. A
      // self-admission here would be refused by every peer's role-gate
      // anyway (the joiner is not yet an owner-bound device).

      // Persist the QR's shop_mode_token locally so the joiner's first
      // BLE handshake echoes it as HelloMessage.pair_nonce. The owner's
      // pair-admission path requires this exact nonce to match a live
      // unconsumed pair token, binding "this handshake came from the QR
      // we just generated" vs "any stranger in BLE range during the
      // window." The TTL matches the QR's expiry (see PAIR_QR_TTL_MS);
      // cleared on the first successful handshake.
      try {
        const localPair = await import("../../lib/mesh/local-pair");
        await localPair.setLocalPairNonceForVault(
          payload.vault_id,
          payload.shop_mode_token,
          payload.expires_at_ms,
        );
      } catch (err) {
        console.warn("[vault/pair-scan] setLocalPairNonceForVault failed", err);
        // Non-fatal: the handshake retries the lookup. If it's missing,
        // the owner refuses the pair handshake loudly until re-paired.
      }

      await setActiveVaultId(payload.vault_id);

      // M-BTC-3.2: pair + sync over Bluetooth Classic (RFCOMM). The joiner runs
      // classic inquiry, dials the owner by the UUID derived from the QR's
      // shop_mode_token, and runs the REAL anti-entropy handshake — the owner
      // claims our pair_nonce and emits our admission (vault_member_added +
      // vault_device_added) into the chain, then streams the ledger delta. This
      // replaces the old BLE peripheral path (startShopMode), which never
      // completed a handshake on real hardware. Throws on failure → caught
      // below → retry (the vault row + pair nonce persist, so re-running is
      // idempotent and re-syncs even if the first attempt already admitted us).
      const { joinPairOverBtc } = await import("../../lib/mesh/pair-btc");
      await joinPairOverBtc({
        vaultId: payload.vault_id,
        pairNonce: payload.shop_mode_token,
        hostMac: payload.issuer_bt_mac ?? null,
        hostName: payload.issuer_bt_name ?? null,
      });

      // Persist shop-mode intent only AFTER the rendezvous completes, so
      // MeshController's background poll doesn't bring up other radios that
      // contend with our inquiry/dial on the single Bluetooth adapter mid-pair.
      await setAppMeta("shop_mode_enabled", "1");

      // M-BTC-3.3: start steady-state sync now (inquiry is done, so no radio
      // contention) so future changes propagate without re-scanning the QR. The
      // peer's MAC was cached during the pair, so the dial loop re-syncs every
      // ~30s. Idempotent; non-fatal.
      try {
        const mesh = await import("../../lib/mesh");
        // startShopMode covers the cold-start case; notifyVaultSetChanged covers
        // the case where Shop Mode was ALREADY running for another vault (then
        // startShopMode no-ops) — it refreshes every channel for this new vault.
        await mesh.startShopMode();
        await mesh.notifyVaultSetChanged();
      } catch (err) {
        console.warn("[vault/pair-scan] could not start steady sync", err);
      }

      setStep({
        kind: "joined",
        vault_id: payload.vault_id,
        vault_name: payload.vault_name,
      });
      toast.push(t("vaultPairScan.toast.pairedNearby"), "success");
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
    setStep({ kind: "scanning" });
  }

  function onDone() {
    router.replace("/");
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      {/* Phase 7 coherence: shared ScreenHeader replaces the bespoke
          Cancel/Done text button. When the user has successfully joined
          a vault, we still want a single "back to home" affordance — the
          chevron handles both Cancel (during scanning/confirming) and
          Done (post-join) semantics, with the post-join Pressable
          replaced with a "Done" Button below. */}
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
          {/* After "Don't ask again" the OS suppresses the dialog —
              requestPermission() silently no-ops and the Allow button
              looks broken. Route to system settings instead, the same
              recovery ContactsPickerSheet and MeshController use. */}
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

      {step.kind === "confirming"
        ? (() => {
            // D-PAIR-WITH-ROLE: surface the role the QR is offering so
            // the user can confirm before joining. Legacy v=1 QRs (no
            // role field) fall back to "editor" with a warning row.
            const offered = deriveOfferedRole(step.payload);
            return (
              <View style={styles.body}>
                <Ionicons name="phone-portrait-outline" size={40} color={colors.textEmphasis} />
                <Text style={[styles.headline, textDir(isRTL)]}>
                  {t("vaultPairScan.confirm.prefix")}{" "}
                  <Text style={styles.emph}>{step.payload.vault_name}</Text>?
                </Text>
                <Text style={[styles.bodyText, textDir(isRTL), { marginBottom: 6 }]}>
                  {t("vaultPairScan.confirm.asRole", {
                    role: humanizeRoleForUI(offered.role),
                  })}
                </Text>
                {offered.missing ? (
                  <Text style={[styles.warnText, textDir(isRTL)]}>
                    {t("vaultPairScan.confirm.roleMissing")}
                  </Text>
                ) : null}
                <Text style={[styles.bodyText, textDir(isRTL)]}>
                  {step.payload.vault_trust_anchor_pubkey
                    ? t("vaultPairScan.confirm.body.local")
                    : t("vaultPairScan.confirm.body.server")}
                </Text>
                <View style={{ height: 20 }} />
                <Button label={t("vaultPairScan.confirm.join")} onPress={onConfirmJoin} />
                <View style={{ height: 10 }} />
                <Button
                  label={t("vaultPairScan.confirm.rescan")}
                  variant="secondary"
                  onPress={onRescan}
                />
              </View>
            );
          })()
        : null}

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
  warnText: {
    fontSize: 12,
    fontFamily: fonts.sansSemi,
    color: colors.danger,
    marginBottom: 10,
    alignSelf: "stretch",
    textAlign: "center",
  },
});
