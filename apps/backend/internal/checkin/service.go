package checkin

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// maxInstalledAtFutureSkew clamps a device-supplied installed_at that's
// further in the future than this. Phones with badly-set clocks are
// common; without clamping, "installed_at = year 2099" would poison the
// admin dashboard's "N days ago" math.
const maxInstalledAtFutureSkew = 5 * time.Minute

type Service struct {
	pool                *pgxpool.Pool
	migrateToBackendURL string
}

func NewService(pool *pgxpool.Pool, migrateToBackendURL string) *Service {
	return &Service{pool: pool, migrateToBackendURL: migrateToBackendURL}
}

type Request struct {
	InstallID    string `json:"install_id"`
	AppVersion   string `json:"app_version"`
	Platform     string `json:"platform"`
	DeviceLocale string `json:"device_locale"`

	// Wall-clock device timestamp from the moment the install_id was first
	// minted. Sent on every check-in; backend stores once on INSERT, never
	// overwrites. Lets us know "installed N days ago" for an install that
	// was offline at install time and only came online much later.
	InstalledAtUnixMS *int64 `json:"installed_at_unix_ms,omitempty"`

	// True once the user has created a shop profile (users.is_local_self).
	// Sent every check-in so we can flip it the first time they finish
	// onboarding without needing a "did onboard" event.
	HasOnboarded *bool `json:"has_onboarded,omitempty"`

	// Optional telemetry from the mobile v0 -> v1 migration. Mobile sends
	// these whenever the app_meta counters are present (set once when the
	// migration runs); they're stable across check-ins, so we COALESCE on
	// UPSERT instead of overwriting with NULL.
	PhonesInvalidCount  *int `json:"phones_invalid_count,omitempty"`
	PhonesConflictCount *int `json:"phones_conflict_count,omitempty"`

	// Usage counters. DELTAS since the previous successful check-in (mobile
	// resets its local counters on receiving a 2xx). Backend ADDS — never
	// overwrites — so a dropped response that triggers a retry double-counts
	// at worst by one batch, never silently loses events.
	UsageEntriesCreated *int `json:"usage_entries_created,omitempty"`
	UsageCustomersAdded *int `json:"usage_customers_added,omitempty"`
	UsageSharesSent     *int `json:"usage_shares_sent,omitempty"`
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
	// MigrateToBackendURL: when non-nil, mobile persists it and uses it for
	// all subsequent check-ins. Send an empty string to clear a previously
	// persisted override on the client. Omit (nil) to leave the client's
	// current setting alone.
	MigrateToBackendURL *string `json:"migrate_to_backend_url,omitempty"`
}

