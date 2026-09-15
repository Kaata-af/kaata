// apps/mobile/lib/mesh/device-key.ts
//
// Phase 5: per-device Ed25519 identity for mesh sync and event signing.
//
// Each install owns ONE Ed25519 keypair that uniquely identifies the
// physical device. The private seed lives in expo-secure-store (Android
// Keystore / iOS Keychain — hardware-backed where available); the public
// key is mirrored into app_meta for fast synchronous reads (no SecureStore
// round-trip on every event signature header).
//
// THE TWO HALVES CAN DRIFT APART, and this module is the only place that
// notices. app_meta lives in kaata.db, which plugins/withBackupRules.js
// deliberately includes in Android Auto Backup + device-to-device transfer;
// the SecureStore prefs are deliberately EXCLUDED (Keystore-wrapped values
// cannot be decrypted on another device). A restored, transferred or
// reinstalled-with-backup Android phone therefore boots with the pubkey
// mirror present and the private seed gone. expo-secure-store also returns
// null (not a throw) when the Keystore key was permanently invalidated
// (lock-screen changes on some OEMs). Before this module validated the pair,
// ensureDeviceKey() trusted the mirror, every local event write reached
// signWithDeviceKey() INSIDE the SQLite transaction, hit a plain Error,
// rolled back, and the shopkeeper saw "Couldn't save. Try again." on every
// contact and every tally, forever (reported 2026-09-02: an Australian
// contact "isn't being saved for no reason").
//
// Lifecycle:
//   - ensureDeviceKey() is the single cold-path entry. It reads the mirror,
//     reads SecureStore, and REPAIRS any disagreement (loadOrRepairDeviceKey):
//       * no mirror (fresh install / wiped app_meta) → generate.
//       * mirror + seed that derives to it → warm both caches (common case).
//       * mirror + seed for a DIFFERENT pubkey → ADOPT the seed. Convergent:
//         a repair whose app_meta half rolled back, or the old double-
//         generation race, is healed without minting a third key.
//       * mirror + missing / undecodable seed → generate and RETIRE the
//         mirrored pubkey (the restored-phone case).
//     Concurrent callers share one in-flight promise: two concurrent cold
//     calls on a fresh install used to generate two keypairs and persist one
//     half of each. A SecureStore READ that throws never repairs anything — a
//     locked iOS keychain or a Keystore hiccup is transient, and rotating on
//     it would destroy a good key — except when it has thrown on three
//     consecutive foreground launches/saves (a Keystore blob that can never
//     be decrypted again), which is treated as a lost seed. Repairs are
//     refused while the shared SQLite connection has a transaction open:
//     setAppMeta is a bare statement on that connection, so the write would
//     silently join (and roll back with) whatever transaction is open. The
//     probe is re-taken immediately around the app_meta write; if a
//     transaction slipped in between, the caches stay cold and the NEXT call
//     converges through the adopt branch (the seed is already on disk).
//     Code that runs inside applyEvent or the sweep therefore uses the
//     read-only accessors (readOwnDevicePubkeys / isOwnDevicePubkey), never
//     ensureDeviceKey.
//   - getDeviceSigner() is what applyEvent uses: a {pubkey, sign} snapshot
//     closed over the loaded seed, taken OUTSIDE the transaction, so the
//     in-transaction signature can neither race clearDeviceKey() nor stamp a
//     pubkey from a different generation than the key that signed.
//   - Retired pubkeys stay in app_meta. Everything that identifies "this
//     device" by its key — the `local:` account sentinel
//     (lib/trust/account-id.ts), vaults.vault_trust_anchor_pubkey, the
//     LOCAL-only role-gate carve-outs — keeps recognising vaults and
//     membership rows minted under a rotated-away key. REMOTE signature
//     verification never consults this list.
//   - After a rotation the backend must learn the new key
//     (device_key_reregister_pending → registerDeviceKey() on the next
//     check-in / sign-in) and, when signed in, the membership chain must
//     re-bind it (device_key_rebind_pending → lib/trust/backfill.ts).
//
// The backend's /v1/devices/register-key endpoint UPSERTs by install_id,
// so re-registration on every sign-in (defensive) is a free no-op once
// the row exists.

