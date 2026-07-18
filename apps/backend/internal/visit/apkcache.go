package visit

// APK disk cache — makes /v1/download serve the APK bytes ITSELF instead of
// bouncing every phone to GitHub's release-asset CDN.
//
// WHY (2026-07-18, "download stuck at the end" on Android): GitHub release
// assets redirect to release-assets.githubusercontent.com URLs that are
// SIGNED AND EXPIRE (~1 hour). A ~100 MB APK on the slow, flaky connections
// this audience lives on takes long enough — and gets interrupted often
// enough — that the browser's resume (a Range request against the SAME
// URL) lands after expiry, gets refused, and the download wedges at 99%.
// Serving from our own disk with http.ServeContent gives clients a stable
// URL with correct Content-Length / Accept-Ranges / If-Range semantics:
// resumable forever, no third-party expiry, and every byte served from the
// same origin the QR attribution already points at.
//
// DESIGN — lazy, self-healing, zero-regression:
//   - The cache warms from APK_DOWNLOAD_URL (GitHub stays the source of
//     truth; the release playbook doesn't change). Warm runs at startup
//     and, if that failed, retries lazily on demand — single-flight, with a
//     cooldown so a dead upstream isn't hammered.
//   - Until the cache is warm, Download() falls back to the 302 exactly as
//     before. The endpoint can only ever be BETTER than the old behavior.
//   - The cache key embeds a hash of the source URL: pointing
//     APK_DOWNLOAD_URL at a new release invalidates the old file
//     automatically on the next deploy (stale entries in the dir are
//     removed on warm).
//   - Downloads land in a temp file and are RENAMED into place only after
//     the byte count matches upstream's Content-Length — a torn download
//     can never be served.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// warmRetryCooldown bounds how often a FAILED warm may retry when download
// requests keep arriving. Requests during the cooldown just take the 302
// fallback.
const warmRetryCooldown = time.Minute

// warmHTTPTimeout bounds one warm attempt end-to-end. Generous: the server
// sits in a datacenter and pulls ~100 MB from GitHub's CDN in seconds; if it
// genuinely takes 10 minutes something is wrong and the attempt should die.
const warmHTTPTimeout = 10 * time.Minute

type apkCache struct {
	srcURL string
	dir    string

	mu          sync.Mutex
	warming     bool
	lastAttempt time.Time
}

func newAPKCache(srcURL, dir string) *apkCache {
	return &apkCache{srcURL: srcURL, dir: dir}
}

// cachePath is the deterministic on-disk location for the CURRENT source
// URL: <dir>/<sha256(url)[:12]>-<basename>. The hash prefix invalidates on
// any URL change; the basename keeps the file recognizable in `ls` and is
// reused as the download filename.
func (c *apkCache) cachePath() string {
	sum := sha256.Sum256([]byte(c.srcURL))
	return filepath.Join(c.dir, hex.EncodeToString(sum[:6])+"-"+c.fileName())
}

// fileName derives the client-facing filename from the source URL's last
// path segment, falling back to a constant when the URL is unparseable or
// bare. Query strings never leak into it.
func (c *apkCache) fileName() string {
	if u, err := url.Parse(c.srcURL); err == nil {
		if base := path.Base(u.Path); base != "" && base != "." && base != "/" {
			return base
		}
	}
	return "kaata.apk"
}

// ready returns the cached file's path + name when a fully-downloaded copy
// exists. Cheap (one stat) — called per request.
func (c *apkCache) ready() (filePath, name string, ok bool) {
	p := c.cachePath()
	if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Size() > 0 {
		return p, c.fileName(), true
	}
	return "", "", false
}

// warmAsync kicks a background warm unless one is already running or the
// last failure is inside the cooldown. Never blocks the caller.
func (c *apkCache) warmAsync() {
	c.mu.Lock()
	if c.warming || time.Since(c.lastAttempt) < warmRetryCooldown {
		c.mu.Unlock()
		return
	}
	c.warming = true
	c.lastAttempt = time.Now()
	c.mu.Unlock()

	go func() {
		defer func() {
			c.mu.Lock()
			c.warming = false
			c.mu.Unlock()
		}()
		if err := c.warm(); err != nil {
			log.Printf("visit.apkcache: warm failed (serving 302 fallback meanwhile): %v", err)
		}
	}()
}

// warm downloads the APK from srcURL into the cache. Verifies the byte
// count against upstream's Content-Length before the atomic rename, and
// sweeps stale cache entries (previous releases) afterwards.
func (c *apkCache) warm() error {
	if _, _, ok := c.ready(); ok {
		return nil
	}
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return fmt.Errorf("mkdir cache dir: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), warmHTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.srcURL, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("fetch %s: %w", c.srcURL, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch %s: status %d", c.srcURL, res.StatusCode)
	}

	tmp, err := os.CreateTemp(c.dir, "warm-*.part")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after successful rename

	n, err := io.Copy(tmp, res.Body)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("download body: %w", err)
	}
	if res.ContentLength > 0 && n != res.ContentLength {
		return fmt.Errorf("torn download: got %d of %d bytes", n, res.ContentLength)
	}
	if n == 0 {
		return fmt.Errorf("empty body from %s", c.srcURL)
	}
	if err := os.Rename(tmpName, c.cachePath()); err != nil {
		return fmt.Errorf("rename into cache: %w", err)
	}
	log.Printf("visit.apkcache: warmed %s (%d bytes) from %s", c.fileName(), n, c.srcURL)

	// Sweep entries from previous source URLs (old releases) — best-effort.
	current := filepath.Base(c.cachePath())
	if entries, err := os.ReadDir(c.dir); err == nil {
		for _, e := range entries {
			name := e.Name()
			if name == current || strings.HasPrefix(name, "warm-") {
				continue
			}
			_ = os.Remove(filepath.Join(c.dir, name))
		}
	}
	return nil
}

// serve writes the cached APK with full Range/If-Range/HEAD semantics via
// http.ServeContent. Returns false when the cache isn't ready (caller falls
// back to the 302) — including the race where the file was swept between
// ready() and Open.
func (c *apkCache) serve(w http.ResponseWriter, r *http.Request) bool {
	p, name, ok := c.ready()
	if !ok {
		return false
	}
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", `attachment; filename=`+name)
	// Immutable per cache key: a new release changes the URL hash, so a
	// client/proxy may cache aggressively without ever serving a stale APK
	// version under a different filename.
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeContent(w, r, name, fi.ModTime(), f)
	return true
}
