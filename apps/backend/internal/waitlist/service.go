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

// DeviceFromUA classifies the browser's User-Agent into the device the visitor
// is on — "ios" (iPhone/iPad/iPod), "android", or "other" (desktop/unknown).
// This is distinct from the store the visitor picked: an Android user can ask
// about the App Store. iOS is checked first since no Android UA contains those
// Apple tokens. iPadOS-as-desktop-Safari falls through to "other" — acceptable
// for a marketing signal.
func DeviceFromUA(ua string) string {
	l := strings.ToLower(ua)
	switch {
	case strings.Contains(l, "iphone"), strings.Contains(l, "ipad"), strings.Contains(l, "ipod"):
		return "ios"
	case strings.Contains(l, "android"):
		return "android"
	default:
		return "other"
	}
}

// Join records (or idempotently no-ops on) a waitlist signup. The email is
// lower-cased so casing variants collapse to one row under the UNIQUE
// (email, platform) constraint. The device is derived from the User-Agent.
func (s *Service) Join(ctx context.Context, p JoinParams) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO waitlist (email, platform, device, source, ip, user_agent, accept_language)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (email, platform) DO NOTHING
	`,
		strings.ToLower(strings.TrimSpace(p.Email)),
		p.Platform,
		DeviceFromUA(p.UserAgent),
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
