package crashreport

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// Report ingests a batch of client diagnostic items. Public + anonymous
// (mounted in the same OptionalMiddleware group as /v1/check-in) so a
// local-only install with no account can still report why it died.
func (h *Handler) Report(w http.ResponseWriter, r *http.Request) {
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "install_id must be a uuid")
		return
	}
	if len(req.Reports) == 0 {
		// Nothing to do — a no-op flush is not an error.
		httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "accepted": 0})
		return
	}
	if len(req.Reports) > 100 {
		httpx.Error(w, http.StatusBadRequest, "reports must be 1..100 items")
		return
	}
	if err := h.svc.Handle(r.Context(), req, httpx.ClientIP(r)); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "crash report failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "accepted": len(req.Reports)})
}
