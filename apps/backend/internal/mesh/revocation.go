package mesh

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Revocation is one entry in the wire-format revocation list returned to
// peers via /v1/check-in. install_id is the device whose VMC has been
// invalidated; mesh peers refuse handshake with any VMC whose device_id
// appears here.
type Revocation struct {
	VaultID     string `json:"vault_id"`
	DeviceID    string `json:"device_id"` // install_id of the revoked credential
	RevokedAtMS int64  `json:"revoked_at_ms"`
}

// GetRevocationsForVault returns all revocation entries on (vaultID) whose
// revoked_at is STRICTLY GREATER THAN sinceMs. The client passes the
// largest revoked_at_ms it has previously seen; the server returns
// everything newer.
//
// Caller authority: this MUST be gated on the caller being a current
// active member of the vault — leaking revocation timestamps from a vault
// the caller doesn't belong to would be a privacy leak. The check-in
// extension code enforces this before calling.
func (s *Service) GetRevocationsForVault(
	ctx context.Context,
	vaultID string,
	sinceMs int64,
) ([]Revocation, error) {
	if _, err := uuid.Parse(vaultID); err != nil {
		return nil, fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	since := time.UnixMilli(sinceMs)

	rows, err := s.pool.Query(ctx, `
		SELECT install_id::text, revoked_at
		  FROM vault_credentials_issued
		 WHERE vault_id = $1::uuid
		   AND revoked_at IS NOT NULL
		   AND revoked_at > $2
		 ORDER BY revoked_at ASC
	`, vaultID, since)
	if err != nil {
		return nil, fmt.Errorf("query revocations: %w", err)
	}
	defer rows.Close()

	out := make([]Revocation, 0, 8)
	for rows.Next() {
		var (
			installID string
			revokedAt time.Time
		)
		if err := rows.Scan(&installID, &revokedAt); err != nil {
			return nil, fmt.Errorf("scan revocation row: %w", err)
		}
		out = append(out, Revocation{
			VaultID:     vaultID,
			DeviceID:    installID,
			RevokedAtMS: revokedAt.UnixMilli(),
		})
	}
	return out, rows.Err()
}

// ApplyRevocation marks ALL currently-active VMCs for (vaultID, installID)
// as revoked at now(). Used in two paths:
//
//  1. Server-side membership mutations (Leave / SetMemberRole demote /
//     RevokeMember / TransferOwnership). vaults/service.go calls into
//     this via the optional MeshRevoker hook so a role demotion or
//     revocation invalidates ALL the credentials that account currently
//     holds for the vault — preventing a window where the demoted
//     account's mesh peers still believe it has owner privileges.
//  2. Future: explicit "log this device out of mesh" UI on the account
//     screen.
//
// txn is optional. When non-nil, ApplyRevocation participates in the
// caller's transaction (used inside vaults.SetMemberRole). When nil,
// runs against the pool directly.
//
// Returns (rowsAffected, error). rowsAffected == 0 is NOT an error —
// it just means no active credential existed (e.g. the device never
// ran mesh).
func (s *Service) ApplyRevocation(
	ctx context.Context,
	txn pgx.Tx,
	vaultID, installID string,
) (int64, error) {
	if _, err := uuid.Parse(vaultID); err != nil {
		return 0, fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(installID); err != nil {
		return 0, fmt.Errorf("install_id must be a uuid: %w", err)
	}

	const sql = `
		UPDATE vault_credentials_issued
		   SET revoked_at = NOW()
		 WHERE vault_id   = $1::uuid
		   AND install_id = $2::uuid
		   AND revoked_at IS NULL
	`
	if txn != nil {
		tag, err := txn.Exec(ctx, sql, vaultID, installID)
		if err != nil {
			return 0, fmt.Errorf("revoke vmcs (tx): %w", err)
		}
		return tag.RowsAffected(), nil
	}

	tag, err := s.pool.Exec(ctx, sql, vaultID, installID)
	if err != nil {
		return 0, fmt.Errorf("revoke vmcs: %w", err)
	}
	return tag.RowsAffected(), nil
}

// ApplyRevocationForAccount revokes every active credential held by
// `accountID` on `vaultID`, regardless of install_id. Used when a member
// is revoked outright or has their role changed (the per-account ban
// covers every device they own). We can't enumerate the account's
// install_ids any other way — the account_id column on
// vault_credentials_issued is exactly the join we need.
func (s *Service) ApplyRevocationForAccount(
	ctx context.Context,
	txn pgx.Tx,
	vaultID, accountID string,
) (int64, error) {
	if _, err := uuid.Parse(vaultID); err != nil {
		return 0, fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(accountID); err != nil {
		return 0, fmt.Errorf("account_id must be a uuid: %w", err)
	}
	const sql = `
		UPDATE vault_credentials_issued
		   SET revoked_at = NOW()
		 WHERE vault_id   = $1::uuid
		   AND account_id = $2::uuid
		   AND revoked_at IS NULL
	`
	if txn != nil {
		tag, err := txn.Exec(ctx, sql, vaultID, accountID)
		if err != nil {
			return 0, fmt.Errorf("revoke account vmcs (tx): %w", err)
		}
		return tag.RowsAffected(), nil
	}
	tag, err := s.pool.Exec(ctx, sql, vaultID, accountID)
	if err != nil {
		return 0, fmt.Errorf("revoke account vmcs: %w", err)
	}
	return tag.RowsAffected(), nil
}

// IsMember reports whether the caller is a currently active member of
// the vault. Used by the check-in path before disclosing revocation
// entries.
func (s *Service) IsMember(ctx context.Context, vaultID, accountID string) (bool, error) {
	if _, err := uuid.Parse(vaultID); err != nil {
		return false, fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(accountID); err != nil {
		return false, fmt.Errorf("account_id must be a uuid: %w", err)
	}
	var one int
	err := s.pool.QueryRow(ctx, `
		SELECT 1 FROM vault_members
		 WHERE vault_id   = $1::uuid
		   AND account_id = $2::uuid
		   AND revoked_at IS NULL
		   AND accepted_at IS NOT NULL
		 LIMIT 1
	`, vaultID, accountID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check membership: %w", err)
	}
	return true, nil
}
