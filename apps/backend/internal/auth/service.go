package auth

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/idtoken"

	"github.com/matee/kaata-backend/internal/mail"
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
	// appleServicesID: the Sign in with Apple SERVICES ID (e.g. af.kaata.auth)
	// — the audience of identity tokens minted by the Android/web OAuth flow
	// (appleid.apple.com authorize → form_post trampoline). Empty = that flow
	// is disabled; the native-iOS bundle-id audience keeps working.
	appleServicesID string
	sessionSecret   string
	sharedRecords   SharedRecordNotifier
	// outbox queues the email-account codes and notices (internal/mail).
	// nil or disabled: the code endpoints answer 503 email_unavailable.
	outbox *mail.Outbox
}

// SetMailOutbox wires email delivery for Kaata email accounts.
func (s *Service) SetMailOutbox(o *mail.Outbox) { s.outbox = o }

func NewService(pool *pgxpool.Pool, googleWebClientID, sessionSecret string) *Service {
	// Built now, so the first unknown identifier after a boot costs what every
	// other sign-in costs.
	dummyHash()
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

// SetAppleServicesID wires the Services-ID audience for the Android/web
// Sign in with Apple flow. Empty disables that flow.
func (s *Service) SetAppleServicesID(id string) { s.appleServicesID = id }

// AppleServicesID exposes the configured Services ID for the web-flow
// trampoline handlers.
func (s *Service) AppleServicesID() string { return s.appleServicesID }

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
	// Username is the optional private sign-in handle (Kaata email accounts).
	Username string `json:"username,omitempty"`
	// HasPassword: the account can also sign in with email/username + password.
	HasPassword bool `json:"has_password"`
}

// PendingVaultRegistration lets a mobile install that already minted
// its default vault locally (the common Phase 2 case via migration 007)
// register that vault with the server in the SAME round-trip as sign-in.
type PendingVaultRegistration struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Currency    string `json:"currency,omitempty"`
	CreatedAtMS int64  `json:"created_at_ms,omitempty"`
	// VaultTrustAnchorPubkey is the owner device's Ed25519 public key, the
	// vault's local-CA mesh trust anchor — std or URL-safe base64 of 32
	// bytes. It MUST be carried here: this block is the ONLY way a kaata
	// that already existed on the phone before sign-in reaches the server,
	// and until 2026-09 the field did not exist, so those vaults landed with
	// vaults.vault_trust_anchor_pubkey NULL. An anchor-less server row turns
	// the whole M2 membership-chain path off (internal/sync/service.go's
	// `len(vaultAnchor) == ed25519.PublicKeySize` gate), which drops a
	// joiner's own admission onto the legacy owner-only role matrix and
	// refuses it forever — the "member never appears on my first kaata" bug.
	// Omitted (or malformed) is still accepted: a vault with no anchor is a
	// valid legacy/server-anchored vault, and refusing the SIGN-IN over it
	// would be far worse than registering it anchor-less. POST /v1/vaults
	// fills a NULL anchor for the owner later (vaults.Service.Create).
	VaultTrustAnchorPubkey string `json:"vault_trust_anchor_pubkey,omitempty"`
}

// decodeAnchorPubkey parses a client-supplied trust anchor. Returns nil for
// an absent or malformed value — never an error, because this is only ever
// reached from the sign-in path, where a bad anchor must not cost the user
// their session (see PendingVaultRegistration.VaultTrustAnchorPubkey). Both
// encodings are accepted: mobile's pair-QR uses URL-safe base64 while
// POST /v1/vaults uses the standard alphabet.
func decodeAnchorPubkey(s string) []byte {
	if s == "" {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		decoded, err = base64.RawURLEncoding.DecodeString(s)
	}
	if err != nil || len(decoded) != 32 {
		return nil
	}
	return decoded
}

