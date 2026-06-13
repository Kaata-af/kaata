package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CheckEventPermission decides whether an event authored by accountID against
// vaultID is permissible at the event's HLC time. The "lawful-at-HLC" rule
// means we evaluate the author's role *as of* hlcPhysicalMS — not their
// current role — so an 8-hour offline batch authored as editor is still
// accepted even if the author was demoted to viewer five minutes ago.
//
// The reconstruction walks vault_audit_log backwards from hlcPhysicalMS,
// targeting (vault_id, target_id) where target_id = accountID:
//   - role_changed     → payload.to is the role the author held going forward
//   - invite_accepted  → payload.role is the role they joined with
//   - member_revoked   → no role at that time, reject
//   - member_left      → no role at that time, reject
//
// If no audit entries precede hlcPhysicalMS, we fall back to the live
// vault_members row (the member existed since vault creation, no transitions).
//
// account_bound is a special-cased system event: it carries no role
// requirement. The handler is expected to enforce target_id == accountID
// before reaching here. We short-circuit allowed=true.
//
// Phase 4.1: when the EVENT's stored actor_account_id is NULL (the event was
// authored before the device signed in), we look for a covering account_bound
// event and attribute the event to that account for ACL purposes. If no
// binding covers it, we reject. Empty currentRole + storedActorAccountID nil
// signals the caller to mark the rejection as "unauthored_pre_binding"
// instead of "insufficient_role".
//
// The function shares the caller's tx so the role read sees the same snapshot
// as the event insert.
func CheckEventPermission(
	ctx context.Context,
	tx pgx.Tx,
	br *BindingResolver,
	pushingAccountID uuid.UUID,
	vaultID uuid.UUID,
	eventID uuid.UUID,
	eventType string,
	storedActorAccountID *uuid.UUID,
	hlcPhysicalMS int64,
	hlcLogical int64,
	hlcDeviceID uuid.UUID,
) (allowed bool, currentRole string, requiredRole string, err error) {
	if eventType == "account_bound" {
		return true, "", "", nil
	}

	required, ok := requiredRoleFor(eventType)
	if !ok {
		// Unknown event type — reject defensively. Adding a new event type
		// without updating this table is a server bug.
		return false, "", "", fmt.Errorf("unknown event_type %q for permission check", eventType)
	}

	// Phase 4.1: resolve the effective author.
	//   - storedActorAccountID present → use it directly.
	//   - storedActorAccountID NULL → look for an account_bound that covers
	//     this event's HLC; on hit use that account; on miss reject.
	effectiveAuthor := pushingAccountID
	if storedActorAccountID != nil && *storedActorAccountID != uuid.Nil {
		effectiveAuthor = *storedActorAccountID
	} else if br != nil {
		bound, found, lookupErr := br.ResolveTx(
			ctx, tx, vaultID, eventID, hlcPhysicalMS, hlcLogical, hlcDeviceID,
		)
		if lookupErr != nil {
			return false, "", required, fmt.Errorf("binding lookup: %w", lookupErr)
		}
		if !found {
			// No binding covers this event. Empty currentRole signals the
			// caller to render this as "unauthored_pre_binding".
			return false, "", required, nil
		}
		effectiveAuthor = bound
	}

	roleAtHLC, found, err := roleAtHLC(ctx, tx, effectiveAuthor, vaultID, hlcPhysicalMS)
	if err != nil {
		return false, "", required, fmt.Errorf("role lookup: %w", err)
	}
	if !found {
		return false, "", required, nil
	}
	if !roleSatisfies(roleAtHLC, required) {
		return false, roleAtHLC, required, nil
	}
	return true, roleAtHLC, "", nil
}

// CheckEventPermissionByRole is the legacy interface kept for backward
// compat with callers that haven't been updated to the lawful-at-HLC
// signature. It evaluates the matrix using current role only — used by
// PushEvents when an HLC-aware lookup isn't wired up at the call site
// yet.
func CheckEventPermissionByRole(role, eventType string) bool {
	required, ok := requiredRoleFor(eventType)
	if !ok {
		return false
	}
	return roleSatisfies(role, required)
}

// requiredRoleFor maps an event type to the minimum role required to author
// it. Returns ok=false for unknown event types so the caller can defensively
// reject rather than silently accept.
func requiredRoleFor(eventType string) (string, bool) {
	switch eventType {
	// Ledger data mutations — editor.
	case "entry_created",
		"entry_amended",
		"entry_deleted",
		"entry_settled",
		"person_added",
		"person_renamed",
		"person_phone_changed",
		"person_archived",
		"person_unarchived",
		"shop_profile_updated":
		return "editor", true

	// Vault governance — owner.
	//
	// M2: vault_device_added / vault_device_removed are listed here only
	// for the LEGACY fallback path (unsigned events / anchor-less vaults)
	// so an unknown-event-type lookup can't 500 a batch. Signed device
	// events on anchored vaults never reach this matrix — the chain rules
	// in membership.go (which allow witnessed self-admission) decide them.
	case "vault_setting_set",
		"vault_member_added",
		"vault_member_role_changed",
		"vault_member_removed",
		"vault_device_added",
		"vault_device_removed":
		return "owner", true
	}
	return "", false
}

// roleRank is the privilege hierarchy. Hoisted to package scope so
// roleSatisfies doesn't reallocate the map on every PushEvents loop
// iteration (ENG #10).
var roleRank = map[string]int{"viewer": 1, "editor": 2, "owner": 3}

// roleSatisfies returns true if `have` is at least as privileged as `need`.
// Hierarchy: owner > editor > viewer.
func roleSatisfies(have, need string) bool {
	return roleRank[have] >= roleRank[need]
}

