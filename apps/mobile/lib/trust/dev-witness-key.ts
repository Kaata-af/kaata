function httpOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

const publicKeyPattern = /^[A-Za-z0-9+/]{43}=$/;
const primary = process.env.EXPO_PUBLIC_DEV_WITNESS_PUBKEY;
const rotation = process.env.EXPO_PUBLIC_DEV_WITNESS_ROTATION_PUBKEY;
const configuredOrigin = httpOrigin(process.env.EXPO_PUBLIC_DEV_WITNESS_ORIGIN);

export function hasDevWitnessConfig(): boolean {
  return (
    typeof __DEV__ !== "undefined" &&
    __DEV__ &&
    !!configuredOrigin &&
    !!primary &&
    publicKeyPattern.test(primary)
  );
}

/** Test witness keys are supplied by the local operator, never by HTTP. */
export function devWitnessPublicKeys(backendUrlOverride: string | null): string[] | null {
  if (!hasDevWitnessConfig() || !primary) return null;
  const effectiveOrigin = httpOrigin(backendUrlOverride || process.env.EXPO_PUBLIC_BACKEND_URL);
  if (effectiveOrigin !== configuredOrigin) return null;
  return rotation && rotation !== primary && publicKeyPattern.test(rotation)
    ? [primary, rotation]
    : [primary];
}
