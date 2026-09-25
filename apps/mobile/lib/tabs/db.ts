// apps/mobile/lib/tabs/db.ts
//
// The local cache of a mutual tab: tab_links / tab_entries / tab_outbox
// (migration 028 in lib/db.ts). This is a CACHE of server state plus an outbox
// of this device's intent — never a projection of the vault event log (D2).
// Nothing here writes entries, event_log or any vault table, and nothing here
// is signed or role-gated: the server is the source of truth (D1) and the
// session JWT and server-side party membership authorize requests.
//
// Rules every function follows:
//   - getDb() from lib/db-tx and its own (implicit or explicit) transaction.
//     None of these run inside applyEvent's transaction and none call
//     setAppMeta, which is a bare statement on the shared connection that
//     would otherwise join — and roll back with — whatever is open.
//   - No import of lib/db.ts. lib/db.ts imports THIS module (read-site
//     integration), so the reverse edge would be a cycle.
//   - Money is integer hundredths in tab_entries.amount_minor. The mapped
//     Entry gets major units through fromMinorUnits, exactly like every
//     balance read divides by 100.0.
//   - The ledger-refresh notifier is reached through a lazy require, the
//     shape lib/projection/index.ts uses, so loading this module never pulls
//     react-native into a Node selftest that loads lib/db.ts.

import { getAccountIdSync, getActiveVaultIdSyncMaybe, getDb } from "../db-tx";
import { fromMinorUnits, toMinorUnits } from "../money";
import type { Entry, EntryType } from "../types";
import { directionFor, entryTypeFor, otherRole } from "./direction";
import { emitTabApplied } from "./events";
import { TabReviewFinalError } from "./errors";
import type {
  TabAppliedEvent,
  TabEntryRow,
  TabEntryStatus,
  TabLink,
  TabOutboxRow,
  TabResponse,
  WireEntry,
} from "./types";
import { wireToMinor } from "./wire";

// Anything longer is a stack trace, not a diagnosis; the App health report
// shows this verbatim and the column is TEXT with no other reader.
const LAST_ERROR_MAX = 200;

// Share the ledger writer lock: Expo's shared SQLite handle otherwise lets
// concurrent tab and vault transactions join/roll back each other's writes.
async function transaction(fn: () => Promise<void>): Promise<void> {
  const { applyEventMutex } = require("../projection") as typeof import("../projection");
  const db = await getDb();
  await applyEventMutex.runExclusive(() => db.withTransactionAsync(fn));
}

/**
 * Tell the screens something changed for `vaultId`. Origin "remote" is the
 * one that ONLY refreshes: "local" would kick the vault push (scheduler) and
 * the mesh dial (btc-steady) for a write that is not in the event log, and
 * bg-notify's remote listener is gated on the app being backgrounded, which a
 * tap-driven optimistic write never is. Lazy require: see the header.
 */
function notifyTabChanged(vaultId: string, ev: TabAppliedEvent): void {
  emitTabApplied(ev);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { emitLedgerApplied } = require("../ledger-events") as {
      emitLedgerApplied: (vaultId: string, origin: "local" | "remote" | "backfill") => void;
    };
    emitLedgerApplied(vaultId, "remote");
  } catch {
    /* best-effort */
  }
}

function clampError(err: string): string {
  return err.length > LAST_ERROR_MAX ? err.slice(0, LAST_ERROR_MAX) : err;
}

// ---------------------------------------------------------------------------
// tab_links

/** The OPEN link on a relationship, if any (closed links are history). */
export async function getTabLinkForRelationship(relationshipId: string): Promise<TabLink | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<TabLink>(
    `SELECT * FROM tab_links WHERE relationship_id = ? AND closed_at IS NULL LIMIT 1`,
    relationshipId,
  );
  return row ?? null;
}

/**
 * The open link for a person (users.id) through their ACTIVE relationship in
 * the ACTIVE vault — the same resolution db.ts uses for every person read, so
 * a stale id from another kaata never surfaces another kaata's tab.
 */
