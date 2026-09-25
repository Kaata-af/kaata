package visit

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool        *pgxpool.Pool
	downloadURL string
}

// NewService keeps existing QR links working by routing them to the store page.
func NewService(pool *pgxpool.Pool, webBaseURL string) *Service {
	return &Service{pool: pool, downloadURL: strings.TrimRight(webBaseURL, "/") + "/download"}
}

func (s *Service) DownloadURL() string { return s.downloadURL }

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
