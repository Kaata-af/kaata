package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/idtoken"
)

const ProviderGoogle = "google"
const ProviderApple = "apple"

// maxTokenAge is a GENEROUS outer bound on a Google ID token's `iat` — set to
// the token's own lifetime so it defers entirely to idtoken.Validate's `exp`
// check (the authoritative freshness guard, enforced against server time). It
// is NOT a tight "minted within minutes" replay window anymore: that broke
// real sign-ins whenever the BACKEND host clock drifted ahead of real time
// (`iat` is Google's accurate timestamp, so `time.Since(iat)` ballooned and
// every token 401'd as "stale" — the exact production outage). At 1h this can
// never reject a token Validate already accepted; it only fires on gross host
// clock skew, and then the logged age says so. Fix the host's NTP, not this.
const maxTokenAge = time.Hour

// maxClockSkewAhead tolerates a token `iat` that looks future-dated from the
// server (host clock running behind). Generous (15m) so ordinary skew never
// blocks sign-in, while still rejecting an implausibly future-dated forgery.
const maxClockSkewAhead = 15 * time.Minute

type Service struct {
	pool              *pgxpool.Pool
	googleWebClientID string
	appleClientID     string
	sessionSecret     string
}

func NewService(pool *pgxpool.Pool, googleWebClientID, sessionSecret string) *Service {
	return &Service{
		pool:              pool,
		googleWebClientID: googleWebClientID,
		sessionSecret:     sessionSecret,
	}
}

// SetAppleClientID wires the Apple audience (the app's bundle id) for
// /v1/auth/apple. When empty, Apple sign-in is rejected. Called at startup from
// config so NewService's signature (and its existing callers) stay unchanged.
func (s *Service) SetAppleClientID(id string) { s.appleClientID = id }

// User is the display block returned to the mobile client.
type User struct {
	Sub        string `json:"sub,omitempty"`
	Email      string `json:"email,omitempty"`
	Name       string `json:"name,omitempty"`
	PictureURL string `json:"picture_url,omitempty"`
	// Phone is the account-level phone the shopkeeper saved (E.164), returned so
	// a reinstalled device can prefill it on sign-in. Empty when none stored.
	// Unlike email/name/picture (Google-asserted) this is user-supplied via
	// PUT /v1/account/phone — Google sign-in never provides a phone number.
	Phone string `json:"phone,omitempty"`
}

// PendingVaultRegistration lets a mobile install that already minted
// its default vault locally (the common Phase 2 case via migration 007)
// register that vault with the server in the SAME round-trip as sign-in.
type PendingVaultRegistration struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Currency    string `json:"currency,omitempty"`
	CreatedAtMS int64  `json:"created_at_ms,omitempty"`
}

// GoogleSignInResult is the response shape for POST /v1/auth/google.
type GoogleSignInResult struct {
	SessionJWT     string  `json:"session_jwt"`
	AccountID      string  `json:"account_id"`
	DefaultVaultID *string `json:"default_vault_id"`
	User           User    `json:"user"`
}

