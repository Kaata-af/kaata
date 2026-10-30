package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

const browserTestSecret = "browser-auth-test-secret-not-a-production-key"

var browserTestNonce = strings.Repeat("a", 64)
var browserTestState = strings.Repeat("b", 64)

func newBrowserProviderHandler() *Handler {
	svc := NewService(nil, "browser-google.apps.googleusercontent.com", browserTestSecret)
	svc.SetAppleClientID("af.kaata.app")
	svc.SetAppleServicesID("af.kaata.auth")
	h := NewHandler(svc)
	h.SetPublicAPIBaseURL("https://api.kaata.af")
	h.SetWebBaseURL("https://kaata.af")
	return h
}

func browserStartState(t *testing.T, h *Handler, returnOrigin ...string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	query := url.Values{"state": {browserTestState}, "nonce": {browserTestNonce}, "return_to": {"https://attacker.invalid"}}
	if len(returnOrigin) > 0 {
		query.Set("return_origin", returnOrigin[0])
	}
	h.AppleBrowserStart(rec, httptest.NewRequest(http.MethodGet,
		"https://host-header.invalid/v1/auth/apple/browser/start?"+query.Encode(), nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("start status=%d", rec.Code)
	}
	authorize, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if authorize.Scheme != "https" || authorize.Host != "appleid.apple.com" || authorize.Path != "/auth/authorize" {
		t.Fatal("wrong Apple authorize destination")
	}
	want := map[string]string{
		"client_id": "af.kaata.auth", "redirect_uri": "https://api.kaata.af/v1/auth/apple/web/callback",
		"response_type": "code id_token", "response_mode": "form_post", "scope": "name email", "nonce": browserTestNonce,
	}
	for key, value := range want {
		if authorize.Query().Get(key) != value {
			t.Errorf("authorize %s = %q, want %q", key, authorize.Query().Get(key), value)
		}
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("authorization state response must not be cached or sent as a referrer")
	}
	return authorize.Query().Get("state")
}

func browserCallback(h *Handler, form url.Values) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/apple/web/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.AppleWebCallback(rec, req)
	return rec
}

func browserFragment(t *testing.T, rec *httptest.ResponseRecorder) url.Values {
	t.Helper()
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("callback status=%d, want303", rec.Code)
	}
	location, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Scheme != "https" || location.Host != "kaata.af" || location.Path != "/app" || location.RawQuery != "" {
		t.Fatal("browser callback escaped fixed app destination or placed credentials in query")
	}
	fragment, err := url.ParseQuery(location.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	if fragment.Get("kaata_apple") != "1" || fragment.Get("state") != browserTestState {
		t.Fatal("browser response lost original pending state")
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("callback response lacks credential privacy headers")
	}
	return fragment
}

