package shared

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

// Paper rule (2026-08-07): a bill is permanent and unrevocable. Create
// returns just a token; Get serves it forever; there is no Revoke and no TTL.
func TestSharedCreateGet(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	payload := []byte(`{"v":1,"person":"Ahmad","balance":1200,"entries":[]}`)
	token, err := svc.Create(ctx, payload)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if token == "" {
		t.Fatal("Create returned an empty token")
	}

	got, err := svc.Get(ctx, token)
	if err != nil {
		t.Fatalf("Get after create: %v", err)
	}
	// JSONB normalizes whitespace/key order — compare parsed content, not bytes.
	var stored map[string]any
	if err := json.Unmarshal(got, &stored); err != nil {
		t.Fatalf("Get returned invalid JSON: %v", err)
	}
	if stored["person"] != "Ahmad" || stored["balance"] != float64(1200) {
		t.Fatalf("Get = %s, want the stored snapshot content back", got)
	}

	if _, err := svc.Get(ctx, "no-such-token"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(unknown token) = %v, want ErrNotFound", err)
	}
}

// Old rows keep serving no matter how old they are — migration 035 retired
// the TTL (Get no longer filters on expires_at), and nothing may reintroduce
// an age filter on the read path.
func TestSharedOldBillStillServes(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	if _, err := pool.Exec(ctx, `
		INSERT INTO shared_ledger_snapshots (token, payload, created_at)
		VALUES ('ancienttok12', '{"v":1}'::jsonb, NOW() - interval '5 years')
	`); err != nil {
		t.Fatalf("seed ancient row: %v", err)
	}
	if _, err := svc.Get(ctx, "ancienttok12"); err != nil {
		t.Fatalf("a 5-year-old bill must still serve (paper rule): %v", err)
	}
}
