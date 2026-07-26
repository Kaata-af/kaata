package sync

// M2 membership chain (docs/m2-membership-chain.md §8.2): push-side
// verification and fold of membership events.
//
// When a vault has a trust anchor (vaults.vault_trust_anchor_pubkey) AND a
// membership event arrives carrying an author signature, the chain rules —
// not the JWT ACL — decide acceptance:
//
//   authorized iff
//     (a) the signer pubkey IS the vault trust anchor (the owner's device;
//         transitively the chain root), or
//     (b) the signer pubkey is a bound, unremoved vault_devices row whose
//         account holds the owner role at the event's HLC (lawful-at-HLC,
//         same roleAtHLC the ledger ACL uses), or
//     (b2) for vault_device_removed only: the signer is a bound, unremoved
//         device of the SAME account that owns the device being removed
//         (self-service "remove my old phone", §2), or
//     (b3) for vault_member_removed only: the signer is a bound, unremoved
//         device of the SAME account being removed (self-service "leave
//         kaata" — any role may remove itself; the fold's last-owner guard
//         still refuses a sole owner's self-removal), or
//     (c) the event carries a valid server witness per its type's rule
//         (§2): freshness ±7d vs the event HLC, signature over the
//         canonical witness tuple, verified against the pinned server
//         signing pubkey set. vault_device_added additionally requires the
//         event's signer to BE the named device (self-signed + witness).
//
// Failures reject the single event with reason "membership_unverified" —
// never the batch.
//
// Legacy paths are untouched: anchor-less vaults and unsigned membership
// events keep the existing JWT + roleAtHLC ACL exactly as before, and are
// NOT folded (vault_members keeps being driven by the Phase 4 endpoints
// for those flows).
//
// On acceptance of a chain-verified event, the server folds it into its
// operational ACL tables inside the same push transaction:
//   vault_member_added        → vault_members insert (if no active row)
//   vault_member_role_changed → vault_members.role update
//   vault_member_removed      → vault_members.revoked_at + all the
//                               account's vault_devices removed
//   vault_device_added        → vault_devices upsert (re-add clears removal,
//                               HLC-arbitrated: a stale add never resurrects)
//   vault_device_removed      → vault_devices.removed_at_ms (HLC-arbitrated:
//                               a stale removal never clobbers a newer bind)
// vault_member_* folds bump vaults.vault_epoch like SetMemberRole does.
// Removals/demotions that would zero the vault's active owner count are
// skipped (last-owner guard, parity with the REST endpoints + mobile gate).

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/mesh"
)

// RejectReasonMembershipUnverified is the per-event rejection reason for
// membership events that fail chain verification.
const RejectReasonMembershipUnverified = "membership_unverified"

// RejectReasonFutureHLC is the per-event rejection reason for an event whose HLC
// physical time is implausibly far ahead of the server clock (> maxFutureHLCSkewMS).
// The client MUST treat this as retryable (leave the event unacked, do NOT
// tombstone it) so a temporarily-wrong device clock can't permanently drop it.
const RejectReasonFutureHLC = "future_hlc"

// witnessFreshnessWindowMS — a witness's issued_at_ms must be within ±7
// days of the event's hlc_physical_ms (§2: limits replay of a leaked
// witness while tolerating offline queuing after an online witness fetch).
const witnessFreshnessWindowMS = int64(7 * 24 * 60 * 60 * 1000)

// membershipEventTypes is the M2 membership-chain event-type set as a slice,
// for SQL `event_type = ANY($n)` filters (e.g. the M5 snapshot membership
// pull). Kept in lockstep with IsMembershipEventType below — both source the
// same EventVault* constants.
var membershipEventTypes = []string{
	EventVaultMemberAdded,
	EventVaultMemberRoleChng,
	EventVaultMemberRemoved,
	EventVaultDeviceAdded,
	EventVaultDeviceRemoved,
}

// IsMembershipEventType reports whether eventType participates in the M2
// membership chain.
func IsMembershipEventType(eventType string) bool {
	switch eventType {
	case EventVaultMemberAdded,
		EventVaultMemberRoleChng,
		EventVaultMemberRemoved,
		EventVaultDeviceAdded,
		EventVaultDeviceRemoved:
		return true
	}
	return false
}

// SetWitnessPubkeys pins the server signing pubkey set used to verify the
// `witness` field on membership events. Plural so a rotation window
// verifies against both old and new keys. Wired at startup from the mesh
// signing material; empty disables the witness arm (anchor / bound-owner
// arms keep working).
func (s *Service) SetWitnessPubkeys(keys []ed25519.PublicKey) {
	s.witnessPubkeys = keys
}

// ---------------------------------------------------------------------------
// Wire payload shapes (mirror apps/mobile/lib/events.ts)
// ---------------------------------------------------------------------------

type membershipWitnessWire struct {
	SigB64           string `json:"sig_b64"`
	ServerKeyID      string `json:"server_key_id"`
	IssuedAtMS       int64  `json:"issued_at_ms"`
	InviterAccountID string `json:"inviter_account_id"`
}

