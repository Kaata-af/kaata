// apps/mobile/lib/mesh/btc-steady.ts
//
// M-BTC-3.3 (smallest-first) — keep ALREADY-PAIRED phones in sync over Bluetooth
// Classic without re-scanning a QR. Two halves, both running while Shop Mode is on:
//
//   LISTEN  — open an RFCOMM server on a STABLE per-(vault,day) UUID derived
//             from vaultDigest (NOT the one-shot QR token). Every member derives
//             the same UUID; no outsider can. Accepted sockets run the real
//             anti-entropy handshake. Listeners are refreshed on UTC-day
//             rollover so always-on shop mode keeps working past midnight.
//   DIAL    — every ~30s, for each KNOWN peer (MAC cached at pair time, see
//             btc-peers.ts), connectRfcomm(mac, steadyUuid) directly — NO classic
//             inquiry, so it's instant — then run anti-entropy and close.
//
// This deliberately does NOT discover brand-new peers (that needs inquiry+SDP or
// BLE advertising — a later milestone). It only re-syncs peers we've already
// paired with, which is the user-facing "changes show up on both phones" gap.
//
// Single-radio discipline: ticks are serialized (skip if one is in flight); a
// reached peer is on a short cooldown and an UNreachable peer is backed off
// longer so a powered-off staff phone isn't dialed every tick. Both phones may
// still each initiate ~once per interval — that's fine, anti-entropy is
// idempotent and bidirectional, and keeping both-dial means sync still works
// when one phone is backgrounded (the dial loop is foreground-only; the listener
// always answers). The first kick is jittered so two phones that pair at the
// same instant don't dial each other on the exact same tick.

import { AppState, Platform } from "react-native";
import { runAntiEntropy, loadVaultTrustAnchor } from "./anti-entropy";
import { ensureDeviceKey } from "./device-key";
import {
  deriveRfcommUuid,
  dialBtcPeer,
  discoverAndConnect,
  startBtcListener,
  type BtcListenerHandle,
  type BtcMeshConnection,
} from "./transport-btc";
import { isBtClassicSupported } from "../../modules/kaata-bt-classic";
import { vaultDigest, advertiseDays, dayNumber } from "./vault-digest";
import { addKnownPeer, listKnownPeers } from "./btc-peers";
import { onLedgerApplied } from "../ledger-events";
import { markPeerSeen } from "./presence";

const STEADY_SERVICE_NAME = "kaata-sync";
// Backstop poll. Push-on-write (ledger-events) already covers the real-time case
// for known peers, so this is just the safety net for missed pushes / a peer
// that came back in range — 15s keeps it snappy without much extra radio.
const DIAL_INTERVAL_MS = 15_000;
// After we reach a peer, don't re-dial for this long (dedupes the both-phones-
// dial-each-other burst within a window). Must be < DIAL_INTERVAL.
const PEER_COOLDOWN_MS = 12_000;
// After we FAIL to reach a peer (powered off / out of range), back off longer so
// the radio isn't burned dialing a dead MAC every tick.
const FAILURE_BACKOFF_MS = 90_000;
// Jitter on the first kick so two phones pairing at the same instant don't fire
// their first dial on the exact same millisecond.
const FIRST_KICK_JITTER_MS = 3_000;
// Debounce for push-on-local-write: coalesce a burst of edits (e.g. add-person
// then add-entry) into a single immediate dial. ~real-time without thrashing.
const KICK_DEBOUNCE_MS = 500;
// Inquiry fallback for vaults with NO cached peer MAC (a newly created/paired
// vault, or one whose peer MAC we never stored). A classic inquiry monopolizes
// the radio (~8-12s), so throttle it hard and only do one vault per sweep.
const INQUIRY_INTERVAL_MS = 150_000;
const INQUIRY_DISCOVERY_MS = 8_000;
// Cap a steady session's handshake+delta. The default is 5min; a half-open peer
// that connects + sends nothing would otherwise pin the socket (+ its native
// reader) that long, piling up toward the crash. 45s is ample for a real sync.
const STEADY_SESSION_MAX_MS = 45_000;

/** Stable per-(vault,day) RFCOMM service UUID. Distinct domain prefix from the
 *  one-shot pair UUID (deriveRfcommUuid(shop_mode_token)) so a live pair window
 *  and steady-state never collide. */
