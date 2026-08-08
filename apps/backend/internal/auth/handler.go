package auth

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	svc           *Service
	authenticator *SessionAuthenticator
	// publicAPIBaseURL: the backend's own public origin (cfg.PublicAPIBaseURL),
	// used by the Apple web-flow trampoline to build the absolute redirect_uri
	// Apple posts back to. Empty → derived from the request host.
	publicAPIBaseURL string
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// SetPublicAPIBaseURL wires the backend's public origin for the Apple
// web-flow callback URL (apple_web.go).
func (h *Handler) SetPublicAPIBaseURL(u string) { h.publicAPIBaseURL = u }

// SetAuthenticator wires the session authenticator so SignOut can invalidate
// the LRU revocation cache. Optional — without it SignOut still deletes the
// row server-side, but JWTs cached <60s ago will continue to authorize until
// the cache entry expires.
func (h *Handler) SetAuthenticator(a *SessionAuthenticator) {
	h.authenticator = a
}

type googleSignInRequest struct {
	InstallID                string                    `json:"install_id"`
	IDToken                  string                    `json:"id_token"`
	PendingVaultRegistration *PendingVaultRegistration `json:"pending_vault_registration,omitempty"`
}

// GoogleSignIn — POST /v1/auth/google (PUBLIC).
//
// Request: { install_id, id_token, pending_vault_registration? }
// Response 200: { session_jwt, account_id, default_vault_id, user }
//
// Errors:
//
//	400 — invalid json, install_id not uuid, id_token empty, pending malformed
//	401 — id_token signature/audience/expiry/email_verified/iat-staleness fail
//	409 — pending_vault_registration.id collides with vault owned by another acct
//	500 — DB error
func (h *Handler) GoogleSignIn(w http.ResponseWriter, r *http.Request) {
	// Sign-in body is bounded: install_id + id_token (Google id_tokens are
	// ~1-2 KB) + an optional vault registration. 64 KiB is generous. Without
	// this, an attacker can stream a multi-gigabyte body to exhaust memory.
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var req googleSignInRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "install_id must be a uuid")
		return
	}
	if req.IDToken == "" {
		httpx.Error(w, http.StatusBadRequest, "id_token is required")
		return
	}

	result, err := h.svc.SignInWithGoogle(r.Context(), req.InstallID, req.IDToken, req.PendingVaultRegistration)
	if err != nil {
		msg := err.Error()
		// Log the REAL cause of EVERY non-200 server-side (response bodies stay
		// generic — nothing leaks to the client). Without this, a misconfigured
		// GOOGLE_WEB_CLIENT_ID, an audience mismatch, clock-skew staleness, and a
		// DB error are all indistinguishable "401 google sign-in failed" lines in
		// the logs — which is exactly what stalled diagnosing the auth outage.
		log.Printf("auth/google failed for install %s: %v", req.InstallID, err)
		// Vault collision is the one error class that's safe to surface
		// verbatim — the client UI keys on it to recover. Everything else
		// goes through a generic error after server-side logging so
		// internals (db errors, "begin tx: connection refused", etc.)
		// don't leak via response bodies.
		if strings.Contains(msg, "vault_id collides") {
			httpx.Error(w, http.StatusConflict, "vault_id collides with vault owned by a different account")
			return
		}
		// Map well-known client-fixable conditions to specific messages so the
		// mobile UI can render a useful hint instead of a generic 401.
		switch {
		case strings.Contains(msg, "email is not verified"):
			httpx.Error(w, http.StatusUnauthorized, "google account email is not verified")
		// Match the FULL phrase, not the bare word "stale": the service also
		// wraps DB failures as "clear stale auth credential: …", so a database
		// outage reported itself to the user as a bad token — and as a 401,
		// which invites retrying forever against a server that cannot succeed.
		case strings.Contains(msg, "id token is stale"):
			httpx.Error(w, http.StatusUnauthorized, "google id token is stale; please retry sign-in")
		case strings.Contains(msg, "missing iat"), strings.Contains(msg, "missing sub"), strings.Contains(msg, "iat is in the future"):
			httpx.Error(w, http.StatusUnauthorized, "google id token is malformed")
		case strings.Contains(msg, "pending_vault_registration"):
			httpx.Error(w, http.StatusBadRequest, msg)
		case isServerSideFailure(err):
			// Our fault, not the credential's: DB down, context cancelled
			// (the phone hung up), Google cert fetch failed. 503 tells the
			// client this is worth retrying and keeps 401 meaning "your
			// token is bad" — the two used to be indistinguishable.
			httpx.Error(w, http.StatusServiceUnavailable, "sign-in is temporarily unavailable; try again")
		default:
			// (already logged above with the underlying error)
			httpx.Error(w, http.StatusUnauthorized, "google sign-in failed")
		}
		return
	}
	// Same stale-revoked-cache purge as the Apple path below: a fresh sign-in
	// must not be 401'd for up to 60s by a verdict cached against a prior
	// session's JWT.
	if h.authenticator != nil {
		h.authenticator.Invalidate(req.InstallID, ProviderGoogle)
	}
	httpx.JSON(w, http.StatusOK, result)
}

