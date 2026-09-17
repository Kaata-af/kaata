package auth

// The sign-in pending-vault block is where "a member never gets added to the
// first kaata I created" started: it is the ONLY way a kaata that already
// existed on the phone before sign-in reaches the server, and until 2026-09
// it carried no trust-anchor field at all, so those vaults landed with
// vaults.vault_trust_anchor_pubkey NULL. An anchor-less server row turns the
// M2 membership-chain path off, which drops a joiner's own admission onto
// the legacy owner-only role matrix and refuses it forever.
//
// SignInWithGoogle itself needs a live Google ID token, so these tests drive
// upsertPendingVault — the exact statement that path runs — plus the pure
// decoder in front of it.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestDecodeAnchorPubkey(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	std := base64.StdEncoding.EncodeToString(pub)
	rawURL := base64.RawURLEncoding.EncodeToString(pub)

	cases := []struct {
		name string
		in   string
		want []byte
	}{
		{"standard base64", std, pub},
		{"url-safe base64 (pair QR)", rawURL, pub},
		{"absent", "", nil},
		{"not base64", "this is not base64!!", nil},
		{"right encoding, wrong length", base64.StdEncoding.EncodeToString([]byte("short")), nil},
		{"33 bytes", base64.StdEncoding.EncodeToString(append([]byte(pub), 0)), nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeAnchorPubkey(tc.in)
			if !bytes.Equal(got, tc.want) {
				t.Fatalf("decodeAnchorPubkey(%q) = %x, want %x", tc.in, got, tc.want)
			}
		})
	}

	// A malformed anchor must degrade to nil rather than fail: this runs on
	// the SIGN-IN path, and refusing someone their session over a bad anchor
	// would be far worse than registering the vault anchor-less. Nothing in
	// the signature can report an error, which is the point — this test pins
	// that intent so nobody "fixes" it into a (value, error) pair.
	if got := decodeAnchorPubkey("!!!"); got != nil {
		t.Fatalf("malformed anchor = %x, want nil (never an error)", got)
	}
}