function steadyUuid(vaultId: string, day: number): string {
  return deriveRfcommUuid("steady:" + vaultDigest(vaultId, day));
}

type SteadyState = {
  listeners: BtcListenerHandle[];
  /** UTC day the current listeners were opened for (rollover refresh). */
  listenerDay: number;
  timer: ReturnType<typeof setInterval> | null;
  firstKick: ReturnType<typeof setTimeout> | null;
  tickRunning: boolean;
  stopped: boolean;
  vaultIds: string[];
  /** deviceId → ms until which we skip dialing it (success cooldown / fail backoff). */
  skipUntil: Map<string, number>;
  /** Pending push-on-write debounce timer (coalesces a burst of local edits). */
  kickDebounce: ReturnType<typeof setTimeout> | null;
  /** A push arrived while a pass was mid-flight — run one more when it finishes. */
  kickPending: boolean;
  /** Unsubscribe from the ledger-applied emitter (push trigger). */
  unsubLedger: (() => void) | null;
  /** Last classic-inquiry sweep for peerless vaults (heavily throttled). */
  lastInquiryAt: number;
  /** Round-robin cursor over peerless vaults for the inquiry sweep. */
  inquiryRR: number;
};

let steady: SteadyState | null = null;

/**
 * Start steady-state RFCOMM sync for the given chain-anchored vaults. Idempotent
 * (restarts cleanly). Android-only; no-ops elsewhere.
 */
export async function startBtcSteadySync(opts: { vaultIds: string[] }): Promise<void> {
  if (Platform.OS !== "android" || !isBtClassicSupported()) return;
  await stopBtcSteadySync();

  const s: SteadyState = {
    listeners: [],
    listenerDay: dayNumber(Date.now()),
    timer: null,
    firstKick: null,
    tickRunning: false,
    stopped: false,
    vaultIds: opts.vaultIds,
    skipUntil: new Map(),
    kickDebounce: null,
    kickPending: false,
    unsubLedger: null,
    lastInquiryAt: 0,
    inquiryRR: 0,
  };
  steady = s;

  try {
    await ensureDeviceKey();
  } catch {
    /* handshake will fail loudly if the key truly isn't ready */
  }
  // A concurrent start/stop may have superseded us during the await above.
  if (steady !== s) return;

  await openListeners(s);
  if (steady !== s) return; // superseded while opening listeners — openListeners cleaned up

  s.timer = setInterval(() => void steadyTick(s), DIAL_INTERVAL_MS);
  // Kick one soon (jittered) so the first post-pair sync isn't a full interval
  // away, but two phones don't collide on the exact same instant.
  s.firstKick = setTimeout(
    () => void steadyTick(s),
    Math.floor(Math.random() * FIRST_KICK_JITTER_MS),
  );

  // Push-on-write: when a LOCAL ledger event is applied, dial peers immediately
  // (debounced) instead of waiting up to 30s. Only origin==="local" — pushing on
  // a remote-applied event would ping-pong between two phones forever.
  s.unsubLedger = onLedgerApplied((vaultId, origin) => {
    if (origin !== "local") return;
    if (!s.vaultIds.includes(vaultId)) return;
    scheduleKick(s);
  });

  if (__DEV__)
    console.log("[btc.steady] started", {
      vaults: opts.vaultIds.length,
      listeners: s.listeners.length,
    });
}

/** Stop steady-state sync (idempotent). In-flight sessions drain on their own. */
export async function stopBtcSteadySync(): Promise<void> {
  const s = steady;
  steady = null;
  if (!s) return;
  s.stopped = true;
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  if (s.firstKick) {
    clearTimeout(s.firstKick);
    s.firstKick = null;
  }
  if (s.kickDebounce) {
    clearTimeout(s.kickDebounce);
    s.kickDebounce = null;
  }
  if (s.unsubLedger) {
    s.unsubLedger();
    s.unsubLedger = null;
  }
  const listeners = s.listeners;
  s.listeners = [];
  for (const h of listeners) {
    try {
      await h.stop();
    } catch {
      /* */
    }
  }
}

/** Open (or re-open) listeners on today+tomorrow UUIDs for every vault. Tears
 *  down any existing listeners first. Bails cleanly (and stops anything it
 *  opened) if this session is superseded mid-flight — the start/stop race fix. */
