// Package shared stores + serves read-only "bill" snapshots behind a short
// opaque token. The mobile app POSTs a small per-person ledger snapshot
// (POST /v1/shared); the WhatsApp ping links to kaata.af/v/<token>; the web
// client fetches GET /v1/shared/<token> and renders the full list. The backend
// only stores the small packet + serves it — no auth, no ledger compute.
//
// PAPER RULE (2026-08-07, deliberate product decision): a bill is the
// RECIPIENT'S asset, exactly like a paper bill handed across the counter —
// permanent, frozen, and unrevocable. There is no TTL, no prune sweep, and no
// revoke endpoint (all three existed until this date; the 2026-07-26
// revocation hardening was deliberately reversed). The immutable chain of
// bills in a WhatsApp thread is the customer's tamper-evidence: a new bill
// can be compared against the old ones precisely because old ones can never
// be altered or withdrawn.
package shared

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned by Get when the token is unknown.
var ErrNotFound = errors.New("shared ledger not found")

// tokenBytes → 16-char URL-safe base64 token (96 bits of entropy). Opaque +
// unguessable so the link can't be enumerated. Bumped from 9 bytes (72 bits);
// nothing validates token length — GET is a plain PK lookup on a TEXT column —
// so old shorter tokens keep resolving.
const tokenBytes = 12

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// Create stores the snapshot payload (already-validated JSON bytes) and
// returns a fresh short token. Retries on the astronomically-unlikely token
// collision.
func (s *Service) Create(ctx context.Context, payload []byte) (token string, err error) {
	for attempt := 0; attempt < 3; attempt++ {
		token, err = newToken()
		if err != nil {
			return "", err
		}
		tag, err := s.pool.Exec(ctx, `
			INSERT INTO shared_ledger_snapshots (token, payload)
			VALUES ($1, $2::jsonb)
			ON CONFLICT (token) DO NOTHING
		`, token, string(payload))
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
// token is unknown.
func (s *Service) Get(ctx context.Context, token string) ([]byte, error) {
	var payload []byte
	err := s.pool.QueryRow(ctx, `
		SELECT payload FROM shared_ledger_snapshots
		WHERE token = $1
	`, token).Scan(&payload)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, ErrNotFound
	case err != nil:
		return nil, fmt.Errorf("get shared ledger: %w", err)
	}
	return payload, nil
}

func newToken() (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
