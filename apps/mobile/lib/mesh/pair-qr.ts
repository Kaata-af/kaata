// apps/mobile/lib/mesh/pair-qr.ts
//
// Phase 5 — same-account multi-device QR pairing payload.
//
// The QR is NOT a server-signed credential. The backend's VMC issuance
// (POST /v1/vaults/:vault_id/credential) authenticates the requesting device
// via its JWT (account_id) — so we don't need a server-signed token on the
// wire. The QR is purely a local proof-of-intent: the owner is declaring
// "this physical phone is the one I want to add to vault X".
//
// Security model:
//   - The QR payload is short-lived (5 min) and rate-limited locally to
//     prevent shoulder-surfing/replay (1 active token per vault per device).
//   - The new device MUST be signed into the same Google account as the
//     issuer; the backend enforces this when /credential issues the VMC.
//   - Cross-account joining via QR is REFUSED. Phase 4 invite flow is the
//     supported path for cross-account access.

import * as Crypto from "expo-crypto";

// Phase 8 D-PAIR-WITH-ROLE: bump v=1 -> v=2 to carry an explicit `role`
// field. decodePairQr ACCEPTS both v=1 and v=2 so older QRs still scan;
// missing-role defaults to "editor" (safer than the legacy implicit
// "owner" — a careless owner snapping a QR for staff shouldn't grant
// owner-tier access by accident).
export const PAIR_QR_VERSION = 3;
// 30 min (was 5): this TTL bounds the BLE pair-admission window, not just the
// QR's visual life. First-pair latency (BLE permission dialogs + duty-cycled
// discovery + connect/MTU) routinely outran a 5-min window, after which the
// joiner's nonce expired and the owner refused with "no live pair token
// matched". 30 min is longer than any first-contact handshake; the token is
// still single-use and bound to the joiner's pubkey on claim.
export const PAIR_QR_TTL_MS = 30 * 60 * 1000;
// v=3 carries device_pubkey + display_name in addition to v=2 fields, so
// the payload grew. Existing payloads still fit comfortably under 512.
export const PAIR_QR_MAX_PAYLOAD_BYTES = 768;

/** Role offered by an owner-issued pair QR. Local-CA pair flow only —
 *  server-anchored flow ignores this field and always mints an owner-
 *  role VMC (Phase 5 behaviour). */
export type PairQrRole = "owner" | "editor" | "viewer";

export type PairQrPayload = {
  /**
   * Wire version. v=1 is the legacy schema (no role field; implicit
   * owner). v=2 carries an explicit `role`. v=3 (this version) adds
   * issuer_device_pubkey + issuer_display_name so the SCANNER can
   * pin the issuer's identity directly — enabling Briar-style
   * bidirectional pair: each phone scans the other's QR, both ends
   * end up with locally-pinned peer identities, and BLE handshake
   * verifies peer signatures against the pinned pubkey (no VMC chain
   * needed for local-CA). decodePairQr ACCEPTS v=1/v=2/v=3 for
   * forward compatibility — see decodePairQr for the legacy fallback
   * (defaults role to "editor" when missing).
   */
  v: 1 | 2 | 3;
  vault_id: string;
  vault_name: string;
  issuer_account_id: string;
  issuer_install_id: string;
  issued_at_ms: number;
  expires_at_ms: number;
  shop_mode_token: string;
  /**
   * Phase 7 local-CA: base64-encoded 32-byte Ed25519 public key of the
   * vault's trust anchor (owner's device). When present, the scanner
   * stores this into vaults.vault_trust_anchor_pubkey. Absent on
   * Phase 5 server-anchored vaults (back-compat). Additive — older
   * scanners ignore the field silently.
   */
  vault_trust_anchor_pubkey?: string;
  /**
   * D-PAIR-WITH-ROLE: role the owner is offering for this pair token.
   * Only meaningful in local-CA mode (vault_trust_anchor_pubkey set).
   * Server-anchored pair flow ignores this — the server always mints
   * an owner VMC for same-account pairing.
   *
   * Missing field on a v=1 payload (legacy) is treated as "editor"
   * (safer than legacy implicit owner) on decode. See decodePairQr.
   */
  role?: PairQrRole;
  /**
   * v=3 bidirectional pair: the issuer's Ed25519 device pubkey
   * (base64-encoded 32-byte). When the scanner pins this into its
   * local vault_credentials, the BLE handshake on that side can
   * verify the issuer's PoP signatures directly — no VMC chain
   * needed. This is what makes true offline mesh work for local-CA
   * users without the deferred pair_claim/pair_grant wire.
   *
   * Required for v=3. Optional/absent for v<=2 (back-compat: v<=2
   * scanners fall back to the legacy VMC-chain path).
   */
  issuer_device_pubkey?: string;
  /**
   * v=3: the issuer's chosen display name (so the OTHER side can
   * render "Matee" instead of "local:abc…" in the Members tab).
   * Required for v=3.
   */
  issuer_display_name?: string;
  /**
   * v=3 (M-BTC-3.2): the issuer's Bluetooth adapter name (getLocalName).
   * Lets the scanner target the owner's device FIRST during classic
   * inquiry instead of blind-dialing every nearby phone by the derived
   * RFCOMM UUID. Optional + additive — when absent the scanner still
   * finds the host by trying all inquiry hits against the UUID (only the
   * host exposes that service). Not validated on decode (best-effort hint).
   */
  issuer_bt_name?: string;
};

