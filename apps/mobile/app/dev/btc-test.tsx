// apps/mobile/app/dev/btc-test.tsx
//
// DEV / milestone M-BTC-3.1 — proves REAL ledger sync over Bluetooth Classic
// (insecure RFCOMM), Briar-style, with NO manual MAC entry and NO system
// pairing dialog. Builds on M-BTC-2's QR rendezvous but swaps the raw ping/pong
// for the actual mesh handshake: both phones run runAntiEntropy over the
// BtcMeshConnection (Hello / PoP / AEAD / membership-chain verdict / delta) —
// the exact transport-agnostic protocol that already runs over LAN and BLE.
//
// PREREQ: both phones must already be members of the SAME vault (same
// vault_trust_anchor_pubkey). Pair once via the normal QR flow first, then use
// this screen to prove the ledger replicates over Bluetooth.
//
//   Phone A: tap "Host" → allow the "make discoverable" prompt → show the QR.
//   Phone B: tap "Scan" → point at Phone A's QR. It finds + connects + syncs.
//   Either phone: tap "Make test entry", then sync — watch recv>0 on the peer.
//
// Throwaway dev surface (Settings → "Bluetooth test (dev)").

import { useCallback, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import QRCode from "react-native-qrcode-svg";
import * as Crypto from "expo-crypto";
import { colors } from "../../lib/colors";
import { fonts } from "../../lib/fonts";
import { requestBlePermissions } from "../../lib/mesh/ble-permissions";
import { getLocalName, requestDiscoverable } from "../../modules/kaata-bt-classic";
import {
  deriveRfcommUuid,
  discoverAndConnect,
  startBtcListener,
  type BtcListenerHandle,
  type BtcMeshConnection,
} from "../../lib/mesh/transport-btc";
import { runAntiEntropy, loadVaultTrustAnchor } from "../../lib/mesh/anti-entropy";
import { ensureDeviceKey } from "../../lib/mesh/device-key";
import { getActiveVaultIdSyncMaybe } from "../../lib/db-tx";
import { appendEntryCreated } from "../../lib/event-log";
import { getDb } from "../../lib/db";

const DISCOVERABLE_SEC = 300;

type Mode = "idle" | "hosting" | "scanning";

export default function BtcTestScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [qr, setQr] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const listenerRef = useRef<BtcListenerHandle | null>(null);
  const scannedRef = useRef(false);

  const append = useCallback((line: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    setLog((prev) => [`${ts}  ${line}`, ...prev].slice(0, 200));
  }, []);

  // Run the REAL anti-entropy handshake + delta over a connected RFCOMM socket.
  // This is the whole point of M-BTC-3.1: prove the transport-agnostic mesh
  // protocol (Hello/PoP/AEAD/chain-verdict/delta) runs over Bluetooth unchanged.
  // Both phones must already share the active vault + its trust anchor.
  //
  // suppressFailures stays true on this DEV surface only: a real handshake or
  // decrypt failure still surfaces because runAntiEntropy THROWS (caught + logged
  // below); suppressFailures only mutes the transport's post-sync close toast,
  // which here is just noise (the log is our feedback channel).
  const runRealSync = useCallback(
    async (conn: BtcMeshConnection) => {
      conn.suppressFailures = true;
      const vaultId = getActiveVaultIdSyncMaybe();
      if (!vaultId) {
        append("✗ no active vault — onboard/pair first");
        return;
      }
      const anchor = await loadVaultTrustAnchor(vaultId);
      if (!anchor) {
        append("✗ active vault has no trust anchor — pair into a chain vault first");
        return;
      }
      await ensureDeviceKey();
      append(`▶ runAntiEntropy vault=${vaultId.slice(0, 8)}…`);
      try {
        const r = await runAntiEntropy(conn, { vaultId, vaultTrustAnchorPubkey: anchor });
        append(
          `✓✓ sync OK  sent=${r.sent} recv=${r.received} dup=${r.duplicates} ` +
            `peer=${r.peerDeviceId.slice(0, 8)} ${r.durationMs}ms`,
        );
      } catch (err) {
        append(`✗ sync failed: ${(err as Error).message}`);
      } finally {
        try {
          await conn.close();
        } catch {
          /* */
        }
      }
    },
    [append],
  );

  // Make a tiny ledger entry so replication is observable: tap on one phone,
  // then sync — the other phone's "recv" count should go up by one.
  const onMakeTestEntry = useCallback(async () => {
    try {
      const vaultId = getActiveVaultIdSyncMaybe();
      if (!vaultId) {
        append("✗ no active vault");
        return;
      }
      const db = await getDb();
      const rel = await db.getFirstAsync<{ id: string }>(
        `SELECT id FROM relationships WHERE vault_id = ? AND archived_at IS NULL LIMIT 1`,
        vaultId,
      );
      if (!rel) {
        append("✗ no relationship — add a person first");
        return;
      }
      const res = await appendEntryCreated({
        relationshipId: rel.id,
        type: "debt",
        amountAfn: 1,
        note: "btc-test",
      });
      append(`+ test entry ${res.entry_id.slice(0, 8)} (debt 1) — now sync to replicate`);
    } catch (err) {
      append(`✗ make entry failed: ${(err as Error).message}`);
    }
  }, [append]);

  const ensureBt = useCallback(async (): Promise<boolean> => {
    const res = await requestBlePermissions();
    if (res.kind === "ok" || res.kind === "platform_unsupported") return true;
    append(`✗ Bluetooth permission: ${res.kind}`);
    return false;
  }, [append]);

  // --- Host ---------------------------------------------------------------
  const onHost = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await ensureBt())) return;
      const secret = Crypto.randomUUID();
      const uuid = deriveRfcommUuid(secret);
      append("starting RFCOMM server…");
      const handle = await startBtcListener({
        serviceName: "kaata-btc-test",
        uuid,
        onConnection: (conn: BtcMeshConnection) => {
          append("← peer connected");
          void runRealSync(conn);
        },
      });
      listenerRef.current = handle;
      append("requesting discoverable (allow the prompt)…");
      await requestDiscoverable(DISCOVERABLE_SEC);
      const hostName = await getLocalName().catch(() => null);
      setQr(JSON.stringify({ v: 1, n: secret, name: hostName }));
      setMode("hosting");
      append("✓ hosting — show this QR to the other phone");
    } catch (err) {
      append(`✗ host failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [busy, ensureBt, append, runRealSync]);

  const onStopHost = useCallback(async () => {
    try {
      await listenerRef.current?.stop();
    } catch {
      /* */
    }
    listenerRef.current = null;
    setQr(null);
    setMode("idle");
    append("host stopped");
  }, [append]);

  // --- Scan ---------------------------------------------------------------
  const onScan = useCallback(async () => {
    if (busy) return;
    if (!(await ensureBt())) return;
    if (!camPerm?.granted) {
      const r = await requestCamPerm();
      if (!r.granted) {
        append("✗ camera permission denied");
        return;
      }
    }
    scannedRef.current = false;
    setMode("scanning");
    append("point the camera at the host's QR…");
  }, [busy, camPerm, requestCamPerm, ensureBt, append]);

  const onBarcode = useCallback(
    (result: { data?: string }) => {
      if (scannedRef.current || !result.data) return;
      scannedRef.current = true;
      setMode("idle");
      setBusy(true);
      void (async () => {
        let conn: BtcMeshConnection | null = null;
        try {
          const parsed = JSON.parse(result.data!) as { n?: string; name?: string | null };
          if (!parsed.n) {
            append("✗ QR missing secret");
            return;
          }
          const uuid = deriveRfcommUuid(parsed.n);
          conn = await discoverAndConnect({
            uuid,
            hostName: parsed.name ?? undefined,
            onLog: append,
          });
          await runRealSync(conn);
        } catch (err) {
          append(`✗ ${(err as Error).message}`);
        } finally {
          try {
            await conn?.close();
          } catch {
            /* */
          }
          setBusy(false);
        }
      })();
    },
    [append, runRealSync],
  );

  if (Platform.OS !== "android") {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.note}>Android only.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>BT Classic sync (M-BTC-3.1)</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {mode === "scanning" ? (
          <View style={styles.camWrap}>
            <CameraView
              style={styles.cam}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={onBarcode}
            />
            <Pressable
              onPress={() => setMode("idle")}
              style={({ pressed }) => [styles.btnGhost, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.btnGhostText}>Cancel scan</Text>
            </Pressable>
          </View>
        ) : mode === "hosting" && qr ? (
          <View style={styles.qrWrap}>
            <Text style={styles.section}>Show this to the other phone</Text>
            <View style={styles.qrBox}>
              <QRCode value={qr} size={240} />
            </View>
            <Text style={styles.hint}>Discoverable for ~5 min. Keep this screen open.</Text>
            <Pressable
              onPress={onStopHost}
              style={({ pressed }) => [styles.btnGhost, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.btnGhostText}>Stop hosting</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.actions}>
            <Pressable
              onPress={onHost}
              disabled={busy}
              style={({ pressed }) => [styles.btn, (pressed || busy) && { opacity: 0.6 }]}
            >
              <Text style={styles.btnText}>Host (show QR)</Text>
            </Pressable>
            <View style={{ height: 12 }} />
            <Pressable
              onPress={onScan}
              disabled={busy}
              style={({ pressed }) => [styles.btn, (pressed || busy) && { opacity: 0.6 }]}
            >
              <Text style={styles.btnText}>Scan to connect</Text>
            </Pressable>
            <Pressable
              onPress={onMakeTestEntry}
              style={({ pressed }) => [styles.btnGhost, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.btnGhostText}>Make test entry (then sync)</Text>
            </Pressable>
          </View>
        )}

        <Text style={[styles.section, { marginTop: 22 }]}>Log</Text>
        <View style={styles.logBox}>
          {log.length === 0 ? (
            <Text style={styles.logEmpty}>—</Text>
          ) : (
            log.map((l, i) => (
              <Text key={i} style={styles.logLine}>
                {l}
              </Text>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefault,
  },
  back: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textSubtle, width: 50 },
  title: { fontSize: 15, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  body: { padding: 16, paddingBottom: 40 },
  note: { padding: 16, fontFamily: fonts.sansRegular, color: colors.textSubtle },
  actions: { marginTop: 8 },
  btn: {
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: colors.textEmphasis,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { fontSize: 15, fontFamily: fonts.sansSemi, color: colors.bgDefault },
  btnGhost: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 12 },
  btnGhostText: { fontSize: 14, fontFamily: fonts.sansMedium, color: colors.textSubtle },
  qrWrap: { alignItems: "center", marginTop: 8 },
  qrBox: {
    padding: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    marginTop: 10,
    marginBottom: 10,
  },
  camWrap: { marginTop: 8 },
  cam: { width: "100%", height: 320, borderRadius: 12, overflow: "hidden" },
  section: {
    fontSize: 12,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  hint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
  },
  logBox: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 10,
    padding: 12,
    backgroundColor: colors.bgMuted,
    minHeight: 120,
  },
  logEmpty: { fontFamily: fonts.monoRegular, color: colors.textMuted, fontSize: 12 },
  logLine: {
    fontFamily: fonts.monoRegular,
    fontSize: 11,
    color: colors.textDefault,
    marginBottom: 3,
    lineHeight: 15,
  },
});
