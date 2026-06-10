// Phase 5 — same-account multi-device QR pairing, new-device side.
//
// Mounts the camera (expo-camera), parses the QR, validates it, then:
//   1. Verifies own account_id == payload.issuer_account_id (cross-account
//      pairing via QR is refused — Phase 4 invite flow is the path).
//   2. Adds the vault row locally (so it appears in the vault picker even
//      before /v1/sync/pull populates the canonical fields).
//   3. Calls POST /v1/vaults/:vault_id/credential to fetch our VMC.
//   4. Persists the VMC into vault_credentials.
//   5. Flips shop_mode_enabled = '1' so mesh starts immediately.

import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
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
import { cachePeerVMC, cacheVMC, verifyAndCacheVMC } from "../../lib/mesh/vmc";
import { ensureDeviceKey, getDevicePubkey } from "../../lib/mesh/device-key";
import { buildLocalAccountId, issueLocalVMC } from "../../lib/mesh/local-vmc";
import { getInstallIdSync } from "../../lib/db-tx";
import { issueVaultCredential } from "../../lib/vault-api";

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
      /**
       * True when the QR's vault_trust_anchor_pubkey was present, i.e.
       * the scanner installed a local-CA vault. Drives copy on the
       * success screen so we don't promise wifi-sync on a BLE-primary
       * local-anchored pair.
       */
      isLocalCA: boolean;
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
      // Phase 7 local-CA path: if the QR carries
      // vault_trust_anchor_pubkey, the owner's device will sign the
      // VMC directly (no server roundtrip, no Google sign-in required).
      // The actual VMC delivery over the mesh handshake is wired in a
      // follow-up phase (Phase 6.1 — BLE peripheral). Until then we
      // record the local-CA intent: persist the vault row with the
      // trust anchor populated and the QR's vault_name. The mesh
      // handshake will then verify the eventually-received VMC against
      // this anchor instead of the pinned server pubkey.
      const isLocalCA = Boolean(payload.vault_trust_anchor_pubkey);

      // Phase 5 server-anchor path retains the account-match guard so
      // a server-issued VMC is only mintable for the issuer's account.
      // Local-CA path skips this check — the owner's device is the
      // root of trust.
      const ourAccountId = await getAppMeta("account_id");
      if (!isLocalCA) {
        if (!ourAccountId) {
          setStep({
            kind: "error",
            message: t("vaultPairScan.error.signInRequired"),
          });
          return;
        }
        if (ourAccountId !== payload.issuer_account_id) {
          setStep({
            kind: "error",
            message: t("vaultPairScan.error.accountMismatch"),
          });
          return;
        }
      }

      // Local vault row. The server's /v1/sync/pull will reconcile the
      // canonical fields when signed in; for local-only vaults this is
      // the canonical row.
      // Make sure the device key is loaded before reading it (same
      // reason as pair.tsx: an in-memory cache miss leaves
      // getDevicePubkey() returning null, which then skips both the
      // joiner-self-VMC issuance AND the owner identity pin — silently
      // leaving the joiner unable to participate in BLE handshake.
      await ensureDeviceKey();
      // Compute the role + the joining device's effective account_id.
      // For local-CA when not signed in, synthesize a stable local ID
      // from the device pubkey, matching the convention local-vmc.ts uses.
      const offered = deriveOfferedRole(payload);
      const devicePubkeyB64 = getDevicePubkey();
      const effectiveAccountId =
        ourAccountId ??
        (devicePubkeyB64
          ? buildLocalAccountId(devicePubkeyB64)
          : `local:${getInstallIdSync().slice(0, 16)}`);

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
            // For server-anchored pair we set account_id immediately
            // (issueVaultCredential will INSERT vault_members on the
            // server next). For local-CA pair we leave account_id null
            // when the scanner is signed-out; sign-in later reconciles.
            isLocalCA ? (ourAccountId ?? null) : ourAccountId,
            isLocalCA ? null : now,
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
          await db.runAsync(
            `INSERT OR IGNORE INTO vault_members_mirror
               (vault_id, account_id, role, accepted_at, revoked_at)
             VALUES (?, ?, 'owner', ?, NULL)`,
            payload.vault_id,
            payload.issuer_account_id,
            now,
          );
        }
      });

      // Emit a vault_member_added event for self into the event log so
      // mesh anti-entropy propagates this membership to the owner (and
      // any other peers) on the next handshake. The mirror row above
      // makes our local UI correct; this event makes the OWNER's UI also
      // show the new member once they sync.
      try {
        const eventLog = await import("../../lib/event-log");
        await eventLog.appendVaultMemberAdded({
          targetVaultId: payload.vault_id,
          accountId: effectiveAccountId,
          role: offered.role,
        });
      } catch (err) {
        console.warn("[vault/pair-scan] appendVaultMemberAdded failed", err);
        // Non-fatal — the mirror row is already written; the event will
        // get re-emitted next time the user explicitly toggles role or
        // re-joins. We don't want to abort the whole join over this.
      }

      if (isLocalCA) {
        // v0.5.3 BRIAR-STYLE BIDIRECTIONAL PAIR (this is the change that
        // makes local-CA mesh actually WORK without Google sign-in).
        //
        // Two new pieces are wired here, both keyed to the v=3 QR fields
        // (issuer_device_pubkey + issuer_display_name):
        //
        // (1) JOINER SELF-VMC. The joiner generates their own VMC signed
        //     with their own device key (the same issueLocalVMC primitive
        //     the owner uses at vault creation). They cache it via the
        //     standard cacheVMC. When the joiner initiates a BLE
        //     handshake, the OWNER receives this self-signed VMC and
        //     verifies it against the joiner's pinned device_pubkey via
        //     verifyVMCAgainstPinnedPeer (vmc.ts). No
        //     pair_claim/pair_grant wire needed.
        //
        // (2) PIN THE OWNER. v=3 QRs carry issuer_device_pubkey — we
        //     write a vault_credentials row for the owner using the
        //     existing cachePeerVMC primitive (with the owner's vmc_blob
        //     left empty as a placeholder; the BLE handshake will fill
        //     it in via cachePeerVMC when the owner actually connects).
        //     This is what role-gate.lookupSignerCredential needs to
        //     find when the owner's events arrive over the mesh.
        //
        // Combined effect: BOTH sides have each other pinned, both can
        // verify each other's events at role-gate AND BLE handshake,
        // privacy is preserved (only the peer whose QR we scanned can
        // pass either gate), and we don't need a separate peer_identities
        // table — vault_credentials does the job.
        const installId = getInstallIdSync();
        const myDevicePubkey = getDevicePubkey();
        // BUG-M: fail-loud on self-VMC issuance. Without a self-VMC
        // we have NOTHING to send in the BLE handshake hello — mesh
        // sync silently does nothing while the UI says "paired".
        // Previously this swallowed the error with console.warn and
        // pushed the user to the joined screen anyway. Now we surface
        // the failure as an error step so the user knows to retry.
        if (!myDevicePubkey || !payload.vault_trust_anchor_pubkey) {
          setStep({
            kind: "error",
            message:
              "Couldn't finish pairing — your device key isn't ready. Force-close the app and try again.",
          });
          return;
        }
        try {
          const { blob, expiresAtMs } = await issueLocalVMC({
            vaultId: payload.vault_id,
            peerAccountId: effectiveAccountId,
            peerDeviceId: installId,
            peerDevicePubkey: myDevicePubkey,
            role: offered.role,
            vaultEpoch: 0,
          });
          await cacheVMC(
            payload.vault_id,
            blob,
            expiresAtMs,
            effectiveAccountId,
            myDevicePubkey,
            0,
          );
        } catch (err) {
          console.warn("[vault/pair-scan] self-VMC issue failed", err);
          setStep({
            kind: "error",
            message:
              "Couldn't create your sync credential — please try pairing again. If this keeps happening, force-close Kaata and retry.",
          });
          return;
        }
        // BUG-O: we used to pre-pin the owner's identity into
        // vault_credentials with peerVmcBlob: "" as a placeholder.
        // That broke role-gate's extractRoleFromVmcBlob (which returns
        // null for empty blobs) AND made the row look "real" to
        // lookupSignerCredential for ~1 year. The BLE handshake's
        // cachePeerVMC at anti-entropy.ts:863 writes the real blob with
        // the correct expiry on first connect — that's the only path
        // that should populate vault_credentials. The Members tab is
        // already populated via vault_members_mirror (written above)
        // so dropping the placeholder is purely a clean-up of dead
        // weight.

        await setAppMeta("shop_mode_enabled", "1");
        await setActiveVaultId(payload.vault_id);

        // BUG-A: tell mesh the vault set just changed so BLE discovery
        // can match this vault's hash AND so our advertiser includes it
        // in the rotation. Without this notify, the just-joined vault
        // is invisible to mesh until the user toggles Nearby sync off
        // and on again — the exact "I paired but nothing syncs"
        // symptom users were reporting. No-op when mesh isn't running.
        try {
          const mesh = await import("../../lib/mesh");
          await mesh.notifyVaultSetChanged();
        } catch (err) {
          console.warn("[vault/pair-scan] notifyVaultSetChanged failed", err);
        }

        setStep({
          kind: "joined",
          vault_id: payload.vault_id,
          vault_name: payload.vault_name,
          isLocalCA: true,
        });
        toast.push(t("vaultPairScan.toast.pairedNearby"), "success");
        return;
      }

      // Phase 5 server-anchor path: fetch our VMC. The new-device
      // flow forwards the QR's shop_mode_token + issued_at_ms so the
      // backend can consume the single-use token, reject scanner-
      // clock rollback, and INSERT a vault_members row before
      // minting the VMC.
      const issued = await issueVaultCredential(payload.vault_id, {
        pair_token: payload.shop_mode_token,
        pair_issued_at_ms: payload.issued_at_ms,
      });

      // Verify against the pinned server pubkey (default path — no
      // trust anchor passed) and persist. verifyAndCacheVMC populates
      // device_pubkey + vault_epoch from the parsed blob.
      await verifyAndCacheVMC(payload.vault_id, issued.vmc_blob);

      // Auto-enable Shop Mode + switch active vault.
      await setAppMeta("shop_mode_enabled", "1");
      await setActiveVaultId(payload.vault_id);

      setStep({
        kind: "joined",
        vault_id: payload.vault_id,
        vault_name: payload.vault_name,
        isLocalCA: false,
      });
      toast.push(t("vaultPairScan.toast.pairedNearby"), "success");
    } catch (err) {
      console.warn("[vault/pair-scan] join failed", err);
      setStep({
        kind: "error",
        message: err instanceof Error ? err.message : t("vaultPairScan.error.generic"),
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
          <Button label={t("vaultPairScan.permission.allow")} onPress={() => requestPermission()} />
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
            {step.isLocalCA
              ? t("vaultPairScan.joined.body.local")
              : t("vaultPairScan.joined.body.server")}
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
