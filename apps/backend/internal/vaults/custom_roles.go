package vaults

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/connectionnotice"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/rolepolicy"
)

var (
	errInvalidCustomRole      = errors.New("invalid custom role definition")
	errCustomRoleNameTaken    = errors.New("a custom role already uses this name")
	errCustomRoleLimit        = errors.New("too many custom roles in this Kaata")
	errCustomRoleInUse        = errors.New("unassign this role from members before deleting it")
	errCustomRoleBaseMismatch = errors.New("custom role must use the member's current preset")
)

type CustomRole struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	BaseRole    string   `json:"base_role"`
	Permissions []string `json:"permissions"`
}

type CustomRoleAssignment struct {
	AccountID string `json:"account_id"`
	RoleID    string `json:"role_id"`
}

type CustomRoles struct {
	Roles         []CustomRole           `json:"roles"`
	Assignments   []CustomRoleAssignment `json:"assignments"`
	EffectiveRole *CustomRole            `json:"effective_role"`
}

// The vault lock serializes settings/assignments with membership and sync.
func (s *Service) beginCustomRoles(ctx context.Context, vaultID, callerID string, ownerOnly bool, accountIDs ...string) (pgx.Tx, string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	if err := lockActiveAccounts(ctx, tx, callerID, accountIDs...); err != nil {
		_ = tx.Rollback(ctx)
		return nil, "", err
	}
	if ownerOnly {
		if err := credit.Lock(ctx, tx, vaultID); err != nil {
			_ = tx.Rollback(ctx)
			return nil, "", err
		}
	}
	role, err := activeMemberRoleLocked(ctx, tx, vaultID, callerID)
	if err == nil && ownerOnly && role != "owner" {
		err = ErrNotOwner
	}
	if err == nil {
		err = creditPermissionVaultAvailable(ctx, tx, vaultID, callerID, role)
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, "", err
	}
	return tx, role, nil
}

func (s *Service) ListCustomRoles(ctx context.Context, vaultID, callerID string) (CustomRoles, error) {
	result := CustomRoles{Roles: []CustomRole{}, Assignments: []CustomRoleAssignment{}}
	tx, role, err := s.beginCustomRoles(ctx, vaultID, callerID, false)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if role == "owner" {
		result.Roles, err = listCustomRoleDefinitions(ctx, tx, vaultID)
		if err != nil {
			return result, err
		}
		result.Assignments, err = listCustomRoleAssignments(ctx, tx, vaultID)
		if err != nil {
			return result, err
		}
	} else {
		var effective CustomRole
		err = tx.QueryRow(ctx, `SELECT r.id::text,r.name,r.base_role,r.permissions
		 FROM vault_members m JOIN vault_custom_roles r ON r.id=m.custom_role_id
		 WHERE m.vault_id=$1::uuid AND m.account_id=$2::uuid
		 AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL`, vaultID, callerID).Scan(
			&effective.ID, &effective.Name, &effective.BaseRole, &effective.Permissions)
		if err == nil {
			result.EffectiveRole = &effective
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return result, err
		}
	}
	return result, tx.Commit(ctx)
}

