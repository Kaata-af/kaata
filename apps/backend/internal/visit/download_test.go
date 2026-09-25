package visit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestDownloadRoutesToStores(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	h := NewHandler(NewService(pool, "https://kaata.af/"))
	for _, tc := range []struct {
		name, method, query, byteRange string
		status, counted                int
	}{
		{"get", "GET", "s=shop_42", "", 302, 1},
		{"head", "HEAD", "", "", 302, 0},
		{"range", "GET", "", "bytes=10-", 302, 0},
		{"beacon", "GET", "count_only=1", "", 204, 1},
		{"untrusted source", "GET", "s=" + url.QueryEscape("https://evil.invalid/?x=1&y=2"), "", 302, 1},
		{"long unicode source", "GET", "s=" + url.QueryEscape(strings.Repeat("ک", 150)), "", 302, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var before, after int
			if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM web_visits").Scan(&before); err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(tc.method, "/v1/download?"+tc.query, nil)
			r.Header.Set("Range", tc.byteRange)
			w := httptest.NewRecorder()
			h.Download(w, r)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
			if tc.status == 302 {
				target, err := url.Parse(w.Header().Get("Location"))
				if err != nil {
					t.Fatal(err)
				}
				if target.Scheme != "https" || target.Host != "kaata.af" || target.Path != "/download" {
					t.Fatalf("unsafe destination: %s", target)
				}
				if target.Query().Get("s") != truncateUTF8(r.URL.Query().Get("s"), 200) {
					t.Fatalf("source lost: %s", target)
				}
			} else if w.Header().Get("Location") != "" {
				t.Fatal("beacon redirected")
			}
			if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM web_visits").Scan(&after); err != nil {
				t.Fatal(err)
			}
			if after-before != tc.counted {
				t.Fatalf("counted %d, want %d", after-before, tc.counted)
			}
		})
	}
	// A failed analytics write must not prevent an installation/store visit.
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	w := httptest.NewRecorder()
	h.Download(w, httptest.NewRequest(http.MethodGet, "/v1/download", nil).WithContext(ctx))
	if w.Code != 302 || w.Header().Get("Location") != "https://kaata.af/download" {
		t.Fatal("analytics failure blocked redirect")
	}
}
