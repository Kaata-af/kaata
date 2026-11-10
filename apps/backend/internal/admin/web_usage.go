package admin

import (
	"context"
	"net/http"
	"time"

	"github.com/matee/kaata-backend/internal/httpx"
)

const webUsageDays = 30

// The directory and the dashboard use the same account links and exclusions
// for browser activity. Historical heartbeats must still match both IDs, so
// rebinding an installation cannot transfer its earlier activity.
const eligibleWebInstallsCTE = `
	report_web_installs AS (
	  SELECT i.install_id, i.resolved_account_id, i.first_seen_at
	  FROM report_installs i
	  JOIN accounts a ON a.id = i.resolved_account_id
	  WHERE i.is_web_session AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
	    AND a.id::text NOT IN (SELECT id FROM report_excluded_accounts)
	    AND i.install_id NOT IN (SELECT install_id FROM report_excluded_installs)
	)`

type WebUsageDay struct {
	Day            string `json:"day"`
	ActiveAccounts *int64 `json:"active_accounts"` // null before heartbeat history began
	FirstSignIns   int64  `json:"first_sign_ins"`
	IsPartial      bool   `json:"is_partial"` // tracking began mid-day, or the day is ongoing
}

type WebUsage struct {
	GeneratedAt            string        `json:"generated_at"`
	TrackingStartedAt      string        `json:"tracking_started_at"`
	RecentAccounts         int64         `json:"recent_accounts"`
	FirstSignIns7d         int64         `json:"first_sign_ins_7d"`
	FirstSignInsPrevious7d int64         `json:"first_sign_ins_previous_7d"`
	Days                   []WebUsageDay `json:"days"`
}

func (s *Service) GetWebUsage(ctx context.Context) (WebUsage, error) {
	now := s.now().UTC()
	usage := WebUsage{GeneratedAt: now.Format(time.RFC3339Nano), Days: make([]WebUsageDay, 0, webUsageDays)}
	// First sign-ins are observable from existing browser sessions. Only the
	// dedicated history supplies active accounts by day, and the first day is
	// visibly partial when tracking starts after Kabul midnight.
	rows, err := s.pool.Query(ctx, userReportInstalls+`, `+reportExclusionCTEs+`, `+eligibleWebInstallsCTE+`,
		clock AS (
		  SELECT $2::timestamptz AS now_at, ($2::timestamptz AT TIME ZONE 'Asia/Kabul')::date AS today,
		    applied_at AS started_at, (applied_at AT TIME ZONE 'Asia/Kabul')::date AS started_day
		  FROM (SELECT (SELECT applied_at FROM schema_migrations
		    WHERE name = '097_admin_web_workspace_activity.sql') AS applied_at) t
		), dates AS (
		  SELECT clock.today - offset_days AS day
		  FROM clock CROSS JOIN generate_series(0, $3::int - 1) AS offset_days
		), first_sign_ins AS (
		  SELECT (MIN(first_seen_at) AT TIME ZONE 'Asia/Kabul')::date AS day
		  FROM report_web_installs CROSS JOIN clock
		  WHERE first_seen_at <= clock.now_at
		  GROUP BY resolved_account_id
		), first_sign_in_days AS (
		  SELECT day, COUNT(*) AS accounts FROM first_sign_ins GROUP BY day
		), activity AS (
		  SELECT d.account_id, d.active_day, d.last_seen_at
		  FROM web_workspace_days d
		  JOIN report_web_installs w ON w.install_id = d.install_id AND w.resolved_account_id = d.account_id
		  CROSS JOIN clock
		  WHERE d.active_day BETWEEN clock.today - ($3::int - 1) AND clock.today
		    AND d.last_seen_at BETWEEN clock.started_at AND clock.now_at
		), activity_days AS (
		  SELECT active_day, COUNT(DISTINCT account_id) AS accounts FROM activity GROUP BY active_day
		), recent AS (
		  SELECT COUNT(DISTINCT account_id) AS accounts FROM activity CROSS JOIN clock
		  WHERE last_seen_at >= clock.now_at - INTERVAL '5 minutes'
		)
		SELECT to_char(d.day, 'YYYY-MM-DD'),
		       CASE WHEN d.day >= c.started_day AND c.started_at <= c.now_at THEN COALESCE(a.accounts, 0) END,
		       COALESCE(f.accounts, 0),
		       COALESCE(c.started_at <= c.now_at AND d.day >= c.started_day
		         AND (d.day = c.today OR (d.day = c.started_day
		           AND c.started_at > (d.day::timestamp AT TIME ZONE 'Asia/Kabul'))), false),
		       c.started_at, r.accounts
		FROM dates d CROSS JOIN clock c CROSS JOIN recent r
		LEFT JOIN first_sign_in_days f ON f.day = d.day
		LEFT JOIN activity_days a ON a.active_day = d.day
		ORDER BY d.day
	`, s.operatorAccountIDs, now, webUsageDays)
	if err != nil {
		return WebUsage{}, err
	}
	defer rows.Close()
	var trackingStartedAt *time.Time
	for rows.Next() {
		var day WebUsageDay
		if err := rows.Scan(&day.Day, &day.ActiveAccounts, &day.FirstSignIns, &day.IsPartial,
			&trackingStartedAt, &usage.RecentAccounts); err != nil {
			return WebUsage{}, err
		}
		usage.Days = append(usage.Days, day)
	}
	if err := rows.Err(); err != nil {
		return WebUsage{}, err
	}
	if trackingStartedAt != nil {
		usage.TrackingStartedAt = trackingStartedAt.UTC().Format(time.RFC3339Nano)
	}
	for i, day := range usage.Days {
		switch {
		case i >= webUsageDays-7:
			usage.FirstSignIns7d += day.FirstSignIns
		case i >= webUsageDays-14:
			usage.FirstSignInsPrevious7d += day.FirstSignIns
		}
	}
	return usage, nil
}

// WebUsage — GET /v1/admin/web-usage. Mounted behind AdminKeyMiddleware.
func (h *Handler) WebUsage(w http.ResponseWriter, r *http.Request) {
	usage, err := h.svc.GetWebUsage(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "web usage query failed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, usage)
}
