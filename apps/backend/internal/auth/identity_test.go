package auth

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// resolveInTx runs resolveOrCreateAccount inside a committed transaction,
// mirroring how SignInWithGoogle drives it.
func resolveInTx(t *testing.T, pool *pgxpool.Pool, provider, sub string, profile AccountProfile) (string, bool) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	accountID, created, err := resolveOrCreateAccount(ctx, tx, provider, sub, profile)
	if err != nil {
		t.Fatalf("resolveOrCreateAccount(%s, %s): %v", provider, sub, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return accountID, created
}

func googleProfile(email, name string) AccountProfile {
	return AccountProfile{
		Email:           email,
		EmailNormalized: normalizeEmail(email),
		EmailVerified:   true,
		Name:            name,
		PictureURL:      "https://example.com/p.jpg",
	}
}

func TestResolveOrCreateAccount_NewAccount(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	accountID, created := resolveInTx(t, pool, ProviderGoogle, "sub-new-1", googleProfile("new@gmail.com", "New User"))
	if !created {
		t.Fatalf("expected created=true for first sign-in")
	}
	if _, err := uuid.Parse(accountID); err != nil {
		t.Fatalf("account id is not a uuid: %q", accountID)
	}

	// Identity row exists.
	var gotAccount string
	if err := pool.QueryRow(ctx, `
		SELECT account_id::text FROM account_identities
		WHERE provider = 'google' AND provider_sub = 'sub-new-1'
	`).Scan(&gotAccount); err != nil {
		t.Fatalf("identity row missing: %v", err)
	}
	if gotAccount != accountID {
		t.Fatalf("identity points at %s, want %s", gotAccount, accountID)
	}

	// DUAL-WRITE: accounts.google_sub still populated this release.
	var googleSub *string
	var email string
	if err := pool.QueryRow(ctx, `
		SELECT google_sub, email FROM accounts WHERE id = $1::uuid
	`, accountID).Scan(&googleSub, &email); err != nil {
		t.Fatalf("accounts row missing: %v", err)
	}
	if googleSub == nil || *googleSub != "sub-new-1" {
		t.Fatalf("dual-write failed: google_sub = %v, want sub-new-1", googleSub)
	}
	if email != "new@gmail.com" {
		t.Fatalf("email = %q, want new@gmail.com", email)
	}
}

func TestResolveOrCreateAccount_ExistingViaBackfilledIdentity(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	// Simulate a pre-M1 account that migration 013 backfilled: accounts row
	// + identity row both present.
	var accountID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ('sub-backfilled', 'old@gmail.com', TRUE, 'Old User')
		RETURNING id::text
	`).Scan(&accountID); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_identities (account_id, provider, provider_sub)
		VALUES ($1::uuid, 'google', 'sub-backfilled')
	`, accountID); err != nil {
		t.Fatalf("seed identity: %v", err)
	}

	gotID, created := resolveInTx(t, pool, ProviderGoogle, "sub-backfilled", googleProfile("old@gmail.com", "Old User"))
	if created {
		t.Fatalf("expected created=false for existing identity")
	}
	if gotID != accountID {
		t.Fatalf("resolved %s, want %s", gotID, accountID)
	}
}

