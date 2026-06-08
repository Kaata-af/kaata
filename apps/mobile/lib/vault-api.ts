// apps/mobile/lib/vault-api.ts
//
// Backend calls for vault lifecycle (Phase 4). Centralized so app screens
// don't sprinkle fetch() across the codebase. Every function reads the JWT
// via getSessionJWT() and the base URL via getBackendUrl(). Failures return
// typed result unions where the caller might need to differentiate; the
// throw-everywhere helpers (patchVault, archiveVault, etc.) throw on
// non-2xx and the screen catches+surfaces a toast.

import { getBackendUrl } from "./api";
import { getSessionJWT } from "./auth";
import { getDb, getInstallIdSync } from "./db-tx";
import type { VaultRole } from "./events";

const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

async function requireJwt(): Promise<string> {
  const jwt = await getSessionJWT();
  if (!jwt) throw new Error("not signed in");
  return jwt;
}

async function http(method: string, path: string, body?: unknown): Promise<Response> {
  const jwt = await requireJwt();
  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function httpThrowing(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await http(method, path, body);
  if (!res.ok) {
    let msg = `${method} ${path}: ${res.status}`;
    try {
      const text = await res.text();
      if (text) msg = `${msg} — ${text.slice(0, 200)}`;
    } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) {
    return await res.json();
  }
  return null;
}

// ---------------------------------------------------------------------------
// PATCH / archive / leave / transfer
// ---------------------------------------------------------------------------

export async function patchVault(
  vaultId: string,
  body: { name?: string; currency?: string },
): Promise<void> {
  await httpThrowing("PATCH", `/v1/vaults/${encodeURIComponent(vaultId)}`, body);
}

export async function archiveVault(vaultId: string): Promise<void> {
  await httpThrowing("POST", `/v1/vaults/${encodeURIComponent(vaultId)}/archive`);
}

export async function leaveVault(vaultId: string): Promise<void> {
  await httpThrowing("POST", `/v1/vaults/${encodeURIComponent(vaultId)}/leave`);
}

export async function transferOwnership(
  vaultId: string,
  toAccountId: string,
  demoteSelfTo: "editor" | "leave",
): Promise<void> {
  await httpThrowing("POST", `/v1/vaults/${encodeURIComponent(vaultId)}/transfer-ownership`, {
    to_account_id: toAccountId,
    demote_self_to: demoteSelfTo,
  });
}

export async function setMemberRole(
  vaultId: string,
  accountId: string,
  role: VaultRole,
): Promise<void> {
  await httpThrowing(
    "POST",
    `/v1/vaults/${encodeURIComponent(vaultId)}/members/${encodeURIComponent(accountId)}/role`,
    { role },
  );
}

export async function revokeMember(vaultId: string, accountId: string): Promise<void> {
  await httpThrowing(
    "POST",
    `/v1/vaults/${encodeURIComponent(vaultId)}/members/${encodeURIComponent(accountId)}/revoke`,
  );
}

// ---------------------------------------------------------------------------
// Invites — create / accept / pending
// ---------------------------------------------------------------------------

export type CreateInviteResult = {
  invite_url: string;
  invite_email: string;
  expires_at: number; // unix ms
};

export async function createVaultInvite(
  vaultId: string,
  body: { email: string; role: VaultRole },
): Promise<CreateInviteResult> {
  const raw = (await httpThrowing(
    "POST",
    `/v1/vaults/${encodeURIComponent(vaultId)}/invites`,
    body,
  )) as { invite_url: string; invite_email: string; expires_at: string };
  return {
    invite_url: raw.invite_url,
    invite_email: raw.invite_email,
    // Server returns ISO8601; collapse to unix ms for local storage.
    expires_at: Date.parse(raw.expires_at),
  };
}

export type PendingInvite = {
  // MIG #6: After the Phase 4.1 token-hashing migration the server no
  // longer holds (or returns) the plaintext token — only its SHA-256.
  // The plaintext lives ONLY on the inviter's response and on the
  // invitee's device after they receive the share URL. The local
  // pending_invitations table stores the plaintext (keyed by it). When
  // we mirror /v1/vaults/invites/pending into the local cache below,
  // any DB row already keyed by the plaintext is kept; rows for invites
  // we've never seen the plaintext of cannot exist locally — that's
  // correct because acceptance requires the plaintext anyway.
  vault_id: string;
  vault_name: string;
  inviter_email: string | null;
  inviter_name: string | null;
  role: VaultRole;
  invited_at: number;
  expires_at: number;
};

// PendingInviteWire matches the server's pendingInviteRow shape: NO
// invite_token field — it was deliberately dropped post-hash-migration
// (handler.go's pendingInviteRow comment). Marking it required here
// would silently coerce JS undefined into the cache, breaking acceptance.
type PendingInviteWire = {
  vault_id: string;
  vault_name: string;
  inviter_email: string;
  inviter_name: string;
  role: VaultRole;
  invited_at: string;
  expires_at: string;
};

export async function fetchPendingInvitations(): Promise<PendingInvite[]> {
  const raw = (await httpThrowing("GET", `/v1/vaults/invites/pending`)) as {
    pending?: PendingInviteWire[];
  };
  const list = raw.pending ?? [];
  const now = Date.now();
  const out: PendingInvite[] = list.map((p) => ({
    vault_id: p.vault_id,
    vault_name: p.vault_name,
    inviter_email: p.inviter_email || null,
    inviter_name: p.inviter_name || null,
    role: p.role,
    invited_at: Date.parse(p.invited_at),
    expires_at: Date.parse(p.expires_at),
  }));

  // Mirror into the local pending_invitations cache so the
  // ProfileSettingsSheet / invite-list badge can render offline. We refresh by
  // (vault_id) match against rows whose plaintext token we already
  // hold from the inviter's share link — server-side has only the
  // hash post-migration so we cannot key on token here.
  try {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const p of out) {
        await db.runAsync(
          `UPDATE pending_invitations
              SET vault_name       = ?,
                  invited_by_email = ?,
                  invited_by_name  = ?,
                  role             = ?,
                  invite_email     = ?,
                  invited_at       = ?,
                  expires_at       = ?,
                  fetched_at       = ?
            WHERE vault_id    = ?
              AND accepted_at IS NULL`,
          p.vault_name,
          p.inviter_email,
          p.inviter_name,
          p.role,
          p.inviter_email ?? "",
          p.invited_at,
          p.expires_at,
          now,
          p.vault_id,
        );
      }
    });
  } catch {
    // pending_invitations table may not exist yet on a partial migration —
    // the screen still gets correct server data, just no local cache.
  }
  return out;
}

