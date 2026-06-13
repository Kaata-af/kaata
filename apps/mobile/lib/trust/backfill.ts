// M2 chain-genesis backfill + pending witness emission
// (docs/m2-membership-chain.md §5).
//
// Existing vaults have members with no chain (server-invite members,
// pre-M2 pairs). ensureChainBackfill gives them one — one-shot,
// OWNER-side: the anchor-holding device folds its current local knowledge
// (vault_members_mirror + vault_credentials) and emits owner-signed
// backfill admissions. Non-anchor devices receive the chain via normal
// sync; until it arrives, verification falls back to legacy sources — no
// flag-day.
//
// The same entry point also retries a pending witnessed self-admission
// (the online invite-accept path, §4 row 3): if the emission failed at
// accept time (offline blip, local vault row not yet reconciled), the
// app_meta flag `witness_emit_pending:<vaultId>` stays set and the next
// ensureChainBackfill call retries it. Duplicate admissions are no-ops in
// the chain fold and the appliers are HLC-aware, so a partial first
// attempt re-running is safe.
//
// Call sites:
//   - lib/sync/scheduler.ts startSyncScheduler (fire-and-forget at start)
//   - app/index.tsx load() (covers local-only installs that never start
//     the sync scheduler)
// Both call freely: the in-session Set below makes everything after the
// first call per (session, vault) a synchronous no-op, so focus-driven
// re-loads cost nothing. A failed attempt is NOT retried until the next
// app session — deliberate, per §5's "one-shot, next-launch retry" shape.

import { getAccountIdSync, getDb, getInstallIdSync } from "../db-tx";
import { getAppMeta, setAppMeta } from "../db";
import {
  appendVaultDeviceAdded,
  appendVaultMemberAdded,
  RoleGateRejectionError,
} from "../event-log";
import type { MembershipWitness, VaultRole } from "../events";
import { ensureDeviceKey, getDevicePubkey } from "../mesh/device-key";
import { buildLocalAccountId } from "./account-id";
import { fetchMembershipWitness } from "../vault-api";
import { getLocalMembershipState } from "./proof";

// Once per app session per vault — guards against useFocusEffect-driven
// re-entry from app/index.tsx's load().
const attemptedThisSession = new Set<string>();

export async function ensureChainBackfill(vaultId: string): Promise<void> {
  if (attemptedThisSession.has(vaultId)) return;
  attemptedThisSession.add(vaultId);

  // Part 1 — pending witnessed self-admission retry (any device, not just
  // the anchor). Independent of the owner-side backfill below: a failure
  // here must not block genesis emission and vice versa.
  try {
    if ((await getAppMeta(witnessEmitPendingKey(vaultId))) === "1") {
      await emitWitnessedSelfAdmission(vaultId);
      await setAppMeta(witnessEmitPendingKey(vaultId), "");
    }
  } catch (err) {
    console.warn("[trust/backfill] pending witness emission retry failed", err);
  }

  // Part 2 — owner-side one-shot genesis backfill.
  try {
    await runGenesisBackfill(vaultId);
  } catch (err) {
    console.warn("[trust/backfill] genesis backfill failed", err);
  }
}