func TestResolveOrCreateAccount_LegacyGoogleSubFallbackSelfHeals(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	// An accounts row with google_sub but NO identity row (e.g. created by
	// a rolled-back binary after 013 ran its backfill).
	var accountID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ('sub-legacy', 'legacy@gmail.com', TRUE, 'Legacy User')
		RETURNING id::text
	`).Scan(&accountID); err != nil {
		t.Fatalf("seed account: %v", err)
	}

	gotID, created := resolveInTx(t, pool, ProviderGoogle, "sub-legacy", googleProfile("legacy@gmail.com", "Legacy User"))
	if created {
		t.Fatalf("expected created=false for legacy fallback hit")
	}
	if gotID != accountID {
		t.Fatalf("resolved %s, want %s", gotID, accountID)
	}

	// Self-heal: the identity row was inserted.
	var healed string
	if err := pool.QueryRow(ctx, `
		SELECT account_id::text FROM account_identities
		WHERE provider = 'google' AND provider_sub = 'sub-legacy'
	`).Scan(&healed); err != nil {
		t.Fatalf("self-healed identity row missing: %v", err)
	}
	if healed != accountID {
		t.Fatalf("healed identity points at %s, want %s", healed, accountID)
	}
}

func TestResolveOrCreateAccount_ProfileUpdateOnRelogin(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	accountID, _ := resolveInTx(t, pool, ProviderGoogle, "sub-relogin", googleProfile("before@gmail.com", "Before"))

	var firstLogin time.Time
	if err := pool.QueryRow(ctx, `
		SELECT last_login_at FROM accounts WHERE id = $1::uuid
	`, accountID).Scan(&firstLogin); err != nil {
		t.Fatalf("read first last_login_at: %v", err)
	}

	time.Sleep(20 * time.Millisecond) // make last_login_at strictly comparable

	gotID, created := resolveInTx(t, pool, ProviderGoogle, "sub-relogin", googleProfile("after@gmail.com", "After"))
	if created || gotID != accountID {
		t.Fatalf("re-login resolved (%s, created=%v), want (%s, false)", gotID, created, accountID)
	}

	var email, name string
	var lastLogin time.Time
	if err := pool.QueryRow(ctx, `
		SELECT email, name, last_login_at FROM accounts WHERE id = $1::uuid
	`, accountID).Scan(&email, &name, &lastLogin); err != nil {
		t.Fatalf("read account after re-login: %v", err)
	}
	if email != "after@gmail.com" || name != "After" {
		t.Fatalf("profile not refreshed: email=%q name=%q", email, name)
	}
	if !lastLogin.After(firstLogin) {
		t.Fatalf("last_login_at not bumped: first=%v last=%v", firstLogin, lastLogin)
	}
}

func TestResolveOrCreateAccount_SecondProviderMapsToSameAccount(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	accountID, _ := resolveInTx(t, pool, ProviderGoogle, "sub-multi", googleProfile("multi@gmail.com", "Multi"))

	// Link a phone_otp identity to the same account (what the future
	// identity-linking flow will do).
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_identities (account_id, provider, provider_sub)
		VALUES ($1::uuid, 'phone_otp', '+93700000001')
	`, accountID); err != nil {
		t.Fatalf("link phone identity: %v", err)
	}

	// Resolve by the phone identity with an empty profile (OTP asserts no
	// email/name/picture).
	gotID, created := resolveInTx(t, pool, "phone_otp", "+93700000001", AccountProfile{})
	if created {
		t.Fatalf("expected created=false when resolving by linked identity")
	}
	if gotID != accountID {
		t.Fatalf("phone identity resolved %s, want %s", gotID, accountID)
	}

	// The empty OTP profile must not blank out the Google-asserted fields.
	var email, name string
	var verified bool
	if err := pool.QueryRow(ctx, `
		SELECT email, name, email_verified FROM accounts WHERE id = $1::uuid
	`, accountID).Scan(&email, &name, &verified); err != nil {
		t.Fatalf("read account: %v", err)
	}
	if email != "multi@gmail.com" || name != "Multi" || !verified {
		t.Fatalf("empty profile clobbered fields: email=%q name=%q verified=%v", email, name, verified)
	}
}

func appleProfile(email string, verified bool, name string) AccountProfile {
	return AccountProfile{
		Email:           email,
		EmailNormalized: normalizeEmail(email),
		EmailVerified:   verified,
		Name:            name,
	}
}

