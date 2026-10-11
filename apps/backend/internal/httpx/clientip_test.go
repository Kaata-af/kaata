package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The client is never an address the client wrote. Cloudflare appends what it
// saw to the client's own X-Forwarded-For; Traefik either appends its peer or
// replaces the header with it.
func TestClientIPIgnoresAddressesTheClientWrote(t *testing.T) {
	cases := []struct {
		name   string
		xff    []string
		cf     string
		remote string
		want   string
	}{
		{"Cloudflare appended, Traefik appended", []string{"6.6.6.6, 203.0.113.9, 172.70.1.1"}, "", "10.0.1.4:51000", "203.0.113.9"},
		{"Traefik replaced the header with the Cloudflare edge", []string{"172.70.1.1"}, "203.0.113.9", "10.0.1.4:51000", "203.0.113.9"},
		{"an IPv6 Cloudflare edge", []string{"2606:4700::6810:1"}, "2001:db8:5::7", "10.0.1.4:51000", "2001:db8:5::7"},
		{"a forged CF-Connecting-IP straight to the origin", []string{"198.51.100.7"}, "1.1.1.1", "10.0.1.4:51000", "198.51.100.7"},
		{"a forged entry straight to the origin", []string{"6.6.6.6, 198.51.100.7"}, "", "10.0.1.4:51000", "198.51.100.7"},
		{"internal hops are skipped", []string{"203.0.113.9, 10.0.1.5, 100.64.3.2"}, "", "127.0.0.1:1", "203.0.113.9"},
		{"repeated headers keep their order", []string{"6.6.6.6", "203.0.113.9, 162.158.4.4"}, "", "10.0.1.4:51000", "203.0.113.9"},
		{"garbage is the client's own claim", []string{"not-an-ip"}, "", "10.0.1.4:51000", "not-an-ip"},
		{"no proxy headers: the TCP peer", nil, "9.9.9.9", "192.0.2.10:443", "192.0.2.10"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = c.remote
			for _, v := range c.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if c.cf != "" {
				r.Header.Set("CF-Connecting-IP", c.cf)
			}
			if got := ClientIP(r); got != c.want {
				t.Fatalf("ClientIP = %q, want %q", got, c.want)
			}
			var seen string
			RealIP(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = r.RemoteAddr })).
				ServeHTTP(httptest.NewRecorder(), r)
			if len(c.xff) > 0 && seen != c.want {
				t.Fatalf("RealIP set RemoteAddr = %q, want %q", seen, c.want)
			}
		})
	}
}
