package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// SharedRecordNotifier refreshes surviving participants after deletion commits.
// The interface keeps auth independent of tabs (which already imports auth).
type SharedRecordNotifier interface {
	NotifyChanged(context.Context, []string)
}

var ErrInstallRetired = errors.New("installation was retired after account deletion")

// A retired installation must be reset to a new UUID before another sign-in.
// Otherwise an offline profile from the deleted account could be uploaded again.
func ensureSignInInstall(ctx context.Context, tx pgx.Tx, installID, accountID string) error {
	var id string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE id = $1::uuid FOR KEY SHARE`, accountID).Scan(&id); err != nil {
		return fmt.Errorf("lock sign-in account: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO installs (install_id, app_version, platform)
		VALUES ($1, 'unknown', 'unknown') ON CONFLICT (install_id) DO NOTHING`, installID); err != nil {
		return fmt.Errorf("ensure sign-in install: %w", err)
	}
	var retired bool
	if err := tx.QueryRow(ctx, `SELECT account_deleted_at IS NOT NULL FROM installs WHERE install_id = $1 FOR UPDATE`, installID).Scan(&retired); err != nil {
		return fmt.Errorf("lock sign-in install: %w", err)
	}
	if retired {
		return ErrInstallRetired
	}
	return nil
}

func (s *Service) SetSharedRecordNotifier(n SharedRecordNotifier) { s.sharedRecords = n }

