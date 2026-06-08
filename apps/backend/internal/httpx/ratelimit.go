package httpx

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
)

// AccountIDResolver returns the authenticated account_id from the request,
// or "" if the claim isn't present (e.g., the route is unauthenticated or
// the auth middleware was skipped). Injected at startup so httpx does not
// have to import the auth package — that would create an import cycle
// because the auth handlers/middleware already import httpx.
type AccountIDResolver func(r *http.Request) string

// accountIDResolver is set once at startup via SetAccountIDResolver.
// Default is a stub that returns "" so any rate-limit middleware
// installed before wiring falls back to per-IP bucketing rather than
// silently bypassing the cap.
var accountIDResolver AccountIDResolver = func(_ *http.Request) string { return "" }

// SetAccountIDResolver wires the auth-package's claim lookup. main.go
// calls this once with a closure over auth.ClaimsFromContext.
func SetAccountIDResolver(fn AccountIDResolver) {
	if fn != nil {
		accountIDResolver = fn
	}
}

// Rate-limit policy constants. Tuned per route, NOT per group, because the
// risk surface differs sharply:
//
//   - CreateInvite is the only path that emits a kaata.af/i/<token> URL the
//     attacker could try to flood SMS/email pipes with — tight cap.
//   - CreateVault is rare in normal use (a shopkeeper opens 1-2 vaults total)
//     so 20/day is generous and still blocks scripted abuse.
//   - InviteInfo is fully public — the only authenticated knob is the IP.
//     30/hr per IP keeps token-enumeration attempts from being free; the
//     handler also already 404s on missing/mismatch so success requires a
//     genuinely valid token.
//   - SyncPush is hot-path: 1000/hr per account is ~1 request every 3.6s
//     averaged, well above any normal client's churn even on a busy day.
//
// In-memory backend (httprate default) is single-instance only. Phase 5 mesh
// or any horizontal scale will need a Redis-backed limiter swap; documented
// here so the next reader sees the limitation up front.
const (
	createInviteLimit  = 10
	createInviteWindow = time.Hour
	createVaultLimit   = 20
	createVaultWindow  = 24 * time.Hour
	inviteInfoLimit    = 30
	inviteInfoWindow   = time.Hour
	syncPushLimit      = 1000
	syncPushWindow     = time.Hour

	// Phase 5 mesh:
	//   issueVMC: 60/hr per account. Well-behaved clients refresh once per
	//   60-day VMC lifetime; bursts come from "joined N vaults" or recovery
	//   after a key rotation. 60/hr absorbs that without inviting abuse.
	//   registerKey: 5/hr per account. The legit path runs once per first
	//   launch + occasional reinstall.
	issueVMCLimit     = 60
	issueVMCWindow    = time.Hour
	registerKeyLimit  = 5
	registerKeyWindow = time.Hour
)

// keyByAccount pulls the authenticated account_id off the request via the
// injected resolver (wired at startup from main.go so this package does not
// have to import auth — that would form an import cycle).
//
// SEC H4: previously this fell back to per-IP bucketing on a missing
// claim. That degraded silently to a 1000/hr per-IP cap when the auth
// middleware was misordered or future-refactored away — fail-open in
// exactly the surface area that demands fail-closed. Per-account routes
// MUST be installed after SessionAuthenticator.Middleware(), which 401s
// on missing claims, so reaching this resolver without claims is a
// server bug, not a recoverable degradation. We now return a typed
// error that httprate forwards as a 500 via the limit handler — loud and
// detectable in ops dashboards instead of silently collapsing the cap.
func keyByAccount(r *http.Request) (string, error) {
	id := accountIDResolver(r)
	if id == "" {
		return "", errMissingAccountClaim
	}
	return "acct:" + id, nil
}

// errMissingAccountClaim is returned by keyByAccount when a per-account
// rate-limited route is reached without an account_id on the request
// context — almost certainly a middleware-wiring bug.
var errMissingAccountClaim = &rateLimitMisconfigError{
	msg: "rate limit: account_id missing from request context (auth middleware mis-ordered?)",
}

type rateLimitMisconfigError struct{ msg string }

