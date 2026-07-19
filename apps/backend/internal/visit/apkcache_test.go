package visit

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

// fakeAPK stands in for the GitHub release asset. 1 MiB of deterministic
// bytes — big enough for meaningful Range slices, small enough for CI.
func fakeAPK() []byte {
	b := make([]byte, 1<<20)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}

func upstream(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.android.package-archive")
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// warmSync runs a warm to completion for tests (warmAsync is fire-and-forget).
func warmSync(t *testing.T, c *apkCache) {
	t.Helper()
	if err := c.warm(); err != nil {
		t.Fatalf("warm: %v", err)
	}
}

func TestAPKCache_WarmAndServeFull(t *testing.T) {
	body := fakeAPK()
	src := upstream(t, body)
	c := newAPKCache(src.URL+"/kaata-9.9.9.apk", t.TempDir())
	warmSync(t, c)

	if _, name, ok := c.ready(); !ok || name != "kaata-9.9.9.apk" {
		t.Fatalf("ready() = %q,%v after warm, want kaata-9.9.9.apk,true", name, ok)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/download", nil)
	if served := c.serve(rec, req); !served {
		t.Fatal("serve() = false with a warm cache")
	}
	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if got := rec.Body.Len(); got != len(body) {
		t.Fatalf("body = %d bytes, want %d", got, len(body))
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/vnd.android.package-archive" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, "kaata-9.9.9.apk") {
		t.Errorf("Content-Disposition = %q, want the release filename", cd)
	}
	if ar := res.Header.Get("Accept-Ranges"); ar != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes (resume support is the point)", ar)
	}
}

// The reason this cache exists: a resume (Range request) must return 206
// with the exact requested slice — GitHub's expiring signed URLs made these
// fail near the end of slow downloads.
func TestAPKCache_RangeResume(t *testing.T) {
	body := fakeAPK()
	src := upstream(t, body)
	c := newAPKCache(src.URL+"/kaata-9.9.9.apk", t.TempDir())
	warmSync(t, c)

	from := len(body) - 1000 // "stuck at 99%": resume the final KB
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/download", nil)
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-", from))
	if served := c.serve(rec, req); !served {
		t.Fatal("serve() = false with a warm cache")
	}
	res := rec.Result()
	if res.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", res.StatusCode)
	}
	got := rec.Body.Bytes()
	if len(got) != 1000 {
		t.Fatalf("slice = %d bytes, want 1000", len(got))
	}
	for i, b := range got {
		if b != body[from+i] {
			t.Fatalf("slice byte %d mismatch", i)
		}
	}
}

// A lying upstream (Content-Length > delivered bytes) must never populate
// the cache — a torn APK is worse than the fallback.
func TestAPKCache_TornDownloadRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000000")
		_, _ = w.Write(make([]byte, 1000)) // then "die"
	}))
	t.Cleanup(srv.Close)
	c := newAPKCache(srv.URL+"/kaata.apk", t.TempDir())
	if err := c.warm(); err == nil {
		t.Fatal("warm succeeded on a torn download, want error")
	}
	if _, _, ok := c.ready(); ok {
		t.Fatal("torn download populated the cache")
	}
}

// Changing the source URL (a new release) re-keys the cache; warming the new
// key sweeps the old release's file.
func TestAPKCache_NewReleaseSweepsOld(t *testing.T) {
	dir := t.TempDir()
	src := upstream(t, fakeAPK())

	old := newAPKCache(src.URL+"/kaata-1.0.0.apk", dir)
	warmSync(t, old)
	next := newAPKCache(src.URL+"/kaata-1.0.1.apk", dir)
	warmSync(t, next)

	if _, _, ok := next.ready(); !ok {
		t.Fatal("new release not ready after warm")
	}
	if _, _, ok := old.ready(); ok {
		t.Fatal("old release survived the sweep")
	}
}