func (s *Service) Handle(ctx context.Context, req Request, clientIP string) (Response, error) {
	// Clamp installed_at against device clock skew. A timestamp more than
	// a few minutes in the future is bogus — fall back to NOW() by passing
	// nil so the SQL's COALESCE picks up the backend time.
	var installedAt *time.Time
	if req.InstalledAtUnixMS != nil && *req.InstalledAtUnixMS > 0 {
		t := time.UnixMilli(*req.InstalledAtUnixMS)
		if t.Before(time.Now().Add(maxInstalledAtFutureSkew)) {
			installedAt = &t
		}
	}

	// hadUsage drives last_activity_at: only check-ins carrying a non-zero
	// delta are "activity". Pure liveness pings (app opened, nothing done)
	// bump last_seen_at but leave last_activity_at alone.
	hadUsage := nonZero(req.UsageEntriesCreated) ||
		nonZero(req.UsageCustomersAdded) ||
		nonZero(req.UsageSharesSent)

	if _, err := s.pool.Exec(ctx, `
		INSERT INTO installs (
			install_id, app_version, platform, device_locale, check_in_count,
			migration_001_phones_invalid, migration_001_phones_conflict,
			usage_entries_created, usage_customers_added, usage_shares_sent,
			installed_at, has_onboarded, last_activity_at
		)
		VALUES (
			$1, $2, $3, $4, 1, $5, $6,
			COALESCE($7, 0), COALESCE($8, 0), COALESCE($9, 0),
			COALESCE($10, NOW()),
			COALESCE($11, FALSE),
			CASE WHEN $12::boolean THEN NOW() ELSE NULL END
		)
		ON CONFLICT (install_id) DO UPDATE
		SET last_seen_at   = NOW(),
		    app_version    = EXCLUDED.app_version,
		    platform       = EXCLUDED.platform,
		    device_locale  = EXCLUDED.device_locale,
		    check_in_count = installs.check_in_count + 1,
		    migration_001_phones_invalid  = COALESCE(EXCLUDED.migration_001_phones_invalid, installs.migration_001_phones_invalid),
		    migration_001_phones_conflict = COALESCE(EXCLUDED.migration_001_phones_conflict, installs.migration_001_phones_conflict),
		    usage_entries_created = installs.usage_entries_created + COALESCE($7, 0),
		    usage_customers_added = installs.usage_customers_added + COALESCE($8, 0),
		    usage_shares_sent     = installs.usage_shares_sent     + COALESCE($9, 0),
		    -- installed_at: COALESCE keeps the original (oldest known) value
		    -- and only fills if it's currently NULL (legacy install upgrading
		    -- to this APK for the first time after column was added).
		    installed_at  = COALESCE(installs.installed_at, EXCLUDED.installed_at),
		    -- has_onboarded latches true once set; never flips back to false.
		    has_onboarded = installs.has_onboarded OR COALESCE($11, FALSE),
		    last_activity_at = CASE
		      WHEN $12::boolean THEN NOW()
		      ELSE installs.last_activity_at
		    END
	`, req.InstallID, req.AppVersion, req.Platform, req.DeviceLocale,
		req.PhonesInvalidCount, req.PhonesConflictCount,
		req.UsageEntriesCreated, req.UsageCustomersAdded, req.UsageSharesSent,
		installedAt, req.HasOnboarded, hadUsage,
	); err != nil {
		return Response{}, err
	}

	// Deferred-deep-link attribution. On a fresh install (source still NULL),
	// look for the most recent unclaimed web_visits row from the same client
	// IP within the last hour and stamp its source onto this install. The
	// `installs.source IS NULL` guard in the final UPDATE makes this safe to
	// re-run on every check-in — subsequent calls match nothing and no-op.
	//
	// Failure here is non-fatal: a check-in must still succeed even if
	// attribution glitches, so we log and move on.
	if clientIP != "" {
		if _, err := s.pool.Exec(ctx, `
			WITH already AS (
				SELECT source FROM installs WHERE install_id = $1
			), matched AS (
				SELECT id, source FROM web_visits
				WHERE ip = $2
				  AND visited_at > NOW() - INTERVAL '60 minutes'
				  AND claimed_by_install_id IS NULL
				  AND source IS NOT NULL
				  AND (SELECT source FROM already) IS NULL
				ORDER BY visited_at DESC
				LIMIT 1
			), claim AS (
				UPDATE web_visits
				SET claimed_by_install_id = $1
				WHERE id IN (SELECT id FROM matched)
				RETURNING source
			)
			UPDATE installs
			SET source = c.source, attribution_method = 'ip_match'
			FROM claim c
			WHERE install_id = $1
		`, req.InstallID, clientIP); err != nil {
			log.Printf("attribution match failed for install %s: %v", req.InstallID, err)
		}
	}

	resp := Response{
		ServerTime:    time.Now().UTC().Format(time.RFC3339),
		LatestVersion: req.AppVersion,
	}
	if s.migrateToBackendURL != "" {
		target := s.migrateToBackendURL
		resp.MigrateToBackendURL = &target
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

func nonZero(p *int) bool {
	return p != nil && *p > 0
}

// cmpSemver compares two dotted version strings numerically.
// Missing components default to 0. Non-numeric suffixes are ignored.
func cmpSemver(a, b string) int {
	aa := strings.Split(a, ".")
	bb := strings.Split(b, ".")
	n := max(len(aa), len(bb))
	for i := range n {
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
