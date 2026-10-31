package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserCreditSettingsPreflightAllowsAuthenticatedPUT(t *testing.T) {
	called := false
	handler := CORS(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	req := httptest.NewRequest(http.MethodOptions, "/v1/sync/credit-limits?vault_id=fixture", nil)
	req.Header.Set("Origin", "https://kaata.af")
	req.Header.Set("Access-Control-Request-Method", "PUT")
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type,x-kaata-currencies")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if called || response.Code != http.StatusNoContent {
		t.Fatalf("preflight reached authenticated handler: %d", response.Code)
	}
	for _, method := range []string{"GET", "POST", "PUT", "OPTIONS"} {
		if !strings.Contains(response.Header().Get("Access-Control-Allow-Methods"), method) {
			t.Fatalf("missing %s method", method)
		}
	}
	for _, header := range []string{"authorization", "content-type", "x-kaata-currencies"} {
		if !strings.Contains(strings.ToLower(response.Header().Get("Access-Control-Allow-Headers")), header) {
			t.Fatalf("missing %s header", header)
		}
	}
	if response.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Fatal("missing browser origin response")
	}
}