type memberAddedWire struct {
	AccountID string                 `json:"account_id"`
	Role      string                 `json:"role"`
	Witness   *membershipWitnessWire `json:"witness"`
}

type memberRoleChangedWire struct {
	AccountID string `json:"account_id"`
	Role      string `json:"role"`
}

type memberRemovedWire struct {
	AccountID string `json:"account_id"`
}

type deviceAddedWire struct {
	AccountID    string                 `json:"account_id"`
	DeviceID     string                 `json:"device_id"`
	DevicePubkey string                 `json:"device_pubkey"` // std base64, 32 bytes
	Witness      *membershipWitnessWire `json:"witness"`
}

type deviceRemovedWire struct {
	DeviceID string `json:"device_id"`
}

// ---------------------------------------------------------------------------
// Canonical signable event (Go mirror of mobile lib/event-sig.ts
// canonicalizeEvent — the fixture pin lives in internal/canonical tests)
// ---------------------------------------------------------------------------

func canonicalSignableEvent(vaultID string, ev *PushEvent) ([]byte, error) {
	payloadRaw := ev.Payload
	if len(payloadRaw) == 0 {
		payloadRaw = json.RawMessage("null")
	}
	payload, err := canonical.Decode(payloadRaw)
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	return canonical.Canonicalize(map[string]any{
		"actor_account_id": strOrNull(ev.ActorAccountID),
		"device_id":        ev.HLC.DeviceID,
		"event_id":         ev.EventID,
		"event_type":       ev.EventType,
		"hlc": map[string]any{
			"did": ev.HLC.DeviceID,
			"l":   ev.HLC.Logical,
			"pms": ev.HLC.PhysicalMS,
		},
		"payload":         payload,
		"payload_schema":  ev.SchemaVersion,
		"relationship_id": strOrNull(ev.RelationshipID),
		"target_id":       strOrNull(ev.TargetID),
		"vault_id":        vaultID,
	})
}

