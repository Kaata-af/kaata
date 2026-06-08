// apps/mobile/lib/event-sig.ts
//
// Phase 8 D-ROLE-ENFORCEMENT-MOBILE — event signing.
//
// Each ledger event carries an Ed25519 signature over a canonical
// encoding of its envelope+payload, signed by the author's device
// privkey (the same key that mints local-CA VMCs in mesh/device-key.ts).
// Verification at apply-time uses the SIGNER's device_pubkey (looked up
// from vault_credentials by device_id, which is itself signature-bound
// via the VMC chain that landed it there) rather than the wire's
// claimed actor_account_id — closing SECURITY #2/#3, the membership-
// event-forgery attack.
//
// Canonical encoding: a deterministic JSON string with keys sorted
// lexicographically, payload re-serialized via canonicalize() so any
// peer rebuilds the SAME bytes. The wire envelope and the signature
// are bound together; tampering with any field (vault_id, hlc, payload,
// device_id, actor_account_id) invalidates the signature.
//
// Backward compat: pre-013 events have NULL event_sig_b64. The verifier
// treats NULL signatures as "legacy local replay" — only acceptable for
// origin='local' and origin='backfill'. Any remote-origin event MUST
// carry a signature OR be refused by the role-gate as 'unsigned_event'.
//
// This file is pure functions only — no DB I/O.

// @noble/ed25519 v2 Hermes shims — INLINED here because event-sig.ts can be
// transitively imported via `lib/event-log.ts` from boot paths (vault/new,
// person/new, entry/new) that may not have already pulled in
// `lib/mesh/device-key.ts` or the mesh barrel `_ed25519-setup.ts`. Without
// these two assignments the SYNC `ed.verify` below falls back to the
// closure-local `sha512s` whose underlying `etc.sha512Sync` is undefined,
// and the next `ed.verify` call throws `hashes.sha512Sync not set`. The
// shim writes the same singleton `etc` object that the other two shim
// sites write — re-running this code is a free no-op once the property
// is already set.
import { sha512 as _sha512 } from "@noble/hashes/sha512";
import { etc as _ed25519etc } from "@noble/ed25519";
import * as _ExpoCrypto from "expo-crypto";
if (typeof _ed25519etc.sha512Sync !== "function") {
  _ed25519etc.sha512Sync = (...m: Uint8Array[]) => _sha512(_ed25519etc.concatBytes(...m));
}
_ed25519etc.randomBytes = (len?: number) => _ExpoCrypto.getRandomBytes(len ?? 32);

import * as ed from "@noble/ed25519";

import type { HLC } from "./hlc";

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Stringify any JSON-compatible value with keys sorted lexicographically.
 * Objects are emitted as {"k1":v1,"k2":v2,...} in sorted-key order;
 * arrays are emitted positionally; scalars use JSON.stringify. Used to
 * canonicalize the event payload so signing+verifying produce the same
 * bytes across Hermes / Node / Go.
 *
 * Subtle: JSON.stringify on objects with non-ASCII keys is technically
 * spec-correct but engines have historically differed on surrogate-pair
 * escaping. Our event payloads are all-ASCII keys (entry_id, name, etc.)
 * so we sidestep this; a future event type with unicode keys must add
 * a UTF-8-normalized canonicalizer.
 */
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map((x) => canonicalize(x)).join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Envelope fields signed by every event
// ---------------------------------------------------------------------------

/**
 * The minimal envelope+payload bundle that the signature commits to.
 * Fields NOT in this list (appended_at, server_acked_at, origin) are
 * device-local metadata that legitimately differ across replicas and
 * MUST NOT enter the canonical input.
 *
 * vault_id is included so a signature over an event for vault A cannot
 * be replayed against vault B (cross-vault binding).
 * device_id is included so an attacker who steals an EVENT but not the
 * privkey cannot present it as authored by a different device.
 * hlc is included so reordering attempts produce different signatures.
 * actor_account_id is included for completeness — the role-gate ignores
 * it in favor of the looked-up account from vault_credentials, but
 * including it keeps the wire field tamper-evident.
 */
export type SignableEvent = {
  event_id: string;
  event_type: string;
  vault_id: string | null;
  target_id: string;
  relationship_id: string | null;
  hlc: HLC;
  device_id: string;
  actor_account_id: string | null;
  payload: unknown;
  payload_schema: number;
};

export function canonicalizeEvent(e: SignableEvent): Uint8Array {
  const ordered: Record<string, unknown> = {
    actor_account_id: e.actor_account_id,
    device_id: e.device_id,
    event_id: e.event_id,
    event_type: e.event_type,
    hlc: { did: e.hlc.did, l: e.hlc.l, pms: e.hlc.pms },
    payload: e.payload,
    payload_schema: e.payload_schema,
    relationship_id: e.relationship_id,
    target_id: e.target_id,
    vault_id: e.vault_id,
  };
  const canonical = canonicalize(ordered);
  // eslint-disable-next-line no-undef
  return new TextEncoder().encode(canonical);
}

// ---------------------------------------------------------------------------
// base64 helpers (standard, NOT url-safe — matches VMC encoding)
// ---------------------------------------------------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  // eslint-disable-next-line no-undef
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign an event with the supplied raw Ed25519 privkey (32 bytes).
 * Returns the base64-encoded 64-byte signature. The signer is expected
 * to be the device referenced by event.device_id; the verifier on the
 * other side confirms this by looking up device_pubkey by device_id.
 */
export async function signEvent(
  event: SignableEvent,
  signer: (msg: Uint8Array) => Promise<Uint8Array>,
): Promise<string> {
  const bytes = canonicalizeEvent(event);
  const sig = await signer(bytes);
  if (sig.length !== 64) {
    throw new Error(`signEvent: signer returned ${sig.length} bytes (expected 64)`);
  }
  return bytesToB64(sig);
}

export type EventVerifyResult =
  | { valid: true }
  | { valid: false; reason: "malformed_sig" | "malformed_pubkey" | "bad_signature" };

/**
 * Verify an event's signature against the supplied signer device_pubkey.
 *
 * pubkeyB64 — base64-encoded 32-byte Ed25519 pubkey of the signing
 *             device. Caller is expected to retrieve this from
 *             vault_credentials.device_pubkey (which is itself
 *             signature-bound through the VMC chain) keyed by the
 *             event's device_id.
 *
 * sigB64    — base64-encoded 64-byte Ed25519 signature from the
 *             event_log.event_sig_b64 column (or wire envelope).
 *
 * Returns valid=false on ANY tampering — a mutated payload, a mutated
 * envelope field, or a signature forged with a different key.
 */
export function verifyEventSignature(
  event: SignableEvent,
  sigB64: string,
  pubkeyB64: string,
): EventVerifyResult {
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = b64ToBytes(sigB64);
  } catch {
    return { valid: false, reason: "malformed_sig" };
  }
  if (sig.length !== 64) return { valid: false, reason: "malformed_sig" };
  try {
    pub = b64ToBytes(pubkeyB64);
  } catch {
    return { valid: false, reason: "malformed_pubkey" };
  }
  if (pub.length !== 32) return { valid: false, reason: "malformed_pubkey" };

  const msg = canonicalizeEvent(event);
  try {
    // SYNC verify — Hermes has no crypto.subtle for the async variant.
    if (ed.verify(sig, msg, pub)) return { valid: true };
  } catch {
    // fall through
  }
  return { valid: false, reason: "bad_signature" };
}