export async function getTabLinkForPerson(personId: string): Promise<TabLink | null> {
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) return null;
  const db = await getDb();
  const row = await db.getFirstAsync<TabLink>(
    `SELECT tl.*
       FROM tab_links tl
       INNER JOIN relationships r ON r.id = tl.relationship_id
      WHERE r.user_b_id = ?
        AND r.vault_id  = ?
        AND r.archived_at IS NULL
        AND tl.closed_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT 1`,
    personId,
    vaultId,
  );
  return row ?? null;
}

/**
 * The contact's tab whether it is open or CLOSED — the read-path twin of
 * getTabLinkForPerson (which stays open-only because it decides where a new
 * tally is written). Closing a tab freezes its rows, it does not un-happen
 * them: the shared period is still this contact's history and still counts
 * toward the balance, and the pre-link local rows it carried into the
 * opening entry must stay excluded forever (D8). Callers that ACT on the tab
 * must check `closed_at` themselves.
 *
 * The open link wins when there is one (at most one, by
 * idx_tab_links_open_rel); otherwise the most recently linked closed one.
 */
export async function getLatestTabLinkForPerson(personId: string): Promise<TabLink | null> {
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) return null;
  const db = await getDb();
  const row = await db.getFirstAsync<TabLink>(
    `SELECT tl.*
       FROM tab_links tl
       INNER JOIN relationships r ON r.id = tl.relationship_id
      WHERE r.user_b_id = ?
        AND r.vault_id  = ?
        AND r.archived_at IS NULL
      ORDER BY (tl.closed_at IS NULL) DESC, tl.linked_at DESC
      LIMIT 1`,
    personId,
    vaultId,
  );
  return row ?? null;
}

/**
 * ANY tab on this relationship, open or closed (latest first) — the guard the
 * JOIN path needs. Party b never mints an opening entry, and only the latest
 * tab counts toward the balance, so joining a second tab onto a contact that
 * already holds a frozen one would silently zero months of history. Party a's
 * linkContact deliberately uses the open-only getTabLinkForRelationship
 * instead: re-linking is fine there, because its opening entry carries the
 * frozen balance forward.
 */
export async function getAnyTabLinkForRelationship(
  relationshipId: string,
): Promise<TabLink | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<TabLink>(
    `SELECT * FROM tab_links WHERE relationship_id = ?
      ORDER BY (closed_at IS NULL) DESC, linked_at DESC LIMIT 1`,
    relationshipId,
  );
  return row ?? null;
}

/** By tab id, open or closed. */
export async function getTabLink(tabId: string): Promise<TabLink | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<TabLink>(`SELECT * FROM tab_links WHERE tab_id = ?`, tabId);
  return row ?? null;
}

/** Every link, open ones by default; optionally one vault's only. */
export async function listTabLinks(
  opts: { vaultId?: string; includeClosed?: boolean } = {},
): Promise<TabLink[]> {
  const db = await getDb();
  const where: string[] = [];
  const args: string[] = [];
  if (opts.vaultId) {
    where.push("vault_id = ?");
    args.push(opts.vaultId);
  }
  if (!opts.includeClosed) where.push("closed_at IS NULL");
  const sql = `SELECT * FROM tab_links${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY linked_at ASC`;
  return db.getAllAsync<TabLink>(sql, ...args);
}

/** Insert or overwrite a link row wholesale (the caller owns every column). */
export async function upsertTabLink(link: TabLink): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO tab_links (tab_id, vault_id, relationship_id, role, currency, party_token,
                            my_label, other_label, other_joined_at, invite_url, rev, closed_at,
                            linked_at, last_synced_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tab_id) DO UPDATE SET
       vault_id = excluded.vault_id, relationship_id = excluded.relationship_id,
       role = excluded.role, currency = excluded.currency, party_token = excluded.party_token,
       my_label = excluded.my_label, other_label = excluded.other_label,
       other_joined_at = excluded.other_joined_at, invite_url = excluded.invite_url,
       rev = excluded.rev, closed_at = excluded.closed_at, linked_at = excluded.linked_at,
       last_synced_at = excluded.last_synced_at, last_error = excluded.last_error`,
    link.tab_id,
    link.vault_id,
    link.relationship_id,
    link.role,
    link.currency,
    link.party_token,
    link.my_label,
    link.other_label,
    link.other_joined_at,
    link.invite_url,
    link.rev,
    link.closed_at,
    link.linked_at,
    link.last_synced_at,
    link.last_error,
  );
}

/** Record (or clear, with null) the last sync failure for the App health line. */
export async function setTabLinkError(tabId: string, err: string | null): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE tab_links SET last_error = ? WHERE tab_id = ?`,
    err == null ? null : clampError(err),
    tabId,
  );
}