// Handler-level contract, cold cache + dead upstream: /v1/download must fall
// back to the 302 exactly as it always did (fail open — the phone gets the
// APK from GitHub even when the cache can't warm).
func TestDownload_ColdCacheFallsBackTo302(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, "https://example.invalid/kaata-9.9.9.apk", t.TempDir())
	h := NewHandler(svc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/download?s=test_qr", nil)
	h.Download(rec, req)
	res := rec.Result()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want 302 fallback", res.StatusCode)
	}
	if loc := res.Header.Get("Location"); loc != "https://example.invalid/kaata-9.9.9.apk" {
		t.Errorf("Location = %q", loc)
	}

	// The click was recorded despite the cold cache.
	var n int
	if err := pool.QueryRow(req.Context(), `
		SELECT COUNT(*) FROM web_visits WHERE kind = 'download' AND source = 'test_qr'
	`).Scan(&n); err != nil {
		t.Fatalf("count web_visits: %v", err)
	}
	if n != 1 {
		t.Errorf("recorded %d download rows, want 1", n)
	}
}

// Warm cache end-to-end through the handler: full body on GET, and a resume
// (Range) is served 206 WITHOUT recording a second analytics row.
func TestDownload_WarmCacheServesAndCountsOnce(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	body := fakeAPK()
	src := upstream(t, body)
	svc := NewService(pool, src.URL+"/kaata-9.9.9.apk", t.TempDir())
	h := NewHandler(svc)
	warmSync(t, svc.cache)

	rec := httptest.NewRecorder()
	h.Download(rec, httptest.NewRequest(http.MethodGet, "/v1/download?s=warm_qr", nil))
	if rec.Result().StatusCode != http.StatusOK || rec.Body.Len() != len(body) {
		t.Fatalf("full GET = %d/%d bytes, want 200/%d", rec.Result().StatusCode, rec.Body.Len(), len(body))
	}

	rec2 := httptest.NewRecorder()
	resume := httptest.NewRequest(http.MethodGet, "/v1/download?s=warm_qr", nil)
	resume.Header.Set("Range", "bytes=1000-1999")
	h.Download(rec2, resume)
	if rec2.Result().StatusCode != http.StatusPartialContent {
		t.Fatalf("resume = %d, want 206", rec2.Result().StatusCode)
	}

	// give the (synchronous in this path, but stay safe) recorder a moment
	deadline := time.Now().Add(2 * time.Second)
	for {
		var n int
		if err := pool.QueryRow(resume.Context(), `
			SELECT COUNT(*) FROM web_visits WHERE kind = 'download' AND source = 'warm_qr'
		`).Scan(&n); err != nil {
			t.Fatalf("count web_visits: %v", err)
		}
		if n == 1 || time.Now().After(deadline) {
			if n != 1 {
				t.Errorf("recorded %d download rows, want exactly 1 (resume must not double-count)", n)
			}
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// HEAD probes (download managers) must get the real headers with no body —
// and never a 405 or an analytics row. DB-free: the method guard means
// Record is never reached, so a nil pool proves the guard by construction.
func TestDownload_HeadProbeServesHeadersOnly(t *testing.T) {
	body := fakeAPK()
	src := upstream(t, body)
	svc := NewService(nil, src.URL+"/kaata-9.9.9.apk", t.TempDir())
	h := NewHandler(svc)
	warmSync(t, svc.cache)

	rec := httptest.NewRecorder()
	h.Download(rec, httptest.NewRequest(http.MethodHead, "/v1/download", nil))
	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("HEAD status = %d, want 200", res.StatusCode)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD returned %d body bytes, want 0", rec.Body.Len())
	}
	if cl := res.Header.Get("Content-Length"); cl != fmt.Sprint(len(body)) {
		t.Errorf("HEAD Content-Length = %q, want %d", cl, len(body))
	}
	if ar := res.Header.Get("Accept-Ranges"); ar != "bytes" {
		t.Errorf("HEAD Accept-Ranges = %q, want bytes", ar)
	}
}
