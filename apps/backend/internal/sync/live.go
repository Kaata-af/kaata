// Live-sync poke channel — GET /v1/sync/live (WebSocket).
//
// The socket carries NO ledger data. It exists only to collapse the polling
// latency between "co-editor pushed" and "my device pulled": the server sends
// {"t":"poke","vault_id":"…"} when a vault gains committed events (or its
// membership changes), and the client reacts by running the SAME
// authenticated pull it would have run on its next poll tick. Every
// authorization decision therefore still happens on the pull path — a poke
// received by a just-revoked member leads to a 403, never to data.
//
// Because polling continues to exist as the backstop, delivery here is
// deliberately best-effort: pokes are dropped rather than ever blocking
// PushEvents, and a dead socket is simply reaped (the client reconnects).
package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	gosync "sync"
	"time"

	"github.com/coder/websocket"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

const (
	// livePokeBuffer is each subscriber's poke-channel capacity. When a
	// burst overflows it, Notify DROPS the poke instead of blocking —
	// harmless, because (a) any one queued poke already means "pull this
	// vault", extra ones are redundant, and (b) the client's regular poll
	// still exists as the backstop for a missed poke.
	livePokeBuffer = 8

	// maxLiveSocketsPerAccount is a leak guard, not a feature limit. A
	// shopkeeper has a handful of devices; more than 8 concurrent sockets
	// for one account means a client-side reconnect loop that isn't closing
	// its old connections. Rejecting with 429 pre-upgrade keeps the server's
	// goroutine count bounded by 8 × accounts.
	maxLiveSocketsPerAccount = 8

	// liveMaxMissedPings: the conn is dropped when this many consecutive
	// pings go unanswered by a {"t":"pong"}.
	liveMaxMissedPings = 2

	// liveWriteTimeout bounds every frame write. A peer that stopped
	// reading (dead radio, suspended app) would otherwise pin the writer
	// goroutine on a full TCP buffer forever — after hijack the http.Server
	// Write/Idle timeouts no longer apply, so the socket must police itself.
	liveWriteTimeout = 10 * time.Second
)

// livePingInterval implements the keepalive contract: {"t":"ping"} every 30s.
// JSON-level pings (not WS protocol pings) because React Native's WebSocket
// does not expose protocol-level ping/pong to application code. A var, not a
// const, ONLY so live_test.go can shrink it — production code never writes it.
var livePingInterval = 30 * time.Second

// liveMsg is the single wire shape for both directions.
//
//	server → client: {"t":"poke","vault_id":"<uuid>"} | {"t":"ping"}
//	client → server: {"t":"pong"}
type liveMsg struct {
	T       string `json:"t"`
	VaultID string `json:"vault_id,omitempty"`
}

// liveSub is one connected socket's subscription. The vault set is resolved
// ONCE at connect time (see Handler.Live) — a vault joined mid-connection
// starts poking after the client's next reconnect, and a vault revoked
// mid-connection keeps receiving (harmless) pokes until disconnect. Both
// staleness windows are acceptable because pokes carry no data and the pull
// path re-checks membership on every request.
type liveSub struct {
	accountID string
	ch        chan string // buffered vault_id pokes
}

// liveBroker is the in-memory per-vault fanout. Single-instance deploy —
// same assumption as every other in-process cache in this Service (membership
// LRU, pull-page LRU): one backend replica, so no Redis/pubsub indirection.
type liveBroker struct {
	mu gosync.Mutex
	// subs is vault_id → the sockets subscribed to it. One liveSub appears
	// under every vault in its connect-time membership list.
	subs map[string]map[*liveSub]struct{}
	// perAccount counts open sockets per account for the leak guard.
	perAccount map[string]int
}

func newLiveBroker() *liveBroker {
	return &liveBroker{
		subs:       make(map[string]map[*liveSub]struct{}),
		perAccount: make(map[string]int),
	}
}

// subscribe registers a socket for every vault in vaultIDs. Returns an error
// when the account already holds maxLiveSocketsPerAccount sockets — callers
// must reject BEFORE upgrading so the client sees a plain HTTP 429.
func (b *liveBroker) subscribe(accountID string, vaultIDs []string) (*liveSub, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.perAccount[accountID] >= maxLiveSocketsPerAccount {
		return nil, fmt.Errorf("account %s already holds %d live sockets", accountID, maxLiveSocketsPerAccount)
	}
	sub := &liveSub{
		accountID: accountID,
		ch:        make(chan string, livePokeBuffer),
	}
	for _, v := range vaultIDs {
		set, ok := b.subs[v]
		if !ok {
			set = make(map[*liveSub]struct{})
			b.subs[v] = set
		}
		set[sub] = struct{}{}
	}
	b.perAccount[accountID]++
	return sub, nil
}

// unsubscribe removes the socket from every vault set and releases its
// per-account slot. Idempotence is not needed — the single caller runs it
// exactly once via defer.
func (b *liveBroker) unsubscribe(sub *liveSub) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for v, set := range b.subs {
		if _, ok := set[sub]; ok {
			delete(set, sub)
			if len(set) == 0 {
				delete(b.subs, v)
			}
		}
	}
	if n := b.perAccount[sub.accountID]; n <= 1 {
		delete(b.perAccount, sub.accountID)
	} else {
		b.perAccount[sub.accountID] = n - 1
	}
}

