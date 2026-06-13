package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// AccountProfile carries the provider-asserted profile fields that are
// refreshed on the accounts row at every login. Empty fields are treated
// as "not asserted by this provider" and never overwrite existing values —
// a future phone-OTP login (which asserts no email/name/picture) must not
// blank out the profile a Google login previously filled in.
type AccountProfile struct {
	Email           string
	EmailNormalized string
	EmailVerified   bool
	Name            string
	PictureURL      string
}

// resolveOrCreateAccount is the single funnel every auth provider ends in
// (docs/sync-v2-architecture.md §4): resolve-or-create the account via
// account_identities, then refresh profile fields. A future
// /v1/auth/otp/verify handler needs nothing more than
// resolveOrCreateAccount(ctx, tx, "phone_otp", e164, profile).
//
// Resolution order:
//
//  1. account_identities by (provider, provider_sub) — the canonical path.
//     For google hits this also backfills accounts.google_sub when NULL
//     (an OTP-first account that later linked Google), keeping the row
//     resolvable by a rolled-back google_sub-only binary.
//  2. provider == "google" only: legacy accounts.google_sub lookup. A hit
//     means this account predates migration 013's backfill window on this
//     row (e.g. created by a rolled-back binary that only dual-wrote
//     google_sub); we SELF-HEAL by inserting the missing identity row.
//  3. Full miss: create the account + identity row in this tx.
//     DUAL-WRITE: new google accounts still get accounts.google_sub for
//     one release so a binary rollback keeps resolving them.
//
// Runs inside the caller's transaction so account creation is atomic with
// the rest of the sign-in pipeline (credentials, install linkage, vault
// registration).
//
// Returns the account id as a string (the codebase convention for account
// ids on service boundaries), and created=true when a brand-new account
// row was minted.
func resolveOrCreateAccount(
	ctx context.Context,
	tx pgx.Tx,
	provider, providerSub string,
	profile AccountProfile,
) (accountID string, created bool, err error) {
	if provider == "" || providerSub == "" {
		return "", false, errors.New("provider and provider_sub are required")
	}

	// (1) Canonical lookup.
	err = tx.QueryRow(ctx, `
		SELECT account_id::text
		FROM account_identities
		WHERE provider = $1 AND provider_sub = $2
	`, provider, providerSub).Scan(&accountID)
	switch {
	case err == nil:
		// DUAL-WRITE (google only, rollback safety): an account created by
		// another provider first (e.g. future phone-OTP) that later linked
		// Google resolves here via the identity row while accounts.google_sub
		// is still NULL. A rolled-back binary (pre-013, google_sub-only
		// resolution) would then mint a duplicate account for the same
		// Google subject. Backfill it; COALESCE never overwrites an
		// existing value.
		if provider == ProviderGoogle {
			if _, err := tx.Exec(ctx, `
				UPDATE accounts SET google_sub = COALESCE(google_sub, $1)
				WHERE id = $2::uuid
			`, providerSub, accountID); err != nil {
				return "", false, fmt.Errorf("dual-write google_sub: %w", err)
			}
		}
		if err := touchIdentityAndProfile(ctx, tx, accountID, provider, providerSub, profile); err != nil {
			return "", false, err
		}
		return accountID, false, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return "", false, fmt.Errorf("lookup account identity: %w", err)
	}

	// (2) Legacy fallback — google only.
	if provider == ProviderGoogle {
		err = tx.QueryRow(ctx, `
			SELECT id::text FROM accounts WHERE google_sub = $1
		`, providerSub).Scan(&accountID)
		switch {
		case err == nil:
			// Self-heal: materialize the identity row migration 013 would
			// have backfilled. ON CONFLICT guards the (rare) concurrent
			// sign-in that healed it between our two reads.
			if _, err := tx.Exec(ctx, `
				INSERT INTO account_identities (account_id, provider, provider_sub, verified_at, created_at)
				VALUES ($1::uuid, $2, $3, NOW(), NOW())
				ON CONFLICT (provider, provider_sub) DO NOTHING
			`, accountID, provider, providerSub); err != nil {
				return "", false, fmt.Errorf("self-heal account identity: %w", err)
			}
			if err := touchIdentityAndProfile(ctx, tx, accountID, provider, providerSub, profile); err != nil {
				return "", false, err
			}
			return accountID, false, nil
		case !errors.Is(err, pgx.ErrNoRows):
			return "", false, fmt.Errorf("legacy google_sub lookup: %w", err)
		}
	}

	// (3) Create. For google we keep dual-writing accounts.google_sub this
	// release (rollback safety) and reuse its UNIQUE constraint as the race
	// arbiter — two concurrent first sign-ins converge on one row exactly
	// like the pre-M1 upsert did.
	if provider == ProviderGoogle {
		if err := tx.QueryRow(ctx, `
			INSERT INTO accounts (id, google_sub, email, email_normalized, email_verified, name, picture_url, last_login_at)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())
			ON CONFLICT (google_sub) DO UPDATE
			SET last_login_at = NOW()
			RETURNING id::text
		`, providerSub, profile.Email, profile.EmailNormalized, profile.EmailVerified,
			profile.Name, profile.PictureURL).Scan(&accountID); err != nil {
			return "", false, fmt.Errorf("create google account: %w", err)
		}
	} else {
		if err := tx.QueryRow(ctx, `
			INSERT INTO accounts (id, email, email_normalized, email_verified, name, picture_url, last_login_at)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())
			RETURNING id::text
		`, profile.Email, profile.EmailNormalized, profile.EmailVerified,
			profile.Name, profile.PictureURL).Scan(&accountID); err != nil {
			return "", false, fmt.Errorf("create %s account: %w", provider, err)
		}
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO account_identities (account_id, provider, provider_sub, verified_at, created_at)
		VALUES ($1::uuid, $2, $3, NOW(), NOW())
		ON CONFLICT (provider, provider_sub) DO NOTHING
	`, accountID, provider, providerSub)
	if err != nil {
		return "", false, fmt.Errorf("create account identity: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Identity row already exists: we lost a creation race. A google
		// race-loser DOES reach this branch — but its accounts insert above
		// already arbitrated on the google_sub UNIQUE and returned the
		// winner's row, so winner == accountID and the orphan DELETE below
		// is skipped. For non-google providers there is no such arbiter:
		// the loser minted a genuinely orphan accounts row — adopt the
		// winner's account and drop the orphan.
		var winner string
		if err := tx.QueryRow(ctx, `
			SELECT account_id::text FROM account_identities
			WHERE provider = $1 AND provider_sub = $2
		`, provider, providerSub).Scan(&winner); err != nil {
			return "", false, fmt.Errorf("re-read raced identity: %w", err)
		}
		if winner != accountID {
			if _, err := tx.Exec(ctx, `DELETE FROM accounts WHERE id = $1::uuid`, accountID); err != nil {
				return "", false, fmt.Errorf("drop orphan account after identity race: %w", err)
			}
			accountID = winner
		}
		if err := touchIdentityAndProfile(ctx, tx, accountID, provider, providerSub, profile); err != nil {
			return "", false, err
		}
		return accountID, false, nil
	}

	if err := touchIdentityAndProfile(ctx, tx, accountID, provider, providerSub, profile); err != nil {
		return "", false, err
	}
	return accountID, true, nil
}

// touchIdentityAndProfile stamps verified_at on the identity (this provider
// just re-verified the subject) and refreshes the accounts profile fields.
// Non-empty wins: a provider that doesn't assert a field leaves the stored
// value alone; email_verified can only be raised, never lowered, by a login.
func touchIdentityAndProfile(
	ctx context.Context,
	tx pgx.Tx,
	accountID, provider, providerSub string,
	profile AccountProfile,
) error {
	if _, err := tx.Exec(ctx, `
		UPDATE account_identities SET verified_at = NOW()
		WHERE provider = $1 AND provider_sub = $2
	`, provider, providerSub); err != nil {
		return fmt.Errorf("touch identity verified_at: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE accounts
		SET email            = COALESCE(NULLIF($2, ''), email),
		    email_normalized = COALESCE(NULLIF($3, ''), email_normalized),
		    email_verified   = email_verified OR $4,
		    name             = COALESCE(NULLIF($5, ''), name),
		    picture_url      = COALESCE(NULLIF($6, ''), picture_url),
		    last_login_at    = NOW()
		WHERE id = $1::uuid
	`, accountID, profile.Email, profile.EmailNormalized, profile.EmailVerified,
		profile.Name, profile.PictureURL); err != nil {
		return fmt.Errorf("refresh account profile: %w", err)
	}
	return nil
}
