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

func TestAdminGrantHTTP(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, Config{})
	now := time.Date(2027, time.January, 31, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	account := seedAccount(t, pool)
	handler := NewHandler(svc)
	router := chi.NewRouter()
	key := "synthetic-admin-key"
	router.Group(func(r chi.Router) {
		r.Use(httpx.AdminKeyMiddleware(key))
		r.Post("/v1/admin/users/{account_id}/pro/grants", handler.AdminGrant)
		r.Post("/v1/admin/users/{account_id}/pro/grants/{grant_id}/revoke", handler.AdminRevokeGrant)
	})
	request := func(suffix, auth, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/admin/users/"+account+"/pro/grants"+suffix, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+auth)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	grantID := uuid.NewString()
	grantBody := `{"operation_id":"` + grantID + `","expires_at":"2027-02-05T12:00:00Z","reason":"Courtesy"}`
	revokeURL := "/" + grantID + "/revoke"
	revokeBody := `{"operation_id":"` + uuid.NewString() + `","reason":"Courtesy ended"}`
	for _, route := range []string{"", revokeURL} {
		if res := request(route, "customer-token", "{}"); res.Code != 401 {
			t.Fatalf("grant route accepted customer credentials: %d", res.Code)
		}
	}
	if res := request("", key, grantBody+` {}`); res.Code != 400 || res.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("malformed grant request = %d %s", res.Code, res.Body.String())
	}
	if res := request("", key, strings.Replace(grantBody, "2027-02-05", "2027-01-25", 1)); res.Code != 400 || !strings.Contains(res.Body.String(), "manual_grant_invalid") {
		t.Fatalf("past expiry = %d %s", res.Code, res.Body.String())
	}
	if res := request("", key, grantBody); res.Code != 200 || res.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("grant request = %d %s", res.Code, res.Body.String())
	}
	if res := request(revokeURL, key, revokeBody); res.Code != 200 {
		t.Fatalf("revoke request = %d %s", res.Code, res.Body.String())
	}
	res := request(revokeURL, key, revokeBody)
	var retry ManualGrantResult
	if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &retry) != nil || !retry.Duplicate || retry.Grant.ID != grantID || retry.Grant.RevokedAt == nil {
		t.Fatalf("revoke retry = %d %s", res.Code, res.Body.String())
	}
}
