package auth

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

const AccountDeletionGrace = 30 * 24 * time.Hour

var ErrAccountDeletionExpired = errors.New("account deletion recovery window has ended")
var ErrDeletionSessionEnded = errors.New("deleting session was superseded")

type AccountDeletionState struct {
	Status  string     `json:"status"`
	PurgeAt *time.Time `json:"purge_at,omitempty"`
}

// Authenticated profile/password edits must finish before deletion or reject
// its pending state. Proven sign-in/reset uses cancellation instead.
func lockActiveAccountMutation(ctx context.Context, tx pgx.Tx, accountID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM accounts
	 WHERE id=$1::uuid AND pending_delete_at IS NULL FOR UPDATE`, accountID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSessionRevoked
	}
	return err
}

// RequestAccountDeletion revokes access now, but keeps identities, memberships,
// vaults and shared records until the deadline. It never extends an old request.
func (s *Service) RequestAccountDeletion(ctx context.Context, claims *SessionClaims) (AccountDeletionState, error) {
	accountID, installID := claims.AccountID, claims.InstallID
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AccountDeletionState{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var requested *time.Time
	if err := tx.QueryRow(ctx, `SELECT pending_delete_at FROM accounts WHERE id=$1::uuid FOR UPDATE`, accountID).Scan(&requested); err != nil {
		return AccountDeletionState{}, fmt.Errorf("lock deletion request: %w", err)
	}
	if requested == nil {
		var live bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM auth_credentials
		 WHERE install_id=$1::uuid AND provider=$2 AND (account_id=$3::uuid OR (account_id IS NULL AND EXISTS (
		 SELECT 1 FROM installs i WHERE i.install_id=$1::uuid AND i.account_id=$3::uuid)))
		 AND session_epoch=$4 AND revoked_at IS NULL)`, installID, claims.Provider, accountID, claims.Epoch).Scan(&live); err != nil {
			return AccountDeletionState{}, err
		}
		if !live {
			return AccountDeletionState{}, ErrDeletionSessionEnded
		}
		if err := tx.QueryRow(ctx, `UPDATE accounts SET pending_delete_at=NOW(), delete_requested_from_install=$2::uuid
		 WHERE id=$1::uuid RETURNING pending_delete_at`, accountID, installID).Scan(&requested); err != nil {
			return AccountDeletionState{}, err
		}
		// Existing archives can reach their separate purge deadline during this
		// recovery window. Preserve still-saved owned archives until this request's
		// deadline, even after recovery, without changing their archived_at value.
		if _, err := tx.Exec(ctx, `UPDATE vaults SET archive_purge_not_before=
		 GREATEST(archive_purge_not_before,$2::timestamptz+INTERVAL '720 hours')
		 WHERE owner_account_id=$1::uuid AND archived_at IS NOT NULL AND purged_at IS NULL`, accountID, requested); err != nil {
			return AccountDeletionState{}, err
		}
		// Prefer the current explicit owner when a phone has changed accounts.
		if _, err := tx.Exec(ctx, `UPDATE installs i SET account_deleted_at=NOW(), deletion_account_id=$1::uuid
		 WHERE i.account_id=$1::uuid OR (i.account_id IS NULL AND EXISTS (
		   SELECT 1 FROM auth_credentials c WHERE c.install_id=i.install_id AND c.account_id=$1::uuid
		 ) AND NOT EXISTS (SELECT 1 FROM auth_credentials c WHERE c.install_id=i.install_id AND c.account_id<>$1::uuid))`, accountID); err != nil {
			return AccountDeletionState{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE auth_credentials c SET revoked_at=NOW(), session_epoch=session_epoch+1
		 WHERE c.account_id=$1::uuid OR (c.account_id IS NULL AND EXISTS (
		   SELECT 1 FROM installs i WHERE i.install_id=c.install_id
		   AND (i.account_id=$1::uuid OR i.deletion_account_id=$1::uuid)
		 ))`, accountID); err != nil {
			return AccountDeletionState{}, err
		}
		// Account-bound codes issued before deletion must not finish credential setup.
		if _, err := tx.Exec(ctx, `DELETE FROM email_codes WHERE account_id=$1::uuid`, accountID); err != nil {
			return AccountDeletionState{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return AccountDeletionState{}, err
	}
	deadline := requested.Add(AccountDeletionGrace)
	return AccountDeletionState{Status: "deletion_scheduled", PurgeAt: &deadline}, nil
}

// Called only after a provider token/password/code has proven this account,
// inside completeSignIn's account-first transaction. Rollback also cancels the
// recovery if another-account confirmation or any later sign-in step fails.
func cancelPendingAccountDeletion(ctx context.Context, tx pgx.Tx, accountID string) (bool, error) {
	var pending *time.Time
	var recoverable bool
	if err := tx.QueryRow(ctx, `SELECT pending_delete_at,
	  pending_delete_at IS NULL OR pending_delete_at > NOW()-INTERVAL '720 hours'
	  FROM accounts WHERE id=$1::uuid FOR UPDATE`, accountID).Scan(&pending, &recoverable); err != nil {
		return false, err
	}
	if pending == nil {
		return false, nil
	}
	if !recoverable {
		return false, ErrAccountDeletionExpired
	}
	if _, err := tx.Exec(ctx, `UPDATE accounts SET pending_delete_at=NULL, delete_requested_from_install=NULL WHERE id=$1::uuid`, accountID); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE installs SET account_deleted_at=NULL, deletion_account_id=NULL WHERE deletion_account_id=$1::uuid`, accountID); err != nil {
		return false, err
	}
	// Other phones' old sessions stay revoked. Their next proved sign-in gets a
	// fresh epoch; cancelling deletion must never resurrect a stolen token.
	return true, nil
}

func (s *Service) RunAccountPurgeTick(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT id::text FROM accounts
	 WHERE pending_delete_at <= NOW()-INTERVAL '720 hours' ORDER BY pending_delete_at LIMIT 50`)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	var first error
	for _, id := range ids {
		if err := s.hardDeleteAccount(ctx, id, true); err != nil {
			if first == nil {
				first = err
			}
			log.Printf("account-purge failed: %v", err)
		}
	}
	return first
}

func (s *Service) StartAccountPurgeCron(ctx context.Context, interval time.Duration) {
	tick := func() {
		if err := s.RunAccountPurgeTick(ctx); err != nil {
			log.Printf("account-purge: %v", err)
		}
	}
	tick()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}