func (e *rateLimitMisconfigError) Error() string { return e.msg }

// keyByRealIP buckets by the client IP as resolved by chi's RealIP middleware
// (which honors X-Forwarded-For / X-Real-IP from the Dokploy/Traefik front).
// Use this for unauthenticated routes only.
func keyByRealIP(r *http.Request) (string, error) {
	return httprate.KeyByIP(r)
}

// rateLimitResponder writes a 429 with Retry-After in seconds and a JSON body
// matching httpx.Error's shape. httprate calls this whenever a request crosses
// the cap. The library tells us the window length; we round up to whole seconds
// so a sub-second remainder doesn't get truncated to "Retry-After: 0".
func rateLimitResponder(w http.ResponseWriter, r *http.Request) {
	// httprate stamps these headers on the response BEFORE invoking the
	// limit handler. We mirror the X-RateLimit-Reset value into the
	// standard Retry-After header that RFC 6585 / 7231 §7.1.3 defines.
	resetSec := 0
	if v := w.Header().Get("X-RateLimit-Reset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			resetSec = n
		}
	}
	if resetSec <= 0 {
		// Fall back to a minimum of 1 if the library did not stamp a
		// precise reset. Never emit Retry-After: 0 — that invites a
		// tight retry loop that immediately re-trips the cap.
		resetSec = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(resetSec))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": "rate limit exceeded; retry after " + strconv.Itoa(resetSec) + "s",
	})
}

// RateLimitPerAccount returns middleware that caps requests at `limit` per
// `window` keyed by the authenticated account_id. MUST be installed AFTER
// SessionAuthenticator.Middleware() in the chain so the claims are on ctx.
//
// SEC H4: WithErrorHandler returns 500 (not 428 default and not fail-open
// per-IP fallback) when keyByAccount errors because the claim is missing.
// Any per-account route reaching this resolver without claims is a
// wiring bug — louder is safer.
func RateLimitPerAccount(limit int, window time.Duration) func(http.Handler) http.Handler {
	return httprate.Limit(
		limit,
		window,
		httprate.WithKeyFuncs(keyByAccount),
		httprate.WithLimitHandler(rateLimitResponder),
		httprate.WithErrorHandler(rateLimitErrorResponder),
	)
}

// rateLimitErrorResponder is invoked by httprate when the key function
// returns a non-nil error (we only do that for the missing-account-claim
// case in keyByAccount). 500 + structured JSON matches httpx.Error's
// shape so the client sees the same error envelope it does elsewhere.
func rateLimitErrorResponder(w http.ResponseWriter, _ *http.Request, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": err.Error(),
	})
}

// RateLimitPerIP returns middleware that caps requests at `limit` per `window`
// keyed by the request's real IP. Use for public/unauthenticated routes.
// Install AFTER middleware.RealIP so X-Forwarded-For is honored.
func RateLimitPerIP(limit int, window time.Duration) func(http.Handler) http.Handler {
	return httprate.Limit(
		limit,
		window,
		httprate.WithKeyFuncs(keyByRealIP),
		httprate.WithLimitHandler(rateLimitResponder),
	)
}

// Compile-time guard: ensures we import chi/middleware so RealIP is wired up
// transitively when callers blank-import this package. Without it, go-vet
// would complain about the unused import if a future refactor drops the
// keyByRealIP usage path.
var _ = middleware.RealIP

// Exported policy constants so main.go reads from one source of truth.
// Window types are explicit so a future change doesn't silently retune
// by changing a literal in main.go.
var (
	CreateInviteLimit  = createInviteLimit
	CreateInviteWindow = createInviteWindow
	CreateVaultLimit   = createVaultLimit
	CreateVaultWindow  = createVaultWindow
	InviteInfoLimit    = inviteInfoLimit
	InviteInfoWindow   = inviteInfoWindow
	SyncPushLimit      = syncPushLimit
	SyncPushWindow     = syncPushWindow

	IssueVMCLimit     = issueVMCLimit
	IssueVMCWindow    = issueVMCWindow
	RegisterKeyLimit  = registerKeyLimit
	RegisterKeyWindow = registerKeyWindow
)
