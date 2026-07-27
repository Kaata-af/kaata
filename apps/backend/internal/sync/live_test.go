package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/auth"
)

// liveFixture is the m1 world (account + vault + membership) plus everything
// the WebSocket path needs on top: an installs row + auth_credentials row so
// the session middleware's revocation check passes (a missing credential row
// counts as revoked — see auth.CheckCredentialRevoked), a minted session JWT,
// and an httptest server running the SAME middleware chain main.go registers
// for /v1/sync/live.
type liveFixture struct {
	*m1Fixture
	jwt    string
	server *httptest.Server
}

func newLiveFixture(t *testing.T) *liveFixture {
	t.Helper()
	f := newM1Fixture(t)
	ctx := context.Background()

	installID := uuid.NewString()
	providerSub := "sub-" + uuid.NewString()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO installs (install_id) VALUES ($1::uuid)
	`, installID); err != nil {
		t.Fatalf("seed install: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO auth_credentials (install_id, provider, provider_sub, account_id)
		VALUES ($1::uuid, 'google', $2, $3::uuid)
	`, installID, providerSub, f.accountID); err != nil {
		t.Fatalf("seed auth credential: %v", err)
	}

	jwt, err := auth.SignSession(testJWTSecret, f.accountID, installID, "google", providerSub)
	if err != nil {
		t.Fatalf("sign session: %v", err)
	}

	// Mirror main.go's /v1/sync/live group exactly: token-fallback first,
	// then the real session middleware (signature + revocation lookup).
	authenticator := auth.NewSessionAuthenticator(
		auth.NewService(f.pool, "", testJWTSecret), testJWTSecret)
	handler := NewHandler(f.svc)
	chain := LiveTokenFallbackMiddleware(
		authenticator.Middleware()(http.HandlerFunc(handler.Live)))

	srv := httptest.NewServer(chain)
	t.Cleanup(srv.Close)

	return &liveFixture{m1Fixture: f, jwt: jwt, server: srv}
}

// dial opens a client socket. authz "" means "no Authorization header".
func (f *liveFixture) dial(t *testing.T, url, authz string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	opts := &websocket.DialOptions{}
	if authz != "" {
		opts.HTTPHeader = http.Header{"Authorization": []string{authz}}
	}
	conn, _, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		t.Fatalf("websocket dial %s: %v", url, err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

// readUntil reads frames until one matches want.T (skipping keepalive pings,
// which can interleave with pokes when the test shrinks livePingInterval).
func readUntil(t *testing.T, conn *websocket.Conn, wantT string, timeout time.Duration) liveMsg {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read (waiting for %q): %v", wantT, err)
		}
		var m liveMsg
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("unmarshal frame %q: %v", data, err)
		}
		if m.T == wantT {
			return m
		}
		if m.T != "ping" {
			t.Fatalf("unexpected frame type %q (want %q)", m.T, wantT)
		}
	}
}

// ==========================================================================
// Auth
// ==========================================================================

func TestLiveRejectsUnauthorized(t *testing.T) {
	f := newLiveFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// No credentials at all.
	if _, resp, err := websocket.Dial(ctx, f.server.URL, nil); err == nil {
		t.Fatal("dial without credentials succeeded, want reject")
	} else if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("dial without credentials: response %+v, want 401", resp)
	}

	// Garbage query token must not fall back to anonymous success either.
	if _, resp, err := websocket.Dial(ctx, f.server.URL+"?token=not-a-jwt", nil); err == nil {
		t.Fatal("dial with garbage token succeeded, want reject")
	} else if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("dial with garbage token: response %+v, want 401", resp)
	}
}

// ==========================================================================
// Poke delivery
// ==========================================================================

func TestLivePokeAfterPush(t *testing.T) {
	f := newLiveFixture(t)

	// Header auth — the primary contract path.
	conn := f.dial(t, f.server.URL, "Bearer "+f.jwt)

	// A committed push with >=1 accepted event must poke every subscriber,
	// including the pusher's own account (this very socket).
	res := f.push(t, f.event(nil))
	if len(res.Accepted) != 1 {
		t.Fatalf("push accepted %d events, want 1", len(res.Accepted))
	}

	msg := readUntil(t, conn, "poke", 5*time.Second)
	if msg.VaultID != f.vaultID {
		t.Fatalf("poke vault_id = %q, want %q", msg.VaultID, f.vaultID)
	}
}