// SignInWithGoogle is the full Phase 2 sign-in pipeline:
//
//  1. Verify Google ID token (signature, audience, expiry, email_verified, iat freshness)
//  2. Resolve-or-create the account via account_identities (M1 — see
//     resolveOrCreateAccount in identity.go; google_sub is still
//     dual-written for new accounts this release)
//  3. Ensure installs row exists
//  4. Upsert auth_credentials row keyed by (install_id, provider), bound to account_id
//  5. Optionally register a pending vault as owned by this account
//  6. Issue 30-day session JWT
func (s *Service) SignInWithGoogle(
	ctx context.Context,
	installID, idTokenStr string,
	pending *PendingVaultRegistration,
) (GoogleSignInResult, error) {
	if s.googleWebClientID == "" {
		return GoogleSignInResult{}, errors.New("google web client id not configured")
	}

	// (1) Verify the Google ID token.
	payload, err := idtoken.Validate(ctx, idTokenStr, s.googleWebClientID)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("verify google id token: %w", err)
	}

	// Pin the issuer. idtoken.Validate checks signature/exp/aud but NOT iss, and
	// its ES256 branch also trusts Google's IAP cert endpoint (whose tokens carry
	// iss=https://cloud.google.com/iap) — a different Google signing domain. Only
	// real Google Sign-In tokens carry the accounts.google.com issuer.
	switch payload.Issuer {
	case "accounts.google.com", "https://accounts.google.com":
	default:
		return GoogleSignInResult{}, fmt.Errorf("google id token has unexpected issuer %q", payload.Issuer)
	}

	providerSub := payload.Subject
	if providerSub == "" {
		return GoogleSignInResult{}, errors.New("google id token missing sub claim")
	}

	// email_verified gate. The id_token carries this claim from Google's
	// own verification. If false, the email is attacker-controlled.
	if v, ok := payload.Claims["email_verified"].(bool); !ok || !v {
		return GoogleSignInResult{}, errors.New("google account email is not verified")
	}

	// iat sanity: Google always sets `iat`; absence indicates a malformed/forged
	// token slipping past the signature check (defense in depth). We do NOT use a
	// tight "minted within minutes" window anymore — it was rejecting legitimate
	// sign-ins whenever the BACKEND host clock drifted ahead of real time (NTP),
	// because `iat` is Google's accurate timestamp and `time.Since(iat)` then
	// looks large. The authoritative freshness guard is the token's `exp`, which
	// idtoken.Validate already enforces against server time (Google tokens live
	// ~1h). maxTokenAge is kept only as a generous outer bound (≈ token lifetime)
	// so it can never reject a token that Validate already accepted; if it ever
	// DOES fire, the logged age tells us the host clock is grossly skewed.
	iatAny, ok := payload.Claims["iat"].(float64)
	if !ok {
		return GoogleSignInResult{}, errors.New("google id token missing iat claim")
	}
	iat := time.Unix(int64(iatAny), 0)
	age := time.Since(iat)
	// Reject an implausibly future-dated token (forgery / gross skew), with a
	// tolerant window for ordinary clock skew. Log the actual age for diagnosis.
	if age < -maxClockSkewAhead {
		return GoogleSignInResult{}, fmt.Errorf(
			"google id token iat is in the future (age %s; host clock likely behind)", age)
	}
	if age > maxTokenAge {
		return GoogleSignInResult{}, fmt.Errorf(
			"google id token is stale (iat age %s > %s; host clock likely ahead / NTP)", age, maxTokenAge)
	}

	email, _ := payload.Claims["email"].(string)
	name, _ := payload.Claims["name"].(string)
	picture, _ := payload.Claims["picture"].(string)
	emailNormalized := normalizeEmail(email)

	// (2-5) Single transaction.
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// (2) Resolve-or-create the account via account_identities (M1).
	// Profile fields (email/name/picture, last_login_at) are refreshed on
	// every login inside the helper.
	accountID, _, err := resolveOrCreateAccount(ctx, tx, ProviderGoogle, providerSub, AccountProfile{
		Email:           email,
		EmailNormalized: emailNormalized,
		EmailVerified:   true,
		Name:            name,
		PictureURL:      picture,
	})
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("resolve account: %w", err)
	}

	// Read the account-level phone (set via PUT /v1/account/phone on a prior
	// device) so the response can prefill it on a reinstalled device. COALESCE
	// to '' so a NULL column scans cleanly into the non-pointer string.
	var accountPhone string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(phone_e164, '') FROM accounts WHERE id = $1::uuid
	`, accountID).Scan(&accountPhone); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("read account phone: %w", err)
	}

	// (3) Ensure installs row exists.
	if _, err := tx.Exec(ctx, `
		INSERT INTO installs (install_id, app_version, platform)
		VALUES ($1, 'unknown', 'unknown')
		ON CONFLICT (install_id) DO NOTHING
	`, installID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("ensure installs row: %w", err)
	}

	// Also stamp account_id on the installs row (Phase 2 linkage).
	//
	// If a DIFFERENT account previously owned this install (rare: user
	// signed out of A then into B on the same phone), we delete the prior
	// auth_credentials row so the old account can't keep refreshing JWTs.
	// The new credential row is inserted below in step (4).
	if _, err := tx.Exec(ctx, `
		DELETE FROM auth_credentials
		WHERE install_id = $1
		  AND provider = $2
		  AND account_id IS DISTINCT FROM $3::uuid
	`, installID, ProviderGoogle, accountID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("clear stale auth credential: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE installs SET account_id = $2::uuid WHERE install_id = $1
	`, installID, accountID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("set install account_id: %w", err)
	}

	// (4) Upsert auth_credentials.
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_credentials (
			install_id, provider, provider_sub, account_id,
			email, name, picture_url, revoked_at, last_used_at
		) VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, NULL, NOW())
		ON CONFLICT (install_id, provider) DO UPDATE
		SET provider_sub = EXCLUDED.provider_sub,
		    account_id   = EXCLUDED.account_id,
		    email        = EXCLUDED.email,
		    name         = EXCLUDED.name,
		    picture_url  = EXCLUDED.picture_url,
		    revoked_at   = NULL,
		    last_used_at = NOW()
	`, installID, ProviderGoogle, providerSub, accountID, email, name, picture); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("upsert auth credential: %w", err)
	}

	// (5) Pending vault registration.
	//
	// Canonicalization rule: an account owns AT MOST one default vault. If
	// the account already has an owned vault and the mobile sends a DIFFERENT
	// pending vault_id (signing in on a second device that minted its own
	// local vault, for example), we DO NOT create a second vault — that
	// silently bifurcates the account. Instead we return the existing default
	// vault id and let mobile reconcile (adopt the canonical id, abandon the
	// local one). The same logic protects the "two devices signing in
	// concurrently" race.
	var defaultVaultID *string

	// Look up the existing canonical (oldest) vault owned by this account.
	// Independent of whether the mobile sent a pending block.
	var existingVault string
	err = tx.QueryRow(ctx, `
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
		// Account already has a default vault. We'll return it as the
		// canonical id, regardless of whether mobile sent a pending block.
	case errors.Is(err, pgx.ErrNoRows):
		existingVault = ""
	default:
		return GoogleSignInResult{}, fmt.Errorf("lookup default vault: %w", err)
	}

	if pending != nil && pending.ID != "" {
		if _, err := uuid.Parse(pending.ID); err != nil {
			return GoogleSignInResult{}, fmt.Errorf("pending_vault_registration.id must be uuid: %w", err)
		}
		if strings.TrimSpace(pending.Name) == "" {
			return GoogleSignInResult{}, errors.New("pending_vault_registration.name is required")
		}

		// If the account already has a canonical vault AND the pending id
		// is different, refuse the registration and surface the existing
		// id so the mobile client adopts it. Avoids silent bifurcation
		// across two devices that each minted their own local default.
		if existingVault != "" && existingVault != pending.ID {
			id := existingVault
			defaultVaultID = &id
		} else {
			currency := pending.Currency
			if currency == "" {
				currency = "AFN"
			}
			var createdAt time.Time
			if pending.CreatedAtMS > 0 {
				t := time.UnixMilli(pending.CreatedAtMS)
				// Clamp the lower bound too — a malicious / buggy client
				// can otherwise plant a vault with created_at = epoch which
				// then sorts as "oldest" and becomes the canonical default
				// even when a legitimate vault was registered first.
				minAllowed := time.Now().Add(-365 * 24 * time.Hour)
				if t.Before(minAllowed) {
					createdAt = time.Now()
				} else if t.After(time.Now().Add(5 * time.Minute)) {
					createdAt = time.Now()
				} else {
					createdAt = t
				}
			} else {
				createdAt = time.Now()
			}

			var existingOwner string
			err := tx.QueryRow(ctx, `
				INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, created_at)
				VALUES ($1::uuid, $2::uuid, $3, $4, 0, $5)
				ON CONFLICT (vault_id) DO UPDATE
				SET vault_id = vaults.vault_id
				RETURNING owner_account_id::text
			`, pending.ID, accountID, pending.Name, currency, createdAt).Scan(&existingOwner)
			if err != nil {
				return GoogleSignInResult{}, fmt.Errorf("upsert vault: %w", err)
			}
			if existingOwner != accountID {
				return GoogleSignInResult{}, errors.New("vault_id collides with vault owned by a different account")
			}

			// Seed owner membership row. Idempotent via partial unique index.
			if _, err := tx.Exec(ctx, `
				INSERT INTO vault_members (
					vault_id, account_id, role, invited_at, accepted_at, invited_by
				)
				SELECT $1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid
				WHERE NOT EXISTS (
					SELECT 1 FROM vault_members
					 WHERE vault_id = $1::uuid AND account_id = $2::uuid
					   AND revoked_at IS NULL
				)
			`, pending.ID, accountID); err != nil {
				return GoogleSignInResult{}, fmt.Errorf("seed vault owner membership: %w", err)
			}

			id := pending.ID
			defaultVaultID = &id
		}
	} else if existingVault != "" {
		id := existingVault
		defaultVaultID = &id
	}
	// no pending block AND no existing vault → mobile will POST /v1/vaults next.

	if err := tx.Commit(ctx); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("commit sign-in tx: %w", err)
	}

	// (6) Issue session JWT.
	sessionJWT, err := SignSession(s.sessionSecret, accountID, installID, ProviderGoogle, providerSub)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("sign session jwt: %w", err)
	}

	return GoogleSignInResult{
		SessionJWT:     sessionJWT,
		AccountID:      accountID,
		DefaultVaultID: defaultVaultID,
		User: User{
			Sub:        providerSub,
			Email:      email,
			Name:       name,
			PictureURL: picture,
			Phone:      accountPhone,
		},
	}, nil
}

