package httpx

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP extracts the originating client IP from common proxy headers.
// Trust assumption: backend always sits behind Caddy/Dokploy, so
// X-Forwarded-For is set by infrastructure we control. If the Go server
// is ever exposed directly to the internet, this header is spoofable.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for part := range strings.SplitSeq(xff, ",") {
			ip := strings.TrimSpace(part)
			if ip != "" {
				return ip
			}
		}
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
