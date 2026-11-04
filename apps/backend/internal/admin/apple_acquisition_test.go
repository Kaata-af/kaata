package admin

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestAppleAcquisitionImportRetainsLatestRevisionAndDistinguishesMissingFromZero(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC) }
	h := httpx.AdminKeyMiddleware("test-admin-key")(http.HandlerFunc(NewHandler(svc).ImportAppleAcquisition))
	put := func(key, days string, want int) {
		t.Helper()
		r := httptest.NewRequest(http.MethodPut, "/v1/admin/acquisition/apple-downloads", strings.NewReader(`{"days":[`+days+`]}`))
		r.Header.Set("Authorization", "Bearer "+key)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("import status = %d, want %d: %s", w.Code, want, w.Body.String())
		}
	}
	const first = `{"date":"2026-10-01","processing_date":"2026-10-02","downloads":{"facebook_ads":15,"organic_posts":0}}`
	const second = `{"date":"2026-10-02","processing_date":"2026-10-03","downloads":{"facebook_ads":6,"bill_share":8}}`
	const revised = `{"date":"2026-10-02","processing_date":"2026-10-04","downloads":{}}`
	put("wrong-key", first, http.StatusUnauthorized)
	put("test-admin-key", first+","+first, http.StatusBadRequest)
	put("test-admin-key", first+`,`+`{"date":"2026-10-03","processing_date":"2026-10-04","downloads":{"unknown":1}}`, http.StatusBadRequest)
	put("test-admin-key", `{"date":"2026-10-03","processing_date":"2026-10-02","downloads":{"bill_share":1}}`, http.StatusBadRequest)
	put("test-admin-key", `{"date":"2026-10-03","processing_date":"2026-10-04","downloads":{"bill_share":null}}`, http.StatusBadRequest)
	put("test-admin-key", `{"date":"2026-10-03","processing_date":"2026-10-04","downloads":{"bill_share":2147483648}}`, http.StatusBadRequest)
	check := func(want map[string]*int64) {
		t.Helper()
		result, err := svc.getAcquisition(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range result.Sources {
			got, expected := row.AppleFirstDownloads, want[row.Source]
			if (got == nil) != (expected == nil) || (got != nil && *got != *expected) {
				t.Fatalf("%s Apple first downloads = %v, want %v", row.Source, got, expected)
			}
		}
	}
	check(nil)
	put("test-admin-key", first+","+second, http.StatusNoContent)
	zero, eight, fifteen, twentyOne := int64(0), int64(8), int64(15), int64(21)
	check(map[string]*int64{"facebook_ads": &twentyOne, "organic_posts": &zero, "bill_share": &eight})
	put("test-admin-key", revised, http.StatusNoContent)
	put("test-admin-key", second, http.StatusNoContent)
	put("test-admin-key", first, http.StatusNoContent)
	check(map[string]*int64{"facebook_ads": &fifteen, "organic_posts": &zero})
}
