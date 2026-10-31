package httpx

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebProWebhookTokenIsRedactedFromLogs(t *testing.T) {
	var captured bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&captured)
	defer log.SetOutput(previous)
	secret := strings.Repeat("synthetic-secret", 5)
	req := httptest.NewRequest(http.MethodPost, "/v1/web-pro/hesabpay/webhook/"+secret+"?private=value", nil)
	Logger(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })).ServeHTTP(httptest.NewRecorder(), req)
	if strings.Contains(captured.String(), secret) || strings.Contains(captured.String(), "private=value") {
		t.Fatal("webhook credential leaked into request logs")
	}
	if !strings.Contains(captured.String(), "/v1/web-pro/hesabpay/webhook/[redacted]") {
		t.Fatal("redacted route missing from request log")
	}
}
