package auth

import (
	"context"
	"fmt"
)

// AccountDeletionCompleted checks a server-written receipt for this exact
// installation and deleted account. It is only useful after JWT validation;
// knowing an installation UUID alone never grants deletion confirmation.
func (s *Service) AccountDeletionCompleted(ctx context.Context, installID, accountID string) (bool, error) {
	var completed bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM installs
			WHERE install_id = $1::uuid
			  AND account_deleted_at IS NOT NULL
			  AND deletion_account_id = $2::uuid
			  AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = $2::uuid)
		)
	`, installID, accountID).Scan(&completed)
	if err != nil {
		return false, fmt.Errorf("lookup account deletion receipt: %w", err)
	}
	return completed, nil
}