export type PairQrValidationResult =
  | { ok: true; payload: PairQrPayload }
  | {
      ok: false;
      reason:
        | "malformed"
        | "unsupported_version"
        | "expired"
        | "missing_field"
        | "payload_too_large";
    };

export function encodePairQr(p: PairQrPayload): string {
  const json = JSON.stringify(p);
  if (json.length > PAIR_QR_MAX_PAYLOAD_BYTES) {
    throw new Error("pair_qr_payload_too_large");
  }
  return json;
}

export function decodePairQr(raw: string): PairQrValidationResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (raw.length > PAIR_QR_MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "malformed" };
  }
  const obj = parsed as Record<string, unknown>;
  // Accept v=1 (legacy), v=2 (role-aware), v=3 (bidirectional pair w/
  // issuer_device_pubkey + issuer_display_name). v=4+ surfaces as a
  // clean unsupported_version error so the user gets "upgrade your app"
  // instead of a silent malformed-reject.
  if (obj.v !== 1 && obj.v !== 2 && obj.v !== 3) {
    return { ok: false, reason: "unsupported_version" };
  }
  const requiredStrings = [
    "vault_id",
    "vault_name",
    "issuer_account_id",
    "issuer_install_id",
    "shop_mode_token",
  ] as const;
  for (const k of requiredStrings) {
    if (typeof obj[k] !== "string" || (obj[k] as string).length === 0) {
      return { ok: false, reason: "missing_field" };
    }
  }
  const requiredNumbers = ["issued_at_ms", "expires_at_ms"] as const;
  for (const k of requiredNumbers) {
    if (typeof obj[k] !== "number") {
      return { ok: false, reason: "missing_field" };
    }
  }
  // Validate role if present. Missing role is permitted (legacy v=1 or
  // server-anchored v=2) and the scanner falls back to "editor".
  if ("role" in obj && obj.role !== undefined) {
    if (
      typeof obj.role !== "string" ||
      (obj.role !== "owner" && obj.role !== "editor" && obj.role !== "viewer")
    ) {
      return { ok: false, reason: "missing_field" };
    }
  }
  // v=3 mandatory fields. For v<=2 these are absent and the scanner
  // falls back to the legacy VMC-chain path (now that local-CA mesh has
  // a working alternative this is preserved purely for back-compat with
  // any QR generated before the v0.5.3 upgrade window).
  if (obj.v === 3) {
    if (typeof obj.issuer_device_pubkey !== "string" || obj.issuer_device_pubkey.length === 0) {
      return { ok: false, reason: "missing_field" };
    }
    if (typeof obj.issuer_display_name !== "string" || obj.issuer_display_name.length === 0) {
      return { ok: false, reason: "missing_field" };
    }
  }
  const payload = obj as unknown as PairQrPayload;
  if (payload.expires_at_ms <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

/** Generate a 32-byte URL-safe base64 nonce via the platform CSPRNG. */
export async function generateShopModeToken(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += alphabet[(n >> 6) & 63];
    out += alphabet[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i] << 16) | ((rem > 1 ? bytes[i + 1] : 0) << 8);
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    if (rem === 2) out += alphabet[(n >> 6) & 63];
  }
  return out;
}

// ---------------------------------------------------------------------
// Phase 5.1 — kaata://pair/<token> deep link encoding.
//
// The deep link carries the full PairQrPayload as a base64url-encoded
// JSON blob in the `p` query param. Shape:
//
//   kaata://pair/<token>?p=<base64url-json>
//
// The `<token>` path segment is purely for human-readable share
// previews — the canonical payload is `?p=`. Receiving this on a phone
// that's signed into the SAME Google account is equivalent to scanning
// the QR.
// ---------------------------------------------------------------------

export function encodePairDeepLink(p: PairQrPayload): string {
  const json = JSON.stringify(p);
  if (json.length > PAIR_QR_MAX_PAYLOAD_BYTES) {
    throw new Error("pair_deeplink_payload_too_large");
  }
  const b64 = utf8ToBase64Url(json);
  // The token segment is informational; the receiver doesn't trust it
  // and re-reads everything from `?p=`. We expose just a slice of the
  // shop_mode token so analytics / share previews can show a non-opaque
  // slug.
  const slug = p.shop_mode_token.slice(0, 12);
  return `kaata://pair/${slug}?p=${b64}`;
}

export function decodePairDeepLinkPayload(b64: string): PairQrValidationResult {
  if (typeof b64 !== "string" || b64.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  let json: string;
  try {
    json = base64UrlToUtf8(b64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Reuse the QR validator end-to-end so the deep link and QR paths
  // share identical schema + expiry + version checks.
  return decodePairQr(json);
}

function utf8ToBase64Url(s: string): string {
  // RN doesn't ship a global btoa for UTF-8 safely; encode bytes by hand.
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
      i++;
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytesToBase64Url(Uint8Array.from(bytes));
}

function base64UrlToUtf8(b64: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lookup = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) lookup.set(alphabet[i], i);
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const v = lookup.get(b64[i]);
    if (v === undefined) throw new Error("invalid_base64url");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  // Decode UTF-8.
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if ((b & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if ((b & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f),
      );
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
      const adj = cp - 0x10000;
      out += String.fromCharCode(0xd800 | (adj >> 10), 0xdc00 | (adj & 0x3ff));
    }
  }
  return out;
}
