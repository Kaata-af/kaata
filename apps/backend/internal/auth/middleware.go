package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/matee/kaata-backend/internal/httpx"
)

// contextKey is unexported to prevent collisions when other packages stash
// values on the same context. ClaimsFromContext is the only safe way to
// pull the claims back out — direct context.Value(...) calls with a string
// key won't find them.
type contextKey int

const claimsContextKey contextKey = iota

// RequireSession is HTTP middleware that:
//  1. Parses an Authorization: Bearer <jwt> header
//  2. Validates the JWT against the configured session secret
//  3. Stashes the parsed SessionClaims on the request context
//
// Used to gate routes that require an authenticated install (sign-out,
// future backup endpoints, etc.). Unauthenticated requests get a 401.
func RequireSession(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authz := r.Header.Get("Authorization")
			if authz == "" {
				httpx.Error(w, http.StatusUnauthorized, "missing authorization header")
				return
			}
			// Tolerant prefix match: some clients send "bearer" lowercase
			// or just the raw token. We accept both shapes, lowercase the
			// prefix once, and trim.
			token := strings.TrimSpace(authz)
			if len(token) >= 7 && strings.EqualFold(token[:6], "bearer") {
				token = strings.TrimSpace(token[6:])
			}
			if token == "" {
				httpx.Error(w, http.StatusUnauthorized, "empty bearer token")
				return
			}

			claims, err := ParseSession(secret, token)
			if err != nil {
				httpx.Error(w, http.StatusUnauthorized, "invalid session token: "+err.Error())
				return
			}

			ctx := context.WithValue(r.Context(), claimsContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClaimsFromContext pulls the SessionClaims stashed by RequireSession.
// Returns (nil, false) on a request that didn't go through the middleware.
func ClaimsFromContext(ctx context.Context) (*SessionClaims, bool) {
	claims, ok := ctx.Value(claimsContextKey).(*SessionClaims)
	return claims, ok
}
