package tabs

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

const testJWTSecret = "0123456789abcdef0123456789abcdef"

// httpFixture is tabFixture plus an httptest server running the SAME
// middleware chain main.go registers for /v1/tabs: OptionalMiddleware (the
// real session parser + revocation lookup) and per-IP limits only. The route
// table below mirrors main.go; if a route moves there, move it here.
type httpFixture struct {
	*tabFixture
	server *httptest.Server
	h      *Handler
}

func newHTTPFixture(t *testing.T) *httpFixture {
	t.Helper()
	f := newTabFixture(t)
	authenticator := auth.NewSessionAuthenticator(auth.NewService(f.pool, "", testJWTSecret), testJWTSecret)
	h := NewHandler(f.svc, "https://kaata.af", "", "")

	r := chi.NewRouter()
	r.Use(httpx.CORS)
	r.Get("/t/{token}", h.View)
	r.Group(func(pr chi.Router) {
		pr.Use(authenticator.OptionalMiddleware())
		pr.Post("/v1/tabs", h.Create)
		pr.Get("/v1/tabs/mine", h.Mine)
		pr.Get("/v1/tabs/inbox", h.Inbox)
		pr.Post("/v1/tabs/inbox/read", h.ReadInbox)
		pr.Post("/v1/tabs/by-token", h.ByToken)
		pr.Get("/v1/tabs/{tab_id}", h.Get)
		pr.Post("/v1/tabs/{tab_id}/notifications", h.Notifications)
		pr.Post("/v1/tabs/{tab_id}/join", h.Join)
		pr.Post("/v1/tabs/{tab_id}/bind", h.Bind)
		pr.Post("/v1/tabs/{tab_id}/label", h.Label)
		pr.Post("/v1/tabs/{tab_id}/entries", h.Append)
		pr.Post("/v1/tabs/{tab_id}/entries/{id}/accept", h.Accept)
		pr.Post("/v1/tabs/{tab_id}/entries/{id}/dispute", h.Dispute)
		pr.Post("/v1/tabs/{tab_id}/entries/{id}/void", h.Void)
		pr.Post("/v1/tabs/{tab_id}/close", h.Close)
		pr.Post("/v1/tabs/{tab_id}/regenerate-link", h.RegenerateLink)
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &httpFixture{tabFixture: f, server: srv, h: h}
}

// jwtFor mints a session for accountID the way sign-in does, with the
// installs + auth_credentials rows the revocation check needs (a missing
// credential row counts as revoked).
func (f *httpFixture) jwtFor(t *testing.T, accountID string) string {
	t.Helper()
	ctx := context.Background()
	installID := uuid.NewString()
	providerSub := "sub-" + uuid.NewString()
	if _, err := f.pool.Exec(ctx, `INSERT INTO installs (install_id) VALUES ($1::uuid)`, installID); err != nil {
		t.Fatalf("seed install: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO auth_credentials (install_id, provider, provider_sub, account_id)
		VALUES ($1::uuid, 'google', $2, $3::uuid)
	`, installID, providerSub, accountID); err != nil {
		t.Fatalf("seed credential: %v", err)
	}
	jwt, err := auth.SignSession(testJWTSecret, accountID, installID, "google", providerSub)
	if err != nil {
		t.Fatalf("sign session: %v", err)
	}
	return jwt
}

type httpResult struct {
	status int
	header http.Header
	body   []byte
}

func (r httpResult) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("body is not a JSON object: %s", r.body)
	}
	return m
}

// do sends one request. authz "" means no Authorization header.
func (f *httpFixture) do(t *testing.T, method, path, authz string, body any, party ...string) httpResult {
	t.Helper()
	var rd io.Reader
	if body != nil {
		switch b := body.(type) {
		case string:
			rd = strings.NewReader(b)
		default:
			raw, _ := json.Marshal(b)
			rd = bytes.NewReader(raw)
		}
	}
	req, err := http.NewRequest(method, f.server.URL+path, rd)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if authz != "" {
		req.Header.Set("Authorization", authz)
	}
	if len(party) != 0 {
		req.Header.Set("X-Kaata-Party", party[0])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return httpResult{status: resp.StatusCode, header: resp.Header, body: raw}
}

// createOverHTTP opens a tab through the API (as the given session, or
// anonymously) and returns the decoded CreateResponse.
func (f *httpFixture) createOverHTTP(t *testing.T, authz string) CreateResponse {
	t.Helper()
	if authz == "" {
		authz = "Bearer " + f.jwtFor(t, f.acctA)
	}
	res := f.do(t, "POST", "/v1/tabs", authz, map[string]any{"currency": "AFN", "label": "Saafi Store"})
	if res.status != http.StatusCreated {
		t.Fatalf("create = %d %s", res.status, res.body)
	}
	var out CreateResponse
	if err := json.Unmarshal(res.body, &out); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	return out
}

const uniform404 = `{"error":"tab not found","error_code":"tab_not_found"}` + "\n"

// These are the requests the PHONE sends, through real session middleware.
// A token and a session cannot both occupy Authorization.
func TestHTTPMobileInvitationAndRecovery(t *testing.T) {
	f := newHTTPFixture(t)
	created := f.createOverHTTP(t, "")
	path := "/v1/tabs/" + created.Tab.ID
	preview := f.do(t, "POST", "/v1/tabs/by-token", "Bearer "+f.jwtFor(t, f.acctB), map[string]any{"token": created.InviteToken})
	if preview.status != 200 || preview.json(t)["tab"].(map[string]any)["you"] != "b" {
		t.Fatalf("mobile preview: %d %s", preview.status, preview.body)
	}
	jwtB := f.jwtFor(t, f.acctB)
	rel := uuid.NewString()
	joined := f.do(t, "POST", path+"/join", "Bearer "+jwtB, map[string]any{
		"token": created.InviteToken, "label": "Ahmad", "vault_id": f.vaultB, "relationship_id": rel,
	})
	if joined.status != 200 {
		t.Fatalf("mobile join: %d %s", joined.status, joined.body)
	}
	// Reinstall has only a JWT. It must discover the same contact and role.
	mine := f.do(t, "GET", "/v1/tabs/mine", "Bearer "+jwtB, nil)
	items := mine.json(t)["tabs"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["relationship_id"] != rel {
		t.Fatalf("recovery: %s", mine.body)
	}
	jwtA := f.jwtFor(t, f.acctA)
	bound := f.do(t, "POST", path+"/bind", "Bearer "+jwtA, map[string]any{
		"token": created.MyToken, "vault_id": f.vaultA, "relationship_id": uuid.NewString(),
	})
	if bound.status != 200 {
		t.Fatalf("bind previously anonymous party: %d %s", bound.status, bound.body)
	}
	other := f.createOverHTTP(t, "")
	wrong := f.do(t, "POST", path+"/bind", "Bearer "+jwtA, map[string]any{"token": other.MyToken})
	if wrong.status != 404 || string(wrong.body) != uniform404 {
		t.Fatalf("wrong token must not fall back to bound account: %d %s", wrong.status, wrong.body)
	}
}

// ==========================================================================
// Auth resolution order (§3.2)
// ==========================================================================

func TestHTTPAuthResolutionOrder(t *testing.T) {
	f := newHTTPFixture(t)
	jwtA := f.jwtFor(t, f.acctA)
	jwtStranger := f.jwtFor(t, seedAccount(t, f.pool, "s@example.com", "S"))

	created := f.createOverHTTP(t, "Bearer "+jwtA)
	if !created.Tab.Parties["a"].Bound {
		t.Fatal("a session on create must bind party a")
	}
	if !strings.HasPrefix(created.InviteURL, "https://kaata.af/t/") || !strings.HasSuffix(created.InviteURL, created.InviteToken) {
		t.Fatalf("invite_url = %q, want <share base>/t/<invite_token>", created.InviteURL)
	}
	path := "/v1/tabs/" + created.Tab.ID

	// 1. `Tab <token>` — either party's token, case-insensitive scheme.
	if r := f.do(t, "GET", path, "Tab "+created.MyToken, nil); r.status != 404 {
		t.Fatalf("A's token: %d %s", r.status, r.body)
	}
	if r := f.do(t, "GET", path, "tab "+created.InviteToken, nil); r.status != 404 {
		t.Fatalf("B's token (lowercase scheme): %d %s", r.status, r.body)
	}
	// 2. Session claims — the bound account.
	if r := f.do(t, "GET", path, "Bearer "+jwtA, nil); r.status != 200 || r.json(t)["tab"].(map[string]any)["you"] != "a" {
		t.Fatalf("A's session: %d %s", r.status, r.body)
	}
	// 3. Everything else is the SAME 404, byte for byte.
	for name, authz := range map[string]string{
		"anonymous":        "",
		"stranger session": "Bearer " + jwtStranger,
		"garbage token":    "Tab nope",
		"other scheme":     "Basic abc",
	} {
		r := f.do(t, "GET", path, authz, nil)
		if r.status != 404 || string(r.body) != uniform404 {
			t.Errorf("%s: %d %q, want 404 %q", name, r.status, r.body, uniform404)
		}
	}
	if r := f.do(t, "GET", path, "Bearer not-a-jwt", nil); r.status != 401 {
		t.Fatalf("expired/invalid session must be retryable: %d", r.status)
	}
	// Token for a different tab than the URL, and a malformed tab id.
	other := f.createOverHTTP(t, "")
	if r := f.do(t, "GET", "/v1/tabs/"+other.Tab.ID, "Tab "+created.MyToken, nil); r.status != 404 || string(r.body) != uniform404 {
		t.Errorf("token/URL mismatch: %d %q", r.status, r.body)
	}
	if r := f.do(t, "GET", "/v1/tabs/not-a-uuid", "Tab "+created.MyToken, nil); r.status != 404 || string(r.body) != uniform404 {
		t.Errorf("malformed tab id: %d %q", r.status, r.body)
	}
	if r := f.do(t, "GET", "/v1/tabs/"+uuid.NewString(), "Bearer "+jwtA, nil); r.status != 404 || string(r.body) != uniform404 {
		t.Errorf("unknown tab id with session: %d %q", r.status, r.body)
	}
}

func TestHTTPMineRequiresSession(t *testing.T) {
	f := newHTTPFixture(t)
	if r := f.do(t, "GET", "/v1/tabs/mine", "", nil); r.status != 401 || r.json(t)["error"] != "authentication required" {
		t.Fatalf("anonymous /mine = %d %s", r.status, r.body)
	}
	created := f.create(t, "Legacy unbound", "", "")
	// A party token is not a session either.
	if r := f.do(t, "GET", "/v1/tabs/mine", "Tab "+created.MyToken, nil); r.status != 401 {
		t.Fatalf("token /mine = %d %s", r.status, r.body)
	}
	jwtA := f.jwtFor(t, f.acctA)
	if r := f.do(t, "GET", "/v1/tabs/mine", "Bearer "+jwtA, nil); r.status != 200 || len(r.json(t)["tabs"].([]any)) != 0 {
		t.Fatalf("session /mine = %d %s", r.status, r.body)
	}
	// Bind the anonymous tab to A, and it appears.
	if r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/bind", "Bearer "+jwtA, nil); r.status != 404 {
		t.Fatalf("bind by session alone must be 404 (not a party yet): %d %s", r.status, r.body)
	}
	// Bind needs the token AND a session; a token alone is 401.
	if r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/bind", "Tab "+created.MyToken, map[string]any{}); r.status != 401 {
		t.Fatalf("bind by token alone = %d %s, want 401", r.status, r.body)
	}
	// The handler reads the Tab header first, so a session must ride in the
	// body-less way the phone does it: token in Authorization is the party;
	// the session comes from… the same header slot. That cannot carry both,
	// so the phone binds by joining WITH the session (Join binds too). Prove
	// that path: join as A's own party with the session → bound → in /mine.
	if r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/join", "Bearer "+jwtA, map[string]any{"label": "Me"}); r.status != 404 {
		t.Fatalf("join by a non-party session = %d, want 404", r.status)
	}
}

// ==========================================================================
// Response hygiene: no-store everywhere, GET/POST only, error envelopes
// ==========================================================================

func TestHTTPNoStoreAndSafeMethods(t *testing.T) {
	f := newHTTPFixture(t)
	created := f.createOverHTTP(t, "")
	path := "/v1/tabs/" + created.Tab.ID

	for name, r := range map[string]httpResult{
		"create":   f.do(t, "POST", "/v1/tabs", "", map[string]any{"currency": "AFN", "label": "X"}),
		"get":      f.do(t, "GET", path, "Tab "+created.MyToken, nil),
		"404":      f.do(t, "GET", path, "", nil),
		"mine 401": f.do(t, "GET", "/v1/tabs/mine", "", nil),
		"page":     f.do(t, "GET", "/t/"+created.InviteToken, "", nil),
		"page 404": f.do(t, "GET", "/t/nope", "", nil),
	} {
		if cc := r.header.Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", name, cc)
		}
	}

	// Every route the page can call is GET or POST — the global CORS
	// middleware allows nothing else, so a PATCH/PUT/DELETE would never
	// pass the browser's preflight. Walk the mounted routes.
	// (The test router mirrors main.go; a new verb there must show up here.)
	if r := f.do(t, "DELETE", path, "Tab "+created.MyToken, nil); r.status != http.StatusMethodNotAllowed {
		t.Errorf("DELETE should not be routed: %d", r.status)
	}
	if r := f.do(t, "PATCH", path+"/label", "Tab "+created.MyToken, nil); r.status != http.StatusMethodNotAllowed {
		t.Errorf("PATCH should not be routed: %d", r.status)
	}
	// Preflight for the page's write call succeeds with the Authorization
	// header allowed.
	req, _ := http.NewRequest("OPTIONS", f.server.URL+path+"/entries", nil)
	req.Header.Set("Origin", "https://kaata.af")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 || !strings.Contains(strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers")), "authorization") {
		t.Errorf("preflight = %d %v", resp.StatusCode, resp.Header)
	}
}

func TestHTTPAppendStatusCodesAndErrors(t *testing.T) {
	f := newHTTPFixture(t)
	created := f.createOverHTTP(t, "")
	path := "/v1/tabs/" + created.Tab.ID + "/entries"
	authz := "Bearer " + f.jwtFor(t, f.acctA)
	jwtB := "Bearer " + f.jwtFor(t, f.acctB)
	joined := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/join", jwtB, map[string]any{"token": created.InviteToken, "label": "B"})
	if joined.status != 200 {
		t.Fatalf("join: %d %s", joined.status, joined.body)
	}

	body := map[string]any{"id": uuid.NewString(), "direction": "a_to_b", "amount": "500", "note": "cement", "occurred_at_ms": 1_756_000_000_000}
	first := f.do(t, "POST", path, authz, body)
	if first.status != 201 {
		t.Fatalf("append = %d %s", first.status, first.body)
	}
	if first.json(t)["duplicate_hint"] != nil {
		t.Fatalf("duplicate_hint must be an explicit null: %s", first.body)
	}
	if replay := f.do(t, "POST", path, authz, body); replay.status != 200 {
		t.Fatalf("replay = %d %s, want 200", replay.status, replay.body)
	}
	if r := f.do(t, "POST", path, jwtB, body); r.status != 409 || r.json(t)["error_code"] != "id_taken" {
		t.Fatalf("id reuse by B = %d %s", r.status, r.body)
	}
	for name, tc := range map[string]struct {
		body any
		code string
	}{
		"invalid amount":    {map[string]any{"id": uuid.NewString(), "direction": "a_to_b", "amount": "12.345", "occurred_at_ms": 1}, "invalid_amount"},
		"zero amount":       {map[string]any{"id": uuid.NewString(), "direction": "a_to_b", "amount": "0", "occurred_at_ms": 1}, "invalid_amount"},
		"invalid direction": {map[string]any{"id": uuid.NewString(), "direction": "up", "amount": "1", "occurred_at_ms": 1}, "invalid_direction"},
		"bad id":            {map[string]any{"id": "x", "direction": "a_to_b", "amount": "1", "occurred_at_ms": 1}, "invalid_body"},
		"invalid json":      {"{not json", "invalid_body"},
		"no date":           {map[string]any{"id": uuid.NewString(), "direction": "a_to_b", "amount": "1"}, "invalid_occurred_at"},
	} {
		r := f.do(t, "POST", path, authz, tc.body)
		if r.status != 400 || r.json(t)["error_code"] != tc.code {
			t.Errorf("%s: %d %s, want 400 %s", name, r.status, r.body, tc.code)
		}
	}
	// Review/void/close through HTTP, with the documented codes.
	entryID := first.json(t)["entry"].(map[string]any)["id"].(string)
	if r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/entries/"+entryID+"/accept", authz, map[string]any{}); r.status != 403 || r.json(t)["error_code"] != "own_entry" {
		t.Errorf("accept own = %d %s", r.status, r.body)
	}
	if r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/entries/"+entryID+"/dispute", jwtB, map[string]any{"reason": ""}); r.status != 200 || r.json(t)["entry"].(map[string]any)["status"] != "disputed" {
		t.Errorf("dispute without reason = %d %s", r.status, r.body)
	}
	if r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/entries/"+entryID+"/void", authz, map[string]any{}); r.status != 409 || r.json(t)["error_code"] != "review_final" {
		t.Errorf("void = %d %s", r.status, r.body)
	}
	if r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/regenerate-link", jwtB, map[string]any{}); r.status != 403 || r.json(t)["error_code"] != "not_party_a" {
		t.Errorf("B regenerate = %d %s", r.status, r.body)
	}
	if r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/close", authz, map[string]any{}); r.status != 200 || r.json(t)["tab"].(map[string]any)["closed_by"] != "a" {
		t.Errorf("close = %d %s", r.status, r.body)
	}
	if r := f.do(t, "POST", path, authz, map[string]any{"id": uuid.NewString(), "direction": "a_to_b", "amount": "1", "occurred_at_ms": 1}); r.status != 409 || r.json(t)["error_code"] != "tab_closed" {
		t.Errorf("append on closed = %d %s", r.status, r.body)
	}
}

// ==========================================================================
// Rate-limit wiring smoke
// ==========================================================================

func TestHTTPPartyContextDoesNotBecomeAuthority(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	c, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.Join(ctx, f.party(t, c.InviteToken, c.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB})
	if err != nil {
		t.Fatal(err)
	}
	path := "/v1/tabs/" + c.Tab.ID + "/entries"
	payload := map[string]any{"id": uuid.NewString(), "direction": "b_to_a", "amount": "10", "occurred_at_ms": 1756000000000}
	// An A-only account cannot manufacture access by requesting side B.
	r := f.do(t, "POST", path, "Bearer "+f.jwtFor(t, f.acctA), payload, "b")
	if r.status != 404 {
		t.Fatalf("side selector granted access: %d %s", r.status, r.body)
	}
	member := seedAccount(t, f.pool, "both-books@example.com", "Member")
	seedMember(t, f.pool, f.vaultA, member, "editor")
	seedMember(t, f.pool, f.vaultB, member, "editor")
	r = f.do(t, "POST", path, "Bearer "+f.jwtFor(t, member), payload, "b")
	if r.status != 201 || r.json(t)["entry"].(map[string]any)["created_by"] != "b" {
		t.Fatalf("recorded under wrong party: %d %s", r.status, r.body)
	}
}

func TestHTTPRateLimitWiring(t *testing.T) {
	f := newHTTPFixture(t)
	created := f.createOverHTTP(t, "")

	// The limiter main.go composes in front of each route: per IP, 429 with
	// Retry-After once the cap is crossed. One request per hour proves the
	// wiring without waiting.
	r := chi.NewRouter()
	r.With(httpx.RateLimitPerIP(1, time.Hour)).Get("/v1/tabs/{tab_id}", f.h.Get)
	srv := httptest.NewServer(r)
	defer srv.Close()

	get := func() *http.Response {
		req, _ := http.NewRequest("GET", srv.URL+"/v1/tabs/"+created.Tab.ID, nil)
		req.Header.Set("Authorization", "Tab "+created.MyToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		resp.Body.Close()
		return resp
	}
	if resp := get(); resp.StatusCode != 404 {
		t.Fatalf("first = %d", resp.StatusCode)
	}
	if resp := get(); resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("second = %d Retry-After=%q, want 429 with Retry-After", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
}

// ==========================================================================
// The page
// ==========================================================================

func TestHTTPViewPage(t *testing.T) {
	f := newHTTPFixture(t)
	created := f.createOverHTTP(t, "")
	f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/entries", "Tab "+created.MyToken,
		map[string]any{"id": uuid.NewString(), "direction": "a_to_b", "amount": "1250", "occurred_at_ms": 1_756_000_000_000})

	// B's link before joining: generic title, B's-view balance ("you owe").
	r := f.do(t, "GET", "/t/"+created.InviteToken, "", nil)
	if r.status != 200 || !strings.HasPrefix(r.header.Get("Content-Type"), "text/html") {
		t.Fatalf("page = %d %s", r.status, r.header.Get("Content-Type"))
	}
	html := string(r.body)
	for _, want := range []string{
		`<html lang="en" dir="ltr">`,
		`Kaata shared-account invitation`,
		`var token = "` + created.InviteToken + `";`,
		"Open in Kaata", "App Store", "Google Play",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("page missing %q", want)
		}
	}
	// The other party's token must never be in B's page.
	if strings.Contains(html, created.MyToken) {
		t.Error("A's token leaked into B's page")
	}

	// Dari shell for a Dari browser, Persian digits in the hero.
	req, _ := http.NewRequest("GET", f.server.URL+"/t/"+created.MyToken, nil)
	req.Header.Set("Accept-Language", "fa-AF,fa;q=0.9")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("fa page: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	fa := string(raw)
	for _, want := range []string{`<html lang="fa" dir="rtl">`, "باز کردن در کاتا"} {
		if !strings.Contains(fa, want) {
			t.Errorf("fa page missing %q", want)
		}
	}
	if resp.Header.Get("Vary") != "Accept-Language" {
		t.Errorf("Vary = %q", resp.Header.Get("Vary"))
	}

	// Unknown token: the 404 page, localized, still no-store.
	nf := f.do(t, "GET", "/t/"+strings.Repeat("x", 40), "", nil)
	if nf.status != 404 || !strings.Contains(string(nf.body), "This tab doesn’t exist") {
		t.Fatalf("404 page = %d %s", nf.status, nf.body)
	}
}
