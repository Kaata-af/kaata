// Package rolepolicy checks restrictions on a member's preset permissions.
// It never grants membership or replaces the caller's existing authority check.
package rolepolicy

import (
	"context"
	"sort"

	"github.com/jackc/pgx/v5"
)

const (
	EntryCreate     = "entry.create"
	EntryAmend      = "entry.amend"
	EntryDelete     = "entry.delete"
	PersonAdd       = "person.add"
	PersonEdit      = "person.edit"
	GroupManage     = "group.manage"
	TallyNoteAdd    = "tally_note.add"
	TallyNoteRemove = "tally_note.remove"
	VaultSettings   = "vault.settings"
	VaultMembers    = "vault.members"
)

var minRank = map[string]int{
	TallyNoteAdd: 1,
	EntryCreate:  2, PersonAdd: 2,
	EntryAmend: 3, EntryDelete: 3, PersonEdit: 3, GroupManage: 3,
	TallyNoteRemove: 4, VaultSettings: 4, VaultMembers: 4,
}

// Normalize checks that a definition only removes permissions from its preset
// and returns a stable order for API responses and audit comparisons.
func Normalize(base string, permissions []string) ([]string, bool) {
	rank := map[string]int{"viewer": 1, "clerk": 2, "editor": 3, "manager": 4}[base]
	if rank == 0 || len(permissions) > len(minRank) {
		return nil, false
	}
	result := make([]string, 0, len(permissions))
	seen := make(map[string]bool, len(permissions))
	for _, permission := range permissions {
		need := minRank[permission]
		if need == 0 || need > rank || seen[permission] {
			return nil, false
		}
		seen[permission] = true
		result = append(result, permission)
	}
	sort.Strings(result)
	return result, true
}

type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Allows checks the current seat assignment. Unassigned members retain their
// preset permissions. Call inside the same lock/transaction as the mutation.
func Allows(ctx context.Context, q Querier, vaultID, accountID, permission string) (bool, error) {
	var allowed bool
	err := q.QueryRow(ctx, `SELECT NOT EXISTS (
	 SELECT 1 FROM vault_members m JOIN vault_custom_roles r ON r.id=m.custom_role_id
	 WHERE m.vault_id=$1::uuid AND m.account_id=$2::uuid AND m.revoked_at IS NULL
	   AND m.accepted_at IS NOT NULL AND NOT COALESCE($3=ANY(r.permissions),FALSE)
	)`, vaultID, accountID, permission).Scan(&allowed)
	return allowed, err
}

// Assigned seats are owner-managed. An admin cannot remove a restriction by
// changing the target's preset or removing and re-inviting the target.
func HasAssignment(ctx context.Context, q Querier, vaultID, accountID string) (bool, error) {
	var assigned bool
	err := q.QueryRow(ctx, `SELECT EXISTS (
	 SELECT 1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid
	 AND custom_role_id IS NOT NULL
	)`, vaultID, accountID).Scan(&assigned)
	return assigned, err
}
