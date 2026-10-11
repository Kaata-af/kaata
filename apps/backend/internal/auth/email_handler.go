package auth

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/mail"
)

// HTTP surface of Kaata email accounts (docs/kaata-accounts.md §6). Bodies are
// small JSON objects capped at 8 KiB. Logs carry the route, the install id and
// the error class only: never an address, identifier, code or password.

const emailBodyLimit = 8 << 10

type emailStartRequest struct {
	Email string `json:"email"`
	Lang  string `json:"lang"`
}

type emailSignUpVerifyRequest struct {
	InstallID        string `json:"install_id"`
	Email            string `json:"email"`
	Code             string `json:"code"`
	Password         string `json:"password"`
	Lang             string `json:"lang"`
	CurrentAccountID string `json:"current_account_id,omitempty"`
	AllowSwitch      bool   `json:"allow_switch,omitempty"`
}

type emailSignInRequest struct {
	InstallID        string `json:"install_id"`
	Identifier       string `json:"identifier"`
	Password         string `json:"password"`
	CurrentAccountID string `json:"current_account_id,omitempty"`
	AllowSwitch      bool   `json:"allow_switch,omitempty"`
}

type emailResetVerifyRequest struct {
	InstallID        string `json:"install_id"`
	Email            string `json:"email"`
	Code             string `json:"code"`
	NewPassword      string `json:"new_password"`
	Lang             string `json:"lang"`
	CurrentAccountID string `json:"current_account_id,omitempty"`
	AllowSwitch      bool   `json:"allow_switch,omitempty"`
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, emailBodyLimit)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_request", "invalid json body")
		return false
	}
	return true
}

func validInstall(w http.ResponseWriter, installID string) bool {
	if _, err := uuid.Parse(installID); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_request", "install_id must be a uuid")
		return false
	}
	return true
}

func codeSent(w http.ResponseWriter) {
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "sent", "resend_after_s": 60})
}

var logAddress = regexp.MustCompile(`[^\s<>"'(),;:=]+@[^\s<>"'(),;:=]+`)

// writeEmailError maps every error of these flows to its status and code.
func writeEmailError(w http.ResponseWriter, route, installID string, err error) {
	var (
		weak     *WeakPasswordError
		badEmail *InvalidEmailError
		thr      *ThrottledError
		limited  *RateLimitedError
		attempts *AttemptsError
		badUser  *InvalidUsernameError
		badName  *InvalidNameError
	)
	if writeSignInRefusal(w, err) {
		return
	}
	switch {
	case errors.As(err, &badEmail):
		httpx.ErrorFields(w, http.StatusBadRequest, "invalid_email", "this email address cannot be used",
			map[string]any{"reason": badEmail.Reason})
	case errors.As(err, &weak):
		httpx.ErrorFields(w, http.StatusBadRequest, "weak_password", "choose a stronger password",
			map[string]any{"reason": weak.Reason})
	case errors.Is(err, ErrInvalidCodeFormat):
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_code_format", "the code must be 6 digits")
	case errors.Is(err, ErrInvalidCode):
		httpx.ErrorCode(w, http.StatusUnauthorized, "invalid_code", "the code is wrong or has expired")
	case errors.Is(err, ErrInvalidCredentials):
		httpx.ErrorCode(w, http.StatusUnauthorized, "invalid_credentials", "email/username or password is incorrect")
	case errors.As(err, &thr):
		secs := RetryAfterSeconds(thr.RetryAfter)
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		httpx.ErrorFields(w, http.StatusTooManyRequests, "too_many_requests", "too many requests; try again later",
			map[string]any{"retry_after_s": secs, "limit": thr.Limit})
	case errors.As(err, &limited):
		secs := RetryAfterSeconds(limited.RetryAfter)
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		httpx.ErrorFields(w, http.StatusTooManyRequests, "rate_limited", "too many requests; try again later",
			map[string]any{"retry_after_s": secs})
	case errors.As(err, &attempts):
		secs := RetryAfterSeconds(attempts.RetryAfter)
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		httpx.ErrorFields(w, http.StatusTooManyRequests, "too_many_attempts", "too many attempts; try again later",
			map[string]any{"retry_after_s": secs})
	case errors.Is(err, ErrAccountExists):
		httpx.ErrorCode(w, http.StatusConflict, "account_exists", "an account already uses this email")
	case errors.Is(err, ErrWrongPassword):
		// 403, never 401: in this app a 401 means the session ended.
		httpx.ErrorCode(w, http.StatusForbidden, "wrong_password", "the current password is incorrect")
	case errors.Is(err, ErrNoPassword):
		httpx.ErrorCode(w, http.StatusConflict, "no_password", "this account has no password yet")
	case errors.Is(err, ErrPasswordExists):
		httpx.ErrorCode(w, http.StatusConflict, "password_exists", "this account already has a password")
	case errors.Is(err, ErrEmailInUse):
		httpx.ErrorCode(w, http.StatusConflict, "email_in_use", "this email belongs to another account")
	case errors.Is(err, ErrEmailRequired):
		httpx.ErrorCode(w, http.StatusBadRequest, "email_required", "enter the email address to sign in with")
	case errors.Is(err, ErrEmailFixed):
		httpx.ErrorCode(w, http.StatusConflict, "email_fixed", "the password must use this account's own email")
	case errors.Is(err, ErrProviderSessionRequired):
		httpx.ErrorCode(w, http.StatusForbidden, "provider_session_required",
			"sign in with Google or Apple to remove the password")
	case errors.Is(err, ErrSessionRevoked):
		httpx.Error(w, http.StatusUnauthorized, "session has been revoked")
	case errors.As(err, &badUser):
		httpx.ErrorFields(w, http.StatusBadRequest, "invalid_username", "this username cannot be used",
			map[string]any{"reason": badUser.Reason})
	case errors.Is(err, ErrUsernameTaken):
		httpx.ErrorCode(w, http.StatusConflict, "username_taken", "this username is taken")
	case errors.As(err, &badName):
		httpx.ErrorFields(w, http.StatusBadRequest, "invalid_name", "the name must be 2 to 60 characters",
			map[string]any{"reason": "length"})
	case errors.Is(err, ErrProviderName):
		httpx.ErrorCode(w, http.StatusConflict, "provider_name", "this account's name comes from Google or Apple")
	case errors.Is(err, mail.ErrUnavailable):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "email_unavailable", "email is unavailable right now")
	case errors.Is(err, ErrHashBusy):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "busy", "the server is busy; try again")
	default:
		log.Printf("%s failed for install %s: %s", route, installID, logAddress.ReplaceAllString(err.Error(), "<address>"))
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "unavailable", "sign-in is temporarily unavailable; try again")
	}
}

