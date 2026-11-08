import type { SQLiteTx } from "./db-tx";
import { toAsciiDigits } from "./digits";
import { resolveAccountIdCandidates } from "./effective-account";
import {
  isTallyNoteEventType,
  type LedgerEvent,
  type TallyNoteAddedEvent,
  type TallyNoteRemovedEvent,
} from "./events";
import { parseVaultRole, type VaultRole } from "./vault-roles";

export const TALLY_NOTE_MAX_LENGTH = 500;
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOTE_NUMBER = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,6})?$/;

export function normalizeTallyNote(note: string): string | null {
  // Unicode White_Space matches the server's strings.TrimSpace. Reject NUL
  // (JSONB cannot store it) and unpaired surrogates (not Unicode scalars).
  const text = note.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  if (
    !text ||
    /[\u0000\uD800-\uDFFF]/u.test(text) ||
    Array.from(text).length > TALLY_NOTE_MAX_LENGTH
  )
    return null;
  return text;
}

/** An empty optional field returns undefined. Keep decimals as text so we
 * preserve the entered precision without rounding or treating it as money. */
export function normalizeTallyNoteNumber(raw: string): string | null | undefined {
  const value = toAsciiDigits(raw.trim())
    .replace(/[٫,]/g, ".")
    .replace(/^\./, "0.")
    .replace(/^0+(?=[0-9])/, "");
  if (!value) return undefined;
  return NOTE_NUMBER.test(value) ? value : null;
}

export function validTallyNoteEvent(
  event: LedgerEvent,
): event is TallyNoteAddedEvent | TallyNoteRemovedEvent {
  if (
    !isTallyNoteEventType(event.event_type) ||
    event.payload_schema !== 1 ||
    !event.vault_id ||
    !event.relationship_id ||
    !NOTE_ID.test(event.relationship_id) ||
    !NOTE_ID.test(event.target_id) ||
    !NOTE_ID.test(event.event_id) ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  )
    return false;
  const keys = Object.keys(event.payload);
  if (event.event_type === "tally_note_removed")
    return event.event_id !== event.target_id && keys.length === 0;
  const { note, number } = (event as TallyNoteAddedEvent).payload;
  const validNumber = keys.includes("number")
    ? keys.length === 2 && typeof number === "string" && normalizeTallyNoteNumber(number) === number
    : keys.length === 1;
  return (
    event.target_id === event.event_id &&
    keys.includes("note") &&
    validNumber &&
    typeof note === "string" &&
    normalizeTallyNote(note) === note
  );
}

/** Active roles only. A revoked or pending membership is not a viewer. */
export async function readCurrentTallyNoteRole(
  tx: SQLiteTx,
  vaultId: string,
  accountId: string | null,
): Promise<VaultRole | null> {
  const candidates = await resolveAccountIdCandidates(accountId);
  const vault = await tx.getFirstAsync<{
    account_id: string | null;
    registered_with_server_at: number | null;
  }>(
    "SELECT account_id,registered_with_server_at FROM vaults WHERE id=? AND archived_at IS NULL",
    vaultId,
  );
  if (!vault) return null;
  const members = await tx.getAllAsync<{
    account_id: string;
    role: string;
    accepted_at: number | null;
    revoked_at: number | null;
  }>(
    "SELECT account_id,role,accepted_at,revoked_at FROM vault_members_mirror WHERE vault_id=?",
    vaultId,
  );
  for (const id of candidates) {
    const row = members.find((member) => member.account_id === id);
    if (row)
      return row.accepted_at != null && row.revoked_at == null ? parseVaultRole(row.role) : null;
  }
  // Solo legacy setups can predate a membership mirror. Never treat a
  // missing row as implicit authority on a registered or shared Kaata.
  return members.length === 0 &&
    vault.registered_with_server_at == null &&
    (vault.account_id == null || candidates.includes(vault.account_id))
    ? "owner"
    : null;
}
