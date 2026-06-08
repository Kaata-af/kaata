package auth

import (
	"context"
	"net/http"
	"strings"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"

	"github.com/matee/kaata-backend/internal/httpx"
)

// contextKey is unexported to prevent collisions with other packages
// stashing values on the same context.
type contextKey int

const claimsContextKey contextKey = iota

// revokedCacheTTL is the freshness window for the auth_credentials.revoked_at
// lookup. 60s means a forced revocation lands within ~1 minute on every
// install — fast enough for security, slow enough that we don't hammer
// Postgres on every authed request.
const revokedCacheTTL = 60 * time.Second

type revokedEntry struct {
	checkedAt time.Time
	revoked   bool
}

// SessionAuthenticator owns the LRU cache of revoked_at lookups. Construct
// once at startup; the cache is shared across all incoming requests.
type SessionAuthenticator struct {
	secret string
	svc    *Service
	cache  *lru.Cache[string, revokedEntry]
}

// NewSessionAuthenticator wires up the LRU cache.
func NewSessionAuthenticator(svc *Service, secret string) *SessionAuthenticator {
	cache, _ := lru.New[string, revokedEntry](4096)
	return &SessionAuthenticator{secret: secret, svc: svc, cache: cache}
}

// Middleware returns chi-compatible middleware that requires a valid
// session JWT. Failures return 401.
func (a *SessionAuthenticator) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := a.authorize(w, r)
			if !ok {
				return
			}
			ctx := context.WithValue(r.Context(), claimsContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// OptionalMiddleware is the same parsing pipeline but tolerant: if the
// Authorization header is missing OR the token is invalid, the request
// proceeds without claims on the context. /v1/check-in uses this so a
// signed-in install gets JWT refresh while a local-only install keeps
// working unchanged.
func (a *SessionAuthenticator) OptionalMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok := extractBearer(r.Header.Get("Authorization"))
			if tok == "" {
				next.ServeHTTP(w, r)
				return
			}
			claims, err := ParseSession(a.secret, tok)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			if revoked, err := a.isRevoked(r.Context(), claims); err != nil || revoked {
				next.ServeHTTP(w, r)
				return
			}
			ctx := context.WithValue(r.Context(), claimsContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func (a *SessionAuthenticator) authorize(w http.ResponseWriter, r *http.Request) (*SessionClaims, bool) {
	tok := extractBearer(r.Header.Get("Authorization"))
	if tok == "" {
		httpx.Error(w, http.StatusUnauthorized, "missing or empty bearer token")
		return nil, false
	}
	claims, err := ParseSession(a.secret, tok)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid session token: "+err.Error())
		return nil, false
	}
	revoked, err := a.isRevoked(r.Context(), claims)
	if err != nil {
		// Fail closed — a flaky DB shouldn't let stale-but-valid JWTs through.
		httpx.Error(w, http.StatusServiceUnavailable, "session check unavailable")
		return nil, false
	}
	if revoked {
		httpx.Error(w, http.StatusUnauthorized, "session has been revoked")
		return nil, false
	}
	return claims, true
}

func (a *SessionAuthenticator) isRevoked(ctx context.Context, claims *SessionClaims) (bool, error) {
	key := claims.InstallID + "|" + claims.Provider
	now := time.Now()
	if entry, ok := a.cache.Get(key); ok {
		if now.Sub(entry.checkedAt) < revokedCacheTTL {
			return entry.revoked, nil
		}
	}
	revoked, err := a.svc.CheckCredentialRevoked(ctx, claims.InstallID, claims.Provider)
	if err != nil {
		return false, err
	}
	a.cache.Add(key, revokedEntry{checkedAt: now, revoked: revoked})
	return revoked, nil
}

// Invalidate purges any cached revocation state for (installID, provider) so
// the next request re-reads from Postgres. Called by SignOut so a deleted
// credential row is honored immediately instead of waiting up to 60s for the
// LRU entry to expire.
func (a *SessionAuthenticator) Invalidate(installID, provider string) {
	a.cache.Remove(installID + "|" + provider)
}

// extractBearer parses an Authorization header. Requires the "Bearer "
// scheme prefix (case-insensitive). Returns "" for anything else —
// including Basic/Digest, no-scheme tokens, or a Bearer header with an
// empty token. The caller treats "" as "no auth presented" and either
// 401s (RequireSession) or proceeds anonymously (OptionalMiddleware).
func extractBearer(authz string) string {
	authz = strings.TrimSpace(authz)
	if len(authz) < 8 {
		// "Bearer " is 7 chars; anything shorter cannot contain a token
		// after the scheme. Reject explicitly to avoid the empty-token
		// edge case that ParseSession then surfaces as the misleading
		// "token contains an invalid number of segments" error.
		return ""
	}
	if !strings.EqualFold(authz[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(authz[7:])
}

// ClaimsFromContext returns the SessionClaims stashed by the middleware.
func ClaimsFromContext(ctx context.Context) (*SessionClaims, bool) {
	claims, ok := ctx.Value(claimsContextKey).(*SessionClaims)
	return claims, ok
}

// RequireSession is kept as a free function for backward compatibility.
// New code should use SessionAuthenticator.Middleware() at startup so the
// LRU is shared.
//
// Deprecated: use NewSessionAuthenticator + .Middleware() instead.
func RequireSession(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok := extractBearer(r.Header.Get("Authorization"))
			if tok == "" {
				httpx.Error(w, http.StatusUnauthorized, "missing or empty bearer token")
				return
			}
			claims, err := ParseSession(secret, tok)
			if err != nil {
				httpx.Error(w, http.StatusUnauthorized, "invalid session token: "+err.Error())
				return
			}
			ctx := context.WithValue(r.Context(), claimsContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
