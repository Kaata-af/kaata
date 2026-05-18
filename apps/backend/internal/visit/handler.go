package visit

import (
	"encoding/json"
	"net/http"

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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := h.svc.Record(r.Context(), RecordParams{
		Kind:           "visit",
		Source:         req.Source,
		Path:           req.Path,
		Referrer:       req.Referrer,
		IP:             httpx.ClientIP(r),
		UserAgent:      r.UserAgent(),
		AcceptLanguage: r.Header.Get("Accept-Language"),
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
		Source:         r.URL.Query().Get("s"),
		Path:           r.URL.Path,
		Referrer:       r.Header.Get("Referer"),
		IP:             httpx.ClientIP(r),
		UserAgent:      r.UserAgent(),
		AcceptLanguage: r.Header.Get("Accept-Language"),
	})
	// Fail open: the user getting the APK is more important than perfect
	// analytics. A logging error must not block the download.
	http.Redirect(w, r, h.svc.APKDownloadURL(), http.StatusFound)
}
