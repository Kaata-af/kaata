// Keep the noble-free polyfill ahead of curves, whose hash utilities capture
// globalThis.crypto at import time. Key generation still belongs to device-key.
import "./_crypto-polyfill";
import { ed25519 } from "@noble/curves/ed25519";

// Configure once per module. Reconfiguring clears the shared BASE table; a
// four-bit window reduces its cold table from 4,224 points to 520. Both key
// derivation and signing use this table; verification keeps its existing API.
ed25519.Point.BASE.precompute(4, true);

export function deriveDeviceSigningPublicKey(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed);
}

export function signDeviceMessage(message: Uint8Array, seed: Uint8Array): Uint8Array {
  return ed25519.sign(message, seed);
}
