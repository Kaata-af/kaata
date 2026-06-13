// M2 membership chain — the core trust fold (docs/m2-membership-chain.md §3).
//
// PURE MODULE: no SQLite, no React Native, no static crypto imports. All
// cryptography is dependency-injected (ChainCrypto) so:
//   - the app wires the real event-sig implementations (crypto-runtime.ts),
//   - the bun selftest injects noble directly and pins canonical fixtures,
//     catching any drift between the two.
//
// The fold is DETERMINISTIC and SKIP-INVALID: every replica folding the same
// events computes byte-identical membership state; an unauthorized or
// malformed event is recorded as a conflict and skipped, never fatal — a
// malicious insert cannot brick the fold. Authorization is evaluated against
// the state built SO FAR, which (because the fold runs in HLC order) is
// exactly lawful-at-HLC: an owner demoted at T still validly signed
// admissions before T.

export type HlcTuple = { pms: number; l: number; did: string };

export type VaultRole = "owner" | "editor" | "viewer";

export type MembershipWitnessLike = {
  sig_b64: string;
  server_key_id: string;
  issued_at_ms: number;
  inviter_account_id?: string;
};

/** Structural event shape — mirrors LedgerEvent's signable envelope without
 *  importing lib/events.ts (keeps this module bun-runnable). */
export type MembershipEventLike = {
  event_id: string;
  event_type: string;
  vault_id: string | null;
  target_id: string;
  relationship_id: string | null;
  hlc: HlcTuple;
  device_id: string;
  actor_account_id: string | null;
  payload: unknown;
  payload_schema: number;
  event_sig_b64?: string | null;
  signer_device_pubkey?: string | null;
  // M3.5: the author's transfer seq, carried so a membership event relayed in
  // the proof bundle is recorded with its seq (vector-visible). Not part of
  // the chain fold — purely transfer bookkeeping.
  author_seq?: number | null;
};

export type ChainCrypto = {
  /** Event-envelope signature check (lib/event-sig verifyEventSignature). */
  verifyEvent: (event: MembershipEventLike, sigB64: string, pubkeyB64: string) => boolean;
  /** Raw bytes signature check (lib/event-sig verifyRawSignature). */
  verifyRaw: (msg: Uint8Array, sigB64: string, pubkeyB64: string) => boolean;
  /** Canonical JSON encoder (lib/event-sig canonicalize). */
  canonicalize: (v: unknown) => string;
};

export type MemberEntry = {
  account_id: string;
  role: VaultRole;
  removed: boolean;
};

export type DeviceEntry = {
  device_pubkey: string;
  device_id: string;
  account_id: string;
  removed: boolean;
};

export type ChainConflict = {
  event_id: string;
  event_type: string;
  reason:
    | "bad_signature"
    | "missing_signature"
    | "wrong_vault"
    | "malformed_payload"
    | "not_genesis_eligible"
    | "signer_not_owner_device"
    | "witness_invalid"
    | "witness_stale"
    | "witness_role_too_high"
    | "removed_entry_replay"
    | "last_owner"
    | "unknown_member_account"
    | "unknown_device"
    | "unauthorized";
};

export type MembershipState = {
  /** account_id → entry. Removal is sticky on the entry (re-add flips it). */
  members: Map<string, MemberEntry>;
  /** device_pubkey_b64 → entry. */
  devices: Map<string, DeviceEntry>;
  /** Events the fold refused, in fold order. Deterministic. */
  conflicts: ChainConflict[];
  /** True once a valid genesis admission has been folded. */
  hasGenesis: boolean;
};

export const MEMBERSHIP_EVENT_TYPES: ReadonlySet<string> = new Set([
  "vault_member_added",
  "vault_member_role_changed",
  "vault_member_removed",
  "vault_device_added",
  "vault_device_removed",
]);

/** Witness freshness window: ±7 days between attestation and event HLC
 *  (limits replay of a leaked witness; generous for offline queuing). */
export const WITNESS_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

