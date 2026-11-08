import type { SQLiteTx } from "../db-tx";
import type { LedgerEvent } from "../events";
import { validTallyNoteEvent } from "../tally-note-policy";
import { MissingPrereqError } from "./errors";

export async function applyTallyNote(
  tx: SQLiteTx,
  event: LedgerEvent,
  authenticatedAccountId: string | null = null,
): Promise<void> {
  if (!validTallyNoteEvent(event)) throw new Error("Invalid tally note");
  const scope = [event.vault_id, event.relationship_id, event.target_id] as const;
  if (
    !(await tx.getFirstAsync(
      "SELECT 1 FROM relationships WHERE vault_id=? AND id=?",
      scope[0],
      scope[1],
    ))
  )
    throw new MissingPrereqError("Tally note relationship has not arrived");

  if (event.event_type === "tally_note_added") {
    await tx.runAsync(
      `INSERT INTO tally_notes (vault_id,relationship_id,id,note,created_at,author_account_id,author_device_id)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (vault_id,relationship_id,id) DO UPDATE SET
         note=excluded.note, created_at=excluded.created_at,
         author_account_id=excluded.author_account_id, author_device_id=excluded.author_device_id
       WHERE tally_notes.note IS NULL`,
      ...scope,
      event.payload.note,
      event.hlc.pms,
      authenticatedAccountId,
      event.device_id,
    );
  } else {
    // A manager may receive a note over mesh, then upload its removal before
    // the author's phone uploads creation. Keep the tombstone in either order.
    await tx.runAsync(
      `INSERT INTO tally_notes (vault_id,relationship_id,id,removed_at)
       VALUES (?,?,?,?)
       ON CONFLICT (vault_id,relationship_id,id) DO UPDATE SET
         removed_at=MIN(COALESCE(tally_notes.removed_at,excluded.removed_at),excluded.removed_at)`,
      ...scope,
      event.hlc.pms,
    );
  }
}