// SignInWithApple verifies an Apple identity token and resolves-or-creates the
// account, mirroring SignInWithGoogle for provider='apple'. It intentionally
// does NOT take a pending_vault_registration: an Apple-onboarding install
// registers its default vault via the existing POST /v1/vaults follow-up (the
// same path the no-pending Google branch uses), which keeps this small and
// avoids duplicating the vault-canonicalisation logic in the working Google path.
//
// name/email are present only on the FIRST Apple sign-in for a given Apple ID
// (Apple omits them afterwards), and email may be a private-relay address — so
// we never clobber a stored non-empty profile with a later empty one.
func (s *Service) SignInWithApple(
	ctx context.Context,
	installID, idTokenStr, displayName string,
) (GoogleSignInResult, error) {
	if s.appleClientID == "" {
		return GoogleSignInResult{}, errors.New("apple client id not configured")
	}
	payload, err := VerifyAppleIDToken(ctx, idTokenStr, s.appleClientID)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("verify apple id token: %w", err)
	}
	providerSub := payload.Sub

	email := payload.Email
	emailNormalized := normalizeEmail(email)
	name := strings.TrimSpace(displayName)

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	accountID, _, err := resolveOrCreateAccount(ctx, tx, ProviderApple, providerSub, AccountProfile{
		Email:           email,
		EmailNormalized: emailNormalized,
		EmailVerified:   payload.EmailVerified,
		Name:            name,
		PictureURL:      "",
	})
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("resolve account: %w", err)
	}

	var accountPhone string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(phone_e164, '') FROM accounts WHERE id = $1::uuid
	`, accountID).Scan(&accountPhone); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("read account phone: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO installs (install_id, app_version, platform)
		VALUES ($1, 'unknown', 'unknown')
		ON CONFLICT (install_id) DO NOTHING
	`, installID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("ensure installs row: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM auth_credentials
		WHERE install_id = $1 AND provider = $2 AND account_id IS DISTINCT FROM $3::uuid
	`, installID, ProviderApple, accountID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("clear stale auth credential: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE installs SET account_id = $2::uuid WHERE install_id = $1
	`, installID, accountID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("set install account_id: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_credentials (
			install_id, provider, provider_sub, account_id,
			email, name, picture_url, revoked_at, last_used_at
		) VALUES ($1, $2, $3, $4::uuid, $5, $6, '', NULL, NOW())
		ON CONFLICT (install_id, provider) DO UPDATE
		SET provider_sub = EXCLUDED.provider_sub,
		    account_id   = EXCLUDED.account_id,
		    email        = COALESCE(NULLIF(EXCLUDED.email, ''), auth_credentials.email),
		    name         = COALESCE(NULLIF(EXCLUDED.name, ''), auth_credentials.name),
		    revoked_at   = NULL,
		    last_used_at = NOW()
	`, installID, ProviderApple, providerSub, accountID, email, name); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("upsert auth credential: %w", err)
	}

	// Return the account's existing canonical vault, if any. No pending-vault
	// creation here — the client POSTs /v1/vaults after onboarding.
	var defaultVaultID *string
	var existingVault string
	err = tx.QueryRow(ctx, `
		SELECT v.vault_id::text
		FROM vault_members vm
		JOIN vaults v ON v.vault_id = vm.vault_id
		WHERE vm.account_id = $1::uuid AND vm.role = 'owner'
		  AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		  AND v.archived_at IS NULL
		ORDER BY v.created_at ASC
		LIMIT 1
	`, accountID).Scan(&existingVault)
	switch {
	case err == nil:
		id := existingVault
		defaultVaultID = &id
	case errors.Is(err, pgx.ErrNoRows):
		// no vault yet — client registers via POST /v1/vaults
	default:
		return GoogleSignInResult{}, fmt.Errorf("lookup default vault: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("commit sign-in tx: %w", err)
	}

	sessionJWT, err := SignSession(s.sessionSecret, accountID, installID, ProviderApple, providerSub)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("sign session jwt: %w", err)
	}
	return GoogleSignInResult{
		SessionJWT:     sessionJWT,
		AccountID:      accountID,
		DefaultVaultID: defaultVaultID,
		User: User{
			Sub:   providerSub,
			Email: email,
			Name:  name,
			Phone: accountPhone,
		},
	}, nil
}

// UpdateAccountPhone upserts the account-level phone (E.164), or clears it when
// phone is empty. Stored on accounts.phone_e164 so it round-trips to a
// reinstalled device via the /v1/auth/google response. Identity/display only —
// never an ACL key — so no uniqueness or format constraint here (the client
// normalizes before sending).
func (s *Service) UpdateAccountPhone(ctx context.Context, accountID, phone string) error {
	var val any
	if strings.TrimSpace(phone) == "" {
		val = nil
	} else {
		val = phone
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE accounts SET phone_e164 = $2 WHERE id = $1::uuid
	`, accountID, val); err != nil {
		return fmt.Errorf("update account phone: %w", err)
	}
	return nil
}

