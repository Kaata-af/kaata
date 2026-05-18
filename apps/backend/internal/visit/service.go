package visit

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool   *pgxpool.Pool
	apkURL string
}

func NewService(pool *pgxpool.Pool, apkURL string) *Service {
	return &Service{pool: pool, apkURL: apkURL}
}

func (s *Service) APKDownloadURL() string { return s.apkURL }

type RecordParams struct {
	Kind           string // "visit" | "download"
	Source         string
	Path           string
	Referrer       string
	IP             string
	UserAgent      string
	AcceptLanguage string
}

func (s *Service) Record(ctx context.Context, p RecordParams) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO web_visits (kind, source, path, referrer, ip, user_agent, accept_language)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`,
		p.Kind,
		nilIfEmpty(p.Source),
		nilIfEmpty(p.Path),
		nilIfEmpty(p.Referrer),
		nilIfEmpty(p.IP),
		nilIfEmpty(p.UserAgent),
		nilIfEmpty(p.AcceptLanguage),
	)
	return err
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
