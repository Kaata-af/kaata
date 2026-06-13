// apps/mobile/lib/trust/proof.ts
//
// M2c — membership-proof plumbing between the event log and the mesh
// handshake (docs/m2-membership-chain.md §3 + §7). PERMANENT module:
// M3 (minimal-chain extraction) and M4 (VMC retirement + transport
// rewrite) build on the same three entry points.
//
// Division of labor:
//   - lib/trust/chain.ts is the PURE fold/verifier (no SQLite, injected
//     crypto) — do not add I/O there.
//   - THIS module owns the I/O: reading membership rows out of
//     event_log, the vault anchor out of vaults, and the pinned server
//     witness keys out of app_meta, then handing everything to the pure
//     verifier with the app's real crypto (runtimeChainCrypto).

import { getAppMeta, getDb, setAppMeta } from "../db";
import {
  foldMembership,
  MEMBERSHIP_EVENT_TYPES,
  verifyPeerProof,
  type MembershipEventLike,
  type MembershipState,
  type VaultRole,
} from "./chain";
import { runtimeChainCrypto } from "./crypto-runtime";

/**
 * Hard cap on how many membership events we load / present. Real shops
 * have <100 membership events total; hitting this cap means something
 * is pathologically wrong (or the vault is enormous) — we warn loudly
 * so M3's minimal-chain extraction gets prioritized if it ever fires.
 */
export const PROOF_BUNDLE_CAP = 500;

// app_meta keys for the pinned server witness pubkeys. M4: this module is
// the single source of truth — persistPinnedServerPubkeys (below) writes
// them on check-in and loadPinnedWitnessPubkeysB64 reads them for the
// chain handshake. (Relocated from the retired lib/mesh/vmc.ts.)
const META_KEY_WITNESS_PRIMARY = "mesh_server_pubkey_primary";
const META_KEY_WITNESS_ROTATION = "mesh_server_pubkey_rotation";

type MembershipRow = {
  event_id: string;
  event_type: string;
  target_id: string | null;
  relationship_id: string | null;
  hlc_physical_ms: number;
  hlc_logical: number;
  hlc_device_id: string;
  device_id: string;
  actor_account_id: string | null;
  payload_json: string;
  payload_schema: number;
  event_sig_b64: string | null;
  signer_device_pubkey: string | null;
  author_seq: number | null;
};

/**
 * SELECT the vault's membership-type rows (the 5 types in
 * MEMBERSHIP_EVENT_TYPES) from event_log in HLC order, shaped as
 * MembershipEventLike for the pure chain fold.
 *
 * Row filter: only `tombstone_reason IS NULL` (tombstones are
 * cryptographic ingest refusals — the fold would refuse them again, so
 * loading them is pure waste). QUARANTINED rows are deliberately
 * INCLUDED: quarantine is a role-gate/apply-time verdict under the
 * legacy source, not a crypto verdict, and a chain-valid removal that
 * the legacy role-gate couldn't attribute must still win inside the
 * fold (security: removals the verifier knows about always count).
 */
export async function loadLocalMembershipEvents(
  vaultId: string,
  cap: number = PROOF_BUNDLE_CAP,
): Promise<MembershipEventLike[]> {
  const db = await getDb();
  const types = [...MEMBERSHIP_EVENT_TYPES];
  const placeholders = types.map(() => "?").join(", ");
  const rows = await db.getAllAsync<MembershipRow>(
    `SELECT event_id, event_type, target_id, relationship_id,
            hlc_physical_ms, hlc_logical, hlc_device_id,
            device_id, actor_account_id, payload_json, payload_schema,
            event_sig_b64, signer_device_pubkey, author_seq
       FROM event_log
      WHERE vault_id = ?
        AND event_type IN (${placeholders})
        AND tombstone_reason IS NULL
      ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC, event_id ASC
      LIMIT ?`,
    vaultId,
    ...types,
    cap,
  );
  if (rows.length >= cap) {
    console.warn(
      `[trust/proof] membership event cap hit (${cap}) for vault ${vaultId.slice(0, 8)} — ` +
        `implement M3 minimal-chain extraction (docs/m2-membership-chain.md §3)`,
    );
  }

  const out: MembershipEventLike[] = [];
  for (const r of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(r.payload_json);
    } catch (err) {
      // Corrupt payload_json — the row can't be verified or presented.
      // Same loud-log policy as the mesh send path; the migration-014
      // sweep tombstones such rows on its next pass.
      console.error(
        `[trust/proof] payload_json corrupt for membership event=${r.event_id} — skipping`,
        err,
      );
      continue;
    }
    out.push({
      event_id: r.event_id,
      event_type: r.event_type,
      vault_id: vaultId,
      target_id: r.target_id ?? "",
      relationship_id: r.relationship_id,
      hlc: { pms: r.hlc_physical_ms, l: r.hlc_logical, did: r.hlc_device_id },
      device_id: r.device_id,
      actor_account_id: r.actor_account_id,
      payload,
      payload_schema: r.payload_schema,
      event_sig_b64: r.event_sig_b64,
      signer_device_pubkey: r.signer_device_pubkey,
      author_seq: r.author_seq,
    });
  }
  return out;
}

