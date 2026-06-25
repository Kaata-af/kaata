package waitlist

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/matee/kaata-backend/internal/httpx"
)

// Deliberately permissive: catches obvious garbage without rejecting valid
// addresses on a marketing form. Real validation is "we can send to it",
// which only a confirmation email proves.
var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

func normalizePlatform(p string) string {
	switch p {
	case "ios", "android", "stores":
		return p
	default:
		return "stores"
	}
}

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

type joinRequest struct {
	Email    string `json:"email"`
	Platform string `json:"platform"`
	Source   string `json:"source"`
}

// Join — POST /v1/waitlist (PUBLIC, rate-limited per IP).
//
// A visitor opts in to be emailed when the iPhone / Play Store app ships.
// Email is normalized + sanity-checked; (email, platform) is idempotent
// server-side, so a double submit is a no-op rather than a duplicate.
func (h *Handler) Join(w http.ResponseWriter, r *http.Request) {
	var req joinRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	email := strings.TrimSpace(req.Email)
	if len(email) == 0 || len(email) > 254 || !emailRe.MatchString(email) {
		httpx.Error(w, http.StatusBadRequest, "invalid email")
		return
	}
	if err := h.svc.Join(r.Context(), JoinParams{
		Email:          email,
		Platform:       normalizePlatform(req.Platform),
		Source:         req.Source,
		IP:             httpx.ClientIP(r),
		UserAgent:      r.UserAgent(),
		AcceptLanguage: r.Header.Get("Accept-Language"),
	}); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "waitlist join failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
