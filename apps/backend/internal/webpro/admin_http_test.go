package webpro

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/testutil"
)

func adminProRouter(s *Service, key string) chi.Router {
	h := NewHandler(s)
	r := chi.NewRouter()
	r.Group(func(r chi.Router) {
		r.Use(httpx.AdminKeyMiddleware(key))
		r.Get("/v1/admin/users/{account_id}/pro", h.AdminStatus)
		r.Post("/v1/admin/users/{account_id}/pro", h.AdminRecordPayment)
	})
	return r
}

func adminProRequest(r http.Handler, method, accountID, key, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/v1/admin/users/"+accountID+"/pro", strings.NewReader(body))
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res := httptest.NewRecorder()
	r.ServeHTTP(res, req)
	return res
}

func TestManualPaymentHTTPRejectsUnauthenticatedAndInvalidRequests(t *testing.T) {
	key := "synthetic-admin-key"
	id := uuid.NewString()
	r := adminProRouter(nil, key)
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		if got := adminProRequest(r, method, id, "normal-session-token", "{}"); got.Code != 401 {
			t.Fatalf("%s accepted a regular session: %d", method, got.Code)
		}
		if got := adminProRequest(adminProRouter(nil, ""), method, id, key, "{}"); got.Code != 404 {
			t.Fatalf("%s exposed disabled operator route: %d", method, got.Code)
		}
		if got := adminProRequest(r, method, "not-an-account", key, "{}"); got.Code != 400 {
			t.Fatalf("%s accepted invalid account ID: %d", method, got.Code)
		}
	}
	for _, body := range []string{
		`{"plan_id":"web_pro_monthly","method":"cash","reference":"CASH-1","amount_minor":1}`,
		`{"plan_id":"web_pro_monthly","method":"cash","reference":"CASH-1"} {}`,
		`{"reference":"` + strings.Repeat("x", 2100) + `"}`,
	} {
		if got := adminProRequest(r, http.MethodPost, id, key, body); got.Code != 400 || got.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid payment request was not privately rejected: %d", got.Code)
		}
	}
}

func TestAdminManualPaymentActivatesCustomerStatusWithoutCheckout(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	s := NewService(pool, Config{})
	s.now = func() time.Time { return time.Date(2026, 1, 31, 10, 0, 0, 0, time.UTC) }
	id := seedAccount(t, pool)
	key := "synthetic-admin-key"
	r := adminProRouter(s, key)
	request := `{"plan_id":"web_pro_monthly","method":"cash","reference":"CASH-1042"}`
	res := adminProRequest(r, http.MethodPost, id, key, request)
	if res.Code != 200 || res.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("record payment: %d %s", res.Code, res.Body.String())
	}
	want := time.Date(2026, 2, 28, 10, 0, 0, 0, time.UTC)
	status, err := s.Status(t.Context(), id)
	if err != nil || status.Status != "active" || status.Access != "trial_open" || status.CheckoutReady || status.SubscriptionExpiresAt == nil || !status.SubscriptionExpiresAt.Equal(want) {
		t.Fatalf("unexpected customer status: %+v, %v", status, err)
	}
	res = adminProRequest(r, http.MethodGet, id, key, "")
	var view AdminSubscription
	if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &view) != nil || view.Status != "active" || len(view.Payments) != 1 || view.Payments[0].Method != "cash" || view.Payments[0].AmountMinor != 20_000 {
		t.Fatalf("incorrect operator history: %d %s", res.Code, res.Body.String())
	}
	conflicting := strings.Replace(request, "web_pro_monthly", "web_pro_yearly", 1)
	if res = adminProRequest(r, http.MethodPost, id, key, conflicting); res.Code != 409 || !strings.Contains(res.Body.String(), "manual_payment_conflict") {
		t.Fatalf("payment conflict not reported: %d %s", res.Code, res.Body.String())
	}
}
