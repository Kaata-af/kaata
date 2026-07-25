package auth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func newWebFlowHandler(servicesID string) *Handler {
	svc := NewService(nil, "web-client", "0123456789abcdef0123456789abcdef")
	svc.SetAppleServicesID(servicesID)
	h := NewHandler(svc)
	h.SetPublicAPIBaseURL("https://api.kaata.af")
	return h
}

func TestAppleWebStart_RedirectsToAppleAuthorize(t *testing.T) {
	h := newWebFlowHandler("af.kaata.auth")
	rec := httptest.NewRecorder()
	h.AppleWebStart(rec, httptest.NewRequest(http.MethodGet, "/v1/auth/apple/web/start?state=abc123", nil))

	res := rec.Result()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want 302", res.StatusCode)
	}
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatalf("parse Location: %v", err)
	}
	if loc.Host != "appleid.apple.com" || loc.Path != "/auth/authorize" {
		t.Fatalf("Location = %s, want appleid.apple.com/auth/authorize", loc)
	}
	q := loc.Query()
	checks := map[string]string{
		"client_id":     "af.kaata.auth",
		"redirect_uri":  "https://api.kaata.af/v1/auth/apple/web/callback",
		"response_type": "code id_token",
		"response_mode": "form_post",
		"scope":         "name email",
		"state":         "abc123",
	}
	for k, want := range checks {
		if got := q.Get(k); got != want {
			t.Errorf("authorize param %s = %q, want %q", k, got, want)
		}
	}
}

func TestAppleWebStart_RequiresConfigAndState(t *testing.T) {
	// Unconfigured → 404 (feature off).
	off := newWebFlowHandler("")
	rec := httptest.NewRecorder()
	off.AppleWebStart(rec, httptest.NewRequest(http.MethodGet, "/v1/auth/apple/web/start?state=x", nil))
	if rec.Result().StatusCode != http.StatusNotFound {
		t.Errorf("unconfigured start = %d, want 404", rec.Result().StatusCode)
	}
	// Missing state → 400.
	on := newWebFlowHandler("af.kaata.auth")
	rec2 := httptest.NewRecorder()
	on.AppleWebStart(rec2, httptest.NewRequest(http.MethodGet, "/v1/auth/apple/web/start", nil))
	if rec2.Result().StatusCode != http.StatusBadRequest {
		t.Errorf("missing-state start = %d, want 400", rec2.Result().StatusCode)
	}
}

func TestAppleWebCallback_RelaysTokenIntoDeepLinkFragment(t *testing.T) {
	h := newWebFlowHandler("af.kaata.auth")
	form := url.Values{}
	form.Set("id_token", "eyJhbGciOiJSUzI1NiJ9.payload.sig")
	form.Set("code", "ignored-code")
	form.Set("state", "abc123")
	form.Set("user", `{"name":{"firstName":"Ahmad","lastName":"K"}}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/apple/web/callback",
		strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.AppleWebCallback(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want 302", res.StatusCode)
	}
	loc := res.Header.Get("Location")
	if !strings.HasPrefix(loc, "kaata://apple-auth#") {
		t.Fatalf("Location = %q, want kaata://apple-auth#...", loc)
	}
	frag, err := url.ParseQuery(strings.TrimPrefix(loc, "kaata://apple-auth#"))
	if err != nil {
		t.Fatalf("parse fragment: %v", err)
	}
	if frag.Get("id_token") != "eyJhbGciOiJSUzI1NiJ9.payload.sig" {
		t.Errorf("fragment id_token = %q", frag.Get("id_token"))
	}
	if frag.Get("state") != "abc123" {
		t.Errorf("fragment state = %q, want abc123", frag.Get("state"))
	}
	if !strings.Contains(frag.Get("user"), "Ahmad") {
		t.Errorf("fragment user = %q, want the first-auth name JSON relayed", frag.Get("user"))
	}
	if frag.Get("error") != "" {
		t.Errorf("fragment error = %q, want empty", frag.Get("error"))
	}
}

func TestAppleWebCallback_RelaysCancelError(t *testing.T) {
	h := newWebFlowHandler("af.kaata.auth")
	form := url.Values{}
	form.Set("error", "user_cancelled_authorize")
	form.Set("state", "abc123")
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/apple/web/callback",
		strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.AppleWebCallback(rec, req)

	loc := rec.Result().Header.Get("Location")
	frag, err := url.ParseQuery(strings.TrimPrefix(loc, "kaata://apple-auth#"))
	if err != nil {
		t.Fatalf("parse fragment: %v", err)
	}
	if frag.Get("error") != "user_cancelled_authorize" {
		t.Errorf("fragment error = %q, want user_cancelled_authorize", frag.Get("error"))
	}
	if frag.Get("id_token") != "" {
		t.Errorf("cancel relay carried an id_token")
	}
}
