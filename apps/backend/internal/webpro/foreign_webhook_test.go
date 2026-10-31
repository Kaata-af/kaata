package webpro

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func foreignTLSTransport(t *testing.T, server *httptest.Server) *http.Transport {
	t.Helper()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	return transport
}

func relayService(t *testing.T, receiver http.Handler) (*Service, *atomic.Int64) {
	t.Helper()
	legacy := httptest.NewTLSServer(receiver)
	t.Cleanup(legacy.Close)
	var verified atomic.Int64
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verified.Add(1)
		if r.URL.Path != "/api/v1/hesab/webhooks/verify-signature" || r.Header.Get("Authorization") != "API-KEY synthetic-test-key" {
			t.Error("provider verification contract changed")
		}
		var input map[string]string
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Error("provider verification request malformed")
		}
		json.NewEncoder(w).Encode(map[string]bool{"success": input["signature"] == "valid"})
	}))
	t.Cleanup(provider.Close)
	cfg := testConfig()
	cfg.ForeignWebhookURL = "https://example.com/api/webhooks/hesabpay"
	s := NewService(nil, cfg)
	api := newHesabPay(s.cfg)
	api.baseURL = provider.URL
	api.client.Transport = provider.Client().Transport
	s.gateway = api
	s.foreignClient.Transport = foreignTLSTransport(t, legacy)
	return s, &verified
}

func rawWebhookRequest(s *Service, body []byte, token string) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	router.Post("/v1/web-pro/hesabpay/webhook/{token}", NewHandler(s).Webhook)
	req := httptest.NewRequest(http.MethodPost, "/v1/web-pro/hesabpay/webhook/"+token, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer incoming-secret")
	req.Header.Set("Cookie", "session=incoming-cookie")
	req.Header.Set("X-API-Key", "incoming-api-key")
	req.Header.Set("X-Signature", "incoming-signature-header")
	req.Header.Set("Referer", "https://api.kaata.af/private")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	return res
}

func foreignJSON(signature string, note string) []byte {
	// Legacy failure fields intentionally do not fit Kaata's strict schema.
	return []byte(fmt.Sprintf(" \n{\n  \"signature\":%q, \"timestamp\":%d, \"user_id\":987, \"success\":false, \"status_code\":\"failed\", \"transaction_id\":null, \"legacy_note\":%q\n}\n", signature, time.Now().Unix(), note))
}

func TestForeignWebhookURLConfiguration(t *testing.T) {
	for _, tc := range []struct {
		raw   string
		valid bool
	}{
		{"https://kakamalem.com/api/webhooks/hesabpay", true},
		{"http://kakamalem.com/api/webhooks/hesabpay", false},
		{"https://user:secret@kakamalem.com/api/webhooks/hesabpay", false},
		{"https://kakamalem.com:443/api/webhooks/hesabpay", false},
		{"https://127.0.0.1/api/webhooks/hesabpay", false},
		{"https://[::1]/api/webhooks/hesabpay", false},
		{"https://kakamalem.com/api/webhooks/hesabpay?key=secret", false},
		{"https://kakamalem.com/api/webhooks/hesabpay?", false},
		{"https://kakamalem.com/api/webhooks/hesabpay#fragment", false},
		{"https://api.kaata.af/v1/web-pro/hesabpay/webhook/private-token", false},
		{"https://api.kaata.af/v1%2Fweb-pro%2Fhesabpay%2Fwebhook%2Fprivate-token", false},
		{"https://api.kaata.af//v1/web-pro/hesabpay/webhook/private-token", false},
		{"https://api.kaata.af/x/../v1/web-pro/hesabpay/webhook/private-token", false},
		{"https://api.kaata.af/x/%2e%2e/v1/web-pro/hesabpay/webhook/private-token", false},
		{" https://kakamalem.com/api/webhooks/hesabpay", false},
	} {
		if got := validForeignWebhookURL(tc.raw); got != tc.valid {
			t.Errorf("destination %q = %v", tc.raw, got)
		}
		cfg := testConfig()
		cfg.ForeignWebhookURL = tc.raw
		cfg = normalizeConfig(cfg)
		if !tc.valid && (checkoutReady(cfg) || !cfg.foreignWebhookInvalid) {
			t.Error("invalid relay configuration did not fail closed")
		}
	}
	if !checkoutReady(testConfig()) {
		t.Fatal("unset optional relay disabled normal checkout")
	}
}

func TestVerifiedForeignSuccessKeepsLegacyFinancialFieldsOpaque(t *testing.T) {
	raw := []byte(fmt.Sprintf(`{"signature":"valid","timestamp":"%d","user_id":"legacy-order","success":true,"status_code":"10","transaction_id":123456,"amount":"200.00","items":"legacy-format"}`, time.Now().Unix()))
	var calls atomic.Int64
	s, _ := relayService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		got, _ := io.ReadAll(r.Body)
		if !bytes.Equal(got, raw) {
			t.Error("legacy success body changed")
		}
		w.WriteHeader(200)
	}))
	if got := rawWebhookRequest(s, raw, s.cfg.WebhookToken).Code; got != 200 || calls.Load() != 1 {
		t.Fatalf("foreign success rejected by Kaata schema: %d", got)
	}
}

