// Nearby is parked on iOS. Metro resolves this module in place of aead.ts so
// the Bluetooth/LAN confidentiality implementation is absent from the iOS
// bundle. Refuse the handshake rather than permit an unencrypted fallback.

export type { BleAeadContext, EphemeralKeyPair } from "./aead";

export const TAG_BYTES = 16;
export const X25519_PUBKEY_BYTES = 32;

export class MeshAeadError extends Error {
  readonly code = "ios_unavailable";

  constructor() {
    super("Nearby sync is unavailable on iOS");
    this.name = "MeshAeadError";
  }
}

function unavailable(): never {
  throw new MeshAeadError();
}

export const generateEphemeralKeyPair: typeof import("./aead").generateEphemeralKeyPair =
  unavailable;
export const deriveSessionAead: typeof import("./aead").deriveSessionAead = unavailable;
export const sealChunk: typeof import("./aead").sealChunk = unavailable;
export const openChunk: typeof import("./aead").openChunk = unavailable;

export function wipeEphemeralPriv(privateKey: Uint8Array): void {
  privateKey.fill(0);
}
