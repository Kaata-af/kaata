// apps/mobile/lib/mesh/pair-btc.ts
//
// M-BTC-3.2 — first-pair over Bluetooth Classic (insecure RFCOMM), Briar-style.
//
// Owner and joiner derive the SAME RFCOMM service UUID from the pair QR's
// shop_mode_token (deriveRfcommUuid). The owner goes discoverable + listens on
// it; the joiner runs classic inquiry, dials the host by that UUID, and BOTH run
// the REAL transport-agnostic anti-entropy handshake — Hello / PoP / AEAD /
// membership-chain verdict + pair-admission + delta — the exact path proven over
// RFCOMM by the M-BTC-3.1 dev screen. The pair-admission binding (the joiner's
// Hello.pair_nonce ↔ the owner's live pair token) is keyed by vault_id, not by
// transport, so verifyPeerChain admits the joiner with ZERO changes here.
//
// This REPLACES the BLE peripheral/GATT bringup the pair screens used to do via
// mesh.startShopMode(); Bluetooth Classic is the only proximity transport that
// works on the target hardware (e.g. Xiaomi Mi 10T). The screens drive these
// helpers directly during the pair window instead of relying on always-on
// discovery (classic inquiry carries no vault advertisement — there is no
// steady-state "is this peer in my vault" signal, so first contact is a QR-
// scoped rendezvous; ongoing auto-discovery is M-BTC-3.3).

import { Platform } from "react-native";
import { runAntiEntropy, loadVaultTrustAnchor } from "./anti-entropy";
import { ensureDeviceKey } from "./device-key";
import { requestBlePermissions } from "./ble-permissions";
import {
  deriveRfcommUuid,
  discoverAndConnect,
  startBtcListener,
  type BtcListenerHandle,
  type BtcMeshConnection,
} from "./transport-btc";
import { requestDiscoverable } from "../../modules/kaata-bt-classic";

const PAIR_SERVICE_NAME = "kaata-pair";
// Android caps discoverability at ~300s; that's the first-contact window during
// which a never-before-seen joiner's inquiry can learn our MAC. The pair TOKEN
// lives longer (PAIR_QR_TTL_MS), so a slow re-scan just re-arms discoverable.
const DISCOVERABLE_SEC = 300;
// Failsafe: if hostPairOverBtc's stop() is never called (screen killed without
// cleanup), auto-resume the steady loop after this long so sync can't stay
// paused forever. Slightly longer than the discoverable window.
const PAIR_PAUSE_SAFETY_MS = 360_000;
// After a pair SESSION completes (success or not), resume steady this soon —
// unless another attempt re-arms it (retries reset it, so we never resume
// mid-retry and re-introduce radio contention). Bridges the gap where the owner's
// side of a successful pair reported ok=false and the success-only resume didn't
// fire. Must be > the joiner's dial-retry backoff so a retry sequence keeps it
// armed; the joiner retries every ~1.5s, so 12s comfortably spans the gaps.
const POST_RESULT_RESUME_MS = 12_000;
// Cap the pair handshake+delta. The default is 5min; a hung peer would otherwise
// pin the steady-sync pause (joiner) / the host listener that long. 60s is ample
// for a pair + initial ledger transfer.
const PAIR_SESSION_MAX_MS = 60_000;

export type PairSyncOutcome = {
  ok: boolean;
  sent: number;
  received: number;
  peerDeviceId: string | null;
  error: string | null;
};

export type HostPairHandle = {
  /** Idempotent teardown of the RFCOMM pair server. */
  stop: () => Promise<void>;
};

async function ensureBtReady(): Promise<void> {
  if (Platform.OS !== "android") throw new Error("bt_classic_android_only");
  const perm = await requestBlePermissions();
  if (perm.kind !== "ok" && perm.kind !== "platform_unsupported") {
    throw new Error(`bluetooth_permission_${perm.kind}`);
  }
  await ensureDeviceKey();
}

