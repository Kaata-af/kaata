package admin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"

	"github.com/matee/kaata-backend/internal/httpx"
)

const liveTestKey = "test-admin-live-key"

type adminLiveFixture struct {
	live   *Live
	server *httptest.Server
	cancel context.CancelFunc
}

func newAdminLiveFixture(t *testing.T, enabled bool, interval time.Duration) *adminLiveFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	live := NewLive(ctx, enabled)
	if interval > 0 {
		live.pingInterval = interval
	}
	r := chi.NewRouter()
	// Mirror the real global stack: notably Logger must preserve Hijacker.
	r.Use(httpx.RealIP, httpx.Logger, httpx.Recoverer, httpx.CORS, live.NotifyOnSuccess)
	key := liveTestKey
	if !enabled {
		key = ""
	}
	r.With(httpx.AdminKeyMiddleware(key)).Post("/v1/admin/live-ticket", live.Ticket)
	r.Get("/v1/admin/live", live.Subscribe)
	srv := httptest.NewServer(r)
	t.Cleanup(func() { cancel(); srv.Close() })
	return &adminLiveFixture{live: live, server: srv, cancel: cancel}
}

func (f *adminLiveFixture) ticketResponse(t *testing.T, key string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.server.URL+"/v1/admin/live-ticket", nil)
	if err != nil {
		t.Fatal(err)
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func (f *adminLiveFixture) ticket(t *testing.T) string {
	t.Helper()
	res := f.ticketResponse(t, liveTestKey)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("ticket status %d", res.StatusCode)
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("ticket response must not be cached")
	}
	var body struct {
		Ticket    string `json:"ticket"`
		ExpiresIn int    `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.ExpiresIn != 30 {
		t.Fatalf("ticket expiry %d", body.ExpiresIn)
	}
	raw, err := base64.RawURLEncoding.DecodeString(body.Ticket)
	if err != nil || len(raw) != 32 {
		t.Fatal("ticket must contain 32 random bytes")
	}
	return body.Ticket
}

func (f *adminLiveFixture) dial(t *testing.T, ticket string, wantStatus int) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, res, err := websocket.Dial(ctx, f.server.URL+"/v1/admin/live?ticket="+ticket, nil)
	if wantStatus != http.StatusSwitchingProtocols {
		if err == nil {
			conn.CloseNow()
			t.Fatal("unexpected successful upgrade")
		}
		if res == nil || res.StatusCode != wantStatus {
			t.Fatalf("upgrade status: response=%v error=%v", res, err)
		}
		return nil
	}
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func readAdminLive(t *testing.T, conn *websocket.Conn, want string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	kind, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read %s: %v", want, err)
	}
	if kind != websocket.MessageText || string(data) != `{"t":"`+want+`"}` {
		t.Fatalf("unexpected frame %q", data)
	}
}

func waitAdminLiveCount(t *testing.T, live *Live, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		live.mu.Lock()
		n := len(live.subs)
		live.mu.Unlock()
		if n == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("live subscriptions did not reach %d", want)
}

func TestAdminLiveAuthorization(t *testing.T) {
	f := newAdminLiveFixture(t, true, 0)
	for _, key := range []string{"", "wrong"} {
		if got := f.ticketResponse(t, key).StatusCode; got != http.StatusUnauthorized {
			t.Fatalf("unauthorized ticket status %d", got)
		}
	}
	f.dial(t, "", http.StatusUnauthorized)
	f.dial(t, "not-a-ticket", http.StatusUnauthorized)
	// Supplying the long-lived admin key as a ticket must not authenticate.
	f.dial(t, liveTestKey, http.StatusUnauthorized)
	ticket := f.ticket(t)
	conn := f.dial(t, ticket, http.StatusSwitchingProtocols)
	readAdminLive(t, conn, "ready")
	f.dial(t, ticket, http.StatusUnauthorized)
	f.dial(t, ticket, http.StatusUnauthorized)

	disabled := newAdminLiveFixture(t, false, 0)
	if got := disabled.ticketResponse(t, liveTestKey).StatusCode; got != http.StatusNotFound {
		t.Fatalf("disabled ticket status %d", got)
	}
	disabled.dial(t, ticket, http.StatusNotFound)
}

func TestAdminLiveTicketExpiryAndCapacity(t *testing.T) {
	f := newAdminLiveFixture(t, true, 0)
	ticket := f.ticket(t)
	f.live.mu.Lock()
	f.live.tickets[ticket] = time.Now().Add(-time.Second)
	f.live.mu.Unlock()
	f.dial(t, ticket, http.StatusUnauthorized)
	f.dial(t, ticket, http.StatusUnauthorized)
	for i := 0; i < maxLiveTickets; i++ {
		f.ticket(t)
	}
	if got := f.ticketResponse(t, liveTestKey).StatusCode; got != http.StatusTooManyRequests {
		t.Fatalf("ticket capacity status %d", got)
	}
	f.live.mu.Lock()
	for token := range f.live.tickets {
		f.live.tickets[token] = time.Now().Add(-time.Second)
	}
	f.live.mu.Unlock()
	f.ticket(t) // expired entries are reclaimed, not a permanent lockout.
}

func TestAdminLiveSocketCapacityAndFailedUpgrade(t *testing.T) {
	f := newAdminLiveFixture(t, true, 0)
	for i := 0; i < maxLiveSockets; i++ {
		readAdminLive(t, f.dial(t, f.ticket(t), http.StatusSwitchingProtocols), "ready")
	}
	ticket := f.ticket(t)
	f.dial(t, ticket, http.StatusTooManyRequests)
	f.dial(t, ticket, http.StatusUnauthorized) // also consumed on capacity rejection.

	fresh := newAdminLiveFixture(t, true, 0)
	ticket = fresh.ticket(t)
	res, err := fresh.server.Client().Get(fresh.server.URL + "/v1/admin/live?ticket=" + ticket)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == http.StatusSwitchingProtocols {
		t.Fatal("ordinary GET upgraded")
	}
	waitAdminLiveCount(t, fresh.live, 0)
	fresh.dial(t, ticket, http.StatusUnauthorized)
}

func TestAdminLiveFanoutDisconnectAndShutdown(t *testing.T) {
	f := newAdminLiveFixture(t, true, 0)
	a := f.dial(t, f.ticket(t), http.StatusSwitchingProtocols)
	b := f.dial(t, f.ticket(t), http.StatusSwitchingProtocols)
	readAdminLive(t, a, "ready")
	readAdminLive(t, b, "ready")
	f.live.Notify()
	readAdminLive(t, a, "invalidate")
	readAdminLive(t, b, "invalidate")
	a.CloseNow()
	waitAdminLiveCount(t, f.live, 1)
	f.live.Notify()
	readAdminLive(t, b, "invalidate")
	f.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := b.Read(ctx); err == nil {
		t.Fatal("socket survived shutdown")
	}
	waitAdminLiveCount(t, f.live, 0)
	if got := f.ticketResponse(t, liveTestKey).StatusCode; got != http.StatusServiceUnavailable {
		t.Fatalf("shutdown ticket status %d", got)
	}
}

func TestAdminLiveHeartbeat(t *testing.T) {
	f := newAdminLiveFixture(t, true, 40*time.Millisecond)
	conn := f.dial(t, f.ticket(t), http.StatusSwitchingProtocols)
	readAdminLive(t, conn, "ready")
	// Survive more than two heartbeat windows by answering each ping.
	for i := 0; i < 4; i++ {
		readAdminLive(t, conn, "ping")
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := conn.Write(ctx, websocket.MessageText, []byte(`{"t":"pong"}`))
		cancel()
		if err != nil {
			t.Fatal(err)
		}
	}
	readAdminLive(t, conn, "ping")
	readAdminLive(t, conn, "ping")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("socket survived unanswered heartbeats")
	}
	waitAdminLiveCount(t, f.live, 0)
}

func TestAdminLiveReadLimit(t *testing.T) {
	f := newAdminLiveFixture(t, true, 0)
	conn := f.dial(t, f.ticket(t), http.StatusSwitchingProtocols)
	readAdminLive(t, conn, "ready")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = conn.Write(ctx, websocket.MessageText, []byte(strings.Repeat("x", liveReadLimit+1)))
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("oversized client frame accepted")
	}
	waitAdminLiveCount(t, f.live, 0)
}

func TestAdminLiveNotifyRouting(t *testing.T) {
	cases := []struct {
		method, path string
		status       int
		want         bool
	}{
		{"POST", "/v1/check-in", 200, true},
		{"POST", "/v1/visit", 204, true},
		{"POST", "/v1/auth/google", 200, true},
		{"POST", "/v1/auth/apple", 200, true},
		{"POST", "/v1/auth/signout", 204, true},
		{"DELETE", "/v1/account", 204, true},
		{"PUT", "/v1/account/phone", 200, true},
		{"POST", "/v1/vaults", 201, true},
		{"PATCH", "/v1/vaults/id", 200, true},
		{"POST", "/v1/vaults/id/members/id/revoke", 204, true},
		{"POST", "/v1/vaults/invites/accept", 200, true},
		{"POST", "/v1/sync/push", 200, true},
		{"POST", "/v1/shared", 201, true},
		{"GET", "/v1/download", 302, true},
		{"GET", "/v1/download", 206, true},
		{"POST", "/v1/check-in", 0, true}, // implicit 200.
		{"HEAD", "/v1/download", 200, false},
		{"GET", "/v1/admin/users", 200, false},
		{"POST", "/v1/admin/live-ticket", 200, false},
		{"GET", "/v1/sync/pull", 200, false},
		{"GET", "/v1/vaults", 200, false},
		{"GET", "/v1/shared/token", 200, false},
		{"POST", "/v1/crash-reports", 200, false},
		{"POST", "/v1/vaultstuff", 200, false},
		{"OPTIONS", "/v1/check-in", 204, false},
		{"POST", "/v1/check-in", 400, false},
		{"POST", "/v1/sync/push", 401, false},
		{"POST", "/v1/vaults/id/unknown", 404, false},
		{"POST", "/v1/shared", 429, false},
		{"POST", "/v1/auth/google", 500, false},
		{"GET", "/v1/download", 502, false},
	}
	for _, tc := range cases {
		t.Run(tc.method+tc.path+http.StatusText(tc.status), func(t *testing.T) {
			live := NewLive(context.Background(), true)
			sub := &liveSubscription{changed: make(chan struct{}, 1)}
			live.subs[sub] = struct{}{}
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				select {
				case <-sub.changed:
					t.Fatal("notified before request completed")
				default:
				}
				if tc.status != 0 {
					w.WriteHeader(tc.status)
				}
			})
			live.NotifyOnSuccess(next).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.path, nil))
			got := false
			select {
			case <-sub.changed:
				got = true
			default:
			}
			if got != tc.want {
				t.Fatalf("notified=%v want=%v", got, tc.want)
			}
		})
	}
	// Coalescing is bounded and must not block the committing request.
	live := NewLive(context.Background(), true)
	sub := &liveSubscription{changed: make(chan struct{}, 1)}
	live.subs[sub] = struct{}{}
	for i := 0; i < 1000; i++ {
		live.Notify()
	}
	if len(sub.changed) != 1 {
		t.Fatal("invalidations did not coalesce")
	}
	<-sub.changed
	panics := httpx.Recoverer(live.NotifyOnSuccess(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("test panic") })))
	panics.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/check-in", nil))
	if len(sub.changed) != 0 {
		t.Fatal("panicking request invalidated")
	}
}
