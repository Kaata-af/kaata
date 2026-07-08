package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Sign in with Apple identity-token verification.
//
// Native Sign in with Apple on iOS returns an identity token: a JWT (RS256)
// signed by Apple, with iss=https://appleid.apple.com and aud=<app bundle id>.
// We verify it exactly like the Google path verifies a Google ID token, but
// against Apple's published JWKS instead of a library. No external dependency
// is needed beyond golang-jwt: the JWKS is plain RSA public keys we parse with
// crypto/rsa.

const (
	appleIssuer   = "https://appleid.apple.com"
	appleKeysURL  = "https://appleid.apple.com/auth/keys"
	appleKeysTTL  = time.Hour
	appleHTTPWait = 10 * time.Second
)

// ApplePayload is the subset of Apple identity-token claims we consume.
type ApplePayload struct {
	Sub           string
	Email         string
	EmailVerified bool
}

type appleJWK struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// appleKeyCache caches Apple's JWKS (RSA public keys keyed by kid) with a TTL.
// Safe for concurrent use.
type appleKeyCache struct {
	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
	client    *http.Client
}

var appleKeys = &appleKeyCache{client: &http.Client{Timeout: appleHTTPWait}}

func (c *appleKeyCache) get(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.keys != nil && time.Since(c.fetchedAt) < appleKeysTTL {
		if k, ok := c.keys[kid]; ok {
			return k, nil
		}
	}
	// Cache is cold, stale, or missing this kid (Apple rotated keys). Refetch.
	if err := c.refreshLocked(ctx); err != nil {
		// On a transient fetch failure, fall back to a stale-but-cached key so a
		// blip at Apple doesn't take down sign-in.
		if c.keys != nil {
			if k, ok := c.keys[kid]; ok {
				return k, nil
			}
		}
		return nil, err
	}
	k, ok := c.keys[kid]
	if !ok {
		return nil, fmt.Errorf("apple jwks: no key for kid %q", kid)
	}
	return k, nil
}

func (c *appleKeyCache) refreshLocked(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, appleKeysURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch apple jwks: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch apple jwks: status %d", resp.StatusCode)
	}
	var doc struct {
		Keys []appleJWK `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return fmt.Errorf("decode apple jwks: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, jwk := range doc.Keys {
		if jwk.Kty != "RSA" {
			continue
		}
		pub, err := jwkToRSAPublicKey(jwk)
		if err != nil {
			continue // skip a malformed key rather than fail the whole set
		}
		keys[jwk.Kid] = pub
	}
	if len(keys) == 0 {
		return errors.New("apple jwks: no usable RSA keys")
	}
	c.keys = keys
	c.fetchedAt = time.Now()
	return nil
}

func jwkToRSAPublicKey(jwk appleJWK) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		return nil, fmt.Errorf("decode modulus: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil {
		return nil, fmt.Errorf("decode exponent: %w", err)
	}
	e := new(big.Int).SetBytes(eBytes)
	if !e.IsInt64() || e.Int64() < 2 || e.Int64() > (1<<31-1) {
		return nil, errors.New("exponent out of range")
	}
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(e.Int64()),
	}, nil
}

// VerifyAppleIDToken verifies an Apple identity token and returns its claims.
// Checks: RS256 signature against Apple's JWKS (by kid), iss == appleid.apple.com,
// aud == audience (the app's bundle id), and exp (required). audience must be
// configured (the APPLE_CLIENT_ID env), else the endpoint is effectively off.
func VerifyAppleIDToken(ctx context.Context, idToken, audience string) (*ApplePayload, error) {
	if audience == "" {
		return nil, errors.New("apple client id not configured")
	}
	keyFunc := func(tok *jwt.Token) (any, error) {
		if _, ok := tok.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method %q", tok.Method.Alg())
		}
		kid, _ := tok.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("apple token missing kid")
		}
		return appleKeys.get(ctx, kid)
	}

	claims := jwt.MapClaims{}
	if _, err := jwt.NewParser(
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(appleIssuer),
		jwt.WithAudience(audience),
		jwt.WithExpirationRequired(),
	).ParseWithClaims(idToken, claims, keyFunc); err != nil {
		return nil, fmt.Errorf("verify apple id token: %w", err)
	}

	sub, _ := claims["sub"].(string)
	if sub == "" {
		return nil, errors.New("apple id token missing sub")
	}
	email, _ := claims["email"].(string)
	// Apple sends email_verified as either a bool or the string "true".
	verified := false
	switch v := claims["email_verified"].(type) {
	case bool:
		verified = v
	case string:
		verified = v == "true"
	}
	return &ApplePayload{Sub: sub, Email: email, EmailVerified: verified}, nil
}
