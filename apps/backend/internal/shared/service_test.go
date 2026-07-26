package shared

import (
	"context"
	"errors"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

// Revocable shares (2026-07-26 hardening): the create-time secret — and only
// it — kills a link early; every failure mode collapses to ErrNotFound so
// the endpoint can't be used as a token/secret oracle.
func TestSharedCreateGetRevoke(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	payload := []byte(`{"v":1,"person":"Ahmad","balance":1200,"entries":[]}`)
	token, secret, err := svc.Create(ctx, payload)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if token == "" || secret == "" || token == secret {
		t.Fatalf("Create returned token=%q secret=%q, want two distinct non-empty values", token, secret)
	}

	if _, err := svc.Get(ctx, token); err != nil {
		t.Fatalf("Get after create: %v", err)
	}

	// Wrong secret: refused as not-found, share survives.
	if err := svc.Revoke(ctx, token, "not-the-secret"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Revoke(wrong secret) = %v, want ErrNotFound", err)
	}
	if _, err := svc.Get(ctx, token); err != nil {
		t.Fatalf("share died from a WRONG-secret revoke attempt: %v", err)
	}

	// Right secret: gone, and a second revoke reports not-found.
	if err := svc.Revoke(ctx, token, secret); err != nil {
		t.Fatalf("Revoke(correct secret): %v", err)
	}
	if _, err := svc.Get(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after revoke = %v, want ErrNotFound", err)
	}
	if err := svc.Revoke(ctx, token, secret); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Revoke = %v, want ErrNotFound", err)
	}
}

// Legacy rows (pre-032, NULL revoke_secret_hash) can never be revoked — no
// proof-of-creator exists — and must not be deletable with any secret.
func TestSharedLegacyRowNotRevocable(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	if _, err := pool.Exec(ctx, `
		INSERT INTO shared_ledger_snapshots (token, payload, expires_at)
		VALUES ('legacytok123', '{"v":1}'::jsonb, NOW() + interval '10 days')
	`); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}
	if err := svc.Revoke(ctx, "legacytok123", "anything"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Revoke(legacy row) = %v, want ErrNotFound", err)
	}
	if _, err := svc.Get(ctx, "legacytok123"); err != nil {
		t.Fatalf("legacy share must survive revoke attempts: %v", err)
	}
}
