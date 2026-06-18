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
// when one phone is backgrounded. The dial loop runs while the app is
// foregrounded OR while the steady session is up under the foreground service +
// wakelock (so two backgrounded phones still sync, #43); the listener always
// answers regardless. The first kick is jittered so two phones that pair at the
// same instant don't dial each other on the exact same tick.

import { AppState, Platform } from "react-native";
import { runAntiEntropySession, loadVaultTrustAnchor } from "./anti-entropy";
import { ensureDeviceKey, getDevicePubkey } from "./device-key";
import {
  deriveRfcommUuid,
  dialBtcPeer,
  discoverAndConnect,
  startBtcListener,
  type BtcListenerHandle,
  type BtcMeshConnection,
} from "./transport-btc";
import {
  isBtClassicSupported,
  onBtStateChanged,
  setPairingActive,
} from "../../modules/kaata-bt-classic";
import { vaultDigest, advertiseDays, dayNumber } from "./vault-digest";
import { addKnownPeer, listKnownPeers } from "./btc-peers";
import { onLedgerApplied } from "../ledger-events";
import { markPeerSeen } from "./presence";
import { getDb } from "../db-tx";
import { getAppMeta } from "../db";
import { syncDiag } from "./sync-diag";

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
// Debounce for the DIAL half of push-on-write (coalesce an edit burst into one
// connect attempt for not-yet-connected peers). The WAKE half is NOT debounced —
// waking an already-warm session to push the edit has zero thrash cost, so it
// fires synchronously (see scheduleKick) for real-time latency.
const KICK_DEBOUNCE_MS = 150;
// Inquiry fallback for vaults with NO cached peer MAC. This is the BOOTSTRAP for
// the BT-MAC-asymmetry case: on modern Android the owner (accept-only side) can't
// learn the joiner's MAC (own MAC hidden; accept socket masked), so it has no peer
// to dial directly and MUST find the joiner by classic inquiry — then it learns
// the joiner's real MAC from that dialed connection and caches it (direct-dial
// forever after, like Briar). 45s (was 150s) so this first connection lands in
// ~tens of seconds, not minutes. Inquiry monopolizes the radio ~8-12s, but only
// runs while a vault is peerless — once a MAC is cached the vault drops out of the
// inquiry set, so the cost is bounded to the bootstrap window.
const INQUIRY_INTERVAL_MS = 45_000;
const INQUIRY_DISCOVERY_MS = 8_000;
// Steady sessions are now PERSISTENT (Briar-style): runAntiEntropySession keeps
// one handshaken conn open and loops sync rounds, bounded by its own per-round
// (ROUND_MAX_MS) and whole-session (SESSION_MAX_MS) caps + idle-close. A
// half-open peer is bounded by the handshake's own 10s recv timeouts.

/** Stable per-(vault,day) RFCOMM service UUID. Distinct domain prefix from the
 *  one-shot pair UUID (deriveRfcommUuid(shop_mode_token)) so a live pair window
 *  and steady-state never collide. */
function steadyUuid(vaultId: string, day: number): string {
  return deriveRfcommUuid("steady:" + vaultDigest(vaultId, day));
}

/**
 * Composite session-tracking key. A steady RFCOMM session is scoped to ONE
 * vault (its UUID is steadyUuid(vaultId,day) and runAntiEntropySession syncs
 * only opts.vaultId). Two phones that share MULTIPLE vaults must therefore keep
 * a SEPARATE warm session per vault for the same peer device — keying the dedup
 * / reservation / cooldown maps by deviceId alone starved every vault but the
 * first (the new-kaata "members show but contacts/ledger don't sync" bug:
 * a freshly-paired second vault loses the per-device dedup race to an already-
 * warm first vault's session and never gets dialed, while its cached peer keeps
 * it out of the peerless inquiry fallback too). LAN already keys its connection
 * map by `${deviceId}:${vaultId}` (lib/mesh/index.ts makeConnKey) — this mirrors
 * that so BTC steady syncs every shared vault, not just one.
 */
function connKey(vaultId: string, deviceId: string): string {
  return `${deviceId}:${vaultId}`;
}

