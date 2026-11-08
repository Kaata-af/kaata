// Metro resolves the Android-only signing helper's import even on iOS.
// Keep the existing iOS Ed25519 implementation without bundling the
// separate curves module, which also includes X25519 key exchange.
import "./_ed25519-setup";
export {
  getPublicKey as deriveDeviceSigningPublicKey,
  sign as signDeviceMessage,
} from "@noble/ed25519";
