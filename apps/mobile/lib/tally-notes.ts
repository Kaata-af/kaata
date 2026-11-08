import * as Crypto from "expo-crypto";
import { loadMemberNames } from "./attribution";
import { applyForUnchangedLocalSession, captureCurrentSession, SessionChangedError } from "./auth";
import {
  getActiveVaultIdSyncMaybe,
  getDb,
  getInstallIdSync,
  getLocalSelfUserIdSync,
  type SQLiteTx,
} from "./db-tx";
import { RoleGateRejectionError } from "./event-log";
import type { TallyNoteAddedEvent, TallyNoteRemovedEvent } from "./events";
import { applyLocalEventsAtomically, AtomicEventRejectionError } from "./projection";
import { normalizeTallyNote, readCurrentTallyNoteRole } from "./tally-note-policy";

export { normalizeTallyNote, TALLY_NOTE_MAX_LENGTH } from "./tally-note-policy";

export type TallyNote = {
  id: string;
  note: string;
  createdAt: number;
  authorAccountId: string | null;
  authorName: string | null;
};

class NoteAlreadyRemoved extends Error {}

function assertActiveVault(vaultId: string): void {
  if (getActiveVaultIdSyncMaybe() !== vaultId) throw new SessionChangedError();
}

async function activeRelationship(db: SQLiteTx, vaultId: string, personId: string) {
  return db.getFirstAsync<{ id: string }>(
    `SELECT id FROM relationships WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL
      ORDER BY created_at DESC, id LIMIT 1`,
    vaultId,
    personId,
  );
}

export async function listTallyNotes(vaultId: string, personId: string): Promise<TallyNote[]> {
  assertActiveVault(vaultId);
  const session = await captureCurrentSession();
  return applyForUnchangedLocalSession(session, async () => {
    assertActiveVault(vaultId);
    const db = await getDb();
    if (!(await readCurrentTallyNoteRole(db, vaultId, session.accountId))) return [];
    const relationship = await activeRelationship(db, vaultId, personId);
    if (!relationship) return [];
    const rows = await db.getAllAsync<Omit<TallyNote, "authorName">>(
      `SELECT n.id,n.note,n.created_at AS createdAt,
              COALESCE(
                n.author_account_id,
                (SELECT d.account_id FROM vault_device_registry d
                  WHERE d.vault_id=n.vault_id AND d.device_id=n.author_device_id
                  ORDER BY d.removed_at_ms IS NOT NULL,d.added_at_ms DESC LIMIT 1)
              ) AS authorAccountId
         FROM tally_notes n
        WHERE n.vault_id=? AND n.relationship_id=? AND n.removed_at IS NULL
        ORDER BY n.created_at DESC,n.id`,
      vaultId,
      relationship.id,
    );
    const names = rows.length > 0 ? await loadMemberNames(vaultId) : null;
    assertActiveVault(vaultId);
    if (!(await readCurrentTallyNoteRole(db, vaultId, session.accountId))) return [];
    return rows.map((row) => ({
      ...row,
      authorName: row.authorAccountId ? (names?.get(row.authorAccountId) ?? null) : null,
    }));
  });
}

async function writeTallyNote(
  vaultId: string,
  personId: string,
  operation: { note: string } | { removeId: string },
): Promise<void> {
  assertActiveVault(vaultId);
  const session = await captureCurrentSession();
  await applyForUnchangedLocalSession(session, async () => {
    const deviceId = getInstallIdSync();
    const authorId = getLocalSelfUserIdSync();
    if (!authorId) throw new Error("Tally notes require a local profile");
    const guard = () => {
      assertActiveVault(vaultId);
      if (getInstallIdSync() !== deviceId || getLocalSelfUserIdSync() !== authorId)
        throw new SessionChangedError();
    };
    guard();
    const relationship = await activeRelationship(await getDb(), vaultId, personId);
    if (!relationship) throw new Error("The contact is no longer active in this Kaata");
    const eventId = Crypto.randomUUID();
    const base = {
      event_id: eventId,
      vault_id: vaultId,
      relationship_id: relationship.id,
      hlc: { pms: 0, l: 0, did: deviceId },
      device_id: deviceId,
      author_user_id_local_only: authorId,
      actor_account_id: session.accountId,
      payload_schema: 1,
      appended_at: 0,
      server_acked_at: null,
      rejected_at: null,
      origin: "local" as const,
    };
    const event: TallyNoteAddedEvent | TallyNoteRemovedEvent =
      "note" in operation
        ? {
            ...base,
            event_type: "tally_note_added",
            target_id: eventId,
            payload: { note: operation.note },
          }
        : { ...base, event_type: "tally_note_removed", target_id: operation.removeId, payload: {} };
    const preflight = async (tx: SQLiteTx) => {
      guard();
      if ((await activeRelationship(tx, vaultId, personId))?.id !== relationship.id)
        throw new Error("The contact is no longer active in this Kaata");
      if (event.event_type === "tally_note_removed") {
        const row = await tx.getFirstAsync<{ removed_at: number | null }>(
          "SELECT removed_at FROM tally_notes WHERE vault_id=? AND relationship_id=? AND id=?",
          vaultId,
          relationship.id,
          event.target_id,
        );
        if (!row) throw new Error("The tally note no longer exists on this contact");
        if (row.removed_at !== null) throw new NoteAlreadyRemoved();
      }
    };
    try {
      await applyLocalEventsAtomically([event], { preflight, guard });
    } catch (err) {
      if (err instanceof NoteAlreadyRemoved) return;
      if (err instanceof AtomicEventRejectionError && err.result.role_gate)
        throw new RoleGateRejectionError(err.result.role_gate);
      throw err;
    }
  });
}

export async function addTallyNote(
  vaultId: string,
  personId: string,
  value: string,
): Promise<void> {
  const note = normalizeTallyNote(value);
  if (note === null) throw new Error("Invalid tally note");
  await writeTallyNote(vaultId, personId, { note });
}

export function removeTallyNote(vaultId: string, personId: string, noteId: string): Promise<void> {
  return writeTallyNote(vaultId, personId, { removeId: noteId });
}