/** Party a re-shares from this; a regenerate-link response lands here. */
export async function setTabInviteUrl(tabId: string, inviteUrl: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE tab_links SET invite_url = ? WHERE tab_id = ?`, inviteUrl, tabId);
}

/**
 * Close locally: the tab FREEZES. Its rows stay on the contact and keep
 * counting, the pre-link rows it absorbed stay excluded, and the only change
 * is that nothing can be written to it any more (D8) — every read site joins
 * the latest link open OR closed, precisely so a close cannot take months of
 * shared tallies and the balance away with it. The server close follows
 * through the outbox. Idempotent (COALESCE keeps the first stamp).
 */
export async function markTabClosedLocally(tabId: string, closedAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE tab_links SET closed_at = COALESCE(closed_at, ?) WHERE tab_id = ?`,
    closedAt,
    tabId,
  );
}

/** D9 guard for changeVaultCurrency: an open tab pins the kaata's currency. */
export async function vaultHasOpenTab(vaultId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ one: number }>(
    `SELECT 1 AS one FROM tab_links WHERE vault_id = ? AND closed_at IS NULL LIMIT 1`,
    vaultId,
  );
  return row != null;
}

// ---------------------------------------------------------------------------
// tab_entries

const ENTRY_COLUMNS = `id, tab_id, seq, rev, created_by, direction, amount_minor, kind, note,
   occurred_at, created_at, status, status_at, dispute_reason, voids_entry_id,
   voided_by_entry_id, local_pending, author_account_id, author_name`;

type PrevRow = Pick<TabEntryRow, "id" | "created_by" | "status" | "voided_by_entry_id">;

/**
 * Apply a server response to the cache.
 *
 *   full=true   → the server sent everything (after_rev 0): every cached row
 *                 the server has acked is dropped first, so a row that no
 *                 longer exists server-side cannot linger. Optimistic rows
 *                 (local_pending=1) survive unless the response carries their
 *                 id — their outbox op has not been acked yet.
 *   full=false  → rows with rev > cursor; upsert by id.
 *
 * INSERT OR REPLACE by id is what clears local_pending: the server's copy of
 * an optimistic append carries local_pending 0. The counts are what the
 * notifier needs — rows by the OTHER party seen for the first time (never a
 * void row; the struck original is the visible event), and MY rows whose
 * status or voided flag moved (the other party accepted / disputed, or one
 * of my other devices voided). Then tab_links gets the tab meta (labels,
 * joined, closed, cursor) and both notifiers fire — but only when something
 * actually changed, so a no-op 60 s poll does not re-query every screen.
 *
 * The link row is created as a skeleton if missing so this is safe in any
 * order with upsertTabLink; the FK on tab_entries needs it to exist first.
 */
