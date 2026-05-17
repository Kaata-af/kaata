package checkin

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

func (h *Handler) CheckIn(w http.ResponseWriter, r *http.Request) {
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "install_id must be a uuid")
		return
	}
	if req.AppVersion == "" || req.Platform == "" {
		httpx.Error(w, http.StatusBadRequest, "app_version and platform are required")
		return
	}

	resp, err := h.svc.Handle(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "check-in failed")
		return
	}
	httpx.JSON(w, http.StatusOK, resp)
}
