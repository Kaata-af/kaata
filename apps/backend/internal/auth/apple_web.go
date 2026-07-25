package auth

// Sign in with Apple — the ANDROID/WEB flow.
//
// Android has no Apple SDK, so Apple sign-in there is Apple's web OAuth:
// the app opens a browser auth session at our /v1/auth/apple/web/start,
// which redirects to appleid.apple.com; after the user authenticates, Apple
// form_posts the identity token to our /v1/auth/apple/web/callback, and the
// callback bounces it straight back into the app via the kaata:// deep link.
// The app then calls the EXISTING POST /v1/auth/apple with the token — one
// session-minting path for both platforms; the only backend difference is
// the token's audience (the SERVICES ID instead of the bundle id, handled
// by VerifyAppleIDToken's audience set).
//
// Deliberate design properties:
//   - response_type = "code id_token": the identity token arrives directly
//     in the form_post, so we never exchange the code and need NO Apple
//     client-secret key (.p8) — the whole client-secret JWT machinery is
//     avoided. The code is ignored.
//   - The trampoline is a DUMB RELAY. It verifies nothing and mints
//     nothing: verification + session issuance live solely in
//     POST /v1/auth/apple. state is generated AND checked by the app
//     (round-tripped opaquely), standard RFC 8252 native-app practice.
//   - The payload rides the deep link's FRAGMENT (#…), not the query, so
//     it never appears in server access logs along the way.
//   - Setup needed in the Apple Developer console: a Services ID with
//     Sign in with Apple enabled, domain api.kaata.af verified, and return
//     URL <PublicAPIBaseURL>/v1/auth/apple/web/callback registered. The
//     Services ID lands in the APPLE_SERVICES_ID env; unset = both
//     endpoints answer 404 (feature off).

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/matee/kaata-backend/internal/httpx"
)

// appleWebRedirectScheme is the deep link the callback bounces the token
// into. The app's registered scheme (app.json `scheme: "kaata"`); the
// browser auth session on the phone watches for exactly this prefix.
const appleWebRedirectScheme = "kaata://apple-auth"

const appleAuthorizeURL = "https://appleid.apple.com/auth/authorize"

// callbackURL builds the absolute return URL Apple posts back to. Prefers
// the configured public origin; falls back to the request host (correct
// behind the TLS-terminating proxy in every current deployment).
func (h *Handler) appleWebCallbackURL(r *http.Request) string {
	base := strings.TrimSuffix(h.publicAPIBaseURL, "/")
	if base == "" {
		base = "https://" + r.Host
	}
	return base + "/v1/auth/apple/web/callback"
}

// AppleWebStart — GET /v1/auth/apple/web/start?state=... (PUBLIC).
//
// Redirects to Apple's authorize page. state is the app's own random nonce,
// round-tripped verbatim; the app refuses a callback whose state it didn't
// mint.
func (h *Handler) AppleWebStart(w http.ResponseWriter, r *http.Request) {
	servicesID := h.svc.AppleServicesID()
	if servicesID == "" {
		httpx.Error(w, http.StatusNotFound, "apple web sign-in is not configured")
		return
	}
	state := r.URL.Query().Get("state")
	if state == "" || len(state) > 256 {
		httpx.Error(w, http.StatusBadRequest, "state is required (max 256 chars)")
		return
	}

	q := url.Values{}
	q.Set("client_id", servicesID)
	q.Set("redirect_uri", h.appleWebCallbackURL(r))
	q.Set("response_type", "code id_token")
	q.Set("response_mode", "form_post") // required by Apple when scopes are requested
	q.Set("scope", "name email")
	q.Set("state", state)
	http.Redirect(w, r, appleAuthorizeURL+"?"+q.Encode(), http.StatusFound)
}

// AppleWebCallback — POST /v1/auth/apple/web/callback (PUBLIC, form_post
// from appleid.apple.com).
//
// Fields (per Apple): id_token, code (ignored — see file header), state,
// user (JSON with the name, FIRST authorization only), error
// ("user_cancelled_authorize" when the user backs out).
//
// Responds with a redirect into the app's deep link, payload in the
// fragment. A tiny HTML fallback link covers browsers that refuse the
// custom-scheme redirect.
func (h *Handler) AppleWebCallback(w http.ResponseWriter, r *http.Request) {
	if h.svc.AppleServicesID() == "" {
		httpx.Error(w, http.StatusNotFound, "apple web sign-in is not configured")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid form body")
		return
	}

	frag := url.Values{}
	if state := r.PostForm.Get("state"); state != "" && len(state) <= 256 {
		frag.Set("state", state)
	}
	if errCode := r.PostForm.Get("error"); errCode != "" {
		frag.Set("error", errCode)
	} else {
		idToken := r.PostForm.Get("id_token")
		if idToken == "" {
			frag.Set("error", "missing_id_token")
		} else {
			frag.Set("id_token", idToken)
		}
		// First-authorization-only name JSON — relayed verbatim; the app
		// parses it and applies its one-shot name-stash discipline exactly
		// like the native iOS path.
		if user := r.PostForm.Get("user"); user != "" && len(user) <= 2048 {
			frag.Set("user", user)
		}
	}

	target := appleWebRedirectScheme + "#" + frag.Encode()
	// 302 + HTML fallback: Chrome Custom Tabs follows the custom-scheme
	// redirect and hands the URL back to the app's auth session; anything
	// that refuses gets a tappable link.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Location", target)
	w.WriteHeader(http.StatusFound)
	_, _ = w.Write([]byte(
		`<!doctype html><meta charset="utf-8"><title>Kaata</title>` +
			`<a href="` + htmlAttrEscape(target) + `">Return to Kaata</a>`))
}

// htmlAttrEscape covers the fragment payload's few risky characters for the
// fallback link. The values are urlencoded already; & and " are the ones
// that could break out of the attribute.
func htmlAttrEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	return s
}