// strOrNull maps an absent wire field to canonical null. Present-but-empty
// stays "" — only the signer knows which it meant, and a mismatch merely
// fails verification (fail-closed).
func strOrNull(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

// verifyMembershipEvent runs the chain rules for one signed membership
// event on an anchored vault. Returns (true, nil) when the event is
// authorized, (false, nil) when it must be rejected with
// "membership_unverified", and a non-nil error only for infrastructure
// failures (DB errors) that should fail the batch.
func (s *Service) verifyMembershipEvent(
	ctx context.Context,
	tx pgx.Tx,
	vaultID string,
	pusherAccountID string,
	anchor []byte,
	ev *PushEvent,
) (bool, error) {
	sig, err := base64.StdEncoding.DecodeString(derefStr(ev.EventSigB64))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false, nil
	}
	signerPub, err := base64.StdEncoding.DecodeString(derefStr(ev.SignerDevicePubkeyB64))
	if err != nil || len(signerPub) != ed25519.PublicKeySize {
		return false, nil
	}

	// 1. The signature itself: canonical envelope+payload, signed by the
	// claimed signer key. Tampering with any signed field — or a payload
	// that isn't valid JSON — fails here.
	canonicalBytes, err := canonicalSignableEvent(vaultID, ev)
	if err != nil {
		return false, nil
	}
	if !ed25519.Verify(ed25519.PublicKey(signerPub), canonicalBytes, sig) {
		return false, nil
	}

	// 2a. Anchor arm: the owner's device key signs anything. Genesis
	// special case (§8.2): a vault_member_added on a vault with no
	// vault_members rows at all is the chain root — it must self-admit the
	// pusher's own account at role owner.
	if bytes.Equal(signerPub, anchor) {
		if ev.EventType == EventVaultMemberAdded {
			var total int
			if err := tx.QueryRow(ctx, `
				SELECT COUNT(*) FROM vault_members WHERE vault_id = $1::uuid
			`, vaultID).Scan(&total); err != nil {
				return false, fmt.Errorf("count vault_members: %w", err)
			}
			if total == 0 {
				var p memberAddedWire
				if err := json.Unmarshal(ev.Payload, &p); err != nil {
					return false, nil
				}
				if p.Role != "owner" || p.AccountID != pusherAccountID {
					return false, nil
				}
			}
		}
		return true, nil
	}

	// 2b. Bound-device arms. One pubkey can in principle be bound under
	// several device_ids; any binding that satisfies an arm authorizes.
	signerAccounts, err := boundAccountsForPubkey(ctx, tx, vaultID, signerPub, ev.HLC.PhysicalMS)
	if err != nil {
		return false, err
	}
	vaultUUID, perr := uuid.Parse(vaultID)
	if perr != nil {
		return false, nil
	}
	for _, acct := range signerAccounts {
		acctUUID, perr := uuid.Parse(acct)
		if perr != nil {
			continue
		}
		role, found, rerr := roleAtHLC(ctx, tx, acctUUID, vaultUUID, ev.HLC.PhysicalMS)
		if rerr != nil {
			return false, fmt.Errorf("signer role lookup: %w", rerr)
		}
		if found && role == "owner" {
			return true, nil
		}
		// 2b-manager (roles v2, docs/roles-v2-design.md): a manager-bound
		// device may author member events strictly BELOW manager rank —
		// both the granted role and the target's lawful-at-HLC current role
		// must rank below manager, so a manager can never touch owners,
		// other managers, or mint a manager/owner. Device events stay
		// owner/self-only. MUST stay in lockstep with the mobile gate's
		// manager carve-out (role-gate.ts) and fold (chain.ts).
		if found && role == "manager" {
			ok, merr := managerCapSatisfied(ctx, tx, vaultUUID, ev)
			if merr != nil {
				return false, merr
			}
			if ok {
				return true, nil
			}
		}
	}

	// 2b3. vault_member_removed self-service ("leave kaata"): a bound,
	// unremoved device of the account being removed may remove its OWN
	// account, whatever its role. Mirrors the mobile role-gate's self-leave
	// carve-out and the chain fold's self-leave arm (lib/trust/chain.ts) —
	// server and replicas must accept identical events. The fold's
	// wouldDropLastOwner guard below still refuses to operationalize a sole
	// owner's self-removal, matching the REST /leave endpoint's ErrLastOwner.
	// KNOWN EDGE (pre-existing class, unchanged here): TWO co-owners
	// self-leaving concurrently offline are arbitrated by ARRIVAL order in
	// the server fold's last-owner guard but by HLC order in the mobile chain
	// fold — the two can disagree about which owner survived. Inherent to the
	// current-state-guard vs ordered-fold split shared by every membership
	// mutation; fixing it means HLC-ordered last-owner arbitration
	// server-side, tracked separately.
	if ev.EventType == EventVaultMemberRemoved && len(signerAccounts) > 0 {
		var p memberRemovedWire
		if err := json.Unmarshal(ev.Payload, &p); err == nil && p.AccountID != "" {
			for _, acct := range signerAccounts {
				if acct == p.AccountID {
					return true, nil
				}
			}
		}
	}

	// 2b2. vault_device_removed self-service: a bound device of the same
	// account may remove its account's other device.
	if ev.EventType == EventVaultDeviceRemoved && len(signerAccounts) > 0 {
		var p deviceRemovedWire
		if err := json.Unmarshal(ev.Payload, &p); err == nil && p.DeviceID != "" {
			if _, perr := uuid.Parse(p.DeviceID); perr == nil {
				var targetAccount string
				err := tx.QueryRow(ctx, `
					SELECT account_id::text FROM vault_devices
					 WHERE vault_id = $1::uuid AND device_id = $2::uuid
				`, vaultID, p.DeviceID).Scan(&targetAccount)
				if err != nil && !isNoRows(err) {
					return false, fmt.Errorf("read target device: %w", err)
				}
				if err == nil {
					for _, acct := range signerAccounts {
						if acct == targetAccount {
							return true, nil
						}
					}
				}
			}
		}
	}

	// 2c. Witness arm — only the two event types §2 grants a witness rule.
	switch ev.EventType {
	case EventVaultMemberAdded:
		var p memberAddedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil || p.Witness == nil {
			return false, nil
		}
		// SEC FIX 3 (defense-in-depth cap): a WITNESSED admission can never
		// mint an owner — nor, since roles v2, ANY member-managing role
		// (manager or above). Promotion requires an owner-signed
		// vault_member_role_changed (or the anchor itself). The invite
		// system already caps brokered invites below manager, but a
		// leaked/forged witness over a role=owner/manager tuple must still
		// be refused here — the witness arm is the one path that admits an
		// account the owner's device never physically met. Reject with the
		// per-event "membership_unverified".
		if !isValidMemberRole(p.Role) || roleRank[p.Role] >= roleRank["manager"] {
			return false, nil
		}
		w := p.Witness
		if !witnessFresh(w.IssuedAtMS, ev.HLC.PhysicalMS) || w.InviterAccountID == "" {
			return false, nil
		}
		// SEC parity with the mobile layers (chain.ts removed_entry_replay,
		// role-gate.ts isRemovedMember): a witness must NOT resurrect a
		// REMOVED member. The witness tuple carries no removal epoch, so a
		// leaver/removed member could replay their original (still-fresh)
		// admission witness — with the b3 self-leave arm this became fully
		// self-service: [self-leave, replayed witnessed re-add] in one push
		// batch would re-admit them server-side while every mobile replica
		// refused the resurrect (permanent ACL/chain split + covert ledger
		// access). Only an owner-signed re-add (arm 2a/2b) may lift a
		// removal; a genuine RE-invite creates its membership via the REST
		// AcceptInvite path, which doesn't route through this arm.
		removed, rmerr := isRemovedMemberAccount(ctx, tx, vaultID, p.AccountID)
		if rmerr != nil {
			return false, rmerr
		}
		if removed {
			return false, nil
		}
		tuple := mesh.MemberWitnessTuple(vaultID, p.AccountID, w.InviterAccountID, p.Role, w.IssuedAtMS)
		return s.verifyWitnessSig(tuple, w.SigB64), nil

	case EventVaultDeviceAdded:
		var p deviceAddedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil || p.Witness == nil {
			return false, nil
		}
		w := p.Witness
		if !witnessFresh(w.IssuedAtMS, ev.HLC.PhysicalMS) {
			return false, nil
		}
		// The named device itself must be the event's signer (§2 rule b).
		namedPub, err := base64.StdEncoding.DecodeString(p.DevicePubkey)
		if err != nil || !bytes.Equal(namedPub, signerPub) {
			return false, nil
		}
		// SEC FIX 5: server parity with the mobile fold
		// (chain.ts unknown_member_account refusal). A witnessed
		// vault_device_added binds a device to p.account_id; that account
		// must be a CURRENTLY-ACTIVE member. A device witness alone proves
		// "account A controls device D", NOT that A has a seat — so without
		// this an outsider (or a removed member) holding any device witness
		// could re-bind a device into the vault. FIX 1's HLC-ordered fold
		// guarantees a preceding member_added (lower HLC) is already mirrored
		// into vault_members by the time this verifies.
		active, merr := isActiveMember(ctx, tx, vaultID, p.AccountID)
		if merr != nil {
			return false, merr
		}
		if !active {
			return false, nil
		}
		// Parity with the mobile fold (role-gate.ts isRemovedDevice /
		// chain.ts removed_entry_replay): a witness must NOT resurrect a
		// removed device. A stolen/retired phone keeps its device key and
		// account JWT; re-binding that key needs an owner-signed re-add, not
		// a self-signed witness. Keyed on pubkey like the mobile check.
		removed, drerr := isRemovedDevicePubkey(ctx, tx, vaultID, namedPub)
		if drerr != nil {
			return false, drerr
		}
		if removed {
			return false, nil
		}
		tuple := mesh.DeviceWitnessTuple(vaultID, p.AccountID, p.DeviceID, p.DevicePubkey, w.IssuedAtMS)
		return s.verifyWitnessSig(tuple, w.SigB64), nil
	}

	return false, nil
}