func TestVerifiedForeignFailureRelaysOriginalBoundedJSONOverTLS(t *testing.T) {
	var calls atomic.Int64
	raw := foreignJSON("valid", strings.Repeat("foreign item ", 4000))
	if len(raw) <= 32768 || len(raw) >= 128*1024 {
		t.Fatal("test must cover a provider-sized body beyond the old Kaata-only limit")
	}
	s, verified := relayService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/webhooks/hesabpay" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("foreign route/body contract changed")
		}
		for _, header := range []string{"Authorization", "Cookie", "X-API-Key", "X-Signature", "Referer"} {
			if r.Header.Get(header) != "" {
				t.Errorf("forwarded private header %s", header)
			}
		}
		got, _ := io.ReadAll(r.Body)
		if !bytes.Equal(got, raw) {
			t.Error("foreign JSON was re-encoded or modified")
		}
		w.WriteHeader(200)
	}))
	if s.foreignClient.Timeout != 5*time.Second {
		t.Fatal("relay timeout is not bounded")
	}
	if got := rawWebhookRequest(s, raw, s.cfg.WebhookToken).Code; got != 200 || calls.Load() != 1 || verified.Load() != 1 {
		t.Fatalf("delivery=%d,calls=%d,verified=%d", got, calls.Load(), verified.Load())
	}
}

func TestForeignRelayRequiresVerificationAndKeepsProbesLocal(t *testing.T) {
	var calls atomic.Int64
	s, verified := relayService(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(200) }))
	if got := rawWebhookRequest(s, foreignJSON("invalid", ""), s.cfg.WebhookToken).Code; got != 400 || calls.Load() != 0 {
		t.Fatal("unverified delivery was forwarded")
	}
	if got := rawWebhookRequest(s, foreignJSON("valid", ""), strings.Repeat("b", 64)).Code; got != 404 || calls.Load() != 0 {
		t.Fatal("wrong secret callback was forwarded")
	}
	probe := map[string]any{"type": "webhook.validation", "test": true, "validation_id": uuid.NewString(), "event_type": "payment_success", "signature": "valid", "timestamp": strconv.FormatInt(time.Now().Unix(), 10)}
	body, _ := json.Marshal(probe)
	if got := rawWebhookRequest(s, body, s.cfg.WebhookToken).Code; got != 200 || calls.Load() != 0 {
		t.Fatal("validation probe was relayed")
	}
	before := verified.Load()
	if got := rawWebhookRequest(s, foreignJSON("valid", strings.Repeat("x", 128*1024)), s.cfg.WebhookToken).Code; got != 413 || calls.Load() != 0 || verified.Load() != before {
		t.Fatal("oversized callback reached provider or relay")
	}
	old := []byte(fmt.Sprintf(`{"signature":"valid","timestamp":"%d","user_id":"foreign"}`, time.Now().Add(-11*time.Minute).Unix()))
	if got := rawWebhookRequest(s, old, s.cfg.WebhookToken).Code; got != 400 || calls.Load() != 0 || verified.Load() != before {
		t.Fatal("stale callback reached provider or relay")
	}
	if got := rawWebhookRequest(s, []byte(`not-json`), s.cfg.WebhookToken).Code; got != 400 || calls.Load() != 0 {
		t.Fatal("malformed callback forwarded")
	}
}

func TestForeignRelayOnlyAcknowledgesHTTP200AndNeverFollowsRedirects(t *testing.T) {
	for _, status := range []int{200, 201, 204, 302, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			var redirected atomic.Int64
			target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { redirected.Add(1); w.WriteHeader(200) }))
			defer target.Close()
			s, _ := relayService(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if status == 302 {
					w.Header().Set("Location", target.URL)
				}
				w.WriteHeader(status)
			}))
			got := rawWebhookRequest(s, foreignJSON("valid", ""), s.cfg.WebhookToken).Code
			want := 503
			if status == 200 {
				want = 200
			}
			if got != want || redirected.Load() != 0 {
				t.Fatalf("upstream%d→%d redirectcalls%d", status, got, redirected.Load())
			}
		})
	}
}

func TestForeignRelayTimeoutAndInvalidConfigurationStayPending(t *testing.T) {
	s, _ := relayService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
		w.WriteHeader(200)
	}))
	s.foreignClient.Timeout = 50 * time.Millisecond
	if got := rawWebhookRequest(s, foreignJSON("valid", ""), s.cfg.WebhookToken).Code; got != 503 {
		t.Fatalf("timed out relay was acknowledged: %d", got)
	}
	cfg := testConfig()
	cfg.ForeignWebhookURL = "http://invalid.example/path"
	bad := NewService(nil, cfg)
	bad.gateway = &fakeGateway{}
	if got := rawWebhookRequest(bad, foreignJSON("valid", ""), bad.cfg.WebhookToken).Code; got != 503 {
		t.Fatal("invalid configured destination silently discarded a delivery")
	}
	unset := NewService(nil, testConfig())
	unset.gateway = &fakeGateway{}
	if got := rawWebhookRequest(unset, foreignJSON("valid", ""), unset.cfg.WebhookToken).Code; got != 200 {
		t.Fatal("unset optional relay changed existing foreign acknowledgement behavior")
	}
}
