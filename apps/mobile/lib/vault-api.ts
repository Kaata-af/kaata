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
import { getAppMeta, setAppMeta } from "./db";
import { getDb, getInstallIdSync } from "./db-tx";
import type { VaultRole } from "./events";

const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

// Thrown by httpThrowing on a non-2xx response. Carries the HTTP status + the
// backend's stable error_code so callers branch on `err.code` / `err.status`
// instead of fragile prose-substring matching of the message. Extends Error so
// existing `instanceof Error` / `.message` handling keeps working.
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

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
    let code = "";
    let serverMsg = "";
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; error_code?: string };
          code = parsed.error_code ?? "";
          serverMsg = parsed.error ?? "";
        } catch {
          serverMsg = text.slice(0, 200); // non-JSON body (e.g. proxy/rate-limit)
        }
      }
    } catch {}
    const msg = `${method} ${path}: ${res.status}${serverMsg ? ` — ${serverMsg}` : ""}`;
    throw new ApiError(res.status, code, msg);
  }
  const ct = res.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) {
    return await res.json();
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /v1/vaults — list the account's memberships (M5 multi-vault recovery)
// ---------------------------------------------------------------------------

/** One active member on a VaultListing (name channel — see `members`). */
export type VaultListingMember = {
  account_id: string;
  role: string;
  /** accounts.name (login-refreshed) with install self_name fallback; may be "". */
  name?: string;
};

/** One vault the signed-in account is a member of (GET /v1/vaults). */
export type VaultListing = {
  vault_id: string;
  name: string;
  currency?: string;
  role: string;
  members_count: number;
  created_at_ms: number;
  archived_at_ms?: number;
  vault_epoch: number;
  /** base64 32-byte owner anchor pubkey; absent for server-anchored vaults. */
  vault_trust_anchor_pubkey?: string;
  /**
   * Active members with display names. The signed membership chain
   * deliberately carries no names (immutable events vs mutable profile
   * data), so this listing is how devices learn what to CALL each other —
   * folded into vault_members_mirror.display_name by lib/recovery.ts.
   * Absent on pre-names backends.
   */
  members?: VaultListingMember[];
};

/**
 * List every vault the signed-in account is a member of, with each vault's
 * role + trust anchor. The driver of multi-vault recovery (lib/recovery.ts)
 * loops this; archived vaults are included so the caller can decide.
 */
export async function listVaults(): Promise<VaultListing[]> {
  const body = await httpThrowing("GET", "/v1/vaults");
  const vaults = (body as { vaults?: unknown } | null)?.vaults;
  if (!Array.isArray(vaults)) return [];
  return vaults.filter(
    (v): v is VaultListing =>
      v != null && typeof v === "object" && typeof (v as VaultListing).vault_id === "string",
  );
}

// ---------------------------------------------------------------------------
// POST /v1/vaults — register a locally-created vault with the server so it
// gets a vault_members owner row. Without that row the vault is invisible to
// GET /v1/vaults (no restore on reinstall) and every sync push 403s — i.e. the
// vault silently never backs up. IDEMPOTENT: 409 (vault already registered) is
// treated as success, so the reconcile loop can safely call this every sweep
// until registered_with_server_at is stamped.
// ---------------------------------------------------------------------------

export async function createVaultOnServer(args: {
  vault_id: string;
  name: string;
  currency: string;
  created_at_ms: number;
  vault_trust_anchor_pubkey?: string | null;
}): Promise<void> {
  try {
    await httpThrowing("POST", "/v1/vaults", {
      vault_id: args.vault_id,
      name: args.name,
      currency: args.currency,
      created_at_ms: args.created_at_ms,
      ...(args.vault_trust_anchor_pubkey
        ? { vault_trust_anchor_pubkey: args.vault_trust_anchor_pubkey }
        : {}),
    });
  } catch (err) {
    // 409 = a vault row with this id already exists server-side (registered on
    // a prior attempt, or by the sign-in pending_vault_registration). That's
    // the success state for our purposes — stop retrying.
    if (err instanceof ApiError && err.status === 409) return;
    throw err;
  }
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
    // B8/M23: serialize this mirror write under applyEventMutex like every
    // other write-transaction on the shared connection — an un-mutexed BEGIN
    // here (opening the Members screen while the scheduler ingests a page) can
    // tear the in-flight transaction into autocommit. Body only touches
    // pending_invitations (no applyEvent), so it can't re-enter and deadlock.
    const { applyEventMutex } = require("./projection") as typeof import("./projection");
    await applyEventMutex.runExclusive(async () => {
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

// Public invite metadata from GET /v1/vaults/invites/{token}/info — the
// same endpoint the kaata.af landing page uses. This is how a LINK invitee
// gets confirm-card details: they never have a local pending_invitations row
// (the server holds only the token hash post-migration, and the /pending
// endpoint excludes link invites), so lookupPendingInvite always misses.
export type InviteInfo = {
  vault_name: string;
  role: VaultRole;
  /** Redacted server-side (e.g. "a***@gmail.com"); null when absent. */
  inviter_email_redacted: string | null;
  inviter_name: string | null;
  expires_at: number; // unix ms
};

/**
 * Fetch invite details by plaintext token. Returns null on 404 — the server
 * collapses not-found / expired / revoked / already-used into one code by
 * design. Network failures and non-404 errors throw so the caller can offer
 * a retry.
 */
export async function fetchInviteInfo(token: string): Promise<InviteInfo | null> {
  try {
    const raw = (await httpThrowing(
      "GET",
      `/v1/vaults/invites/${encodeURIComponent(token)}/info`,
    )) as {
      vault_name: string;
      role: VaultRole;
      inviter_email_redacted?: string;
      inviter_name?: string;
      expires_at: string;
    };
    return {
      vault_name: raw.vault_name,
      role: raw.role,
      inviter_email_redacted: raw.inviter_email_redacted || null,
      inviter_name: raw.inviter_name || null,
      // Server returns ISO8601; collapse to unix ms like the local cache.
      expires_at: Date.parse(raw.expires_at),
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
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
// Accept-then-materialize heal flag
// ---------------------------------------------------------------------------
//
// POST /v1/vaults/invites/accept consumes the invite server-side, but the
// local `vaults` row is only seeded afterwards by recoverJoinedVault. If that
// seed fails (network blip in the window right after the accept), nothing
// else ever creates the row — recoverAllVaults runs only from restore/sign-in
// and reconcileVaultRegistrations only POSTs vaults this device OWNS — so the
// joined kaata stays invisible until a sign-out/in. Mirrors the
// witness_emit_pending pattern (lib/trust/backfill.ts): the accept screen
// stamps the vault_id under this key BEFORE materializing and clears it only
// on success; retryPendingVaultMaterialize sweeps it (safe to re-run —
// seeding is INSERT OR IGNORE and pulls are cursor-idempotent).
// The value is a comma-separated SET of vault_ids, not a single slot: a user
// can accept a second invite before the first heals, and a single slot would
// silently drop the first (leaving that kaata invisible until sign-out/in).
export const VAULT_MATERIALIZE_PENDING_KEY = "vault_materialize_pending";

function parsePendingSet(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Add a vault to the pending-materialize set (dedup-preserving). Call BEFORE
// recoverJoinedVault so a crash/kill in the seed window leaves the flag set.
export async function markVaultMaterializePending(vaultId: string): Promise<void> {
  const set = new Set(parsePendingSet(await getAppMeta(VAULT_MATERIALIZE_PENDING_KEY)));
  set.add(vaultId);
  await setAppMeta(VAULT_MATERIALIZE_PENDING_KEY, [...set].join(","));
}

// Remove one vault from the set (call on confirmed materialize success).
export async function clearVaultMaterializePending(vaultId: string): Promise<void> {
  const set = new Set(parsePendingSet(await getAppMeta(VAULT_MATERIALIZE_PENDING_KEY)));
  if (!set.delete(vaultId)) return;
  await setAppMeta(VAULT_MATERIALIZE_PENDING_KEY, [...set].join(","));
}

export async function retryPendingVaultMaterialize(): Promise<void> {
  const pending = parsePendingSet(await getAppMeta(VAULT_MATERIALIZE_PENDING_KEY));
  if (pending.length === 0) return;
  // recoverJoinedVault lists GET /v1/vaults, which needs the account JWT; a
  // signed-out user keeps the set for after their next sign-in.
  if (!(await getSessionJWT())) return;
  // Dynamic import: lib/recovery statically imports this module.
  const { recoverJoinedVault } = await import("./recovery");
  const stillPending: string[] = [];
  for (const vaultId of pending) {
    let healed = false;
    try {
      healed = await recoverJoinedVault(vaultId);
    } catch (err) {
      // Transient (offline / 5xx) — keep it for the next sweep. A vault that
      // is genuinely gone (invitee removed, vault archived) returns false and
      // stays in the set; the retry is a cheap idempotent GET, never harmful.
      if (__DEV__) console.warn("[vault-api] materialize retry threw", err);
    }
    if (!healed) stillPending.push(vaultId);
  }
  await setAppMeta(VAULT_MATERIALIZE_PENDING_KEY, stillPending.join(","));
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

// M4: issueVaultCredential (POST /v1/vaults/:id/credential) and
// registerVaultPairToken (POST /v1/vaults/:id/pair-tokens) were the legacy
// server VMC-minting + pair-token subsystem. They are deleted with the VMC
// retirement — QR joins are now chain-native (the owner emits the joiner's
// admission over the mesh; no server credential round-trip).

// ---------------------------------------------------------------------------
// M2 membership chain — server witness (docs/m2-membership-chain.md §8.1)
// ---------------------------------------------------------------------------

// Attestation signatures for the calling account + install:
//   device_witness — "account A controls device D" — always present.
//   member_witness — "owner-account O invited account A at role R" — only
//     when a brokered invite exists (the server checked its invite tables;
//     this is what proves owner intent on the online admission path).
// sig_b64 values are Ed25519 over the canonical JSON of the §2 tuples,
// verifiable against the pinned server signing pubkey(s) named by
// server_key_id.
export type MembershipWitnessResponse = {
  server_key_id: string;
  device_witness: { sig_b64: string; issued_at_ms: number };
  member_witness: {
    sig_b64: string;
    issued_at_ms: number;
    inviter_account_id: string;
    role: VaultRole;
  } | null;
};

export async function fetchMembershipWitness(vaultId: string): Promise<MembershipWitnessResponse> {
  return (await httpThrowing(
    "POST",
    `/v1/vaults/${encodeURIComponent(vaultId)}/witness`,
  )) as MembershipWitnessResponse;
}

// _devUnused keeps tree-shaking honest: getInstallIdSync is referenced
// elsewhere in this file but TS may flag the import as unused in some
// configurations. Touch it here as a no-op.
void getInstallIdSync;
void getDb;
