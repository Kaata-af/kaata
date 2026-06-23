package auth

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	svc           *Service
	authenticator *SessionAuthenticator
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

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
		case strings.Contains(msg, "stale"):
			httpx.Error(w, http.StatusUnauthorized, "google id token is stale; please retry sign-in")
		case strings.Contains(msg, "missing iat"), strings.Contains(msg, "missing sub"), strings.Contains(msg, "iat is in the future"):
			httpx.Error(w, http.StatusUnauthorized, "google id token is malformed")
		case strings.Contains(msg, "pending_vault_registration"):
			httpx.Error(w, http.StatusBadRequest, msg)
		default:
			// (already logged above with the underlying error)
			httpx.Error(w, http.StatusUnauthorized, "google sign-in failed")
		}
		return
	}
	httpx.JSON(w, http.StatusOK, result)
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