// DeleteAccount removes the login and private owned ledgers. Shared tallies
// have their own lifecycle: amounts, decisions and recorded attribution survive.
// If deletion leaves a side without an authorized representative, close that
// tally and retire its invitations, without accepting or cancelling any entry.
func (s *Service) DeleteAccount(ctx context.Context, accountID string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin deletion: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// All authenticated tally writes/check-ins lock the actor before their
	// other rows. A request authenticated before deletion must finish first or
	// observe the missing account; it cannot recreate activity after commit.
	var lockedID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE id = $1::uuid FOR UPDATE`, accountID).Scan(&lockedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock deleted account: %w", err)
	}

	// Lock affected tabs in stable order before membership/vault rows change.
	// Include staff membership so a concurrent review sees one complete state.
	rows, err := tx.Query(ctx, `
		SELECT t.id::text FROM tabs t
		WHERE EXISTS (
		  SELECT 1 FROM tab_parties p
		  LEFT JOIN vaults v ON v.vault_id = p.vault_id
		  WHERE p.tab_id = t.id AND (
		    p.account_id = $1::uuid OR v.owner_account_id = $1::uuid OR EXISTS (
		      SELECT 1 FROM vault_members m WHERE m.vault_id = p.vault_id
		      AND m.account_id = $1::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
		    )
		  )
		) ORDER BY t.id FOR UPDATE OF t`, accountID)
	if err != nil {
		return fmt.Errorf("lock shared tallies: %w", err)
	}
	var tabIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("read shared tally: %w", err)
		}
		tabIDs = append(tabIDs, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fmt.Errorf("read shared tallies: %w", err)
	}

	for _, tabID := range tabIDs {
		var abandonedRole string
		err := tx.QueryRow(ctx, `
			SELECT p.role FROM tab_parties p
			LEFT JOIN vaults v ON v.vault_id = p.vault_id
			WHERE p.tab_id = $2::uuid
			  AND (p.account_id = $1::uuid OR v.owner_account_id = $1::uuid OR EXISTS (
			    SELECT 1 FROM vault_members m WHERE m.vault_id = p.vault_id
			    AND m.account_id = $1::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
			  ))
			  AND NOT (
			    (p.account_id IS NOT NULL AND p.account_id <> $1::uuid)
			    OR (v.owner_account_id IS NOT NULL AND v.owner_account_id <> $1::uuid AND EXISTS (
			      SELECT 1 FROM vault_members m WHERE m.vault_id = p.vault_id
			      AND m.account_id IS NOT NULL AND m.account_id <> $1::uuid
			      AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
			      AND m.role IN ('owner','manager','editor')
			    ))
			  ) ORDER BY p.role LIMIT 1`, accountID, tabID).Scan(&abandonedRole)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("check remaining shared participants: %w", err)
		}
		if err == nil {
			if _, err := tx.Exec(ctx, `
				UPDATE tabs SET closed_at = COALESCE(closed_at, NOW()),
				  closed_by = CASE WHEN closed_at IS NULL THEN $2 ELSE closed_by END,
				  closed_reason = CASE WHEN closed_at IS NULL THEN 'account_deleted' ELSE closed_reason END
				WHERE id = $1::uuid`, tabID, abandonedRole); err != nil {
				return fmt.Errorf("close shared tally: %w", err)
			}
			// A never-claimed invitation must not admit a new participant into
			// a relationship whose other side has departed. Stored hashes are
			// replaced with random values whose plaintext is never issued.
			if _, err := tx.Exec(ctx, `UPDATE tab_parties
				SET token_hash = encode(gen_random_bytes(32), 'hex'), account_bound_once = TRUE
				WHERE tab_id = $1::uuid`, tabID); err != nil {
				return fmt.Errorf("retire shared invitations: %w", err)
			}
		}
		// Even a still-open team tally changed party/account metadata. Clients
		// need a new revision to observe the detached account and closure.
		if _, err := tx.Exec(ctx, `UPDATE tabs SET rev = rev + 1 WHERE id = $1::uuid`, tabID); err != nil {
			return fmt.Errorf("advance shared tally revision: %w", err)
		}
	}

	// Legacy credentials can identify an installation whose account_id was
	// never backfilled. Prefer its explicit owner so deleting A cannot retire
	// an installation that has since been switched to B.
	retiredRows, err := tx.Query(ctx, `UPDATE installs i SET account_deleted_at = NOW(), deletion_account_id = $1::uuid
		WHERE i.account_id = $1::uuid OR (i.account_id IS NULL AND EXISTS (
		  SELECT 1 FROM auth_credentials c WHERE c.install_id = i.install_id AND c.account_id = $1::uuid
		) AND NOT EXISTS (
		  SELECT 1 FROM auth_credentials c WHERE c.install_id = i.install_id AND c.account_id <> $1::uuid
	)) RETURNING i.install_id::text`, accountID)
	if err != nil {
		return fmt.Errorf("retire account installations: %w", err)
	}
	retiredIDs, err := pgx.CollectRows(retiredRows, pgx.RowTo[string])
	if err != nil {
		return fmt.Errorf("read retired installations: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM crash_reports WHERE install_id = ANY($1::uuid[])`, retiredIDs); err != nil {
		return fmt.Errorf("delete installation diagnostics: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE installs
		SET account_id = NULL, self_name = NULL, self_phone = NULL, shop_name = NULL
		WHERE install_id = ANY($1::uuid[])`, retiredIDs); err != nil {
		return fmt.Errorf("clear installation identity: %w", err)
	}

	stmts := []struct{ desc, sql string }{
		{"delete owned-vault events", `DELETE FROM events WHERE vault_id IN (SELECT vault_id FROM vaults WHERE owner_account_id = $1::uuid)`},
		{"delete owned vaults", `DELETE FROM vaults WHERE owner_account_id = $1::uuid`},
		// Detaching a live identity is NOT anonymisation: shared payloads and
		// necessary author evidence remain part of the other owner's record.
		{"detach authored events", `UPDATE events SET account_id = NULL WHERE account_id = $1::uuid`},
		{"delete memberships", `DELETE FROM vault_members WHERE account_id = $1::uuid`},
		{"delete device bindings", `DELETE FROM vault_devices WHERE account_id = $1::uuid`},
		{"null invited_by", `UPDATE vault_members SET invited_by = NULL WHERE invited_by = $1::uuid`},
		{"null revoked_by", `UPDATE vault_members SET revoked_by = NULL WHERE revoked_by = $1::uuid`},
		{"null pending_delete_by", `UPDATE vaults SET pending_delete_by = NULL, pending_delete_at = NULL WHERE pending_delete_by = $1::uuid`},
		{"delete account", `DELETE FROM accounts WHERE id = $1::uuid`},
	}
	for _, st := range stmts {
		if _, err := tx.Exec(ctx, st.sql, accountID); err != nil {
			return fmt.Errorf("%s: %w", st.desc, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit account deletion: %w", err)
	}
	if s.sharedRecords != nil {
		s.sharedRecords.NotifyChanged(ctx, tabIDs)
	}
	return nil
}
