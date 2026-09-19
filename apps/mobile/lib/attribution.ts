// lib/attribution.ts
//
// "Who wrote this tally?" for shared kaatas.
//
// The problem this solves: in a multi-member kaata the ledger looked exactly
// the same whoever typed it. The only answer lived on the Activity screen,
// behind vault settings, and shopkeepers do not go there — they asked for the
// answer to be ON the tally.
//
// Two facts make that cheap:
//   1. Authorship already survives sync. Every event carries actor_account_id,
//      and the backend REFUSES a push whose actor_account_id differs from the
//      signed-in session (internal/sync/handler.go), so what we render is
//      verified, not a client-side claim.
//   2. Member display names already land in vault_members_mirror.display_name
//      (the backend's vault listing folds into it, as does a QR pair).
// Nothing joined the two, which is the whole of this file.
//
// What is deliberately NOT here: any notion of authority. The role gate binds
// identity through device_id -> vault_device_registry, never through the wire's
// actor_account_id (lib/db.ts migration notes). This module is for DISPLAY, and
// its only fallback path reads that same registry, so it never invents an
// identity the chain would disagree with.

import { memberTints, type MemberTint } from "./colors";
import { getDb } from "./db-tx";
import { isPlaceholderSelfName } from "./i18n";

/** One member's identity as a tally row needs it. */
export type EntryActor = {
  /** Account id, or a `local:` device sentinel on a pre-sign-in vault. */
  accountId: string;
  /** Resolved display name, or null when the mirror has no name for them. */
  name: string | null;
  /** True when this is one of THIS device's own account ids. */
  isSelf: boolean;
};

/** What a tally row knows about the hands that touched it. */
export type EntryAttribution = {
  /** Who appended entry_created. */
  author: EntryActor | null;
  /**
   * Who appended the LATEST entry_amended, when that is a different person
   * from the author. Null when the entry was never amended, or was only ever
   * amended by its own author (the ordinary "fixed my own typo" case, which
   * is not worth a word on the row).
   */
  editor: EntryActor | null;
};

// ---------------------------------------------------------------------------
// Tint assignment
// ---------------------------------------------------------------------------

// FNV-1a over the account id. Any stable string hash would do; the properties
// that matter are that it is deterministic across devices and platforms (so a
// member is the same color on everyone's phone) and that it does not cluster
// for ids sharing a prefix — `local:` sentinels share their first six chars,
// and a prefix-summing hash would hand half of them the same tint.
function hashAccountId(accountId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < accountId.length; i++) {
    h ^= accountId.charCodeAt(i);
    // FNV prime 16777619, via shifts to stay inside 32-bit int math.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

/** The stable color for a member, derived from their account id. */
export function memberTintFor(accountId: string): MemberTint {
  return memberTints[hashAccountId(accountId) % memberTints.length];
}

/**
 * The single grapheme for an initial chip. Falls back to "?" rather than an
 * empty circle, and skips leading punctuation/whitespace so a name like
 * " ahmad" still reads "A".
 *
 * Uses Array.from, not [0]: a name beginning with an astral character (an
 * emoji nickname is not hypothetical) would otherwise render half a surrogate
 * pair, which paints as a replacement box.
 */
export function initialOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0];
  return (first ?? "?").toUpperCase();
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

/**
 * accountId -> display name for every member the mirror knows about,
 * INCLUDING revoked ones: a staff member who left still wrote the tallies
 * they wrote, and rendering those as "?" would be a worse answer than their
 * name. Falls back to users.display_name for accounts that have a local
 * contact row but no mirrored name yet.
 *
 * The restore placeholder ("You" / "شما") is filtered out, because a mirror
 * row that picked it up would otherwise label a DIFFERENT member "You" on
 * this device.
 */
export async function loadMemberNames(vaultId: string): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ account_id: string; display_name: string | null }>(
    `SELECT vmm.account_id AS account_id,
            COALESCE(vmm.display_name, u.display_name) AS display_name
       FROM vault_members_mirror vmm
       LEFT JOIN users u ON u.account_id = vmm.account_id
      WHERE vmm.vault_id = ?`,
    vaultId,
  );
  const out = new Map<string, string>();
  for (const row of rows) {
    const name = (row.display_name ?? "").trim();
    if (!name || isPlaceholderSelfName(name)) continue;
    out.set(row.account_id, name);
  }
  return out;
}

/**
 * device_id -> account_id, for events whose actor_account_id is NULL.
 *
 * That happens for anything appended before the author signed in; the server
 * re-attributes those through account_bound, but the LOCAL projection of
 * account_bound is deliberately a no-op, so on this device the column stays
 * null forever. The device binding is the answer we do hold locally, and it is
 * the same table the role gate trusts for identity.
 */
