package webpro

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct{ svc *Service }

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

func privateResponse(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func account(w http.ResponseWriter, r *http.Request) (string, bool) {
	privateResponse(w)
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.ErrorCode(w, 401, "unauthorized", "Sign in to continue.")
		return "", false
	}
	if _, err := uuid.Parse(claims.AccountID); err != nil {
		httpx.ErrorCode(w, 401, "unauthorized", "Sign in to continue.")
		return "", false
	}
	return claims.AccountID, true
}

func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	id, ok := account(w, r)
	if !ok {
		return
	}
	status, err := h.svc.Status(r.Context(), id)
	if err != nil {
		writeError(w, err, "")
		return
	}
	httpx.JSON(w, 200, status)
}

func (h *Handler) Order(w http.ResponseWriter, r *http.Request) {
	id, ok := account(w, r)
	if !ok {
		return
	}
	order, err := h.svc.GetOrder(r.Context(), id, chi.URLParam(r, "order_id"))
	if err != nil {
		writeError(w, err, "")
		return
	}
	httpx.JSON(w, 200, order)
}

func (h *Handler) Checkout(w http.ResponseWriter, r *http.Request) {
	id, ok := account(w, r)
	if !ok {
		return
	}
	var input struct {
		PlanID         string `json:"plan_id"`
		RequestID      string `json:"request_id"`
		ReplaceOrderID string `json:"replace_order_id"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		writeError(w, ErrInvalid, "")
		return
	}
	order, err := h.svc.Checkout(r.Context(), id, input.PlanID, input.RequestID, CheckoutOptions{Origin: r.Header.Get("Origin"), ReplaceOrderID: input.ReplaceOrderID})
	if err != nil {
		writeError(w, err, order.ID)
		return
	}
	if order.CheckoutURL == nil {
		writeError(w, ErrPending, order.ID)
		return
	}
	httpx.JSON(w, 200, map[string]string{"order_id": order.ID, "checkout_url": *order.CheckoutURL})
}

func writeError(w http.ResponseWriter, err error, orderID string) {
	status, code, message := 503, "web_pro_unavailable", "Subscriptions are temporarily unavailable. Your free trial stays open."
	switch {
	case errors.Is(err, ErrInvalid):
		status, code, message = 400, "invalid_request", "Choose a valid subscription plan."
	case errors.Is(err, ErrNotFound):
		status, code, message = 404, "order_not_found", "This subscription payment was not found."
	case errors.Is(err, ErrConflict):
		status, code, message = 409, "checkout_conflict", "This checkout request has already been used. Check its payment status."
	case errors.Is(err, ErrPending):
		code, message = "checkout_pending", "This checkout is still being confirmed. Your free trial stays open."
	}
	fields := map[string]any{}
	if orderID != "" {
		fields["order_id"] = orderID
	}
	httpx.ErrorFields(w, status, code, message, fields)
}

type webhookPayment struct {
	Type          string        `json:"type"`
	Test          bool          `json:"test"`
	ValidationID  string        `json:"validation_id"`
	EventType     string        `json:"event_type"`
	Success       bool          `json:"success"`
	StatusCode    int           `json:"status_code"`
	TransactionID string        `json:"transaction_id"`
	UserID        string        `json:"user_id"`
	Amount        json.Number   `json:"amount"`
	Currency      string        `json:"currency"`
	SessionID     string        `json:"session_id"`
	Items         []paymentItem `json:"items"`
	Signature     string        `json:"signature"`
	Timestamp     string        `json:"timestamp"`
}

func (p webhookPayment) matches(order Order) bool {
	amount, ok := parseMinor(p.Amount)
	if p.Type != "" || p.Test || !p.Success || p.StatusCode != 10 || p.UserID != order.ID || !ok || amount != order.AmountMinor || order.Currency != "AFN" || (p.Currency != "" && p.Currency != "AFN") || len(p.Items) != 1 || p.TransactionID == "" || len(p.TransactionID) > 200 || strings.TrimSpace(p.TransactionID) != p.TransactionID {
		return false
	}
	item := p.Items[0]
	price, ok := parseMinor(item.Price)
	if !ok || item.ID != order.ID || item.Name != order.itemName || price != order.AmountMinor {
		return false
	}
	return p.SessionID == "" || (order.sessionID != nil && *order.sessionID == p.SessionID)
}

func (p webhookPayment) fresh(now time.Time) bool {
	if len(p.Signature) == 0 || len(p.Signature) > 4096 || len(p.Timestamp) > 12 {
		return false
	}
	stamp, err := strconv.ParseInt(p.Timestamp, 10, 64)
	if err != nil {
		return false
	}
	return stamp >= now.Add(-10*time.Minute).Unix() && stamp <= now.Add(time.Minute).Unix()
}

func (h *Handler) Webhook(w http.ResponseWriter, r *http.Request) {
	privateResponse(w)
	if h.svc.cfg.APIKey == "" || h.svc.cfg.WebhookToken == "" || subtle.ConstantTimeCompare([]byte(chi.URLParam(r, "token")), []byte(h.svc.cfg.WebhookToken)) != 1 {
		http.NotFound(w, r)
		return
	}
	var payment webhookPayment
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768))
	if decoder.Decode(&payment) != nil || decoder.Decode(new(any)) != io.EOF || !payment.fresh(h.svc.now()) {
		httpx.ErrorCode(w, 400, "invalid_webhook", "Payment notification could not be verified.")
		return
	}
	if err := h.svc.gateway.Verify(r.Context(), payment.Signature, payment.Timestamp); err != nil {
		if errors.Is(err, ErrVerification) {
			httpx.ErrorCode(w, 400, "invalid_webhook", "Payment notification could not be verified.")
		} else {
			httpx.ErrorCode(w, 503, "verification_unavailable", "Payment verification is temporarily unavailable.")
		}
		return
	}
	if payment.Type == "webhook.validation" && payment.Test {
		if _, err := uuid.Parse(payment.ValidationID); err == nil && (payment.EventType == "payment_success" || payment.EventType == "payment_failure") {
			httpx.JSON(w, 200, map[string]bool{"success": true})
			return
		}
	}
	if payment.Test || payment.Type != "" {
		httpx.ErrorCode(w, 400, "invalid_webhook", "Payment notification could not be verified.")
		return
	}
	// Failed/cancelled notifications never grant access or downgrade a payment
	// that was already fulfilled. Their signature was still checked above.
	if !payment.Success || payment.StatusCode != 10 {
		httpx.JSON(w, 200, map[string]bool{"success": true})
		return
	}
	if _, err := uuid.Parse(payment.UserID); err != nil {
		// Merchant webhooks can cover other applications using separate keys.
		// A verified foreign delivery is acknowledged without any entitlement.
		httpx.JSON(w, 200, map[string]bool{"success": true})
		return
	}
	err := h.svc.fulfill(r.Context(), payment)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.JSON(w, 200, map[string]bool{"success": true})
		} else if errors.Is(err, ErrVerification) {
			httpx.ErrorCode(w, 400, "invalid_webhook", "Payment notification could not be verified.")
		} else {
			httpx.ErrorCode(w, 503, "payment_pending", "Payment confirmation is temporarily unavailable.")
		}
		return
	}
	httpx.JSON(w, 200, map[string]bool{"success": true})
}
