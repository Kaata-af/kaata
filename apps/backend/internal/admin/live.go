package admin

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/matee/kaata-backend/internal/httpx"
)

const (
	liveTicketTTL  = 30 * time.Second
	maxLiveTickets = 64
	maxLiveSockets = 16
	liveReadLimit  = 256
)

type liveSubscription struct {
	changed chan struct{}
}

// Live is a single-process, best-effort admin invalidation stream. It carries
// no user or ledger data; clients re-fetch the existing authenticated APIs.
// Polling remains the backstop for missed signals, cron/direct-SQL changes,
// and changes processed by another backend replica. Tickets are also local to
// this process, so a future multi-replica deployment needs sticky routing or a
// shared ticket/broker implementation.
type Live struct {
	ctx          context.Context
	enabled      bool
	mu           sync.Mutex
	tickets      map[string]time.Time
	subs         map[*liveSubscription]struct{}
	pingInterval time.Duration
	writeTimeout time.Duration
}

// NewLive uses the server shutdown context because http.Server.Shutdown does
// not close hijacked WebSocket connections.
func NewLive(ctx context.Context, enabled bool) *Live {
	return &Live{
		ctx: ctx, enabled: enabled,
		tickets:      make(map[string]time.Time),
		subs:         make(map[*liveSubscription]struct{}),
		pingInterval: 30 * time.Second,
		writeTimeout: 10 * time.Second,
	}
}

// Ticket is mounted behind AdminKeyMiddleware. Only the short-lived, single-use
// ticket goes in the WebSocket URL; never the persistent administrator key.
func (l *Live) Ticket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !l.enabled {
		http.NotFound(w, r)
		return
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "live ticket unavailable")
		return
	}
	ticket := base64.RawURLEncoding.EncodeToString(random[:])
	now := time.Now()
	l.mu.Lock()
	for token, expiry := range l.tickets {
		if !now.Before(expiry) {
			delete(l.tickets, token)
		}
	}
	status := http.StatusOK
	if l.ctx.Err() != nil {
		status = http.StatusServiceUnavailable
	} else if len(l.tickets) >= maxLiveTickets {
		status = http.StatusTooManyRequests
	} else {
		l.tickets[ticket] = now.Add(liveTicketTTL)
	}
	l.mu.Unlock()
	if status != http.StatusOK {
		httpx.Error(w, status, "live ticket unavailable")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Ticket    string `json:"ticket"`
		ExpiresIn int    `json:"expires_in"`
	}{Ticket: ticket, ExpiresIn: int(liveTicketTTL / time.Second)})
}

func (l *Live) reserve(ticket string) (*liveSubscription, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	expiry, exists := l.tickets[ticket]
	// Consume before upgrade, even when upgrade or capacity checks fail.
	delete(l.tickets, ticket)
	if !exists || !time.Now().Before(expiry) {
		return nil, http.StatusUnauthorized
	}
	if l.ctx.Err() != nil {
		return nil, http.StatusServiceUnavailable
	}
	if len(l.subs) >= maxLiveSockets {
		return nil, http.StatusTooManyRequests
	}
	sub := &liveSubscription{changed: make(chan struct{}, 1)}
	l.subs[sub] = struct{}{}
	return sub, http.StatusOK
}

func (l *Live) release(sub *liveSubscription) {
	l.mu.Lock()
	delete(l.subs, sub)
	l.mu.Unlock()
}

// Notify never blocks a mutation on a client. One pending invalidation is
// sufficient, so bursts coalesce in each subscriber's one-element mailbox.
func (l *Live) Notify() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for sub := range l.subs {
		select {
		case sub.changed <- struct{}{}:
		default:
		}
	}
}

// Subscribe validates and consumes the ticket before upgrading. Authentication
// is the explicit ticket, not ambient cookies, so cross-origin admin hosting
// is supported without trusting browser origins as authorization.
func (l *Live) Subscribe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !l.enabled {
		http.NotFound(w, r)
		return
	}
	sub, status := l.reserve(r.URL.Query().Get("ticket"))
	if status != http.StatusOK {
		httpx.Error(w, status, "live subscription unavailable")
		return
	}
	defer l.release(sub)
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return // Accept writes its own HTTP error; never log the ticket URL.
	}
	defer conn.CloseNow()
	conn.SetReadLimit(liveReadLimit)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(l.ctx, cancel)
	defer stop()

	pongs := make(chan struct{}, 1)
	go func() {
		defer cancel()
		for {
			kind, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var msg struct {
				T string `json:"t"`
			}
			if kind == websocket.MessageText && json.Unmarshal(data, &msg) == nil && msg.T == "pong" {
				select {
				case pongs <- struct{}{}:
				default:
				}
			}
		}
	}()
	write := func(kind string) error {
		writeCtx, done := context.WithTimeout(ctx, l.writeTimeout)
		defer done()
		return conn.Write(writeCtx, websocket.MessageText, []byte(`{"t":"`+kind+`"}`))
	}
	if write("ready") != nil {
		return
	}
	ticker := time.NewTicker(l.pingInterval)
	defer ticker.Stop()
	missed := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-sub.changed:
			if write("invalidate") != nil {
				return
			}
		case <-pongs:
			missed = 0
		case <-ticker.C:
			if missed >= 2 || write("ping") != nil {
				return
			}
			missed++
		}
	}
}

// NotifyOnSuccess runs inside the global recovery middleware. A panicking or
// failed request therefore cannot announce success. This intentionally tracks
// request completion rather than row changes: duplicate/no-op writes may send
// a harmless extra invalidation, while cron and direct SQL use polling fallback.
func (l *Live) NotifyOnSuccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.enabled || !adminMutation(r.Method, r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		status := ww.Status()
		if status == 0 || (status >= 200 && status < 400) {
			l.Notify()
		}
	})
}

func adminMutation(method, path string) bool {
	if method == http.MethodGet {
		return path == "/v1/download"
	}
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return false
	}
	switch path {
	case "/v1/check-in", "/v1/visit", "/v1/shared", "/v1/sync/push", "/v1/account", "/v1/vaults":
		return true
	}
	return strings.HasPrefix(path, "/v1/auth/") ||
		strings.HasPrefix(path, "/v1/account/") || strings.HasPrefix(path, "/v1/vaults/")
}
