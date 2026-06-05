package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// SessionLifetime is how long an issued session JWT stays valid. Long-lived
// because this is for an app-to-backend identity token, not a browser
// session — re-signing-in every week would be silly UX for a ledger app.
// Sign-out + secret rotation are how we invalidate sooner.
const SessionLifetime = 365 * 24 * time.Hour

// SessionClaims is the payload of a session JWT. install_id ties the
// session back to a specific install row; provider_sub identifies the
// underlying Google user (stable even if they change their Google email).
// We carry both so most endpoints (e.g., upcoming backup endpoints) can
// authorize without an extra DB lookup.
type SessionClaims struct {
	InstallID   string `json:"install_id"`
	Provider    string `json:"provider"`
	ProviderSub string `json:"provider_sub"`
	jwt.RegisteredClaims
}

// SignSession produces a session JWT signed with HS256. The secret must
// be a long random byte string set via SESSION_JWT_SECRET in the env;
// short or predictable secrets are brute-forceable.
func SignSession(secret string, installID, provider, providerSub string) (string, error) {
	if secret == "" {
		return "", errors.New("session jwt secret is not configured")
	}
	now := time.Now()
	claims := SessionClaims{
		InstallID:   installID,
		Provider:    provider,
		ProviderSub: providerSub,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "kaata-backend",
			Subject:   installID,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(SessionLifetime)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString([]byte(secret))
}

// ParseSession verifies a session JWT against the configured secret.
// Returns the claims on success; any signature mismatch, malformation,
// expiry, or wrong algorithm produces an error.
func ParseSession(secret, token string) (*SessionClaims, error) {
	if secret == "" {
		return nil, errors.New("session jwt secret is not configured")
	}
	claims := &SessionClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		// Pin the algorithm explicitly. Without this check, an attacker
		// could craft a "none" or RS256 token that ParseWithClaims would
		// happily accept with the wrong key.
		if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %s", t.Method.Alg())
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	if !parsed.Valid {
		return nil, errors.New("token is not valid")
	}
	return claims, nil
}