// DeleteAccount permanently erases an account and the data it solely owns, for
// the in-app "Delete account" flow (Play + Apple both require in-app account
// deletion once the app supports account creation). One transaction, in FK-safe
// order:
//   - deletes vaults the account OWNS and everything under them: events first
//     (events -> vaults is RESTRICT, not CASCADE), then the vault row (whose
//     ON DELETE CASCADE clears members / snapshots / issued creds / pair
//     tokens / device bindings / audit rows — vault_devices joined the
//     cascade in migration 031 after its plain FK broke every owner's
//     account deletion in prod);
//   - for vaults owned by OTHERS, removes the account's membership AND its
//     device bindings, and ANONYMISES the events it authored (NULL
//     account_id) rather than deleting them — that ledger content belongs
//     to the other owner, not this user. Audit rows there survive with the
//     principal SET NULL by FK action (031), matching the invited_by /
//     revoked_by nulling below;
//   - clears the account's identity from its installs (self name/phone/shop +
//     account_id) and deletes their crash reports (the install rows live on as
//     anonymous installs);
//   - nulls the invited_by / revoked_by / pending_delete_by back-references
//     (all RESTRICT FKs to accounts) that would otherwise block the delete;
//   - deletes the account row, whose ON DELETE CASCADE clears auth_credentials,
//     account_identities, and vault_credentials_issued / vault_pair_tokens it
//     issued.
//
// After commit the account's still-valid JWTs stop authorising: the credential
// row is gone, so the revocation check treats them as revoked.
func (s *Service) DeleteAccount(ctx context.Context, accountID string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	stmts := []struct {
		desc string
		sql  string
	}{
		{"delete owned-vault events", `
			DELETE FROM events
			 WHERE vault_id IN (SELECT vault_id FROM vaults WHERE owner_account_id = $1::uuid)`},
		{"delete owned vaults", `DELETE FROM vaults WHERE owner_account_id = $1::uuid`},
		{"anonymise authored events", `UPDATE events SET account_id = NULL WHERE account_id = $1::uuid`},
		{"delete memberships", `DELETE FROM vault_members WHERE account_id = $1::uuid`},
		{"delete device bindings", `DELETE FROM vault_devices WHERE account_id = $1::uuid`},
		{"null invited_by", `UPDATE vault_members SET invited_by = NULL WHERE invited_by = $1::uuid`},
		{"null revoked_by", `UPDATE vault_members SET revoked_by = NULL WHERE revoked_by = $1::uuid`},
		{"null pending_delete_by", `UPDATE vaults SET pending_delete_by = NULL, pending_delete_at = NULL WHERE pending_delete_by = $1::uuid`},
		{"delete crash reports", `
			DELETE FROM crash_reports
			 WHERE install_id IN (SELECT install_id FROM installs WHERE account_id = $1::uuid)`},
		{"clear install identity", `
			UPDATE installs
			   SET account_id = NULL, self_name = NULL, self_phone = NULL, shop_name = NULL
			 WHERE account_id = $1::uuid`},
		{"delete account", `DELETE FROM accounts WHERE id = $1::uuid`},
	}
	for _, st := range stmts {
		if _, err := tx.Exec(ctx, st.sql, accountID); err != nil {
			return fmt.Errorf("%s: %w", st.desc, err)
		}
	}
	return tx.Commit(ctx)
}