export async function lookupPendingInvite(token: string): Promise<PendingInvite | null> {
  // Local lookup only — server-side cannot disclose the plaintext token
  // post-hash-migration. The token must already be in the local
  // pending_invitations table (received via the share URL handler).
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{
      vault_id: string;
      vault_name: string;
      invited_by_email: string | null;
      invited_by_name: string | null;
      role: VaultRole;
      invited_at: number;
      expires_at: number;
    }>(
      `SELECT vault_id, vault_name, invited_by_email, invited_by_name,
              role, invited_at, expires_at
         FROM pending_invitations
        WHERE token = ?
          AND accepted_at IS NULL
        LIMIT 1`,
      token,
    );
    if (!row) return null;
    return {
      vault_id: row.vault_id,
      vault_name: row.vault_name,
      inviter_email: row.invited_by_email,
      inviter_name: row.invited_by_name,
      role: row.role,
      invited_at: row.invited_at,
      expires_at: row.expires_at,
    };
  } catch {
    return null;
  }
}

export type AcceptInviteResult = {
  vault_id: string;
  vault_name: string;
  role: VaultRole;
};

export async function acceptVaultInvite(token: string): Promise<AcceptInviteResult> {
  const raw = (await httpThrowing("POST", `/v1/vaults/invites/accept`, {
    token,
    install_id: getInstallIdSync(),
  })) as AcceptInviteResult;
  // Stamp accepted_at in the local cache so the badge no longer fires.
  try {
    const db = await getDb();
    await db.runAsync(
      `UPDATE pending_invitations SET accepted_at = ? WHERE token = ?`,
      Date.now(),
      token,
    );
  } catch {}
  return raw;
}