func TestLivePokeOnMembershipInvalidationWithQueryToken(t *testing.T) {
	f := newLiveFixture(t)

	// Query-token fallback — the React-Native-can't-set-headers path.
	conn := f.dial(t, f.server.URL+"?token="+f.jwt, "")

	// The REST vault-management flows (revoke, role change, leave, …) all
	// route through InvalidateMembership; it must poke connected members.
	f.svc.InvalidateMembership(f.vaultID, f.accountID)

	msg := readUntil(t, conn, "poke", 5*time.Second)
	if msg.VaultID != f.vaultID {
		t.Fatalf("poke vault_id = %q, want %q", msg.VaultID, f.vaultID)
	}
}

// ==========================================================================
// Keepalive
// ==========================================================================

func TestLivePingPong(t *testing.T) {
	orig := livePingInterval
	livePingInterval = 50 * time.Millisecond
	t.Cleanup(func() { livePingInterval = orig })

	f := newLiveFixture(t)
	conn := f.dial(t, f.server.URL, "Bearer "+f.jwt)

	// Answer several pings; the connection must stay open well past the
	// 2-missed-pings cutoff (which, unanswered, would land at ~3 ticks).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 6; i++ {
		readUntil(t, conn, "ping", 3*time.Second)
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"t":"pong"}`)); err != nil {
			t.Fatalf("write pong #%d: %v", i, err)
		}
	}
}

func TestLiveDropsConnAfterMissedPings(t *testing.T) {
	orig := livePingInterval
	livePingInterval = 50 * time.Millisecond
	t.Cleanup(func() { livePingInterval = orig })

	f := newLiveFixture(t)
	conn := f.dial(t, f.server.URL, "Bearer "+f.jwt)

	// Never pong. The server must close the socket after 2 consecutive
	// unanswered pings — observed client-side as a read error well within
	// the deadline (3 ticks ≈ 150ms at the shrunk interval).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			if ctx.Err() != nil {
				t.Fatal("server never closed the unresponsive connection")
			}
			return // closed by the server — the behavior under test
		}
	}
}

// ==========================================================================
// Broker unit behavior (no sockets)
// ==========================================================================

func TestLiveBrokerAccountLimitAndDrop(t *testing.T) {
	b := newLiveBroker()
	vault := uuid.NewString()

	// Leak guard: the 9th socket for one account is refused.
	subs := make([]*liveSub, 0, maxLiveSocketsPerAccount)
	for i := 0; i < maxLiveSocketsPerAccount; i++ {
		sub, err := b.subscribe("acct-1", []string{vault})
		if err != nil {
			t.Fatalf("subscribe #%d: %v", i, err)
		}
		subs = append(subs, sub)
	}
	if _, err := b.subscribe("acct-1", []string{vault}); err == nil {
		t.Fatalf("subscribe beyond %d sockets succeeded, want refusal", maxLiveSocketsPerAccount)
	}
	// Unsubscribing frees the slot.
	b.unsubscribe(subs[0])
	if _, err := b.subscribe("acct-1", []string{vault}); err != nil {
		t.Fatalf("subscribe after freeing a slot: %v", err)
	}

	// Drop-on-full: notifies beyond the buffer never block, and the buffer
	// retains exactly livePokeBuffer pokes.
	sub, err := b.subscribe("acct-2", []string{vault})
	if err != nil {
		t.Fatalf("subscribe acct-2: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < livePokeBuffer*3; i++ {
			b.notify(vault)
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("notify blocked on a full subscriber buffer")
	}
	if got := len(sub.ch); got != livePokeBuffer {
		t.Fatalf("buffered pokes = %d, want %d (overflow must drop)", got, livePokeBuffer)
	}
}
