package webpro

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

func decodeAdminGrantRequest(w http.ResponseWriter, r *http.Request, input any) (string, bool) {
	privateResponse(w)
	id, err := uuid.Parse(chi.URLParam(r, "account_id"))
	if err != nil || id == uuid.Nil {
		writeAdminGrantError(w, ErrInvalid)
		return "", false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(input) != nil || decoder.Decode(new(any)) != io.EOF {
		writeAdminGrantError(w, ErrInvalid)
		return "", false
	}
	return id.String(), true
}

func (h *Handler) AdminGrant(w http.ResponseWriter, r *http.Request) {
	var input ManualGrantInput
	accountID, ok := decodeAdminGrantRequest(w, r, &input)
	if !ok {
		return
	}
	result, err := h.svc.GrantManualPro(r.Context(), accountID, input)
	if err != nil {
		writeAdminGrantError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) AdminRevokeGrant(w http.ResponseWriter, r *http.Request) {
	var input RevokeManualGrantInput
	accountID, ok := decodeAdminGrantRequest(w, r, &input)
	if !ok {
		return
	}
	result, err := h.svc.RevokeManualPro(r.Context(), accountID, chi.URLParam(r, "grant_id"), input)
	if err != nil {
		writeAdminGrantError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func writeAdminGrantError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalid):
		httpx.ErrorCode(w, http.StatusBadRequest, "manual_grant_invalid", "Check the account, grant details and reason.")
	case errors.Is(err, ErrNotFound):
		httpx.ErrorCode(w, http.StatusNotFound, "manual_grant_not_found", "This account or grant is unavailable.")
	case errors.Is(err, ErrConflict):
		httpx.ErrorCode(w, http.StatusConflict, "manual_grant_conflict", "The grant has changed or there is already an active manual grant. Refresh the account and review it again.")
	default:
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "manual_grant_unavailable", "Kaata Pro could not confirm the grant request. Retry the same request.")
	}
}