/**
 * The proof bundle WE present in a mesh Hello (v2).
 *
 * M2 implementation: the FULL local membership set — real shops have
 * <100 membership events, so the bundle is small relative to the BLE
 * session budget, and "everything we know" trivially satisfies the §3
 * requirement that the verifier's fold over (proof ∪ local) reaches our
 * own (account, device) binding.
 *
 * M3: implement the minimal-chain extraction per docs §3 (own
 * admission + own device binding + recursive signer admissions up to
 * the anchor) if bundle size ever matters for the BLE budget.
 */
export async function buildOwnProofBundle(vaultId: string): Promise<MembershipEventLike[]> {
  return loadLocalMembershipEvents(vaultId);
}

export type PeerMembershipVerdict =
  | { ok: true; account_id: string; role: VaultRole; device_id: string }
  | {
      ok: false;
      reason: "no_anchor" | "no_genesis" | "device_not_bound" | "device_removed" | "member_removed";
    };

/**
 * Handshake verifier (docs §7): fold the peer's proof events ∪ OUR OWN
 * local membership events against the vault anchor + pinned server
 * witness keys, then check the peer's claimed device pubkey resolves to
 * a live (account, role) binding. Local events are always included so a
 * removal we know about wins regardless of what the presenter omits —
 * that is the M2 revocation done-criterion.
 *
 * Vaults with a NULL trust anchor return the distinct `no_anchor`
 * verdict, which is a hard REFUSAL: M4 made the chain the sole trust path,
 * so an anchor-less vault has no verification at all. The mesh dispatch
 * gate (lib/mesh/index.ts) already filters anchor-less vaults out, so this
 * is fail-closed defense in depth.
 */
export async function verifyPeerMembership(args: {
  vaultId: string;
  claimedDevicePubkeyB64: string;
  proofEvents: MembershipEventLike[];
}): Promise<PeerMembershipVerdict> {
  const anchorPubkeyB64 = await loadVaultAnchorPubkeyB64(args.vaultId);
  if (!anchorPubkeyB64) return { ok: false, reason: "no_anchor" };

  const serverWitnessPubkeysB64 = await loadPinnedWitnessPubkeysB64();
  const localEvents = await loadLocalMembershipEvents(args.vaultId);

  const verdict = verifyPeerProof({
    vaultId: args.vaultId,
    anchorPubkeyB64,
    serverWitnessPubkeysB64,
    localEvents,
    proofEvents: args.proofEvents,
    claimedDevicePubkeyB64: args.claimedDevicePubkeyB64,
    crypto: runtimeChainCrypto,
  });
  if (!verdict.ok) return verdict;

  // verifyPeerProof binds pubkey → (account, role) but doesn't surface
  // the bound device_id, which the handshake needs (conn.remoteDeviceId,
  // revocation_list lookups, telemetry). Re-fold the same merged set to
  // read the device registry entry. Bounded by PROOF_BUNDLE_CAP and
  // membership sets are tiny, so the second fold is cheap; if M3 grows
  // ProofVerdict to carry device_id, delete this.
  const state = foldMembership({
    vaultId: args.vaultId,
    anchorPubkeyB64,
    serverWitnessPubkeysB64,
    events: mergeUniqueEvents(localEvents, args.proofEvents),
    crypto: runtimeChainCrypto,
  });
  const dev = state.devices.get(args.claimedDevicePubkeyB64);
  if (!dev || dev.removed) {
    // Unreachable when verifyPeerProof said ok (same inputs, same pure
    // fold) — defensive fail-closed.
    return { ok: false, reason: "device_not_bound" };
  }
  return {
    ok: true,
    account_id: verdict.account_id,
    role: verdict.role,
    device_id: dev.device_id,
  };
}

/**
 * Fold the vault's LOCAL membership knowledge only (no peer proof).
 * Used by the owner side of the pair flow to decide whether an
 * admission still needs `vault_member_added` / `vault_device_added`
 * emissions. Returns null for vaults with no trust anchor.
 */