// seedVaultOwnedBy registers a vault + owner membership for an account, so
// the account counts as "content-bearing" for the email-link/heal paths.
func seedVaultOwnedBy(t *testing.T, pool *pgxpool.Pool, accountID string) string {
	t.Helper()
	ctx := context.Background()
	vaultID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, created_at)
		VALUES ($1::uuid, $2::uuid, 'Test Kaata', 'AFN', 0, NOW())
	`, vaultID, accountID); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, vaultID, accountID); err != nil {
		t.Fatalf("seed vault membership: %v", err)
	}
	return vaultID
}

// The user's cross-provider contract: Google on Android first, Apple on iOS
// later with the SAME verified email → the Apple identity links into the
// existing account instead of minting an empty duplicate, so GET /v1/vaults
// restores the same vaults.
func TestResolveOrCreateAccount_AppleLinksIntoGoogleAccountByVerifiedEmail(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	googleID, _ := resolveInTx(t, pool, ProviderGoogle, "sub-link-g1", googleProfile("linkme@gmail.com", "Linker"))

	appleID, created := resolveInTx(t, pool, ProviderApple, "sub-link-a1", appleProfile("linkme@gmail.com", true, "Linker"))
	if created {
		t.Fatalf("expected created=false when linking by verified email")
	}
	if appleID != googleID {
		t.Fatalf("apple sign-in resolved %s, want the google account %s", appleID, googleID)
	}

	// The apple identity row now points at the google account.
	var linked string
	if err := pool.QueryRow(ctx, `
		SELECT account_id::text FROM account_identities
		WHERE provider = 'apple' AND provider_sub = 'sub-link-a1'
	`).Scan(&linked); err != nil {
		t.Fatalf("apple identity row missing: %v", err)
	}
	if linked != googleID {
		t.Fatalf("apple identity points at %s, want %s", linked, googleID)
	}

	// Subsequent Apple sign-ins resolve via step (1) — even with the email
	// absent from the token (Apple omits it after the first authorization).
	gotID, created := resolveInTx(t, pool, ProviderApple, "sub-link-a1", appleProfile("", false, ""))
	if created || gotID != googleID {
		t.Fatalf("second apple resolve = (%s, %v), want (%s, false)", gotID, created, googleID)
	}
}

// Reverse direction: Apple-first user later signs in with Google (same
// verified email) — the Google identity links in, and the dual-written
// google_sub lands on the linked account.
func TestResolveOrCreateAccount_GoogleLinksIntoAppleAccountByVerifiedEmail(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	appleID, _ := resolveInTx(t, pool, ProviderApple, "sub-link-a2", appleProfile("applefirst@example.com", true, "Apple First"))

	googleID, created := resolveInTx(t, pool, ProviderGoogle, "sub-link-g2", googleProfile("applefirst@example.com", "Apple First"))
	if created || googleID != appleID {
		t.Fatalf("google sign-in resolved (%s, created=%v), want (%s, false)", googleID, created, appleID)
	}

	var googleSub *string
	if err := pool.QueryRow(ctx, `
		SELECT google_sub FROM accounts WHERE id = $1::uuid
	`, appleID).Scan(&googleSub); err != nil {
		t.Fatalf("accounts row missing: %v", err)
	}
	if googleSub == nil || *googleSub != "sub-link-g2" {
		t.Fatalf("dual-write on email link failed: google_sub = %v, want sub-link-g2", googleSub)
	}
}

// An UNVERIFIED email must never link — it is attacker-typable.
func TestResolveOrCreateAccount_UnverifiedEmailNeverLinks(t *testing.T) {
	pool := testutil.ConnectTestDB(t)

	googleID, _ := resolveInTx(t, pool, ProviderGoogle, "sub-nolink-g1", googleProfile("victim@gmail.com", "Victim"))

	appleID, created := resolveInTx(t, pool, ProviderApple, "sub-nolink-a1", appleProfile("victim@gmail.com", false, "Mallory"))
	if !created {
		t.Fatalf("unverified email must create a fresh account, not link")
	}
	if appleID == googleID {
		t.Fatalf("unverified email linked into the existing account — must not happen")
	}
}

// Same-provider, different-sub, same email = recycled address (e.g. a
// workspace email reissued to a new employee). Must NOT link.
func TestResolveOrCreateAccount_SameProviderNeverLinksByEmail(t *testing.T) {
	pool := testutil.ConnectTestDB(t)

	firstID, _ := resolveInTx(t, pool, ProviderGoogle, "sub-recycled-1", googleProfile("staff@shop-af.com", "Old Staff"))

	secondID, created := resolveInTx(t, pool, ProviderGoogle, "sub-recycled-2", googleProfile("staff@shop-af.com", "New Staff"))
	if !created {
		t.Fatalf("same-provider same-email must create a fresh account, not link")
	}
	if secondID == firstID {
		t.Fatalf("recycled email linked the new google sub into the old account — must not happen")
	}
}

// The healer for pre-linking duplicates: an EMPTY Apple account already
// shadows a content-bearing Google account (same verified email). The next
// Apple sign-in must adopt the Google account and repoint the identity.
func TestResolveOrCreateAccount_HollowDuplicateAdoptedOnSignIn(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	googleID, _ := resolveInTx(t, pool, ProviderGoogle, "sub-heal-g1", googleProfile("healme@gmail.com", "Healed"))
	seedVaultOwnedBy(t, pool, googleID)

	// Simulate the pre-linking duplicate: a separate empty account holding
	// the apple identity for the same verified email.
	var hollowID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (email, email_normalized, email_verified, name)
		VALUES ('healme@gmail.com', $1, TRUE, 'Healed')
		RETURNING id::text
	`, normalizeEmail("healme@gmail.com")).Scan(&hollowID); err != nil {
		t.Fatalf("seed hollow account: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_identities (account_id, provider, provider_sub)
		VALUES ($1::uuid, 'apple', 'sub-heal-a1')
	`, hollowID); err != nil {
		t.Fatalf("seed hollow identity: %v", err)
	}

	gotID, created := resolveInTx(t, pool, ProviderApple, "sub-heal-a1", appleProfile("healme@gmail.com", true, "Healed"))
	if created {
		t.Fatalf("healing must not report a created account")
	}
	if gotID != googleID {
		t.Fatalf("hollow duplicate resolved to %s, want adoption into %s", gotID, googleID)
	}

	// The apple identity row was repointed off the husk.
	var owner string
	if err := pool.QueryRow(ctx, `
		SELECT account_id::text FROM account_identities
		WHERE provider = 'apple' AND provider_sub = 'sub-heal-a1'
	`).Scan(&owner); err != nil {
		t.Fatalf("apple identity row missing after heal: %v", err)
	}
	if owner != googleID {
		t.Fatalf("apple identity still points at %s, want %s", owner, googleID)
	}
}

// A hollow account with NO content-bearing sibling stays put — healing only
// fires when there is real data to reach.
func TestResolveOrCreateAccount_HollowWithoutContentSiblingUntouched(t *testing.T) {
	pool := testutil.ConnectTestDB(t)

	// Both accounts empty: the apple one resolves to itself, no adoption.
	googleID, _ := resolveInTx(t, pool, ProviderGoogle, "sub-noheal-g1", googleProfile("nocontent@gmail.com", "Empty"))
	_ = googleID
	appleID, _ := resolveInTx(t, pool, ProviderApple, "sub-noheal-a1", appleProfile("nocontent2@gmail.com", true, "Empty Two"))

	gotID, created := resolveInTx(t, pool, ProviderApple, "sub-noheal-a1", appleProfile("nocontent2@gmail.com", true, "Empty Two"))
	if created || gotID != appleID {
		t.Fatalf("re-resolve = (%s, %v), want (%s, false)", gotID, created, appleID)
	}
}

func TestResolveOrCreateAccount_NonGoogleCreate(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	// The whole point of M1: a future /v1/auth/otp/verify handler only
	// needs this call. No google_sub involved anywhere.
	accountID, created := resolveInTx(t, pool, "phone_otp", "+93700000099", AccountProfile{})
	if !created {
		t.Fatalf("expected created=true for first OTP sign-in")
	}

	var googleSub *string
	if err := pool.QueryRow(ctx, `
		SELECT google_sub FROM accounts WHERE id = $1::uuid
	`, accountID).Scan(&googleSub); err != nil {
		t.Fatalf("accounts row missing: %v", err)
	}
	if googleSub != nil {
		t.Fatalf("OTP account must not carry google_sub, got %q", *googleSub)
	}

	// Re-resolving lands on the same account.
	gotID, created := resolveInTx(t, pool, "phone_otp", "+93700000099", AccountProfile{})
	if created || gotID != accountID {
		t.Fatalf("second OTP resolve = (%s, %v), want (%s, false)", gotID, created, accountID)
	}
}