func TestBrowserProvidersExposeOnlyReadyPublicConfiguration(t *testing.T) {
	h := newBrowserProviderHandler()
	read := func() map[string]json.RawMessage {
		rec := httptest.NewRecorder()
		h.Providers(rec, httptest.NewRequest(http.MethodGet, "https://attacker.invalid/v1/auth/providers", nil))
		if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), browserTestSecret) {
			t.Fatal("provider config status or secret disclosure")
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	body := read()
	if string(body["google"]) != `{"client_id":"browser-google.apps.googleusercontent.com"}` ||
		string(body["apple"]) != `{"start_url":"https://api.kaata.af/v1/auth/apple/browser/start"}` {
		t.Fatalf("unexpected public config: %v", body)
	}
	h.svc.googleWebClientID = ""
	if string(read()["google"]) != "null" {
		t.Fatal("unconfigured Google advertised")
	}
	for _, bad := range []string{"", "http://kaata.af", "https://localhost", "https://127.0.0.1", "https://user@kaata.af", "https://kaata.af/path", "https://kaata.af?to=evil", "https://kaata.af#evil"} {
		h.SetWebBaseURL(bad)
		if string(read()["apple"]) != "null" {
			t.Fatalf("Apple advertised with invalid web origin %q", bad)
		}
		rec := httptest.NewRecorder()
		h.AppleBrowserStart(rec, httptest.NewRequest(http.MethodGet, "/?state="+browserTestState+"&nonce="+browserTestNonce, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatal("unsafe browser configuration accepted")
		}
	}
	h.SetWebBaseURL("https://kaata.af")
	h.SetPublicAPIBaseURL("")
	if string(read()["apple"]) != `{"start_url":"https://api.kaata.af/v1/auth/apple/browser/start"}` {
		t.Fatal("canonical Kaata deployment lost its fixed default API")
	}
	for _, webOrigin := range []string{"https://kaata.af", "https://KAATA.AF/"} {
		h.SetWebBaseURL(webOrigin)
		browserStartState(t, h) // uses canonical API, never malicious request Host
	}
	for _, webOrigin := range []string{"https://kaata.af:443", "https://www.kaata.af", "https://other.af", "https://kaata.af/path"} {
		h.SetWebBaseURL(webOrigin)
		if string(read()["apple"]) != "null" {
			t.Fatalf("custom web origin %q inherited canonical API", webOrigin)
		}
	}
	h.SetWebBaseURL("https://kaata.af")
	for _, explicitAPI := range []string{" ", "http://api.kaata.af", "https://api.kaata.af/path", "https://api.kaata.af?x=1"} {
		h.SetPublicAPIBaseURL(explicitAPI)
		if string(read()["apple"]) != "null" {
			t.Fatalf("explicitly invalid API %q was replaced by a default", explicitAPI)
		}
	}
	h.SetPublicAPIBaseURL("https://api.kaata.af")
	h.svc.appleServicesID = ""
	if string(read()["apple"]) != "null" {
		t.Fatal("Apple advertised without Services ID")
	}
}

func TestAppleBrowserStateIsBoundedSignedAndPurposeSpecific(t *testing.T) {
	h := newBrowserProviderHandler()
	signed := browserStartState(t, h)
	parsed, err := h.parseAppleBrowserState(signed)
	if err != nil || parsed.State != browserTestState || parsed.Nonce != browserTestNonce || parsed.ReturnOrigin != "https://kaata.af" {
		t.Fatalf("signed state did not preserve challenges: %v", err)
	}
	if _, err := ParseSession(browserTestSecret, strings.TrimPrefix(signed, appleBrowserStatePrefix)); err == nil {
		t.Fatal("public browser state authorized as a Kaata session")
	}
	for _, query := range []string{"", "state=short&nonce=" + browserTestNonce, "state=" + browserTestState + "&nonce=short",
		"state=" + browserTestState + "&nonce=" + browserTestNonce + "&state=" + browserTestState,
		"state=" + strings.Repeat("a", 129) + "&nonce=" + browserTestNonce} {
		rec := httptest.NewRecorder()
		h.AppleBrowserStart(rec, httptest.NewRequest(http.MethodGet, "/?"+query, nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("bad challenge status=%d", rec.Code)
		}
	}
	sign := func(state appleBrowserState) string {
		token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, state).SignedString([]byte(browserTestSecret))
		if err != nil {
			t.Fatal(err)
		}
		return appleBrowserStatePrefix + token
	}
	expired := *parsed
	expired.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Second))
	wrongPurpose := *parsed
	wrongPurpose.Issuer = SessionIssuer
	wrongAudience := *parsed
	wrongAudience.Audience = jwt.ClaimStrings{"unrelated"}
	invalid := []string{appleBrowserStatePrefix + "invalid", signed + "x", sign(expired), sign(wrongPurpose), sign(wrongAudience), appleBrowserStatePrefix + strings.Repeat("x", 3000)}
	for _, state := range invalid {
		rec := browserCallback(h, url.Values{"state": {state}, "id_token": {"must-not-be-relayed"}})
		if rec.Code != http.StatusBadRequest || rec.Header().Get("Location") != "" || strings.Contains(rec.Body.String(), "must-not-be-relayed") {
			t.Fatal("invalid browser state fell through or relayed a token")
		}
	}
	rec := browserCallback(h, url.Values{"state": {"native-first", signed}, "id_token": {"must-not-be-relayed"}})
	if rec.Code != http.StatusBadRequest || rec.Header().Get("Location") != "" {
		t.Fatal("duplicate state bypassed reserved browser state check")
	}
}

