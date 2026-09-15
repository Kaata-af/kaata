import { getAppMeta, setAppMeta } from "./db";

// Local App health diagnostics only. Never persist an error message, stack,
// contact field, SQL statement, or arbitrary error code/name.
const KEY = "last_person_save_error";
const CODES = [
  "signing_unavailable",
  "storage_full",
  "storage_busy",
  "storage_constraint",
  "storage_io",
  "schema",
  "identity_not_ready",
  "unknown",
] as const;
export type PersonSaveErrorCode = (typeof CODES)[number];
const STAGES = ["vault_check", "create_person", "open_person"] as const;
export type PersonSaveStage = (typeof STAGES)[number];
type PersonSaveError = { code: PersonSaveErrorCode; stage: PersonSaveStage; at: number };
let latest: PersonSaveError | null = null;

export function classifyPersonSaveError(err: unknown): PersonSaveErrorCode {
  // Expo SQLite generally wraps the native error in a JS Error message.
  // Inspect it here, then discard it: only the fixed category leaves this function.
  const raw = err instanceof Error ? err.message : err;
  const message = typeof raw === "string" ? raw.toLowerCase() : "";
  // The device signing key (lib/mesh/device-key.ts). applyEvent normally maps
  // this to EventSigningUnavailableError, which the screen records directly;
  // the pattern is here for any raw escape (SecureStore / keychain wording).
  if (/device (?:signing )?key|securestore|keychain|keystore/.test(message))
    return "signing_unavailable";
  if (/sqlite_full|database or disk is full|no space left on device/.test(message))
    return "storage_full";
  if (
    /sqlite_busy|sqlite_locked|database (?:table )?is locked|cannot start a transaction within a transaction/.test(
      message,
    )
  )
    return "storage_busy";
  if (/sqlite_constraint|constraint failed/.test(message)) return "storage_constraint";
  if (
    /sqlite_ioerr|sqlite_readonly|disk i\/o error|readonly database|read-only database/.test(
      message,
    )
  )
    return "storage_io";
  if (/no such (?:table|column)|has no column named|sqlite_schema/.test(message)) return "schema";
  if (
    /(?:install_id|active_vault_id|local.self user.?id).*not cached|local user not yet created|cannot append event: no local-self user/.test(
      message,
    )
  )
    return "identity_not_ready";
  return "unknown";
}

export async function recordPersonSaveError(
  code: PersonSaveErrorCode,
  stage: PersonSaveStage,
): Promise<void> {
  // Keep an in-memory copy too: a full/locked database may refuse diagnostics.
  latest = { code, stage, at: Date.now() };
  try {
    await setAppMeta(KEY, JSON.stringify(latest));
  } catch {
    // A failed diagnostic must never interfere with saving or the error UI.
  }
}

export async function getLastPersonSaveError(): Promise<PersonSaveError | null> {
  if (latest) return latest;
  try {
    const raw = await getAppMeta(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersonSaveError> | null;
    if (
      value &&
      CODES.includes(value.code as PersonSaveErrorCode) &&
      STAGES.includes(value.stage as PersonSaveStage) &&
      typeof value.at === "number" &&
      Number.isFinite(value.at)
    ) {
      // Reconstruct the object so unrelated fields from old/corrupt data cannot leak.
      return { code: value.code!, stage: value.stage!, at: value.at };
    }
  } catch {
    // App health remains available even when storage cannot be read.
  }
  return null;
}
