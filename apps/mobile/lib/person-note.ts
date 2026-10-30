import { getDb } from "./db-tx";
import type { EntryActor } from "./attribution";
import { isValidCustomerNote } from "./customer-note";
import type { HLC } from "./hlc";

export type PersonNoteStamp = { eventId: string; actor: EntryActor | null; at: number };
export type PersonNoteRevision = PersonNoteStamp & { note: string | null };
export type PersonNoteHistoryPage = {
  entries: PersonNoteRevision[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type PersonNoteDetails = {
  note: string | null;
  /** Earliest available save in the current known note/clear cycle. A partial
   * recovery cannot prove original creation; UI should say "first recorded". */
  author: PersonNoteStamp | null;
  updated: PersonNoteStamp | null;
  history: PersonNoteRevision[];
  historyCursor: string | null;
  hasMoreHistory: boolean;
};

const HISTORY_LIMIT = 50;
type Db = Awaited<ReturnType<typeof getDb>>;
type Relationship = { id: string; note: string | null; field_hlcs: string | null };
type RevisionRow = {
  event_id: string;
  actor_account_id: string | null;
  device_id: string;
  signer_device_pubkey: string | null;
  origin: string;
  hlc_physical_ms: number;
  hlc_logical: number;
  hlc_device_id: string;
  payload_json: string;
};
type Binding = { account_id: string; device_id: string; device_pubkey: string };
type IdentityContext = {
  names: Map<string, string>;
  selves: Set<string>;
  publicKeys: Map<string, string | null>;
  devices: Map<string, string | null>;
  credentials: Map<string, Binding>;
};

const REVISION_COLUMNS = `event_id, actor_account_id, device_id, signer_device_pubkey, origin,
  hlc_physical_ms, hlc_logical, hlc_device_id, payload_json`;
const CLOCK_COLUMNS = "hlc_physical_ms, hlc_logical, hlc_device_id";
const HISTORY_ORDER = `${CLOCK_COLUMNS}, event_id`;
// Applied alone is insufficient: refused writes and later server rejections
// remain in the append-only log. None should acquire a customer-note byline.
const VISIBLE_EVENTS = `vault_id=? AND relationship_id=? AND target_id=?
  AND event_type='person_note_set' AND applied_at IS NOT NULL
  AND rejected_at IS NULL AND quarantine_reason IS NULL AND tombstone_reason IS NULL
  AND CASE WHEN json_valid(payload_json)
    THEN json_type(payload_json, '$.note') IN ('text','null') ELSE 0 END`;

async function findRelationship(db: Db, vaultId: string, personId: string) {
  return db.getFirstAsync<Relationship>(
    `SELECT id,note,field_hlcs FROM relationships
      WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    vaultId,
    personId,
  );
}

function addUnambiguous(map: Map<string, string | null>, key: string, account: string) {
  if (!key || !account) return;
  if (!map.has(key)) map.set(key, account);
  else if (map.get(key) !== account) map.set(key, null);
}

async function identities(db: Db, vaultId: string, selfAccountIds: readonly string[]) {
  // Keep the original lightweight text getter independent of profile/i18n
  // modules; edit/create forms do not need attribution or historical reads.
  const { loadMemberNames } = await import("./attribution");
  const [names, registry, legacy] = await Promise.all([
    loadMemberNames(vaultId).catch(() => new Map<string, string>()),
    db.getAllAsync<Binding>(
      "SELECT account_id,device_id,device_pubkey FROM vault_device_registry WHERE vault_id=?",
      vaultId,
    ),
    db.getAllAsync<Binding>(
      "SELECT account_id,device_id,device_pubkey FROM vault_credentials WHERE vault_id=?",
      vaultId,
    ),
  ]);
  const context: IdentityContext = {
    names,
    selves: new Set(selfAccountIds.filter(Boolean)),
    publicKeys: new Map(),
    devices: new Map(),
    credentials: new Map(),
  };
  // Revoked bindings still identify who wrote an accepted historical revision.
  for (const row of registry) {
    addUnambiguous(context.publicKeys, row.device_pubkey, row.account_id);
    addUnambiguous(context.devices, row.device_id, row.account_id);
  }
  for (const row of legacy) context.credentials.set(row.device_id, row);
  return context;
}

function actorFor(row: RevisionRow, context: IdentityContext): EntryActor | null {
  let accountId: string | null = null;
  if (row.signer_device_pubkey && context.publicKeys.has(row.signer_device_pubkey)) {
    accountId = context.publicKeys.get(row.signer_device_pubkey) ?? null;
  } else {
    const credential = context.credentials.get(row.device_id);
    if (
      credential &&
      (!row.signer_device_pubkey || credential.device_pubkey === row.signer_device_pubkey)
    )
      accountId = credential.account_id;
    else if (!row.signer_device_pubkey && context.devices.has(row.device_id))
      accountId = context.devices.get(row.device_id) ?? null;
    // A remote root-signed restore may have no surviving credential. Its
    // claimed actor is informational, so render unknown rather than guessing.
    else if (row.origin === "local" || row.origin === "backfill") accountId = row.actor_account_id;
  }
  return accountId
    ? {
        accountId,
        name: context.names.get(accountId) ?? null,
        isSelf: context.selves.has(accountId),
      }
    : null;
}

function revision(row: RevisionRow, context: IdentityContext): PersonNoteRevision | null {
  if (
    !Number.isSafeInteger(row.hlc_physical_ms) ||
    row.hlc_physical_ms < 0 ||
    !Number.isSafeInteger(row.hlc_logical) ||
    row.hlc_logical < 0 ||
    !row.hlc_device_id
  )
    return null;
  try {
    const note: unknown = JSON.parse(row.payload_json).note;
    if (!isValidCustomerNote(note)) return null;
    // Signed HLC time belongs to the writer; appended_at is receipt-local and
    // would incorrectly date old edits as "now" after sync/restore.
    return { eventId: row.event_id, note, actor: actorFor(row, context), at: row.hlc_physical_ms };
  } catch {
    return null;
  }
}

function noteClock(raw: string | null): HLC | null {
  try {
    const value = JSON.parse(raw ?? "{}").note;
    return value &&
      Number.isSafeInteger(value.pms) &&
      value.pms >= 0 &&
      Number.isSafeInteger(value.l) &&
      value.l >= 0 &&
      typeof value.did === "string" &&
      value.did
      ? value
      : null;
  } catch {
    return null;
  }
}

type Cursor = {
  vaultId: string;
  relationshipId: string;
  pms: number;
  logical: number;
  did: string;
  eventId: string;
};
function parseCursor(cursor: string, vaultId: string, relationshipId: string): Cursor {
  let value: Cursor;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new Error("Invalid customer note history cursor");
  }
  if (
    !value ||
    value.vaultId !== vaultId ||
    value.relationshipId !== relationshipId ||
    !Number.isSafeInteger(value.pms) ||
    value.pms < 0 ||
    !Number.isSafeInteger(value.logical) ||
    value.logical < 0 ||
    typeof value.did !== "string" ||
    !value.did ||
    typeof value.eventId !== "string" ||
    !value.eventId
  )
    throw new Error("Invalid customer note history cursor");
  return value;
}

async function historyPage(
  db: Db,
  vaultId: string,
  relationshipId: string,
  context: IdentityContext,
  cursor?: string | null,
): Promise<PersonNoteHistoryPage> {
  const params: (string | number)[] = [vaultId, relationshipId, relationshipId];
  let before = "";
  if (cursor) {
    const value = parseCursor(cursor, vaultId, relationshipId);
    before = ` AND (${HISTORY_ORDER}) < (?,?,?,?)`;
    params.push(value.pms, value.logical, value.did, value.eventId);
  }
  params.push(HISTORY_LIMIT + 1);
  const rows = await db.getAllAsync<RevisionRow>(
    `SELECT ${REVISION_COLUMNS} FROM event_log WHERE ${VISIBLE_EVENTS}${before}
      ORDER BY hlc_physical_ms DESC,hlc_logical DESC,hlc_device_id DESC,event_id DESC LIMIT ?`,
    ...params,
  );
  const hasMore = rows.length > HISTORY_LIMIT;
  const visible = rows.slice(0, HISTORY_LIMIT);
  const last = visible[visible.length - 1];
  return {
    entries: visible
      .map((row) => revision(row, context))
      .filter((row): row is PersonNoteRevision => row !== null),
    hasMore,
    nextCursor:
      hasMore && last
        ? JSON.stringify({
            vaultId,
            relationshipId,
            pms: last.hlc_physical_ms,
            logical: last.hlc_logical,
            did: last.hlc_device_id,
            eventId: last.event_id,
          } satisfies Cursor)
        : null,
  };
}

/** Internal staff metadata. Read separately so bills and shared-tally payloads
 * never acquire it through a serialized PersonWithBalance object. The caller
 * may already hold applyEventMutex for a consistent customer-page snapshot. */
export async function getPersonNote(vaultId: string, personId: string): Promise<string | null> {
  const row = await (
    await getDb()
  ).getFirstAsync<{ note: string | null }>(
    `SELECT note FROM relationships
      WHERE vault_id=? AND user_b_id=? AND archived_at IS NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    vaultId,
    personId,
  );
  return row?.note ?? null;
}

/** Internal note text, its exact winning revision, and paged original history.
 * Call under applyEventMutex when combining this with a customer snapshot.
 * Neither this model nor historical text is part of public/shared Person rows. */
export async function getPersonNoteDetails(
  vaultId: string,
  personId: string,
  selfAccountIds: readonly string[] = [],
): Promise<PersonNoteDetails> {
  const db = await getDb();
  const relationship = await findRelationship(db, vaultId, personId);
  const details: PersonNoteDetails = {
    note: relationship?.note ?? null,
    author: null,
    updated: null,
    history: [],
    historyCursor: null,
    hasMoreHistory: false,
  };
  if (!relationship) return details;
  try {
    const args = [vaultId, relationship.id, relationship.id];
    // The common never-noted customer avoids all member/device lookups.
    if (
      !(await db.getFirstAsync(`SELECT 1 FROM event_log WHERE ${VISIBLE_EVENTS} LIMIT 1`, ...args))
    )
      return details;
    const context = await identities(db, vaultId, selfAccountIds);
    const page = await historyPage(db, vaultId, relationship.id, context);
    details.history = page.entries;
    details.historyCursor = page.nextCursor;
    details.hasMoreHistory = page.hasMore;
    const clock = noteClock(relationship.field_hlcs);
    if (!clock) return details;
    const atClock = await db.getAllAsync<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM event_log WHERE ${VISIBLE_EVENTS}
      AND (${CLOCK_COLUMNS})=(?,?,?) LIMIT 2`,
      ...args,
      clock.pms,
      clock.l,
      clock.did,
    );
    // Equal-clock competing rows cannot be ordered by UUID: projection skips
    // equal clocks. Keep the visible text, but never guess its current byline.
    if (atClock.length !== 1) return details;
    const winning = revision(atClock[0], context);
    if (!winning || winning.note !== relationship.note) return details;
    details.updated = { eventId: winning.eventId, actor: winning.actor, at: winning.at };
    if (relationship.note === null) return details;
    const cleared = await db.getFirstAsync<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM event_log WHERE ${VISIBLE_EVENTS}
      AND (${CLOCK_COLUMNS}) < (?,?,?)
      AND CASE WHEN json_valid(payload_json) THEN json_type(payload_json,'$.note')='null' ELSE 0 END
      ORDER BY hlc_physical_ms DESC,hlc_logical DESC,hlc_device_id DESC LIMIT 1`,
      ...args,
      clock.pms,
      clock.l,
      clock.did,
    );
    const afterClear = cleared ? ` AND (${CLOCK_COLUMNS}) > (?,?,?)` : "";
    const first = await db.getAllAsync<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM event_log WHERE ${VISIBLE_EVENTS}
      AND (${CLOCK_COLUMNS}) <= (?,?,?)${afterClear}
      AND CASE WHEN json_valid(payload_json) THEN json_type(payload_json,'$.note')='text' ELSE 0 END
      ORDER BY hlc_physical_ms ASC,hlc_logical ASC,hlc_device_id ASC LIMIT 2`,
      ...args,
      clock.pms,
      clock.l,
      clock.did,
      ...(cleared ? [cleared.hlc_physical_ms, cleared.hlc_logical, cleared.hlc_device_id] : []),
    );
    const author = first[0] ? revision(first[0], context) : null;
    const ambiguousAuthor =
      first[1] &&
      first[0].hlc_physical_ms === first[1].hlc_physical_ms &&
      first[0].hlc_logical === first[1].hlc_logical &&
      first[0].hlc_device_id === first[1].hlc_device_id;
    if (author && !ambiguousAuthor)
      details.author = { eventId: author.eventId, actor: author.actor, at: author.at };
    return details;
  } catch {
    // Notes predate this display feature and remain useful if optional
    // identity/history metadata cannot be read. Never break the customer page
    // or log its private text just because a byline is unavailable.
    console.warn("[customer-note] optional attribution/history unavailable");
    return details;
  }
}

/** More private revisions, newest first. Cursor scope prevents paging a
 * previously open customer/Kaata into the currently visible note's history. */
export async function getPersonNoteHistory(
  vaultId: string,
  personId: string,
  selfAccountIds: readonly string[] = [],
  cursor?: string | null,
): Promise<PersonNoteHistoryPage> {
  const db = await getDb();
  const relationship = await findRelationship(db, vaultId, personId);
  if (!relationship) return { entries: [], hasMore: false, nextCursor: null };
  if (cursor) parseCursor(cursor, vaultId, relationship.id);
  return historyPage(
    db,
    vaultId,
    relationship.id,
    await identities(db, vaultId, selfAccountIds),
    cursor,
  );
}
