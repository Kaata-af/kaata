package httpx

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// AdminKeyMiddleware guards operator-only routes (the analytics dashboard) with a
// shared secret. Two deliberate behaviors:
//
//   - key == "": the admin surface is DISABLED. Every request 404s, identical to
//     "route doesn't exist" — a deployment without ADMIN_API_KEY exposes nothing
//     and leaks no hint that admin endpoints exist.
//   - key set: require `Authorization: Bearer <key>`, compared in constant time.
//
// Operator-only (single shared secret) is sufficient here — these are read-only
// aggregate stats viewed by the operator, not per-user data.
func AdminKeyMiddleware(key string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if key == "" {
				http.NotFound(w, r)
				return
			}
			tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
			if subtle.ConstantTimeCompare([]byte(tok), []byte(key)) != 1 {
				Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