// boundAccountsForPubkey lists the accounts whose vault_devices binding for
// signerPub was live at hlcPMS (removed_at_ms NULL, or removed after the
// event — lawful-at-HLC for offline batches authored before a removal).
func boundAccountsForPubkey(
	ctx context.Context,
	tx pgx.Tx,
	vaultID string,
	signerPub []byte,
	hlcPMS int64,
) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT account_id::text FROM vault_devices
		 WHERE vault_id = $1::uuid
		   AND device_pubkey = $2
		   AND (removed_at_ms IS NULL OR removed_at_ms > $3)
	`, vaultID, signerPub, hlcPMS)
	if err != nil {
		return nil, fmt.Errorf("bound device lookup: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var acct string
		if err := rows.Scan(&acct); err != nil {
			return nil, fmt.Errorf("scan bound device: %w", err)
		}
		out = append(out, acct)
	}
	return out, rows.Err()
}

// isActiveMember reports whether accountID has an active, accepted seat in
// the vault — the server's operational ACL mirror of the chain's
// "currently-active member" predicate (SEC FIX 5). A non-uuid accountID is
// not a member.
func isActiveMember(ctx context.Context, tx pgx.Tx, vaultID, accountID string) (bool, error) {
	if _, err := uuid.Parse(accountID); err != nil {
		return false, nil
	}
	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid
			   AND revoked_at IS NULL AND accepted_at IS NOT NULL
		)
	`, vaultID, accountID).Scan(&active); err != nil {
		return false, fmt.Errorf("active-member lookup: %w", err)
	}
	return active, nil
}

// isRemovedMemberAccount reports whether the account's LATEST membership
// state in this vault is "removed": a revoked vault_members row exists and no
// active one does. The server mirror of the mobile fold's member.removed
// check (chain.ts) — used by the witness arm's no-resurrect rule. An account
// that was never a member (no rows at all) is NOT "removed"; first-time
// witnessed admission stays allowed.
func isRemovedMemberAccount(ctx context.Context, tx pgx.Tx, vaultID, accountID string) (bool, error) {
	if _, err := uuid.Parse(accountID); err != nil {
		return false, nil
	}
	var removed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid
			   AND revoked_at IS NOT NULL
		)
		AND NOT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid
			   AND revoked_at IS NULL
		)
	`, vaultID, accountID).Scan(&removed); err != nil {
		return false, fmt.Errorf("removed-member lookup: %w", err)
	}
	return removed, nil
}

// isRemovedDevicePubkey reports whether any vault_devices binding for this
// pubkey has been removed. Mirrors the mobile role-gate's isRemovedDevice
// (keyed on device_pubkey, not device_id): the witness arm must refuse to
// resurrect the key regardless of which device_id it re-binds under.
// Fail-closed when the key has both a removed and an active binding — a
// witnessed re-add of an already-bound key is pointless anyway.
func isRemovedDevicePubkey(ctx context.Context, tx pgx.Tx, vaultID string, pub []byte) (bool, error) {
	var removed bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM vault_devices
			 WHERE vault_id = $1::uuid AND device_pubkey = $2
			   AND removed_at_ms IS NOT NULL
		)
	`, vaultID, pub).Scan(&removed); err != nil {
		return false, fmt.Errorf("removed-device lookup: %w", err)
	}
	return removed, nil
}

