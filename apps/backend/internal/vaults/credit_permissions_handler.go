package vaults

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

// MemberCreditPermissions — GET /v1/vaults/{vault_id}/credit-permissions.
func (h *Handler) MemberCreditPermissions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	rows, err := h.svc.ListMemberCreditPermissions(r.Context(), vaultID, claims.AccountID)
	if err != nil {
		writeCreditPermissionError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, rows)
}

// SetMemberCreditPermission — PUT /v1/vaults/{vault_id}/members/{account_id}/credit-permission.
func (h *Handler) SetMemberCreditPermission(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	var body struct {
		CreditLimitOverride string `json:"credit_limit_override"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || !validCreditOverride(body.CreditLimitOverride) || decoder.Decode(&struct{}{}) != io.EOF {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_credit_limit_override", "credit_limit_override must be inherit, enforce, or bypass")
		return
	}
	targetID := chi.URLParam(r, "account_id")
	if strings.HasPrefix(targetID, "local:") && body.CreditLimitOverride == "enforce" {
		writeCreditPermissionError(w, ErrCreditMemberEnrollment)
		return
	}
	if _, err := uuid.Parse(targetID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "account_id must be a uuid")
		return
	}
	saved, err := h.svc.SetMemberCreditPermission(r.Context(), vaultID, claims.AccountID, targetID, body.CreditLimitOverride)
	if err != nil {
		writeCreditPermissionError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, saved)
}

func writeCreditPermissionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidCreditOverride):
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_credit_limit_override", err.Error())
	case errors.Is(err, ErrCreditPermissionProtected):
		httpx.ErrorCode(w, http.StatusForbidden, "protected_member", err.Error())
	case errors.Is(err, ErrCreditMemberEnrollment):
		httpx.ErrorCode(w, http.StatusConflict, "member_cloud_enrollment_required", err.Error())
	default:
		writeServiceError(w, err)
	}
}
