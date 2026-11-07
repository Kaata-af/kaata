package webpro

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/testutil"
)

func adminBillingTestRouter(s *Service, key string) chi.Router {
	h := NewHandler(s)
	r := chi.NewRouter()
	r.Route("/v1/admin/users/{account_id}/pro", func(r chi.Router) {
		r.Use(httpx.AdminKeyMiddleware(key))
		r.Get("/invoices", h.AdminListInvoices)
		r.Get("/payments", h.AdminListBillingPayments)
		r.Post("/invoices", h.AdminIssueInvoice)
		r.Post("/invoices/{invoice_id}/apply-payment", h.AdminApplyInvoicePayment)
		r.Post("/invoices/{invoice_id}/void", h.AdminVoidInvoice)
		r.Post("/receipts", h.AdminIssueReceipt)
	})
	return r
}

func adminBillingRequest(r http.Handler, method, path, key, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)
	return response
}

func TestAdminBillingHTTPProtectsEveryRoute(t *testing.T) {
	key := "synthetic-operator-key"
	prefix := "/v1/admin/users/" + uuid.NewString() + "/pro"
	invoice := "/invoices/" + uuid.NewString()
	r := adminBillingTestRouter(nil, key)
	for _, route := range []struct{ method, suffix string }{
		{http.MethodGet, "/invoices"}, {http.MethodGet, "/payments"}, {http.MethodPost, "/invoices"},
		{http.MethodPost, invoice + "/apply-payment"}, {http.MethodPost, invoice + "/void"}, {http.MethodPost, "/receipts"},
	} {
		for _, token := range []string{"", "regular-user-token"} {
			if got := adminBillingRequest(r, route.method, prefix+route.suffix, token, "{}"); got.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s accepted a non-admin: %d", route.method, route.suffix, got.Code)
			}
		}
	}
	for _, query := range []string{"?offset=-1", "?offset=1&offset=2", "?offset=too-far"} {
		got := adminBillingRequest(r, http.MethodGet, prefix+"/payments"+query, key, "")
		if got.Code != http.StatusBadRequest || got.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("bad offset was not privately rejected: %d", got.Code)
		}
	}
	for _, body := range []string{`{"amount_minor":1}`, `{} {}`, `{"reason":"` + strings.Repeat("x", 2100) + `"}`} {
		got := adminBillingRequest(r, http.MethodPost, prefix+"/invoices", key, body)
		if got.Code != http.StatusBadRequest || got.Header().Get("Cache-Control") != "no-store" || !strings.Contains(got.Body.String(), "pro_billing_invalid") {
			t.Fatalf("invalid invoice request was not privately rejected: %d %s", got.Code, got.Body.String())
		}
	}
}

func TestAdminBillingHTTPIssuesAndListsDocuments(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	accountID := seedAccount(t, pool)
	key := "synthetic-operator-key"
	prefix := "/v1/admin/users/" + accountID + "/pro"
	s := NewService(pool, Config{})
	r := adminBillingTestRouter(s, key)
	invoiceRequest := `{"request_id":"` + uuid.NewString() + `","plan_id":"web_pro_monthly"}`
	response := adminBillingRequest(r, http.MethodPost, prefix+"/invoices", key, invoiceRequest)
	var invoice AdminInvoice
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &invoice) != nil || invoice.Status != "unpaid" || invoice.DueOn != nil ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("issue invoice response: %d %s", response.Code, response.Body.String())
	}
	response = adminBillingRequest(r, http.MethodGet, prefix+"/invoices", key, "")
	var page AdminInvoicePage
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &page) != nil || len(page.Invoices) != 1 || page.Invoices[0].ID != invoice.ID || page.NextOffset != nil {
		t.Fatalf("list invoices response: %d %s", response.Code, response.Body.String())
	}
	payment, err := s.RecordManualPayment(t.Context(), accountID, ManualPaymentInput{"web_pro_monthly", "cash", "Synthetic-Receipt-1"})
	if err != nil {
		t.Fatal(err)
	}
	paymentRequest := `{"payment_id":"` + payment.Payment.PaymentID + `","payment_source":"manual"}`
	response = adminBillingRequest(r, http.MethodPost, prefix+"/receipts", key, paymentRequest)
	var receipt AdminReceipt
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &receipt) != nil || !billingNumberMatchesID(receipt.Number, "KPRO-R-", receipt.ID) || receipt.Payment.PaymentID != payment.Payment.PaymentID {
		t.Fatalf("issue receipt response: %d %s", response.Code, response.Body.String())
	}
	response = adminBillingRequest(r, http.MethodPost, prefix+"/invoices/"+invoice.ID+"/apply-payment", key, paymentRequest)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &invoice) != nil || invoice.Status != "paid" {
		t.Fatalf("apply payment response: %d %s", response.Code, response.Body.String())
	}
}
