// Package shared stores + serves read-only "shared ledger" snapshots behind a
// short opaque token. The mobile app POSTs a small per-person ledger snapshot
// (POST /v1/shared); the WhatsApp ping links to kaata.af/v/<token>; the web
// client fetches GET /v1/shared/<token> and renders the full list. The backend
// only stores the small packet + serves it — no auth, no ledger compute.
package shared

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned by Get when the token is unknown or expired.
var ErrNotFound = errors.New("shared ledger not found")

// shareTTL is how long a shared link lives. Long enough that a customer can
// open it days later, short enough that the table self-prunes.
const shareTTL = 90 * 24 * time.Hour

// tokenBytes → 12-char URL-safe base64 token (96 bits of entropy). Opaque +
// unguessable so the link can't be enumerated.
const tokenBytes = 9

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// Create stores the snapshot payload (already-validated JSON bytes) and returns
// a fresh short token. Retries on the astronomically-unlikely token collision.
func (s *Service) Create(ctx context.Context, payload []byte) (string, error) {
	for attempt := 0; attempt < 3; attempt++ {
		token, err := newToken()
		if err != nil {
			return "", err
		}
		tag, err := s.pool.Exec(ctx, `
			INSERT INTO shared_ledgers (token, payload, expires_at)
			VALUES ($1, $2::jsonb, NOW() + $3::interval)
			ON CONFLICT (token) DO NOTHING
		`, token, string(payload), shareTTL.String())
		if err != nil {
			return "", fmt.Errorf("insert shared ledger: %w", err)
		}
		if tag.RowsAffected() == 1 {
			return token, nil
		}
		// Collision (token already exists) — retry with a new token.
	}
	return "", errors.New("could not allocate a unique share token")
}

// Get returns the stored payload bytes for a token, or ErrNotFound when the
// token is unknown or has expired.
func (s *Service) Get(ctx context.Context, token string) ([]byte, error) {
	var payload []byte
	err := s.pool.QueryRow(ctx, `
		SELECT payload FROM shared_ledgers
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
	tag, err := s.pool.Exec(ctx, `DELETE FROM shared_ledgers WHERE expires_at < NOW()`)
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
