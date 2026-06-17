// Phase 5 — same-account multi-device QR pairing, owner side.
//
// Owner opens this screen from vault/settings.tsx "Add a phone" (owner-only).
// Renders a QR encoding {vault_id, vault_name, issuer_account_id,
// issuer_install_id, issued_at_ms, expires_at_ms, shop_mode_token} that
// expires after 5 minutes.
//
// IMPORTANT: this flow is for adding *another device of the same Google
// account*. Cross-account invites still go through vault/invite.tsx (the
// Phase 4 email-anchored token flow).

import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import QRCode from "react-native-qrcode-svg";
import { Button } from "../../components/Button";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getActiveVaultId, getInstallIdSync } from "../../lib/db-tx";
import { getAppMeta, getDb, setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import {
  decodeJoinerIdentityQr,
  encodePairQr,
  PAIR_QR_TTL_MS,
  PAIR_QR_VERSION,
  type PairQrPayload,
  type PairQrRole,
} from "../../lib/mesh/pair-qr";
import { ensureDeviceKey, getDevicePubkey } from "../../lib/mesh/device-key";
import { generatePairToken } from "../../lib/mesh/local-pair";
import { buildLocalAccountId } from "../../lib/trust/account-id";
import { getLocalSelf } from "../../lib/db";
import { hostPairOverBtc, type HostPairHandle } from "../../lib/mesh/pair-btc";
import { getLocalName, getLocalAddress } from "../../modules/kaata-bt-classic";

type VaultLite = {
  id: string;
  name: string;
  vault_trust_anchor_pubkey: string | null;
};

export default function VaultPairScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();

  const [loaded, setLoaded] = useState(false);
  const [vault, setVault] = useState<VaultLite | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  /**
   * D-PAIR-WITH-ROLE: 2-step UI. "pick-role" shows the role chips and
   * defers QR generation; "show-qr" renders the QR with the committed
   * role. "Generate a new code" returns to "pick-role" so the owner
   * can choose a fresh role on re-issue.
   */
  const [stage, setStage] = useState<"pick-role" | "show-qr">("pick-role");
  const [role, setRole] = useState<PairQrRole>("editor");
  const [payload, setPayload] = useState<PairQrPayload | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(Math.floor(PAIR_QR_TTL_MS / 1000));
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Synchronous re-entry guard — issueQr hits the network for server-
  // anchored vaults; repeated taps would register multiple pair tokens.
  const issuingRef = useRef(false);
  // M-BTC-3.2: the live RFCOMM pair listener (owner side). Torn down on
  // unmount, QR expiry, and re-issue so the server + discoverable window don't
  // linger past the pair token they belong to.
  const pairHostRef = useRef<HostPairHandle | null>(null);
  // BRIAR-STRICT two-way scan (owner side): after showing the QR, the owner
  // scans the JOINER's identity QR to pin their key. "scanning" mounts the
  // camera; "bound" confirms the joiner is pinned + can be admitted.
  const [scanMode, setScanMode] = useState<"idle" | "bound">("idle");
  const [boundName, setBoundName] = useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  // Dedupe the barcode callback (fires repeatedly until the camera unmounts).
  const ownerScanHandledRef = useRef(false);

  const issueQr = useCallback(
    async (v: VaultLite, accId: string | null, chosenRole: PairQrRole): Promise<string | null> => {
      try {
        // Atomic: generatePairToken mints the nonce AND persists the pending
        // token in ONE SQLite transaction (local-pair.mutatePendingTokens), so
        // pending_pair_tokens has a SINGLE race-free writer. Previously this file
        // minted the nonce and wrote the token via a separate non-atomic
        // read-modify-write on the same key, which could lose-update a concurrent
        // claim/release/consume (mutatePendingTokens exists to prevent exactly
        // that). bindExpectedJoiner/claimPairNonce later mutate this same token.
        const { nonce: token, expires_at_ms: expires } = await generatePairToken(v.id, chosenRole);
        const now = Date.now();
        // In local-only mode (no Google sign-in — the offline-shopkeeper
        // path) accId is null, but the QR schema requires a non-empty
        // issuer_account_id. Synthesize a stable local ID from the device
        // pubkey, matching the convention lib/trust/account-id.ts uses for
        // chain emission. Without this, the scanner rejects the QR as
        // "malformed" and the shopkeeper can never add staff offline.
        // Make sure the device key is loaded BEFORE we read it. The
        // getDevicePubkey() helper reads an in-memory cache that's
        // populated by ensureDeviceKey(); if a screen transition or
        // process reload skipped that warmup, the cache is null and
        // we'd emit a v=3 QR with issuer_device_pubkey=undefined,
        // which the decoder correctly rejects as "missing_field" →
        // "Couldn't read this code" on the scanner side. Awaiting
        // ensureDeviceKey() here is idempotent and cheap (single
        // SecureStore read after first call).
        await ensureDeviceKey();
        const devicePubkey = getDevicePubkey();
        const localIssuerId = devicePubkey
          ? buildLocalAccountId(devicePubkey)
          : `local:${getInstallIdSync().slice(0, 16)}`;
        // v=3 (Briar-style bidirectional pair): include the OWNER's
        // identity in the QR so the scanner can pin
        // (vault_trust_anchor_pubkey, display_name) without waiting for the
        // BLE handshake. The joiner presents an empty proof bundle + this
        // QR's shop_mode_token as the mesh pair_nonce; the owner verifies
        // it against the chain and emits the joiner's admission. Display
        // name is for the Members tab (renders "Matee" instead of
        // "local:abc…").
        const self = await getLocalSelf();
        const ownerDisplayName = (self?.name ?? "").trim() || "Owner";
        // M-BTC-3.2: the owner's Bluetooth adapter name lets the scanner target
        // this device first during classic inquiry (vs blind-dialing every
        // nearby phone by the derived RFCOMM UUID). Best-effort; Android-only
        // and may be null (no name set / permission) — omitted from the QR then.
        const btName = await getLocalName().catch(() => null);
        // The owner's REAL Bluetooth MAC, when obtainable, lets the scanner dial
        // this device DIRECTLY (no inquiry, no name match) — the reliable Briar
        // path. Null on devices that hide it; the scanner then falls back to
        // inquiry-by-UUID. Best-effort; omitted from the QR when null.
        const btMac = await getLocalAddress().catch(() => null);
        // Schema version selection. The chain pair path REQUIRES the
        // owner's trust anchor pubkey in the QR (the joiner pins it). We
        // got the device pubkey above, so ship v=3 with the bidirectional
        // pair fields. If we somehow STILL don't have one (ensureDeviceKey
        // failed — extremely rare; the only realistic failure is the
        // SecureStore being wiped mid-process), fall back to v=2 so the QR
        // is at least a parseable payload rather than breaking the flow
        // with "Couldn't read this code" — but a v=2 QR can't complete a
        // chain join (no anchor to pin), so the user must re-issue once
        // the key is available.
        const qrVersion: 2 | 3 = devicePubkey ? 3 : 2;
        const next: PairQrPayload = {
          v: qrVersion,
          vault_id: v.id,
          vault_name: v.name,
          issuer_account_id: accId ?? localIssuerId,
          issuer_install_id: getInstallIdSync(),
          issued_at_ms: now,
          expires_at_ms: expires,
          shop_mode_token: token,
          // Owner's trust anchor pubkey — the joiner pins it from the QR
          // (TOFU) and the chain handshake folds the membership proof
          // against it. Every vault is chain-anchored (M4), so this is
          // always populated.
          vault_trust_anchor_pubkey: v.vault_trust_anchor_pubkey ?? undefined,
          // D-PAIR-WITH-ROLE: the role the owner commits at QR-issue time.
          // The owner's pair-admission emission (verifyPeerChain) carries
          // it into the joiner's vault_member_added.
          role: chosenRole,
          // v=3: bidirectional pair fields. Only set when devicePubkey
          // is non-null AND we're emitting v=3.
          ...(qrVersion === 3 && devicePubkey
            ? {
                issuer_device_pubkey: devicePubkey,
                issuer_display_name: ownerDisplayName,
                // Additive RFCOMM hint (M-BTC-3.2); omitted when null.
                ...(btName ? { issuer_bt_name: btName } : {}),
                ...(btMac ? { issuer_bt_mac: btMac } : {}),
              }
            : {}),
        };
        // (Token already persisted atomically by generatePairToken above — the
        // owner's pair-admission lookup reads it via local-pair's canonical
        // store; bindExpectedJoiner pins the scanned joiner key onto it.)
        setPayload(next);
        setSecondsLeft(Math.floor(PAIR_QR_TTL_MS / 1000));
        setError(null);
        return token;
      } catch (err) {
        // Localized copy only — the raw err.message is HTTP jargon
        // ("POST /v1/...: 500 — …") that means nothing to a shopkeeper.
        console.warn("[vault/pair] issue failed", err);
        setError(t("vaultPair.issueFailed"));
        return null;
      }
    },
    [],
  );

  // Tear down the RFCOMM pair listener + discoverable window (idempotent).
  // Declared before the teardown effects below that reference it.
  const stopHosting = useCallback(async () => {
    const h = pairHostRef.current;
    pairHostRef.current = null;
    if (h) {
      try {
        await h.stop();
      } catch {
        /* */
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const activeVaultId = await getActiveVaultId();
        if (!activeVaultId) {
          toast.push(t("vaultPair.noActiveKaata"), "error");
          router.back();
          return;
        }
        const db = await getDb();
        const row = await db.getFirstAsync<VaultLite>(
          `SELECT id, name, vault_trust_anchor_pubkey
             FROM vaults WHERE id = ? LIMIT 1`,
          activeVaultId,
        );
        if (!row) {
          toast.push(t("vaultPair.vaultNotFound"), "error");
          router.back();
          return;
        }
        const accId = await getAppMeta("account_id");
        // Phase 7: account_id is NOT required for local-CA vaults — the
        // owner's device signs the VMC directly. Block the flow only
        // when this is a server-anchored vault AND the user is signed
        // out (in which case the scanner would need the server path).
        if (!accId && !row.vault_trust_anchor_pubkey) {
          toast.push(t("vaultPair.signInFirst"), "error");
          router.back();
          return;
        }
        setVault(row);
        setAccountId(accId);
        // D-PAIR-WITH-ROLE: do NOT auto-issue. The owner must pick a
        // role first. Stage stays "pick-role" until they confirm.
      } catch (err) {
        console.warn("[vault/pair] bootstrap failed", err);
        toast.push(t("vaultPair.loadFailed"), "error");
        // Leave — loaded=true with vault=null would strand the user on a
        // header-less "Loading…" screen with no back affordance.
        router.back();
      } finally {
        setLoaded(true);
      }
    })();
    // single-bootstrap on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1-second countdown. Pauses on background to save CPU.
  useEffect(() => {
    if (!payload) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((payload.expires_at_ms - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    tick();
    tickRef.current = setInterval(tick, 1000);
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active" && tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      } else if (next === "active" && !tickRef.current) {
        tickRef.current = setInterval(tick, 1000);
      }
    });
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      sub.remove();
    };
  }, [payload]);

  // M-BTC-3.2: tear down the RFCOMM pair listener when the QR expires (the
  // token is dead, so the UUID should stop answering) and on screen unmount.
  useEffect(() => {
    if (payload && secondsLeft <= 0) {
      void stopHosting();
      // The split-screen camera slot renders the "expired" overlay itself once
      // secondsLeft hits 0, so no scanMode change is needed (a BOUND token stays
      // terminal — the joiner may already be admitted).
    }
  }, [payload, secondsLeft, stopHosting]);

  useEffect(() => {
    return () => {
      void stopHosting();
    };
  }, [stopHosting]);

  async function onReissue() {
    // D-PAIR-WITH-ROLE: send the owner back to the role picker on re-
    // issue so they can change their mind. Previously this re-used the
    // committed role silently, which was surprising once the role
    // picker existed (the owner expected a fresh decision point).
    if (!vault) return;
    await stopHosting(); // the old token's RFCOMM UUID is about to be replaced
    setPayload(null);
    setStage("pick-role");
    // A fresh nonce means any prior joiner-key binding is moot — reset the scan.
    setScanMode("idle");
    setBoundName(null);
  }

  // M-BTC-3.2: host the pair window over Bluetooth Classic (RFCOMM). The owner
  // listens on the UUID derived from THIS QR's shop_mode_token + goes
  // discoverable; the joiner dials it and runs the real chain handshake, which
  // claims the pair nonce and emits the joiner's admission. This replaces the
  // old BLE peripheral/GATT bringup (startShopMode) — Bluetooth Classic is the
  // only proximity transport that works on the target hardware.
  async function hostPairing(vaultId: string, pairNonce: string): Promise<void> {
    try {
      await stopHosting(); // drop any prior listener (e.g. on re-issue)
      // ATOMICITY: record shop-mode intent as soon as we start hosting, NOT only
      // on a fully-successful pair session (onResult ok). If the first session
      // drops mid-sync, steady-sync must still run once the owner leaves this
      // pair screen (the pause releases) so it re-syncs the just-pinned joiner —
      // otherwise the owner ends up with the member shown but no ongoing sync.
      await setAppMeta("shop_mode_enabled", "1");
      const handle = await hostPairOverBtc({
        vaultId,
        pairNonce,
        onResult: (o) => {
          if (o.ok) {
            toast.push(t("vaultPair.toast.paired"), "success");
            // M-BTC-3.3: bring up steady-state sync so future changes propagate
            // to the just-paired phone without re-scanning. Idempotent; the now-
            // cached peer MAC lets the dial loop re-sync every ~30s.
            void (async () => {
              try {
                await setAppMeta("shop_mode_enabled", "1");
                const mesh = await import("../../lib/mesh");
                // startShopMode for the cold-start case; notifyVaultSetChanged so
                // an already-running Shop Mode (another vault) refreshes every
                // channel for this newly-paired vault (startShopMode no-ops then).
                await mesh.startShopMode();
                await mesh.notifyVaultSetChanged();
              } catch (err) {
                console.warn("[vault/pair] could not start steady sync", err);
              }
            })();
          }
          // Failures are intentionally quiet on the owner screen: a stranger
          // dialing the UUID with a stale/forged nonce shouldn't alarm the
          // owner. The joiner gets the real error on its own screen.
        },
      });
      pairHostRef.current = handle;
    } catch (err) {
      console.warn("[vault/pair] could not host pair over BT", err);
      toast.push(t("menu.sync.shopMode.failed"), "info");
    }
  }

  async function onConfirmRole() {
    if (issuingRef.current || !vault) return;
    issuingRef.current = true;
    setIssuing(true);
    try {
      const token = await issueQr(vault, accountId, role);
      // Only advance on success. Flipping to show-qr with a null payload
      // rendered a never-resolving "Generating…" placeholder and a dead
      // Send-link button; the error now shows here on the role picker.
      if (token) {
        setStage("show-qr");
        // Start the RFCOMM pair listener now so the joiner has something to dial.
        void hostPairing(vault.id, token);
      }
    } finally {
      issuingRef.current = false;
      setIssuing(false);
    }
  }

  // Briar split-screen: the camera is LIVE alongside the QR. Request permission
  // once the QR is up; the "Allow camera" prompt in the camera slot re-runs this
  // (or routes to settings if permanently denied).
  async function onRequestCamera() {
    let perm = cameraPermission;
    if (!perm?.granted) perm = await requestCameraPermission();
    if (!perm?.granted && perm && !perm.canAskAgain) {
      void Linking.openSettings().catch(() => {});
    }
  }

  // Auto-request the camera as soon as the QR is showing, so both halves of the
  // split (your code + their camera) are live together with no extra tap.
  useEffect(() => {
    if (stage === "show-qr" && payload && cameraPermission && !cameraPermission.granted) {
      if (cameraPermission.canAskAgain) void requestCameraPermission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, payload, cameraPermission?.granted]);

  // Scanned the joiner's identity QR: pin their device pubkey onto THIS QR's
  // pending token. After this, the owner's pair-admission (claimPairNonce) will
  // admit exactly that one device — the out-of-band binding that makes the pair
  // mutually authenticated. The camera stays live; on a wrong/garbage code we
  // re-arm after a short debounce so it keeps scanning.
  const onJoinerBarcode = useCallback(
    async (result: { data?: string }) => {
      if (ownerScanHandledRef.current) return;
      if (!result?.data) return;
      ownerScanHandledRef.current = true;
      const reArm = () => {
        setTimeout(() => {
          ownerScanHandledRef.current = false;
        }, 1500);
      };
      const decoded = decodeJoinerIdentityQr(result.data);
      if (!decoded.ok) {
        toast.push(t("vaultPair.twoWay.wrongCode"), "error");
        reArm();
        return;
      }
      const nonce = payload?.shop_mode_token;
      if (!vault || !nonce) {
        reArm();
        return;
      }
      try {
        const { bindExpectedJoiner } = await import("../../lib/mesh/local-pair");
        const ok = await bindExpectedJoiner(vault.id, nonce, decoded.payload.device_pubkey);
        if (!ok) {
          toast.push(t("vaultPair.issueFailed"), "error");
          reArm();
          return;
        }
        setBoundName(decoded.payload.display_name.trim() || null);
        setScanMode("bound");
      } catch (err) {
        console.warn("[vault/pair] bindExpectedJoiner failed", err);
        toast.push(t("vaultPair.issueFailed"), "error");
        reArm();
      }
    },
    [payload, vault, toast],
  );

  if (!loaded || !vault) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <Text style={styles.bodyText}>{t("common.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ----- Stage 1: role picker --------------------------------------------
  if (stage === "pick-role") {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <ScreenHeader
          title={t("vaultPair.title")}
          onBack={() => router.back()}
          isRTL={isRTL}
          backLabel={t("common.back")}
        />
        <View style={styles.body}>
          <Text style={[styles.headline, textDir(isRTL)]}>
            {t("vaultPair.role.title")}
            {"\n"}
            <Text style={styles.emph}>{vault.name}</Text>
          </Text>
          <Text style={[styles.bodyText, textDir(isRTL), { marginBottom: 16 }]}>
            {t("vaultPair.role.subtitle")}
          </Text>

          {(["owner", "editor", "viewer"] as PairQrRole[]).map((r) => {
            const selected = role === r;
            return (
              <Pressable
                key={r}
                onPress={() => setRole(r)}
                style={[styles.roleChip, selected ? styles.roleChipSelected : null]}
              >
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      styles.roleChipLabel,
                      selected ? styles.roleChipLabelSelected : null,
                      textDir(isRTL),
                    ]}
                  >
                    {r === "owner"
                      ? t("vaultPair.role.owner")
                      : r === "editor"
                        ? t("vaultPair.role.editor")
                        : t("vaultPair.role.viewer")}
                  </Text>
                  <Text style={[styles.roleChipBody, textDir(isRTL)]}>
                    {r === "owner"
                      ? t("vaultPair.role.owner.body")
                      : r === "editor"
                        ? t("vaultPair.role.editor.body")
                        : t("vaultPair.role.viewer.body")}
                  </Text>
                </View>
                {selected ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.textEmphasis} />
                ) : (
                  <Ionicons name="ellipse-outline" size={22} color={colors.textMuted} />
                )}
              </Pressable>
            );
          })}

          {error ? <Text style={[styles.errorText, textDir(isRTL)]}>{error}</Text> : null}
          <View style={{ height: 24 }} />
          <Button label={t("vaultPair.role.continue")} onPress={onConfirmRole} loading={issuing} />
          <View style={{ height: 10 }} />
          <Button label={t("common.cancel")} variant="secondary" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  // ----- Stage 2: show QR ------------------------------------------------
  const expired = secondsLeft <= 0;
  const encoded = payload ? encodePairQr(payload) : "";

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("vaultPair.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />
      {/* Briar-style split: YOUR code (top) + THEIR camera (bottom), both live
          at once. The other phone shows the same kind of screen; you each scan
          the other's code simultaneously. */}
      <ScrollView contentContainerStyle={styles.splitBody} showsVerticalScrollIndicator={false}>
        <Text style={[styles.splitHint, textDir(isRTL)]}>{t("vaultPair.twoWay.splitHint")}</Text>

        <Text style={[styles.splitLabel, textDir(isRTL)]}>{t("vaultPair.twoWay.yourCode")}</Text>
        <View style={styles.qrCardSm}>
          {payload && !expired ? (
            <QRCode
              value={encoded}
              size={170}
              backgroundColor={colors.bgDefault}
              color={colors.textEmphasis}
            />
          ) : (
            <View style={styles.qrPlaceholderSm}>
              <Ionicons name="time-outline" size={36} color={colors.textMuted} />
              <Text style={[styles.bodyText, { marginTop: 8, textAlign: "center" }]}>
                {expired ? t("vaultPair.codeExpired") : t("vaultPair.generating")}
              </Text>
            </View>
          )}
        </View>
        {payload && !expired && scanMode !== "bound" ? (
          <Text style={[styles.timerText, textDir(isRTL)]}>
            {t("vaultPair.expiresIn", { time: formatCountdown(secondsLeft) })}
          </Text>
        ) : null}

        <Text style={[styles.splitLabel, textDir(isRTL), { marginTop: 18 }]}>
          {t("vaultPair.twoWay.theirCode")}
        </Text>
        <View style={styles.splitCamera}>
          {scanMode === "bound" ? (
            <View style={styles.cameraOverlay}>
              <Ionicons name="checkmark-circle" size={48} color={colors.textEmphasis} />
              <Text style={[styles.boundHeadline, textDir(isRTL)]}>
                {boundName
                  ? t("vaultPair.twoWay.bound.headline", { name: boundName })
                  : t("vaultPair.twoWay.bound.headlineNoName")}
              </Text>
            </View>
          ) : expired ? (
            <View style={styles.cameraOverlay}>
              <Ionicons name="time-outline" size={40} color={colors.textMuted} />
            </View>
          ) : cameraPermission?.granted ? (
            <>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={onJoinerBarcode}
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

        {error ? <Text style={[styles.errorText, textDir(isRTL)]}>{error}</Text> : null}

        <View style={{ height: 18 }} />
        {scanMode === "bound" ? (
          <>
            <Text style={[styles.bodyText, textDir(isRTL), { textAlign: "center" }]}>
              {t("vaultPair.twoWay.bound.body")}
            </Text>
            <View style={{ height: 12 }} />
            <Button label={t("common.done")} onPress={() => router.back()} />
            <View style={{ height: 8 }} />
            <Button
              label={t("vaultPair.twoWay.bound.startOver")}
              variant="secondary"
              onPress={onReissue}
            />
          </>
        ) : expired ? (
          <Button label={t("vaultPair.generateNew")} onPress={onReissue} />
        ) : (
          <Button label={t("common.cancel")} variant="secondary" onPress={() => router.back()} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// (The owner's pending-pair-token store now lives ENTIRELY in
// lib/mesh/local-pair.ts — generatePairToken mints + persists atomically, and
// bindExpectedJoiner/claimPairNonce mutate the same record in one txn. This
// file used to keep a second, non-atomic writer of pending_pair_tokens; it was
// removed to close a lost-update race against local-pair's atomic mutations.)

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: 20, alignItems: "center" },
  bodyText: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: 22,
    alignSelf: "stretch",
  },
  headline: {
    fontSize: 22,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
    lineHeight: 30,
    marginBottom: 16,
  },
  emph: { fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  // Briar split-screen pairing.
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
  timerText: {
    marginTop: 14,
    fontSize: 13,
    fontFamily: fonts.monoMedium,
    color: colors.textSubtle,
  },
  errorText: {
    marginTop: 12,
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.danger,
  },
  fineprint: {
    marginTop: 16,
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
    lineHeight: 18,
  },
  fineprintEmph: {
    marginTop: 6,
    fontSize: 12,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textAlign: "center",
  },
  // Briar-style two-way scan UI ------------------------------------------
  boundHeadline: {
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
  },
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
  roleChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    marginBottom: 10,
    gap: 12,
  },
  roleChipSelected: {
    borderColor: colors.textEmphasis,
    backgroundColor: colors.bgMuted,
  },
  roleChipLabel: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textDefault,
    marginBottom: 4,
  },
  roleChipLabelSelected: { color: colors.textEmphasis },
  roleChipBody: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: 18,
  },
});
