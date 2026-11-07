package vaults

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/matee/kaata-backend/internal/httpx"
)

// This separate route fails closed on older servers. A missing/null recipient
// can never fall through to the existing shareable-link creation behavior.
func (h *Handler) CreateAccountInvite(w http.ResponseWriter, r *http.Request) {
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
		TargetAccountID string `json:"target_account_id"`
		Role            string `json:"role"`
		ReadmitRemoved  bool   `json:"readmit_removed"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	res, err := h.svc.CreateAccountInvite(r.Context(), CreateAccountInviteInput{
		VaultID: vaultID, InviterAccID: claims.AccountID, TargetAccountID: req.TargetAccountID, Role: req.Role, ReadmitRemoved: req.ReadmitRemoved,
	})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, res)
}

func (h *Handler) AccountInviteInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	res, err := h.svc.AccountInviteInfo(r.Context(), claims.AccountID, chi.URLParam(r, "invite_id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

func (h *Handler) DeclineAccountInvite(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	if err := h.svc.DeclineAccountInvite(r.Context(), claims.AccountID, chi.URLParam(r, "invite_id")); err != nil {
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
