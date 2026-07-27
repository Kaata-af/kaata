package visit

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool   *pgxpool.Pool
	apkURL string
	cache  *apkCache
}

// NewService wires the visit recorder + the local APK cache. cacheDir is
// where /v1/download keeps its resumable local copy of the APK (see
// apkcache.go); the cache warms lazily from apkURL and the endpoint serves
// the 302 fallback until it is ready.
func NewService(pool *pgxpool.Pool, apkURL, cacheDir string) *Service {
	return &Service{
		pool:   pool,
		apkURL: apkURL,
		cache:  newAPKCache(apkURL, cacheDir),
	}
}

func (s *Service) APKDownloadURL() string { return s.apkURL }

// WarmAPKCache kicks the background cache warm. Called once at startup
// (main.go) so the first phone to download never pays the fallback, and
// again on demand from the handler if the startup warm failed.
func (s *Service) WarmAPKCache() { s.cache.warmAsync() }

// ServeAPK writes the cached APK (Range-capable, non-expiring) and returns
// true, or returns false when the cache isn't warm yet — the caller then
// 302s to APKDownloadURL exactly as the endpoint always did.
func (s *Service) ServeAPK(w http.ResponseWriter, r *http.Request) bool {
	if ok := s.cache.serve(w, r); ok {
		return true
	}
	s.cache.warmAsync()
	return false
}

type RecordParams struct {
	Kind           string // "visit" | "download" | "store_click"
	Source         string
	Path           string
	Referrer       string
	IP             string
	UserAgent      string
	AcceptLanguage string
	Detail         string // kind-specific payload; for store_click: "play" | "appstore"
}

func (s *Service) Record(ctx context.Context, p RecordParams) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO web_visits (kind, source, path, referrer, ip, user_agent, accept_language, detail)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`,
		p.Kind,
		nilIfEmpty(p.Source),
		nilIfEmpty(p.Path),
		nilIfEmpty(p.Referrer),
		nilIfEmpty(p.IP),
		nilIfEmpty(p.UserAgent),
		nilIfEmpty(p.AcceptLanguage),
		nilIfEmpty(p.Detail),
	)
	return err
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