// writeAccountError is writeEmailError for session routes, where a 401 must
// mean only that the session ended (the app signs out on it): a wrong code
// there is 400.
func writeAccountError(w http.ResponseWriter, route, installID string, err error) {
	if errors.Is(err, ErrInvalidCode) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_code", "the code is wrong or has expired")
		return
	}
	writeEmailError(w, route, installID, err)
}

// EmailSignUpStart — POST /v1/auth/email/signup/start (PUBLIC).
func (h *Handler) EmailSignUpStart(w http.ResponseWriter, r *http.Request) {
	var req emailStartRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if err := h.svc.EmailSignUpStart(r.Context(), req.Email, req.Lang, ClientKey(httpx.ClientIP(r))); err != nil {
		writeEmailError(w, "auth/email/signup/start", "-", err)
		return
	}
	codeSent(w)
}

// EmailSignUpVerify — POST /v1/auth/email/signup/verify (PUBLIC).
func (h *Handler) EmailSignUpVerify(w http.ResponseWriter, r *http.Request) {
	var req emailSignUpVerifyRequest
	if !decodeBody(w, r, &req) || !validInstall(w, req.InstallID) {
		return
	}
	result, err := h.svc.EmailSignUpVerify(r.Context(), req.InstallID, req.Email, req.Code, req.Password,
		SwitchOptions{CurrentAccountID: req.CurrentAccountID, AllowSwitch: req.AllowSwitch})
	if err != nil {
		writeEmailError(w, "auth/email/signup/verify", req.InstallID, err)
		return
	}
	h.signedIn(w, req.InstallID, result)
}

// EmailSignIn — POST /v1/auth/email/signin (PUBLIC).
func (h *Handler) EmailSignIn(w http.ResponseWriter, r *http.Request) {
	var req emailSignInRequest
	if !decodeBody(w, r, &req) || !validInstall(w, req.InstallID) {
		return
	}
	result, err := h.svc.EmailSignIn(r.Context(), req.InstallID, req.Identifier, req.Password,
		SwitchOptions{CurrentAccountID: req.CurrentAccountID, AllowSwitch: req.AllowSwitch})
	if err != nil {
		writeEmailError(w, "auth/email/signin", req.InstallID, err)
		return
	}
	h.signedIn(w, req.InstallID, result)
}

// EmailResetStart — POST /v1/auth/email/reset/start (PUBLIC).
func (h *Handler) EmailResetStart(w http.ResponseWriter, r *http.Request) {
	var req emailStartRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if err := h.svc.EmailResetStart(r.Context(), req.Email, req.Lang, ClientKey(httpx.ClientIP(r))); err != nil {
		writeEmailError(w, "auth/email/reset/start", "-", err)
		return
	}
	codeSent(w)
}

// EmailResetVerify — POST /v1/auth/email/reset/verify (PUBLIC).
func (h *Handler) EmailResetVerify(w http.ResponseWriter, r *http.Request) {
	var req emailResetVerifyRequest
	if !decodeBody(w, r, &req) || !validInstall(w, req.InstallID) {
		return
	}
	result, err := h.svc.EmailResetVerify(r.Context(), req.InstallID, req.Email, req.Code, req.NewPassword, req.Lang,
		SwitchOptions{CurrentAccountID: req.CurrentAccountID, AllowSwitch: req.AllowSwitch})
	if err != nil {
		writeEmailError(w, "auth/email/reset/verify", req.InstallID, err)
		return
	}
	// Every other session of the account was deleted: drop their cached verdicts.
	if h.authenticator != nil {
		h.authenticator.InvalidateAccount(result.AccountID)
	}
	h.signedIn(w, req.InstallID, result)
}

