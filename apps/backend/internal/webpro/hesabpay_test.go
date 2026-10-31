package webpro

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func testConfig() Config {
	return normalizeConfig(Config{APIKey: "synthetic-test-key", WebhookToken: strings.Repeat("a", 64), WebhookReady: true, CheckoutHosts: []string{"developers.hesab.com"}, WebBaseURL: "https://kaata.af"})
}

func TestPlansOpenTrialAndCalendarPeriods(t *testing.T) {
	if checkoutReady(Config{}) {
		t.Fatal("missing credentials enabled payments")
	}
	cfg := testConfig()
	cfg.WebhookReady = false
	if checkoutReady(cfg) {
		t.Fatal("dashboard webhook was not verified")
	}
	now := time.Date(2027, 1, 31, 15, 5, 6, 0, time.UTC)
	for _, tc := range []struct {
		start  time.Time
		months int
		want   string
	}{
		{now, 1, "2027-02-28T15:05:06Z"},
		{time.Date(2028, 1, 31, 15, 5, 6, 0, time.UTC), 1, "2028-02-29T15:05:06Z"},
		{time.Date(2028, 2, 29, 15, 5, 6, 0, time.UTC), 12, "2029-02-28T15:05:06Z"},
		{now.In(time.FixedZone("Kabul", 4*3600+30*60)), 1, "2027-02-28T15:05:06Z"},
	} {
		if got := addMonths(tc.start, tc.months).Format(time.RFC3339); got != tc.want {
			t.Fatalf("period = %s, want %s", got, tc.want)
		}
	}
	for _, until := range []*time.Time{nil, &now} {
		s := statusAt(until, false, now)
		if s.Access != "trial_open" || s.Status != "trial" {
			t.Fatalf("trial blocked: %+v", s)
		}
	}
	future := now.Add(time.Hour)
	if s := statusAt(&future, true, now); s.Status != "active" || s.Access != "trial_open" {
		t.Fatalf("active = %+v", s)
	}
	plans := Plans()
	if len(plans) != 2 || plans[0].AmountMinor != 20000 || plans[1].AmountMinor != 200000 || plans[0].Currency != "AFN" {
		t.Fatalf("wrong prices: %+v", plans)
	}
}

func TestCheckoutURLAndExactMoney(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{"https://developers.hesab.com/checkout/uuid?data=encrypted%2Bdata", true},
		{"https://DEVELOPERS.HESAB.COM:443/checkout", true},
		{"https://developers.hesab.com.evil.test/checkout", false},
		{"https://developers.hesab.com@evil.test/checkout", false},
		{"http://developers.hesab.com/checkout", false},
		{"https://developers.hesab.com:8443/checkout", false},
		{"https://developers.hesab.com/checkout#fragment", false},
		{"javascript:alert(1)", false},
	} {
		if got := validCheckoutURL(tc.raw, testConfig().CheckoutHosts); got != tc.want {
			t.Errorf("url %q = %v", tc.raw, got)
		}
	}
	for _, tc := range []struct {
		raw   string
		minor int64
		ok    bool
	}{{"200", 20000, true}, {"2000.00", 200000, true}, {"0.01", 1, true}, {"2.001", 0, false}, {"2e2", 0, false}, {"-200", 0, false}, {"0200", 0, false}, {"NaN", 0, false}} {
		got, ok := parseMinor(json.Number(tc.raw))
		if got != tc.minor || ok != tc.ok {
			t.Errorf("amount %q = %d,%v", tc.raw, got, ok)
		}
	}
}

func TestHesabPayHostedContractAndVerification(t *testing.T) {
	order := Order{ID: uuid.NewString(), AmountMinor: 20000, itemName: itemName("web_pro_monthly")}
	rawURL := "https://developers.hesab.com/checkout/" + uuid.NewString() + "?data=raw%2Bencrypted%2Fbytes"
	response := map[string]any{"success": true, "status_code": 10, "session_id": uuid.NewString(), "url": rawURL, "expires_at": time.Now().UTC().Add(15 * time.Minute).Format(time.RFC3339), "user_id": order.ID}
	verifyOK := true
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "API-KEY synthetic-test-key" {
			t.Error("missing server credential")
		}
		var input map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Error("invalid request")
		}
		switch r.URL.Path {
		case "/api/v1/payment/create-session":
			if string(input["user_id"]) != `"`+order.ID+`"` {
				t.Error("order reference missing")
			}
			if _, ok := input["currency"]; ok {
				t.Error("unsupported provider currency field")
			}
			if _, ok := input["pin"]; ok {
				t.Error("checkout must not receive a wallet PIN")
			}
			var items []paymentItem
			if json.Unmarshal(input["items"], &items) != nil || len(items) != 1 || items[0].ID != order.ID || items[0].Price.String() != "200.00" {
				t.Error("wrong exact invoice")
			}
			json.NewEncoder(w).Encode(response)
		case "/api/v1/hesab/webhooks/verify-signature":
			if string(input["signature"]) != `"sig"` || string(input["timestamp"]) != `"123"` {
				t.Error("wrong signature request")
			}
			json.NewEncoder(w).Encode(map[string]bool{"success": verifyOK})
		default:
			t.Error("unexpected path")
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	h := newHesabPay(testConfig())
	h.baseURL = server.URL
	h.client = server.Client()
	got, err := h.Create(context.Background(), order, "https://kaata.af/app/subscription?order="+order.ID)
	if err != nil || got.URL != rawURL {
		t.Fatalf("hosted response %v %v", got, err)
	}
	if err = h.Verify(context.Background(), "sig", "123"); err != nil {
		t.Fatal(err)
	}
	verifyOK = false
	if err = h.Verify(context.Background(), "sig", "123"); !errors.Is(err, ErrVerification) {
		t.Fatal("unverified signature accepted")
	}
	response["user_id"] = uuid.NewString()
	if _, err = h.Create(context.Background(), order, "https://kaata.af"); err == nil {
		t.Fatal("wrong provider order accepted")
	}
	if calls != 4 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestHesabPayRejectsRedirectsAndMalformedReplies(t *testing.T) {
	leaked := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, 307) }))
	defer server.Close()
	h := newHesabPay(testConfig())
	h.baseURL = server.URL
	if err := h.Verify(context.Background(), "sig", "123"); err == nil || leaked {
		t.Fatal("credential-bearing redirect followed")
	}
	for _, payload := range []string{"not-json", `{"success":"true"}`, strings.Repeat(" ", 65537)} {
		bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(payload)) }))
		h.baseURL = bad.URL
		if err := h.Verify(context.Background(), "sig", "123"); err == nil {
			t.Fatal("malformed verification response accepted")
		}
		bad.Close()
	}
}