// Run ensureChainBackfill for EVERY non-archived vault, plus any vault with
// a stranded witness_emit_pending flag (M2 review P2). Per-vault backfill is
// a "first M2 launch" obligation, not a "first time you open this vault"
// one: a multi-vault owner's non-active vaults must get their chain too, or
// their members stay handshake-refused; and a pending witness emission for a
// vault the user switched away from must still retry. Fire-and-forget,
// self-guarded per vault by attemptedThisSession.
export async function ensureChainBackfillAllVaults(): Promise<void> {
  const db = await getDb();
  const ids = new Set<string>();
  try {
    const vaults = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM vaults WHERE archived_at IS NULL`,
    );
    for (const v of vaults) ids.add(v.id);
  } catch (err) {
    console.warn("[trust/backfill] vault list for backfill failed", err);
  }
  try {
    const pending = await db.getAllAsync<{ key: string }>(
      `SELECT key FROM app_meta WHERE key LIKE 'witness_emit_pending:%' AND value = '1'`,
    );
    for (const p of pending) ids.add(p.key.slice("witness_emit_pending:".length));
  } catch (err) {
    console.warn("[trust/backfill] pending-witness scan failed", err);
  }
  for (const vaultId of ids) {
    await ensureChainBackfill(vaultId);
  }
}

export function witnessEmitPendingKey(vaultId: string): string {
  return `witness_emit_pending:${vaultId}`;
}

function chainBackfillDoneKey(vaultId: string): string {
  return `chain_backfill_done:${vaultId}`;
}

async function runGenesisBackfill(vaultId: string): Promise<void> {
  // The done-flag still guards against re-running a COMPLETE backfill (cost
  // control for focus-driven re-entry), but — unlike the v1 single-flag
  // heuristic — it is set ONLY after a full successful pass (step 5). The
  // body itself is an IDEMPOTENT DIFF over the folded chain, so a partial
  // pass that crashed leaves the flag unset and the next run re-folds and
  // re-emits ONLY the still-missing parts.
  if ((await getAppMeta(chainBackfillDoneKey(vaultId))) === "1") return;

  // Anchor-holding device only: the vault's trust anchor pubkey must BE
  // this device's pubkey. ensureDeviceKey is idempotent and warms the
  // in-memory cache getDevicePubkey reads.
  await ensureDeviceKey();
  const devicePubkey = getDevicePubkey();
  if (!devicePubkey) return;

  const db = await getDb();
  const vault = await db.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
    `SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ? LIMIT 1`,
    vaultId,
  );
  // If the anchor matches no living device (this device isn't the anchor
  // holder), return silently — orphaned-anchor recovery is out of scope
  // (documented in docs/m2-membership-chain.md §9 row 5).
  if (!vault?.vault_trust_anchor_pubkey || vault.vault_trust_anchor_pubkey !== devicePubkey) {
    return;
  }

  // Same owner-account resolution as vault creation (app/vault/new.tsx):
  // the signed-in account if present, else the deterministic local
  // sentinel derived from the anchor pubkey.
  const ownerAccountId = getAccountIdSync() ?? buildLocalAccountId(devicePubkey);

  // Fold the CURRENT local chain (reuses proof.ts loadLocalMembershipEvents
  // + chain.ts foldMembership wired with the vault anchor + pinned server
  // witness keys). This is the source of truth for what is ALREADY chained
  // — we diff against it instead of the v1 "any owner-signed member_added
  // exists ⇒ skip" probe, which false-positived on the pre-M2 owner
  // self-admission that vault/new.tsx has emitted since v0.5.0 and so
  // never chained pre-M2 invited members / paired devices.
  let state = await getLocalMembershipState(vaultId);

  // 1. Genesis self-admission — the chain root. Emit ONLY if the fold has
  //    no genesis yet. Signed by the anchor via the normal local append
  //    path; the fold implicitly binds the anchor device from it, so NO
  //    vault_device_added is emitted for self. Re-fold afterward so the
  //    member/device diffs below see the now-active owner.
  if (!state || !state.hasGenesis) {
    await appendVaultMemberAdded({
      targetVaultId: vaultId,
      accountId: ownerAccountId,
      role: "owner",
    });
    state = await getLocalMembershipState(vaultId);
  }

  const isActiveMember = (accountId: string): boolean => {
    const m = state?.members.get(accountId);
    return !!m && !m.removed;
  };
  const isActiveBoundDevice = (pubkey: string): boolean => {
    const d = state?.devices.get(pubkey);
    return !!d && !d.removed;
  };

  // 2. Owner-attested admissions for every active mirror member NOT already
  //    an active member in the folded state. backfill_synthetic
  //    distinguishes these from organic adds. Diff-driven: members already
  //    chained (e.g. by a prior partial pass) are skipped.
  const members = await db.getAllAsync<{
    account_id: string;
    role: string;
    display_name: string | null;
  }>(
    `SELECT account_id, role, display_name
       FROM vault_members_mirror
      WHERE vault_id = ? AND revoked_at IS NULL`,
    vaultId,
  );
  for (const m of members) {
    if (m.account_id === ownerAccountId) continue;
    if (isActiveMember(m.account_id)) continue;
    const role: VaultRole = m.role === "owner" || m.role === "viewer" ? m.role : "editor";
    await appendVaultMemberAdded({
      targetVaultId: vaultId,
      accountId: m.account_id,
      role,
      displayName: m.display_name,
      backfillSynthetic: true,
    });
  }
  // Re-fold so the device diff below sees the members just admitted (a
  // device bind is only emitted for an ACTIVE member account).
  state = await getLocalMembershipState(vaultId);

  // 3. Device bindings for every locally cached credential (migration 011
  //    vault_credentials) whose pubkey is NOT already an active bound
  //    device AND whose account IS an active member in the folded state.
  //    The anchor's own pubkey is skipped — genesis binds it. Joining
  //    against active mirror members (revoked_at IS NULL) also skips
  //    credentials of revoked members (review P3). Devices we hold no
  //    credential for get chained when they next handshake / accept online.
  const creds = await db.getAllAsync<{
    account_id: string;
    device_id: string;
    device_pubkey: string;
  }>(
    `SELECT c.account_id, c.device_id, c.device_pubkey
       FROM vault_credentials c
       JOIN vault_members_mirror m
         ON m.vault_id = c.vault_id AND m.account_id = c.account_id
      WHERE c.vault_id = ?
        AND m.revoked_at IS NULL
        AND c.device_pubkey IS NOT NULL
        AND c.device_pubkey != ''`,
    vaultId,
  );
  for (const c of creds) {
    if (c.device_pubkey === devicePubkey) continue;
    if (isActiveBoundDevice(c.device_pubkey)) continue;
    // Only an ACTIVE member account can hold a bound device (the fold
    // refuses vault_device_added for an unknown/removed member account).
    if (!isActiveMember(c.account_id)) continue;
    await appendVaultDeviceAdded({
      targetVaultId: vaultId,
      accountId: c.account_id,
      deviceId: c.device_id,
      devicePubkeyB64: c.device_pubkey,
      backfillSynthetic: true,
    });
  }

  // Set the done-flag ONLY now that every emit above succeeded. If any emit
  // threw, control never reached here, the flag stays unset, and the next
  // ensureChainBackfill (next session) re-folds and re-diffs — emitting
  // only the parts still missing.
  await setAppMeta(chainBackfillDoneKey(vaultId), "1");
}

// ---------------------------------------------------------------------------
// Witnessed self-admission (online invite-accept path, docs §4 row 3)
// ---------------------------------------------------------------------------
//
// Fetches the server witness for the calling account + install, then emits:
//   - witnessed vault_member_added (self) — only when the server holds a
//     brokered invite (member_witness non-null; proves owner intent),
//   - witnessed vault_device_added (self device) — always.
// Both are authored + signed by THIS device through the normal local
// append path; the witness rides in the payload for the chain fold to
// verify against the pinned server pubkeys.
//
// Throws on any failure (network, missing pubkey) — callers own the
// witness_emit_pending flag lifecycle: set it before calling, clear it
// after success, leave it set on throw so ensureChainBackfill retries next
// session.
//
// IDEMPOTENT (M2 review FIX C): the accept-time emission can crash between
// the member_added and the device_added (network/process death). The retry
// must NOT re-throw on the already-committed member_added — the role-gate's
// self-add carve-out DECLINES once a mirror row exists, surfacing a
// RoleGateRejectionError that previously aborted the whole retry and left
// device_added unemitted ⇒ witness_emit_pending stuck forever. So we DIFF
// first (emit member_added only if not already an active member, device_added
// only if our pubkey isn't already bound) AND swallow a RoleGateRejectionError
// on the already-present member_added so the flow always reaches device_added.
// The caller clears witness_emit_pending only after this returns without
// throwing — i.e. only once the device binding exists (emitted or confirmed
// present below).
export async function emitWitnessedSelfAdmission(vaultId: string): Promise<void> {
  await ensureDeviceKey();
  const devicePubkey = getDevicePubkey();
  if (!devicePubkey) {
    throw new Error("device pubkey unavailable — cannot emit witnessed self-admission");
  }

  const res = await fetchMembershipWitness(vaultId);

  // Invite acceptance requires sign-in, so account_id is normally set;
  // the local sentinel is a defensive fallback only.
  const accountId = getAccountIdSync() ?? buildLocalAccountId(devicePubkey);

  // Diff against what is ALREADY chained. Prefer the folded chain state
  // (what the handshake verifies); fall back to the materialized mirror /
  // device registry when the vault has no local trust anchor yet (the
  // folded state is null then).
  const state = await getLocalMembershipState(vaultId);
  let selfIsActiveMember: boolean;
  let selfDeviceBound: boolean;
  if (state) {
    const m = state.members.get(accountId);
    selfIsActiveMember = !!m && !m.removed;
    const d = state.devices.get(devicePubkey);
    selfDeviceBound = !!d && !d.removed;
  } else {
    const db = await getDb();
    const memberRow = await db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM vault_members_mirror
        WHERE vault_id = ? AND account_id = ? AND revoked_at IS NULL LIMIT 1`,
      vaultId,
      accountId,
    );
    selfIsActiveMember = !!memberRow;
    const deviceRow = await db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM vault_device_registry
        WHERE vault_id = ? AND device_pubkey = ? AND removed_at_ms IS NULL LIMIT 1`,
      vaultId,
      devicePubkey,
    );
    selfDeviceBound = !!deviceRow;
  }

  // Emit member_added ONLY when not already an active member AND the server
  // brokered an invite (member_witness proves owner intent). Swallow a
  // RoleGateRejectionError on a member_added the role-gate considers already
  // present — the device_added below is what we actually need to complete.
  if (res.member_witness && !selfIsActiveMember) {
    const memberWitness: MembershipWitness = {
      sig_b64: res.member_witness.sig_b64,
      server_key_id: res.server_key_id,
      issued_at_ms: res.member_witness.issued_at_ms,
      inviter_account_id: res.member_witness.inviter_account_id,
    };
    try {
      await appendVaultMemberAdded({
        targetVaultId: vaultId,
        accountId,
        role: res.member_witness.role,
        witness: memberWitness,
      });
    } catch (err) {
      if (err instanceof RoleGateRejectionError) {
        console.warn(
          "[trust/backfill] witnessed member_added declined by role-gate (already a member) — proceeding to device binding",
        );
      } else {
        throw err;
      }
    }
  }

  // Emit device_added ONLY when our pubkey isn't already an active bound
  // device. If it's already bound the retry is complete — return so the
  // caller clears witness_emit_pending.
  if (selfDeviceBound) return;

  const deviceWitness: MembershipWitness = {
    sig_b64: res.device_witness.sig_b64,
    server_key_id: res.server_key_id,
    issued_at_ms: res.device_witness.issued_at_ms,
  };
  await appendVaultDeviceAdded({
    targetVaultId: vaultId,
    accountId,
    deviceId: getInstallIdSync(),
    devicePubkeyB64: devicePubkey,
    witness: deviceWitness,
  });
}
