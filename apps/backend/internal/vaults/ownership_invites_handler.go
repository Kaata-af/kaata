package vaults

import (
	"encoding/json"
	"net/http"

	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/ownership"
)

func (h *Handler) CreateOwnershipInvite(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req struct {
		Authorization ownership.Authorization `json:"authorization"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	out, err := h.svc.CreateOwnershipInvite(r.Context(), CreateOwnershipInviteInput{AccountID: claims.AccountID, VaultID: vaultID, Authorization: req.Authorization})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, out)
}

func (h *Handler) OwnershipInviteStatus(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	out, err := h.svc.OwnershipInviteStatus(r.Context(), vaultID, claims.AccountID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"pending": out})
}

func (h *Handler) CancelOwnershipInvite(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	if err := h.svc.CancelOwnershipInvite(r.Context(), vaultID, claims.AccountID); err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"cancelled": true})
}

func (h *Handler) AcceptOwnershipInvite(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	out, err := h.svc.AcceptOwnershipInvite(r.Context(), AcceptInviteInput{AccountID: claims.AccountID, InstallID: claims.InstallID, Token: req.Token})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