func (h *Handler) signedIn(w http.ResponseWriter, installID string, result GoogleSignInResult) {
	if h.authenticator != nil {
		h.authenticator.InvalidateInstall(installID)
	}
	httpx.JSON(w, http.StatusOK, result)
}

func sessionClaims(w http.ResponseWriter, r *http.Request) (*SessionClaims, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
	}
	return claims, ok
}

// AccountMe — GET /v1/account/me (PROTECTED).
func (h *Handler) AccountMe(w http.ResponseWriter, r *http.Request) {
	claims, ok := sessionClaims(w, r)
	if !ok {
		return
	}
	me, err := h.svc.AccountMe(r.Context(), claims.AccountID)
	if err != nil {
		writeAccountError(w, "account/me", claims.InstallID, err)
		return
	}
	httpx.JSON(w, http.StatusOK, me)
}

// PasswordSetupStart — POST /v1/account/password/setup/start (PROTECTED).
func (h *Handler) PasswordSetupStart(w http.ResponseWriter, r *http.Request) {
	claims, ok := sessionClaims(w, r)
	if !ok {
		return
	}
	var req emailStartRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if err := h.svc.PasswordSetupStart(r.Context(), claims.AccountID, req.Email, req.Lang); err != nil {
		writeAccountError(w, "account/password/setup/start", claims.InstallID, err)
		return
	}
	codeSent(w)
}

type passwordSetupVerifyRequest struct {
	Code        string `json:"code"`
	NewPassword string `json:"new_password"`
	Lang        string `json:"lang"`
}

// PasswordSetupVerify — POST /v1/account/password/setup/verify (PROTECTED).
func (h *Handler) PasswordSetupVerify(w http.ResponseWriter, r *http.Request) {
	claims, ok := sessionClaims(w, r)
	if !ok {
		return
	}
	var req passwordSetupVerifyRequest
	if !decodeBody(w, r, &req) {
		return
	}
	loginEmail, err := h.svc.PasswordSetupVerify(r.Context(), claims.AccountID, claims.InstallID, req.Code,
		req.NewPassword, req.Lang)
	if err != nil {
		writeAccountError(w, "account/password/setup/verify", claims.InstallID, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"has_password": true, "login_email": loginEmail})
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
	Lang            string `json:"lang"`
}

// ChangePassword — PUT /v1/account/password (PROTECTED).
func (h *Handler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	claims, ok := sessionClaims(w, r)
	if !ok {
		return
	}
	var req changePasswordRequest
	if !decodeBody(w, r, &req) {
		return
	}
	sessionJWT, err := h.svc.ChangePassword(r.Context(), claims, req.CurrentPassword, req.NewPassword, req.Lang)
	if err != nil {
		writeAccountError(w, "account/password", claims.InstallID, err)
		return
	}
	// The account's other sessions were deleted: drop their cached verdicts.
	if h.authenticator != nil {
		h.authenticator.InvalidateAccount(claims.AccountID)
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok", "session_jwt": sessionJWT})
}

// RemovePassword — DELETE /v1/account/password (PROTECTED), Google or Apple
// sessions only. Optional ?lang= for the notice.
func (h *Handler) RemovePassword(w http.ResponseWriter, r *http.Request) {
	claims, ok := sessionClaims(w, r)
	if !ok {
		return
	}
	if err := h.svc.RemovePassword(r.Context(), claims.AccountID, claims.Provider, r.URL.Query().Get("lang")); err != nil {
		writeAccountError(w, "account/password/remove", claims.InstallID, err)
		return
	}
	// The account's email sessions were deleted: drop their cached verdicts.
	if h.authenticator != nil {
		h.authenticator.InvalidateAccount(claims.AccountID)
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"has_password": false})
}

// SetUsername — PUT /v1/account/username (PROTECTED). "" removes it.
func (h *Handler) SetUsername(w http.ResponseWriter, r *http.Request) {
	claims, ok := sessionClaims(w, r)
	if !ok {
		return
	}
	var req struct {
		Username string `json:"username"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	u, err := h.svc.SetUsername(r.Context(), claims.AccountID, req.Username)
	if err != nil {
		writeAccountError(w, "account/username", claims.InstallID, err)
		return
	}
	var out any
	if u != "" {
		out = u
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"username": out})
}

// SetAccountName — PUT /v1/account/name (PROTECTED), email-only accounts.
func (h *Handler) SetAccountName(w http.ResponseWriter, r *http.Request) {
	claims, ok := sessionClaims(w, r)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	name, err := h.svc.SetAccountName(r.Context(), claims.AccountID, req.Name)
	if err != nil {
		writeAccountError(w, "account/name", claims.InstallID, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"name": name})
}
