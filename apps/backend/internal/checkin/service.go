package checkin

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

type Request struct {
	InstallID    string `json:"install_id"`
	AppVersion   string `json:"app_version"`
	Platform     string `json:"platform"`
	DeviceLocale string `json:"device_locale"`

	// Optional telemetry from the mobile v0 -> v1 migration. Mobile sends
	// these whenever the app_meta counters are present (set once when the
	// migration runs); they're stable across check-ins, so we COALESCE on
	// UPSERT instead of overwriting with NULL.
	PhonesInvalidCount  *int `json:"phones_invalid_count,omitempty"`
	PhonesConflictCount *int `json:"phones_conflict_count,omitempty"`
}

type UpdateInfo struct {
	Version      string  `json:"version"`
	APKURL       *string `json:"apk_url"`
	PlayStoreURL *string `json:"play_store_url"`
	ReleaseNotes *string `json:"release_notes"`
}

type Announcement struct {
	ID       int     `json:"id"`
	Title    string  `json:"title"`
	Body     string  `json:"body"`
	CTALabel *string `json:"cta_label"`
	CTAURL   *string `json:"cta_url"`
}

type Response struct {
	ServerTime    string        `json:"server_time"`
	LatestVersion string        `json:"latest_version"`
	ForceUpdate   bool          `json:"force_update"`
	Update        *UpdateInfo   `json:"update"`
	Announcement  *Announcement `json:"announcement"`
}

func (s *Service) Handle(ctx context.Context, req Request) (Response, error) {
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO installs (
			install_id, app_version, platform, device_locale, check_in_count,
			migration_001_phones_invalid, migration_001_phones_conflict
		)
		VALUES ($1, $2, $3, $4, 1, $5, $6)
		ON CONFLICT (install_id) DO UPDATE
		SET last_seen_at   = NOW(),
		    app_version    = EXCLUDED.app_version,
		    platform       = EXCLUDED.platform,
		    device_locale  = EXCLUDED.device_locale,
		    check_in_count = installs.check_in_count + 1,
		    migration_001_phones_invalid  = COALESCE(EXCLUDED.migration_001_phones_invalid, installs.migration_001_phones_invalid),
		    migration_001_phones_conflict = COALESCE(EXCLUDED.migration_001_phones_conflict, installs.migration_001_phones_conflict)
	`, req.InstallID, req.AppVersion, req.Platform, req.DeviceLocale,
		req.PhonesInvalidCount, req.PhonesConflictCount); err != nil {
		return Response{}, err
	}

	resp := Response{
		ServerTime:    time.Now().UTC().Format(time.RFC3339),
		LatestVersion: req.AppVersion,
	}

	var (
		version, minSupported       string
		apkURL, playStoreURL, notes sql.NullString
	)
	err := s.pool.QueryRow(ctx, `
		SELECT version, min_supported_version, apk_url, play_store_url, release_notes
		FROM app_releases
		WHERE platform = $1 AND is_active = TRUE
		ORDER BY published_at DESC
		LIMIT 1
	`, req.Platform).Scan(&version, &minSupported, &apkURL, &playStoreURL, &notes)
	switch {
	case err == nil:
		resp.LatestVersion = version
		if cmpSemver(req.AppVersion, minSupported) < 0 {
			resp.ForceUpdate = true
		}
		if cmpSemver(req.AppVersion, version) < 0 {
			resp.Update = &UpdateInfo{
				Version:      version,
				APKURL:       nullStr(apkURL),
				PlayStoreURL: nullStr(playStoreURL),
				ReleaseNotes: nullStr(notes),
			}
		}
	case errors.Is(err, pgx.ErrNoRows):
		// no release configured — leave defaults
	default:
		return Response{}, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, title, body, cta_label, cta_url, min_app_version, max_app_version
		FROM announcements
		WHERE is_active = TRUE
		  AND (expires_at IS NULL OR expires_at > NOW())
		ORDER BY published_at DESC
	`)
	if err != nil {
		return Response{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id                     int
			title, body            string
			ctaLabel, ctaURL       sql.NullString
			minVersion, maxVersion sql.NullString
		)
		if err := rows.Scan(&id, &title, &body, &ctaLabel, &ctaURL, &minVersion, &maxVersion); err != nil {
			return Response{}, err
		}
		if minVersion.Valid && cmpSemver(req.AppVersion, minVersion.String) < 0 {
			continue
		}
		if maxVersion.Valid && cmpSemver(req.AppVersion, maxVersion.String) > 0 {
			continue
		}
		resp.Announcement = &Announcement{
			ID:       id,
			Title:    title,
			Body:     body,
			CTALabel: nullStr(ctaLabel),
			CTAURL:   nullStr(ctaURL),
		}
		break
	}
	if err := rows.Err(); err != nil {
		return Response{}, err
	}

	return resp, nil
}

func nullStr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

// cmpSemver compares two dotted version strings numerically.
// Missing components default to 0. Non-numeric suffixes are ignored.
func cmpSemver(a, b string) int {
	aa := strings.Split(a, ".")
	bb := strings.Split(b, ".")
	n := len(aa)
	if len(bb) > n {
		n = len(bb)
	}
	for i := 0; i < n; i++ {
		var ai, bi int
		if i < len(aa) {
			ai, _ = strconv.Atoi(stripNonDigits(aa[i]))
		}
		if i < len(bb) {
			bi, _ = strconv.Atoi(stripNonDigits(bb[i]))
		}
		if ai < bi {
			return -1
		}
		if ai > bi {
			return 1
		}
	}
	return 0
}

func stripNonDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
