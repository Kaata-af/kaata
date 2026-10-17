/** A cache entry proves only that these exact bytes passed this verifier.
 * Membership authority, event ordering and revocations must still be folded
 * from current inputs; this cache deliberately stores no membership state. */
export type SignatureVerifier = (
  message: Uint8Array,
  signature: string,
  publicKey: string,
) => boolean;

export type SignatureCheck = {
  message: Uint8Array;
  signature: string;
  publicKey: string;
};
export type BatchSignatureVerifier = (
  checks: readonly SignatureCheck[],
) => Promise<readonly boolean[] | null>;
export type SuccessfulVerificationCache = SignatureVerifier & {
  /** The optional batch verifier must implement the same acceptance policy,
   * or a stricter subset. Only its true results can seed this cache. */
  prewarm: (checks: Iterable<SignatureCheck>) => Promise<void>;
};

type CacheLimits = {
  maxEntries?: number;
  maxMessageBytes?: number;
  /** Total retained key size, counting two bytes per UTF-16 code unit.
   * Map overhead is separately bounded by maxEntries. */
  maxKeyBytes?: number;
};

/** Cache only successful checks, with an LRU bound on entries and key storage.
 * Oversized messages/keys and failures always reach the original verifier.
 * A cache belongs to one verifier, so checks with different policies cannot
 * accidentally share successful results. */
export function createSuccessfulVerificationCache(
  verify: SignatureVerifier,
  limits: CacheLimits = {},
  verifyBatch?: BatchSignatureVerifier,
): SuccessfulVerificationCache {
  const maxEntries = limits.maxEntries ?? 512;
  const maxMessageBytes = limits.maxMessageBytes ?? 16 * 1024;
  const maxKeyBytes = limits.maxKeyBytes ?? 1024 * 1024;
  for (const bound of [maxEntries, maxMessageBytes, maxKeyBytes]) {
    if (!Number.isSafeInteger(bound) || bound < 0) {
      throw new Error("Signature cache limits must be nonnegative safe integers");
    }
  }

  const entries = new Map<string, number>();
  let retainedKeyBytes = 0;

  const makeKey = ({ message, signature, publicKey }: SignatureCheck) => {
    if (
      maxEntries === 0 ||
      message.byteLength > maxMessageBytes ||
      2 * (message.byteLength + signature.length + publicKey.length) > maxKeyBytes
    ) {
      return null;
    }

    // Length prefixes avoid ambiguity even for arbitrary signature/key text.
    // Encode each message byte as one code unit, rather than using a lossy
    // UTF-8 decoder (distinct malformed UTF-8 inputs must never share a key).
    const prefix = `${signature.length}:${signature}${publicKey.length}:${publicKey}${message.length}:`;
    const keyBytes = 2 * (prefix.length + message.length);
    if (keyBytes > maxKeyBytes) return null;
    const parts = [prefix];
    for (let i = 0; i < message.length; i += 1024) {
      parts.push(String.fromCharCode(...message.subarray(i, i + 1024)));
    }
    const key = parts.join("");
    return { key, keyBytes };
  };
  const remember = (key: string, keyBytes: number) => {
    if (entries.has(key)) {
      entries.delete(key);
      entries.set(key, keyBytes);
      return;
    }
    while (entries.size >= maxEntries || retainedKeyBytes + keyBytes > maxKeyBytes) {
      const oldest = entries.keys().next().value!;
      retainedKeyBytes -= entries.get(oldest)!;
      entries.delete(oldest);
    }
    entries.set(key, keyBytes);
    retainedKeyBytes += keyBytes;
  };
  const cached: SuccessfulVerificationCache = Object.assign(
    (message: Uint8Array, signature: string, publicKey: string) => {
      const keyed = makeKey({ message, signature, publicKey });
      if (!keyed) return verify(message, signature, publicKey);
      const { key, keyBytes } = keyed;
      const hitBytes = entries.get(key);
      if (hitBytes !== undefined) {
        entries.delete(key);
        entries.set(key, hitBytes);
        return true;
      }

      if (!verify(message, signature, publicKey)) return false;
      remember(key, keyBytes);
      return true;
    },
    { prewarm },
  );

  // Serialize native warming so concurrent readers share successful work.
  // The actual fold stays synchronous and never awaits while holding state.
  let warming = Promise.resolve();
  function prewarm(checks: Iterable<SignatureCheck>): Promise<void> {
    if (!verifyBatch || maxEntries === 0 || maxKeyBytes === 0) return Promise.resolve();
    const next = warming.then(async () => {
      type Pending = { check: SignatureCheck; key: string; keyBytes: number };
      let batch: Pending[] = [];
      let batchBytes = 0;
      let seenBytes = 0;
      const seen = new Set<string>();
      let sinceYield = Date.now();
      let visited = 0;
      const flush = async (): Promise<boolean> => {
        if (batch.length === 0) return true;
        const pending = batch;
        batch = [];
        batchBytes = 0;
        let results: readonly boolean[] | null;
        try {
          results = await verifyBatch(pending.map((entry) => entry.check));
        } catch {
          return false;
        }
        // A malformed response cannot seed even a partially plausible result.
        if (
          !Array.isArray(results) ||
          results.length !== pending.length ||
          pending.some((_, index) => typeof results![index] !== "boolean")
        )
          return false;
        for (let i = 0; i < pending.length; i++) {
          if (results[i] === true) remember(pending[i].key, pending[i].keyBytes);
        }
        return true;
      };
      for (const check of checks) {
        const keyed = makeKey(check);
        if (keyed && !entries.has(keyed.key) && !seen.has(keyed.key)) {
          // Copy before flushing a previous batch as well: that await can
          // let the caller mutate this candidate while earlier work runs.
          const snapshot = { ...check, message: new Uint8Array(check.message) };
          if (batch.length >= 32 || batchBytes + check.message.byteLength > 128 * 1024) {
            if (!(await flush())) return;
          }
          if (seen.size >= maxEntries || seenBytes + keyed.keyBytes > maxKeyBytes) {
            seen.clear();
            seenBytes = 0;
          }
          seen.add(keyed.key);
          seenBytes += keyed.keyBytes;
          // Snapshot bytes before any await: caller mutation must not let a
          // native result for new bytes warm the key for an earlier message.
          batch.push({ ...keyed, check: snapshot });
          batchBytes += snapshot.message.byteLength;
        }
        if (++visited >= 32 || Date.now() - sinceYield >= 4) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          visited = 0;
          sinceYield = Date.now();
        }
      }
      await flush();
    });
    warming = next.catch(() => {});
    return warming;
  }
  return cached;
}