async function openListeners(s: SteadyState): Promise<void> {
  // Drop the previous day's listeners.
  const prev = s.listeners;
  s.listeners = [];
  for (const h of prev) {
    try {
      await h.stop();
    } catch {
      /* */
    }
  }

  const now = Date.now();
  s.listenerDay = dayNumber(now);
  for (const vaultId of s.vaultIds) {
    if (s.stopped || steady !== s) break;
    const anchor = await loadVaultTrustAnchor(vaultId);
    if (!anchor) continue;
    for (const day of advertiseDays(now)) {
      if (s.stopped || steady !== s) break;
      try {
        const handle = await startBtcListener({
          serviceName: STEADY_SERVICE_NAME,
          uuid: steadyUuid(vaultId, day),
          onConnection: (conn) => {
            void runSteadySession(s, conn, vaultId, anchor);
          },
        });
        // If we were superseded/stopped while openRfcommServer was awaiting, this
        // handle would otherwise leak (accept loop running on a dead session).
        if (s.stopped || steady !== s) {
          void handle.stop().catch(() => {});
        } else {
          s.listeners.push(handle);
        }
      } catch (err) {
        if (__DEV__) console.warn("[btc.steady] listen failed", (err as Error).message);
      }
    }
  }
}

/** Periodic backstop pass — respects each peer's cooldown/backoff. */
async function steadyTick(s: SteadyState): Promise<void> {
  await runDialPass(s, true);
}

/** Push pass — a LOCAL write happened, so dial known peers NOW, bypassing the
 *  success cooldown (an edit must not be swallowed by the 22s window). */
async function kickTick(s: SteadyState): Promise<void> {
  await runDialPass(s, false);
}

/** Schedule a debounced push pass after a local write (coalesces edit bursts). */
function scheduleKick(s: SteadyState): void {
  if (s.stopped || steady !== s || s.kickDebounce) return;
  s.kickDebounce = setTimeout(() => {
    s.kickDebounce = null;
    if (s.stopped || steady !== s) return;
    if (s.tickRunning) {
      // A pass is mid-flight; re-run a push pass when it finishes so the edit
      // isn't lost to the tickRunning guard.
      s.kickPending = true;
      return;
    }
    void kickTick(s);
  }, KICK_DEBOUNCE_MS);
}

/**
 * One dial pass over every known peer. respectCooldown=true for the periodic
 * backstop, false for a push. Single-radio-serialized via tickRunning and
 * foreground-gated. dialKnownPeer still WRITES skipUntil on success either way,
 * so a freshly-pushed peer is correctly skipped by the next backstop tick.
 */
async function runDialPass(s: SteadyState, respectCooldown: boolean): Promise<void> {
  if (s.stopped || steady !== s || s.tickRunning) return;
  // Foreground-only dialing: one BT radio + battery. The listener stays up so a
  // foregrounded peer can still reach a backgrounded one.
  if (AppState.currentState !== "active") return;
  s.tickRunning = true;
  try {
    // Refresh listeners across a UTC-day rollover so the dialer's day window and
    // the listener's frozen day don't drift apart (silent sync death otherwise).
    if (dayNumber(Date.now()) !== s.listenerDay) {
      await openListeners(s);
      if (s.stopped || steady !== s) return;
    }

    const now = Date.now();
    const peerless: string[] = [];
    for (const vaultId of s.vaultIds) {
      if (s.stopped || steady !== s) break;
      const anchor = await loadVaultTrustAnchor(vaultId);
      if (!anchor) continue;
      const peers = await listKnownPeers(vaultId);
      if (peers.length === 0) peerless.push(vaultId);
      for (const peer of peers) {
        if (s.stopped || steady !== s) break;
        if (respectCooldown && now < (s.skipUntil.get(peer.deviceId) ?? 0)) continue;
        await dialKnownPeer(s, vaultId, anchor, peer.deviceId, peer.mac);
      }
    }

    // Inquiry fallback (backstop only, not push-kicks): a vault with NO cached
    // peer (newly created/paired, or MAC never stored) can't be dialed directly.
    // Run a throttled classic inquiry to FIND a co-located co-member by blind-
    // dialing the vault's steady UUID (only co-members answer it). One vault per
    // sweep, round-robin, since inquiry monopolizes the single radio for ~8s.
    if (
      respectCooldown &&
      peerless.length > 0 &&
      now - s.lastInquiryAt >= INQUIRY_INTERVAL_MS &&
      !s.stopped &&
      steady === s
    ) {
      s.lastInquiryAt = Date.now();
      const vaultId = peerless[s.inquiryRR % peerless.length];
      s.inquiryRR++;
      await inquireForPeer(s, vaultId);
    }
  } finally {
    s.tickRunning = false;
    // A push landed while we were mid-pass — honor it now (no-cooldown).
    if (s.kickPending && !s.stopped && steady === s) {
      s.kickPending = false;
      void kickTick(s);
    }
  }
}