// @noble/ed25519 v2 Hermes shims — INLINED at the top of this module
// because vault/new.tsx imports device-key.ts directly (not via the mesh
// barrel) and Metro HMR doesn't reliably pick up side-effect-only modules.
// Both shims are idempotent — re-importing this file just reassigns the
// same functions; no double-init hazard.
import { sha512 } from "@noble/hashes/sha512";
import { etc as _ed25519etc } from "@noble/ed25519";
import * as _ExpoCrypto from "expo-crypto";
_ed25519etc.sha512Sync = (...m: Uint8Array[]) => sha512(_ed25519etc.concatBytes(...m));
// Hermes has no globalThis.crypto.getRandomValues — wire expo-crypto's
// getRandomBytes (backed by SecureRandom on Android, SecRandomCopyBytes on iOS).
_ed25519etc.randomBytes = (len?: number) => _ExpoCrypto.getRandomBytes(len ?? 32);

import * as ed25519 from "@noble/ed25519";
import * as SecureStore from "expo-secure-store";

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import { getAppMeta, setAppMeta } from "../db";
import { getDb } from "../db-tx";

// SecureStore key for the 32-byte Ed25519 private seed (base64). Naming
// is namespaced ("kaata_mesh_") so a future second keypair (e.g. a
// vault-binding key) doesn't collide.
const SECURE_PRIVKEY_KEY = "kaata_mesh_device_privkey";

// app_meta key mirroring the base64-encoded 32-byte public key. Read
// synchronously by mesh handshake / chain code paths that can't afford a
// SecureStore round-trip.
const META_PUBKEY_KEY = "mesh_device_ed25519_pubkey";

// app_meta bookkeeping for repairs. Only the retired list is load-bearing
// (identity resolution); the rest feeds the App health report and the two
// pending flags consumed by check-in (re-register) and the chain backfill
// (re-bind).
export const META_RETIRED_PUBKEYS_KEY = "retired_device_pubkeys";
const META_ROTATED_AT_KEY = "device_key_rotated_at";
const META_ROTATION_COUNT_KEY = "device_key_rotation_count";
export const META_REREGISTER_PENDING_KEY = "device_key_reregister_pending";
export const META_REBIND_PENDING_KEY = "device_key_rebind_pending";
// Consecutive foreground launches / saves on which the SecureStore READ threw.
// A single throw is transient (locked keychain, Keystore hiccup) and must not
// rotate; three in a row across separate processes is the permanently-broken
// Keystore blob, which is otherwise a forever-failing device.
const META_READ_FAILURES_KEY = "device_key_read_failures";
const READ_FAILURES_BEFORE_ROTATE = 3;

// Rotations are rare (one per lost keystore), so this is a hygiene bound,
// not a budget. Eviction never drops a pubkey that is still a live vault's
// trust anchor — that entry is exactly the one the local carve-outs need.
const RETIRED_CAP = 64;

export type DeviceKeyUnavailableReason =
  | "read_failed"
  | "write_failed"
  | "in_transaction"
  | "missing";

