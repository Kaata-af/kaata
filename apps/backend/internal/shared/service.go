// Package shared stores + serves read-only "shared ledger" snapshots behind a
// short opaque token. The mobile app POSTs a small per-person ledger snapshot
// (POST /v1/shared); the WhatsApp ping links to kaata.af/v/<token>; the web
// client fetches GET /v1/shared/<token> and renders the full list. The backend
// only stores the small packet + serves it — no auth, no ledger compute.
package shared

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned by Get when the token is unknown or expired, and by
// Revoke for unknown/expired/legacy tokens AND wrong secrets — one collapsed
// answer so the endpoint is not a secret-validity oracle.
var ErrNotFound = errors.New("shared ledger not found")

// shareTTL is how long a shared link lives. 30 days (was 90 — the 2026-07-26
// hardening pass): a customer opens a WhatsApp ledger link within hours or
// days, not months, and every extra day is real PII sitting behind a public
// URL. Rows created before the change keep their original expiry and age out.
const shareTTL = 30 * 24 * time.Hour

// tokenBytes → 16-char URL-safe base64 token (96 bits of entropy). Opaque +
// unguessable so the link can't be enumerated. Bumped from 9 bytes (72 bits);
// nothing validates token length — GET is a plain PK lookup on a TEXT column —
// so old shorter tokens keep resolving until their TTL expires.
const tokenBytes = 12

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// Create stores the snapshot payload (already-validated JSON bytes) and
// returns a fresh short token plus the REVOKE SECRET: a second 96-bit random
// string returned only to the creating device, whose SHA-256 lands on the
// row. Presenting it to Revoke below is the proof-of-creator that kills the
// link early. Retries on the astronomically-unlikely token collision.
func (s *Service) Create(ctx context.Context, payload []byte) (token, revokeSecret string, err error) {
	for attempt := 0; attempt < 3; attempt++ {
		token, err = newToken()
		if err != nil {
			return "", "", err
		}
		revokeSecret, err = newToken()
		if err != nil {
			return "", "", err
		}
		secretHash := sha256.Sum256([]byte(revokeSecret))
		tag, err := s.pool.Exec(ctx, `
			INSERT INTO shared_ledger_snapshots (token, payload, expires_at, revoke_secret_hash)
			VALUES ($1, $2::jsonb, NOW() + $3::interval, $4)
			ON CONFLICT (token) DO NOTHING
		`, token, string(payload), shareTTL.String(), secretHash[:])
		if err != nil {
			return "", "", fmt.Errorf("insert shared ledger: %w", err)
		}
		if tag.RowsAffected() == 1 {
			return token, revokeSecret, nil
		}
		// Collision (token already exists) — retry with a new token.
	}
	return "", "", errors.New("could not allocate a unique share token")
}

// Revoke deletes a share early when the caller presents the revoke secret
// minted at create time. Constant-time hash comparison; unknown token,
// expired row, legacy row (NULL hash — predates migration 032), and wrong
// secret all collapse to ErrNotFound so nothing here confirms whether a
// token exists or how close a secret was.
func (s *Service) Revoke(ctx context.Context, token, revokeSecret string) error {
	if token == "" || revokeSecret == "" {
		return ErrNotFound
	}
	var stored []byte
	err := s.pool.QueryRow(ctx, `
		SELECT revoke_secret_hash FROM shared_ledger_snapshots
		WHERE token = $1 AND expires_at > NOW()
	`, token).Scan(&stored)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return ErrNotFound
	case err != nil:
		return fmt.Errorf("load share for revoke: %w", err)
	}
	presented := sha256.Sum256([]byte(revokeSecret))
	if len(stored) != sha256.Size || subtle.ConstantTimeCompare(stored, presented[:]) != 1 {
		return ErrNotFound
	}
	if _, err := s.pool.Exec(ctx, `
		DELETE FROM shared_ledger_snapshots WHERE token = $1
	`, token); err != nil {
		return fmt.Errorf("delete revoked share: %w", err)
	}
	return nil
}

// Get returns the stored payload bytes for a token, or ErrNotFound when the
// token is unknown or has expired.
func (s *Service) Get(ctx context.Context, token string) ([]byte, error) {
	var payload []byte
	err := s.pool.QueryRow(ctx, `
		SELECT payload FROM shared_ledger_snapshots
		WHERE token = $1 AND expires_at > NOW()
	`, token).Scan(&payload)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, ErrNotFound
	case err != nil:
		return nil, fmt.Errorf("get shared ledger: %w", err)
	}
	return payload, nil
}

// PruneExpired deletes expired rows. Best-effort housekeeping; safe to call
// periodically. Returns the number of rows removed.
func (s *Service) PruneExpired(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM shared_ledger_snapshots WHERE expires_at < NOW()`)
	if err != nil {
		return 0, fmt.Errorf("prune shared ledgers: %w", err)
	}
	return tag.RowsAffected(), nil
}

func newToken() (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