async function loadDeviceOwners(vaultId: string): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ device_id: string; account_id: string }>(
    `SELECT device_id, account_id FROM vault_device_registry WHERE vault_id = ?`,
    vaultId,
  );
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.device_id && row.account_id) out.set(row.device_id, row.account_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-entry lookup
// ---------------------------------------------------------------------------

type AuthorEventRow = {
  target_id: string | null;
  event_type: string;
  actor_account_id: string | null;
  device_id: string | null;
};

/**
 * Attribution for every tally under ONE relationship — which is exactly the
 * set the person screen renders.
 *
 * Keyed on relationship_id rather than a target_id IN (...) list on purpose:
 * event_log has a partial index on (relationship_id, hlc_physical_ms), the
 * query takes a single bound parameter, and a long ledger therefore can't run
 * into SQLite's 999-variable ceiling or need chunking.
 *
 * `selfAccountIds` is the full candidate set from resolveAccountIdCandidates,
 * not one id: a vault created before sign-in keys its rows by a `local:`
 * device sentinel, and a rotated device key leaves rows under the retired
 * sentinel too. Matching only the current id would paint the user's OWN older
 * tallies as somebody else's.
 *
 * Best-effort: any failure yields an empty map, and the row simply renders the
 * way it did before this feature existed.
 */
export async function loadRelationshipAttribution(
  vaultId: string,
  relationshipId: string,
  selfAccountIds: readonly string[],
): Promise<Map<string, EntryAttribution>> {
  const out = new Map<string, EntryAttribution>();
  if (!vaultId || !relationshipId) return out;

  try {
    const db = await getDb();
    const [names, deviceOwners] = await Promise.all([
      loadMemberNames(vaultId),
      loadDeviceOwners(vaultId),
    ]);

    // Ascending HLC: the first entry_created wins (there is only ever one) and
    // the last entry_amended wins. Full tuple order so two devices that
    // amended at the same millisecond resolve identically on every phone —
    // the same total order the projection folds in.
    const rows = await db.getAllAsync<AuthorEventRow>(
      `SELECT target_id, event_type, actor_account_id, device_id
         FROM event_log
        WHERE relationship_id = ?
          AND event_type IN ('entry_created', 'entry_amended')
        ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC`,
      relationshipId,
    );

    const selves = new Set(selfAccountIds.filter(Boolean));
    const toActor = (row: AuthorEventRow): EntryActor | null => {
      const accountId =
        row.actor_account_id || (row.device_id ? (deviceOwners.get(row.device_id) ?? null) : null);
      if (!accountId) return null;
      return {
        accountId,
        name: names.get(accountId) ?? null,
        isSelf: selves.has(accountId),
      };
    };

    // authors / amenders are accumulated separately because the two rules
    // differ (first vs last) and the rows arrive interleaved across entries.
    const authors = new Map<string, EntryActor | null>();
    const amenders = new Map<string, EntryActor | null>();
    for (const row of rows) {
      const entryId = row.target_id;
      if (!entryId) continue;
      if (row.event_type === "entry_created") {
        if (!authors.has(entryId)) authors.set(entryId, toActor(row));
      } else {
        amenders.set(entryId, toActor(row));
      }
    }

    for (const [entryId, author] of authors) {
      const amender = amenders.get(entryId) ?? null;
      const editor = amender && amender.accountId !== author?.accountId ? amender : null;
      if (!author && !editor) continue;
      out.set(entryId, { author, editor });
    }
    // An amended entry whose CREATE never reached this device (a partial
    // backfill) still deserves its editor rather than nothing.
    for (const [entryId, amender] of amenders) {
      if (out.has(entryId) || !amender) continue;
      out.set(entryId, { author: null, editor: amender });
    }
  } catch (err) {
    console.warn("[attribution] load failed", err);
    return new Map();
  }
  return out;
}

/**
 * The one member whose mark belongs on a collapsed row: the most recent person
 * who touched it who is NOT you.
 *
 * Why "most recent, not the author": the row is a signal, not a byline. On a
 * shared ledger the question that actually worries a shopkeeper is "did
 * somebody else change this number", and an amendment by another member is
 * strictly more surprising than an original by that same member. The expanded
 * row spells out both, so nothing is hidden by the choice.
 *
 * Returns null for a tally only you have ever touched, which is what keeps a
 * solo-dominant ledger free of chips.
 */
export function chipActorFor(attribution: EntryAttribution | undefined): EntryActor | null {
  if (!attribution) return null;
  const { author, editor } = attribution;
  if (editor && !editor.isSelf) return editor;
  if (author && !author.isSelf) return author;
  return null;
}