// Typed failure for "no usable signing key right now". applyEvent maps it to
// EventSigningUnavailableError so the save handlers show the actionable
// "couldn't prepare a secure save" copy instead of the generic one. `reason`
// tells the App health report which of the four cases it was.
export class DeviceKeyUnavailableError extends Error {
  readonly kind = "device_key_unavailable" as const;
  readonly reason: DeviceKeyUnavailableReason;
  constructor(reason: DeviceKeyUnavailableReason, message: string, cause?: unknown) {
    super(message);
    this.name = "DeviceKeyUnavailableError";
    this.reason = reason;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

// Snapshot handed to applyEvent: the pubkey to stamp and a sign function
// bound to the seed that derives to it. Immune to later cache clears.
export type DeviceSigner = {
  pubkey_b64: string;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
};

export type RegisterDeviceKeyResult = "registered" | "no_session" | "failed";

// Process-local cache of the private key bytes. Populated by the cold path
// of ensureDeviceKey(), dropped on process exit. Holding raw bytes in JS
// memory is fine — Hermes runs in our app's sandbox; anything that can read
// this can already read SecureStore.
let _cachedPrivkey: Uint8Array | null = null;

// Process-local cache of the public key (base64) so getDevicePubkey() is
// truly synchronous after the first ensureDeviceKey() resolution. Only ever
// set together with _cachedPrivkey (pubkey cached ⇒ seed cached and verified).
let _cachedPubkeyB64: string | null = null;

// Process-local copy of app_meta.retired_device_pubkeys (oldest first).
let _cachedRetired: string[] | null = null;

// Single in-flight cold path. Every concurrent caller awaits the same
// promise, so at most one generation / repair runs per process.
let _inFlight: Promise<{ pubkey_b64: string }> | null = null;

// Why the last cold path failed (for the App health report), and whether this
// process already counted a read failure (at most one per launch).
let _lastFailure: DeviceKeyUnavailableReason | null = null;
let _readFailureCountedThisProcess = false;

// -------------------- base64 helpers --------------------

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // btoa is shipped by Hermes on RN >= 0.74 (we're on 0.86).
  // eslint-disable-next-line no-undef
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  // eslint-disable-next-line no-undef
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// A stored seed is usable only if it decodes to exactly 32 bytes. Anything
// else (truncated write, foreign value under our key) is "present but
// corrupt" — a permanent condition, handled like a missing seed.
function decodeSeed(b64: string): Uint8Array | null {
  try {
    const bytes = b64ToBytes(b64);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

// SYNC getPublicKey — relies on the sha512Sync shim above. The async
// variant uses crypto.subtle, which is undefined in Hermes.
function derivePubkeyB64(seed: Uint8Array): string | null {
  try {
    return bytesToB64(ed25519.getPublicKey(seed));
  } catch {
    return null;
  }
}

function looksLikePubkey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return b64ToBytes(value).length === 32;
  } catch {
    return false;
  }
}

function parseRetired(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) if (looksLikePubkey(v) && !out.includes(v)) out.push(v);
    return out;
  } catch {
    return [];
  }
}

// True while the shared connection has an open transaction. A repair's
// app_meta writes issued now would join that transaction; refuse instead
// (see loadOrRepairDeviceKey). Tolerates handles without the probe (tests).
function connectionInTransaction(db: unknown): boolean {
  try {
    const probe = (db as { isInTransactionSync?: () => boolean }).isInTransactionSync;
    return typeof probe === "function" ? probe.call(db) === true : false;
  } catch {
    return false;
  }
}

