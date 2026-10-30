package auth

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ProviderEmail is the Kaata email + password sign-in (docs/kaata-accounts.md).
// Its session provider_sub is the account id, never the address.
const ProviderEmail = "email"

// SwitchOptions is the app's claim about the phone it signs in on: the account
// it was last bound to (sent only while the phone holds that account's data),
// and whether the user already chose to switch away from it.
type SwitchOptions struct {
	CurrentAccountID string
	AllowSwitch      bool
	// Platform is an analytics hint. Only web is recognized here; a sign-in
	// must never relabel an existing phone or rely on this for authorization.
	Platform string
	// Nonce binds a browser provider token to the locally pending sign-in.
	// Checked against verified provider claims before entering the shared tail.
	Nonce string
}

// DifferentAccountError: the sign-in resolved another account than the one
// the phone holds data for, and the user has not chosen to switch (409
// different_account). Nothing was written. Error() never contains the email.
type DifferentAccountError struct{ Email string }

func (e *DifferentAccountError) Error() string {
	return "sign-in resolved a different account than the phone's"
}

// ErrAccountDisabled: accounts.disabled_at is set (403 account_disabled).
var ErrAccountDisabled = errors.New("account is disabled")

// signInTail is everything the shared tail needs once the account is known.
type signInTail struct {
	provider    string
	providerSub string
	installID   string
	accountID   string
	sw          SwitchOptions
	// sameAs: other account ids this sign-in proves to be the phone's own,
	// e.g. the husk a hollow-duplicate heal just moved this identity off.
	sameAs []string
	// Stored on the credential row (display only).
	credEmail, credName, credPicture string
	// Google only: a kaata the phone minted before signing in.
	pending *PendingVaultRegistration
}

// newSessionEpoch returns a random epoch in [1, 2^53): 0 is legacy, and a
// JavaScript reader of the JWT must not round it.
func newSessionEpoch() (int64, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0, fmt.Errorf("session epoch: %w", err)
	}
	e := int64(binary.BigEndian.Uint64(b[:]) >> 11)
	if e == 0 {
		e = 1
	}
	return e, nil
}

// providerSignIn resolves (or creates) the account of a verified Google or
// Apple identity and runs the shared tail, in one transaction. When the
// hollow-duplicate heal moves the identity off a husk, the husk still counts
// as the phone's own account: it is the same identity, so the user is not asked
// to keep or wipe their own data.
func (s *Service) providerSignIn(ctx context.Context, profile AccountProfile, t signInTail) (GoogleSignInResult, tailAccount, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var before string
	err = tx.QueryRow(ctx, `SELECT account_id::text FROM account_identities WHERE provider = $1 AND provider_sub = $2`,
		t.provider, t.providerSub).Scan(&before)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("read identity owner: %w", err)
	}
	accountID, _, err := resolveOrCreateAccount(ctx, tx, t.provider, t.providerSub, profile)
	if err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("resolve account: %w", err)
	}
	t.accountID = accountID
	if before != "" && before != accountID {
		t.sameAs = append(t.sameAs, before)
	}
	return s.completeSignIn(ctx, tx, t)
}

// tailAccount is the account's own state, read under the account lock.
type tailAccount struct {
	email       string
	name        string
	phone       string
	username    string
	hasPassword bool
}