// wouldDropLastOwner reports whether revoking (or demoting) accountID would
// leave the vault with zero active owners — the fold-side twin of the
// last-owner gates in the REST endpoints and the mobile role-gate
// (role-gate.ts wouldDropLastOwner), which refuse the same event on every
// replica. The count query duplicates vaults/service.go countActiveOwners
// (unexported there; importing internal/vaults for it would couple the sync
// fold to the REST service). Like the original, it locks the whole
// active-owner row set FOR UPDATE in id ASC order so concurrent
// removals/demotions — fold or REST — serialize instead of both passing a
// stale count (ENG #6).
func wouldDropLastOwner(ctx context.Context, tx pgx.Tx, vaultID, accountID string) (bool, error) {
	var total, target int
	if err := tx.QueryRow(ctx, `
		WITH locked AS (
			SELECT account_id FROM vault_members
			 WHERE vault_id = $1::uuid AND role = 'owner'
			   AND revoked_at IS NULL AND accepted_at IS NOT NULL
			 ORDER BY id
			 FOR UPDATE
		)
		SELECT COUNT(*), COUNT(*) FILTER (WHERE account_id = $2::uuid) FROM locked
	`, vaultID, accountID).Scan(&total, &target); err != nil {
		return false, fmt.Errorf("count owners: %w", err)
	}
	return target > 0 && total <= 1, nil
}

func witnessFresh(issuedAtMS, hlcPMS int64) bool {
	delta := issuedAtMS - hlcPMS
	if delta < 0 {
		delta = -delta
	}
	return delta <= witnessFreshnessWindowMS
}

