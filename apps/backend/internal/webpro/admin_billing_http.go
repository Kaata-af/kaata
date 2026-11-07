package webpro

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

func (h *Handler) AdminListInvoices(w http.ResponseWriter, r *http.Request) {
	privateResponse(w)
	offset, err := billingOffset(r)
	if err != nil {
		writeAdminBillingError(w, err)
		return
	}
	page, err := h.svc.ListInvoices(r.Context(), chi.URLParam(r, "account_id"), offset)
	writeAdminBilling(w, page, err)
}

func (h *Handler) AdminListBillingPayments(w http.ResponseWriter, r *http.Request) {
	privateResponse(w)
	offset, err := billingOffset(r)
	if err != nil {
		writeAdminBillingError(w, err)
		return
	}
	page, err := h.svc.ListBillingPayments(r.Context(), chi.URLParam(r, "account_id"), offset)
	writeAdminBilling(w, page, err)
}

func (h *Handler) AdminIssueInvoice(w http.ResponseWriter, r *http.Request) {
	var input IssueInvoiceInput
	if !readAdminBilling(w, r, &input) {
		return
	}
	invoice, err := h.svc.IssueInvoice(r.Context(), chi.URLParam(r, "account_id"), input)
	writeAdminBilling(w, invoice, err)
}

func (h *Handler) AdminApplyInvoicePayment(w http.ResponseWriter, r *http.Request) {
	var input BillingPaymentInput
	if !readAdminBilling(w, r, &input) {
		return
	}
	invoice, err := h.svc.ApplyInvoicePayment(r.Context(), chi.URLParam(r, "account_id"), chi.URLParam(r, "invoice_id"), input)
	writeAdminBilling(w, invoice, err)
}

func (h *Handler) AdminVoidInvoice(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Reason string `json:"reason"`
	}
	if !readAdminBilling(w, r, &input) {
		return
	}
	invoice, err := h.svc.VoidInvoice(r.Context(), chi.URLParam(r, "account_id"), chi.URLParam(r, "invoice_id"), input.Reason)
	writeAdminBilling(w, invoice, err)
}

func (h *Handler) AdminIssueReceipt(w http.ResponseWriter, r *http.Request) {
	var input BillingPaymentInput
	if !readAdminBilling(w, r, &input) {
		return
	}
	receipt, err := h.svc.IssueReceipt(r.Context(), chi.URLParam(r, "account_id"), input)
	writeAdminBilling(w, receipt, err)
}

func readAdminBilling(w http.ResponseWriter, r *http.Request, input any) bool {
	privateResponse(w)
	id, err := uuid.Parse(chi.URLParam(r, "account_id"))
	if err != nil || id == uuid.Nil {
		writeAdminBillingError(w, ErrInvalid)
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	decoder.DisallowUnknownFields()
	if decoder.Decode(input) != nil || decoder.Decode(new(any)) != io.EOF {
		writeAdminBillingError(w, ErrInvalid)
		return false
	}
	return true
}

func billingOffset(r *http.Request) (int, error) {
	values := r.URL.Query()["offset"]
	if len(values) == 0 {
		return 0, nil
	}
	offset, err := strconv.ParseUint(values[0], 10, 31)
	if err != nil || len(values) != 1 {
		return 0, ErrInvalid
	}
	return int(offset), nil
}

func writeAdminBilling(w http.ResponseWriter, value any, err error) {
	if err != nil {
		writeAdminBillingError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, value)
}

func writeAdminBillingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalid):
		httpx.ErrorCode(w, http.StatusBadRequest, "pro_billing_invalid", "Check the billing details and try again.")
	case errors.Is(err, ErrNotFound):
		httpx.ErrorCode(w, http.StatusNotFound, "pro_billing_not_found", "This account, invoice or confirmed payment is unavailable.")
	case errors.Is(err, ErrConflict):
		httpx.ErrorCode(w, http.StatusConflict, "pro_billing_conflict", "This request conflicts with the current invoice or payment. Refresh and check the records.")
	default:
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "pro_billing_unavailable", "Kaata Pro could not confirm the request. Retry with the same details.")
	}
}
