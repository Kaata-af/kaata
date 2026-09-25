// Diagnostics used to discard the server's validation reason and report only
// "push failed: 400". Include known wire-validation text, never arbitrary server
// output (which might contain ledger content, credentials, HTML, or identifiers).
const validationReasons = new Set([
  "must be a uuid",
  "is required",
  "must be >= 1",
  "must be >= 1 when present",
  "must be standard base64 of a 64-byte signature",
  "must be standard base64 of a 32-byte Ed25519 pubkey",
  "does not match session account",
  "is not valid json",
  "is required for account_bound",
  "exceeds 64 KiB",
]);

export function pushFailureMessage(status: number, body: unknown): string {
  const base = `push failed: ${status}`;
  if (status !== 400 || body == null || typeof body !== "object") return base;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "string" || error.length > 240) return base;
  const field = error.match(
    /^(?:events\[\d{1,3}\]\.(?:event_id|event_type|schema_version|author_seq|event_sig_b64|signer_device_pubkey|hlc\.device_id|actor_account_id|payload(?:\.account_id)?|target_id|relationship_id)|vault_id|device_id) (.+)$/,
  );
  if (field && validationReasons.has(field[1])) return `${base}: ${error}`;
  if (
    /^events\[\d{1,3}\]: event_sig_b64 and signer_device_pubkey must be supplied together$/.test(
      error,
    )
  ) {
    return `${base}: ${error}`;
  }
  if (error === "invalid json body" || error === "batch exceeds 500 events; chunk on the client") {
    return `${base}: ${error}`;
  }
  return base;
}
