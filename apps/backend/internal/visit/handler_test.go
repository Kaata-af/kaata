package visit

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

// POST /v1/visit — kind handling: the classic session beacon (kind omitted
// or "visit"), the store-badge click beacon (kind "store_click" + detail
// "play"/"appstore"), and the rejections (unknown kinds must 400 before
// they can hit the DB CHECK constraint; 'download' stays server-stamped
// by /v1/download only).
func TestVisitHandlerKinds(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	h := NewHandler(NewService(pool, "http://example.invalid/kaata.apk", t.TempDir()))

	post := func(t *testing.T, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/v1/visit", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.Visit(w, req)
		return w
	}

	type row struct {
		kind, source, detail string
	}
	lastRow := func(t *testing.T) row {
		t.Helper()
		var r row
		var source, detail *string
		if err := pool.QueryRow(t.Context(), `
			SELECT kind, source, detail FROM web_visits ORDER BY id DESC LIMIT 1
		`).Scan(&r.kind, &source, &detail); err != nil {
			t.Fatalf("read last web_visits row: %v", err)
		}
		if source != nil {
			r.source = *source
		}
		if detail != nil {
			r.detail = *detail
		}
		return r
	}

	t.Run("store_click stored with detail and source", func(t *testing.T) {
		w := post(t, `{"kind":"store_click","detail":"play","source":"shop_42","path":"/download"}`)
		if w.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204 (body %q)", w.Code, w.Body.String())
		}
		got := lastRow(t)
		if got != (row{kind: "store_click", source: "shop_42", detail: "play"}) {
			t.Fatalf("stored row = %+v", got)
		}
	})

	t.Run("store_click appstore", func(t *testing.T) {
		w := post(t, `{"kind":"store_click","detail":"appstore"}`)
		if w.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", w.Code)
		}
		if got := lastRow(t); got.kind != "store_click" || got.detail != "appstore" {
			t.Fatalf("stored row = %+v", got)
		}
	})

	t.Run("store_click unknown detail dropped, click still counted", func(t *testing.T) {
		w := post(t, `{"kind":"store_click","detail":"microsoft_store"}`)
		if w.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", w.Code)
		}
		if got := lastRow(t); got.kind != "store_click" || got.detail != "" {
			t.Fatalf("stored row = %+v, want store_click with NULL detail", got)
		}
	})

	t.Run("kind omitted defaults to visit", func(t *testing.T) {
		w := post(t, `{"source":"shop_42","path":"/"}`)
		if w.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", w.Code)
		}
		if got := lastRow(t); got.kind != "visit" || got.detail != "" {
			t.Fatalf("stored row = %+v, want plain visit", got)
		}
	})

	t.Run("unknown kind rejected", func(t *testing.T) {
		for _, kind := range []string{"download", "install", "'); DROP TABLE web_visits;--"} {
			w := post(t, `{"kind":"`+kind+`"}`)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("kind %q: status = %d, want 400", kind, w.Code)
			}
		}
	})
}