// notify fans a poke out to every subscriber of vaultID, INCLUDING the
// pusher's own socket — the pusher's follow-up pull is a cursor-idempotent
// no-op, and excluding it would require threading the pushing socket's
// identity through PushEvents for zero benefit. Non-blocking by
// construction: a full channel drops the poke (see livePokeBuffer).
func (b *liveBroker) notify(vaultID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for sub := range b.subs[vaultID] {
		select {
		case sub.ch <- vaultID:
		default:
			// Subscriber's buffer is full: it already has pending pokes it
			// hasn't drained, so it will pull anyway. Dropping keeps this
			// call O(subscribers) with zero blocking on the push hot path.
		}
	}
}

// NotifyLive fans a poke out for vaultID. Exposed on the Service so the
// push commit path and the membership-invalidation entry point (both in
// service.go) can poke without knowing broker internals.
func (s *Service) NotifyLive(vaultID string) {
	if s.live != nil {
		s.live.notify(vaultID)
	}
}

// liveVaultIDs resolves the connect-time subscription set: every vault the
// account is an ACTIVE member of (accepted, not revoked). Archived vaults
// are deliberately NOT filtered out — the owner keeps sync access during the
// 30-day grace and should keep getting pokes; non-owners' pulls 403 with
// vault_archived, which is exactly the signal their client needs anyway.
func (s *Service) liveVaultIDs(ctx context.Context, accountID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT vault_id::text FROM vault_members
		 WHERE account_id = $1::uuid
		   AND accepted_at IS NOT NULL
		   AND revoked_at IS NULL
	`, accountID)
	if err != nil {
		return nil, fmt.Errorf("live: vault list: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("live: vault list scan: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// LiveTokenFallbackMiddleware promotes ?token=<jwt> into the Authorization
// header when (and only when) no Authorization header is present — header
// wins. This lets the standard session middleware authenticate the WebSocket
// upgrade unchanged (signature, expiry, AND the 60s revocation cache) for
// clients whose WebSocket API cannot set headers. Register it BEFORE
// authenticator.Middleware() on the /v1/sync/live group only: promoting
// query tokens on ordinary REST routes would invite tokens into access logs
// and referrers for no reason.
func LiveTokenFallbackMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			if tok := r.URL.Query().Get("token"); tok != "" {
				r.Header.Set("Authorization", "Bearer "+tok)
			}
		}
		next.ServeHTTP(w, r)
	})
}

// Live — GET /v1/sync/live (PROTECTED; WebSocket upgrade).
func (h *Handler) Live(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	vaultIDs, err := h.svc.liveVaultIDs(r.Context(), claims.AccountID)
	if err != nil {
		log.Printf("sync.live: vault list failed for account=%s: %v", claims.AccountID, err)
		httpx.Error(w, http.StatusInternalServerError, "live subscribe failed")
		return
	}

	// Reserve the subscription BEFORE upgrading so the per-account limit is
	// a clean HTTP 429 the client can back off on, not a post-upgrade close.
	sub, err := h.svc.live.subscribe(claims.AccountID, vaultIDs)
	if err != nil {
		httpx.Error(w, http.StatusTooManyRequests, "too many live connections for this account")
		return
	}
	defer h.svc.live.unsubscribe(sub)

	// OriginPatterns "*": this endpoint is consumed by the mobile app's
	// WebSocket client, which sends no browser Origin. The Origin check
	// exists to stop cross-site WebSocket hijacking of COOKIE-authenticated
	// endpoints; auth here is an explicit bearer JWT that a hostile web page
	// cannot obtain, so origin allowlisting adds nothing.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		// Accept already wrote the HTTP error response.
		return
	}
	// CloseNow is the unconditional cleanup; the graceful close paths below
	// run first when they apply.
	defer conn.CloseNow()

	// Own cancellation domain: after hijack the request context is no longer
	// cancelled by the server on connection loss, so the reader goroutine's
	// exit (via cancel) is what unwinds the writer loop.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Reader: the client only ever sends {"t":"pong"}. Anything unparseable
	// is ignored rather than fatal — a lenient reader means a client-side
	// bug degrades to the ping-timeout path instead of a tight reconnect
	// loop. A read error (peer closed, network died) cancels the writer.
	pongCh := make(chan struct{}, 1)
	go func() {
		defer cancel()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var m liveMsg
			if json.Unmarshal(data, &m) == nil && m.T == "pong" {
				select {
				case pongCh <- struct{}{}:
				default:
				}
			}
		}
	}()

	writeJSON := func(msg liveMsg) error {
		// Per-frame deadline; see liveWriteTimeout.
		wctx, wcancel := context.WithTimeout(ctx, liveWriteTimeout)
		defer wcancel()
		b, err := json.Marshal(msg)
		if err != nil {
			return err
		}
		return conn.Write(wctx, websocket.MessageText, b)
	}

	// Writer loop: pokes as they arrive, pings on the keepalive cadence.
	// awaitingPongs counts pings sent since the last pong; hitting
	// liveMaxMissedPings at the next tick means the peer answered neither of
	// the last two pings within 30s each — treat the conn as dead.
	pingTick := time.NewTicker(livePingInterval)
	defer pingTick.Stop()
	awaitingPongs := 0
	for {
		select {
		case <-ctx.Done():
			return
		case vaultID := <-sub.ch:
			if err := writeJSON(liveMsg{T: "poke", VaultID: vaultID}); err != nil {
				return
			}
		case <-pongCh:
			awaitingPongs = 0
		case <-pingTick.C:
			if awaitingPongs >= liveMaxMissedPings {
				// Graceful close so a half-alive peer that can still read
				// learns why; errors ignored — CloseNow follows regardless.
				_ = conn.Close(websocket.StatusPolicyViolation, "ping timeout")
				return
			}
			if err := writeJSON(liveMsg{T: "ping"}); err != nil {
				return
			}
			awaitingPongs++
		}
	}
}
