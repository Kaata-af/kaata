package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// SessionLifetime is how long an issued session JWT stays valid.
//
// 30 days is the Phase 2 choice. Long enough that a normal shopkeeper
// opening the app weekly never sees a re-prompt; short enough that a
// stolen token has a bounded blast radius. We refresh on every check-in
// past RefreshIfOlderThan, so an actively-used install effectively has
// a rolling 30-day window forever.
const SessionLifetime = 30 * 24 * time.Hour

// RefreshIfOlderThan is the staleness threshold at which /v1/check-in
// will return a refreshed session_jwt.
const RefreshIfOlderThan = 7 * 24 * time.Hour

// SessionClaims is the payload of a session JWT.
//
// Subject (sub) = account_id. This is the CANONICAL identity for every
// authorized request. install_id and provider_sub are denormalized for
// convenience — most endpoints can authorize against (account_id) without
// touching auth_credentials, and the few that need install scope (sign-out,
// device-list) read it from the claim instead of an extra round-trip.
//
// M1 (sync v2 §4): the claim set is provider-agnostic — `provider` +
// `provider_sub` describe whichever identity minted the session ('google'
// today, 'phone_otp' later). There is deliberately NO google-specific
// claim. Tokens minted by older releases (or with extra claims) still
// parse: encoding/json — and therefore golang-jwt — ignores unknown JSON
// fields, so adding/removing denormalized claims never invalidates
// in-flight 30-day sessions.
type SessionClaims struct {
	AccountID   string `json:"account_id"`
	InstallID   string `json:"install_id"`
	Provider    string `json:"provider"`
	ProviderSub string `json:"provider_sub"`
	jwt.RegisteredClaims
}

// SignSession produces a session JWT signed with HS256. The secret must
// be a long random byte string (>= 32 bytes) set via JWT_SECRET in env.
func SignSession(secret, accountID, installID, provider, providerSub string) (string, error) {
	if secret == "" {
		return "", errors.New("session jwt secret is not configured")
	}
	if accountID == "" || installID == "" {
		return "", errors.New("account_id and install_id are required for session jwt")
	}
	now := time.Now()
	claims := SessionClaims{
		AccountID:   accountID,
		InstallID:   installID,
		Provider:    provider,
		ProviderSub: providerSub,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    SessionIssuer,
			Subject:   accountID,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(SessionLifetime)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString([]byte(secret))
}

// SessionIssuer is the iss claim minted by SignSession and required by
// ParseSession. Reusing the same constant in both places guarantees a
// token signed with our secret but intended for a DIFFERENT service
// (e.g. a sibling backend that happens to share the JWT secret in a
// future deploy) is rejected.
const SessionIssuer = "kaata-backend"

// ParseSession verifies a session JWT against the configured secret.
// Pinning the algorithm to HS256 is critical — without that check, the
// jwt library would accept "alg=none" tokens that any client could forge.
// Verifying iss is a defense-in-depth guard for shared-secret deploys.
func ParseSession(secret, token string) (*SessionClaims, error) {
	if secret == "" {
		return nil, errors.New("session jwt secret is not configured")
	}
	claims := &SessionClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %s", t.Method.Alg())
		}
		return []byte(secret), nil
	}, jwt.WithIssuer(SessionIssuer))
	if err != nil {
		return nil, err
	}
	if !parsed.Valid {
		return nil, errors.New("token is not valid")
	}
	if claims.AccountID == "" {
		return nil, errors.New("token missing account_id claim")
	}
	return claims, nil
}

// IssuedAtAge returns how long ago the token was issued. Used by
// /v1/check-in to decide whether to refresh.
//
// A nil IssuedAt is treated as MaxInt64 ("infinitely old") rather than 0
// ("just minted"). The latter would silently skip the refresh path on any
// malformed token, which is exactly the wrong default — better to force a
// refresh so the next claims structure is well-formed, or to surface the
// problem via an outright failure.
func (c *SessionClaims) IssuedAtAge() time.Duration {
	if c.IssuedAt == nil {
		return time.Duration(1<<62 - 1)
	}
	return time.Since(c.IssuedAt.Time)
}
