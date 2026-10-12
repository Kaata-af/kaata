package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Shops behind one carrier NAT share an IP. Signed-in tab reads must be
// budgeted per account, anonymous ones per IP, with the IP ceiling still on.
func TestRateLimitPerAccountOrIPSeparatesAccountsBehindOneIP(t *testing.T) {
	prev := accountIDResolver
	accountIDResolver = func(r *http.Request) string { return r.Header.Get("X-Test-Account") }
	defer func() { accountIDResolver = prev }()

	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	h := RateLimitPerAccountOrIP(2, time.Minute)(RateLimitPerIP(5, time.Minute)(ok))
	call := func(account string) int {
		r := httptest.NewRequest(http.MethodGet, "/v1/tabs/x", nil)
		r.RemoteAddr = "198.51.100.7:1234" // the same NAT address for everyone
		if account != "" {
			r.Header.Set("X-Test-Account", account)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	for i := 0; i < 2; i++ {
		if got := call("acct-a"); got != http.StatusOK {
			t.Fatalf("account a request %d = %d", i+1, got)
		}
	}
	if got := call("acct-a"); got != http.StatusTooManyRequests {
		t.Fatalf("account a over its budget = %d, want 429", got)
	}
	if got := call("acct-b"); got != http.StatusOK {
		t.Fatalf("account b behind the same IP = %d, want its own budget", got)
	}
	if got := call(""); got != http.StatusOK {
		t.Fatalf("anonymous request = %d, want the IP budget", got)
	}
	// 5 requests have now reached the IP ceiling's handler (a, a, b, anon + b).
	if got := call("acct-b"); got != http.StatusOK {
		t.Fatalf("fifth request under the IP ceiling = %d", got)
	}
	if got := call("acct-c"); got != http.StatusTooManyRequests {
		t.Fatalf("a fresh account past the IP ceiling = %d, want 429", got)
	}
}