export async function upsertTabFromWire(
  link: Pick<TabLink, "tab_id" | "vault_id" | "relationship_id" | "party_token" | "linked_at">,
  resp: TabResponse,
  opts: { origin?: TabAppliedEvent["origin"]; advanceCursor?: boolean } = {},
): Promise<{ newFromThem: number; statusChangedOnMine: number }> {
  // The cursor means "every row with rev <= cursor is cached". Only a PULL can
  // promise that: an op ack (append/accept/dispute) carries one row and the
  // tab's current rev, and rows the other party wrote between the old cursor
  // and that rev are not in it. Advancing on an ack silently skipped them —
  // the pull that followed asked after_rev=<ack rev> and got nothing back.
  // Acks therefore apply their row and meta with advanceCursor:false and the
  // pull that follows every flush starts from the untouched cursor (re-fetching
  // the acked row is an idempotent upsert).
  const advanceCursor = opts.advanceCursor !== false;
  const db = await getDb();
  const now = Date.now();
  let newFromThem = 0;
  let statusChangedOnMine = 0;
  const changes: NonNullable<TabAppliedEvent["changes"]> = [];
  let changed = false;
  let vaultId = link.vault_id;
  let relationshipId = link.relationship_id;

  await transaction(async () => {
    await db.runAsync(
      `INSERT OR IGNORE INTO tab_links (tab_id, vault_id, relationship_id, role, currency,
                                        party_token, linked_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      link.tab_id,
      link.vault_id,
      link.relationship_id,
      resp.tab.you,
      resp.tab.currency,
      link.party_token,
      link.linked_at,
    );
    const stored = await db.getFirstAsync<TabLink>(
      `SELECT * FROM tab_links WHERE tab_id = ?`,
      link.tab_id,
    );
    if (!stored) throw new Error(`tab_links row missing after upsert: ${link.tab_id}`);
    // An older response must not erase rows from a newer full pull while
    // retaining its higher cursor (which would prevent fetching them again).
    if (resp.tab.rev < stored.rev) return;
    vaultId = stored.vault_id;
    relationshipId = stored.relationship_id;
    // The stored role is the one this device linked as; the server's `you`
    // agrees unless the credential changed hands, and the cache must keep
    // reading as the party that owns these rows.
    const me = stored.role;
    const them = otherRole(me);

    const prevRows = await db.getAllAsync<PrevRow>(
      `SELECT id, created_by, status, voided_by_entry_id FROM tab_entries WHERE tab_id = ?`,
      link.tab_id,
    );
    const prev = new Map(prevRows.map((r) => [r.id, r]));

    if (resp.full) {
      const del = await db.runAsync(
        `DELETE FROM tab_entries WHERE tab_id = ? AND local_pending = 0`,
        link.tab_id,
      );
      if (del.changes > 0) changed = true;
    }

    for (const e of resp.entries) {
      const before = prev.get(e.id);
      await db.runAsync(
        `INSERT OR REPLACE INTO tab_entries (${ENTRY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        e.id,
        link.tab_id,
        e.seq,
        e.rev,
        e.created_by,
        e.direction,
        wireToMinor(e.amount),
        e.kind,
        e.note,
        e.occurred_at_ms,
        e.created_at_ms,
        e.status,
        e.status_at_ms,
        e.dispute_reason,
        e.voids_entry_id,
        e.voided_by_entry_id,
        e.author_account_id ?? null,
        e.author_name ?? "",
      );
      changed = true;
      if (!before) {
        if (e.created_by === them && e.kind !== "void") {
          newFromThem++;
          if (stored.last_synced_at != null && e.status === "pending" && !e.voided_by_entry_id)
            changes.push({ entryId: e.id, rev: e.rev, kind: "entry_created" });
        }
      } else if (e.created_by === me) {
        const wasVoided = before.voided_by_entry_id != null;
        const isVoided = e.voided_by_entry_id != null;
        if (before.status !== e.status || wasVoided !== isVoided) {
          statusChangedOnMine++;
          changes.push({
            entryId: e.id,
            rev: e.rev,
            kind: isVoided
              ? "entry_voided"
              : e.status === "accepted"
                ? "entry_accepted"
                : "entry_rejected",
          });
        }
      }
    }

    await db.runAsync(
      "UPDATE tab_links SET other_account_name=? WHERE tab_id=?",
      resp.tab.parties[them].account_name ?? "",
      link.tab_id,
    );
    const meta = {
      my_label: resp.tab.parties[me].label,
      other_label: resp.tab.parties[them].label,
      other_joined_at: resp.tab.parties[them].joined_at_ms,
      closed_at: resp.tab.closed_at_ms,
    };
    if (
      (resp.tab.parties[them].account_name ?? "") !== (stored.other_account_name ?? "") ||
      meta.my_label !== stored.my_label ||
      meta.other_label !== stored.other_label ||
      meta.other_joined_at !== stored.other_joined_at ||
      meta.closed_at !== stored.closed_at ||
      (advanceCursor && resp.tab.rev > stored.rev)
    ) {
      changed = true;
    }
    // MAX keeps the cursor monotonic: an incremental response that raced an
    // older full one must never rewind it and re-pull applied rows.
    await db.runAsync(
      `UPDATE tab_links
          SET rev = MAX(rev, ?), currency = ?, my_label = ?, other_label = ?,
              other_joined_at = ?, closed_at = ?, last_synced_at = ?, last_error = NULL
        WHERE tab_id = ?`,
      advanceCursor ? resp.tab.rev : stored.rev,
      resp.tab.currency,
      meta.my_label,
      meta.other_label,
      meta.other_joined_at,
      meta.closed_at,
      now,
      link.tab_id,
    );
  });

  if (changed) {
    notifyTabChanged(vaultId, {
      tabId: link.tab_id,
      relationshipId,
      vaultId,
      newFromThem,
      statusChangedOnMine,
      origin: opts.origin ?? "pull",
      changes,
    });
  }
  return { newFromThem, statusChangedOnMine };
}

/** A single wire entry into the cache (append / accept / dispute acks). */
export function entriesResponse(tab: TabResponse["tab"], entries: WireEntry[]): TabResponse {
  return { tab, entries, full: false };
}

function rowToEntry(link: TabLink, r: TabEntryRow): Entry {
  return {
    id: r.id,
    relationship_id: link.relationship_id,
    type: entryTypeFor(link.role, r.direction),
    amount_afn: fromMinorUnits(r.amount_minor),
    note: r.note,
    // The business date is the sort key everywhere (listEntries ORDER BY
    // created_at), so the wire's occurred_at takes that slot.
    created_at: r.occurred_at,
    updated_at: r.status_at ?? r.created_at,
    deleted_at: null,
    proposed_by_user_id: null,
    accepted_at: r.status === "accepted" ? r.status_at : null,
    disputed_at: r.status === "disputed" ? r.status_at : null,
    disputed_reason: r.status === "disputed" ? r.dispute_reason : null,
    settled_at: null,
    tab: {
      author_name: r.author_name ?? "",
      author_account_id: r.author_account_id ?? null,
      by: r.created_by === link.role ? "me" : "them",
      status: r.status,
      dispute_reason: r.dispute_reason,
      kind: r.kind,
      voided: r.voided_by_entry_id != null,
      local_pending: r.local_pending === 1,
      other_label: link.other_label,
    },
  };
}

/**
 * The tab's rows in the shape every screen, bill and export already reads,
 * newest first. Voided ORIGINALS are included with `tab.voided = true` — the
 * struck row is the audit trail (D5). The `kind='void'` rows themselves are
 * not listed: they carry the opposite direction and would read as a second,
 * inverted tally next to the one they cancel.
 */
export async function listTabEntriesAsEntries(link: TabLink): Promise<Entry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<TabEntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM tab_entries
      WHERE tab_id = ? AND kind <> 'void'
      ORDER BY occurred_at DESC, created_at DESC, id DESC`,
    link.tab_id,
  );
  return rows.map((r) => rowToEntry(link, r));
}

/** Rows by the other party still awaiting my accept/dispute (the badge count). */
export async function countPendingForMe(link: TabLink): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tab_entries
      WHERE tab_id = ? AND created_by <> ? AND status = 'pending'
        AND kind <> 'void' AND voided_by_entry_id IS NULL`,
    link.tab_id,
    link.role,
  );
  return row?.n ?? 0;
}

