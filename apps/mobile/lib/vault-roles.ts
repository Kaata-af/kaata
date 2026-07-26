// Permission table for vault roles. The vocabulary mirrors the D4 §1 design
// of the sync plan, and the table here is consulted by both UI gates and
// (eventually, Phase 4) the local pre-flight check before append. The
// server-side authoritative copy will live at
// apps/backend/internal/sync/permissions.go.
//
// Phase 2 reality: every vault has exactly one member (the signed-in owner),
// and never-signed-in users get the empty-mirror fallback that returns
// 'owner'. So in practice every flag below answers true today. The table is
// already three-column because Phase 4 will not touch this file's shape —
// only the boolean cells.

// Re-export the canonical role enum from events.ts so call sites can
// `import { VaultRole } from "./vault-roles"` without needing to know that
// the source is the event union.
export type { VaultRole } from "./events";
import type { VaultRole } from "./events";

// Verb-y, scoped action keys. Note these are NOT event_type strings (which
// use underscores). Action keys describe the *intent* the UI surfaces;
// event_types are what hit the log. Keep the list in sync with the Go-side
// mirror when Phase 4 lands.
export type VaultAction =
  // Ledger writes
  | "entry.create"
  | "entry.amend"
  | "entry.delete"
  // People writes
  | "person.add"
  | "person.rename"
  | "person.change_phone"
  | "person.archive"
  // Vault settings
  | "vault.rename"
  | "vault.archive"
  | "vault.view_audit_log"
  // Membership (Phase 4 surface; Phase 2 only `owner` exists so all true)
  | "vault.invite_member"
  | "vault.change_member_role";

// Roles v2 column order: owner | manager | editor | clerk | viewer.
// clerk is APPEND-ONLY: create entries/people, never amend/delete/rename —
// the "helper with a pen, not an eraser". manager = editor + member
// management (capped below manager in the enforcement layers) + shop
// settings; NOT archive/transfer (owner identity operations).
// person.archive: editor+ — matches what the enforcement gates (mobile
// role-gate + backend permissions.go) always enforced; the old owner-only
// cell here was dead code no UI consulted.
export const PERMISSIONS: Readonly<Record<VaultAction, Readonly<Record<VaultRole, boolean>>>> =
  Object.freeze({
    "entry.create": { owner: true, manager: true, editor: true, clerk: true, viewer: false },
    "entry.amend": { owner: true, manager: true, editor: true, clerk: false, viewer: false },
    "entry.delete": { owner: true, manager: true, editor: true, clerk: false, viewer: false },

    "person.add": { owner: true, manager: true, editor: true, clerk: true, viewer: false },
    "person.rename": { owner: true, manager: true, editor: true, clerk: false, viewer: false },
    "person.change_phone": {
      owner: true,
      manager: true,
      editor: true,
      clerk: false,
      viewer: false,
    },
    "person.archive": { owner: true, manager: true, editor: true, clerk: false, viewer: false },

    "vault.rename": { owner: true, manager: true, editor: false, clerk: false, viewer: false },
    "vault.archive": { owner: true, manager: false, editor: false, clerk: false, viewer: false },
    // Audit-log visibility. Mirrors editor-write authority — anyone who can
    // change the ledger should be able to inspect the change history.
    // Clerks/viewers cannot see the audit log. Decoupled from entry.amend so
    // a future role rebalance doesn't silently strip audit-log access.
    "vault.view_audit_log": {
      owner: true,
      manager: true,
      editor: true,
      clerk: false,
      viewer: false,
    },

    "vault.invite_member": {
      owner: true,
      manager: true,
      editor: false,
      clerk: false,
      viewer: false,
    },
    "vault.change_member_role": {
      owner: true,
      manager: true,
      editor: false,
      clerk: false,
      viewer: false,
    },
  });

// Rank order shared by every mobile enforcement/UI layer (mirrors the
// backend's roleRank in sync/permissions.go). Unknown → 0, fail closed.
export const VAULT_ROLE_RANK: Readonly<Record<VaultRole, number>> = Object.freeze({
  viewer: 1,
  clerk: 2,
  editor: 3,
  manager: 4,
  owner: 5,
});

/** Strict parse: the five known literals, anything else null (fail closed). */
export function parseVaultRole(v: unknown): VaultRole | null {
  return v === "owner" || v === "manager" || v === "editor" || v === "clerk" || v === "viewer"
    ? v
    : null;
}

// Single-source check. Used by UI gates AND (eventually, Phase 4) the
// pre-append guard in event-log.ts.
//
// `null` role means "no membership row" — the local-only default. We resolve
// it to 'owner' here so call sites do not have to special-case the absence
// of a sign-in. This matches the founder decision: local-only mode must
// remain fully functional.
export function canPerformAction(role: VaultRole | null, action: VaultAction): boolean {
  const resolved: VaultRole = role ?? "owner";
  return PERMISSIONS[action][resolved];
}