// SignOut removes the auth_credentials row for (install_id, provider).
func (s *Service) SignOut(ctx context.Context, installID, provider string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM auth_credentials
		WHERE install_id = $1 AND provider = $2
	`, installID, provider)
	if err != nil {
		return fmt.Errorf("delete auth credential: %w", err)
	}
	return nil
}

// CheckCredentialRevoked returns (revoked, error).
//
// A missing row counts as revoked — a credential that was deleted via SignOut
// should not authorize further requests, even if the JWT hasn't expired yet.
//
// The check is bound to the JWT's account_id: after an account switch the
// (install_id, provider) row is DELETEd and re-inserted for the NEW account, so
// a leaked or residual JWT carrying the OLD account_id must not keep authorizing
// (and self-refreshing) against the new binding. A NULL stored account_id
// (legacy row) is treated as matching, for back-compat.
func (s *Service) CheckCredentialRevoked(ctx context.Context, installID, provider, accountID string) (bool, error) {
	var revokedAt *time.Time
	var storedAccountID *string
	err := s.pool.QueryRow(ctx, `
		SELECT revoked_at, account_id::text
		FROM auth_credentials
		WHERE install_id = $1 AND provider = $2
	`, installID, provider).Scan(&revokedAt, &storedAccountID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return true, nil
	case err != nil:
		return false, fmt.Errorf("lookup auth credential: %w", err)
	}
	if storedAccountID != nil && accountID != "" && *storedAccountID != accountID {
		return true, nil
	}
	return revokedAt != nil, nil
}

// IssueRefreshJWT mints a new session JWT for an existing valid claim.
func (s *Service) IssueRefreshJWT(claims *SessionClaims) (string, error) {
	return SignSession(s.sessionSecret, claims.AccountID, claims.InstallID, claims.Provider, claims.ProviderSub)
}

// normalizeEmail mirrors Google's "dots and case don't matter" rule for
// gmail addresses, and lowercases everything else.
func normalizeEmail(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	at := strings.LastIndex(s, "@")
	if at < 0 {
		return s
	}
	local, domain := s[:at], s[at:]
	if domain == "@gmail.com" || domain == "@googlemail.com" {
		local = strings.ReplaceAll(local, ".", "")
		if i := strings.Index(local, "+"); i >= 0 {
			local = local[:i]
		}
		return local + "@gmail.com"
	}
	return local + domain
}
