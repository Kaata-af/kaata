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

// AdminStatus and AdminRecordPayment are mounted only in the operator group.
func (h *Handler) AdminStatus(w http.ResponseWriter, r *http.Request) {
	privateResponse(w)
	id, err := uuid.Parse(chi.URLParam(r, "account_id"))
	if err != nil || id == uuid.Nil {
		writeAdminProError(w, ErrInvalid)
		return
	}
	status, err := h.svc.AdminSubscription(r.Context(), id.String())
	if err != nil {
		writeAdminProError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, status)
}

func (h *Handler) AdminRecordPayment(w http.ResponseWriter, r *http.Request) {
	privateResponse(w)
	id, err := uuid.Parse(chi.URLParam(r, "account_id"))
	if err != nil || id == uuid.Nil {
		writeAdminProError(w, ErrInvalid)
		return
	}
	var input ManualPaymentInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		writeAdminProError(w, ErrInvalid)
		return
	}
	payment, err := h.svc.RecordManualPayment(r.Context(), id.String(), input)
	if err != nil {
		writeAdminProError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, payment)
}

func writeAdminProError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalid):
		httpx.ErrorCode(w, http.StatusBadRequest, "manual_payment_invalid", "Check the account, plan, payment method and reference.")
	case errors.Is(err, ErrNotFound):
		httpx.ErrorCode(w, http.StatusNotFound, "account_not_found", "This account is unavailable.")
	case errors.Is(err, ErrConflict):
		httpx.ErrorCode(w, http.StatusConflict, "manual_payment_conflict", "This payment reference has already been used. Check the receipt before trying again.")
	default:
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "manual_payment_unavailable", "Kaata Pro could not confirm the request. Use the same reference when retrying a payment.")
	}
}