func TestAppleBrowserReturnOriginPreservesOnlyApprovedSites(t *testing.T) {
	h := newBrowserProviderHandler()
	key := browserProviderKey(t)
	identity := browserIdentityToken(t, key, ProviderApple, h.svc.appleServicesID, browserTestNonce, nil)
	var aliasState string
	for _, origin := range []string{"https://kaata.af", "https://www.kaata.af"} {
		signed := browserStartState(t, h, origin)
		state, err := h.parseAppleBrowserState(signed)
		if err != nil || state.ReturnOrigin != origin {
			t.Fatalf("origin not bound into signed state: %v", err)
		}
		rec := browserCallback(h, url.Values{
			"state": {signed}, "id_token": {identity}, "return_origin": {"https://attacker.invalid"},
		})
		location, err := url.Parse(rec.Header().Get("Location"))
		if err != nil || rec.Code != http.StatusSeeOther || location.Scheme+"://"+location.Host != origin || location.Path != "/app" || location.RawQuery != "" {
			t.Fatal("callback failed to preserve signed approved origin")
		}
		fragment, err := url.ParseQuery(location.Fragment)
		if err != nil || fragment.Get("identity_token") != identity || fragment.Get("state") != browserTestState {
			t.Fatal("approved origin lost verified identity or client state")
		}
		if origin == "https://www.kaata.af" {
			aliasState = signed
		}
	}
	for _, origin := range []string{"", "https://attacker.invalid", "http://www.kaata.af", "https://www.kaata.af:443", "https://kaata.af:8443",
		"https://www.kaata.af/", "https://kaata.af/app", "https://www.kaata.af?x=1", "https://www.kaata.af?",
		"https://www.kaata.af#", "https://www.kaata.af#x", "https://user@kaata.af", "https://www.kaata.af.attacker.invalid", "//www.kaata.af"} {
		query := url.Values{"state": {browserTestState}, "nonce": {browserTestNonce}, "return_origin": {origin}}
		rec := httptest.NewRecorder()
		h.AppleBrowserStart(rec, httptest.NewRequest(http.MethodGet, "/?"+query.Encode(), nil))
		if rec.Code != http.StatusBadRequest || rec.Header().Get("Location") != "" {
			t.Fatalf("unapproved return origin %q accepted", origin)
		}
	}
	query := url.Values{"state": {browserTestState}, "nonce": {browserTestNonce}, "return_origin": {"https://kaata.af", "https://www.kaata.af"}}
	rec := httptest.NewRecorder()
	h.AppleBrowserStart(rec, httptest.NewRequest(http.MethodGet, "/?"+query.Encode(), nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatal("duplicate return origins accepted")
	}

	// A custom deployment may return only to its configured origin; the Kaata
	// alias is not a global exception. Existing pending state is revalidated.
	h.SetWebBaseURL("https://custom.example")
	if _, allowed := h.approvedAppleBrowserReturn("https://custom.example"); !allowed {
		t.Fatal("configured custom origin refused")
	}
	for _, origin := range []string{"https://kaata.af", "https://www.kaata.af"} {
		if _, allowed := h.approvedAppleBrowserReturn(origin); allowed {
			t.Fatal("Kaata origin allowed for a custom deployment")
		}
	}
	rec = browserCallback(h, url.Values{"state": {aliasState}, "id_token": {identity}})
	if rec.Code != http.StatusBadRequest || rec.Header().Get("Location") != "" {
		t.Fatal("callback did not revalidate the current origin allowlist")
	}
}

func TestAppleBrowserReturnOriginCannotBeTampered(t *testing.T) {
	h := newBrowserProviderHandler()
	signed := browserStartState(t, h, "https://www.kaata.af")
	parts := strings.Split(strings.TrimPrefix(signed, appleBrowserStatePrefix), ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	// Even swapping between the two approved origins must invalidate the
	// signature: the callback must return to this attempt's original tab.
	claims["return_origin"] = "https://kaata.af"
	payload, _ = json.Marshal(claims)
	parts[1] = base64.RawURLEncoding.EncodeToString(payload)
	tampered := appleBrowserStatePrefix + strings.Join(parts, ".")
	rec := browserCallback(h, url.Values{"state": {tampered}, "error": {"user_cancelled_authorize"}})
	if rec.Code != http.StatusBadRequest || rec.Header().Get("Location") != "" {
		t.Fatal("altered return origin passed signature verification")
	}
	// Also reject an otherwise authentic state if its destination is outside
	// today's allowlist (for example, after a configuration change).
	state, err := h.parseAppleBrowserState(signed)
	if err != nil {
		t.Fatal(err)
	}
	state.ReturnOrigin = "https://attacker.invalid"
	resigned, err := jwt.NewWithClaims(jwt.SigningMethodHS256, state).SignedString([]byte(browserTestSecret))
	if err != nil {
		t.Fatal(err)
	}
	rec = browserCallback(h, url.Values{"state": {appleBrowserStatePrefix + resigned}, "error": {"user_cancelled_authorize"}})
	if rec.Code != http.StatusBadRequest || rec.Header().Get("Location") != "" {
		t.Fatal("signed unapproved return origin accepted")
	}
}

type providerKeyTransport func(*http.Request) (*http.Response, error)

func (transport providerKeyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return transport(r)
}

// Only provider key retrieval is local. The real Google/Apple cryptographic
// verifiers still check the signature and claims of every test identity token.
func browserProviderKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	oldApple := appleKeys
	appleKeys = &appleKeyCache{keys: map[string]*rsa.PublicKey{"browser-test": &key.PublicKey}, fetchedAt: time.Now(), client: &http.Client{Timeout: time.Second}}
	t.Cleanup(func() { appleKeys = oldApple })
	jwks, err := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "alg": "RS256", "kid": "browser-test", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	oldTransport := http.DefaultTransport
	http.DefaultTransport = providerKeyTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://www.googleapis.com/oauth2/v3/certs" {
			return nil, fmt.Errorf("unexpected external request during provider test")
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Cache-Control": {"max-age=0"}}, Body: io.NopCloser(bytes.NewReader(jwks)), Request: r}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = oldTransport })
	return key
}

func browserIdentityToken(t *testing.T, key *rsa.PrivateKey, provider, audience, nonce string, change func(jwt.MapClaims)) string {
	t.Helper()
	issuer := appleIssuer
	if provider == ProviderGoogle {
		issuer = "https://accounts.google.com"
	}
	claims := jwt.MapClaims{"iss": issuer, "aud": audience, "sub": "browser-test-" + provider,
		"iat": time.Now().Unix(), "exp": time.Now().Add(5 * time.Minute).Unix(),
		"email": provider + "@example.test", "email_verified": true, "name": "Phone name"}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	if change != nil {
		change(claims)
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "browser-test"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func TestAppleBrowserCallbackVerifiesSignedTokenAudienceAndNonce(t *testing.T) {
	h := newBrowserProviderHandler()
	key := browserProviderKey(t)
	state := browserStartState(t, h)
	identity := browserIdentityToken(t, key, ProviderApple, "af.kaata.auth", browserTestNonce, nil)
	user := `{"name":{"firstName":"Ahmad","lastName":"K"}}`
	fragment := browserFragment(t, browserCallback(h, url.Values{"state": {state}, "id_token": {identity}, "user": {user}}))
	if fragment.Get("identity_token") != identity || fragment.Get("user") != user || fragment.Get("error") != "" {
		t.Fatal("valid browser callback not relayed")
	}
	for name, change := range map[string]func(jwt.MapClaims){
		"missing nonce":   func(c jwt.MapClaims) { delete(c, "nonce") },
		"different nonce": func(c jwt.MapClaims) { c["nonce"] = strings.Repeat("d", 64) },
		"native audience": func(c jwt.MapClaims) { c["aud"] = "af.kaata.app" },
		"wrong issuer":    func(c jwt.MapClaims) { c["iss"] = "https://attacker.invalid" },
		"expired":         func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Minute).Unix() },
	} {
		t.Run(name, func(t *testing.T) {
			invalid := browserIdentityToken(t, key, ProviderApple, "af.kaata.auth", browserTestNonce, change)
			fragment := browserFragment(t, browserCallback(h, url.Values{"state": {state}, "id_token": {invalid}, "user": {user}}))
			if fragment.Get("error") != "apple_sign_in_failed" || fragment.Get("identity_token") != "" || fragment.Get("user") != "" {
				t.Fatal("unverified identity data relayed")
			}
		})
	}
	for _, invalid := range []string{"not-a-jwt", identity[:len(identity)-4] + "xxxx"} {
		fragment := browserFragment(t, browserCallback(h, url.Values{"state": {state}, "id_token": {invalid}}))
		if fragment.Get("error") != "apple_sign_in_failed" || fragment.Get("identity_token") != "" {
			t.Fatal("invalid signature relayed")
		}
	}
	fragment = browserFragment(t, browserCallback(h, url.Values{"state": {state}, "error": {"user_cancelled_authorize"}, "id_token": {identity}}))
	if fragment.Get("error") != "user_cancelled_authorize" || fragment.Get("identity_token") != "" {
		t.Fatal("cancel did not discard identity token")
	}
}

func TestBrowserProviderNonceChecksUseVerifiedClaims(t *testing.T) {
	h := newBrowserProviderHandler()
	key := browserProviderKey(t)
	// Invalid nonce must fail before touching the nil database for either
	// provider, even when the rest of the signed provider token is valid.
	for _, provider := range []string{ProviderApple, ProviderGoogle} {
		audience := h.svc.appleServicesID
		if provider == ProviderGoogle {
			audience = h.svc.googleWebClientID
		}
		for _, supplied := range []string{"", strings.Repeat("c", 64)} {
			token := browserIdentityToken(t, key, provider, audience, browserTestNonce, nil)
			var err error
			if provider == ProviderApple {
				_, err = h.svc.SignInWithApple(t.Context(), uuid.NewString(), token, "", SwitchOptions{Platform: "web", Nonce: supplied})
			} else {
				_, err = h.svc.SignInWithGoogle(t.Context(), uuid.NewString(), token, nil, SwitchOptions{Platform: "web", Nonce: supplied})
			}
			if err == nil || !strings.Contains(err.Error(), "nonce") {
				t.Fatalf("%s invalid nonce error=%v", provider, err)
			}
		}
	}
}

func TestBrowserSocialSignInReusesNativeAccountAndVault(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	h := newBrowserProviderHandler()
	h.svc.pool = pool
	key := browserProviderKey(t)
	for _, provider := range []string{ProviderApple, ProviderGoogle} {
		t.Run(provider, func(t *testing.T) {
			phoneID, browserID, vaultID := uuid.NewString(), uuid.NewString(), uuid.NewString()
			audience, platform := h.svc.appleClientID, "ios"
			if provider == ProviderGoogle {
				audience, platform = h.svc.googleWebClientID, "android"
			}
			phoneToken := browserIdentityToken(t, key, provider, audience, "", nil)
			var phone GoogleSignInResult
			var err error
			if provider == ProviderApple {
				phone, err = h.svc.SignInWithApple(t.Context(), phoneID, phoneToken, "Phone name", SwitchOptions{})
			} else {
				phone, err = h.svc.SignInWithGoogle(t.Context(), phoneID, phoneToken, nil, SwitchOptions{})
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(t.Context(), `UPDATE installs SET platform=$2 WHERE install_id=$1::uuid`, phoneID, platform); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(t.Context(), `INSERT INTO vaults(vault_id,owner_account_id,name,currency) VALUES($1::uuid,$2::uuid,'Existing phone kaata','AFN')`, vaultID, phone.AccountID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,invited_at,accepted_at,invited_by)
				VALUES($1::uuid,$2::uuid,'owner',NOW(),NOW(),$2::uuid)`, vaultID, phone.AccountID); err != nil {
				t.Fatal(err)
			}
			if provider == ProviderApple {
				audience = h.svc.appleServicesID
			}
			browserToken := browserIdentityToken(t, key, provider, audience, browserTestNonce, func(c jwt.MapClaims) {
				if provider == ProviderApple {
					delete(c, "email") // returning Apple consent need not resend profile
					delete(c, "name")
				}
			})
			body := map[string]string{"install_id": browserID, "platform": "web", "nonce": browserTestNonce}
			if provider == ProviderApple {
				body["identity_token"] = browserToken
			} else {
				body["id_token"] = browserToken
			}
			encoded, _ := json.Marshal(body)
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/v1/auth/"+provider, bytes.NewReader(encoded))
			if provider == ProviderApple {
				h.AppleSignIn(rec, req)
			} else {
				h.GoogleSignIn(rec, req)
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("browser %s sign-in status=%d", provider, rec.Code)
			}
			var browser GoogleSignInResult
			if err := json.Unmarshal(rec.Body.Bytes(), &browser); err != nil {
				t.Fatal(err)
			}
			if browser.AccountID != phone.AccountID || browser.DefaultVaultID == nil || *browser.DefaultVaultID != vaultID || browser.User.Name != "Phone name" {
				t.Fatal("browser did not open the native account, profile and existing kaata")
			}
			var gotPlatform string
			if err := pool.QueryRow(t.Context(), `SELECT platform FROM installs WHERE install_id=$1::uuid`, browserID).Scan(&gotPlatform); err != nil || gotPlatform != "web" {
				t.Fatalf("browser platform=%q err=%v", gotPlatform, err)
			}
			if err := h.svc.SignOut(t.Context(), browserID, provider); err != nil {
				t.Fatal(err)
			}
			claims, err := ParseSession(browserTestSecret, phone.SessionJWT)
			if err != nil {
				t.Fatal(err)
			}
			if revoked, err := h.svc.CheckCredentialRevoked(context.Background(), phoneID, provider, phone.AccountID, claims.Epoch); err != nil || revoked {
				t.Fatalf("browser sign-out revoked the phone: revoked=%v err=%v", revoked, err)
			}
			if err := pool.QueryRow(t.Context(), `SELECT platform FROM installs WHERE install_id=$1::uuid`, phoneID).Scan(&gotPlatform); err != nil || gotPlatform != platform {
				t.Fatalf("native platform changed to %q err=%v", gotPlatform, err)
			}
		})
	}
}