/**
 * OWNER side: open an RFCOMM server on the QR-derived UUID + go discoverable.
 * Each joiner that dials runs the real handshake; the owner's verifyPeerChain
 * claims the pair nonce and emits the joiner's admission events into the chain.
 * Returns a handle the pair screen tears down on unmount / QR expiry / re-issue.
 * The listener stays up so the owner can pair several staff phones in a row.
 */
export async function hostPairOverBtc(opts: {
  vaultId: string;
  /** The QR's shop_mode_token — the shared rendezvous secret. */
  pairNonce: string;
  /** Fired after each joiner session completes (success or failure). */
  onResult?: (o: PairSyncOutcome) => void;
}): Promise<HostPairHandle> {
  await ensureBtReady();
  const anchor = await loadVaultTrustAnchor(opts.vaultId);
  if (!anchor) throw new Error("vault_has_no_trust_anchor");
  const uuid = deriveRfcommUuid(opts.pairNonce);

  // Pause the steady loop for the pair window so it doesn't cross-cancel the
  // joiner's inquiry. Balanced exactly once in stop(); a safety timer also
  // resumes after the QR TTL so a missed stop() can't leave sync paused forever.
  const { pauseBtcSteadyForPairing, resumeBtcSteadyForPairing } = await import("./btc-steady");
  await pauseBtcSteadyForPairing();
  let resumed = false;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  const doResume = () => {
    if (resumed) return;
    resumed = true;
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    // resumeBtcSteadyForPairing is async (it restarts steady + re-opens the
    // listeners the pause closed). doResume is called from sync contexts (the
    // resume-timer + the listener-throw catch), so fire-and-forget; resume wraps
    // its restart in its own try/catch so this can never reject.
    void resumeBtcSteadyForPairing().catch(() => {});
  };
  // Re-armable resume so steady can't stay paused for minutes after a pair. The
  // initial arm is the long "no joiner ever / missed stop()" failsafe. After ANY
  // session completes we re-arm a SHORT timer: retries keep resetting it (so we
  // never resume mid-retry and re-introduce radio contention), but once attempts
  // STOP — the pair succeeded, or the joiner gave up — steady resumes within
  // seconds instead of waiting out the 360s failsafe. Fixes the "paired but the
  // owner's new edits don't sync for ~6 min" bug, where the owner's side of a
  // successful pair reported ok=false (joiner admitted, then closed the socket)
  // so the success-only doResume never fired.
  const rearmResume = (ms: number) => {
    if (resumed) return;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(doResume, ms);
  };
  rearmResume(PAIR_PAUSE_SAFETY_MS);

  let listener: BtcListenerHandle;
  try {
    listener = await startBtcListener({
      serviceName: PAIR_SERVICE_NAME,
      uuid,
      onConnection: (conn) => {
        void runPairSession(conn, opts.vaultId, anchor).then((o) => {
          opts.onResult?.(o);
          // The QR pair nonce is single-use (consumePairNonce after admission), so
          // a completed session ends the useful pair window. On a clean success,
          // resume steady NOW so the just-paired vault syncs promptly. On a not-ok
          // result (incl. the asymmetric case where the joiner got admitted but the
          // owner saw a late close), DON'T resume immediately — a retry may follow
          // — but re-arm the short timer so steady comes back in seconds once the
          // attempts stop, not after the 360s failsafe.
          if (o.ok) doResume();
          else rearmResume(POST_RESULT_RESUME_MS);
        });
      },
    });
  } catch (err) {
    doResume();
    throw err;
  }

  // Best-effort: a never-before-seen joiner needs us discoverable so its classic
  // inquiry can learn our MAC. Non-fatal on deny (a previously-paired phone that
  // already knows our MAC wouldn't need it — but for first contact it's required).
  try {
    await requestDiscoverable(DISCOVERABLE_SEC);
  } catch {
    /* user declined the discoverable prompt — pairing may still work if cached */
  }

  return {
    stop: async () => {
      doResume(); // clears resumeTimer + resumes steady (once-guarded)
      await listener.stop();
    },
  };
}

