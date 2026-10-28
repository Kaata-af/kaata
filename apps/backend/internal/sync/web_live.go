package sync

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	gosync "sync"
	"time"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

const (
	liveTicketTTL            = 30 * time.Second
	maxLiveTickets           = 4096
	maxLiveTicketsAccount    = 32
	maxLiveTicketsInstall    = 4
	maxLiveTicketBearerBytes = 8192
)

var errLiveTicketsFull = errors.New("too many pending live connections")

type liveTicket struct {
	bearer    string
	accountID string
	installID string
	expiresAt time.Time
}

// Tickets only bridge the browser WebSocket API's inability to send a bearer
// header. They authorize the original verified session for at most 30s;
// redeeming one still goes through the normal session authenticator. Like the
// live broker, this store assumes the existing single-instance deployment.
type liveTicketStore struct {
	mu         gosync.Mutex
	tickets    map[string]liveTicket
	perAccount map[string]int
	perInstall map[string]int
}

func newLiveTicketStore() *liveTicketStore {
	return &liveTicketStore{
		tickets: make(map[string]liveTicket), perAccount: make(map[string]int),
		perInstall: make(map[string]int),
	}
}

func (t liveTicket) installKey() string { return t.accountID + "|" + t.installID }

func (s *liveTicketStore) remove(key string, ticket liveTicket) {
	delete(s.tickets, key)
	for _, count := range []struct {
		values map[string]int
		key    string
	}{{s.perAccount, ticket.accountID}, {s.perInstall, ticket.installKey()}} {
		if count.values[count.key] <= 1 {
			delete(count.values, count.key)
		} else {
			count.values[count.key]--
		}
	}
}

func (s *liveTicketStore) issue(bearer, accountID, installID string, now time.Time) (string, error) {
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	key := base64.RawURLEncoding.EncodeToString(random[:])
	// The parsed token may be a substring of a whitespace-padded HTTP header;
	// copy it so a small ticket cannot retain that much larger backing string.
	ticket := liveTicket{bearer: strings.Clone(bearer), accountID: accountID, installID: installID, expiresAt: now.Add(liveTicketTTL)}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Opportunistic cleanup needs no background goroutine. Only authenticated,
	// rate-limited issuance scans the bounded store; bad redemption is O(1).
	for k, pending := range s.tickets {
		if !now.Before(pending.expiresAt) {
			s.remove(k, pending)
		}
	}
	if len(s.tickets) >= maxLiveTickets || s.perAccount[accountID] >= maxLiveTicketsAccount ||
		s.perInstall[ticket.installKey()] >= maxLiveTicketsInstall {
		return "", errLiveTicketsFull
	}
	s.tickets[key] = ticket
	s.perAccount[accountID]++
	s.perInstall[ticket.installKey()]++
	return key, nil
}

func (s *liveTicketStore) consume(key string, now time.Time) (liveTicket, bool) {
	// A JWT, malformed value, or oversized query can never be a ticket.
	if len(key) != 43 {
		return liveTicket{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ticket, ok := s.tickets[key]
	if !ok {
		return liveTicket{}, false
	}
	s.remove(key, ticket)
	return ticket, now.Before(ticket.expiresAt)
}

// LiveTicket — POST /v1/sync/live-ticket (authenticated and rate limited).
func (h *Handler) LiveTicket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, ok := auth.ClaimsFromContext(r.Context())
	header := strings.Fields(r.Header.Get("Authorization"))
	if !ok || claims.AccountID == "" || claims.InstallID == "" || len(header) != 2 ||
		!strings.EqualFold(header[0], "Bearer") || len(header[1]) > maxLiveTicketBearerBytes {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	ticket, err := h.liveTickets.issue(header[1], claims.AccountID, claims.InstallID, time.Now())
	if err != nil {
		if errors.Is(err, errLiveTicketsFull) {
			w.Header().Set("Retry-After", "30")
			httpx.Error(w, http.StatusTooManyRequests, err.Error())
		} else {
			httpx.Error(w, http.StatusInternalServerError, "live connection unavailable")
		}
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ticket": ticket, "expires_in": int(liveTicketTTL.Seconds())})
}

// WebLiveTicketMiddleware belongs only on /v1/sync/web-live and must run before
// the shared SessionAuthenticator.Middleware. A ticket is consumed even if the
// upgrade or subsequent authentication fails. invalidateInstall clears the
// credential cache before revalidation so sign-out/revocation since issuance
// cannot be masked by the successful exchange's cached verdict.
func (h *Handler) WebLiveTicketMiddleware(invalidateInstall func(string)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			query := r.URL.Query()
			keys := query["ticket"]
			if len(keys) != 1 || query.Has("token") || r.Header.Get("Authorization") != "" {
				httpx.Error(w, http.StatusUnauthorized, "invalid or expired live ticket")
				return
			}
			ticket, ok := h.liveTickets.consume(keys[0], time.Now())
			if !ok {
				httpx.Error(w, http.StatusUnauthorized, "invalid or expired live ticket")
				return
			}
			invalidateInstall(ticket.installID)
			request := r.Clone(r.Context())
			request.Header.Set("Authorization", "Bearer "+ticket.bearer)
			// Neither handlers nor downstream middleware need the query secret.
			query.Del("ticket")
			request.URL.RawQuery = query.Encode()
			request.RequestURI = request.URL.RequestURI()
			next.ServeHTTP(w, request)
		})
	}
}