/** Order-independent vault-set equality, for the idempotent-restart guard. */
function sameVaultSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
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
  /** connKey(vaultId,deviceId) → ms until which we skip dialing it (success
   *  cooldown / fail backoff). Keyed per (vault,peer) because a session is
   *  vault-scoped — see connKey. */
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
  /**
   * Live warm sessions, connKey(vaultId,deviceId) → { wake, close }. Briar-style:
   * a (vault,peer) with an open persistent anti-entropy session is NOT re-dialed
   * (dedupe); a local write wake()s it for immediate sync; pairing / stop
   * close()s it to free the single radio. Keyed per (vault,peer) — NOT per
   * deviceId — because a session syncs ONE vault, so a peer shared across two
   * vaults needs two independent warm sessions (the new-kaata sync bug; see
   * connKey). Populated post-handshake by runAntiEntropySession's onEstablished,
   * cleared when the session ends. Sessions run fire-and-forget (NOT awaited by
   * the dial pass), so they live outside the tickRunning window.
   */
  liveSessions: Map<string, { wake: () => void; close: () => void }>;
  /**
   * EVERY connection a session is running on — added before the handshake,
   * removed when the session ends. liveSessions only holds ESTABLISHED sessions
   * (post-handshake, deduped to one per peer), so pause/stop must close THIS set
   * to also catch mid-handshake conns and any displaced/duplicate conn that
   * never made it into liveSessions (else a stray conn holds the radio).
   */
  sessionConns: Set<BtcMeshConnection>;
  /**
   * connKey(vaultId,deviceId)s with a dial→handshake in progress (before the
   * session registers in liveSessions). Skipped by BOTH the backstop and push
   * dial paths so a local write mid-handshake doesn't open a duplicate socket to
   * the same (vault,peer). Keyed per (vault,peer) so a second vault's dial to the
   * same peer is NOT spuriously suppressed by an in-flight first-vault dial.
   */
  dialing: Set<string>;
  /**
   * AppState "change" subscription. On background→active we fire an immediate
   * catch-up dial (steadyTick) instead of waiting up to DIAL_INTERVAL_MS — and
   * it's the reliable trigger if an OEM throttled the background timer. Stored
   * here so stopBtcSteadySync can remove it (no leak across auto-resume restart).
   */
  appStateSub: { remove: () => void } | null;
  /**
   * Bluetooth adapter on/off subscription. When BT is toggled off then on, the
   * RFCOMM listeners die and the dial loop can't recover for minutes (15s dial →
   * 90s fail-backoff → 150s inquiry, and the dead listener is never re-bound). On
   * BT-on we fully restart steady sync (re-open listeners + re-dial) within ~ms,
   * like Briar. Stored so stop can remove it.
   */
  btStateSub: { remove: () => void } | null;
};

let steady: SteadyState | null = null;

// True while a steady session is fully up — which (verified) ONLY happens under
// Shop Mode + the foreground service + PARTIAL_WAKE_LOCK: startBtcSteadySync's
// only callers are startShopModeBody (index.ts startBtcSteadySync call) and the
// vault-set-change resync (notifyVaultSetChanged), both inside Shop Mode right
// next to the FGS start. So steadyRunning is a correct, reversible proxy for "the
// FGS is up" and is what lets runDialPass dial while backgrounded WITHOUT a
// foreground Activity (the #43 background-sync fix). Set true at the END of a
// successful startBtcSteadySync, false at the TOP of stopBtcSteadySync. If a
// future caller starts steady WITHOUT the FGS, gate this behind that — otherwise
// it would permit background dialing with no wakelock.
let steadyRunning = false;

// Last dial-pass summary emitted to the in-app diagnostic — only re-logged when
// the (known peers / peerless vaults) counts CHANGE, so a stable state logs once
// instead of every 15s tick (keeps the diag ring readable).
let lastDialSummary = "";

// Pause-for-pairing: a QR pair window needs EXCLUSIVE use of the single BT radio
// (its inquiry/dial). While paused, the steady dial loop + inquiry fallback
// short-circuit so they don't cross-cancel the pair's inquiry — the bug where a
// SECOND kaata (peerless → steady keeps inquiring it) failed to pair while the
// first kept syncing. Counter, not a bool, so overlapping host+join balance.
let pairPauseCount = 0;

// The vault set to (re)start steady with when the LAST pair window closes.
// non-null ⇒ "steady is intended to be running" — it's set when a pair window
// opens over a live steady session (captured in pauseBtcSteadyForPairing) OR when
// a startBtcSteadySync is requested WHILE paused (deferred, last-write-wins so a
// kaata created mid-pair is included). Cleared by resume after it restarts, and
// by stopBtcSteadySync (a real user toggle-off, so we don't auto-restart against
// an OFF intent). This is the heart of the pair-vs-sync radio handoff: steady's
// listener-churning restart is DEFERRED out of the pair window instead of
// re-grabbing the single BT radio mid-pair (the seesaw bug).
let pendingRestartVaultIds: string[] | null = null;

// How long pauseBtcSteadyForPairing waits for an in-flight steady tick to drop
// the radio before letting the pair inquiry start. The aborting inquiry bails
// within ~150ms of pairPauseCount going >0; this is just the safety ceiling.
const PAIR_RADIO_WAIT_MS = 4_000;

// Coalesce the steady restart after a pair. A RETRYING pair calls joinPairOverBtc
// (joiner) over and over — each call balances pause→resume, so steady would fully
// restart (close + reopen EVERY listener; 24 of them on a 12-vault test phone)
// between each ~1.5s retry. That restart's teardown closes the socket the peer
// JUST connected → "send/recv on closed BTC connection" kills both the steady
// session AND the pair handshake mid-flight (the restart-loop the diagnostics
// caught). Debounce: only restart once the pause/resume cycling actually STOPS
// (pairing settled). Must exceed the joiner's retry gap so a retry burst stays
// collapsed into a single restart.
const RESUME_RESTART_DEBOUNCE_MS = 2_500;
let resumeRestartTimer: ReturnType<typeof setTimeout> | null = null;