// completeSignIn is the one ending every sign-in shares (Google, Apple and each
// email flow), inside the caller's transaction, which it commits:
//
//  1. lock the account row first, the order DeleteAccount uses;
//  2. refuse a disabled account;
//  3. ensureSignInInstall: a retired install answers 410 before anything else;
//  4. different account: return *DifferentAccountError, and the caller's
//     deferred rollback discards everything the request wrote (an id in
//     t.sameAs is the phone's own account, not a different one);
//  5. one live credential per install: every other credential on this install
//     (any provider, any account) is deleted; the handler then invalidates the
//     install's cached verdicts;
//  6. bind the install, upsert the credential with a fresh session epoch (so
//     older JWTs of this install stop authorizing), register or read the
//     default kaata, commit and sign the session.
//
// The caller fills the provider-specific fields of result.User.
func (s *Service) completeSignIn(ctx context.Context, tx pgx.Tx, t signInTail) (GoogleSignInResult, tailAccount, error) {
	var acct tailAccount
	var disabled bool
	if err := tx.QueryRow(ctx, `
		SELECT a.disabled_at IS NOT NULL, COALESCE(a.email, ''), COALESCE(a.display_name, a.name, ''),
		       COALESCE(a.phone_e164, ''), COALESCE(a.username, ''),
		       EXISTS (SELECT 1 FROM account_passwords p WHERE p.account_id = a.id)
		FROM accounts a WHERE a.id = $1::uuid FOR UPDATE
	`, t.accountID).Scan(&disabled, &acct.email, &acct.name, &acct.phone, &acct.username, &acct.hasPassword); err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("lock sign-in account: %w", err)
	}
	if disabled {
		return GoogleSignInResult{}, tailAccount{}, ErrAccountDisabled
	}
	cancelledDeletion, err := cancelPendingAccountDeletion(ctx, tx, t.accountID)
	if err != nil {
		return GoogleSignInResult{}, tailAccount{}, err
	}
	if err := ensureSignInInstall(ctx, tx, t.installID, t.accountID); err != nil {
		return GoogleSignInResult{}, tailAccount{}, err
	}
	if t.sw.Platform == "web" {
		if _, err := tx.Exec(ctx, `UPDATE installs SET platform = 'web', app_version = 'web'
			WHERE install_id = $1 AND platform = 'unknown'`, t.installID); err != nil {
			return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("mark browser install: %w", err)
		}
	}
	if current := strings.TrimSpace(t.sw.CurrentAccountID); current != "" && !t.sw.AllowSwitch &&
		!strings.EqualFold(current, t.accountID) && !containsFold(t.sameAs, current) {
		return GoogleSignInResult{}, tailAccount{}, &DifferentAccountError{Email: acct.email}
	}
	epoch, err := newSessionEpoch()
	if err != nil {
		return GoogleSignInResult{}, tailAccount{}, err
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM auth_credentials
		WHERE install_id = $1
		  AND NOT (provider = $2 AND account_id IS NOT DISTINCT FROM $3::uuid)
	`, t.installID, t.provider, t.accountID); err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("clear stale auth credential: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE installs SET account_id = $2::uuid WHERE install_id = $1`,
		t.installID, t.accountID); err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("set install account_id: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_credentials (
			install_id, provider, provider_sub, account_id,
			email, name, picture_url, revoked_at, last_used_at, session_epoch
		) VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, NULL, NOW(), $8)
		ON CONFLICT (install_id, provider) DO UPDATE
		SET provider_sub  = EXCLUDED.provider_sub,
		    account_id    = EXCLUDED.account_id,
		    email         = COALESCE(NULLIF(EXCLUDED.email, ''), auth_credentials.email),
		    name          = COALESCE(NULLIF(EXCLUDED.name, ''), auth_credentials.name),
		    picture_url   = COALESCE(NULLIF(EXCLUDED.picture_url, ''), auth_credentials.picture_url),
		    revoked_at    = NULL,
		    last_used_at  = NOW(),
		    session_epoch = EXCLUDED.session_epoch
	`, t.installID, t.provider, t.providerSub, t.accountID, t.credEmail, t.credName, t.credPicture, epoch); err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("upsert auth credential: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE accounts SET last_login_at = NOW() WHERE id = $1::uuid`, t.accountID); err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("touch last login: %w", err)
	}

	defaultVaultID, err := resolveDefaultVault(ctx, tx, t.accountID, t.pending)
	if err != nil {
		return GoogleSignInResult{}, tailAccount{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("commit sign-in tx: %w", err)
	}
	sessionJWT, err := SignSessionEpoch(s.sessionSecret, t.accountID, t.installID, t.provider, t.providerSub, epoch)
	if err != nil {
		return GoogleSignInResult{}, tailAccount{}, fmt.Errorf("sign session jwt: %w", err)
	}
	return GoogleSignInResult{
		SessionJWT:        sessionJWT,
		AccountID:         t.accountID,
		DefaultVaultID:    defaultVaultID,
		DeletionCancelled: cancelledDeletion,
		User: User{
			Phone:       acct.phone,
			Username:    acct.username,
			HasPassword: acct.hasPassword,
		},
	}, acct, nil
}

func containsFold(list []string, v string) bool {
	for _, x := range list {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}

// resolveDefaultVault returns the account's canonical (oldest owned, live)
// kaata. With a pending registration (Google only) it also registers the
// phone's pre-sign-in kaata, unless the account already has one: an account
// owns at most one default vault, so a second device's local default is never
// registered next to it (the app adopts the returned id instead).
func resolveDefaultVault(ctx context.Context, tx pgx.Tx, accountID string, pending *PendingVaultRegistration) (*string, error) {
	var existingVault string
	err := tx.QueryRow(ctx, `
		SELECT v.vault_id::text
		FROM vault_members vm
		JOIN vaults v ON v.vault_id = vm.vault_id
		WHERE vm.account_id = $1::uuid
		  AND vm.role = 'owner'
		  AND vm.accepted_at IS NOT NULL
		  AND vm.revoked_at IS NULL
		  AND v.archived_at IS NULL
		ORDER BY v.created_at ASC
		LIMIT 1
	`, accountID).Scan(&existingVault)
	switch {
	case err == nil:
	case errors.Is(err, pgx.ErrNoRows):
		existingVault = ""
	default:
		return nil, fmt.Errorf("lookup default vault: %w", err)
	}

	if pending == nil || pending.ID == "" {
		if existingVault == "" {
			return nil, nil
		}
		return &existingVault, nil
	}
	if _, err := uuid.Parse(pending.ID); err != nil {
		return nil, fmt.Errorf("pending_vault_registration.id must be uuid: %w", err)
	}
	if strings.TrimSpace(pending.Name) == "" {
		return nil, errors.New("pending_vault_registration.name is required")
	}
	if existingVault != "" && existingVault != pending.ID {
		return &existingVault, nil
	}
	currency := pending.Currency
	if currency == "" {
		currency = "AFN"
	}
	createdAt := time.Now()
	if pending.CreatedAtMS > 0 {
		t := time.UnixMilli(pending.CreatedAtMS)
		// Clamp both ends: a client must not plant an "oldest" vault that
		// would become the canonical default.
		if !t.Before(time.Now().Add(-365*24*time.Hour)) && !t.After(time.Now().Add(5*time.Minute)) {
			createdAt = t
		}
	}
	existingOwner, err := upsertPendingVault(ctx, tx, accountID, pending, currency, createdAt)
	if err != nil {
		return nil, err
	}
	if existingOwner != accountID {
		return nil, errors.New("vault_id collides with vault owned by a different account")
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		SELECT $1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid
		WHERE NOT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
		)
	`, pending.ID, accountID); err != nil {
		return nil, fmt.Errorf("seed vault owner membership: %w", err)
	}
	id := pending.ID
	return &id, nil
}