// verifyWitnessSig checks sigB64 over the canonical tuple against the
// pinned server pubkey set.
func (s *Service) verifyWitnessSig(tuple map[string]any, sigB64 string) bool {
	if len(s.witnessPubkeys) == 0 {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	canonicalBytes, err := canonical.Canonicalize(tuple)
	if err != nil {
		return false
	}
	for _, pub := range s.witnessPubkeys {
		if len(pub) == ed25519.PublicKeySize && ed25519.Verify(pub, canonicalBytes, sig) {
			return true
		}
	}
	return false
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func isNoRows(err error) bool {
	return err == pgx.ErrNoRows
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

// foldMembershipEvent applies one chain-verified, freshly-inserted
// membership event to the server's operational tables inside the push
// transaction. Returns the account_ids whose membership-cache entries the
// caller must invalidate after commit.
//
// Best-effort by design: payload fields that don't operationalize
// server-side (a member account the server has no accounts row for, an
// invalid role string) skip the fold WITHOUT failing the event — the event
// is already accepted into the log (the server is a replica first; other
// replicas need the chain even when this one can't mirror it into its ACL
// tables).
func (s *Service) foldMembershipEvent(
	ctx context.Context,
	tx pgx.Tx,
	vaultID string,
	pusherAccountID string,
	ev *PushEvent,
) ([]string, error) {
	switch ev.EventType {
	case EventVaultMemberAdded:
		var p memberAddedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return nil, nil
		}
		if !isValidMemberRole(p.Role) {
			return nil, nil
		}
		if _, err := uuid.Parse(p.AccountID); err != nil {
			return nil, nil
		}
		var acctExists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1::uuid)
		`, p.AccountID).Scan(&acctExists); err != nil {
			return nil, fmt.Errorf("fold member_added: account lookup: %w", err)
		}
		if !acctExists {
			return nil, nil
		}
		var invitedBy any
		if p.Witness != nil && p.Witness.InviterAccountID != "" {
			if _, err := uuid.Parse(p.Witness.InviterAccountID); err == nil {
				invitedBy = p.Witness.InviterAccountID
			}
		}
		// The active-uniqueness partial index rules out ON CONFLICT; an
		// existing active row wins (role changes ride
		// vault_member_role_changed). SEC FIX 4: stamp last_change_hlc_ms on
		// insert so subsequent guarded writes can arbitrate by HLC.
		tag, err := tx.Exec(ctx, `
			INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, last_change_hlc_ms)
			SELECT $1::uuid, $2::uuid, $3, NOW(), NOW(), $4::uuid, $5
			WHERE NOT EXISTS (
				SELECT 1 FROM vault_members
				 WHERE vault_id = $1::uuid AND account_id = $2::uuid
				   AND revoked_at IS NULL
			)
		`, vaultID, p.AccountID, p.Role, invitedBy, ev.HLC.PhysicalMS)
		if err != nil {
			return nil, fmt.Errorf("fold member_added: insert: %w", err)
		}
		// SEC FIX 2: feed roleAtHLC. roleAtHLC reconstructs a member's role
		// AT an event's HLC from vault_audit_log, falling back to CURRENT
		// role only when no audit row precedes the HLC. Without a chain-fold
		// audit row, every chain-driven admission degraded to current-role —
		// breaking lawful-at-HLC (invariant #3). We append an
		// 'invite_accepted'-shaped row (the kind roleAtHLC reads as "joined
		// at role R") at occurred_at = the event's HLC physical_ms, so a
		// member admitted by the chain at T has role R for events at HLC >= T
		// and no role before, exactly like the mobile fold.
		//
		// Only when the insert actually created the row: an existing active
		// row keeps its prior admission/role history (role changes ride
		// vault_member_role_changed).
		if tag.RowsAffected() > 0 {
			if err := writeFoldAudit(ctx, tx, vaultID, signerOrAccount(ev, p.AccountID),
				"invite_accepted", p.AccountID, ev.HLC.PhysicalMS,
				map[string]any{"role": p.Role, "source": "membership_chain"}); err != nil {
				return nil, err
			}
		}
		if err := foldBumpEpoch(ctx, tx, vaultID); err != nil {
			return nil, err
		}
		return []string{p.AccountID}, nil

	case EventVaultMemberRoleChng:
		var p memberRoleChangedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return nil, nil
		}
		if !isValidMemberRole(p.Role) {
			return nil, nil
		}
		if _, err := uuid.Parse(p.AccountID); err != nil {
			return nil, nil
		}
		// Last-owner guard: parity with the REST endpoints (ErrLastOwner)
		// and the mobile gate/fold, which all refuse demoting the sole
		// owner. Without it the fold is the one path into an ownerless
		// vault_members — requireOwner then fails for everyone, permanently
		// (two-owner concurrent demotions each verify lawful-at-HLC). Skip
		// the fold only; the event stays in the log (replica-first).
		if p.Role != "owner" {
			drop, derr := wouldDropLastOwner(ctx, tx, vaultID, p.AccountID)
			if derr != nil {
				return nil, fmt.Errorf("fold role_changed: last-owner check: %w", derr)
			}
			if drop {
				log.Printf("sync.fold: skipping role_changed that would drop the last owner (vault=%s account=%s event=%s)",
					vaultID, p.AccountID, ev.EventID)
				return nil, nil
			}
		}
		// SEC FIX 4: HLC arbitration. Apply only when this event is at least
		// as new as the last change that touched the row
		// (last_change_hlc_ms). A stale chain event arriving after a newer
		// change (chain or legacy) is skipped; ties re-apply idempotently
		// (>=). NULL last_change_hlc_ms (pre-M2 / un-stamped rows) is treated
		// as -infinity so the first guarded write always lands.
		tag, err := tx.Exec(ctx, `
			UPDATE vault_members
			   SET role = $3, updated_at = NOW(), last_change_hlc_ms = $4
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid
			   AND revoked_at IS NULL AND accepted_at IS NOT NULL
			   AND (last_change_hlc_ms IS NULL OR $4 >= last_change_hlc_ms)
		`, vaultID, p.AccountID, p.Role, ev.HLC.PhysicalMS)
		if err != nil {
			return nil, fmt.Errorf("fold role_changed: %w", err)
		}
		if tag.RowsAffected() == 0 {
			// Either the account has no active row, or a newer change already
			// won the HLC arbitration. Either way nothing to mirror; the
			// event is still accepted into the log (replica-first).
			return nil, nil
		}
		// SEC FIX 2: record the role transition at the event's HLC so
		// roleAtHLC reconstructs the chain-driven role lawful-at-HLC.
		if err := writeFoldAudit(ctx, tx, vaultID, signerOrAccount(ev, p.AccountID),
			"role_changed", p.AccountID, ev.HLC.PhysicalMS,
			map[string]any{"to": p.Role, "source": "membership_chain"}); err != nil {
			return nil, err
		}
		if err := foldBumpEpoch(ctx, tx, vaultID); err != nil {
			return nil, err
		}
		return []string{p.AccountID}, nil

	case EventVaultMemberRemoved:
		var p memberRemovedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return nil, nil
		}
		if _, err := uuid.Parse(p.AccountID); err != nil {
			return nil, nil
		}
		// Last-owner guard — same rationale as the role_changed arm above:
		// never fold the vault into zero active owners.
		drop, derr := wouldDropLastOwner(ctx, tx, vaultID, p.AccountID)
		if derr != nil {
			return nil, fmt.Errorf("fold member_removed: last-owner check: %w", derr)
		}
		if drop {
			log.Printf("sync.fold: skipping member_removed that would drop the last owner (vault=%s account=%s event=%s)",
				vaultID, p.AccountID, ev.EventID)
			return nil, nil
		}
		// SEC FIX 4: HLC arbitration — a stale removal must not clobber a
		// newer change, nor a newer removal be undone by a stale re-add
		// (re-adds are member_added, separately stamped). Apply only when at
		// least as new as last_change_hlc_ms (>=, NULL = -infinity).
		tag, err := tx.Exec(ctx, `
			UPDATE vault_members
			   SET revoked_at = NOW(), revoked_by = $3::uuid,
			       revoked_reason = 'membership_event', updated_at = NOW(),
			       last_change_hlc_ms = $4
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
			   AND (last_change_hlc_ms IS NULL OR $4 >= last_change_hlc_ms)
		`, vaultID, p.AccountID, pusherAccountID, ev.HLC.PhysicalMS)
		if err != nil {
			return nil, fmt.Errorf("fold member_removed: %w", err)
		}
		if tag.RowsAffected() == 0 {
			// No active row, or a newer change already won. Do NOT touch the
			// devices either — the membership state did not change here.
			return nil, nil
		}
		// §2: removing the account removes all its devices.
		if _, err := tx.Exec(ctx, `
			UPDATE vault_devices SET removed_at_ms = $3
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND removed_at_ms IS NULL
		`, vaultID, p.AccountID, ev.HLC.PhysicalMS); err != nil {
			return nil, fmt.Errorf("fold member_removed: devices: %w", err)
		}
		// SEC FIX 2: record the revocation at the event's HLC so roleAtHLC
		// returns "no role" for events authored AT OR AFTER the removal,
		// while pre-removal events stay lawful (invariant #3).
		if err := writeFoldAudit(ctx, tx, vaultID, signerOrAccount(ev, pusherAccountID),
			"member_revoked", p.AccountID, ev.HLC.PhysicalMS,
			map[string]any{"reason": "membership_event", "source": "membership_chain"}); err != nil {
			return nil, err
		}
		if err := foldBumpEpoch(ctx, tx, vaultID); err != nil {
			return nil, err
		}
		return []string{p.AccountID}, nil

	case EventVaultDeviceAdded:
		var p deviceAddedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return nil, nil
		}
		if _, err := uuid.Parse(p.DeviceID); err != nil {
			return nil, nil
		}
		if _, err := uuid.Parse(p.AccountID); err != nil {
			return nil, nil
		}
		pub, err := base64.StdEncoding.DecodeString(p.DevicePubkey)
		if err != nil || len(pub) != ed25519.PublicKeySize {
			return nil, nil
		}
		// Re-add clears a prior removal: latest-bind-wins BY HLC (SEC FIX 4
		// pattern, mirrored from vault_members). added_at_ms/removed_at_ms
		// hold the folding events' HLC physical_ms (migration 016), so the
		// row's last change is GREATEST of the two; a stale add — older than
		// a folded removal or a newer bind — must not resurrect/clobber it.
		// Ties re-apply idempotently (>=).
		if _, err := tx.Exec(ctx, `
			INSERT INTO vault_devices (vault_id, device_id, device_pubkey, account_id, added_at_ms, removed_at_ms)
			VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, NULL)
			ON CONFLICT (vault_id, device_id) DO UPDATE
			SET device_pubkey = EXCLUDED.device_pubkey,
			    account_id    = EXCLUDED.account_id,
			    added_at_ms   = EXCLUDED.added_at_ms,
			    removed_at_ms = NULL
			WHERE EXCLUDED.added_at_ms >= GREATEST(
				vault_devices.added_at_ms,
				COALESCE(vault_devices.removed_at_ms, vault_devices.added_at_ms))
		`, vaultID, p.DeviceID, pub, p.AccountID, ev.HLC.PhysicalMS); err != nil {
			return nil, fmt.Errorf("fold device_added: %w", err)
		}
		return nil, nil

	case EventVaultDeviceRemoved:
		var p deviceRemovedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return nil, nil
		}
		if _, err := uuid.Parse(p.DeviceID); err != nil {
			return nil, nil
		}
		// Symmetric HLC arbitration: a stale removal (older than the
		// binding's added_at_ms, i.e. a re-bind already won) is skipped.
		if _, err := tx.Exec(ctx, `
			UPDATE vault_devices SET removed_at_ms = $3
			 WHERE vault_id = $1::uuid AND device_id = $2::uuid AND removed_at_ms IS NULL
			   AND $3 >= added_at_ms
		`, vaultID, p.DeviceID, ev.HLC.PhysicalMS); err != nil {
			return nil, fmt.Errorf("fold device_removed: %w", err)
		}
		return nil, nil
	}
	return nil, nil
}

// writeFoldAudit appends a vault_audit_log row from the membership-chain
// fold (SEC FIX 2). Shape mirrors vaults/service.go writeAudit
// (vault_id, actor_id, kind, target_id, payload) but sets occurred_at
// EXPLICITLY to the event's HLC physical time (to_timestamp(ms/1000.0))
// rather than the column default NOW(): roleAtHLC reconstructs role
// lawful-at-HLC by comparing occurred_at to the candidate event's HLC, so a
// chain-driven change at T must be timestamped at T, not at server-receive
// time, or the reconstruction is wrong for offline-queued batches.
//
// FK safety: both actor_id and target_id reference accounts(id) and the
// fold runs best-effort (the server is a replica that may not have an
// accounts row for every chain-named account — migration 016 documents this
// for vault_devices). We NULL an actor that has no accounts row, and SKIP
// the audit row entirely (without failing the event) when the TARGET has no
// accounts row — roleAtHLC keys on target_id, so a row we cannot write is
// simply not reconstructable here, and the event still lands in the log for
// other replicas. This never aborts the batch.
func writeFoldAudit(
	ctx context.Context,
	tx pgx.Tx,
	vaultID string,
	actorAccountID string,
	kind string,
	targetAccountID string,
	occurredAtMS int64,
	payload map[string]any,
) error {
	if _, err := uuid.Parse(targetAccountID); err != nil {
		return nil
	}
	var targetExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1::uuid)
	`, targetAccountID).Scan(&targetExists); err != nil {
		return fmt.Errorf("fold audit: target account lookup: %w", err)
	}
	if !targetExists {
		return nil
	}

	var actor any
	if _, err := uuid.Parse(actorAccountID); err == nil {
		var actorExists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM accounts WHERE id = $1::uuid)
		`, actorAccountID).Scan(&actorExists); err != nil {
			return fmt.Errorf("fold audit: actor account lookup: %w", err)
		}
		if actorExists {
			actor = actorAccountID
		}
	}

	var payloadJSON []byte
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("fold audit: marshal payload: %w", err)
		}
		payloadJSON = b
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO vault_audit_log (vault_id, actor_id, kind, target_id, payload, occurred_at)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb, to_timestamp($6::bigint / 1000.0))
	`, vaultID, actor, kind, targetAccountID, payloadJSON, occurredAtMS); err != nil {
		return fmt.Errorf("fold audit: insert: %w", err)
	}
	return nil
}