/** The LIVE chain-anchored vault set — the SAME query notifyVaultSetChanged uses
 *  (index.ts). Resume restarts from THIS, not a stashable pointer, so a nulled
 *  pendingRestartVaultIds can never swallow the restart (the "paired but never
 *  syncs" stranding). Briar's plugin just stays ACTIVE; this reconstructs that. */
async function listAnchoredVaultIds(): Promise<string[]> {
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM vaults WHERE archived_at IS NULL AND vault_trust_anchor_pubkey IS NOT NULL`,
    );
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/** True while the steady loop is fully up (listeners open + dial timer armed).
 *  Read by the shop-mode watchdog (index.ts) to self-heal a parked loop. */
export function isBtcSteadyRunning(): boolean {
  return steadyRunning;
}

/** True while a QR pair window owns the radio OR the post-pair restart is still
 *  settling (debounced). The watchdog must NOT restart steady in either case — it
 *  would cross-cancel the pair inquiry, or pre-empt the debounced restart and
 *  reintroduce the connection-killing flap. */
export function isBtcPairPaused(): boolean {
  return pairPauseCount > 0 || resumeRestartTimer !== null;
}

/**
 * Acquire the radio for a QR pair window. Increments the pause (so no NEW steady
 * pass starts) AND waits for any IN-FLIGHT steady tick to release the radio —
 * the in-flight inquiry sees pairPauseCount>0 via its shouldAbort and bails, but
 * we must wait for it to actually finish or the pair's startClassicDiscovery
 * races the steady inquiry's stopClassicDiscovery and both sweeps cancel each
 * other (the "no RFCOMM host found" failure once steady auto-resumes on launch).
 * async + awaited by the pair screens.
 */
export async function pauseBtcSteadyForPairing(): Promise<void> {
  // A new pair window is grabbing the radio — cancel any pending debounced
  // resume-restart so steady can't restart mid-pair (the connection-killing flap).
  if (resumeRestartTimer) {
    clearTimeout(resumeRestartTimer);
    resumeRestartTimer = null;
  }
  const firstPause = pairPauseCount === 0;
  pairPauseCount++;
  // Tell the NATIVE engine to yield the radio too (not just the JS steady loop).
  // The resident engine is otherwise only gated by the 10s liveness heartbeat;
  // during a pair we need a deterministic, immediate stop or its RFCOMM
  // accept/dial contends with the pair and the owner drops the joiner's socket
  // ("read ret -1"). Pairing gets the radio exclusively (Briar principle).
  if (firstPause) void setPairingActive(true).catch(() => {});
  const s = steady;
  if (!s) return;
  quiesceSessions(s);
  // On the FIRST pause only (overlapping host+join keep count>0): remember the
  // running vault set so the LAST resume restarts steady with it, then CLOSE the
  // steady RFCOMM LISTENERS. The old pause only quiesced SESSIONS and left the
  // per-(vault,day) accept loops running — on Android's single BT controller
  // those accept loops + the discovery-receiver register/unregister contend with
  // the pair flow's inquiry/discoverable, so the joiner intermittently can't find
  // or connect to the host ("no RFCOMM host found"). Fully yielding the radio
  // (listeners too) is what makes pairing reliable while sync is otherwise on.
  // (Count-gated: a 2nd overlapping pause must NOT re-capture an already-emptied
  // listener set or re-close.)
  if (firstPause) {
    pendingRestartVaultIds = s.vaultIds;
    // The loop is no longer truly "up" once we close the listeners — keep
    // steadyRunning ACCURATE so the shop-mode watchdog (index.ts) can tell a
    // parked loop from a healthy one (it skips while pairing, restarts otherwise).
    steadyRunning = false;
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
  // Wait for the in-flight tick AND every session conn to actually release the
  // single radio before the pair inquiry starts (a lingering RFCOMM socket or a
  // mid-handshake conn would cross-cancel the pair inquiry). The inquiry itself
  // yields via shouldAbort (pairPauseCount>0). Also bail if a new session opens
  // an inbound accept during the window — onEstablished refuses while paused.
  const deadline = Date.now() + PAIR_RADIO_WAIT_MS;
  while ((s.tickRunning || s.sessionConns.size > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** Wake + close EVERY session (established or mid-handshake) so they stop using
 *  the radio and unwind promptly. Used by pause-for-pairing and stop. */
function quiesceSessions(s: SteadyState): void {
  for (const sess of s.liveSessions.values()) {
    try {
      sess.wake(); // unblock a session parked in its inter-round wait
    } catch {
      /* */
    }
  }
  for (const conn of s.sessionConns) {
    try {
      void conn.close(); // closes established, mid-handshake, and duplicate conns
    } catch {
      /* */
    }
  }
}
export async function resumeBtcSteadyForPairing(): Promise<void> {
  pairPauseCount = Math.max(0, pairPauseCount - 1);
  if (pairPauseCount > 0) return; // another pair window still owns the radio
  // Last pair window closed → let the native engine use the radio again.
  void setPairingActive(false).catch(() => {});
  // DEBOUNCE the restart (the connection-killing-flap fix). A retrying pair cycles
  // pause→resume every ~1.5s; restarting steady on each resume tears down + reopens
  // every listener and closes the socket the peer just connected. Arm a timer
  // instead — the NEXT pause (next retry) cancels it, so the restart fires exactly
  // ONCE, after the retries stop and pairing has truly settled. Steady stays
  // cleanly DOWN during the whole pair window (radio free for the pair), then comes
  // back once.
  if (resumeRestartTimer) clearTimeout(resumeRestartTimer);
  resumeRestartTimer = setTimeout(() => {
    resumeRestartTimer = null;
    void doResumeRestart();
  }, RESUME_RESTART_DEBOUNCE_MS);
}

/** The actual post-pair steady restart, fired once the resume debounce settles.
 *  Restarts from the LIVE anchored-vault DB query (Briar-parity: never the
 *  stashable pendingRestartVaultIds pointer, which an interleaved stop could null
 *  and swallow — the "paired but never syncs" stranding). Respects a genuine
 *  shop_mode=OFF. Never throws (runs detached from a timer). */
async function doResumeRestart(): Promise<void> {
  if (pairPauseCount > 0) return; // a pair re-acquired the radio during the debounce
  pendingRestartVaultIds = null;
  let intent: string | null = null;
  try {
    intent = await getAppMeta("shop_mode_enabled");
  } catch {
    intent = "1"; // DB read failed — assume ON (safer to over-restart than strand)
  }
  if (intent !== "1") {
    syncDiag("pair done: shop mode OFF — steady stays down");
    return;
  }
  const vaultIds = await listAnchoredVaultIds();
  syncDiag(`pair done: resuming steady from DB (${vaultIds.length} vault(s))`);
  if (vaultIds.length === 0) return;
  try {
    await startBtcSteadySync({ vaultIds });
  } catch (err) {
    if (__DEV__) console.warn("[btc.steady] resume restart failed", err);
  }
}

/**
 * Start steady-state RFCOMM sync for the given chain-anchored vaults. Idempotent
 * (restarts cleanly). Android-only; no-ops elsewhere.
 */
export async function startBtcSteadySync(opts: { vaultIds: string[] }): Promise<void> {
  if (Platform.OS !== "android" || !isBtClassicSupported()) return;
  // A QR pair window owns the single BT radio. The normal restart below tears
  // down + RE-OPENS every RFCOMM listener (stopBtcSteadySync + openListeners),
  // which re-grabs the controller mid-pair and breaks the pair inquiry — the
  // pair-vs-sync seesaw. Defer: record the desired vault set (last-write-wins, so
  // a kaata created during the window is included) and return WITHOUT touching
  // the radio; resumeBtcSteadyForPairing runs exactly one restart with this set
  // once the last pair window closes. Triggers that hit this mid-pair:
  // notifyVaultSetChanged (vault create + both pair screens' post-sync) and the
  // MeshController shop_mode poll.
  if (pairPauseCount > 0) {
    pendingRestartVaultIds = opts.vaultIds;
    syncDiag("steady start DEFERRED (pair window owns radio)");
    return;
  }
  // IDEMPOTENT: if steady is ALREADY running this exact vault set with live
  // listeners, do NOT tear down + restart. The post-pair flow fires several restart
  // triggers (startShopMode, notifyVaultSetChanged, the debounced resume, the
  // watchdog); each redundant stop+start closes any connection mid-establishment —
  // at 1 vault that alone killed every dial ("read ret -1": the peer accepted, then
  // our restart — or theirs — dropped the socket). Briar never restarts an active
  // plugin; this matches that. A genuine vault-set change still restarts (set
  // differs); the BT-on handler still forces a real restart via stop()+start().
  if (
    steady &&
    !steady.stopped &&
    steadyRunning &&
    steady.listeners.length > 0 &&
    sameVaultSet(steady.vaultIds, opts.vaultIds)
  ) {
    syncDiag(`steady already running (${opts.vaultIds.length} vault(s)) — skip restart`);
    return;
  }
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
    liveSessions: new Map(),
    sessionConns: new Set(),
    dialing: new Set(),
    appStateSub: null,
    btStateSub: null,
  };
  steady = s;

  try {
    await ensureDeviceKey();
  } catch {
    /* handshake will fail loudly if the key truly isn't ready */
  }
  // A concurrent start/stop may have superseded us during the await above.
  if (steady !== s) return;
  // TOCTOU: a pair window may have opened DURING the awaits above (the top-of-
  // function pairPauseCount check can't catch a pause that lands mid-start — e.g.
  // host re-issue: stopHosting fire-and-forgets a resume restart, then the new
  // hostPairOverBtc pauses while this start is in flight). Bail + defer so we
  // don't proceed to open listeners on the radio mid-pair; resume restarts us.
  if (pairPauseCount > 0) {
    // Defer + tear down INLINE (not via stopBtcSteadySync, which nulls
    // pendingRestartVaultIds across its own awaited listener-stops — a window
    // where a concurrent resume could read it null and skip the restart, leaving
    // steady permanently off). Set the flag FIRST so any resume always sees it,
    // then close the listeners openListeners may have opened. At this point no
    // timer/firstKick/unsubLedger/appStateSub exists yet, so listeners + the two
    // module flags are all there is to undo.
    pendingRestartVaultIds = opts.vaultIds;
    const opened = s.listeners;
    s.listeners = [];
    steady = null;
    steadyRunning = false;
    for (const h of opened) {
      try {
        await h.stop();
      } catch {
        /* */
      }
    }
    return;
  }

  await openListeners(s);
  if (steady !== s) return; // superseded while opening listeners — openListeners cleaned up
  // Same TOCTOU guard AFTER openListeners: if a pair window opened while we were
  // opening RFCOMM servers, openListeners just grabbed the radio — undo it
  // (close the just-opened listeners inline + clear steady) and defer the restart
  // to the last resume.
  if (pairPauseCount > 0) {
    // Defer + tear down INLINE (not via stopBtcSteadySync, which nulls
    // pendingRestartVaultIds across its own awaited listener-stops — a window
    // where a concurrent resume could read it null and skip the restart, leaving
    // steady permanently off). Set the flag FIRST so any resume always sees it,
    // then close the listeners openListeners may have opened. At this point no
    // timer/firstKick/unsubLedger/appStateSub exists yet, so listeners + the two
    // module flags are all there is to undo.
    pendingRestartVaultIds = opts.vaultIds;
    const opened = s.listeners;
    s.listeners = [];
    steady = null;
    steadyRunning = false;
    for (const h of opened) {
      try {
        await h.stop();
      } catch {
        /* */
      }
    }
    return;
  }

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

  // Immediate catch-up dial on background→foreground: don't wait up to
  // DIAL_INTERVAL_MS for the next tick when the user reopens the app, and it's
  // the reliable trigger if an OEM throttled the background timer under Doze.
  // Runs the SAME serialized path the periodic timer runs. Removed on stop.
  s.appStateSub = AppState.addEventListener("change", (next) => {
    // pairPauseCount===0: don't even enter steadyTick on the focus-return after
    // requestDiscoverable's system dialog (which backgrounds then re-foregrounds
    // the app mid-pair). runDialPass also guards on pairPauseCount, but this skips
    // the work entirely during a pair window.
    if (next === "active" && steady === s && !s.stopped && pairPauseCount === 0) {
      void steadyTick(s);
    }
  });

  // Bluetooth back ON: the listeners died while BT was off and the dial loop
  // can't recover for minutes. Fully restart steady sync (re-open listeners +
  // re-dial) immediately, like Briar's transport-state reactivity. Captured
  // vaultIds because stop() nulls `steady`.
  s.btStateSub = onBtStateChanged((state) => {
    if (state !== "on") return;
    if (steady !== s || s.stopped || pairPauseCount > 0) return;
    const vaultIds = s.vaultIds;
    if (__DEV__) console.log("[btc.steady] BT back on — restarting steady sync");
    void (async () => {
      try {
        await stopBtcSteadySync();
        await startBtcSteadySync({ vaultIds });
      } catch (err) {
        if (__DEV__) console.warn("[btc.steady] BT-on restart failed", err);
      }
    })();
  });

  // Backstop: clear any stale native pairing-active flag. We only reach here with
  // pairPauseCount===0 (every pair-window path returned above), so no pair is in
  // progress — this self-heals a flag left set by a pair that was killed before
  // its resume ran (which would otherwise keep the native engine off forever).
  void setPairingActive(false).catch(() => {});

  // Mark the steady session fully up. Reached ONLY on a successful start (every
  // superseded path returned above), and every start is under Shop Mode + the
  // FGS — so this is a safe proxy for "the wakelock is held" that lets
  // runDialPass dial while backgrounded (#43). Cleared in stopBtcSteadySync.
  steadyRunning = true;

  syncDiag(`steady RUNNING: ${opts.vaultIds.length} vault(s), ${s.listeners.length} listener(s)`);
  if (__DEV__)
    console.log("[btc.steady] started", {
      vaults: opts.vaultIds.length,
      listeners: s.listeners.length,
    });
}

/**
 * Force the pair-pause balance to zero. Called on a genuine teardown (Nearby sync
 * toggled off / background handoff): a pair pause whose resume was missed (an
 * interrupted/abandoned attempt) would otherwise keep steady parked until the
 * 360s safety timer. A full teardown means no pair screen is live, so a hard reset
 * is safe and removes the minutes-long stall. Also clears the native pause gate.
 */
export function resetPairPause(): void {
  pairPauseCount = 0;
  void setPairingActive(false).catch(() => {});
}

/** Stop steady-state sync (idempotent). In-flight sessions drain on their own. */
export async function stopBtcSteadySync(): Promise<void> {
  const s = steady;
  steady = null;
  // No steady session is up → background dialing is no longer permitted. Cleared
  // FIRST (next to steady=null) so a superseded/failed start never leaves the
  // background-dial gate open without a live session + wakelock.
  steadyRunning = false;
  // A real stop (user toggle-off via teardownRadios) clears any deferred
  // pair-resume restart so we don't auto-restart steady against an OFF intent.
  // (The resume-driven restart path already captured + nulled this before calling
  // startBtcSteadySync, so this never eats a legitimate restart.)
  pendingRestartVaultIds = null;
  if (!s) return;
  s.stopped = true;
  if (s.appStateSub) {
    s.appStateSub.remove();
    s.appStateSub = null;
  }
  if (s.btStateSub) {
    s.btStateSub.remove();
    s.btStateSub = null;
  }
  // Wake + close every session conn promptly so radios don't linger after stop.
  quiesceSessions(s);
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
    // pairPauseCount>0: a pair window opened mid-open — stop grabbing the radio
    // with more RFCOMM servers. The caller (startBtcSteadySync) re-checks after
    // and closes whatever we opened + defers the restart to the last resume.
    if (s.stopped || steady !== s || pairPauseCount > 0) break;
    const anchor = await loadVaultTrustAnchor(vaultId);
    if (!anchor) continue;
    for (const day of advertiseDays(now)) {
      if (s.stopped || steady !== s || pairPauseCount > 0) break;
      try {
        const handle = await startBtcListener({
          serviceName: STEADY_SERVICE_NAME,
          uuid: steadyUuid(vaultId, day),
          onConnection: (conn) => {
            // Refuse inbound steady sessions while stopping / superseded / in a QR
            // pair window — the single radio is reserved for pairing, and we don't
            // want even the handshake's I/O competing with the pair inquiry.
            if (s.stopped || steady !== s || pairPauseCount > 0) {
              try {
                void conn.close();
              } catch {
                /* */
              }
              return;
            }
            void runSteadySession(s, conn, vaultId, anchor, { isOutbound: false });
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

/** Push pass — DIAL any known peer NOT already in a warm session, bypassing the
 *  success cooldown. Warm sessions were already woken SYNCHRONOUSLY in
 *  scheduleKick (so the edit pushes instantly); re-waking here would only burn an
 *  extra empty round, so this path is dial-only. */
async function kickTick(s: SteadyState): Promise<void> {
  await runDialPass(s, false);
}

/** Schedule a push after a local write. The WAKE of warm sessions fires NOW
 *  (real-time, zero thrash); only the DIAL of not-yet-connected peers is
 *  debounced to coalesce edit bursts. */
function scheduleKick(s: SteadyState): void {
  if (s.stopped || steady !== s) return;
  // Real-time path: push the edit over every already-open warm session
  // immediately — do NOT make it wait on the dial debounce.
  for (const sess of s.liveSessions.values()) {
    try {
      sess.wake();
    } catch {
      /* */
    }
  }
  if (s.kickDebounce) return;
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
  // A QR pair window owns the radio — don't dial/inquire and cross-cancel it.
  if (pairPauseCount > 0) return;
  // Dial while foregrounded OR while a steady session is up under the FGS +
  // PARTIAL_WAKE_LOCK (#43 background sync). Previously this was foreground-only,
  // so a backgrounded phone NEVER initiated — two backgrounded phones never
  // synced, and a reopened phone could only be reached, not reach. steadyRunning
  // is true ONLY under Shop Mode's foreground service, so we never dial on the
  // radio without a wakelock. MUST stay AFTER the pairPauseCount guard above:
  // moving it earlier would let a backgrounded host dial mid-pair and
  // cross-cancel the joiner's inquiry (the "no RFCOMM host found" regression).
  if (AppState.currentState !== "active" && !steadyRunning) return;
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
    let knownCount = 0;
    for (const vaultId of s.vaultIds) {
      if (s.stopped || steady !== s) break;
      const anchor = await loadVaultTrustAnchor(vaultId);
      if (!anchor) continue;
      const peers = await listKnownPeers(vaultId);
      knownCount += peers.length;
      if (peers.length === 0) peerless.push(vaultId);
      for (const peer of peers) {
        if (s.stopped || steady !== s) break;
        // Already in a warm session OR mid dial→handshake for THIS (vault,peer) —
        // don't open a second conn. This guard holds for BOTH the backstop and
        // push paths (a local write must not double-dial a peer whose session is
        // still establishing). Keyed per (vault,peer): a session syncs ONE vault,
        // so a peer already warm on vault A must STILL be dialed for vault B
        // (the new-kaata sync bug — keying on deviceId alone starved every vault
        // but the first). See connKey.
        const key = connKey(vaultId, peer.deviceId);
        if (s.liveSessions.has(key) || s.dialing.has(key)) continue;
        if (respectCooldown && now < (s.skipUntil.get(key) ?? 0)) continue;
        await dialKnownPeer(s, vaultId, anchor, peer.deviceId, peer.mac);
      }
    }

    // Diagnostic heartbeat: proves the dial loop is alive and shows whether it has
    // a dialable peer. Only emitted on change so it doesn't flood the ring.
    const summary = `dial pass: vaults=${s.vaultIds.length} knownPeers=${knownCount} peerless=${peerless.length} live=${s.liveSessions.size}`;
    if (summary !== lastDialSummary) {
      lastDialSummary = summary;
      syncDiag(summary);
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
      // Yield the radio the instant a QR pair window opens (steady is the
      // low-priority radio user). Without this the in-flight steady inquiry
      // cross-cancels the pair inquiry -> "no RFCOMM host found".
      shouldAbort: () => pairPauseCount > 0,
    });
  } catch {
    syncDiag(`inquiry: no co-member found v=${vaultId.slice(0, 6)}`);
    return; // no co-member found this sweep — retry after INQUIRY_INTERVAL_MS
  }
  syncDiag(`inquiry: found + dialing v=${vaultId.slice(0, 6)}`);
  if (s.stopped || steady !== s) {
    try {
      await conn.close();
    } catch {
      /* */
    }
    return;
  }
  // Fire-and-forget (persistent session) so the dial pass / inquiry sweep isn't
  // blocked for the session's lifetime. onEstablished caches the MAC, so the
  // vault stops being "peerless" and this inquiry path won't re-connect it.
  void runSteadySession(s, conn, vaultId, anchor, { isOutbound: true });
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
    } catch (err) {
      // Diagnostic: a dial that fails to even CONNECT (vs a handshake failure,
      // which shows as "session FAILED"). If every dial lands here with knownPeers>0
      // and no "✓ CONNECTED", the listener side isn't answering — usually too many
      // RFCOMM/SDP records (one per vault×day) for the radio to register.
      syncDiag(
        `dial✗ v=${vaultId.slice(0, 6)} peer=${deviceId.slice(0, 6)} d+${day - d}: ${(err as Error)?.message?.slice(0, 28) ?? "connect failed"}`,
      );
      continue; // peer not listening on this day's UUID — try the next
    }
    syncDiag(`dial→ connected v=${vaultId.slice(0, 6)} peer=${deviceId.slice(0, 6)}, handshaking`);
    // Connected. Reserve THIS (vault,peer) (dialing) so a concurrent
    // push/backstop pass won't open a second socket while we handshake; set a
    // cooldown too; then run the session FIRE-AND-FORGET so the dial pass moves
    // on to other peers instead of blocking for the whole (persistent,
    // minutes-long) session. The reservation + skipUntil are cleared in
    // runSteadySession's finally. Reservation is per (vault,peer) so a dial for a
    // DIFFERENT vault to the same peer isn't suppressed (the new-kaata sync bug).
    const key = connKey(vaultId, deviceId);
    s.dialing.add(key);
    s.skipUntil.set(key, Date.now() + PEER_COOLDOWN_MS);
    void runSteadySession(s, conn, vaultId, anchor, {
      isOutbound: true,
      dialReservation: key,
    });
    return;
  }
  // Couldn't reach this peer on any advertised day — back off longer (this
  // (vault,peer) only; the peer may still be reachable for another vault's UUID).
  s.skipUntil.set(connKey(vaultId, deviceId), Date.now() + FAILURE_BACKOFF_MS);
}

/**
 * Run a PERSISTENT (Briar-style) anti-entropy session over a connected socket:
 * one handshake, then loop sync rounds until idle / session cap / stop. Used by
 * BOTH the dialer (dialKnownPeer / inquireForPeer, dialReservation set) and the
 * listener-accepter (dialReservation undefined). Always closes the conn.
 *
 * opts.isOutbound: did WE dial (true) or accept (false)? Drives the both-dial
 * tie-break. opts.dialReservation: the connKey(vaultId,deviceId) the DIAL path
 * reserved in s.dialing (so a concurrent push can't double-dial); cleared in the
 * finally — also the key for connect-but-handshake-fail backoff
 * (conn.remoteDeviceId is null then).
 */
async function runSteadySession(
  s: SteadyState,
  conn: BtcMeshConnection,
  vaultId: string,
  anchor: Uint8Array,
  opts: { isOutbound: boolean; dialReservation?: string },
): Promise<void> {
  const { isOutbound, dialReservation } = opts;
  // suppressFailures mutes the transport's global failure toast for a background
  // sync the user can't see; a genuine error still rejects (logged below).
  conn.suppressFailures = true;
  // Track EVERY session conn so pause/stop can close it even if it never
  // registers in liveSessions (mid-handshake, or a deduped duplicate).
  s.sessionConns.add(conn);
  const closeConn = () => {
    try {
      void conn.close();
    } catch {
      /* */
    }
  };
  let establishedKey: string | null = null;
  let myEntry: { wake: () => void; close: () => void } | null = null;
  let handshakeSucceeded = false;
  try {
    const r = await runAntiEntropySession(
      conn,
      { vaultId, vaultTrustAnchorPubkey: anchor },
      {
        onEstablished: (deviceId, peerPubkeyB64, wake) => {
          // Reached post-handshake => peer is reachable + authenticated. Mark it
          // so the catch below doesn't apply connect-failure backoff even if we
          // close the conn here (a deliberate dedup/pause close, not a failure).
          handshakeSucceeded = true;
          // Don't keep a session alive if we're stopping / superseded / in a QR
          // pair window — closing the conn makes the loop's first send throw and
          // unwind, freeing the single radio for pairing.
          if (s.stopped || steady !== s || pairPauseCount > 0) {
            closeConn();
            return;
          }
          // ONE warm session per (vault,peer). On a both-dial race two sockets
          // exist FOR THE SAME VAULT (our outbound + an inbound accept). Pick
          // deterministically so BOTH devices keep the SAME socket: keep the one
          // DIALED by the smaller device pubkey. (winner direction = outbound iff
          // ourPubkey<peerPubkey, else inbound.) Without this, each side could
          // close a different socket and kill both, forcing a reconnect. The
          // dedup is per (vault,peer): a session for vault B to the same peer is
          // a DIFFERENT key and must NOT collide with vault A's warm session.
          const ownPubkey = getDevicePubkey() ?? "";
          const thisIsWinner = isOutbound ? ownPubkey < peerPubkeyB64 : peerPubkeyB64 < ownPubkey;
          const key = connKey(vaultId, deviceId);
          const existing = s.liveSessions.get(key);
          if (existing) {
            if (!thisIsWinner) {
              closeConn(); // the other socket is the keeper
              return;
            }
            existing.close(); // we're the keeper — drop the duplicate
          }
          establishedKey = key;
          myEntry = {
            wake,
            // close() also wakes so a session parked in its inter-round wait
            // unwinds immediately (prompt radio handoff on pause/stop).
            close: () => {
              try {
                wake();
              } catch {
                /* */
              }
              closeConn();
            },
          };
          s.liveSessions.set(key, myEntry);
          syncDiag(
            `✓ CONNECTED v=${vaultId.slice(0, 6)} peer=${deviceId.slice(0, 6)} ${isOutbound ? "(we dialed)" : "(accepted)"}`,
          );
          markPeerSeen(deviceId); // presence: this device is reachable now
          // Cache the MAC AS SOON AS the peer is identified so a peerless vault
          // becomes non-peerless for the session's lifetime — otherwise the
          // inquiry fallback would keep re-connecting the same peer (dup session).
          if (conn.remoteMac) {
            void addKnownPeer({ vaultId, deviceId, mac: conn.remoteMac }).catch(() => {});
          }
        },
        shouldStop: () => s.stopped || steady !== s,
      },
    );
    if (conn.remoteDeviceId) {
      // Cooldown is per (vault,peer): this session synced only THIS vault, so
      // another vault's dial to the same peer must not be cooled down by it.
      s.skipUntil.set(connKey(vaultId, conn.remoteDeviceId), Date.now() + PEER_COOLDOWN_MS);
      markPeerSeen(conn.remoteDeviceId);
      // Self-heal the MAC mapping (e.g. peer first learned via an inbound accept).
      // addKnownPeer skips the write when the MAC is unchanged, so this is cheap.
      if (conn.remoteMac) {
        await addKnownPeer({ vaultId, deviceId: conn.remoteDeviceId, mac: conn.remoteMac });
      }
    }
    syncDiag(`sync round v=${vaultId.slice(0, 6)} sent=${r.sent} recv=${r.received}`);
    if (__DEV__)
      console.log("[btc.steady] session ended", {
        vault: vaultId.slice(0, 8),
        sent: r.sent,
        recv: r.received,
        peer: r.peerDeviceId.slice(0, 8),
        durationMs: r.durationMs,
      });
  } catch (err) {
    syncDiag(`✗ session FAILED v=${vaultId.slice(0, 6)}: ${(err as Error).message.slice(0, 44)}`);
    if (__DEV__) console.warn("[btc.steady] session failed:", (err as Error).message);
    // Connected but the HANDSHAKE failed (peer outdated / removed / AEAD missing).
    // conn.remoteDeviceId is null here, so back off on the dialed deviceId instead
    // of hammering a guaranteed-failing peer every backstop tick + every push.
    if (!handshakeSucceeded && dialReservation) {
      s.skipUntil.set(dialReservation, Date.now() + FAILURE_BACKOFF_MS);
    }
  } finally {
    if (dialReservation) s.dialing.delete(dialReservation);
    s.sessionConns.delete(conn);
    // Deregister ONLY our own entry — a both-dial race may have replaced it with
    // a newer session for the same (vault,peer); don't evict that one.
    if (establishedKey && s.liveSessions.get(establishedKey) === myEntry) {
      s.liveSessions.delete(establishedKey);
    }
    try {
      await conn.close();
    } catch {
      /* */
    }
  }
}