/**
 * This device's own tally before the server has seen it: counts in the
 * balance at once (D6 — a tally counts the moment it lands), renders with
 * "Sending…", and is replaced by the server row of the same id on ack.
 * seq -1 / rev 0 mark it as unordered until then.
 */
export async function insertOptimisticEntry(
  link: TabLink,
  e: { id: string; type: EntryType; amount: number; note: string | null; occurred_at: number },
  notify = true,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO tab_entries (${ENTRY_COLUMNS})
     VALUES (?, ?, -1, 0, ?, ?, ?, 'entry', ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 1, ?, ?)`,
    e.id,
    link.tab_id,
    link.role,
    directionFor(link.role, e.type),
    toMinorUnits(e.amount),
    e.note,
    e.occurred_at,
    now,
    getAccountIdSync(),
    (
      await db.getFirstAsync<{ display_name: string }>(
        "SELECT display_name FROM users WHERE is_local_self=1 LIMIT 1",
      )
    )?.display_name ?? "",
  );
  if (notify)
    notifyTabChanged(link.vault_id, {
      tabId: link.tab_id,
      relationshipId: link.relationship_id,
      vaultId: link.vault_id,
      newFromThem: 0,
      statusChangedOnMine: 0,
      origin: "local",
    });
}

/** First review only. The server still arbitrates concurrent offline phones. */
export async function applyOptimisticStatus(
  link: TabLink,
  entryId: string,
  status: TabEntryStatus,
  reason: string | null,
  notify = true,
): Promise<void> {
  const db = await getDb();
  const result = await db.runAsync(
    `UPDATE tab_entries SET status = ?, status_at = ?, dispute_reason = ?
      WHERE id = ? AND tab_id = ? AND status = 'pending'
        AND kind <> 'void' AND voided_by_entry_id IS NULL AND created_by <> ?`,
    status,
    Date.now(),
    reason,
    entryId,
    link.tab_id,
    link.role,
  );
  if (result.changes === 0) throw new TabReviewFinalError();
  if (notify)
    notifyTabChanged(link.vault_id, {
      tabId: link.tab_id,
      relationshipId: link.relationship_id,
      vaultId: link.vault_id,
      newFromThem: 0,
      statusChangedOnMine: 0,
      origin: "local",
    });
}

/**
 * Strike my own row before the server minted the void row: `marker` (the
 * outbox op id) stands in for voided_by_entry_id so the balance and the
 * struck rendering flip at once. The pull replaces it with the real id.
 */
export async function applyOptimisticVoid(
  link: TabLink,
  entryId: string,
  marker: string,
  notify = true,
): Promise<void> {
  const db = await getDb();
  const result = await db.runAsync(
    `UPDATE tab_entries SET voided_by_entry_id = ?
      WHERE id = ? AND tab_id = ? AND status = 'pending'
        AND kind <> 'void' AND voided_by_entry_id IS NULL AND created_by = ?`,
    marker,
    entryId,
    link.tab_id,
    link.role,
  );
  if (result.changes === 0) throw new TabReviewFinalError();
  if (notify)
    notifyTabChanged(link.vault_id, {
      tabId: link.tab_id,
      relationshipId: link.relationship_id,
      vaultId: link.vault_id,
      newFromThem: 0,
      statusChangedOnMine: 0,
      origin: "local",
    });
}

/** Drop an optimistic row the server refused for good (tab_closed, id_taken…). */
export async function deleteOptimisticEntry(tabId: string, entryId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `DELETE FROM tab_entries WHERE id = ? AND tab_id = ? AND local_pending = 1`,
    entryId,
    tabId,
  );
}

/**
 * The contact's LOCAL rows from before the link, newest first — shown under
 * the collapsed "Before linking" fold and excluded from the balance, whose
 * sum the opening entry already carries (D8). created_at is the business
 * date: while the tab is OPEN no local row can be created (createEntry routes
 * to the tab), so on an updated device this is every local row of the shared
 * period; an old-version member device could still author one, and it would
 * be hidden here AND excluded from the balance — the same "all editing
 * devices update first" rule the cents rollout set. Rows written after a
 * CLOSE are newer than linked_at, so they are not in this fold: they are
 * ordinary local tallies again and appear in the main list.
 */
export async function listPreLinkEntries(link: TabLink): Promise<Entry[]> {
  const db = await getDb();
  return db.getAllAsync<Entry>(
    `SELECT e.id, e.relationship_id, e.type, e.amount_afn, e.note,
            e.created_at, e.updated_at, e.deleted_at, e.proposed_by_user_id,
            e.accepted_at, e.disputed_at, e.disputed_reason, e.settled_at
       FROM entries e
      WHERE e.relationship_id = ?
        AND e.vault_id = ?
        AND e.deleted_at IS NULL
        AND e.created_at <= ?
      ORDER BY e.created_at DESC`,
    link.relationship_id,
    link.vault_id,
    link.linked_at,
  );
}

/**
 * users.id behind a relationship — the person a tab link points at.
 *
 * Two callers need it and neither has a person in hand: the join screen after
 * joinTabAsContact created the contact itself, and lib/tabs/notify.ts building
 * the `kaata://person/<id>` tap target for a background notification. Kept
 * here rather than in lib/db.ts because this is a tab-layer read and lib/db.ts
 * imports THIS module (the reverse edge would be a cycle — see the header).
 */
export async function getPersonIdForRelationship(relationshipId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT user_b_id AS id FROM relationships WHERE id = ?`,
    relationshipId,
  );
  return row?.id ?? null;
}

/** One pickable contact on the join screen. */
export type TabJoinCandidate = {
  id: string;
  name: string;
  phone: string | null;
  /** 1 = already has an OPEN tab, so it cannot take a second one (D3). */
  linked: number;
};

/**
 * Every live contact of ONE kaata, for the join screen's "who is this?" list.
 *
 * lib/db.ts's listAllPeopleForSearch reads the ACTIVE vault, and the join
 * screen must list the contacts of the kaata the user just picked — which is
 * not the active one until the join commits (joinTabAsContact switches it).
 * Names and the open-link flag are all the picker shows, so this stays a
 * two-join read rather than paying for balances it would not render.
 */
export async function listVaultContactsForJoin(vaultId: string): Promise<TabJoinCandidate[]> {
  const db = await getDb();
  return db.getAllAsync<TabJoinCandidate>(
    `SELECT u.id                                              AS id,
            u.display_name                                    AS name,
            u.phone_e164                                      AS phone,
            CASE WHEN tl.tab_id IS NOT NULL THEN 1 ELSE 0 END AS linked
       FROM relationships r
       INNER JOIN users u ON u.id = r.user_b_id
       -- Any tab, open or closed: joining onto a contact that already holds a
       -- frozen tab would wipe its balance (party b mints no opening entry,
       -- and only the latest tab counts), so such a contact is not offerable.
       LEFT JOIN tab_links tl
         ON tl.relationship_id = r.id
      WHERE r.vault_id = ?
        AND r.archived_at IS NULL
      GROUP BY u.id
      ORDER BY u.display_name COLLATE NOCASE`,
    vaultId,
  );
}

// ---------------------------------------------------------------------------
// tab_outbox

/** Commit the visible change and its durable operation as one unit. */
export async function queueTabMutation(link: TabLink, op: TabOutboxRow): Promise<void> {
  const db = await getDb();
  const p = JSON.parse(op.payload);
  await transaction(async () => {
    switch (op.op) {
      case "append":
        await insertOptimisticEntry(
          link,
          {
            id: op.id,
            type: entryTypeFor(link.role, p.direction),
            amount: fromMinorUnits(wireToMinor(p.amount)),
            note: p.note,
            occurred_at: p.occurred_at_ms,
          },
          false,
        );
        break;
      case "accept":
      case "dispute":
        await applyOptimisticStatus(
          link,
          p.entry_id,
          op.op === "accept" ? "accepted" : "disputed",
          p.reason ?? null,
          false,
        );
        break;
      case "void":
        await applyOptimisticVoid(link, p.entry_id, op.id, false);
        break;
      case "label":
        await db.runAsync(
          `UPDATE tab_links SET my_label = ? WHERE tab_id = ?`,
          p.label,
          link.tab_id,
        );
        break;
      case "close":
        await db.runAsync(
          `UPDATE tab_links SET closed_at = ? WHERE tab_id = ?`,
          op.created_at,
          link.tab_id,
        );
        break;
    }
    await enqueueTabOp(op);
  });
  notifyTabChanged(link.vault_id, {
    tabId: link.tab_id,
    relationshipId: link.relationship_id,
    vaultId: link.vault_id,
    newFromThem: 0,
    statusChangedOnMine: 0,
    origin: "local",
  });
}

/** Persist invalidation BEFORE dropping a refused optimistic operation. */
export async function rejectTabOp(op: TabOutboxRow, reason = "refused"): Promise<void> {
  const db = await getDb();
  await transaction(async () => {
    await db.runAsync(
      `INSERT OR IGNORE INTO tab_failed_ops (id, tab_id, op, payload, created_at, reason)
      VALUES (?, ?, ?, ?, ?, ?)`,
      op.id,
      op.tab_id,
      op.op,
      op.payload,
      op.created_at,
      clampError(reason),
    );
    await db.runAsync(`UPDATE tab_links SET rev = 0 WHERE tab_id = ?`, op.tab_id);
    if (op.op === "append") await deleteOptimisticEntry(op.tab_id, op.id);
    await completeTabOp(op.id);
  });
}

/** Refused tallies stay readable, but never contribute to balances/exports. */
export async function listFailedTabEntries(relationshipId: string): Promise<Entry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    payload: string;
    role: TabLink["role"];
    created_at: number;
  }>(
    `SELECT f.id, f.payload, f.created_at, l.role FROM tab_failed_ops f
     JOIN tab_links l ON l.tab_id=f.tab_id
     WHERE l.relationship_id=? AND f.op='append' ORDER BY f.created_at DESC`,
    relationshipId,
  );
  return rows.map((r) => {
    const p = JSON.parse(r.payload);
    return {
      id: r.id,
      relationship_id: relationshipId,
      type: entryTypeFor(r.role, p.direction),
      amount_afn: fromMinorUnits(wireToMinor(p.amount)),
      note: p.note ?? null,
      created_at: p.occurred_at_ms ?? r.created_at,
      updated_at: r.created_at,
      deleted_at: null,
      proposed_by_user_id: null,
      accepted_at: null,
      disputed_at: null,
      disputed_reason: null,
      settled_at: null,
    };
  });
}

/** Queue one op. For 'append' the op id IS the entry id (server idempotency). */
export async function enqueueTabOp(op: TabOutboxRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO tab_outbox (id, tab_id, op, payload, created_at, attempts, next_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    op.id,
    op.tab_id,
    op.op,
    op.payload,
    op.created_at,
    op.attempts,
    op.next_at,
    op.last_error,
  );
}

/**
 * Ops whose backoff has elapsed, oldest first (rowid breaks same-ms ties so
 * an append always precedes the accept that follows it). One tab's, or all.
 */
export async function listDueTabOps(tabId?: string): Promise<TabOutboxRow[]> {
  const db = await getDb();
  const now = Date.now();
  return db.getAllAsync<TabOutboxRow>(
    `SELECT o.* FROM tab_outbox o
      WHERE (? IS NULL OR o.tab_id = ?) AND (o.next_at IS NULL OR o.next_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM tab_outbox older
           WHERE older.tab_id = o.tab_id AND older.rowid < o.rowid AND older.next_at > ?
        )
      ORDER BY o.rowid ASC`,
    tabId ?? null,
    tabId ?? null,
    now,
    now,
  );
}

/** Tabs with anything queued — including CLOSED links whose close op is still
 *  unsent, which the open-links sweep would otherwise never flush. */
export async function listTabIdsWithQueuedOps(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ tab_id: string }>(`SELECT DISTINCT tab_id FROM tab_outbox`);
  return rows.map((r) => r.tab_id);
}

/** Acked (or dropped as a permanent verdict): gone. */
export async function completeTabOp(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM tab_outbox WHERE id = ?`, id);
}