/**
 * JOINER side: classic inquiry → dial the host by the QR-derived UUID → real
 * handshake. The joiner's Hello carries the pair_nonce (persisted by the scan
 * screen before this call); the owner admits it. THROWS on failure so the scan
 * screen can offer a retry — the vault row + pair nonce persist, so re-running
 * is safe and idempotent (a second attempt re-syncs even if the first already
 * admitted this device chain-side).
 */
export async function joinPairOverBtc(opts: {
  vaultId: string;
  pairNonce: string;
  /** The owner's REAL Bluetooth MAC from the QR (issuer_bt_mac) — dialed DIRECTLY
   *  when present (no inquiry). The reliable Briar path. */
  hostMac?: string | null;
  /** The owner's Bluetooth name from the QR (issuer_bt_name) — inquiry sort hint. */
  hostName?: string | null;
  onLog?: (line: string) => void;
}): Promise<PairSyncOutcome> {
  await ensureBtReady();
  const anchor = await loadVaultTrustAnchor(opts.vaultId);
  if (!anchor) throw new Error("vault_has_no_trust_anchor");
  const uuid = deriveRfcommUuid(opts.pairNonce);

  // Give the pair inquiry/dial EXCLUSIVE use of the single radio — pause the
  // steady loop so it doesn't cross-cancel our inquiry (the new-kaata pair bug).
  const { pauseBtcSteadyForPairing, resumeBtcSteadyForPairing } = await import("./btc-steady");
  await pauseBtcSteadyForPairing();
  try {
    const conn = await discoverAndConnect({
      uuid,
      hostMac: opts.hostMac ?? undefined,
      hostName: opts.hostName ?? undefined,
      onLog: opts.onLog,
    });
    const outcome = await runPairSession(conn, opts.vaultId, anchor);
    if (!outcome.ok) {
      // Re-throw the real reason (e.g. the membership-chain verdict) so the scan
      // screen can surface it and offer a retry.
      throw new Error(outcome.error ?? "pair_sync_failed");
    }
    return outcome;
  } finally {
    // await is safe: resumeBtcSteadyForPairing never throws (its steady restart
    // is internally try/caught), so it can't clobber the pair outcome/error this
    // try block returns or re-throws. It also re-opens the listeners the pause
    // closed before we hand back to the scan screen.
    await resumeBtcSteadyForPairing();
  }
}

/**
 * Run the real anti-entropy handshake over a connected RFCOMM socket, from
 * either side. NEVER throws — returns an outcome so the owner's fire-and-forget
 * onResult path can't leak an unhandled rejection; the joiner inspects ok and
 * re-throws. suppressFailures is set because the PAIR SCREENS are the feedback
 * channel (their own joined / retry UI); suppressFailures only mutes the
 * transport's global mesh-failure toast on the normal post-sync close, which
 * after a SUCCESSFUL pair would otherwise read as a scary "couldn't connect".
 */
async function runPairSession(
  conn: BtcMeshConnection,
  vaultId: string,
  anchor: Uint8Array,
): Promise<PairSyncOutcome> {
  conn.suppressFailures = true;
  try {
    const r = await runAntiEntropy(conn, {
      vaultId,
      vaultTrustAnchorPubkey: anchor,
      maxDurationMs: PAIR_SESSION_MAX_MS,
    });
    // M-BTC-3.3: remember the now-authenticated peer's MAC so steady-state sync
    // (btc-steady.ts) can re-dial it directly — no QR re-scan, no classic inquiry.
    if (conn.remoteDeviceId && conn.remoteMac) {
      try {
        const { addKnownPeer } = await import("./btc-peers");
        await addKnownPeer({ vaultId, deviceId: conn.remoteDeviceId, mac: conn.remoteMac });
      } catch {
        /* non-fatal — steady sync just won't have this peer cached yet */
      }
    }
    return {
      ok: true,
      sent: r.sent,
      received: r.received,
      peerDeviceId: r.peerDeviceId,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      sent: 0,
      received: 0,
      peerDeviceId: null,
      error: (err as Error)?.message ?? "pair_sync_failed",
    };
  } finally {
    try {
      await conn.close();
    } catch {
      /* */
    }
  }
}
