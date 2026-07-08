package httpx

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP extracts the originating client IP.
//
// Trust model: the backend always sits behind the Dokploy/Traefik edge, which
// sets X-Forwarded-For to the observed client IP (and, on its default config,
// REPLACES any inbound XFF for an untrusted downstream — so the leftmost entry
// is the real client). We deliberately do NOT honor True-Client-IP or
// X-Real-IP: our edge does not emit them, so trusting them would let any client
// spoof its source IP and defeat every per-IP rate limit / poison attribution.
// If the Go server is ever exposed directly to the internet, XFF is spoofable
// and this must key off r.RemoteAddr instead.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for part := range strings.SplitSeq(xff, ",") {
			ip := strings.TrimSpace(part)
			if ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// RealIP rewrites r.RemoteAddr from X-Forwarded-For so downstream middleware
// (the per-IP rate limiter) keys off the real client. Unlike chi's
// middleware.RealIP we ignore True-Client-IP and X-Real-IP: those are not set
// by our edge and are attacker-controllable, so trusting them (as chi does, at
// highest precedence) lets a client rotate a spoofed header to get a fresh
// rate-limit bucket per request. Use this in place of middleware.RealIP.
func RealIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i >= 0 {
				xff = xff[:i]
			}
			if ip := strings.TrimSpace(xff); ip != "" {
				r.RemoteAddr = ip
			}
		}
		next.ServeHTTP(w, r)
	})
}