/** Retry later: attempts+1, due at now+backoff, reason kept for diagnostics. */
export async function failTabOp(id: string, err: string, backoffMs: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE tab_outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?`,
    Date.now() + backoffMs,
    clampError(err),
    id,
  );
}

/** Persist a notification action ONCE, even across the Android headless and
 * foreground VMs. The receipt and the outbox row commit together. Do not
 * mutate the cache optimistically: this is an old notification, not an open
 * ledger. The server enforces final decisions and checks expected_rev. */
export async function queueNotificationReview(
  link: TabLink,
  entryId: string,
  rev: number,
  action: "accept" | "dispute",
): Promise<void> {
  const db = await getDb();
  const key = `tab_notification_review:${link.tab_id}:${entryId}:${rev}`;
  await transaction(async () => {
    const claimed = await db.runAsync(
      "INSERT OR IGNORE INTO app_meta (key,value) VALUES (?,?)",
      key,
      String(Date.now()),
    );
    if (!claimed.changes) return;
    await enqueueTabOp({
      id: key,
      tab_id: link.tab_id,
      op: action,
      payload: JSON.stringify({ entry_id: entryId, expected_rev: rev, reason: "" }),
      created_at: Date.now(),
      attempts: 0,
      next_at: 0,
      last_error: null,
    });
    // Keep the receipt for 30 days (pushes expire after 24 hours).
    await db.runAsync(
      "DELETE FROM app_meta WHERE key LIKE 'tab_notification_review:%' AND CAST(value AS INTEGER) < ?",
      Date.now() - 30 * 86400_000,
    );
  });
}
