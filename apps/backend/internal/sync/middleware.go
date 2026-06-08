package sync

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
)

// gzipResponseWriter wraps an http.ResponseWriter to gzip-encode the body.
// Used by GzipResponseMiddleware for sync endpoints so pull responses
// (which can be ~200 events × ~1 KiB each) compress well over the wire.
type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
}

func (g *gzipResponseWriter) WriteHeader(status int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	// Strip Content-Length — the gzipped body's length is unknown.
	g.Header().Del("Content-Length")
	g.Header().Set("Content-Encoding", "gzip")
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipResponseWriter) Write(p []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	return g.gz.Write(p)
}

// GzipResponseMiddleware compresses responses for clients that advertise
// gzip support. Sync endpoints carry JSON bodies that compress 3-5x.
//
// Request-body gunzip is handled inside the push handler via
// readMaybeGzipped, since it needs to enforce a tighter decompressed-size
// cap (16 MiB) than a generic middleware would.
func GzipResponseMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		gz := gzip.NewWriter(w)
		defer func() { _ = gz.Close() }()
		gw := &gzipResponseWriter{ResponseWriter: w, gz: gz}
		next.ServeHTTP(gw, r)
	})
}

// drainBody is a tiny convenience for callers that want to discard a
// remainder safely.
var _ = io.Discard