export async function declineVaultInviteLocally(token: string): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync(
      `UPDATE pending_invitations SET declined_at = ? WHERE token = ?`,
      Date.now(),
      token,
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

// Audit log shape. The screens consume `id` as a string (since it's
// rendered into list keys + expand-toggle Sets) and `occurred_at` as a
// human timestamp. We stringify the server's numeric id and surface the
// ms value under both names for forward-compat.
export type AuditEntry = {
  id: string;
  vault_id: string;
  actor_id: string | null;
  kind: string;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  occurred_at: number;
  occurred_at_ms: number;
};

type AuditEntryWire = {
  id: number;
  vault_id: string;
  actor_id: string | null;
  kind: string;
  target_id: string | null;
  payload: unknown;
  occurred_at_ms: number;
};

export type AuditPage = {
  entries: AuditEntry[];
  // String cursor matches the screen's null / non-null discriminator.
  // null means "no more pages"; non-null is opaque from the screen's POV.
  next_cursor: string | null;
  has_more: boolean;
};

export async function fetchAuditLog(
  vaultId: string,
  opts: { cursor: string | null; limit: number },
): Promise<AuditPage> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("since_id", opts.cursor);
  params.set("limit", String(opts.limit));
  const raw = (await httpThrowing(
    "GET",
    `/v1/vaults/${encodeURIComponent(vaultId)}/audit-log?${params.toString()}`,
  )) as { entries?: AuditEntryWire[]; next_since_id?: number; has_more?: boolean };
  const entries = (raw.entries ?? []).map((e) => ({
    id: String(e.id),
    vault_id: e.vault_id,
    actor_id: e.actor_id,
    kind: e.kind,
    target_id: e.target_id,
    payload:
      e.payload && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : null,
    occurred_at: e.occurred_at_ms,
    occurred_at_ms: e.occurred_at_ms,
  }));
  const hasMore = Boolean(raw.has_more);
  return {
    entries,
    next_cursor: hasMore && raw.next_since_id ? String(raw.next_since_id) : null,
    has_more: hasMore,
  };
}

// ---------------------------------------------------------------------------
// Phase 5 mesh
// ---------------------------------------------------------------------------

// Registers this device's Ed25519 public key with the backend. Idempotent
// server-side (UPSERT by install_id). pubkey is the raw 32-byte key as
// standard base64 (44 chars including padding) — NOT a PEM envelope.
//
// Most call sites should prefer lib/mesh/device-key.ts:registerDeviceKey()
// which swallows errors for the fire-and-forget sign-in path.
export async function registerDeviceKey(pubkey_b64: string): Promise<void> {
  await httpThrowing("POST", `/v1/devices/register-key`, {
    ed25519_pubkey: pubkey_b64,
  });
}

// Requests a fresh VMC for the given vault.
//
// Two callers, two regimes:
//   - Existing member (renewal): pass `undefined` for `pairAuth`. The
//     backend authorises by JWT (account_id) — the steady-state path.
//   - New device joining via QR (`/vault/pair-scan`): pass `pairAuth`
//     carrying the single-use token + the QR's issued_at_ms. The backend
//     consumes the token (single-use), checks issued_at_ms against its
//     own clock to defeat scanner-clock rollback, and INSERTs a
//     vault_members row before minting the VMC. Without these two
//     fields the new-device call 403s.
export async function issueVaultCredential(
  vaultId: string,
  pairAuth?: { pair_token: string; pair_issued_at_ms: number },
): Promise<{
  vmc_blob: string;
  expires_at_ms: number;
}> {
  const body = pairAuth ?? {};
  const res = (await httpThrowing(
    "POST",
    `/v1/vaults/${encodeURIComponent(vaultId)}/credential`,
    body,
  )) as { vmc_blob: string; expires_at_ms: number };
  return { vmc_blob: res.vmc_blob, expires_at_ms: res.expires_at_ms };
}

// Registers a same-account pair token with the server. Called by the QR
// issuer (apps/mobile/app/vault/pair.tsx) immediately after the QR is
// generated locally so the scanner side can consume it via /credential.
//
// Only owners may mint pair tokens — 403 on non-owner call. expires_at_ms
// is clamped server-side to a max 10-minute lifetime regardless of input.
export async function registerVaultPairToken(
  vaultId: string,
  token: string,
  expires_at_ms: number,
): Promise<void> {
  await httpThrowing("POST", `/v1/vaults/${encodeURIComponent(vaultId)}/pair-tokens`, {
    token,
    expires_at_ms,
  });
}

// _devUnused keeps tree-shaking honest: getInstallIdSync is referenced
// elsewhere in this file but TS may flag the import as unused in some
// configurations. Touch it here as a no-op.
void getInstallIdSync;
void getDb;