export async function getLocalMembershipState(vaultId: string): Promise<MembershipState | null> {
  const anchorPubkeyB64 = await loadVaultAnchorPubkeyB64(vaultId);
  if (!anchorPubkeyB64) return null;
  return foldMembership({
    vaultId,
    anchorPubkeyB64,
    serverWitnessPubkeysB64: await loadPinnedWitnessPubkeysB64(),
    events: await loadLocalMembershipEvents(vaultId),
    crypto: runtimeChainCrypto,
  });
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function loadVaultAnchorPubkeyB64(vaultId: string): Promise<string | null> {
  const db = await getDb();
  try {
    const row = await db.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
      `SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ? LIMIT 1`,
      vaultId,
    );
    const v = row?.vault_trust_anchor_pubkey;
    return v && v.length > 0 ? v : null;
  } catch {
    // Column missing (pre-migration-012) — treat as server-anchored.
    return null;
  }
}

async function loadPinnedWitnessPubkeysB64(): Promise<string[]> {
  const out: string[] = [];
  const primary = await getAppMeta(META_KEY_WITNESS_PRIMARY);
  if (primary) out.push(primary);
  const rotation = await getAppMeta(META_KEY_WITNESS_ROTATION);
  if (rotation) out.push(rotation);
  return out;
}

const META_KEY_WITNESS_PINNED_AT = "mesh_server_pubkey_pinned_at_ms";

export type PubkeyPinOutcome =
  | "first_pin"
  | "no_change"
  | "rotation_accepted"
  | "rotation_refused_mitm";

/**
 * Persist the pinned server WITNESS pubkeys announced in a /v1/check-in
 * response. Relocated from lib/mesh/vmc.ts (deleted in M4) — these are the
 * same keys loadPinnedWitnessPubkeysB64() reads, which the chain handshake
 * (verifyPeerMembership) uses to verify witness attestations on the online
 * invite/admission path. NOTE: the witness keys never signed VMCs in the
 * first place; this pinning is independent of the retired credential
 * system.
 *
 * SECURITY MODEL — Trust-On-First-Use (TOFU):
 *   1. The FIRST primary pubkey we see is pinned. From then on it is the
 *      root of trust for witness verification.
 *   2. A response whose primary EQUALS the pin is accepted silently.
 *   3. A response whose primary DIFFERS is accepted IFF the wire's
 *      rotation slot carries the EXISTING pinned primary (server promoted
 *      rotation → primary and is telling us the old key for a grace
 *      window). Atomically: store new primary, store old as rotation.
 *   4. Otherwise REFUSE the overwrite and warn — the symptom of a TLS MITM
 *      trying to install their own key. The user keeps their pin.
 *
 * `rotationB64`:
 *   - non-null: store it as the rotation key (after the TOFU gate).
 *   - null/undefined: clear any previously-stored rotation key.
 */
export async function persistPinnedServerPubkeys(
  primaryB64: string,
  rotationB64: string | null | undefined,
): Promise<PubkeyPinOutcome> {
  if (!primaryB64) return "no_change"; // never clear primary — breaks mesh entirely
  const db = await getDb();
  const existingPrimary = await getAppMeta(META_KEY_WITNESS_PRIMARY);

  if (!existingPrimary) {
    await setAppMeta(META_KEY_WITNESS_PRIMARY, primaryB64);
    await setAppMeta(META_KEY_WITNESS_PINNED_AT, String(Date.now()));
    if (rotationB64) {
      await setAppMeta(META_KEY_WITNESS_ROTATION, rotationB64);
    } else {
      await db.runAsync(`DELETE FROM app_meta WHERE key = ?`, META_KEY_WITNESS_ROTATION);
    }
    return "first_pin";
  }

  if (existingPrimary === primaryB64) {
    if (rotationB64 == null) {
      await db.runAsync(`DELETE FROM app_meta WHERE key = ?`, META_KEY_WITNESS_ROTATION);
    } else {
      await setAppMeta(META_KEY_WITNESS_ROTATION, rotationB64);
    }
    return "no_change";
  }

  if (rotationB64 && rotationB64 === existingPrimary) {
    await setAppMeta(META_KEY_WITNESS_PRIMARY, primaryB64);
    await setAppMeta(META_KEY_WITNESS_ROTATION, existingPrimary);
    await setAppMeta(META_KEY_WITNESS_PINNED_AT, String(Date.now()));
    return "rotation_accepted";
  }

  console.warn(
    "[trust] REFUSED server witness pubkey overwrite — pinned primary differs " +
      "from wire primary and rotation slot does not carry the previous primary. " +
      "This is the symptom of TLS MITM. Keeping original pin.",
    { existingPrefix: existingPrimary.slice(0, 8), wirePrefix: primaryB64.slice(0, 8) },
  );
  return "rotation_refused_mitm";
}

/** Dedup by event_id, local knowledge first — mirrors verifyPeerProof's
 *  merge so both folds in verifyPeerMembership see identical input. */
function mergeUniqueEvents(
  local: MembershipEventLike[],
  proof: MembershipEventLike[],
): MembershipEventLike[] {
  const seen = new Set<string>();
  const merged: MembershipEventLike[] = [];
  for (const e of [...local, ...proof]) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    merged.push(e);
  }
  return merged;
}
