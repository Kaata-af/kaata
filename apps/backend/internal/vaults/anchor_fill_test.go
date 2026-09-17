package vaults

// The vault trust anchor is ONE-WAY fillable: NULL → value, by the owner
// only, never a rewrite.
//
// Why it is fillable at all: a kaata registered through the sign-in
// pending-registration block landed with vault_trust_anchor_pubkey NULL,
// because that block carried no anchor field until 2026-09. An anchor-less
// server row turns the M2 membership-chain path off, which drops a joiner's
// own admission onto the legacy owner-only role matrix and refuses it
// forever — "a member never gets added to the first kaata I created". Those
// live vaults heal when their owner re-POSTs /v1/vaults with the anchor the
// phone has held all along (mobile: healMissingServerAnchors).
//
// Why it is one-way and owner-gated: an anchor is the vault's root of trust.
// Rewriting one would hand the vault to whoever wrote last, and the caller's
// collision check runs AFTER the UPDATE has applied, so the owner gate has to
// live inside the statement or a stranger who guessed a vault UUID could
// stamp an anchor onto someone else's vault before being rejected.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

func seedAnchorTestAccount(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, $2, TRUE, 'A')
		RETURNING id::text
	`, "sub-"+uuid.NewString(), uuid.NewString()+"@gmail.com").Scan(&id); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	return id
}

func newAnchor(t *testing.T) []byte {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate anchor: %v", err)
	}
	return pub
}

func readAnchor(t *testing.T, pool *pgxpool.Pool, vaultID string) []byte {
	t.Helper()
	var anchor []byte
	if err := pool.QueryRow(context.Background(), `
		SELECT vault_trust_anchor_pubkey FROM vaults WHERE vault_id = $1::uuid
	`, vaultID).Scan(&anchor); err != nil {
		t.Fatalf("read anchor: %v", err)
	}
	return anchor
}

// TestCreateFillsNullAnchorForOwnerOnly walks the whole matrix in one
// database: fresh create, the heal, and every case that must NOT move.
func TestCreateFillsNullAnchorForOwnerOnly(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	owner := seedAnchorTestAccount(t, pool)
	stranger := seedAnchorTestAccount(t, pool)

	// ---- 1. Fresh create stores the anchor verbatim. -------------------
	anchorA := newAnchor(t)
	vaultA := uuid.NewString()
	if _, err := svc.Create(ctx, CreateInput{
		AccountID: owner, VaultID: vaultA, Name: "Shop A",
		VaultTrustAnchorPubkey: anchorA,
	}); err != nil {
		t.Fatalf("Create (fresh): %v", err)
	}
	if got := readAnchor(t, pool, vaultA); !bytes.Equal(got, anchorA) {
		t.Fatalf("fresh anchor = %x, want %x", got, anchorA)
	}

	// ---- 2. A re-POST with a DIFFERENT anchor never rotates. -----------
	// This is the retry-from-a-second-device case: the owner's first write
	// stays authoritative.
	if _, err := svc.Create(ctx, CreateInput{
		AccountID: owner, VaultID: vaultA, Name: "Shop A",
		VaultTrustAnchorPubkey: newAnchor(t),
	}); err != nil {
		t.Fatalf("Create (idempotent retry): %v", err)
	}
	if got := readAnchor(t, pool, vaultA); !bytes.Equal(got, anchorA) {
		t.Fatalf("anchor rotated on retry: %x, want %x", got, anchorA)
	}

	// ---- 3. A nil anchor never clears an existing one. -----------------
	// An old client that omits the field must not blank the column.
	if _, err := svc.Create(ctx, CreateInput{
		AccountID: owner, VaultID: vaultA, Name: "Shop A",
	}); err != nil {
		t.Fatalf("Create (no anchor): %v", err)
	}
	if got := readAnchor(t, pool, vaultA); !bytes.Equal(got, anchorA) {
		t.Fatalf("anchor cleared by an anchor-less re-POST: %x, want %x", got, anchorA)
	}

	// ---- 4. THE HEAL: the owner fills a NULL anchor. -------------------
	// vaultB is seeded exactly as the pre-2026-09 sign-in path left it.
	vaultB := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'First Kaata', 'AFN', 0)
	`, vaultB, owner); err != nil {
		t.Fatalf("seed anchor-less vault: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, vaultB, owner); err != nil {
		t.Fatalf("seed anchor-less owner membership: %v", err)
	}
	if a := readAnchor(t, pool, vaultB); a != nil {
		t.Fatalf("seeded vault should start anchor-less, got %x", a)
	}

	anchorB := newAnchor(t)
	if _, err := svc.Create(ctx, CreateInput{
		AccountID: owner, VaultID: vaultB, Name: "First Kaata",
		VaultTrustAnchorPubkey: anchorB,
	}); err != nil {
		t.Fatalf("Create (heal): %v", err)
	}
	if got := readAnchor(t, pool, vaultB); !bytes.Equal(got, anchorB) {
		t.Fatalf("heal did not fill the anchor: %x, want %x", got, anchorB)
	}
	// The heal must not duplicate the owner membership row.
	var ownerRows int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
	`, vaultB, owner).Scan(&ownerRows); err != nil {
		t.Fatalf("count owner membership: %v", err)
	}
	if ownerRows != 1 {
		t.Errorf("owner membership rows after heal = %d, want 1", ownerRows)
	}

	// ---- 5. A stranger cannot fill a NULL anchor. ----------------------
	// The refusal must be ErrVaultCollision AND the column must still be
	// NULL: the collision check alone is too late, because the UPDATE has
	// already run by the time it fires.
	vaultC := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Someone Elses Kaata', 'AFN', 0)
	`, vaultC, owner); err != nil {
		t.Fatalf("seed victim vault: %v", err)
	}
	if _, err := svc.Create(ctx, CreateInput{
		AccountID: stranger, VaultID: vaultC, Name: "Hijack",
		VaultTrustAnchorPubkey: newAnchor(t),
	}); !errors.Is(err, ErrVaultCollision) {
		t.Fatalf("stranger Create = %v, want ErrVaultCollision", err)
	}
	if a := readAnchor(t, pool, vaultC); a != nil {
		t.Fatalf("stranger stamped an anchor onto an anchor-less vault: %x", a)
	}

	// ---- 6. A stranger cannot rotate an existing anchor either. --------
	if _, err := svc.Create(ctx, CreateInput{
		AccountID: stranger, VaultID: vaultA, Name: "Hijack",
		VaultTrustAnchorPubkey: newAnchor(t),
	}); !errors.Is(err, ErrVaultCollision) {
		t.Fatalf("stranger Create over anchored vault = %v, want ErrVaultCollision", err)
	}
	if got := readAnchor(t, pool, vaultA); !bytes.Equal(got, anchorA) {
		t.Fatalf("stranger rotated an anchor: %x, want %x", got, anchorA)
	}
	// And the stranger gained no membership anywhere.
	var strangerRows int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM vault_members WHERE account_id = $1::uuid
	`, stranger).Scan(&strangerRows); err != nil {
		t.Fatalf("count stranger memberships: %v", err)
	}
	if strangerRows != 0 {
		t.Errorf("stranger holds %d membership rows, want 0", strangerRows)
	}
}