// RequiredRoleFor returns the role that WOULD have been required for the
// rejected event, so the client can render a useful error.
func RequiredRoleFor(eventType string) string {
	if r, ok := requiredRoleFor(eventType); ok {
		return r
	}
	return "editor"
}

// roleAtHLC reconstructs accountID's role in vaultID as of hlcPhysicalMS.
//
// Algorithm:
//  1. Find the most recent vault_audit_log entry that affects the caller's
//     role with occurred_at <= to_timestamp(hlcPhysicalMS / 1000). Two
//     query branches:
//     * target_id = accountID for kinds where the affected member is the
//     direct target (role_changed, invite_accepted, member_revoked,
//     member_left);
//     * ownership_transferred rows must be inspected from BOTH sides
//     — the row records target_id = ToAccountID (promoted to owner)
//     and payload.from = AccountID (initiator demoted to
//     payload.demote_self_to). One audit row affects two members.
//  2. Interpret the entry's effect on role.
//  3. If no entry exists, fall back to the current vault_members row — the
//     member's role hasn't changed since they joined (which predates the
//     event).
//
// Returns (role, true, nil) on success, ("", false, nil) if the author had
// no role at that time.
//
// ARCH FIX #14: previously this query only filtered by target_id and the
// four single-target kinds. It missed every transition recorded by
// ownership_transferred, so an old owner who later transferred (and is
// now editor or revoked) would fall back to currentMemberRole for every
// offline-batched event authored when they were genuinely owner —
// silently rejecting their owner-grade events as insufficient_role.
func roleAtHLC(
	ctx context.Context,
	tx pgx.Tx,
	accountID uuid.UUID,
	vaultID uuid.UUID,
	hlcPhysicalMS int64,
) (string, bool, error) {
	const q = `
		SELECT kind, target_id, payload
		  FROM vault_audit_log
		 WHERE vault_id = $1
		   AND occurred_at <= to_timestamp($3::bigint / 1000.0)
		   AND (
		     (target_id = $2 AND kind IN
		        ('role_changed', 'invite_accepted', 'member_revoked', 'member_left'))
		     OR
		     -- ownership_transferred affects both the promoted target ($2)
		     -- AND the initiator whose account id is recorded in
		     -- payload.from = $2::text.
		     (kind = 'ownership_transferred'
		      AND (target_id = $2 OR payload->>'from' = $2::text))
		   )
		 ORDER BY occurred_at DESC, id DESC
		 LIMIT 1
	`
	var kind string
	var targetID *uuid.UUID
	var payloadRaw []byte
	err := tx.QueryRow(ctx, q, vaultID, accountID, hlcPhysicalMS).Scan(&kind, &targetID, &payloadRaw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return currentMemberRole(ctx, tx, accountID, vaultID)
		}
		return "", false, err
	}

	switch kind {
	case "member_revoked", "member_left":
		return "", false, nil

	case "invite_accepted":
		var p struct {
			Role string `json:"role"`
		}
		if err := json.Unmarshal(payloadRaw, &p); err != nil {
			return "", false, fmt.Errorf("decode invite_accepted payload: %w", err)
		}
		if p.Role == "" {
			return "", false, fmt.Errorf("invite_accepted audit entry missing role")
		}
		return p.Role, true, nil

	case "role_changed":
		var p struct {
			To string `json:"to"`
		}
		if err := json.Unmarshal(payloadRaw, &p); err != nil {
			return "", false, fmt.Errorf("decode role_changed payload: %w", err)
		}
		if p.To == "" {
			return "", false, fmt.Errorf("role_changed audit entry missing 'to'")
		}
		return p.To, true, nil

	case "ownership_transferred":
		// payload: { from, to, demote_self_to } where demote_self_to is
		// "editor" or "leave". `to` is recorded as target_id on the audit
		// row, `from` is in the payload.
		var p struct {
			From         string `json:"from"`
			To           string `json:"to"`
			DemoteSelfTo string `json:"demote_self_to"`
		}
		if err := json.Unmarshal(payloadRaw, &p); err != nil {
			return "", false, fmt.Errorf("decode ownership_transferred payload: %w", err)
		}
		// If the caller is the promoted side (target_id), they became owner.
		if targetID != nil && *targetID == accountID {
			return "owner", true, nil
		}
		// Otherwise they're the initiator (payload.from). Their new role
		// is demote_self_to. "leave" terminates their membership at this
		// point, so they have no role going forward.
		if p.From != "" && p.From == accountID.String() {
			switch p.DemoteSelfTo {
			case "editor":
				return "editor", true, nil
			case "leave":
				return "", false, nil
			default:
				return "", false, fmt.Errorf("ownership_transferred audit entry has bad demote_self_to %q", p.DemoteSelfTo)
			}
		}
		// Neither side matches — shouldn't happen given the WHERE clause
		// above, but treat defensively as no-role.
		return "", false, nil
	}

	return "", false, fmt.Errorf("unhandled audit kind %q", kind)
}

// currentMemberRole reads vault_members for accountID/vaultID, treating
// revoked/un-accepted rows as "no role".
func currentMemberRole(
	ctx context.Context,
	tx pgx.Tx,
	accountID uuid.UUID,
	vaultID uuid.UUID,
) (string, bool, error) {
	const q = `
		SELECT role
		  FROM vault_members
		 WHERE vault_id   = $1
		   AND account_id = $2
		   AND revoked_at IS NULL
		   AND accepted_at IS NOT NULL
	`
	var role string
	err := tx.QueryRow(ctx, q, vaultID, accountID).Scan(&role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return role, true, nil
}
