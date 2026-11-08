import { getBackendUrl } from "./api";
import { applyForCurrentSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import { currencyRequestHeaders } from "./currency-sync";
import { isValidCustomerNote } from "./customer-note";
import { getAppMetaInTx, getDb, setAppMetaInTx } from "./db-tx";
import { verifyEventSignature } from "./event-sig";
import { isTallyNoteEventType, type LedgerEvent } from "./events";
import { applyEventMutex } from "./projection";
import {
  ingestPulledEvents,
  mapPulledWireToEvent,
  type PulledWireEvent,
} from "./projection/ingest-row";
import { sweepVaultNow } from "./projection/sweep";
import { validTallyNoteEvent } from "./tally-note-policy";

const PAGE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 6_000;
const inFlight = new Map<string, Promise<boolean>>();
type NoteHistory = {
  endpoint: string;
  marker: string;
  matches: (type: string) => boolean;
  validate: (event: LedgerEvent) => boolean;
};
const CONTACT_NOTES: NoteHistory = {
  endpoint: "person-notes",
  marker: "person_notes_history_v1",
  matches: (type: string) => type === "person_note_set",
  validate: (event: LedgerEvent) =>
    event.event_type === "person_note_set" &&
    event.target_id === event.relationship_id &&
    isValidCustomerNote(event.payload.note),
};
const TALLY_NOTES: NoteHistory = {
  endpoint: "tally-notes",
  marker: "tally_notes_history_v1",
  matches: isTallyNoteEventType,
  validate: validTallyNoteEvent,
};

/** Old clients could restore a snapshot without understanding note history.
 * Recover only that signed history, without rewinding their ledger cursor. */
export async function syncPersonNotesHistory(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<boolean> {
  return syncNoteHistory(CONTACT_NOTES, vaultId, expected);
}

export async function syncTallyNotesHistory(
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<boolean> {
  return syncNoteHistory(TALLY_NOTES, vaultId, expected);
}

async function syncNoteHistory(
  history: NoteHistory,
  vaultId: string,
  expected?: SessionSnapshot,
): Promise<boolean> {
  const session = expected ?? (await captureCurrentSession());
  if (!session.jwt || !session.accountId) return false;
  const key = `${history.marker}:${session.accountId}:${vaultId}`;
  const current = inFlight.get(key);
  if (current) return current;
  const work = recover(history, vaultId, session, key);
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    if (inFlight.get(key) === work) inFlight.delete(key);
  }
}

async function recover(
  history: NoteHistory,
  vaultId: string,
  session: SessionSnapshot,
  marker: string,
): Promise<boolean> {
  function apply<T>(work: () => Promise<T>): Promise<T> {
    return applyForCurrentSession(session, work);
  }
  const db = await getDb();
  if ((await apply(() => getAppMetaInTx(db, marker))) === "1") return true;
  const baseUrl = await getBackendUrl();
  const headers = await apply(() => currencyRequestHeaders(db, vaultId));
  let after = 0;
  for (;;) {
    await apply(async () => {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let body: unknown;
    try {
      const response = await fetch(
        `${baseUrl}/v1/sync/${history.endpoint}?vault_id=${encodeURIComponent(vaultId)}&after_server_seq=${after}&limit=${PAGE_LIMIT}`,
        {
          headers: { ...headers, Authorization: `Bearer ${session.jwt}` },
          signal: controller.signal,
        },
      );
      // A server upgrade will be picked up on a later normal sync. Never mark
      // an unsupported, unavailable or denied response as recovered.
      if (!response.ok) return false;
      body = await response.json();
    } finally {
      clearTimeout(timer);
    }
    const page = validatePage(history, body, vaultId, after);
    await apply(async () => {
      await ingestPulledEvents(page.events, Date.now());
      await sweepVaultNow(vaultId);
    });
    if (!page.hasMore) {
      // This flag records durable original events, not successful projection:
      // missing membership prerequisites remain in the normal retrying sweep.
      await apply(() => applyEventMutex.runExclusive(() => setAppMetaInTx(db, marker, "1")));
      return true;
    }
    after = page.next;
  }
}

function validatePage(history: NoteHistory, body: unknown, vaultId: string, after: number) {
  const page = body as Record<string, unknown> | null;
  if (
    !page ||
    page.vault_id !== vaultId ||
    !Array.isArray(page.events) ||
    page.events.length > PAGE_LIMIT ||
    typeof page.has_more !== "boolean" ||
    !Number.isSafeInteger(page.next_after_server_seq)
  )
    throw new Error("Invalid note history response");
  let previous = after;
  const events = page.events.map((raw: PulledWireEvent & { vault_id?: unknown }) => {
    if (
      !raw ||
      !history.matches(raw.event_type) ||
      (raw.vault_id !== undefined && raw.vault_id !== vaultId) ||
      typeof raw.event_id !== "string" ||
      !raw.event_id ||
      typeof raw.device_id !== "string" ||
      !raw.device_id ||
      typeof raw.target_id !== "string" ||
      !raw.target_id ||
      typeof raw.server_seq !== "number" ||
      !Number.isSafeInteger(raw.server_seq) ||
      raw.server_seq <= previous ||
      typeof raw.event_sig_b64 !== "string" ||
      typeof raw.signer_device_pubkey !== "string"
    )
      throw new Error("Invalid signed note history");
    const event = mapPulledWireToEvent(raw, vaultId);
    if (
      !history.validate(event) ||
      !Number.isSafeInteger(event.hlc.pms) ||
      event.hlc.pms < 0 ||
      event.hlc.pms > Date.now() + 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(event.hlc.l) ||
      event.hlc.l < 0 ||
      typeof event.hlc.did !== "string" ||
      !event.hlc.did ||
      !verifyEventSignature(event, raw.event_sig_b64, raw.signer_device_pubkey).valid
    )
      throw new Error("Invalid note history signature");
    previous = raw.server_seq;
    return event;
  });
  if (page.next_after_server_seq !== previous || (page.has_more && events.length === 0))
    throw new Error("Invalid note history page cursor");
  return { events, hasMore: page.has_more, next: previous };
}
