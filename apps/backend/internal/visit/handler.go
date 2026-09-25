package visit

import (
	"encoding/json"
	"net/http"
	"net/url"
	"unicode/utf8"

	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

type visitRequest struct {
	Kind     string `json:"kind"`
	Source   string `json:"source"`
	Path     string `json:"path"`
	Referrer string `json:"referrer"`
	Detail   string `json:"detail"`
}

// POST /v1/visit — fired once per browser session from the web bundle
// (kind omitted / "visit"), and on every store-badge click on the download
// page (kind "store_click", detail "play" | "appstore"). Server harvests
// IP + Accept-Language directly from the request. Source comes from the
// `?s=` query param the QR encodes (passed through by the client).
func (h *Handler) Visit(w http.ResponseWriter, r *http.Request) {
	var req visitRequest
	// Public + anonymous: cap the body and clamp every client-controlled
	// field so web_visits rows stay small no matter what's POSTed.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	// Whitelist the kind — 'download' stays server-stamped by /v1/download
	// only, and arbitrary strings must not reach the CHECK constraint (a
	// violated CHECK would read as a 500, not the caller's fault).
	kind := req.Kind
	detail := ""
	switch kind {
	case "", "visit":
		kind = "visit"
	case "store_click":
		// detail says WHICH store; anything unrecognized is dropped rather
		// than stored (the column is an enum-in-spirit, not a free field).
		if req.Detail == "play" || req.Detail == "appstore" {
			detail = req.Detail
		}
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid kind")
		return
	}
	if err := h.svc.Record(r.Context(), RecordParams{
		Kind:           kind,
		Source:         truncateUTF8(req.Source, 200),
		Path:           truncateUTF8(req.Path, 500),
		Referrer:       truncateUTF8(req.Referrer, 500),
		IP:             httpx.ClientIP(r),
		UserAgent:      truncateUTF8(r.UserAgent(), 500),
		AcceptLanguage: truncateUTF8(r.Header.Get("Accept-Language"), 200),
		Detail:         detail,
	}); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "visit record failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /v1/download?s=foo preserves printed QR links and their attribution.
// It redirects to the store landing page; analytics failures never block it.
func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	// Range continuations are the SAME download being resumed, and HEAD
	// requests are download-manager probes, not downloads — only count the
	// initial full GET, or one flaky-network download inflates the
	// analytics by every retry/probe it needed.
	if r.Method == http.MethodGet && r.Header.Get("Range") == "" {
		_ = h.svc.Record(r.Context(), RecordParams{
			Kind:           "download",
			Source:         truncateUTF8(r.URL.Query().Get("s"), 200),
			Path:           truncateUTF8(r.URL.Path, 500),
			Referrer:       truncateUTF8(r.Header.Get("Referer"), 500),
			IP:             httpx.ClientIP(r),
			UserAgent:      truncateUTF8(r.UserAgent(), 500),
			AcceptLanguage: truncateUTF8(r.Header.Get("Accept-Language"), 200),
		})
	}
	// Keep old clients' count-only analytics beacons compatible.
	if r.URL.Query().Get("count_only") == "1" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	target := h.svc.DownloadURL()
	if source := truncateUTF8(r.URL.Query().Get("s"), 200); source != "" {
		target += "?" + url.Values{"s": []string{source}}.Encode()
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// truncateUTF8 caps s at max bytes, backing up to a rune boundary so the
// result stays valid UTF-8 — Postgres rejects invalid byte sequences, which
// would abort the insert.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}
