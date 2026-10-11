package httpx

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP extracts the originating client IP.
//
// Trust model: requests reach the backend through Cloudflare (the API's DNS
// record is proxied) and then Dokploy's Traefik. Every X-Forwarded-For entry
// left of the hops we run can be written by the client: Cloudflare APPENDS
// the address it saw to whatever the client sent. So the client is the
// RIGHTMOST address that is not one of our hops: walk the header from the
// right, skipping internal (Traefik, Docker) and Cloudflare addresses, and
// stop at the first other one.
//
// When every entry is such a hop (Traefik's default replaces the header with
// the Cloudflare edge it accepted the connection from), the request came
// through Cloudflare, so Cloudflare's CF-Connecting-IP names the client.
// CF-Connecting-IP on a request whose hops do not include Cloudflare is
// ignored: anyone reaching the origin directly could forge it. We never honor
// True-Client-IP or X-Real-IP, which our edge does not set.
//
// Without proxy headers (local development) it is the TCP peer.
func ClientIP(r *http.Request) string {
	hops := forwardedFor(r)
	viaCloudflare := false
	for i := len(hops) - 1; i >= 0; i-- {
		raw := hops[i]
		ip := net.ParseIP(raw)
		switch {
		case ip == nil:
			// Not an address: by position it is the client's own claim.
			return raw
		case isCloudflare(ip):
			viaCloudflare = true
		case isInternal(ip):
		default:
			return ip.String()
		}
	}
	if viaCloudflare {
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("CF-Connecting-IP"))); ip != nil {
			return ip.String()
		}
	}
	if len(hops) > 0 {
		return hops[0]
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// forwardedFor returns every X-Forwarded-For entry in order, across repeated
// headers, trimmed and without empty entries.
func forwardedFor(r *http.Request) []string {
	var hops []string
	for _, value := range r.Header.Values("X-Forwarded-For") {
		for part := range strings.SplitSeq(value, ",") {
			if p := strings.TrimSpace(part); p != "" {
				hops = append(hops, p)
			}
		}
	}
	return hops
}

// RealIP rewrites r.RemoteAddr to ClientIP so downstream middleware (the
// per-IP rate limiter) keys off the real client, never an address the client
// chose. Use this in place of chi's middleware.RealIP, which trusts
// True-Client-IP and X-Real-IP at the highest precedence.
func RealIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Forwarded-For") != "" {
			r.RemoteAddr = ClientIP(r)
		}
		next.ServeHTTP(w, r)
	})
}

// cloudflareRanges is Cloudflare's published edge address list
// (https://www.cloudflare.com/ips/, unchanged for years; re-check it if
// clients ever start to look like Cloudflare addresses).
var cloudflareRanges = mustCIDRs(
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
	"141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
	"197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
	"104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
	"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
	"2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
)

// sharedAddressSpace is RFC 6598 100.64.0.0/10: carrier and overlay networks
// inside our own path, never a client as seen from the internet.
var sharedAddressSpace = mustCIDRs("100.64.0.0/10")

func isCloudflare(ip net.IP) bool { return inRanges(ip, cloudflareRanges) }

func isInternal(ip net.IP) bool {
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() ||
		inRanges(ip, sharedAddressSpace)
}

func inRanges(ip net.IP, ranges []*net.IPNet) bool {
	for _, n := range ranges {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func mustCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic("httpx: bad CIDR " + c)
		}
		out = append(out, n)
	}
	return out
}