// upsertPendingVault registers — or idempotently re-registers — a vault the
// mobile install minted locally before sign-in, returning the row's TRUE
// owner so the caller can detect a vault_id collision. Split out of
// SignInWithGoogle purely so this can be tested: the sign-in entry point
// needs a live Google ID token, and it is the anchor semantics below, not
// the token plumbing, that the "member never adds on my first kaata" bug
// turned on.
//
// The anchor is carried through verbatim (nil → SQL NULL, which the column's
// CHECK allows). On conflict it is a ONE-WAY NULL→value fill, gated on the
// stored row already being ours:
//
//   - an anchor is the vault's root of trust, so a later registration must
//     never silently ROTATE one;
//   - a row with NO anchor is exactly what this path used to create, and an
//     anchor-less server row turns the M2 membership chain off, so filling it
//     is how such a vault heals;
//   - the owner gate lives INSIDE the statement, not in the caller's
//     collision check, because that check only runs after the UPDATE has
//     already been applied.
func upsertPendingVault(
	ctx context.Context,
	tx pgx.Tx,
	accountID string,
	pending *PendingVaultRegistration,
	currency string,
	createdAt time.Time,
) (string, error) {
	var existingOwner string
	err := tx.QueryRow(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, created_at, vault_trust_anchor_pubkey)
		VALUES ($1::uuid, $2::uuid, $3, $4, 0, $5, $6)
		ON CONFLICT (vault_id) DO UPDATE
		SET vault_trust_anchor_pubkey = CASE
			WHEN vaults.vault_trust_anchor_pubkey IS NULL
			 AND vaults.owner_account_id = EXCLUDED.owner_account_id
			 AND EXCLUDED.vault_trust_anchor_pubkey IS NOT NULL
			THEN EXCLUDED.vault_trust_anchor_pubkey
			ELSE vaults.vault_trust_anchor_pubkey
		END
		RETURNING owner_account_id::text
	`, pending.ID, accountID, pending.Name, currency, createdAt,
		decodeAnchorPubkey(pending.VaultTrustAnchorPubkey)).Scan(&existingOwner)
	if err != nil {
		return "", fmt.Errorf("upsert vault: %w", err)
	}
	return existingOwner, nil
}

// GoogleSignInResult is the response shape for POST /v1/auth/google.
type GoogleSignInResult struct {
	SessionJWT        string  `json:"session_jwt"`
	AccountID         string  `json:"account_id"`
	DefaultVaultID    *string `json:"default_vault_id"`
	DeletionCancelled bool    `json:"deletion_cancelled,omitempty"`
	User              User    `json:"user"`
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
	sw SwitchOptions,
) (GoogleSignInResult, error) {
	if s.googleWebClientID == "" {
		return GoogleSignInResult{}, errors.New("google web client id not configured")
	}
	if sw.Platform == "web" && !validBrowserChallenge(sw.Nonce) {
		return GoogleSignInResult{}, errors.New("browser sign-in nonce is required")
	}

	// (1) Verify the Google ID token.
	payload, err := idtoken.Validate(ctx, idTokenStr, s.googleWebClientID)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("verify google id token: %w", err)
	}
	nonce, _ := payload.Claims["nonce"].(string)
	if err := verifyProviderNonce(sw.Nonce, nonce); err != nil {
		return GoogleSignInResult{}, err
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

	// (2-6) One transaction: resolve-or-create the account via
	// account_identities (M1; profile fields and last_login_at are refreshed
	// inside the helper), then the shared sign-in tail (signin.go).
	result, acct, err := s.providerSignIn(ctx, AccountProfile{
		Email:           email,
		EmailNormalized: emailNormalized,
		EmailVerified:   true,
		Name:            name,
		PictureURL:      picture,
	}, signInTail{
		provider:    ProviderGoogle,
		providerSub: providerSub,
		installID:   installID,
		sw:          sw,
		credEmail:   email,
		credName:    name,
		credPicture: picture,
		pending:     pending,
	})
	if err != nil {
		return GoogleSignInResult{}, err
	}
	result.User = User{
		Sub:         providerSub,
		Email:       email,
		Name:        acct.name,
		PictureURL:  picture,
		Phone:       acct.phone,
		Username:    acct.username,
		HasPassword: acct.hasPassword,
	}
	return result, nil
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
	sw SwitchOptions,
) (GoogleSignInResult, error) {
	if s.appleClientID == "" {
		return GoogleSignInResult{}, errors.New("apple client id not configured")
	}
	audiences := []string{s.appleClientID, s.appleServicesID}
	if sw.Platform == "web" {
		if !validBrowserChallenge(sw.Nonce) {
			return GoogleSignInResult{}, errors.New("browser sign-in nonce is required")
		}
		// A browser sign-in uses the registered Services ID, never an unrelated
		// native token. Native clients keep the pre-existing audience set.
		audiences = []string{s.appleServicesID}
	}
	// Two legitimate audiences: the bundle id (native iOS flow) and the
	// Services ID (Android/web flow) — see VerifyAppleIDToken.
	payload, err := VerifyAppleIDToken(ctx, idTokenStr, audiences...)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("verify apple id token: %w", err)
	}
	if err := verifyProviderNonce(sw.Nonce, payload.Nonce); err != nil {
		return GoogleSignInResult{}, err
	}
	providerSub := payload.Sub

	email := payload.Email
	emailNormalized := normalizeEmail(email)
	name := strings.TrimSpace(displayName)

	result, acct, err := s.providerSignIn(ctx, AccountProfile{
		Email:           email,
		EmailNormalized: emailNormalized,
		EmailVerified:   payload.EmailVerified,
		Name:            name,
		PictureURL:      "",
	}, signInTail{
		provider:    ProviderApple,
		providerSub: providerSub,
		installID:   installID,
		sw:          sw,
		credEmail:   email,
		credName:    name,
	})
	if err != nil {
		return GoogleSignInResult{}, err
	}
	result.User = User{
		Sub:         providerSub,
		Email:       email,
		Name:        acct.name,
		Phone:       acct.phone,
		Username:    acct.username,
		HasPassword: acct.hasPassword,
	}
	return result, nil
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
	result, err := s.pool.Exec(ctx, `
		UPDATE accounts SET phone_e164 = $2 WHERE id = $1::uuid AND pending_delete_at IS NULL
	`, accountID, val)
	if err != nil {
		return fmt.Errorf("update account phone: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrSessionRevoked
	}
	return nil
}

// SignOut removes every credential of the install, whichever provider minted
// it (one live credential per install, docs/kaata-accounts.md §6). provider is
// the session's own and only kept for callers' logs.
func (s *Service) SignOut(ctx context.Context, installID, provider string) error {
	_ = provider
	_, err := s.pool.Exec(ctx, `DELETE FROM auth_credentials WHERE install_id = $1`, installID)
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
// (legacy row) uses the install's explicit owner. Missing both ownership
// fields fails closed; a JWT cannot supply otherwise unknown attribution.
//
// It is bound to the JWT's epoch too: every sign-in on the install, a password
// reset and a password change give the credential a fresh epoch, so an older
// JWT of the same install, or a copy of it, stops authorizing.
func (s *Service) CheckCredentialRevoked(ctx context.Context, installID, provider, accountID string, epoch int64) (bool, error) {
	var revokedAt *time.Time
	var storedAccountID *string
	var storedEpoch int64
	var pendingDeletion bool
	err := s.pool.QueryRow(ctx, `
		SELECT c.revoked_at, COALESCE(c.account_id,i.account_id)::text, c.session_epoch, a.pending_delete_at IS NOT NULL
		FROM auth_credentials c LEFT JOIN installs i ON i.install_id=c.install_id
		LEFT JOIN accounts a ON a.id=COALESCE(c.account_id,i.account_id)
		WHERE c.install_id = $1 AND c.provider = $2
	`, installID, provider).Scan(&revokedAt, &storedAccountID, &storedEpoch, &pendingDeletion)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return true, nil
	case err != nil:
		return false, fmt.Errorf("lookup auth credential: %w", err)
	}
	if storedAccountID == nil || (accountID != "" && *storedAccountID != accountID) {
		return true, nil
	}
	if storedEpoch != epoch {
		return true, nil
	}
	return revokedAt != nil || pendingDeletion, nil
}

// IssueRefreshJWT mints a new session JWT for an existing valid claim. The
// epoch stays: a refresh is the same session.
func (s *Service) IssueRefreshJWT(claims *SessionClaims) (string, error) {
	return SignSessionEpoch(s.sessionSecret, claims.AccountID, claims.InstallID, claims.Provider, claims.ProviderSub,
		claims.Epoch)
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