/** Classic-inquiry fallback for a vault with no cached peer: find a co-located
 *  co-member by blind-dialing the vault's steady UUID, then sync. runSteadySession
 *  caches the found peer's MAC so future ticks dial it directly (no more inquiry). */
async function inquireForPeer(s: SteadyState, vaultId: string): Promise<void> {
  const anchor = await loadVaultTrustAnchor(vaultId);
  if (!anchor) return;
  let conn: BtcMeshConnection;
  try {
    conn = await discoverAndConnect({
      uuid: steadyUuid(vaultId, dayNumber(Date.now())),
      discoveryMs: INQUIRY_DISCOVERY_MS,
    });
  } catch {
    return; // no co-member found this sweep — retry after INQUIRY_INTERVAL_MS
  }
  if (s.stopped || steady !== s) {
    try {
      await conn.close();
    } catch {
      /* */
    }
    return;
  }
  await runSteadySession(s, conn, vaultId, anchor);
}

async function dialKnownPeer(
  s: SteadyState,
  vaultId: string,
  anchor: Uint8Array,
  deviceId: string,
  mac: string,
): Promise<void> {
  // Dial today first, then tomorrow — matching what listeners advertise
  // (advertiseDays). Yesterday is intentionally NOT tried: no peer ever listens
  // on it, so dialing it just burns a multi-second native connect failure.
  const d = dayNumber(Date.now());
  for (const day of [d, d + 1]) {
    if (s.stopped || steady !== s) return;
    let conn: BtcMeshConnection;
    try {
      conn = await dialBtcPeer({ mac, uuid: steadyUuid(vaultId, day), suppressFailures: true });
    } catch {
      continue; // peer not listening on this day's UUID — try the next
    }
    await runSteadySession(s, conn, vaultId, anchor);
    // We at least connected — short cooldown (covers a connect-but-handshake-fail
    // so we don't hammer it every tick; runSteadySession also stamps on success).
    s.skipUntil.set(deviceId, Date.now() + PEER_COOLDOWN_MS);
    return;
  }
  // Couldn't reach this peer on any advertised day — back off longer.
  s.skipUntil.set(deviceId, Date.now() + FAILURE_BACKOFF_MS);
}

async function runSteadySession(
  s: SteadyState,
  conn: BtcMeshConnection,
  vaultId: string,
  anchor: Uint8Array,
): Promise<void> {
  // Background periodic sync — the user has no screen to show a failure on, and a
  // normal post-sync close shouldn't toast. suppressFailures mutes the transport
  // toast; a genuine handshake failure still rejects runAntiEntropy (logged).
  conn.suppressFailures = true;
  try {
    const r = await runAntiEntropy(conn, {
      vaultId,
      vaultTrustAnchorPubkey: anchor,
      maxDurationMs: STEADY_SESSION_MAX_MS,
    });
    if (conn.remoteDeviceId) {
      s.skipUntil.set(conn.remoteDeviceId, Date.now() + PEER_COOLDOWN_MS);
      markPeerSeen(conn.remoteDeviceId); // presence: this device is reachable now
      // Self-heal the MAC mapping (e.g. peer first learned via an inbound accept).
      // addKnownPeer skips the write when the MAC is unchanged, so this is cheap.
      if (conn.remoteMac) {
        await addKnownPeer({ vaultId, deviceId: conn.remoteDeviceId, mac: conn.remoteMac });
      }
    }
    if (__DEV__)
      console.log("[btc.steady] synced", {
        vault: vaultId.slice(0, 8),
        sent: r.sent,
        recv: r.received,
        peer: r.peerDeviceId.slice(0, 8),
      });
  } catch (err) {
    if (__DEV__) console.warn("[btc.steady] session failed:", (err as Error).message);
  } finally {
    try {
      await conn.close();
    } catch {
      /* */
    }
  }
}