// Total HLC order — identical to lib/hlc.ts compare semantics.
export function hlcCompare(a: HlcTuple, b: HlcTuple): number {
  if (a.pms !== b.pms) return a.pms - b.pms;
  if (a.l !== b.l) return a.l - b.l;
  return a.did < b.did ? -1 : a.did > b.did ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Witness tuples — canonical forms shared byte-for-byte with the backend.
// (The Go side signs canonicalize() of these exact objects; the bun selftest
// pins fixture strings for both.)
// ---------------------------------------------------------------------------

export function deviceWitnessTuple(args: {
  vault_id: string;
  account_id: string;
  device_id: string;
  device_pubkey_b64: string;
  issued_at_ms: number;
}): Record<string, unknown> {
  return {
    account_id: args.account_id,
    device_id: args.device_id,
    device_pubkey_b64: args.device_pubkey_b64,
    issued_at_ms: args.issued_at_ms,
    vault_id: args.vault_id,
  };
}

export function memberWitnessTuple(args: {
  vault_id: string;
  account_id: string;
  inviter_account_id: string;
  role: VaultRole;
  issued_at_ms: number;
}): Record<string, unknown> {
  return {
    account_id: args.account_id,
    inviter_account_id: args.inviter_account_id,
    issued_at_ms: args.issued_at_ms,
    role: args.role,
    vault_id: args.vault_id,
  };
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

export type FoldArgs = {
  vaultId: string;
  /** base64 Ed25519 — the vault's root of trust (owner device key). */
  anchorPubkeyB64: string;
  /** Pinned server signing pubkeys (primary [+ rotation]). May be empty —
   *  then witness-path events simply fail closed. */
  serverWitnessPubkeysB64: string[];
  events: MembershipEventLike[];
  crypto: ChainCrypto;
};

export function foldMembership(args: FoldArgs): MembershipState {
  const { vaultId, anchorPubkeyB64, serverWitnessPubkeysB64, crypto } = args;

  const state: MembershipState = {
    members: new Map(),
    devices: new Map(),
    conflicts: [],
    hasGenesis: false,
  };

  // Deterministic order: HLC, then event_id as the total-order tiebreaker
  // (mirrors migration 018's backfill ordering rationale).
  const ordered = [...args.events]
    .filter((e) => MEMBERSHIP_EVENT_TYPES.has(e.event_type))
    .sort((a, b) => hlcCompare(a.hlc, b.hlc) || (a.event_id < b.event_id ? -1 : 1));

  const refuse = (e: MembershipEventLike, reason: ChainConflict["reason"]): void => {
    state.conflicts.push({ event_id: e.event_id, event_type: e.event_type, reason });
  };

  const signerIsActiveOwnerDevice = (signerPubkey: string): boolean => {
    const dev = state.devices.get(signerPubkey);
    if (!dev || dev.removed) return false;
    const member = state.members.get(dev.account_id);
    return !!member && !member.removed && member.role === "owner";
  };

  const countActiveOwners = (s: MembershipState): number => {
    let n = 0;
    for (const m of s.members.values()) {
      if (!m.removed && m.role === "owner") n++;
    }
    return n;
  };

  // True if upserting `accountId` to `newRole` would demote the only active
  // owner. Covers vault_member_added's UPSERT-demotion vector (the guard on
  // role_changed/removed alone left it open).
  const wouldDemoteSoleOwner = (
    s: MembershipState,
    accountId: string,
    newRole: VaultRole,
  ): boolean => {
    if (newRole === "owner") return false;
    const existing = s.members.get(accountId);
    if (!existing || existing.removed || existing.role !== "owner") return false;
    return countActiveOwners(s) <= 1;
  };

  const witnessValid = (
    e: MembershipEventLike,
    witness: MembershipWitnessLike | undefined,
    tuple: Record<string, unknown> | null,
  ): "ok" | "stale" | "invalid" => {
    if (!witness || !tuple) return "invalid";
    if (typeof witness.issued_at_ms !== "number") return "invalid";
    if (Math.abs(witness.issued_at_ms - e.hlc.pms) > WITNESS_FRESHNESS_MS) return "stale";
    const msg = new TextEncoder().encode(crypto.canonicalize(tuple));
    for (const pub of serverWitnessPubkeysB64) {
      if (crypto.verifyRaw(msg, witness.sig_b64, pub)) return "ok";
    }
    return "invalid";
  };

  for (const e of ordered) {
    if (e.vault_id !== vaultId) {
      refuse(e, "wrong_vault");
      continue;
    }
    const signer = e.signer_device_pubkey ?? null;
    const sig = e.event_sig_b64 ?? null;
    if (!signer || !sig) {
      refuse(e, "missing_signature");
      continue;
    }
    if (!crypto.verifyEvent(e, sig, signer)) {
      refuse(e, "bad_signature");
      continue;
    }

    const p = (e.payload ?? {}) as Record<string, unknown>;

    switch (e.event_type) {
      case "vault_member_added": {
        const accountId = typeof p.account_id === "string" ? p.account_id : null;
        const role =
          p.role === "owner" || p.role === "editor" || p.role === "viewer"
            ? (p.role as VaultRole)
            : null;
        if (!accountId || !role) {
          refuse(e, "malformed_payload");
          continue;
        }

        if (!state.hasGenesis) {
          // Genesis: must be the anchor itself self-admitting as owner.
          if (signer !== anchorPubkeyB64 || role !== "owner") {
            refuse(e, "not_genesis_eligible");
            continue;
          }
          state.hasGenesis = true;
          state.members.set(accountId, { account_id: accountId, role: "owner", removed: false });
          // The genesis event implicitly binds the anchor device.
          state.devices.set(anchorPubkeyB64, {
            device_pubkey: anchorPubkeyB64,
            device_id: e.device_id,
            account_id: accountId,
            removed: false,
          });
          continue;
        }

        // Offline/QR path: any active owner-bound device. (The anchor is
        // always such a device unless explicitly removed.)
        if (signerIsActiveOwnerDevice(signer)) {
          // Last-owner guard: vault_member_added is also an UPSERT, so a
          // re-add of an existing active owner at a lower role demotes them
          // — the same lockout vector the guard on role_changed/removed
          // blocks. Refuse if it would zero the active owner set.
          if (wouldDemoteSoleOwner(state, accountId, role)) {
            refuse(e, "last_owner");
            continue;
          }
          upsertMember(state, accountId, role);
          continue;
        }
        // Online path: server-witnessed admission proving owner intent via
        // a brokered invite.
        //
        // SECURITY: a witness is an INVITE attestation, never an owner
        // grant (§1). It can only admit at editor/viewer — owner promotion
        // requires an owner-signed role_changed or the anchor. Without this
        // cap, a leaked/misbehaving witness key would mint a brand-new
        // owner and take the vault over.
        if (role === "owner") {
          refuse(e, "witness_role_too_high");
          continue;
        }
        // SECURITY: a witness must not RESURRECT a removed member. The
        // witness tuple carries no removal-epoch, so a removed member
        // could replay their original (still-fresh) admission witness at a
        // later HLC and re-enter. Only an owner-signed re-add may lift a
        // removal; the owner-bound path above already handles that.
        const existingMember = state.members.get(accountId);
        if (existingMember && existingMember.removed) {
          refuse(e, "removed_entry_replay");
          continue;
        }
        // Last-owner guard on the witnessed path too: a leaked/misbehaving
        // witness key signing a member_added for the sole owner's account
        // at editor/viewer (role!=owner passes the cap above) would demote
        // them via upsertMember and brick the vault. This is the §9.4
        // "leaked witness alone" invariant.
        if (wouldDemoteSoleOwner(state, accountId, role)) {
          refuse(e, "last_owner");
          continue;
        }
        const w = p.witness as MembershipWitnessLike | undefined;
        const inviter = w?.inviter_account_id;
        const verdict = witnessValid(
          e,
          w,
          inviter
            ? memberWitnessTuple({
                vault_id: vaultId,
                account_id: accountId,
                inviter_account_id: inviter,
                role,
                issued_at_ms: w?.issued_at_ms ?? 0,
              })
            : null,
        );
        if (verdict === "ok") {
          upsertMember(state, accountId, role);
        } else {
          refuse(e, verdict === "stale" ? "witness_stale" : "signer_not_owner_device");
        }
        continue;
      }

      case "vault_member_role_changed": {
        const accountId = typeof p.account_id === "string" ? p.account_id : null;
        const role =
          p.role === "owner" || p.role === "editor" || p.role === "viewer"
            ? (p.role as VaultRole)
            : null;
        if (!accountId || !role) {
          refuse(e, "malformed_payload");
          continue;
        }
        if (!signerIsActiveOwnerDevice(signer)) {
          refuse(e, "signer_not_owner_device");
          continue;
        }
        const member = state.members.get(accountId);
        if (!member || member.removed) {
          refuse(e, "unknown_member_account");
          continue;
        }
        // Last-owner guard: demoting the only owner would zero the active
        // owner set, after which NO future membership event could ever be
        // authorized — a permanent, unrecoverable lockout. Refuse instead.
        if (member.role === "owner" && role !== "owner" && countActiveOwners(state) <= 1) {
          refuse(e, "last_owner");
          continue;
        }
        member.role = role;
        continue;
      }

      case "vault_member_removed": {
        const accountId = typeof p.account_id === "string" ? p.account_id : null;
        if (!accountId) {
          refuse(e, "malformed_payload");
          continue;
        }
        if (!signerIsActiveOwnerDevice(signer)) {
          refuse(e, "signer_not_owner_device");
          continue;
        }
        const member = state.members.get(accountId);
        if (!member || member.removed) {
          refuse(e, "unknown_member_account");
          continue;
        }
        // Last-owner guard (see role_changed above): removing the only
        // owner bricks the vault.
        if (member.role === "owner" && countActiveOwners(state) <= 1) {
          refuse(e, "last_owner");
          continue;
        }
        member.removed = true;
        // Removing the account retires all its bound devices.
        for (const dev of state.devices.values()) {
          if (dev.account_id === accountId) dev.removed = true;
        }
        continue;
      }

      case "vault_device_added": {
        const accountId = typeof p.account_id === "string" ? p.account_id : null;
        const deviceId = typeof p.device_id === "string" ? p.device_id : null;
        const devicePubkey = typeof p.device_pubkey === "string" ? p.device_pubkey : null;
        if (!accountId || !deviceId || !devicePubkey) {
          refuse(e, "malformed_payload");
          continue;
        }
        const member = state.members.get(accountId);
        if (!member || member.removed) {
          refuse(e, "unknown_member_account");
          continue;
        }

        // Path (a): owner-bound device vouches (QR / backfill).
        if (signerIsActiveOwnerDevice(signer)) {
          bindDevice(state, devicePubkey, deviceId, accountId);
          continue;
        }
        // Path (b): the named device self-signs + server witness. The
        // envelope must actually be signed by the key being bound, by the
        // device claiming that id.
        if (signer === devicePubkey && e.device_id === deviceId) {
          // SECURITY: a witness must not RESURRECT a removed device (same
          // replay attack as the witnessed member path). Only an
          // owner-signed re-bind (the path above) may lift a removal.
          const existingDev = state.devices.get(devicePubkey);
          if (existingDev && existingDev.removed) {
            refuse(e, "removed_entry_replay");
            continue;
          }
          const w = p.witness as MembershipWitnessLike | undefined;
          const verdict = witnessValid(
            e,
            w,
            deviceWitnessTuple({
              vault_id: vaultId,
              account_id: accountId,
              device_id: deviceId,
              device_pubkey_b64: devicePubkey,
              issued_at_ms: w?.issued_at_ms ?? 0,
            }),
          );
          if (verdict === "ok") {
            bindDevice(state, devicePubkey, deviceId, accountId);
          } else {
            refuse(e, verdict === "stale" ? "witness_stale" : "witness_invalid");
          }
          continue;
        }
        refuse(e, "unauthorized");
        continue;
      }

      case "vault_device_removed": {
        const deviceId = typeof p.device_id === "string" ? p.device_id : null;
        if (!deviceId) {
          refuse(e, "malformed_payload");
          continue;
        }
        // Retire EVERY non-removed device sharing this device_id — the
        // registry is keyed by pubkey, so a device_id can carry more than
        // one bound pubkey (key rotation, re-bind). A `.find()` would leave
        // the other pubkey live and an incomplete revocation; the mobile
        // applier (vault_devices.ts) already tombstones all rows for the id.
        const targets = [...state.devices.values()].filter(
          (d) => d.device_id === deviceId && !d.removed,
        );
        if (targets.length === 0) {
          refuse(e, "unknown_device");
          continue;
        }
        // Owner devices may remove any device; a member's own OTHER bound
        // device may remove a same-account device ("remove my old phone").
        const signerDev = state.devices.get(signer);
        const signerSameAccount =
          !!signerDev &&
          !signerDev.removed &&
          targets.every((t) => t.account_id === signerDev.account_id);
        if (!signerIsActiveOwnerDevice(signer) && !signerSameAccount) {
          refuse(e, "signer_not_owner_device");
          continue;
        }
        for (const t of targets) t.removed = true;
        continue;
      }
    }
  }

  return state;
}

function upsertMember(state: MembershipState, accountId: string, role: VaultRole): void {
  const existing = state.members.get(accountId);
  if (existing) {
    // Re-admission lifts a prior removal; duplicate admission is a no-op
    // role refresh (keeps the fold idempotent under backfill duplicates).
    existing.removed = false;
    existing.role = role;
  } else {
    state.members.set(accountId, { account_id: accountId, role, removed: false });
  }
}

function bindDevice(
  state: MembershipState,
  devicePubkey: string,
  deviceId: string,
  accountId: string,
): void {
  const existing = state.devices.get(devicePubkey);
  if (existing) {
    existing.removed = false;
    existing.device_id = deviceId;
    existing.account_id = accountId;
  } else {
    state.devices.set(devicePubkey, {
      device_pubkey: devicePubkey,
      device_id: deviceId,
      account_id: accountId,
      removed: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Peer proof verification (handshake)
// ---------------------------------------------------------------------------

export type ProofVerdict =
  | { ok: true; account_id: string; role: VaultRole }
  | {
      ok: false;
      reason: "no_genesis" | "device_not_bound" | "device_removed" | "member_removed";
    };

/**
 * Verify a peer's claimed (account, device) against proof events ∪ our own
 * local membership events. Local knowledge is always included so a removal
 * we know about wins regardless of what the presenter omits.
 */
export function verifyPeerProof(args: {
  vaultId: string;
  anchorPubkeyB64: string;
  serverWitnessPubkeysB64: string[];
  localEvents: MembershipEventLike[];
  proofEvents: MembershipEventLike[];
  claimedDevicePubkeyB64: string;
  crypto: ChainCrypto;
}): ProofVerdict {
  const seen = new Set<string>();
  const merged: MembershipEventLike[] = [];
  for (const e of [...args.localEvents, ...args.proofEvents]) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    merged.push(e);
  }
  const state = foldMembership({
    vaultId: args.vaultId,
    anchorPubkeyB64: args.anchorPubkeyB64,
    serverWitnessPubkeysB64: args.serverWitnessPubkeysB64,
    events: merged,
    crypto: args.crypto,
  });

  if (!state.hasGenesis) return { ok: false, reason: "no_genesis" };
  const dev = state.devices.get(args.claimedDevicePubkeyB64);
  if (!dev) return { ok: false, reason: "device_not_bound" };
  if (dev.removed) return { ok: false, reason: "device_removed" };
  const member = state.members.get(dev.account_id);
  if (!member || member.removed) return { ok: false, reason: "member_removed" };
  return { ok: true, account_id: member.account_id, role: member.role };
}
