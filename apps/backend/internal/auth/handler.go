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
	webBaseURL       string
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// SetPublicAPIBaseURL wires the backend's public origin for the Apple
// web-flow callback URL (apple_web.go).
func (h *Handler) SetPublicAPIBaseURL(u string) { h.publicAPIBaseURL = u }

// SetWebBaseURL fixes the browser Apple return origin; requests cannot choose it.
func (h *Handler) SetWebBaseURL(u string) { h.webBaseURL = u }

// SetAuthenticator wires the session authenticator so SignOut can invalidate
// the LRU revocation cache. Optional — without it SignOut still deletes the
// row server-side, but JWTs cached <60s ago will continue to authorize until
// the cache entry expires.
func (h *Handler) SetAuthenticator(a *SessionAuthenticator) {
	h.authenticator = a
}

type googleSignInRequest struct {
	InstallID                string                    `json:"install_id"`
	Platform                 string                    `json:"platform,omitempty"`
	IDToken                  string                    `json:"id_token"`
	Nonce                    string                    `json:"nonce,omitempty"`
	PendingVaultRegistration *PendingVaultRegistration `json:"pending_vault_registration,omitempty"`
	// The account this phone holds data for, and whether the user already
	// chose to switch away from it (409 different_account otherwise).
	CurrentAccountID string `json:"current_account_id,omitempty"`
	AllowSwitch      bool   `json:"allow_switch,omitempty"`
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

	result, err := h.svc.SignInWithGoogle(r.Context(), req.InstallID, req.IDToken, req.PendingVaultRegistration,
		SwitchOptions{CurrentAccountID: req.CurrentAccountID, AllowSwitch: req.AllowSwitch, Platform: req.Platform, Nonce: req.Nonce})
	if err != nil {
		if writeSignInRefusal(w, err) {
			return
		}
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
	// The sign-in replaced every other credential of this install, so drop
	// every cached verdict for it: a fresh session must not be 401'd for up to
	// 60s by a verdict cached against a prior JWT, and a replaced one must not
	// keep authorizing.
	if h.authenticator != nil {
		h.authenticator.InvalidateInstall(req.InstallID)
	}
	httpx.JSON(w, http.StatusOK, result)
}

type appleSignInRequest struct {
	InstallID        string `json:"install_id"`
	IDToken          string `json:"identity_token"`
	Platform         string `json:"platform,omitempty"`
	Nonce            string `json:"nonce,omitempty"`
	DisplayName      string `json:"display_name,omitempty"`
	CurrentAccountID string `json:"current_account_id,omitempty"`
	AllowSwitch      bool   `json:"allow_switch,omitempty"`
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
	result, err := h.svc.SignInWithApple(r.Context(), req.InstallID, req.IDToken, req.DisplayName,
		SwitchOptions{CurrentAccountID: req.CurrentAccountID, AllowSwitch: req.AllowSwitch, Platform: req.Platform, Nonce: req.Nonce})
	if err != nil {
		if writeSignInRefusal(w, err) {
			return
		}
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
		h.authenticator.InvalidateInstall(req.InstallID)
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
		if errors.Is(err, ErrSessionRevoked) {
			httpx.Error(w, http.StatusUnauthorized, "session has ended; sign in again")
			return
		}
		log.Printf("account/phone update failed for account %s: %v", claims.AccountID, err)
		httpx.Error(w, http.StatusInternalServerError, "update phone failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// SignOut — POST /v1/auth/signout (PROTECTED).
//
// Deletes every auth_credentials row of the install (one live credential per
// install). The JWT is not blacklisted;
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
	// Drop the install's cached verdicts so the next request hits Postgres
	// and learns the rows are gone. Without this, the JWT keeps authorizing
	// for up to revokedCacheTTL (60s) after sign-out.
	if h.authenticator != nil {
		h.authenticator.InvalidateInstall(claims.InstallID)
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DeleteAccount — DELETE /v1/account (PROTECTED).
//
// Permanently erases the authenticated account and the data it solely owns
// (see Service.DeleteAccount). DeletionMiddleware confirms completed retries
// using a signed, unexpired session and its matching server deletion receipt.
// The mobile app must also wipe its local ledger + stored JWT after a 200.
func (h *Handler) DeleteAccount(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	state, err := h.svc.RequestAccountDeletion(r.Context(), claims)
	if err != nil {
		if errors.Is(err, ErrDeletionSessionEnded) {
			httpx.Error(w, http.StatusUnauthorized, "session has ended; sign in again")
			return
		}
		log.Printf("account delete failed for account %s: %v", claims.AccountID, err)
		httpx.Error(w, http.StatusInternalServerError, "account deletion failed")
		return
	}
	// Drop every installation/provider verdict for this account, including
	// other phones, so their JWTs stop authorizing immediately.
	if h.authenticator != nil {
		h.authenticator.InvalidateAccount(claims.AccountID)
	}
	writeDeletionState(w, r, state)
}

func writeDeletionState(w http.ResponseWriter, r *http.Request, state AccountDeletionState) {
	// Older apps only recognize "deleted"; retain their acknowledgement shape
	// while keeping the same server recovery window for every account.
	if state.Status == "deletion_scheduled" && r.Header.Get("X-Kaata-Deletion-Grace") != "30" {
		state.Status = "deleted"
	}
	httpx.JSON(w, http.StatusOK, state)
}

func (h *Handler) AccountDeletionPolicy(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]int{"grace_days": 30})
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

const retiredInstallMessage = "This installation belongs to a deleted account. Export any local records, then reset the app before signing in."

// writeSignInRefusal answers the refusals every sign-in shares (the tail in
// signin.go): a retired install, a different account, a disabled account.
func writeSignInRefusal(w http.ResponseWriter, err error) bool {
	var diff *DifferentAccountError
	switch {
	case errors.Is(err, ErrInstallRetired):
		httpx.Error(w, http.StatusGone, retiredInstallMessage)
	case errors.As(err, &diff):
		httpx.ErrorFields(w, http.StatusConflict, "different_account",
			"this sign-in belongs to a different account than this phone's", map[string]any{"email": diff.Email})
	case errors.Is(err, ErrAccountDisabled):
		httpx.ErrorCode(w, http.StatusForbidden, "account_disabled", "this account is disabled")
	case errors.Is(err, ErrAccountDeletionExpired):
		httpx.ErrorCode(w, http.StatusForbidden, "account_deletion_expired", "the 30-day recovery window has ended; deletion will finish shortly")
	default:
		return false
	}
	return true
}
