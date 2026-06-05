package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/idtoken"
)

const ProviderGoogle = "google"

type Service struct {
	pool              *pgxpool.Pool
	googleWebClientID string
	sessionSecret     string
}

func NewService(pool *pgxpool.Pool, googleWebClientID, sessionSecret string) *Service {
	return &Service{
		pool:              pool,
		googleWebClientID: googleWebClientID,
		sessionSecret:     sessionSecret,
	}
}

// User is the public profile we return to the mobile client so it can
// display "Signed in as ahmad@gmail.com" or render the avatar. None of
// these fields are used as identity keys — provider_sub (held server-side)
// is the identity key.
type User struct {
	Email      string `json:"email,omitempty"`
	Name       string `json:"name,omitempty"`
	PictureURL string `json:"picture_url,omitempty"`
}

// GoogleSignInResult is what we hand back to mobile after a successful
// /v1/auth/google call: the session JWT they should send in subsequent
// Authorization headers, plus the User block for display.
type GoogleSignInResult struct {
	SessionJWT string `json:"session_jwt"`
	User       User   `json:"user"`
}

// SignInWithGoogle verifies the supplied Google ID token, upserts an
// auth_credentials row for this install, and returns a fresh session JWT
// the mobile client should use for subsequent authenticated requests.
//
// install_id MUST already exist in `installs`. The mobile flow guarantees
// this because the BackgroundCheckIn fires on app load before any auth
// UI is reachable; if it doesn't, we INSERT a stub installs row to avoid
// blocking sign-in on a check-in race.
func (s *Service) SignInWithGoogle(ctx context.Context, installID, idTokenStr string) (GoogleSignInResult, error) {
	if s.googleWebClientID == "" {
		return GoogleSignInResult{}, errors.New("google web client id not configured")
	}

	// Validate the Google ID token: signature against Google's JWKs,
	// audience matches our Web Client ID, expiry, issuer. The idtoken
	// library fetches and caches Google's public keys for us.
	payload, err := idtoken.Validate(ctx, idTokenStr, s.googleWebClientID)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("verify google id token: %w", err)
	}

	// payload.Subject is the stable Google user id (the `sub` claim).
	// email/name/picture come from claims; the user may have changed them
	// since the token was issued, but for a sign-in flow this is fine —
	// it's display data, refreshed every sign-in.
	providerSub := payload.Subject
	if providerSub == "" {
		return GoogleSignInResult{}, errors.New("google id token missing sub claim")
	}
	email, _ := payload.Claims["email"].(string)
	name, _ := payload.Claims["name"].(string)
	picture, _ := payload.Claims["picture"].(string)

	// Make sure the installs row exists. The mobile app should have called
	// /v1/check-in before reaching auth, but we don't want a race condition
	// at first-launch onboarding to wedge sign-in. A no-op INSERT on conflict
	// covers both cases.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO installs (install_id, app_version, platform)
		VALUES ($1, 'unknown', 'unknown')
		ON CONFLICT (install_id) DO NOTHING
	`, installID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("ensure installs row: %w", err)
	}

	// Upsert credential. If the same install signs in with a DIFFERENT
	// Google account, the UNIQUE(install_id, provider) constraint replaces
	// the row — only one Google identity per install at a time.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO auth_credentials (
			install_id, provider, provider_sub, email, name, picture_url
		) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (install_id, provider) DO UPDATE
		SET provider_sub = EXCLUDED.provider_sub,
		    email        = EXCLUDED.email,
		    name         = EXCLUDED.name,
		    picture_url  = EXCLUDED.picture_url,
		    last_used_at = NOW()
	`, installID, ProviderGoogle, providerSub, email, name, picture); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("upsert auth credential: %w", err)
	}

	sessionJWT, err := SignSession(s.sessionSecret, installID, ProviderGoogle, providerSub)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("sign session jwt: %w", err)
	}

	return GoogleSignInResult{
		SessionJWT: sessionJWT,
		User: User{
			Email:      email,
			Name:       name,
			PictureURL: picture,
		},
	}, nil
}

// SignOut removes the auth credential for this install + provider. The
// session JWT itself remains technically valid until expiry — there's no
// server-side blacklist — but a signed-out install has nothing to back
// up to, so even if a stale JWT is replayed it can't access anything
// useful. Rotating SESSION_JWT_SECRET is the nuclear option that
// invalidates ALL existing sessions.
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
