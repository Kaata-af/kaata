package httpx

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoggerRedactsCapabilityPathsAndQueries(t *testing.T) {
	var output bytes.Buffer
	original := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(original)
	h := Logger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, prefix := range []string{"/t/", "/v/", "/i/"} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", prefix+"private-capability?secret=private-ticket", nil))
	}
	if strings.Contains(output.String(), "private-") {
		t.Fatal("credential leaked into access log")
	}
	if strings.Count(output.String(), "[redacted]") != 3 {
		t.Fatal("missing redaction")
	}
}
