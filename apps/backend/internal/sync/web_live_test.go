package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	gosync "sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

func TestLiveTicketsSingleUseExpiryAndBindings(t *testing.T) {
	s := newLiveTicketStore()
	now := time.Now()
	key, err := s.issue("session-a", "account-a", "install-a", now)
	if err != nil || len(key) != 43 || strings.Contains(key, "session-a") {
		t.Fatalf("issue: key length %d, error %v", len(key), err)
	}
	var successes atomic.Int32
	var wg gosync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ticket, ok := s.consume(key, now); ok {
				successes.Add(1)
				if ticket.bearer != "session-a" || ticket.accountID != "account-a" || ticket.installID != "install-a" {
					t.Error("ticket lost its original session binding")
				}
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 || len(s.perAccount) != 0 || len(s.perInstall) != 0 {
		t.Fatalf("single-use successes=%d, account/install counts=%d/%d", successes.Load(), len(s.perAccount), len(s.perInstall))
	}
	key, _ = s.issue("session-a", "account-a", "install-a", now)
	if _, ok := s.consume(key, now.Add(liveTicketTTL)); ok {
		t.Fatal("ticket accepted at its expiry")
	}
	for _, invalid := range []string{"", "not-a-ticket", strings.Repeat("x", 43), strings.Repeat("x", 10000)} {
		if _, ok := s.consume(invalid, now); ok {
			t.Fatal("invalid ticket accepted")
		}
	}
}

func TestLiveTicketsBoundedAndExpiredSlotsReclaimed(t *testing.T) {
	now := time.Now()
	s := newLiveTicketStore()
	for i := 0; i < maxLiveTicketsAccount; i++ {
		if _, err := s.issue("session", "account", fmt.Sprint(i/maxLiveTicketsInstall), now); err != nil {
			t.Fatal(err)
		}
		if i == maxLiveTicketsInstall-1 {
			if _, err := s.issue("session", "account", "0", now); !errors.Is(err, errLiveTicketsFull) {
				t.Fatalf("install limit: %v", err)
			}
		}
	}
	if _, err := s.issue("session", "account", "new-install", now); !errors.Is(err, errLiveTicketsFull) {
		t.Fatalf("account limit: %v", err)
	}
	if _, err := s.issue("session-b", "other-account", "0", now); err != nil {
		t.Fatalf("different account shared install budget: %v", err)
	}
	if _, err := s.issue("session", "account", "0", now.Add(liveTicketTTL)); err != nil {
		t.Fatalf("expired slots not reclaimed: %v", err)
	}
	if len(s.tickets) != 1 || len(s.perAccount) != 1 || len(s.perInstall) != 1 {
		t.Fatal("expired tickets retained in store or accounting")
	}
	s = newLiveTicketStore()
	for i := 0; i < maxLiveTickets; i++ {
		if _, err := s.issue("session", fmt.Sprint(i), "install", now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.issue("session", "extra-account", "install", now); !errors.Is(err, errLiveTicketsFull) {
		t.Fatalf("global limit: %v", err)
	}
	if _, err := s.issue("session", "extra-account", "install", now.Add(liveTicketTTL)); err != nil {
		t.Fatalf("global expired slots not reclaimed: %v", err)
	}
}

type webLiveFixture struct {
	*liveFixture
	handler       *Handler
	authenticator *auth.SessionAuthenticator
	authService   *auth.Service
	webServer     *httptest.Server
}

func newWebLiveFixture(t *testing.T) *webLiveFixture {
	t.Helper()
	f := &webLiveFixture{liveFixture: newLiveFixture(t)}
	f.handler = NewHandler(f.svc)
	f.authService = auth.NewService(f.pool, "", testJWTSecret)
	f.authenticator = auth.NewSessionAuthenticator(f.authService, testJWTSecret)
	httpx.SetAccountIDResolver(func(r *http.Request) string {
		claims, ok := auth.ClaimsFromContext(r.Context())
		if !ok {
			return ""
		}
		return claims.AccountID
	})
	mux := http.NewServeMux()
	mux.Handle("POST /v1/sync/live-ticket", f.authenticator.Middleware()(
		httpx.RateLimitPerAccount(120, time.Hour)(http.HandlerFunc(f.handler.LiveTicket))))
	mux.Handle("GET /v1/sync/web-live", f.handler.WebLiveTicketMiddleware(f.authenticator.InvalidateInstall)(
		f.authenticator.Middleware()(http.HandlerFunc(f.handler.Live))))
	f.webServer = httptest.NewServer(mux)
	t.Cleanup(f.webServer.Close)
	return f
}

func (f *webLiveFixture) issue(t *testing.T, bearer string, wantStatus int) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.webServer.URL+"/v1/sync/live-ticket", nil)
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != wantStatus {
		t.Fatalf("ticket status=%d, want=%d", res.StatusCode, wantStatus)
	}
	if wantStatus != http.StatusOK {
		return ""
	}
	var body struct {
		Ticket    string `json:"ticket"`
		ExpiresIn int    `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Ticket) != 43 || body.ExpiresIn != 30 || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("wrong ticket response contract")
	}
	return body.Ticket
}

func (f *webLiveFixture) reject(t *testing.T, query, authorization string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	options := &websocket.DialOptions{HTTPHeader: http.Header{}}
	if authorization != "" {
		options.HTTPHeader.Set("Authorization", authorization)
	}
	conn, res, err := websocket.Dial(ctx, f.webServer.URL+"/v1/sync/web-live"+query, options)
	if err == nil {
		_ = conn.CloseNow()
		t.Fatal("unauthorized browser socket accepted")
	}
	if res == nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("browser socket response=%v, want 401", res)
	}
}

func (f *webLiveFixture) otherAccount(t *testing.T) (string, string) {
	t.Helper()
	accountID, installID := uuid.NewString(), uuid.NewString()
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `INSERT INTO accounts(id,google_sub,email,email_verified,name)
		VALUES ($1::uuid,$2,$3,TRUE,'Other')`, accountID, "sub-"+accountID, accountID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO installs(install_id) VALUES ($1::uuid)`, installID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO auth_credentials(install_id,provider,provider_sub,account_id)
		VALUES ($1::uuid,'google',$2,$3::uuid)`, installID, "sub-"+installID, accountID); err != nil {
		t.Fatal(err)
	}
	bearer, err := auth.SignSession(testJWTSecret, accountID, installID, "google", "sub-"+installID)
	if err != nil {
		t.Fatal(err)
	}
	return accountID, bearer
}

func TestWebLiveTicketRejectsInvalidExpiredAndReusedCredentials(t *testing.T) {
	f := newWebLiveFixture(t)
	f.issue(t, "", http.StatusUnauthorized)
	f.issue(t, "invalid-session", http.StatusUnauthorized)
	for _, query := range []string{"", "?ticket=", "?ticket=bad", "?token=" + f.jwt, "?ticket=" + f.jwt} {
		f.reject(t, query, "")
	}
	key := f.issue(t, f.jwt, http.StatusOK)
	f.reject(t, "?ticket="+key+"&ticket="+key, "")
	f.reject(t, "?ticket="+key+"&token="+f.jwt, "")
	_, otherJWT := f.otherAccount(t)
	f.reject(t, "?ticket="+key, "Bearer "+otherJWT)
	conn := f.dial(t, f.webServer.URL+"/v1/sync/web-live?ticket="+key, "")
	_ = conn.CloseNow()
	f.reject(t, "?ticket="+key, "")
	key = f.issue(t, f.jwt, http.StatusOK)
	f.handler.liveTickets.mu.Lock()
	ticket := f.handler.liveTickets.tickets[key]
	ticket.expiresAt = time.Now().Add(-time.Second)
	f.handler.liveTickets.tickets[key] = ticket
	f.handler.liveTickets.mu.Unlock()
	f.reject(t, "?ticket="+key, "")

	// A session that expires between exchange and connection is revalidated,
	// even though its still-live ticket remains present in the store.
	claims, err := auth.ParseSession(testJWTSecret, f.jwt)
	if err != nil {
		t.Fatal(err)
	}
	claims.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Second))
	expired, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	key, err = f.handler.liveTickets.issue(expired, claims.AccountID, claims.InstallID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	f.reject(t, "?ticket="+key, "")
}

func TestWebLiveCommittedPokeAndAccountIsolation(t *testing.T) {
	f := newWebLiveFixture(t)
	key := f.issue(t, f.jwt, http.StatusOK)
	conn := f.dial(t, f.webServer.URL+"/v1/sync/web-live?ticket="+url.QueryEscape(key), "")
	otherID, otherJWT := f.otherAccount(t)
	otherKey := f.issue(t, otherJWT, http.StatusOK)
	otherConn := f.dial(t, f.webServer.URL+"/v1/sync/web-live?ticket="+otherKey, "")

	event := f.event(nil)
	if res := f.push(t, event); len(res.Accepted) != 1 {
		t.Fatalf("push did not commit event: %+v", res)
	}
	if msg := readUntil(t, conn, "poke", 5*time.Second); msg.VaultID != f.vaultID {
		t.Fatalf("wrong poke: %+v", msg)
	}
	var committed bool
	if err := f.pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM events WHERE event_id=$1::uuid)`, event.EventID).Scan(&committed); err != nil || !committed {
		t.Fatalf("poke arrived before committed event: committed=%v err=%v", committed, err)
	}
	// A marker after the first account's push must be the other socket's next
	// non-ping frame; an accidental cross-account vault subscription fails.
	tabID := uuid.NewString()
	f.svc.NotifyTab(tabID, []string{otherID})
	if msg := readUntil(t, otherConn, "tab_poke", 5*time.Second); msg.TabID != tabID {
		t.Fatalf("wrong account marker: %+v", msg)
	}
}

func TestWebLiveRevalidatesRevocationAndSignOutAfterTicketIssue(t *testing.T) {
	f := newWebLiveFixture(t)
	claims, err := auth.ParseSession(testJWTSecret, f.jwt)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"revoked", "epoch", "signout"} {
		t.Run(mode, func(t *testing.T) {
			key := f.issue(t, f.jwt, http.StatusOK) // primes the successful auth cache
			switch mode {
			case "revoked":
				_, err = f.pool.Exec(context.Background(), `UPDATE auth_credentials SET revoked_at=NOW() WHERE install_id=$1::uuid`, claims.InstallID)
			case "epoch":
				_, err = f.pool.Exec(context.Background(), `UPDATE auth_credentials SET session_epoch=1 WHERE install_id=$1::uuid`, claims.InstallID)
			case "signout":
				err = f.authService.SignOut(context.Background(), claims.InstallID, claims.Provider)
			}
			if err != nil {
				t.Fatal(err)
			}
			// No manual cache eviction: ticket middleware must force a fresh check.
			f.reject(t, "?ticket="+key, "")
			f.reject(t, "?ticket="+key, "")
			f.issue(t, f.jwt, http.StatusUnauthorized)
			if mode != "signout" {
				if _, err := f.pool.Exec(context.Background(), `UPDATE auth_credentials SET revoked_at=NULL,session_epoch=0 WHERE install_id=$1::uuid`, claims.InstallID); err != nil {
					t.Fatal(err)
				}
				f.authenticator.InvalidateInstall(claims.InstallID)
			}
		})
	}
}

func TestWebLiveTicketExchangeRateLimitedPerAccount(t *testing.T) {
	f := newWebLiveFixture(t)
	for i := 0; i < 120; i++ {
		key := f.issue(t, f.jwt, http.StatusOK)
		if _, ok := f.handler.liveTickets.consume(key, time.Now()); !ok {
			t.Fatal("issued ticket missing")
		}
	}
	f.issue(t, f.jwt, http.StatusTooManyRequests)
	_, otherJWT := f.otherAccount(t)
	f.issue(t, otherJWT, http.StatusOK)
}
