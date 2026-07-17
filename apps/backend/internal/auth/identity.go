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
//     1.5. HEAL: when the resolved account is a HOLLOW duplicate (no active
//     vault membership, owns no vaults) and another account with the SAME
//     verified email holds real content, adopt that account — repoint this
//     account's identities/credentials/installs onto it and resolve to it.
//     This heals the pre-linking era's duplicates (e.g. an Apple sign-in
//     that minted an empty account shadowing the user's Google account).
//  2. provider == "google" only: legacy accounts.google_sub lookup. A hit
//     means this account predates migration 013's backfill window on this
//     row (e.g. created by a rolled-back binary that only dual-wrote
//     google_sub); we SELF-HEAL by inserting the missing identity row.
//     2.5. EMAIL LINK: a first-ever (provider, provider_sub) whose token
//     asserts a VERIFIED email matching an existing verified-email account
//     links into that account (new identity row) instead of minting a
//     duplicate — same email E on Google (Android) and Apple (iOS) must
//     reach the same vaults. Guarded: both sides email-verified, and the
//     target must not already hold an identity for this provider (a
//     same-provider different-sub match means a recycled/reissued email —
//     e.g. a workspace address handed to a new employee — never link those).
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
		// (1.5) HEAL a hollow duplicate: if this identity points at an
		// account with no content while a verified-same-email account WITH
		// content exists, adopt the content-bearing account. Never lossy —
		// the hollow account has nothing to lose by construction, and only
		// verified emails on both sides can trigger it.
		if adopted, aerr := adoptHollowDuplicate(ctx, tx, accountID, provider, providerSub, profile); aerr != nil {
			return "", false, aerr
		} else if adopted != "" {
			accountID = adopted
		}
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

	// (2.5) EMAIL LINK: first sign-in for this (provider, provider_sub), but
	// the token asserts a VERIFIED email an existing verified-email account
	// already holds — link the new identity into it instead of minting a
	// duplicate (the "Google on Android, Apple on iOS, same email, same
	// vaults" contract). linkableAccountByVerifiedEmail encodes the safety
	// rails (verified-only, never same-provider — see its doc).
	if profile.EmailVerified && profile.EmailNormalized != "" {
		linkID, lerr := linkableAccountByVerifiedEmail(
			ctx, tx, provider, profile.EmailNormalized, "", false)
		if lerr != nil {
			return "", false, lerr
		}
		if linkID != "" {
			tag, ierr := tx.Exec(ctx, `
				INSERT INTO account_identities (account_id, provider, provider_sub, verified_at, created_at)
				VALUES ($1::uuid, $2, $3, NOW(), NOW())
				ON CONFLICT (provider, provider_sub) DO NOTHING
			`, linkID, provider, providerSub)
			if ierr != nil {
				return "", false, fmt.Errorf("link account identity by email: %w", ierr)
			}
			if tag.RowsAffected() == 0 {
				// Concurrent sign-in won the (provider, provider_sub) slot —
				// adopt whatever it resolved/created; no orphan to clean up
				// because we created no accounts row on this path.
				if err := tx.QueryRow(ctx, `
					SELECT account_id::text FROM account_identities
					WHERE provider = $1 AND provider_sub = $2
				`, provider, providerSub).Scan(&linkID); err != nil {
					return "", false, fmt.Errorf("re-read raced email link: %w", err)
				}
			}
			// DUAL-WRITE parity with step (1): a google identity linked into
			// an Apple/OTP-first account keeps the row resolvable by a
			// rolled-back google_sub-only binary. COALESCE never overwrites.
			if provider == ProviderGoogle {
				if _, err := tx.Exec(ctx, `
					UPDATE accounts SET google_sub = COALESCE(google_sub, $1)
					WHERE id = $2::uuid
				`, providerSub, linkID); err != nil {
					return "", false, fmt.Errorf("dual-write google_sub on email link: %w", err)
				}
			}
			if err := touchIdentityAndProfile(ctx, tx, linkID, provider, providerSub, profile); err != nil {
				return "", false, err
			}
			return linkID, false, nil
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

// linkableAccountByVerifiedEmail finds the account a new (provider, sub)
// identity should attach to instead of minting a duplicate. Safety rails —
// email is a LINKING HINT here, never an authorization key (the canonical key
// stays (provider, provider_sub), per 004_auth_credentials.sql):
//
//   - Both sides must be email-verified: the incoming token's claim is the
//     caller's gate; the stored account's email_verified is checked here. An
//     unverified email is attacker-typable and must never grant linking.
//   - The target must NOT already hold an identity for the incoming provider,
//     and (google) must not carry a different legacy google_sub: a
//     same-provider, different-sub match on one email means the address was
//     recycled (e.g. a workspace email reissued to a new employee) — linking
//     would hand the new person the old person's vaults. Cross-provider only.
//     KNOWN RESIDUAL (accepted): the recycled-address vector still exists
//     CROSS-provider — an old Apple ID keeps asserting a recycled workspace
//     email as verified (Apple attests verification at add-time, not current
//     mailbox control), so its next sign-in could link into the address's new
//     holder's Google account. This is the standard one-account-per-verified-
//     email trade-off (Firebase/GitHub semantics); Kaata's users are
//     overwhelmingly on personal Gmail (never recycled) and Apple private-
//     relay addresses can never collide. Closing it fully needs an in-band
//     re-verification (email OTP) we don't have infrastructure for.
//   - Deterministic pick when several rows share the email (legal — the
//     column is non-unique): content-bearing accounts first (an active vault
//     membership), then oldest. requireContent=true additionally REQUIRES the
//     target to have content (an active membership or an owned vault) — used
//     by the hollow-duplicate healer, where moving identities is only
//     justified by reaching real data.
//
// excludeAccountID ("" = none) removes a known account from consideration.
// Returns "" when no linkable account exists.
func linkableAccountByVerifiedEmail(
	ctx context.Context,
	tx pgx.Tx,
	provider, emailNormalized, excludeAccountID string,
	requireContent bool,
) (string, error) {
	var linkID string
	err := tx.QueryRow(ctx, `
		SELECT a.id::text
		  FROM accounts a
		 WHERE a.email_normalized = $2
		   AND a.email_verified
		   AND ($3 = '' OR a.id::text != $3)
		   AND NOT EXISTS (
		     SELECT 1 FROM account_identities ai
		      WHERE ai.account_id = a.id AND ai.provider = $1
		   )
		   AND ($1 != 'google' OR a.google_sub IS NULL)
		   AND (NOT $4::bool OR (
		     EXISTS (
		       SELECT 1 FROM vault_members vm
		        WHERE vm.account_id = a.id
		          AND vm.revoked_at IS NULL AND vm.accepted_at IS NOT NULL
		     )
		     OR EXISTS (SELECT 1 FROM vaults v WHERE v.owner_account_id = a.id)
		   ))
		 ORDER BY EXISTS (
		     SELECT 1 FROM vault_members vm
		      WHERE vm.account_id = a.id
		        AND vm.revoked_at IS NULL AND vm.accepted_at IS NOT NULL
		   ) DESC,
		   a.created_at ASC
		 LIMIT 1
	`, provider, emailNormalized, excludeAccountID, requireContent).Scan(&linkID)
	switch {
	case err == nil:
		return linkID, nil
	case errors.Is(err, pgx.ErrNoRows):
		return "", nil
	default:
		return "", fmt.Errorf("linkable-account lookup: %w", err)
	}
}

// adoptHollowDuplicate heals a pre-linking-era duplicate at sign-in time.
// When the canonically-resolved account is HOLLOW (no active vault
// membership, owns no vaults — nothing to lose) and a verified-same-email
// account WITH content exists, every pointer of the hollow account
// (account_identities, auth_credentials, installs) is repointed onto the
// content-bearing account and it becomes the resolution result. The hollow
// accounts row is left behind as an unreferenced husk — deleting it would
// have to untangle RESTRICT FKs (revoked memberships, audit rows, events it
// may have authored in others' vaults) for zero user-visible gain.
//
// Trigger example: user synced vaults under Google on Android, later signed
// in with Apple on iOS BEFORE email linking shipped — that minted an empty
// Apple account which now permanently shadows their data. The next Apple
// sign-in lands here and re-homes the Apple identity onto the Google account,
// so the vaults restore.
//
// Returns the adopted account id, or "" when no healing applies.
func adoptHollowDuplicate(
	ctx context.Context,
	tx pgx.Tx,
	accountID, provider, providerSub string,
	profile AccountProfile,
) (string, error) {
	if !profile.EmailVerified || profile.EmailNormalized == "" {
		return "", nil
	}

	// Serialize adoption on the husk's accounts row: two concurrent sign-ins
	// with the same identity must not both pass the hollow check and repoint
	// twice. Residual (accepted): a vault registered under a hollow-account
	// JWT in the SAME instant on another device isn't serialized by this lock
	// (POST /v1/vaults doesn't lock the accounts row) and would strand that
	// vault on the husk — same-user, milliseconds-wide, needs manual repair.
	if _, err := tx.Exec(ctx, `
		SELECT id FROM accounts WHERE id = $1::uuid FOR UPDATE
	`, accountID); err != nil {
		return "", fmt.Errorf("lock hollow account row: %w", err)
	}

	var hollow bool
	if err := tx.QueryRow(ctx, `
		SELECT NOT EXISTS (
		         SELECT 1 FROM vault_members vm
		          WHERE vm.account_id = $1::uuid
		            AND vm.revoked_at IS NULL AND vm.accepted_at IS NOT NULL
		       )
		   AND NOT EXISTS (SELECT 1 FROM vaults v WHERE v.owner_account_id = $1::uuid)
	`, accountID).Scan(&hollow); err != nil {
		return "", fmt.Errorf("hollow-account check: %w", err)
	}
	if !hollow {
		return "", nil
	}

	target, err := linkableAccountByVerifiedEmail(
		ctx, tx, provider, profile.EmailNormalized, accountID, true)
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil
	}

	// Move the legacy google_sub dual-write with the google identity: the
	// UNIQUE constraint on accounts.google_sub means the husk must release
	// the value BEFORE the target can adopt it. Only when the INCOMING
	// identity is the google one — an apple-triggered merge must not strip a
	// google_sub whose identity row stays behind on the husk.
	if provider == ProviderGoogle {
		var hollowGoogleSub *string
		if err := tx.QueryRow(ctx, `
			SELECT google_sub FROM accounts WHERE id = $1::uuid
		`, accountID).Scan(&hollowGoogleSub); err != nil {
			return "", fmt.Errorf("read hollow google_sub: %w", err)
		}
		if hollowGoogleSub != nil {
			if _, err := tx.Exec(ctx, `
				UPDATE accounts SET google_sub = NULL WHERE id = $1::uuid
			`, accountID); err != nil {
				return "", fmt.Errorf("release hollow google_sub: %w", err)
			}
			if _, err := tx.Exec(ctx, `
				UPDATE accounts SET google_sub = COALESCE(google_sub, $2)
				WHERE id = $1::uuid
			`, target, *hollowGoogleSub); err != nil {
				return "", fmt.Errorf("adopt google_sub onto target: %w", err)
			}
		}
	}

	// Repoint the INCOMING identity (the one that just authenticated) plus
	// the hollow account's credentials and install linkage, so live sessions
	// and install rows keep working. Other identities on the husk — none in
	// practice; pre-linking accounts are single-identity — stay behind
	// rather than be moved unchecked past the same-provider rail.
	// CheckCredentialRevoked compares the JWT's account_id against the
	// credential row: the client stores the NEW account id from this
	// sign-in's response, and older JWTs for the husk stop authorizing —
	// the correct post-merge posture.
	if _, err := tx.Exec(ctx, `
		UPDATE account_identities SET account_id = $3::uuid
		WHERE provider = $1 AND provider_sub = $2
	`, provider, providerSub, target); err != nil {
		return "", fmt.Errorf("repoint account identity: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE auth_credentials SET account_id = $2::uuid WHERE account_id = $1::uuid
	`, accountID, target); err != nil {
		return "", fmt.Errorf("repoint auth_credentials: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE installs SET account_id = $2::uuid WHERE account_id = $1::uuid
	`, accountID, target); err != nil {
		return "", fmt.Errorf("repoint installs: %w", err)
	}
	// Keep a phone the user saved while on the duplicate; never clobber one
	// already on the target.
	if _, err := tx.Exec(ctx, `
		UPDATE accounts SET phone_e164 = COALESCE(
			phone_e164,
			(SELECT phone_e164 FROM accounts WHERE id = $1::uuid)
		) WHERE id = $2::uuid
	`, accountID, target); err != nil {
		return "", fmt.Errorf("adopt phone onto target: %w", err)
	}

	return target, nil
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