type appleSignInRequest struct {
	InstallID   string `json:"install_id"`
	IDToken     string `json:"identity_token"`
	DisplayName string `json:"display_name,omitempty"`
}

// AppleSignIn — POST /v1/auth/apple (PUBLIC).
//
// Request: { install_id, identity_token, display_name? }. display_name is only
// sent on the FIRST Sign in with Apple (Apple returns the name once); the token
// carries sub + email. Response mirrors /v1/auth/google.
func (h *Handler) AppleSignIn(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var req appleSignInRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "install_id must be a uuid")
		return
	}
	if req.IDToken == "" {
		httpx.Error(w, http.StatusBadRequest, "identity_token is required")
		return
	}
	result, err := h.svc.SignInWithApple(r.Context(), req.InstallID, req.IDToken, req.DisplayName)
	if err != nil {
		log.Printf("auth/apple failed for install %s: %v", req.InstallID, err)
		// Same split as the Google path: a server-side failure is retryable and
		// must not masquerade as a rejected credential.
		if isServerSideFailure(err) {
			httpx.Error(w, http.StatusServiceUnavailable, "sign-in is temporarily unavailable; try again")
			return
		}
		httpx.Error(w, http.StatusUnauthorized, "apple sign-in failed")
		return
	}
	// Drop any cached "revoked" verdict for this (install, provider): a stale
	// JWT presented moments before this sign-in (e.g. a background check-in
	// after sign-out) poisons the 60s LRU, and without this purge the FRESH
	// session 401s "session has been revoked" on the immediate restore probe.
	if h.authenticator != nil {
		h.authenticator.Invalidate(req.InstallID, ProviderApple)
	}
	httpx.JSON(w, http.StatusOK, result)
}

type updatePhoneRequest struct {
	Phone string `json:"phone"`
}

// UpdatePhone — PUT /v1/account/phone (PROTECTED).
//
// Body: { phone } — E.164 string, or "" to clear. Persists the shopkeeper's own
// phone at the account level so it survives a reinstall (the mobile
// users.phone_e164 is device-local and never reaches the server). Returned by
// /v1/auth/google on the next sign-in for prefill.
func (h *Handler) UpdatePhone(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	// Phone is a short string; 4 KiB is generous and caps abuse.
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req updatePhoneRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if len(req.Phone) > 32 {
		httpx.Error(w, http.StatusBadRequest, "phone too long")
		return
	}
	if err := h.svc.UpdateAccountPhone(r.Context(), claims.AccountID, req.Phone); err != nil {
		log.Printf("account/phone update failed for account %s: %v", claims.AccountID, err)
		httpx.Error(w, http.StatusInternalServerError, "update phone failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// SignOut — POST /v1/auth/signout (PROTECTED).
//
// Deletes auth_credentials(install_id, provider). The JWT is not blacklisted;
// it'll fail middleware's revoked-cache check on next use because the row
// is gone. Mobile should also discard its stored session_jwt.
func (h *Handler) SignOut(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if err := h.svc.SignOut(r.Context(), claims.InstallID, claims.Provider); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "sign-out failed")
		return
	}
	// Drop the cached "not revoked" entry so the next request hits Postgres
	// and learns the row is gone. Without this, the JWT keeps authorizing
	// for up to revokedCacheTTL (60s) after sign-out.
	if h.authenticator != nil {
		h.authenticator.Invalidate(claims.InstallID, claims.Provider)
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DeleteAccount — DELETE /v1/account (PROTECTED).
//
// Permanently erases the authenticated account and the data it solely owns
// (see Service.DeleteAccount). Idempotent-ish: a second call after the account
// is gone 401s at the middleware (credential row deleted). The mobile app must
// also wipe its local ledger + stored JWT after a 200.
func (h *Handler) DeleteAccount(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if err := h.svc.DeleteAccount(r.Context(), claims.AccountID); err != nil {
		log.Printf("account delete failed for account %s: %v", claims.AccountID, err)
		httpx.Error(w, http.StatusInternalServerError, "account deletion failed")
		return
	}
	// Kill the cached "not revoked" entry so the now-orphaned JWT stops
	// authorizing immediately rather than for up to revokedCacheTTL.
	if h.authenticator != nil {
		h.authenticator.Invalidate(claims.InstallID, claims.Provider)
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// isServerSideFailure reports whether a sign-in error is OUR problem rather
// than a bad credential — a database outage, a cancelled request (the phone
// gave up mid-flight, common on slow links), or a failure fetching Google's
// signing certificates. Those all used to fall through to a blanket 401,
// telling a shopkeeper their sign-in was rejected when the truth was that the
// server couldn't answer. Response bodies stay generic; only the STATUS
// changes, so the client can distinguish "retry this" from "this won't work".
func isServerSideFailure(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	msg := err.Error()
	for _, marker := range []string{
		"begin tx", "commit", "rollback", "connection refused", "connection reset",
		"driver: bad connection", "context canceled", "context deadline exceeded",
		"statement timeout", "clear stale auth credential", "certificate", "no such host",
	} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}
