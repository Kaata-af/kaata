package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecordingCapabilityIsAllowedInPreflight(t *testing.T) {
	called := false
	handler := CORS(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodOptions, "/v1/tabs", nil))
	if called || response.Code != http.StatusNoContent || !strings.Contains(response.Header().Get("Access-Control-Allow-Headers"), "X-Kaata-Tab-Recording") {
		t.Fatalf("recording preflight not supported: %d %v", response.Code, response.Header())
	}
	if !strings.Contains(response.Header().Get("Access-Control-Allow-Headers"), "X-Kaata-Tab-One-Way") {
		t.Fatal("one-way capability header is not allowed in browser preflight")
	}
	if !strings.Contains(response.Header().Get("Access-Control-Allow-Headers"), "X-Kaata-Tab-Group") {
		t.Fatal("group capability header is not allowed in browser preflight")
	}
}
