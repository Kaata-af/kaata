package backup

import (
	"encoding/json"
	"net/http"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// Upload — POST /v1/backup/upload
// Authorization: Bearer <session_jwt>
// Body: { snapshot, snapshot_version, app_version }
// Returns: { updated_at, byte_size }
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var req UploadRequest
	// MaxBytesReader bounds how much we'll read off the wire — guards
	// against an attacker streaming an unbounded body and exhausting RAM
	// before the size check in the service runs.
	r.Body = http.MaxBytesReader(w, r.Body, MaxSnapshotBytes+8192)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	resp, err := h.svc.Upload(r.Context(), claims.InstallID, claims.ProviderSub, req)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "backup upload failed: "+err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// Latest — GET /v1/backup/latest
// Authorization: Bearer <session_jwt>
// Returns: LatestResponse — fields are zero/empty if no backup exists yet.
func (h *Handler) Latest(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	resp, err := h.svc.Latest(r.Context(), claims.InstallID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "backup fetch failed")
		return
	}
	httpx.JSON(w, http.StatusOK, resp)
}
