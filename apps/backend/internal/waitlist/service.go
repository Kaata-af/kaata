package waitlist

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

type JoinParams struct {
	Email          string // already validated by the handler
	Platform       string // "ios" | "android" | "stores"
	Source         string
	IP             string
	UserAgent      string
	AcceptLanguage string
}

// Join records (or idempotently no-ops on) a waitlist signup. The email is
// lower-cased so casing variants collapse to one row under the UNIQUE
// (email, platform) constraint.
func (s *Service) Join(ctx context.Context, p JoinParams) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO waitlist (email, platform, source, ip, user_agent, accept_language)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (email, platform) DO NOTHING
	`,
		strings.ToLower(strings.TrimSpace(p.Email)),
		p.Platform,
		nilIfEmpty(p.Source),
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