func listCustomRoleDefinitions(ctx context.Context, tx pgx.Tx, vaultID string) ([]CustomRole, error) {
	rows, err := tx.Query(ctx, `SELECT id::text,name,base_role,permissions
	 FROM vault_custom_roles WHERE vault_id=$1::uuid ORDER BY lower(name),id`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []CustomRole{}
	for rows.Next() {
		var role CustomRole
		if err := rows.Scan(&role.ID, &role.Name, &role.BaseRole, &role.Permissions); err != nil {
			return nil, err
		}
		result = append(result, role)
	}
	return result, rows.Err()
}

func listCustomRoleAssignments(ctx context.Context, tx pgx.Tx, vaultID string) ([]CustomRoleAssignment, error) {
	rows, err := tx.Query(ctx, `SELECT account_id::text,custom_role_id::text
	 FROM vault_members WHERE vault_id=$1::uuid AND custom_role_id IS NOT NULL ORDER BY account_id`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []CustomRoleAssignment{}
	for rows.Next() {
		var assignment CustomRoleAssignment
		if err := rows.Scan(&assignment.AccountID, &assignment.RoleID); err != nil {
			return nil, err
		}
		result = append(result, assignment)
	}
	return result, rows.Err()
}

func (s *Service) SaveCustomRole(ctx context.Context, vaultID, callerID string, role CustomRole) (CustomRole, error) {
	role.Name = strings.TrimSpace(role.Name)
	permissions, valid := rolepolicy.Normalize(role.BaseRole, role.Permissions)
	if !valid || !utf8.ValidString(role.Name) || utf8.RuneCountInString(role.Name) > 40 || role.Name == "" ||
		strings.ContainsFunc(role.Name, func(r rune) bool {
			return unicode.IsControl(r) || r >= '\u202a' && r <= '\u202e' || r >= '\u2066' && r <= '\u2069'
		}) {
		return CustomRole{}, errInvalidCustomRole
	}
	role.Permissions = permissions
	var recipients []string
	if role.ID != "" {
		rows, err := s.pool.Query(ctx, `SELECT DISTINCT account_id::text FROM vault_members WHERE vault_id=$1::uuid
 AND custom_role_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL`, vaultID, role.ID)
		if err != nil {
			return CustomRole{}, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return CustomRole{}, err
			}
			recipients = append(recipients, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return CustomRole{}, err
		}
	}
	tx, _, err := s.beginCustomRoles(ctx, vaultID, callerID, true, recipients...)
	if err != nil {
		return CustomRole{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	creating := role.ID == ""
	if creating {
		role.ID = uuid.NewString()
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM vault_custom_roles WHERE vault_id=$1::uuid`, vaultID).Scan(&count); err != nil {
			return CustomRole{}, err
		}
		if count >= 32 {
			return CustomRole{}, errCustomRoleLimit
		}
	} else {
		var oldBase, oldName string
		var oldPermissions []string
		err := tx.QueryRow(ctx, `SELECT base_role,name,permissions FROM vault_custom_roles WHERE vault_id=$1::uuid AND id=$2::uuid`, vaultID, role.ID).Scan(&oldBase, &oldName, &oldPermissions)
		if errors.Is(err, pgx.ErrNoRows) {
			return CustomRole{}, ErrNotFound
		}
		if err != nil {
			return CustomRole{}, err
		}
		if oldBase != role.BaseRole {
			return CustomRole{}, errCustomRoleBaseMismatch
		}
		if oldName == role.Name && slices.Equal(oldPermissions, role.Permissions) {
			return role, tx.Commit(ctx)
		}
	}
	var nameTaken bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vault_custom_roles
	 WHERE vault_id=$1::uuid AND lower(name)=lower($2) AND id<>$3::uuid)`, vaultID, role.Name, role.ID).Scan(&nameTaken); err != nil {
		return CustomRole{}, err
	}
	if nameTaken {
		return CustomRole{}, errCustomRoleNameTaken
	}
	if creating {
		_, err = tx.Exec(ctx, `INSERT INTO vault_custom_roles(id,vault_id,name,base_role,permissions)
		 VALUES($1::uuid,$2::uuid,$3,$4,$5)`, role.ID, vaultID, role.Name, role.BaseRole, role.Permissions)
	} else {
		_, err = tx.Exec(ctx, `UPDATE vault_custom_roles SET name=$3,permissions=$4
		 WHERE id=$1::uuid AND vault_id=$2::uuid`, role.ID, vaultID, role.Name, role.Permissions)
	}
	if err != nil {
		return CustomRole{}, fmt.Errorf("save custom role: %w", err)
	}
	auditID, err := writeAudit(ctx, tx, vaultID, &callerID, "custom_role_saved", nil, map[string]any{
		"role_id": role.ID, "name": role.Name, "base_role": role.BaseRole, "permissions": role.Permissions,
	})
	if err != nil {
		return CustomRole{}, err
	}
	for _, recipient := range recipients {
		var assigned bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid
 AND custom_role_id=$3::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL)`, vaultID, recipient, role.ID).Scan(&assigned); err != nil {
			return CustomRole{}, err
		}
		if assigned {
			if err := connectionnotice.Add(ctx, tx, connectionnotice.Notice{Kind: "vault_member_role_changed", SourceID: connectionnotice.AuditSource(auditID), RecipientID: recipient, ActorID: callerID, VaultID: vaultID, Detail: role.BaseRole}); err != nil {
				return CustomRole{}, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return CustomRole{}, err
	}
	s.notifyCustomRoleChange(vaultID)
	return role, nil
}

func (s *Service) DeleteCustomRole(ctx context.Context, vaultID, callerID, roleID string) error {
	tx, _, err := s.beginCustomRoles(ctx, vaultID, callerID, true)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var assigned bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vault_members
	 WHERE vault_id=$1::uuid AND custom_role_id=$2::uuid)`, vaultID, roleID).Scan(&assigned); err != nil {
		return err
	}
	if assigned {
		return errCustomRoleInUse
	}
	deleted, err := tx.Exec(ctx, `DELETE FROM vault_custom_roles WHERE vault_id=$1::uuid AND id=$2::uuid`, vaultID, roleID)
	if err != nil {
		return err
	}
	if deleted.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err := writeAudit(ctx, tx, vaultID, &callerID, "custom_role_deleted", nil, map[string]any{"role_id": roleID}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyCustomRoleChange(vaultID)
	return nil
}

func (s *Service) AssignCustomRole(ctx context.Context, vaultID, callerID, targetID string, roleID *string) error {
	tx, _, err := s.beginCustomRoles(ctx, vaultID, callerID, true, targetID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var memberID int64
	var preset string
	var old *string
	err = tx.QueryRow(ctx, `SELECT m.id,m.role,m.custom_role_id::text FROM vault_members m
	 JOIN accounts a ON a.id=m.account_id
	 WHERE m.vault_id=$1::uuid AND m.account_id=$2::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
	 AND ($3::boolean OR (a.disabled_at IS NULL AND a.pending_delete_at IS NULL))
	 FOR UPDATE OF m`, vaultID, targetID, roleID == nil).Scan(&memberID, &preset, &old)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTargetNotMember
	}
	if err != nil {
		return err
	}
	if preset == "owner" {
		return errCustomRoleBaseMismatch
	}
	if roleID != nil {
		var base string
		err = tx.QueryRow(ctx, `SELECT base_role FROM vault_custom_roles WHERE vault_id=$1::uuid AND id=$2::uuid`, vaultID, *roleID).Scan(&base)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if base != preset {
			return errCustomRoleBaseMismatch
		}
	}
	if (old == nil && roleID == nil) || (old != nil && roleID != nil && *old == *roleID) {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE vault_members SET custom_role_id=$2::uuid WHERE id=$1`, memberID, roleID); err != nil {
		return err
	}
	auditID, err := writeAudit(ctx, tx, vaultID, &callerID, "custom_role_assigned", &targetID, map[string]any{
		"from_role_id": old, "role_id": roleID,
	})
	if err != nil {
		return err
	}
	if err := connectionnotice.Add(ctx, tx, connectionnotice.Notice{Kind: "vault_member_role_changed", SourceID: connectionnotice.AuditSource(auditID), RecipientID: targetID, ActorID: callerID, VaultID: vaultID, Detail: preset}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyCustomRoleChange(vaultID)
	return nil
}

func (s *Service) notifyCustomRoleChange(vaultID string) {
	if notifier, ok := s.invalidator.(interface{ NotifyLive(string) }); ok {
		notifier.NotifyLive(vaultID)
	}
}
