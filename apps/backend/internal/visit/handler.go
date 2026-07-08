package visit

import (
	"encoding/json"
	"net/http"
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
	Source   string `json:"source"`
	Path     string `json:"path"`
	Referrer string `json:"referrer"`
}

// POST /v1/visit — fired once per browser session from the web bundle.
// Server harvests IP + Accept-Language directly from the request so the
// fingerprint can't be forged from the body. Source comes from the
// `?s=` query param the QR encodes (passed through by the client).
func (h *Handler) Visit(w http.ResponseWriter, r *http.Request) {
	var req visitRequest
	// Public + anonymous: cap the body and clamp every client-controlled
	// field so web_visits rows stay small no matter what's POSTed.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := h.svc.Record(r.Context(), RecordParams{
		Kind:           "visit",
		Source:         truncateUTF8(req.Source, 200),
		Path:           truncateUTF8(req.Path, 500),
		Referrer:       truncateUTF8(req.Referrer, 500),
		IP:             httpx.ClientIP(r),
		UserAgent:      truncateUTF8(r.UserAgent(), 500),
		AcceptLanguage: truncateUTF8(r.Header.Get("Accept-Language"), 200),
	}); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "visit record failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /v1/download?s=foo — counts the download click then 302s to the APK.
// QR codes can point straight here, skipping the landing page entirely:
//
//	kaata.af/v1/download?s=mandawi_qr_03
//
// Scan → tap → APK starts downloading, and the source is captured. The
// fingerprint (IP) recorded here is later matched against the install's
// first /v1/check-in to tie source → install_id.
func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	_ = h.svc.Record(r.Context(), RecordParams{
		Kind:           "download",
		Source:         truncateUTF8(r.URL.Query().Get("s"), 200),
		Path:           truncateUTF8(r.URL.Path, 500),
		Referrer:       truncateUTF8(r.Header.Get("Referer"), 500),
		IP:             httpx.ClientIP(r),
		UserAgent:      truncateUTF8(r.UserAgent(), 500),
		AcceptLanguage: truncateUTF8(r.Header.Get("Accept-Language"), 200),
	})
	// count_only=1 is the web bundle's analytics beacon (the download button
	// itself points straight at the APK). Record the click but skip the 302 —
	// a redirect can't be followed by the beacon's no-cors fetch and would make
	// the request a network error, which is why web download counts were 0.
	if r.URL.Query().Get("count_only") == "1" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Fail open: the user getting the APK is more important than perfect
	// analytics. A logging error must not block the download.
	http.Redirect(w, r, h.svc.APKDownloadURL(), http.StatusFound)
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
