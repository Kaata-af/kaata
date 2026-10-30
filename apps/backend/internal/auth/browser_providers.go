package auth

import (
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/matee/kaata-backend/internal/httpx"
)

const (
	appleBrowserStatePrefix = "kaata_web."
	appleBrowserStateIssuer = "kaata-apple-browser"
	appleBrowserStateTTL    = 10 * time.Minute
)

type appleBrowserState struct {
	State        string `json:"state"`
	Nonce        string `json:"nonce"`
	ReturnOrigin string `json:"return_origin"`
	jwt.RegisteredClaims
}

func validBrowserChallenge(value string) bool {
	if len(value) < 32 || len(value) > 128 {
		return false
	}
	for _, ch := range value {
		if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') || ch == '-' || ch == '_') {
			return false
		}
	}
	return true
}

// An omitted nonce retains the existing native contract. Browser handlers
// require one; when supplied, compare only to cryptographically verified claims.
func verifyProviderNonce(expected, actual string) error {
	if expected == "" {
		return nil
	}
	if !validBrowserChallenge(expected) || subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) != 1 {
		return errors.New("provider sign-in nonce did not match")
	}
	return nil
}

func browserHTTPSOrigin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" ||
		u.Opaque != "" || strings.EqualFold(u.Hostname(), "localhost") || net.ParseIP(u.Hostname()) != nil {
		return ""
	}
	return "https://" + strings.ToLower(u.Host)
}

func (h *Handler) appleBrowserOrigins() (apiOrigin, webOrigin string, ready bool) {
	apiOrigin = browserHTTPSOrigin(h.publicAPIBaseURL)
	webOrigin = browserHTTPSOrigin(h.webBaseURL)
	// Kaata's canonical deployment uses this API origin even when the legacy
	// SSR origin setting is unset. Custom sites require explicit configuration;
	// never derive a callback from Host or override an explicitly invalid URL.
	if h.publicAPIBaseURL == "" && webOrigin == "https://kaata.af" {
		apiOrigin = "https://api.kaata.af"
	}
	ready = h.svc.appleServicesID != "" && h.svc.appleClientID != "" && h.svc.sessionSecret != "" &&
		apiOrigin != "" && webOrigin != ""
	return
}

// Keep pending sign-in, existing sessions and unsaved writes on the browser's
// original origin. Only the configured site and Kaata's explicit www alias are
// allowed; a callback cannot choose another destination by adding form fields.
func (h *Handler) approvedAppleBrowserReturn(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") {
		return "", false
	}
	origin := browserHTTPSOrigin(raw)
	configured := browserHTTPSOrigin(h.webBaseURL)
	allowed := origin != "" && (origin == configured ||
		(configured == "https://kaata.af" && origin == "https://www.kaata.af"))
	return origin, allowed
}

// Providers exposes public client configuration so a static web deployment
// uses exactly the IDs that the backend verifies. No client secrets are used.
func (h *Handler) Providers(w http.ResponseWriter, r *http.Request) {
	response := map[string]any{"google": nil, "apple": nil}
	if h.svc.googleWebClientID != "" && h.svc.sessionSecret != "" {
		response["google"] = map[string]string{"client_id": h.svc.googleWebClientID}
	}
	if api, _, ready := h.appleBrowserOrigins(); ready {
		response["apple"] = map[string]string{"start_url": api + "/v1/auth/apple/browser/start"}
	}
	w.Header().Set("Cache-Control", "public, max-age=60")
	httpx.JSON(w, http.StatusOK, response)
}