func seedPendingTestAccount(t *testing.T, pool *pgxpool.Pool, label string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, $2, TRUE, $3)
		RETURNING id::text
	`, "sub-"+uuid.NewString(), uuid.NewString()+"@gmail.com", label).Scan(&id); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	return id
}

// runUpsert drives upsertPendingVault inside its own committed transaction,
// the way SignInWithGoogle does.
func runUpsert(
	t *testing.T, pool *pgxpool.Pool, accountID string, pending *PendingVaultRegistration,
) (string, error) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	owner, err := upsertPendingVault(ctx, tx, accountID, pending, "AFN", time.Now())
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return owner, nil
}

func pendingAnchor(t *testing.T, id string, anchor ed25519.PublicKey) *PendingVaultRegistration {
	t.Helper()
	p := &PendingVaultRegistration{ID: id, Name: "First Kaata"}
	if anchor != nil {
		p.VaultTrustAnchorPubkey = base64.StdEncoding.EncodeToString(anchor)
	}
	return p
}

func mustAnchor(t *testing.T) ed25519.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate anchor: %v", err)
	}
	return pub
}

func anchorOf(t *testing.T, pool *pgxpool.Pool, vaultID string) []byte {
	t.Helper()
	var anchor []byte
	if err := pool.QueryRow(context.Background(), `
		SELECT vault_trust_anchor_pubkey FROM vaults WHERE vault_id = $1::uuid
	`, vaultID).Scan(&anchor); err != nil {
		t.Fatalf("read anchor: %v", err)
	}
	return anchor
}

// TestUpsertPendingVaultStoresAndHealsAnchor is the fix: the sign-in path now
// stores the anchor the phone sends, fills a NULL one it left behind on an
// earlier sign-in, and still refuses to rotate or to let a stranger write.
func TestUpsertPendingVaultStoresAndHealsAnchor(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	owner := seedPendingTestAccount(t, pool, "Owner")
	stranger := seedPendingTestAccount(t, pool, "Stranger")

	// ---- 1. The anchor now survives sign-in. --------------------------
	anchorA := mustAnchor(t)
	vaultA := uuid.NewString()
	gotOwner, err := runUpsert(t, pool, owner, pendingAnchor(t, vaultA, anchorA))
	if err != nil {
		t.Fatalf("upsert (fresh): %v", err)
	}
	if gotOwner != owner {
		t.Fatalf("RETURNING owner = %s, want %s", gotOwner, owner)
	}
	if got := anchorOf(t, pool, vaultA); !bytes.Equal(got, []byte(anchorA)) {
		t.Fatalf("anchor after sign-in = %x, want %x — this is the bug", got, anchorA)
	}

	// ---- 2. A second sign-in never rotates it. ------------------------
	if _, err := runUpsert(t, pool, owner, pendingAnchor(t, vaultA, mustAnchor(t))); err != nil {
		t.Fatalf("upsert (second sign-in): %v", err)
	}
	if got := anchorOf(t, pool, vaultA); !bytes.Equal(got, []byte(anchorA)) {
		t.Fatalf("second sign-in rotated the anchor: %x, want %x", got, anchorA)
	}

	// ---- 3. An anchor-less sign-in never clears it. -------------------
	// An old APK, or one whose local vault row has no anchor, must not blank
	// the column it cannot reproduce.
	if _, err := runUpsert(t, pool, owner, pendingAnchor(t, vaultA, nil)); err != nil {
		t.Fatalf("upsert (no anchor): %v", err)
	}
	if got := anchorOf(t, pool, vaultA); !bytes.Equal(got, []byte(anchorA)) {
		t.Fatalf("anchor-less sign-in cleared the anchor: %x, want %x", got, anchorA)
	}

	// ---- 4. THE HEAL: a vault registered before this field existed. ---
	// Seeded exactly as the old code left it, then re-signed-in by its owner.
	vaultB := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'First Kaata', 'AFN', 0)
	`, vaultB, owner); err != nil {
		t.Fatalf("seed anchor-less vault: %v", err)
	}
	anchorB := mustAnchor(t)
	if _, err := runUpsert(t, pool, owner, pendingAnchor(t, vaultB, anchorB)); err != nil {
		t.Fatalf("upsert (heal): %v", err)
	}
	if got := anchorOf(t, pool, vaultB); !bytes.Equal(got, []byte(anchorB)) {
		t.Fatalf("re-sign-in did not heal the NULL anchor: %x, want %x", got, anchorB)
	}

	// ---- 5. A stranger can neither fill nor rotate. -------------------
	// The caller rejects on the RETURNING owner, but that check runs AFTER
	// the UPDATE, so the owner gate has to be in the statement. Both the
	// anchor-less and the anchored victim are tested.
	vaultC := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Someone Elses Kaata', 'AFN', 0)
	`, vaultC, owner); err != nil {
		t.Fatalf("seed victim vault: %v", err)
	}
	reported, err := runUpsert(t, pool, stranger, pendingAnchor(t, vaultC, mustAnchor(t)))
	if err != nil {
		t.Fatalf("upsert (stranger): %v", err)
	}
	if reported != owner {
		t.Fatalf("RETURNING owner for stranger = %s, want the true owner %s "+
			"(SignInWithGoogle rejects the collision on this value)", reported, owner)
	}
	if a := anchorOf(t, pool, vaultC); a != nil {
		t.Fatalf("stranger stamped an anchor onto an anchor-less vault: %x", a)
	}

	reported2, err := runUpsert(t, pool, stranger, pendingAnchor(t, vaultA, mustAnchor(t)))
	if err != nil {
		t.Fatalf("upsert (stranger, anchored vault): %v", err)
	}
	if reported2 != owner {
		t.Fatalf("RETURNING owner = %s, want %s", reported2, owner)
	}
	if got := anchorOf(t, pool, vaultA); !bytes.Equal(got, []byte(anchorA)) {
		t.Fatalf("stranger rotated an anchor: %x, want %x", got, anchorA)
	}

	// ---- 6. A malformed anchor registers the vault anyway. ------------
	// Sign-in must never fail over one.
	vaultD := uuid.NewString()
	if _, err := runUpsert(t, pool, owner, &PendingVaultRegistration{
		ID: vaultD, Name: "Junk Anchor", VaultTrustAnchorPubkey: "%%%not-base64%%%",
	}); err != nil {
		t.Fatalf("upsert (malformed anchor) must not fail sign-in: %v", err)
	}
	if a := anchorOf(t, pool, vaultD); a != nil {
		t.Fatalf("malformed anchor was stored: %x", a)
	}
	// …and the owner can heal it on a later sign-in.
	anchorD := mustAnchor(t)
	if _, err := runUpsert(t, pool, owner, pendingAnchor(t, vaultD, anchorD)); err != nil {
		t.Fatalf("upsert (heal after malformed): %v", err)
	}
	if got := anchorOf(t, pool, vaultD); !bytes.Equal(got, []byte(anchorD)) {
		t.Fatalf("heal after a malformed anchor failed: %x, want %x", got, anchorD)
	}
}

// TestPendingVaultRegistrationDecodesAnchorField pins the JSON tag mobile
// sends. A rename on either side silently reintroduces the bug: the block
// keeps working, the anchor just never arrives.
func TestPendingVaultRegistrationDecodesAnchorField(t *testing.T) {
	anchor := mustAnchor(t)
	body := `{"id":"` + uuid.NewString() + `","name":"Shop",` +
		`"vault_trust_anchor_pubkey":"` + base64.StdEncoding.EncodeToString(anchor) + `"}`

	var p PendingVaultRegistration
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatalf("decode pending block: %v", err)
	}
	if !bytes.Equal(decodeAnchorPubkey(p.VaultTrustAnchorPubkey), []byte(anchor)) {
		t.Fatalf("anchor did not survive JSON decoding of the pending block")
	}
}
