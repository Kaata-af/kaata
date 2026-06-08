// UUIDv5 — RFC 4122 §4.3. Deterministic UUID from (namespace, name).
// Used by the event log to mint stable event IDs:
//   - Real events: Crypto.randomUUID() (UUIDv4) — collision risk is statistically
//     zero and we don't need determinism for them.
//   - Backfilled events (migration 006): uuidv5(KAATA_UUID_NAMESPACE,
//     `backfill|${kind}|${entity_id}|${physical_ms}`) so re-running the
//     migration produces byte-identical event_ids and INSERT OR IGNORE turns
//     it into a true no-op.
//
// Pure-JS implementation. No native deps. expo-crypto SDK 54 exposes only async
// SHA-1 via digestStringAsync, which we don't want to await per-row inside a
// migration loop that already holds withTransactionAsync. react-native-quick-
// crypto is not in the dep tree. So we inline SHA-1.
//
// The SHA-1 implementation is the standard FIPS 180-4 algorithm operating on
// byte arrays. It is NOT cryptographically validated for adversarial input —
// we only use it to derive deterministic IDs from non-adversarial namespace +
// name pairs, which is exactly the RFC 4122 use case.

// Kaata's private UUIDv5 namespace. Generated once via crypto.randomUUID() and
// frozen forever. Treat as a magic constant — never regenerate.
export const KAATA_UUID_NAMESPACE = "7c4a8d09-ca37-4e5b-9f2a-1d6b8e3f4a52";

/**
 * Compute UUIDv5 from a namespace UUID and a name string.
 *
 * @param namespace UUID string in canonical 8-4-4-4-12 form (any case)
 * @param name      Arbitrary string (UTF-8 encoded internally)
 * @returns         UUIDv5 string in lowercase canonical form
 */
export function uuidv5(namespace: string, name: string): string {
  const nsBytes = parseUuidToBytes(namespace);
  const nameBytes = utf8Encode(name);

  const input = new Uint8Array(nsBytes.length + nameBytes.length);
  input.set(nsBytes, 0);
  input.set(nameBytes, nsBytes.length);

  const hash = sha1(input); // 20 bytes

  // Take the first 16 bytes of the SHA-1 hash, then set version + variant.
  const out = hash.slice(0, 16);
  out[6] = (out[6] & 0x0f) | 0x50; // version 5 (high nibble = 0101)
  out[8] = (out[8] & 0x3f) | 0x80; // RFC 4122 variant (high bits = 10)

  return bytesToUuidString(out);
}

// ---------- helpers ----------

function parseUuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToUuidString(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function utf8Encode(str: string): Uint8Array {
  // RN/Hermes ships TextEncoder; fall back to a manual UTF-8 encoder just in case.
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str);
  }
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      // surrogate pair
      const c2 = str.charCodeAt(++i);
      const code = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

// ---------- SHA-1 (FIPS 180-4) ----------
// Operates on bytes, returns 20-byte digest. Pure JS, ~40 lines. Not for
// adversarial use — only for deterministic name-based UUID derivation.

function sha1(data: Uint8Array): Uint8Array {
  // We only write the LOW 32 bits of the FIPS 180-4 64-bit length field —
  // adequate for any input under 2^29 bytes (~512 MiB). UUIDv5 backfill
  // names are <100 chars. Guard explicitly so we throw rather than silently
  // produce a wrong digest if someone ever feeds a giant blob.
  if (data.length > 0x1fffffff) {
    throw new Error("sha1: input exceeds 512 MiB — 64-bit length encoding is truncated to 32 bits");
  }
  // Pre-processing: append 0x80, pad with zeros, append 64-bit big-endian length.
  const bitLen = data.length * 8;
  const withPad = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  withPad.set(data, 0);
  withPad[data.length] = 0x80;
  // 64-bit length, big-endian (only low 32 bits written — guarded above)
  const lenOffset = withPad.length - 4;
  withPad[lenOffset] = (bitLen >>> 24) & 0xff;
  withPad[lenOffset + 1] = (bitLen >>> 16) & 0xff;
  withPad[lenOffset + 2] = (bitLen >>> 8) & 0xff;
  withPad[lenOffset + 3] = bitLen & 0xff;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let blockStart = 0; blockStart < withPad.length; blockStart += 64) {
    for (let i = 0; i < 16; i++) {
      const o = blockStart + i * 4;
      w[i] =
        ((withPad[o] << 24) | (withPad[o + 1] << 16) | (withPad[o + 2] << 8) | withPad[o + 3]) >>>
        0;
    }
    for (let i = 16; i < 80; i++) {
      const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((v << 1) | (v >>> 31)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const hs = [h0, h1, h2, h3, h4];
  for (let i = 0; i < 5; i++) {
    out[i * 4] = (hs[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (hs[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (hs[i] >>> 8) & 0xff;
    out[i * 4 + 3] = hs[i] & 0xff;
  }
  return out;
}
