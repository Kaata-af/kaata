// Local audit-log derivation for local-CA vaults.
//
// For local-CA vaults (vaults.vault_trust_anchor_pubkey IS NOT NULL) we don't
// have a server-side audit_log table — the source of truth is the local
// event_log. This module synthesizes AuditEntry rows from event_log so the
// UI in app/vault/audit-log.tsx can render the same shape regardless of
// whether the vault is anchored to the server or to a local trust anchor.
//
// We deliberately mirror the wire-shape (id, kind, actor_id, target_id,
// payload, occurred_at_ms) and not the raw event envelope: the UI's
// humanizeKind / previewPayload helpers already understand the wire shape.
// Mapping event_type -> audit kind is many-to-one (e.g. both
// vault_member_added and account_bound can produce "invite_accepted"
// equivalents on the server). For now we surface event_type verbatim under
// `kind` and add cases to humanizeKind() in the screen.

import { getDb } from "../db-tx";
import type { AuditEntry } from "../vault-api";

// Event types that should appear in the audit log for a local-CA vault.
// Kept in rough sync with the server's vault_audit_log emission set.
const AUDITED_EVENT_TYPES = [
  "vault_member_added",
  "vault_member_role_changed",
  "vault_member_removed",
  "vault_setting_set",
  "shop_profile_updated",
  "entry_created",
  "entry_amended",
  "entry_deleted",
  "person_added",
  "person_renamed",
  "person_archived",
  "person_unarchived",
] as const;

export type LocalAuditPage = {
  entries: AuditEntry[];
  next_cursor: string | null;
  has_more: boolean;
};

// Returns true iff the vault has a local trust anchor (Phase 7 local-CA
// vault) — i.e. operations on it never need to round-trip to the server.
//
// Engineering critique: thin wrapper over the canonical helper in
// lib/vault-router so we don't keep two diverging implementations of the
// same predicate (the previous duplicate had subtly different SQL column
// aliasing). The canonical helper throws VaultNotFoundError when the
// vaults row is missing; the audit-log screen treats that as "no local
// derivation possible — fall through to the server path" so we swallow
// the error and return false to preserve the screen's pre-existing
// behaviour on freshly-arrived mesh events.
export async function isLocalCAVault(vaultId: string): Promise<boolean> {
  if (!vaultId) return false;
  try {
    const { isLocalCAVault: canonical } = await import("../vault-router");
    return await canonical(vaultId);
  } catch {
    return false;
  }
}

type EventRow = {
  event_id: string;
  event_type: string;
  target_id: string | null;
  actor_account_id: string | null;
  hlc_physical_ms: number;
  hlc_logical: number;
  hlc_device_id: string;
  appended_at: number;
  payload_json: string;
};

// Reads up to `limit` audit-relevant events for the given vault, newest
// first, paginated by an opaque cursor encoding (hlc_physical_ms,
// hlc_logical, hlc_device_id). The cursor is opaque to the caller and
// matches the (id) cursor protocol the server endpoint uses — the screen
// only checks for null / non-null.
export async function fetchLocalAuditLog(
  vaultId: string,
  opts: { cursor: string | null; limit: number },
): Promise<LocalAuditPage> {
  const db = await getDb();
  const placeholders = AUDITED_EVENT_TYPES.map(() => "?").join(",");

  // Cursor format: "<pms>:<logical>:<did>". Page starts strictly BEFORE the
  // (pms, logical, did) triple, descending — matches the ORDER BY below.
  let where = `vault_id = ? AND event_type IN (${placeholders})`;
  const params: (string | number)[] = [vaultId, ...AUDITED_EVENT_TYPES];

  if (opts.cursor) {
    const parsed = parseCursor(opts.cursor);
    if (parsed) {
      where +=
        " AND (hlc_physical_ms < ?" +
        "       OR (hlc_physical_ms = ? AND hlc_logical < ?)" +
        "       OR (hlc_physical_ms = ? AND hlc_logical = ? AND hlc_device_id < ?))";
      params.push(parsed.pms, parsed.pms, parsed.logical, parsed.pms, parsed.logical, parsed.did);
    }
  }

  // Over-fetch by one row to detect has_more without a second COUNT query.
  const limit = Math.max(1, Math.min(opts.limit, 200));
  params.push(limit + 1);

  const sql = `SELECT event_id, event_type, target_id, actor_account_id,
            hlc_physical_ms, hlc_logical, hlc_device_id,
            appended_at, payload_json
       FROM event_log
      WHERE ${where}
   ORDER BY hlc_physical_ms DESC, hlc_logical DESC, hlc_device_id DESC
      LIMIT ?`;

  const rows = await db.getAllAsync<EventRow>(sql, ...params);

  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;

  const entries: AuditEntry[] = visible.map((r) => {
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(r.payload_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
    // appended_at is local wall-clock and best matches the server's
    // occurred_at_ms semantics; HLC physical can be skewed by tickRemote.
    const occurredAt = r.appended_at > 0 ? r.appended_at : r.hlc_physical_ms;
    return {
      id: r.event_id,
      vault_id: vaultId,
      actor_id: r.actor_account_id,
      kind: r.event_type,
      target_id: r.target_id,
      payload,
      occurred_at: occurredAt,
      occurred_at_ms: occurredAt,
    };
  });

  let nextCursor: string | null = null;
  if (hasMore && visible.length > 0) {
    const last = visible[visible.length - 1];
    nextCursor = `${last.hlc_physical_ms}:${last.hlc_logical}:${last.hlc_device_id}`;
  }

  return { entries, next_cursor: nextCursor, has_more: hasMore };
}

function parseCursor(c: string): { pms: number; logical: number; did: string } | null {
  const parts = c.split(":");
  if (parts.length < 3) return null;
  const pms = Number(parts[0]);
  const logical = Number(parts[1]);
  const did = parts.slice(2).join(":");
  if (!Number.isFinite(pms) || !Number.isFinite(logical) || !did) return null;
  return { pms, logical, did };
}