// One statement, so the rows land (or roll back) together — never a mirror
// without its retired list, or a retired list without the new mirror.
//
// The transaction probe is taken again right here, on both sides of the
// statement: the caller's earlier probe is stale by the time the SecureStore
// round-trip and the bookkeeping reads have completed, and a transaction
// opened in that window (the launch sweep, a sync pull, any db.ts block)
// would make this bare statement join it. A join is invisible to us, so the
// only safe answer is to treat "a transaction is open now" as failure: the
// caller leaves its caches cold, and the next cold path — with the seed
// already on disk — converges through the adopt branch.
async function writeAppMetaBatch(entries: Array<[string, string]>): Promise<void> {
  const db = await getDb();
  const refuse = () =>
    new DeviceKeyUnavailableError(
      "in_transaction",
      "a SQLite transaction opened while the device key was being repaired; retry outside it",
    );
  if (connectionInTransaction(db)) throw refuse();
  const placeholders = entries.map(() => "(?, ?)").join(", ");
  try {
    await db.runAsync(
      `INSERT INTO app_meta (key, value) VALUES ${placeholders}
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ...entries.flat(),
    );
  } catch (err) {
    throw new DeviceKeyUnavailableError(
      "write_failed",
      "could not persist the device key mirror; the key will be re-validated on the next attempt",
      err,
    );
  }
  if (connectionInTransaction(db)) throw refuse();
}

// Dedupe, append newest-last, and evict beyond the cap — but never a pubkey
// that is still some vault's trust anchor. If the anchors cannot be read,
// nothing is evicted: an over-long list costs bytes, evicting a live anchor
// costs the owner their own vault's carve-outs.
async function appendRetired(retired: string[], pubkeyB64: string): Promise<string[]> {
  const next = retired.filter((p) => p !== pubkeyB64);
  next.push(pubkeyB64);
  if (next.length <= RETIRED_CAP) return next;
  let anchors: Set<string>;
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<{ k: string }>(
      `SELECT DISTINCT vault_trust_anchor_pubkey AS k FROM vaults
        WHERE vault_trust_anchor_pubkey IS NOT NULL`,
    );
    anchors = new Set(rows.map((r) => r.k));
  } catch {
    return next;
  }
  for (let i = 0; i < next.length && next.length > RETIRED_CAP; ) {
    if (anchors.has(next[i])) i++;
    else next.splice(i, 1);
  }
  return next;
}

// Generate the 32-byte seed ourselves via expo-crypto.
//
// We can NOT use ed25519.utils.randomPrivateKey() — @noble/ed25519 v2
// hardcodes a closure-local randomBytes() that calls crypto.getRandomValues,
// which is undefined in Hermes. The exported etc.randomBytes IS reassignable
// (and we do shim it at the top of this file for other call paths), but
// utils.randomPrivateKey reaches the closure-local function NOT etc, so the
// shim doesn't affect it. Bypass entirely with expo-crypto's CSPRNG.
//
// SecureStore is written FIRST. If it fails nothing changes; if the app_meta
// write that follows fails, the next cold path finds a seed for a pubkey the
// mirror doesn't know and ADOPTS it — no third key, nothing lost.
async function generateAndStoreSeed(): Promise<{ priv: Uint8Array; pubB64: string }> {
  const priv = _ExpoCrypto.getRandomBytes(32);
  const pubB64 = derivePubkeyB64(priv);
  if (!pubB64) throw new DeviceKeyUnavailableError("missing", "could not derive a device pubkey");
  try {
    await SecureStore.setItemAsync(SECURE_PRIVKEY_KEY, bytesToB64(priv));
  } catch (err) {
    throw new DeviceKeyUnavailableError(
      "write_failed",
      "SecureStore refused to store the device key; nothing was changed",
      err,
    );
  }
  return { priv, pubB64 };
}

// -------------------- public API --------------------

// Ensures the device has an Ed25519 keypair whose two halves agree, generating
// or repairing as needed (see the header). Returns the base64-encoded public
// key (32 bytes raw → 44 chars base64) for callers that want to immediately
// POST it to the backend.
//
// Idempotent and safe to call from every boot path (the root layout, auth.ts
// after sign-in, BackgroundCheckIn, createSelfProfile, the mesh handshake,
// applyEvent's pre-warm). Warm calls are a synchronous cache hit. Throws
// DeviceKeyUnavailableError (typed) when the key genuinely cannot be made
// ready right now; never throws for a healthy device.
export async function ensureDeviceKey(opts?: {
  // True for user-driven paths (boot, a save). Only those count a thrown
  // SecureStore read toward the rotate-after-N threshold: a background task
  // running while the phone is locked must not push a healthy device over it.
  interactive?: boolean;
}): Promise<{ pubkey_b64: string }> {
  if (_cachedPubkeyB64 && _cachedPrivkey) return { pubkey_b64: _cachedPubkeyB64 };
  if (_inFlight) return _inFlight;
  // The tracked promise clears itself once settled (resolved OR rejected —
  // a failed attempt must not be memoised, the next call re-validates).
  const run: Promise<{ pubkey_b64: string }> = loadOrRepairDeviceKey(opts?.interactive === true)
    .then((r) => {
      _lastFailure = null;
      return r;
    })
    .catch((err: unknown) => {
      if (err instanceof DeviceKeyUnavailableError) _lastFailure = err.reason;
      throw err;
    })
    .finally(() => {
      if (_inFlight === run) _inFlight = null;
    });
  _inFlight = run;
  return run;
}

async function loadOrRepairDeviceKey(interactive: boolean): Promise<{ pubkey_b64: string }> {
  const db = await getDb();
  const mirroredRaw = await getAppMeta(META_PUBKEY_KEY);
  // A mirror that is not a 32-byte key (corrupt app_meta) is treated as
  // absent: nothing to retire, no identity ever hung off it.
  const mirrored = looksLikePubkey(mirroredRaw) ? mirroredRaw : null;
  const retired = parseRetired(await getAppMeta(META_RETIRED_PUBKEYS_KEY));
  _cachedRetired = retired;

  // The ONE SecureStore read. A throw here is normally transient (iOS returns
  // nil only for "not found" and throws for a locked keychain; Android
  // returns null for a missing entry, an invalidated Keystore key and an
  // undecryptable value, but throws DecryptException for a corrupt key blob
  // or an unparseable pref). Repairing on a single throw would overwrite a
  // key that reads fine seconds later, so one throw changes nothing. The
  // Android corrupt-blob case is permanent, though: after
  // READ_FAILURES_BEFORE_ROTATE consecutive foreground failures across
  // separate launches the seed is treated as lost and repaired below.
  let seedB64: string | null;
  let seedLost = false;
  try {
    seedB64 = await SecureStore.getItemAsync(SECURE_PRIVKEY_KEY);
  } catch (err) {
    const failures = await countReadFailure(interactive, db);
    if (!(mirrored && failures >= READ_FAILURES_BEFORE_ROTATE && !connectionInTransaction(db))) {
      throw new DeviceKeyUnavailableError(
        "read_failed",
        `SecureStore read failed (${failures} consecutive); the device key was left untouched`,
        err,
      );
    }
    console.warn(
      `[device-key] SecureStore read failed on ${failures} consecutive launches; treating the seed as lost`,
    );
    seedB64 = null;
    seedLost = true;
  }
  const seed = seedB64 ? decodeSeed(seedB64) : null;
  const seedPub = seed ? derivePubkeyB64(seed) : null;

  // Healthy device — the only path that runs on a normal launch.
  if (mirrored && seed && seedPub === mirrored) {
    _cachedPrivkey = seed;
    _cachedPubkeyB64 = mirrored;
    void clearReadFailures(db);
    return { pubkey_b64: mirrored };
  }

  // Every remaining branch WRITES. Refuse inside a transaction: the writes
  // would join it and disappear with its rollback, leaving SecureStore and the
  // mirror disagreeing again. The next out-of-transaction call (applyEvent's
  // pre-warm, the boot check, check-in) performs the repair. writeAppMetaBatch
  // re-probes around the statement itself.
  if (connectionInTransaction(db)) {
    throw new DeviceKeyUnavailableError(
      "in_transaction",
      "device key needs repair but a SQLite transaction is open; retry outside the transaction",
    );
  }

  if (!mirrored) {
    // Fresh install, app_meta wiped by resetAllLocalData (which does NOT
    // delete the SecureStore row), or a corrupt mirror string. A valid seed
    // is kept and simply re-mirrored; otherwise a fresh pair is generated.
    // Nothing to retire, no pending flags.
    if (seed && seedPub) {
      await writeAppMetaBatch([
        [META_PUBKEY_KEY, seedPub],
        [META_READ_FAILURES_KEY, "0"],
      ]);
      _cachedPrivkey = seed;
      _cachedPubkeyB64 = seedPub;
      return { pubkey_b64: seedPub };
    }
    const { priv, pubB64 } = await generateAndStoreSeed();
    await writeAppMetaBatch([
      [META_PUBKEY_KEY, pubB64],
      [META_READ_FAILURES_KEY, "0"],
    ]);
    _cachedPrivkey = priv;
    _cachedPubkeyB64 = pubB64;
    return { pubkey_b64: pubB64 };
  }

  const nextRetired = await appendRetired(retired, mirrored);
  const priorCount = Number((await getAppMeta(META_ROTATION_COUNT_KEY)) ?? "0");
  const rotationRows: Array<[string, string]> = [
    [META_RETIRED_PUBKEYS_KEY, JSON.stringify(nextRetired)],
    [META_ROTATED_AT_KEY, String(Date.now())],
    [META_ROTATION_COUNT_KEY, String((Number.isFinite(priorCount) ? priorCount : 0) + 1)],
    [META_REREGISTER_PENDING_KEY, "1"],
    [META_REBIND_PENDING_KEY, "1"],
    [META_READ_FAILURES_KEY, "0"],
  ];

  if (seed && seedPub) {
    // MISMATCH: SecureStore holds a valid seed the mirror doesn't know. Adopt
    // it rather than generating — this is how a half-landed repair converges.
    await writeAppMetaBatch([[META_PUBKEY_KEY, seedPub], ...rotationRows]);
    _cachedRetired = nextRetired;
    _cachedPrivkey = seed;
    _cachedPubkeyB64 = seedPub;
    console.warn("[device-key] adopted the SecureStore seed; the app_meta mirror was stale");
    return { pubkey_b64: seedPub };
  }

  // MISSING or CORRUPT seed behind a live mirror: the restored / transferred /
  // reinstalled-with-backup phone (or a Keystore blob that stopped decrypting,
  // see seedLost). Generate, retire the mirrored pubkey.
  const { priv, pubB64 } = await generateAndStoreSeed();
  await writeAppMetaBatch([[META_PUBKEY_KEY, pubB64], ...rotationRows]);
  _cachedRetired = nextRetired;
  _cachedPrivkey = priv;
  _cachedPubkeyB64 = pubB64;
  console.warn(
    seedLost
      ? "[device-key] SecureStore kept failing; generated a new device key"
      : "[device-key] no private key for the mirrored pubkey (restored device?); generated a new device key",
  );
  return { pubkey_b64: pubB64 };
}

// One read failure per process, only for interactive callers, persisted in
// app_meta so the count survives relaunches (that is the whole point: the
// permanent case is "fails on every launch"). Best-effort; returns the count
// after this failure, or 0 when it could not be counted.
async function countReadFailure(interactive: boolean, db: unknown): Promise<number> {
  if (!interactive) return 0;
  try {
    const prior = Number((await getAppMeta(META_READ_FAILURES_KEY)) ?? "0");
    const base = Number.isFinite(prior) && prior >= 0 ? prior : 0;
    if (_readFailureCountedThisProcess) return base;
    if (connectionInTransaction(db)) return base;
    const next = base + 1;
    await setAppMeta(META_READ_FAILURES_KEY, String(next));
    _readFailureCountedThisProcess = true;
    return next;
  } catch {
    return 0;
  }
}

async function clearReadFailures(db: unknown): Promise<void> {
  try {
    if (connectionInTransaction(db)) return;
    if ((await getAppMeta(META_READ_FAILURES_KEY)) != null) {
      await setAppMeta(META_READ_FAILURES_KEY, "0");
    }
  } catch {
    /* diagnostics only */
  }
}

// Synchronous read of the cached public key. Returns null if
// ensureDeviceKey() has not yet resolved in this process; callers must
// handle null (e.g., by deferring mesh handshake until next tick).
//
// Never throws. Never touches I/O.
export function getDevicePubkey(): string | null {
  return _cachedPubkeyB64;
}

// True once both halves are cached and verified against each other.
export function isDeviceKeyReady(): boolean {
  return _cachedPubkeyB64 != null && _cachedPrivkey != null;
}

// Synchronous copy of the retired list (empty until the first cold path or
// readOwnDevicePubkeys() warmed it).
export function getRetiredDevicePubkeysSync(): string[] {
  return _cachedRetired ? [..._cachedRetired] : [];
}

// READ-ONLY identity view: the current mirrored pubkey plus every retired one.
// Safe inside a SQLite transaction — never touches SecureStore, never writes,
// never throws. This is what identity resolution (lib/effective-account.ts)
// and the LOCAL-only trust-anchor carve-outs use; a device that has not been
// repaired yet still identifies as its mirrored pubkey, which is exactly what
// its vaults and membership rows are keyed by.
export async function readOwnDevicePubkeys(): Promise<{
  current: string | null;
  retired: string[];
}> {
  if (_cachedPubkeyB64 && _cachedRetired) {
    return { current: _cachedPubkeyB64, retired: [..._cachedRetired] };
  }
  try {
    const current = _cachedPubkeyB64 ?? (await getAppMeta(META_PUBKEY_KEY));
    const retired = _cachedRetired ?? parseRetired(await getAppMeta(META_RETIRED_PUBKEYS_KEY));
    if (!_cachedRetired) _cachedRetired = retired;
    return { current: looksLikePubkey(current) ? current : null, retired: [...retired] };
  } catch {
    return { current: _cachedPubkeyB64, retired: _cachedRetired ? [..._cachedRetired] : [] };
  }
}

// True when the pubkey is this device's current key OR one it rotated away
// from. LOCAL trust decisions only (the device's own claim about itself);
// remote signature verification must keep using the registry / anchor.
export async function isOwnDevicePubkey(pubkeyB64: string | null | undefined): Promise<boolean> {
  if (!pubkeyB64) return false;
  const { current, retired } = await readOwnDevicePubkeys();
  return pubkeyB64 === current || retired.includes(pubkeyB64);
}

// The signer snapshot applyEvent takes OUTSIDE its transaction. Throws
// DeviceKeyUnavailableError when the key can't be made ready.
export async function getDeviceSigner(opts?: { interactive?: boolean }): Promise<DeviceSigner> {
  await ensureDeviceKey(opts);
  const priv = _cachedPrivkey;
  const pub = _cachedPubkeyB64;
  if (!priv || !pub) {
    throw new DeviceKeyUnavailableError(
      "missing",
      "device key caches are cold after ensureDeviceKey",
    );
  }
  return {
    pubkey_b64: pub,
    // SYNC sign — uses the sha512Sync shim. The async variant would need
    // crypto.subtle (undefined on Hermes).
    sign: async (message: Uint8Array) => ed25519.sign(message, priv),
  };
}

// Signs a message with the device's private key. Cold cache → ensureDeviceKey
// (which repairs only outside a transaction and otherwise throws the typed
// error); warm cache → signs from memory. Kept for the mesh handshake's
// proof-of-possession; applyEvent uses getDeviceSigner().
export async function signWithDeviceKey(message: Uint8Array): Promise<Uint8Array> {
  const signer = await getDeviceSigner();
  return signer.sign(message);
}

// Returns the raw 32-byte device seed as standard base64, for injecting into
// the NATIVE mesh engine (KeystoreSeedStore) so it can sign proof-of-possession
// after a swipe-kill. The seed already lives in expo-secure-store; this only
// moves it within the trusted boundary (native re-encrypts it under AndroidKeyStore).
// null when no key exists yet. Used by the cutover seed-injection path only.
export async function getDeviceSeedB64(): Promise<string | null> {
  return await SecureStore.getItemAsync(SECURE_PRIVKEY_KEY);
}

// Status for the App health report. Never the key material. Re-validates
// first (never called inside a transaction) so a cache cleared by sign-out
// does not read as a broken key; `lastFailure` says why it is NOT ready.
export async function getDeviceKeyStatus(): Promise<{
  ready: boolean;
  lastFailure: DeviceKeyUnavailableReason | null;
  mirrored: boolean;
  rotations: number;
  lastRotatedAt: number | null;
  retiredCount: number;
  readFailures: number;
  reregisterPending: boolean;
  rebindPending: boolean;
}> {
  await ensureDeviceKey().catch(() => undefined);
  const [mirror, count, at, retiredRaw, failures, rereg, rebind] = await Promise.all([
    getAppMeta(META_PUBKEY_KEY),
    getAppMeta(META_ROTATION_COUNT_KEY),
    getAppMeta(META_ROTATED_AT_KEY),
    getAppMeta(META_RETIRED_PUBKEYS_KEY),
    getAppMeta(META_READ_FAILURES_KEY),
    getAppMeta(META_REREGISTER_PENDING_KEY),
    getAppMeta(META_REBIND_PENDING_KEY),
  ]);
  const rotations = Number(count ?? "0");
  const lastRotatedAt = at ? Number(at) : null;
  const readFailures = Number(failures ?? "0");
  return {
    ready: isDeviceKeyReady(),
    lastFailure: isDeviceKeyReady() ? null : _lastFailure,
    mirrored: looksLikePubkey(mirror),
    rotations: Number.isFinite(rotations) ? rotations : 0,
    lastRotatedAt: lastRotatedAt != null && Number.isFinite(lastRotatedAt) ? lastRotatedAt : null,
    retiredCount: parseRetired(retiredRaw).length,
    readFailures: Number.isFinite(readFailures) ? readFailures : 0,
    reregisterPending: rereg === "1",
    rebindPending: rebind === "1",
  };
}

// -------------------- backend registration --------------------

// clearDeviceKey wipes the in-memory caches. Called from auth.ts signOut /
// clearLocalSession / deleteAccount so a subsequent sign-in (potentially as
// a different user on the same physical device) does not unintentionally
// reuse the previous session's loaded-into-memory copy. The SecureStore-
// backed seed is left in place — `install_id` is per-device-not-per-account —
// and the next ensureDeviceKey() re-reads and re-validates both halves.
//
// resetAllLocalData drops app_meta but does NOT delete the SecureStore row;
// the next cold path sees "no mirror" and generates a fresh pair over it.
export function clearDeviceKey(): void {
  _cachedPrivkey = null;
  _cachedPubkeyB64 = null;
  _cachedRetired = null;
}

// POSTs the device's public key to the backend so other peers can verify
// our signatures. Idempotent: backend UPSERTs by install_id. On success the
// post-rotation re-register flag is cleared.
//
// Never throws — the sign-in path fires and forgets it; check-in and the
// chain backfill act on the returned outcome.
export async function registerDeviceKey(): Promise<RegisterDeviceKeyResult> {
  try {
    const { pubkey_b64 } = await ensureDeviceKey();
    const jwt = await getSessionJWT().catch(() => null);
    if (!jwt) {
      // Local-only mode — no backend to register with. ensureDeviceKey
      // still ran (good: the keypair is ready for whenever the user
      // signs in later).
      return "no_session";
    }
    const baseUrl = await getBackendUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${baseUrl}/v1/devices/register-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ ed25519_pubkey: pubkey_b64 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[mesh] register-key returned ${res.status}`);
        return "failed";
      }
    } finally {
      clearTimeout(timer);
    }
    try {
      await setAppMeta(META_REREGISTER_PENDING_KEY, "");
    } catch {
      /* flag stays set; the next check-in re-registers (idempotent) */
    }
    return "registered";
  } catch (err) {
    console.warn("[mesh] registerDeviceKey failed", err);
    return "failed";
  }
}
