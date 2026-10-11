package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// AccountDeletionCompleted checks a server-written receipt for this exact
// installation and deleted account. It is only useful after JWT validation;
// knowing an installation UUID alone never grants deletion confirmation.
func (s *Service) AccountDeletionCompleted(ctx context.Context, installID, accountID string) (bool, error) {
	state, err := s.DeletionState(ctx, installID, accountID)
	return state.Status != "", err
}

func (s *Service) DeletionState(ctx context.Context, installID, accountID string) (AccountDeletionState, error) {
	var state AccountDeletionState
	err := s.pool.QueryRow(ctx, `SELECT CASE WHEN a.id IS NULL THEN 'deleted'
	 WHEN a.pending_delete_at IS NOT NULL THEN 'deletion_scheduled' ELSE '' END,
	 a.pending_delete_at+INTERVAL '720 hours'
	 FROM installs i LEFT JOIN accounts a ON a.id=$2::uuid
	 WHERE i.install_id=$1::uuid AND i.account_deleted_at IS NOT NULL
	 AND i.deletion_account_id=$2::uuid`, installID, accountID).Scan(&state.Status, &state.PurgeAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountDeletionState{}, nil
	}
	if err != nil {
		return AccountDeletionState{}, fmt.Errorf("lookup account deletion receipt: %w", err)
	}
	return state, nil
}