// signerOrAccount picks the audit actor for a fold row: the event's stored
// actor_account_id (the device's account, when the wire carried it),
// falling back to the supplied account. writeFoldAudit NULLs it if it turns
// out not to be a real accounts row, so this only needs to produce a
// best-guess UUID string.
func signerOrAccount(ev *PushEvent, fallback string) string {
	if ev.ActorAccountID != nil && *ev.ActorAccountID != "" {
		return *ev.ActorAccountID
	}
	return fallback
}

// foldBumpEpoch mirrors vaults/service.go bumpEpoch — every membership
// mutation bumps vaults.vault_epoch so outstanding VMCs invalidate. The
// push path already holds the vaults-row FOR UPDATE lock.
func foldBumpEpoch(ctx context.Context, tx pgx.Tx, vaultID string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE vaults SET vault_epoch = vault_epoch + 1 WHERE vault_id = $1::uuid
	`, vaultID); err != nil {
		return fmt.Errorf("fold: bump vault_epoch: %w", err)
	}
	return nil
}

func isValidMemberRole(role string) bool {
	switch role {
	case "owner", "manager", "editor", "clerk", "viewer":
		return true
	}
	return false
}

// managerCapSatisfied checks whether a MANAGER-bound signer is allowed to
// author this membership event (roles v2). A manager operates strictly BELOW
// manager rank: for member_added / role_changed, the granted role must rank
// below manager AND the target's lawful-at-HLC current role (if any) must
// rank below manager; for member_removed, the target's current role must
// rank below manager. Anything else — device events, owner/manager targets,
// owner/manager grants — is out of a manager's authority.
func managerCapSatisfied(ctx context.Context, tx pgx.Tx, vaultUUID uuid.UUID, ev *PushEvent) (bool, error) {
	managerRank := roleRank["manager"]
	var targetAccountID, grantedRole string
	rolelessKind := false
	switch ev.EventType {
	case EventVaultMemberAdded:
		var p memberAddedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return false, nil
		}
		targetAccountID, grantedRole = p.AccountID, p.Role
	case EventVaultMemberRoleChng:
		var p memberRoleChangedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return false, nil
		}
		targetAccountID, grantedRole = p.AccountID, p.Role
	case EventVaultMemberRemoved:
		var p memberRemovedWire
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			return false, nil
		}
		targetAccountID = p.AccountID
		rolelessKind = true
	default:
		return false, nil
	}
	// member_added / role_changed MUST carry a valid below-manager role.
	// Review fix: an ABSENT role previously skipped this via a !="" guard,
	// authorizing an event both mobile layers refuse as malformed_payload.
	if !rolelessKind && (!isValidMemberRole(grantedRole) || roleRank[grantedRole] >= managerRank) {
		return false, nil
	}
	// Non-UUID target (a `local:…` pair-admitted chain member): it CANNOT
	// have a vault_members seat (UUID column), so no server-side role can
	// rank >= manager — within the cap by definition. Review fix: hard-
	// refusing here made the server reject events every mobile layer
	// accepts (permanent replica split); chain-protected local: targets are
	// enforced by every replica's fold, which sees their real chain role.
	targetUUID, err := uuid.Parse(targetAccountID)
	if err != nil {
		return targetAccountID != "", nil
	}
	targetRole, found, rerr := roleAtHLC(ctx, tx, targetUUID, vaultUUID, ev.HLC.PhysicalMS)
	if rerr != nil {
		return false, fmt.Errorf("manager cap: target role lookup: %w", rerr)
	}
	if found && roleRank[targetRole] >= managerRank {
		return false, nil
	}
	return true, nil
}
