// Runtime ChainCrypto wiring — connects the pure chain fold to the app's
// real signature implementations in lib/event-sig.ts. Kept OUT of chain.ts
// so the bun selftest can import chain.ts without dragging in event-sig's
// expo-crypto shim (which only resolves inside React Native).

import {
  canonicalize,
  verifyEventSignature,
  verifyRawSignature,
  type SignableEvent,
} from "../event-sig";
import type { ChainCrypto, MembershipEventLike } from "./chain";

export const runtimeChainCrypto: ChainCrypto = {
  verifyEvent: (event: MembershipEventLike, sigB64: string, pubkeyB64: string) =>
    verifyEventSignature(event as unknown as SignableEvent, sigB64, pubkeyB64).valid,
  verifyRaw: verifyRawSignature,
  canonicalize,
};
