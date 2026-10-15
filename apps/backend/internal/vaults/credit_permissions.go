package vaults

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/credit"
)

var (
	ErrInvalidCreditOverride     = errors.New("invalid credit limit override")
	ErrCreditPermissionProtected = errors.New("owners and admins are always exempt from credit limits")
	ErrCreditMemberEnrollment    = errors.New("member must sign in and sync before credit enforcement")
)

// MemberCreditPermission is online configuration, never a membership grant.
// Owners and managers remain exempt regardless of any saved override.
type MemberCreditPermission struct {
	AccountID           string `json:"account_id"`
	CreditLimitOverride string `json:"credit_limit_override"`
	UpdatedAtMS         int64  `json:"updated_at_ms"`
}

func validCreditOverride(value string) bool {
	return value == "inherit" || value == "enforce" || value == "bypass"
}

// ListMemberCreditPermissions returns all current accepted members. Missing
// exceptions explicitly inherit; this lets phones replace an obsolete cache.
func (s *Service) ListMemberCreditPermissions(ctx context.Context, vaultID, callerID string) ([]MemberCreditPermission, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin credit permissions: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveAccounts(ctx, tx, callerID); err != nil {
		return nil, err
	}
	// Keep account -> credit -> vault -> member lock order, shared by saves
	// and financial admission. The vault lock also serializes membership edits.
	if err := credit.Lock(ctx, tx, vaultID); err != nil {
		return nil, err
	}
	role, err := activeMemberRoleLocked(ctx, tx, vaultID, callerID)
	if err != nil {
		return nil, err
	}
	if err := creditPermissionVaultAvailable(ctx, tx, vaultID, callerID, role); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT m.account_id::text,
	 COALESCE(p.credit_limit_override,'inherit'), COALESCE(p.updated_at_ms,0)
	 FROM vault_members m JOIN accounts a ON a.id=m.account_id
	 LEFT JOIN vault_member_credit_permissions p ON p.vault_id=m.vault_id
	  AND p.account_id=m.account_id AND p.vault_member_id=m.id
	 WHERE m.vault_id=$1::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
	  AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
	 ORDER BY m.account_id`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("list credit permissions: %w", err)
	}
	defer rows.Close()
	out := make([]MemberCreditPermission, 0)
	for rows.Next() {
		var p MemberCreditPermission
		if err := rows.Scan(&p.AccountID, &p.CreditLimitOverride, &p.UpdatedAtMS); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// SetMemberCreditPermission can change only an active member below admin.
// It rechecks both parties after acquiring the same lock as money admission.
func (s *Service) SetMemberCreditPermission(ctx context.Context, vaultID, callerID, targetID, override string) (MemberCreditPermission, error) {
	if !validCreditOverride(override) {
		return MemberCreditPermission{}, ErrInvalidCreditOverride
	}
	if strings.HasPrefix(targetID, "local:") && override == "enforce" {
		return MemberCreditPermission{}, ErrCreditMemberEnrollment
	}
	if _, err := uuid.Parse(targetID); err != nil {
		return MemberCreditPermission{}, ErrTargetNotMember
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MemberCreditPermission{}, fmt.Errorf("begin credit permission save: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveAccounts(ctx, tx, callerID, targetID); err != nil {
		return MemberCreditPermission{}, err
	}
	if err := credit.Lock(ctx, tx, vaultID); err != nil {
		return MemberCreditPermission{}, err
	}
	callerRole, err := requireOwnerOrManager(ctx, tx, vaultID, callerID)
	if err != nil {
		return MemberCreditPermission{}, err
	}
	if err := creditPermissionVaultAvailable(ctx, tx, vaultID, callerID, callerRole); err != nil {
		return MemberCreditPermission{}, err
	}
	var memberID int64
	var targetRole string
	err = tx.QueryRow(ctx, `SELECT m.id,m.role FROM vault_members m JOIN accounts a ON a.id=m.account_id
	 WHERE m.vault_id=$1::uuid AND m.account_id=$2::uuid AND m.accepted_at IS NOT NULL
	  AND m.revoked_at IS NULL AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL FOR UPDATE OF m`, vaultID, targetID).Scan(&memberID, &targetRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return MemberCreditPermission{}, ErrTargetNotMember
	}
	if err != nil {
		return MemberCreditPermission{}, fmt.Errorf("read credit permission target: %w", err)
	}
	if targetID == callerID || vaultRoleRank[targetRole] >= vaultRoleRank["manager"] {
		return MemberCreditPermission{}, ErrCreditPermissionProtected
	}
	old := MemberCreditPermission{AccountID: targetID, CreditLimitOverride: "inherit"}
	err = tx.QueryRow(ctx, `SELECT credit_limit_override,updated_at_ms FROM vault_member_credit_permissions
	 WHERE vault_id=$1::uuid AND account_id=$2::uuid AND vault_member_id=$3`, vaultID, targetID, memberID).Scan(&old.CreditLimitOverride, &old.UpdatedAtMS)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return MemberCreditPermission{}, err
	}
	if old.CreditLimitOverride == override {
		if err := tx.Commit(ctx); err != nil {
			return MemberCreditPermission{}, err
		}
		return old, nil
	}
	saved := MemberCreditPermission{AccountID: targetID, CreditLimitOverride: override, UpdatedAtMS: nowMS()}
	if saved.UpdatedAtMS <= old.UpdatedAtMS {
		saved.UpdatedAtMS = old.UpdatedAtMS + 1
	}
	_, err = tx.Exec(ctx, `INSERT INTO vault_member_credit_permissions
	 (vault_id,account_id,vault_member_id,credit_limit_override,updated_at_ms) VALUES($1::uuid,$2::uuid,$3,$4,$5)
	 ON CONFLICT(vault_id,account_id) DO UPDATE SET vault_member_id=EXCLUDED.vault_member_id,
	 credit_limit_override=EXCLUDED.credit_limit_override,updated_at_ms=EXCLUDED.updated_at_ms`, vaultID, targetID, memberID, override, saved.UpdatedAtMS)
	if err != nil {
		return MemberCreditPermission{}, fmt.Errorf("save credit permission: %w", err)
	}
	if _, err := writeAudit(ctx, tx, vaultID, &callerID, "credit_permission_changed", &targetID,
		map[string]any{"from": old.CreditLimitOverride, "to": override}); err != nil {
		return MemberCreditPermission{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MemberCreditPermission{}, err
	}
	// main wires the sync service as the membership invalidator; it also
	// provides live pokes so cached exceptions refresh after online changes.
	if notifier, ok := s.invalidator.(interface{ NotifyLive(string) }); ok {
		notifier.NotifyLive(vaultID)
	}
	return saved, nil
}

func creditPermissionVaultAvailable(ctx context.Context, tx pgx.Tx, vaultID, callerID, role string) error {
	var available bool
	if err := tx.QueryRow(ctx, `SELECT (v.archived_at IS NULL OR $3='owner')
	 AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
	 FROM vaults v JOIN accounts a ON a.id=$2::uuid WHERE v.vault_id=$1::uuid`, vaultID, callerID, role).Scan(&available); err != nil {
		return err
	}
	if !available {
		return ErrNotMember
	}
	return nil
}
