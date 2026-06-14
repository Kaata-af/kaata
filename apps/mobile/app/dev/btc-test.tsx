// apps/mobile/app/dev/btc-test.tsx
//
// DEV / milestone M-BTC-2 — proves Bluetooth Classic (insecure RFCOMM) pairing
// via QR, Briar-style, with NO manual MAC entry. The host shows a QR carrying a
// random secret + goes discoverable + listens on a derived RFCOMM UUID; the
// scanner reads the QR, derives the same UUID, runs classic inquiry to learn
// the host's MAC, and dials it. They then exchange a ping/pong over a real
// BtcMeshConnection (the same framing the anti-entropy handshake will use). No
// bonding, no system pairing dialog.
//
//   Phone A: tap "Host" → allow the "make discoverable" prompt → show the QR.
//   Phone B: tap "Scan" → point at Phone A's QR. It finds + connects on its own.
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

const RECV_TIMEOUT_MS = 60_000;
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
          conn.suppressFailures = true; // raw test: a normal close isn't a failure
          append("← peer connected");
          void (async () => {
            try {
              const msg = await conn.recvJSON(RECV_TIMEOUT_MS);
              append(`← recv: ${JSON.stringify(msg)}`);
              await conn.sendJSON({ pong: true, echo: msg, at: Date.now() });
              append("→ sent pong  ✓✓ round-trip OK");
            } catch (err) {
              append(`✗ host exchange failed: ${(err as Error).message}`);
            }
          })();
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
  }, [busy, ensureBt, append]);

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
          conn.suppressFailures = true; // raw test: a normal close isn't a failure
          await conn.sendJSON({ ping: true, from: "btc-test", ts: Date.now() });
          append("→ sent ping");
          const reply = await conn.recvJSON(RECV_TIMEOUT_MS);
          append(`← recv: ${JSON.stringify(reply)}  ✓✓ round-trip OK`);
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
    [append],
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
        <Text style={styles.title}>BT Classic test (M-BTC-2)</Text>
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