// AppleBrowserStart reuses the already-registered native web callback. Only
// signed, browser-purpose state selects an approved HTTPS return origin.
// The client separately keeps its one-use state and nonce in sessionStorage.
func (h *Handler) AppleBrowserStart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	api, web, ready := h.appleBrowserOrigins()
	if !ready {
		httpx.Error(w, http.StatusNotFound, "apple browser sign-in is not configured")
		return
	}
	query := r.URL.Query()
	if len(query["state"]) != 1 || len(query["nonce"]) != 1 ||
		!validBrowserChallenge(query.Get("state")) || !validBrowserChallenge(query.Get("nonce")) {
		httpx.Error(w, http.StatusBadRequest, "state and nonce must be 32-128 URL-safe characters")
		return
	}
	returnOrigin := web
	if values, supplied := query["return_origin"]; supplied {
		var allowed bool
		if len(values) == 1 {
			returnOrigin, allowed = h.approvedAppleBrowserReturn(values[0])
		}
		if !allowed {
			httpx.Error(w, http.StatusBadRequest, "return origin is not allowed")
			return
		}
	}
	now := time.Now()
	state := appleBrowserState{State: query.Get("state"), Nonce: query.Get("nonce"), ReturnOrigin: returnOrigin, RegisteredClaims: jwt.RegisteredClaims{
		Issuer: appleBrowserStateIssuer, Audience: jwt.ClaimStrings{appleBrowserStateIssuer},
		IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(appleBrowserStateTTL)),
	}}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, state).SignedString([]byte(h.svc.sessionSecret))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "apple sign-in is temporarily unavailable")
		return
	}
	authorize := url.Values{
		"client_id": {h.svc.appleServicesID}, "redirect_uri": {api + "/v1/auth/apple/web/callback"},
		"response_type": {"code id_token"}, "response_mode": {"form_post"}, "scope": {"name email"},
		"state": {appleBrowserStatePrefix + signed}, "nonce": {state.Nonce},
	}
	http.Redirect(w, r, appleAuthorizeURL+"?"+authorize.Encode(), http.StatusFound)
}

func (h *Handler) parseAppleBrowserState(raw string) (*appleBrowserState, error) {
	if !strings.HasPrefix(raw, appleBrowserStatePrefix) || len(raw) > 2048 {
		return nil, errors.New("invalid browser state")
	}
	state := &appleBrowserState{}
	_, err := jwt.ParseWithClaims(strings.TrimPrefix(raw, appleBrowserStatePrefix), state, func(*jwt.Token) (any, error) {
		return []byte(h.svc.sessionSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(appleBrowserStateIssuer),
		jwt.WithAudience(appleBrowserStateIssuer), jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil || !validBrowserChallenge(state.State) || !validBrowserChallenge(state.Nonce) ||
		state.IssuedAt == nil || state.ExpiresAt == nil || state.ExpiresAt.Sub(state.IssuedAt.Time) > appleBrowserStateTTL {
		return nil, errors.New("invalid or expired browser state")
	}
	if origin, allowed := h.approvedAppleBrowserReturn(state.ReturnOrigin); !allowed || origin != state.ReturnOrigin {
		return nil, errors.New("invalid browser return origin")
	}
	return state, nil
}

// Called only for reserved browser state. Malformed/expired state must fail
// closed, never fall through to the legacy native deep-link relay.
func (h *Handler) appleBrowserCallback(w http.ResponseWriter, r *http.Request) {
	_, _, ready := h.appleBrowserOrigins()
	if !ready {
		httpx.Error(w, http.StatusNotFound, "apple browser sign-in is not configured")
		return
	}
	if len(r.PostForm["state"]) != 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid browser state")
		return
	}
	state, err := h.parseAppleBrowserState(r.PostForm.Get("state"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid or expired browser state")
		return
	}
	fragment := url.Values{"kaata_apple": {"1"}, "state": {state.State}}
	if code := r.PostForm.Get("error"); code != "" {
		if code == "user_cancelled_authorize" {
			fragment.Set("error", code)
		} else {
			fragment.Set("error", "apple_sign_in_failed")
		}
	} else {
		identityToken := r.PostForm.Get("id_token")
		if len(r.PostForm["id_token"]) != 1 || identityToken == "" || len(identityToken) > 8192 {
			fragment.Set("error", "missing_id_token")
		} else if payload, verifyErr := VerifyAppleIDToken(r.Context(), identityToken, h.svc.appleServicesID); verifyErr != nil ||
			verifyProviderNonce(state.Nonce, payload.Nonce) != nil {
			fragment.Set("error", "apple_sign_in_failed")
		} else {
			fragment.Set("identity_token", identityToken)
			if user := r.PostForm.Get("user"); user != "" && len(user) <= 2048 {
				fragment.Set("user", user)
			}
		}
	}
	// 303 converts Apple's cross-site form POST into an ordinary page GET.
	// The fragment never travels in the return request or its access logs.
	http.Redirect(w, r, state.ReturnOrigin+"/app#"+fragment.Encode(), http.StatusSeeOther)
}
