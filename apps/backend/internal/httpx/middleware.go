package httpx

import (
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// Preserve Hijacker/Flusher for WebSocket upgrades and streaming routes.
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		status := ww.Status()
		if status == 0 {
			status = http.StatusOK
		}
		// Path only: query strings can contain short-lived socket tickets.
		path := r.URL.Path
		for _, prefix := range []string{"/t/", "/v/", "/v2/", "/v3/", "/v1/shared/", "/i/"} {
			if strings.HasPrefix(path, prefix) {
				path = prefix + "[redacted]"
				break
			}
		}
		log.Printf("%s %s -> %d (%s)", r.Method, path, status, time.Since(start))
	})
}

func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("PANIC: %v", rec)
				Error(w, http.StatusInternalServerError, "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Kaata-Party, X-Kaata-Currencies, X-Kaata-Legacy-Currency, X-Kaata-Entry-Currency-Edit, X-Kaata-Tab-Recording, X-Kaata-Tab-One-Way, X-Kaata-Tab-Group")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
