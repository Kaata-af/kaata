// Package admin serves operator-only analytics — the funnel + usage aggregates
// the backend already captures (installs, web_visits), surfaced for the admin
// dashboard (docs/backlog.md "Admin dashboard") so the operator can see the data
// without hand-writing SQL. Read-only; guarded by httpx.AdminKeyMiddleware.
package admin

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// botUARegex matches obvious non-human user agents (matched against a lowercased
// User-Agent). WhatsApp / Facebook link-preview fetchers are included on purpose:
// sharing the download link over WhatsApp triggers a preview fetch that is NOT a
// real visitor and otherwise inflates the visit count.
const botUARegex = `bot|crawl|spider|slurp|curl|wget|headless|python-requests|go-http-client|facebookexternalhit|whatsapp|preview|monitoring|uptime`

type Service struct {
	pool               *pgxpool.Pool
	operatorAccountIDs []string
	operatorIPs        []string
	now                func() time.Time
}

// NewService wires the analytics service. operatorAccountIDs / operatorIPs are
// the operator's own identifiers (config), filtered out of every aggregate so
// the dashboard reflects real users, not the dev's test devices.
func NewService(pool *pgxpool.Pool, operatorAccountIDs, operatorIPs []string) *Service {
	if operatorAccountIDs == nil {
		operatorAccountIDs = []string{}
	}
	if operatorIPs == nil {
		operatorIPs = []string{}
	}
	return &Service{pool: pool, operatorAccountIDs: operatorAccountIDs, operatorIPs: operatorIPs, now: time.Now}
}

type DayCount struct {
	Day   string `json:"day"`
	Count int64  `json:"count"`
}

type SourceRow struct {
	Source      string `json:"source"`
	Visits      int64  `json:"visits"`
	Downloads   int64  `json:"downloads"`
	StoreClicks int64  `json:"store_clicks"`
	Attributed  int64  `json:"attributed"`
	// RawVisits / Excluded mirror the headline RawVisits / ExcludedVisits, per
	// source. Without them a campaign scanned only by the operator (whose IP is
	// filtered) or only by bots reports 0/0/0/0 and is indistinguishable from a
	// QR that was never scanned at all — which is exactly how a working QR gets
	// reported as broken. Excluded counts rows of EVERY kind that the keep
	// predicate rejected.
	RawVisits int64 `json:"raw_visits"`
	Excluded  int64 `json:"excluded"`
}

type LocaleCount struct {
	Locale string `json:"locale"`
	Count  int64  `json:"count"`
}

// SeriesPoint is one time bucket of the activity series. The bucket width
// (hour/day/week/month) is chosen by the caller, so usage can be inspected at
// any granularity. Active = distinct installs that checked in, including
// signed-out/read-only sessions, exactly like DAU. Hours use Kabul-aligned
// check-in records; older date-only history remains available for wider buckets.
type SeriesPoint struct {
	T        string `json:"t"`
	Installs int64  `json:"installs"`
	Active   int64  `json:"active"`
}

// RecentInstall exposes the known install instant as well as the server's
// first observation. Device-reported clocks can be wrong; the effective
// install time is the earlier of installed_at and first_seen_at, like Users.
type RecentInstall struct {
	InstallID   string `json:"install_id"`
	Name        string `json:"name"`
	Platform    string `json:"platform"`
	InstalledAt string `json:"installed_at"`
	FirstSeenAt string `json:"first_seen_at"`
}

type Stats struct {
	// Users follow the directory's units: one non-excluded account, including
	// dormant accounts without installs, plus one non-excluded installation
	// without a proven account link. These are not deduplicated people.
	UsersTotal     int64 `json:"users_total"`
	UsersAccounts  int64 `json:"users_accounts"`
	UsersAnonymous int64 `json:"users_anonymous"`
	// Browser session credentials are collapsed by their proven account link.
	// They never enter the installation or device metrics below.
	WebAccountsTotal int64 `json:"web_accounts_total"`
	WebActive7d      int64 `json:"web_active_7d"`
	// Funnel (installs): total → onboarded → made an entry → shared → active.
	InstallsTotal  int64          `json:"installs_total"`
	DeviceEstimate DeviceEstimate `json:"device_estimate"`
	Onboarded      int64          `json:"onboarded"`
	WithEntries    int64          `json:"with_entries"`
	WithShares     int64          `json:"with_shares"`
	// Active = used a feature within the window. active_7d is the HONEST
	// headline; ever_active is the old "touched a feature ever" number (kept
	// for continuity, no longer labelled "active"). distinct_accounts is the
	// true signed-in-human count (collapses one person's many installs).
	Active7d         int64 `json:"active_7d"`
	Active30d        int64 `json:"active_30d"`
	EverActive       int64 `json:"ever_active"`
	DistinctAccounts int64 `json:"distinct_accounts"`
	// Lifetime usage sums across all (non-operator) installs.
	EntriesSum   int64 `json:"entries_sum"`
	CustomersSum int64 `json:"customers_sum"`
	SharesSum    int64 `json:"shares_sum"`
	// Web funnel — deduped per (ip, user_agent, hour) and filtered of bots +
	// operator IPs. raw_visits is the pre-dedup/pre-filter total.
	Visits    int64 `json:"visits"`
	Downloads int64 `json:"downloads"`
	// Store-badge clicks (kind 'store_click') — the post-Play-launch
	// replacement for the retired direct-APK "download" stage.
	StoreClicks int64 `json:"store_clicks"`
	RawVisits   int64 `json:"raw_visits"`
	// Signal quality: how much was removed as operator/bot noise.
	// ExcludedInstalls counts installs left out as operator or test data
	// (reportExclusionCTEs), the same set every install metric drops.
	ExcludedInstalls int64 `json:"excluded_installs"`
	ExcludedVisits   int64 `json:"excluded_visits"`
	// Engagement — from admin_active_days. Accrues from the day per-day
	// tracking deploys; 0 until then (frontend shows a "collecting since" state).
	DAU int64 `json:"dau"`
	WAU int64 `json:"wau"`
	MAU int64 `json:"mau"`
	// Day-N retention as raw eligible/retained counts — frontend divides so a
	// 0/0 window renders "—" rather than a misleading 0%.
	RetD1Eligible  int64 `json:"ret_d1_eligible"`
	RetD1Retained  int64 `json:"ret_d1_retained"`
	RetD7Eligible  int64 `json:"ret_d7_eligible"`
	RetD7Retained  int64 `json:"ret_d7_retained"`
	RetD30Eligible int64 `json:"ret_d30_eligible"`
	RetD30Retained int64 `json:"ret_d30_retained"`
	// Segmentation: installs by in-app language ('fa'/'en'/'ps'/'unknown').
	Languages []LocaleCount `json:"languages"`
	// Bucketed activity series — installs + active devices per time bucket. The
	// bucket width is the caller's granularity choice (hour/day/week/month).
	Series         []SeriesPoint   `json:"series"`
	Bucket         string          `json:"bucket"`
	Points         int             `json:"points"`
	LatestInstalls []RecentInstall `json:"latest_installs"`
	// Attribution.
	BySource []SourceRow `json:"by_source"`
	// Server "as of" timestamp (RFC3339) so the dashboard can show freshness.
	GeneratedAt string `json:"generated_at"`
	// Earlier date-only history used UTC and cannot be exactly re-bucketed.
	ActivityTimezoneSince string `json:"activity_timezone_since"`
	// Hourly activity before this instant is incomplete: migration 036 only
	// seeded the latest known check-in, not every earlier hour of that day.
	HourlyTrackingSince string `json:"hourly_tracking_since"`
	WeekStartsOn        int    `json:"week_starts_on"` // 6 = Saturday; rolling WAU remains seven days
}

// bucketSpec maps a granularity to the date_trunc field, generate_series step
// interval, and a to_char label format.
var bucketSpec = map[string]struct{ field, interval, format string }{
	"hour":  {"hour", "1 hour", `YYYY-MM-DD"T"HH24:00`},
	"day":   {"day", "1 day", "YYYY-MM-DD"},
	"week":  {"week", "1 week", "YYYY-MM-DD"},
	"month": {"month", "1 month", "YYYY-MM"},
}

// GetStats computes the dashboard aggregates. `bucket` (hour/day/week/month) +
// `points` define the activity time series window; the point-in-time KPIs
// (active_7d/30d, DAU/WAU/MAU, retention, language) use their own fixed windows.
func (s *Service) GetStats(ctx context.Context, bucket string, points int) (Stats, error) {
	now := s.now()
	spec, ok := bucketSpec[bucket]
	if !ok {
		bucket = "day"
		spec = bucketSpec["day"]
	}
	if points < 1 {
		points = 30
	}
	if points > 744 { // bound the series (e.g. 744 hourly = 31 days)
		points = 744
	}
	var st Stats
	st.Bucket = bucket
	st.Points = points
	st.WeekStartsOn = int(time.Saturday)

	// Installs funnel. `keep` = not test data (reportExclusionCTEs: operator
	// accounts in $1 and the installs/accounts excluded as test data, including
	// devices of such an account that was since deleted; signed-out installs
	// are kept unless excluded). Computed once, then every metric FILTERs on
	// it. "active" is now RECENCY-WINDOWED via last_activity_at instead of the
	// old "ever touched a feature" (which counted every reinstall of one dev
	// phone). excluded_installs reports the noise we filtered.
	// User totals and their splits share this statement's snapshot with the
	// install funnel. Reuse the directory's account resolver, without loading
	// its identities, kaatas or snapshots, so a concurrent sign-in cannot make
	// the account and anonymous counts come from different states.
	if err := s.pool.QueryRow(ctx, userReportInstalls+`, `+reportExclusionCTEs+`,
		user_counts AS (
		  SELECT
		    (SELECT COUNT(*) FROM accounts a
		     WHERE a.id::text NOT IN (SELECT id FROM report_excluded_accounts)) AS accounts,
		    (SELECT COUNT(*) FROM report_installs i
		     WHERE i.resolved_account_id IS NULL
		       AND NOT i.is_web_session
		       AND i.install_id NOT IN (SELECT install_id FROM report_excluded_installs)) AS anonymous
		), web_counts AS (
		  SELECT COUNT(DISTINCT resolved_account_id) AS accounts,
		    COUNT(DISTINCT resolved_account_id) FILTER (
		      WHERE last_seen_at >= $2::timestamptz - INTERVAL '7 days' AND last_seen_at <= $2::timestamptz) AS active_7d
		  FROM report_installs i
		  WHERE is_web_session AND resolved_account_id IS NOT NULL
		    AND resolved_account_id IN (SELECT id FROM accounts)
		    AND install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		)
		SELECT
		  (SELECT accounts + anonymous FROM user_counts),
		  (SELECT accounts FROM user_counts),
		  (SELECT anonymous FROM user_counts),
		  (SELECT accounts FROM web_counts), (SELECT active_7d FROM web_counts),
		  COUNT(*) FILTER (WHERE keep),
		  COUNT(*) FILTER (WHERE keep AND has_onboarded),
		  COUNT(*) FILTER (WHERE keep AND usage_entries_created > 0),
		  COUNT(*) FILTER (WHERE keep AND usage_shares_sent > 0),
		  COUNT(*) FILTER (WHERE keep AND last_activity_at >= NOW() - INTERVAL '7 days'),
		  COUNT(*) FILTER (WHERE keep AND last_activity_at >= NOW() - INTERVAL '30 days'),
		  COUNT(*) FILTER (WHERE keep AND last_activity_at IS NOT NULL),
		  COUNT(DISTINCT account_id) FILTER (WHERE keep AND account_id IS NOT NULL),
		  COALESCE(SUM(usage_entries_created) FILTER (WHERE keep), 0),
		  COALESCE(SUM(usage_customers_added) FILTER (WHERE keep), 0),
		  COALESCE(SUM(usage_shares_sent) FILTER (WHERE keep), 0),
		  COUNT(*) FILTER (WHERE NOT keep),
		  COUNT(*) FILTER (WHERE keep AND device_id_hash IS NOT NULL),
		  COUNT(DISTINCT (device_id_kind, device_id_hash)) FILTER (WHERE keep AND device_id_hash IS NOT NULL)
		FROM (
		  SELECT *, (install_id NOT IN (SELECT install_id FROM report_excluded_installs)) AS keep
		  FROM report_native_installs
		) i
	`, s.operatorAccountIDs, now).Scan(
		&st.UsersTotal, &st.UsersAccounts, &st.UsersAnonymous,
		&st.WebAccountsTotal, &st.WebActive7d,
		&st.InstallsTotal, &st.Onboarded, &st.WithEntries, &st.WithShares,
		&st.Active7d, &st.Active30d, &st.EverActive, &st.DistinctAccounts,
		&st.EntriesSum, &st.CustomersSum, &st.SharesSum, &st.ExcludedInstalls,
		&st.DeviceEstimate.IdentifiedInstalls, &st.DeviceEstimate.IdentifiedDevices,
	); err != nil {
		return st, err
	}
	st.DeviceEstimate.setTotalInstalls(st.InstallsTotal)

	// Web funnel. `keep` = not an operator IP ($1) and not an obvious bot ($2,
	// matched against lowercased UA). Visits/downloads are DEDUPED by
	// (ip, user_agent, hour) so 20 refreshes or re-clicks count once. raw_visits
	// + excluded_visits expose how much noise was removed.
	if err := s.pool.QueryRow(ctx, `
		WITH w AS (
		  SELECT kind, ip, user_agent, visited_at,
		         (
		           (ip IS NULL OR ip <> ALL($1::text[]))
		           AND (user_agent IS NULL OR lower(user_agent) !~ $2)
		         ) AS keep
		  FROM web_visits
		)
		SELECT
		  COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'visit'),
		  COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'download'),
		  COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'store_click'),
		  COUNT(*) FILTER (WHERE kind = 'visit'),
		  COUNT(*) FILTER (WHERE NOT keep)
		FROM w
	`, s.operatorIPs, botUARegex).Scan(&st.Visits, &st.Downloads, &st.StoreClicks, &st.RawVisits, &st.ExcludedVisits); err != nil {
		return st, err
	}

	// Compute the series AND DAU/WAU/MAU in one database snapshot, using one
	// captured time. Separate queries could disagree if a check-in or midnight
	// lands between them. "Active" means checked in, not uploaded ledger edits.
	// All new day/hour/week/month boundaries are explicitly Kabul-local.
	rows, err := s.pool.Query(ctx, `
		WITH `+installMetricCTEs+`,
		clock AS (
		  SELECT $6::timestamptz AT TIME ZONE 'Asia/Kabul' AS local_now
		), buckets AS (
		  SELECT generate_series(
		    admin_bucket_start($2, local_now) - ($4 - 1) * $3::interval,
		    admin_bucket_start($2, local_now),
		    $3::interval
		  ) AS b
		  FROM clock
		),
		ins AS (
		  SELECT admin_bucket_start($2, CASE WHEN $2 = 'hour'
		    THEN LEAST(i.installed_at, i.first_seen_at) AT TIME ZONE 'Asia/Kabul'
		    ELSE d.installed_date::timestamp END) AS b, COUNT(*) AS n
		  FROM report_native_installs i JOIN admin_install_dates d USING (install_id)
		  WHERE i.install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		    AND CASE WHEN $2 = 'hour' THEN LEAST(i.installed_at, i.first_seen_at)
		      ELSE COALESCE(i.installed_at, i.first_seen_at) END <= $6
		    AND i.first_seen_at <= $6
		  GROUP BY 1
		),
		days AS (
		  SELECT ad.install_id, ad.active_date
		  FROM report_native_active_days ad
		  WHERE ad.install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		    AND ad.active_date <= (SELECT local_now::date FROM clock)
		),
		activity AS (
		  SELECT install_id, active_date::timestamp AS at FROM days WHERE $2 <> 'hour'
		  UNION ALL
		  SELECT h.install_id, h.active_hour AT TIME ZONE 'Asia/Kabul'
		  FROM report_native_active_hours h
		  WHERE $2 = 'hour' AND h.active_hour <= $6
		    AND h.install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		),
		act AS (
		  SELECT admin_bucket_start($2, at) AS b, COUNT(DISTINCT install_id) AS n
		  FROM activity
		  GROUP BY 1
		), engagement AS (
		  SELECT
		    COUNT(DISTINCT install_id) FILTER (WHERE active_date = (SELECT local_now::date FROM clock)) AS dau,
		    COUNT(DISTINCT install_id) FILTER (WHERE active_date >= (SELECT local_now::date FROM clock) - 6) AS wau,
		    COUNT(DISTINCT install_id) FILTER (WHERE active_date >= (SELECT local_now::date FROM clock) - 29) AS mau
		  FROM days
		)
		SELECT to_char(buckets.b, $5), COALESCE(ins.n, 0), COALESCE(act.n, 0),
		       engagement.dau, engagement.wau, engagement.mau,
		       to_char(calendar.kabul_since, 'YYYY-MM-DD'), calendar.started_at
		FROM buckets
		CROSS JOIN engagement CROSS JOIN analytics_calendar calendar
		LEFT JOIN ins ON ins.b = buckets.b
		LEFT JOIN act ON act.b = buckets.b
		ORDER BY buckets.b ASC
	`, s.operatorAccountIDs, spec.field, spec.interval, points, spec.format, now)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var p SeriesPoint
		var hourlyTrackingSince time.Time
		if err := rows.Scan(&p.T, &p.Installs, &p.Active, &st.DAU, &st.WAU, &st.MAU, &st.ActivityTimezoneSince, &hourlyTrackingSince); err != nil {
			rows.Close()
			return st, err
		}
		st.HourlyTrackingSince = hourlyTrackingSince.UTC().Format(time.RFC3339Nano)
		st.Series = append(st.Series, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return st, err
	}

	// A small exact-time feed makes new installs visible without loading the
	// whole Users directory. Apply the same exclusion rules as the charts and
	// do not show installations first observed after this report's clock.
	irrows, err := s.pool.Query(ctx, `
		WITH `+installMetricCTEs+`
		SELECT i.install_id::text,
		       COALESCE(NULLIF(a.name, ''), i.self_name, ''),
		       COALESCE(i.platform, ''),
		       LEAST(i.installed_at, i.first_seen_at), i.first_seen_at
		FROM report_native_installs i LEFT JOIN accounts a ON a.id = i.account_id
		WHERE i.install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		  AND LEAST(i.installed_at, i.first_seen_at) <= $2
		  AND i.first_seen_at <= $2
		ORDER BY LEAST(i.installed_at, i.first_seen_at) DESC, i.install_id ASC
		LIMIT 10
	`, s.operatorAccountIDs, now)
	if err != nil {
		return st, err
	}
	for irrows.Next() {
		var r RecentInstall
		var installedAt, firstSeenAt time.Time
		if err := irrows.Scan(&r.InstallID, &r.Name, &r.Platform, &installedAt, &firstSeenAt); err != nil {
			irrows.Close()
			return st, err
		}
		r.InstalledAt = installedAt.UTC().Format(time.RFC3339)
		r.FirstSeenAt = firstSeenAt.UTC().Format(time.RFC3339)
		st.LatestInstalls = append(st.LatestInstalls, r)
	}
	irrows.Close()
	if err := irrows.Err(); err != nil {
		return st, err
	}

	// Day-N retention (eligible = had the chance; retained = active on exactly
	// day d0+N). Raw counts; frontend divides. Meaningful only for installs first
	// seen AFTER per-day tracking deployed.
	if err := s.pool.QueryRow(ctx, `
		WITH `+installMetricCTEs+`,
		clock AS (
		  SELECT ($2::timestamptz AT TIME ZONE 'Asia/Kabul')::date AS today
		), base AS (
		  SELECT i.install_id, d.first_seen_date AS d0
		  FROM report_native_installs i JOIN admin_install_dates d USING (install_id)
		  WHERE i.install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		)
		SELECT
		  COUNT(*) FILTER (WHERE d0 <= today - 1),
		  COUNT(*) FILTER (WHERE d0 <= today - 1  AND EXISTS (SELECT 1 FROM report_native_active_days a WHERE a.install_id = base.install_id AND a.active_date = base.d0 + 1)),
		  COUNT(*) FILTER (WHERE d0 <= today - 7),
		  COUNT(*) FILTER (WHERE d0 <= today - 7  AND EXISTS (SELECT 1 FROM report_native_active_days a WHERE a.install_id = base.install_id AND a.active_date = base.d0 + 7)),
		  COUNT(*) FILTER (WHERE d0 <= today - 30),
		  COUNT(*) FILTER (WHERE d0 <= today - 30 AND EXISTS (SELECT 1 FROM report_native_active_days a WHERE a.install_id = base.install_id AND a.active_date = base.d0 + 30))
		FROM base CROSS JOIN clock
	`, s.operatorAccountIDs, now).Scan(
		&st.RetD1Eligible, &st.RetD1Retained,
		&st.RetD7Eligible, &st.RetD7Retained,
		&st.RetD30Eligible, &st.RetD30Retained,
	); err != nil {
		return st, err
	}

	// Language split — installs by in-app language (app_locale).
	lrows, err := s.pool.Query(ctx, `
		WITH `+installMetricCTEs+`
		SELECT COALESCE(NULLIF(app_locale, ''), 'unknown') AS locale, COUNT(*)
		FROM report_native_installs
		WHERE install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		GROUP BY 1 ORDER BY 2 DESC
	`, s.operatorAccountIDs)
	if err != nil {
		return st, err
	}
	for lrows.Next() {
		var lc LocaleCount
		if err := lrows.Scan(&lc.Locale, &lc.Count); err != nil {
			lrows.Close()
			return st, err
		}
		st.Languages = append(st.Languages, lc)
	}
	lrows.Close()
	if err := lrows.Err(); err != nil {
		return st, err
	}

	// Web visits/downloads + attributed installs per source — same dedup + bot +
	// operator-IP filter as the headline web counts.
	// NOTE on the shape: `keep` is applied inside FILTER, not as a WHERE on the
	// CTE, so a source whose rows were ALL rejected still produces a group row
	// (with zeroes) rather than disappearing. That is deliberate — see
	// SourceRow.Excluded — and it is why the ordering below has to be careful.
	//
	// ORDER BY used to be a bare `2 DESC LIMIT 20`, which made a brand-new
	// campaign invisible twice over: zero kept visits sorted it last, and the
	// LIMIT then cut it off entirely once 20 sources existed. Recency is the
	// tiebreak so the QR you just scanned surfaces at the top of the zero-traffic
	// group instead of the bottom of an arbitrary list.
	//
	// The LIMIT stays (source is attacker-controllable — anyone can mint a new
	// group by hitting the site with ?s=<anything>) but at a bound no real
	// operator will reach.
	srows, err := s.pool.Query(ctx, `
		WITH `+installReportingCTEs+`, w AS (
		  SELECT COALESCE(source, '(direct)') AS source, kind, ip, user_agent, visited_at, claimed_by_install_id,
		         (
		           (ip IS NULL OR ip <> ALL($1::text[]))
		           AND (user_agent IS NULL OR lower(user_agent) !~ $2)
		         ) AS keep
		  FROM web_visits
		)
		SELECT source,
		       COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'visit') AS visits,
		       COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'download'),
		       COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'store_click'),
		       COUNT(DISTINCT claimed_by_install_id) FILTER (WHERE keep AND claimed_by_install_id IN (SELECT install_id FROM report_native_installs)),
		       COUNT(*) FILTER (WHERE kind = 'visit') AS raw_visits,
		       COUNT(*) FILTER (WHERE NOT keep) AS excluded_rows
		FROM w
		GROUP BY source
		ORDER BY visits DESC, excluded_rows DESC, MAX(visited_at) DESC
		LIMIT 100
	`, s.operatorIPs, botUARegex)
	if err != nil {
		return st, err
	}
	for srows.Next() {
		var r SourceRow
		if err := srows.Scan(&r.Source, &r.Visits, &r.Downloads, &r.StoreClicks, &r.Attributed,
			&r.RawVisits, &r.Excluded); err != nil {
			srows.Close()
			return st, err
		}
		st.BySource = append(st.BySource, r)
	}
	srows.Close()
	if err := srows.Err(); err != nil {
		return st, err
	}

	// Never emit JSON null for the slices — the dashboard expects arrays.
	if st.Series == nil {
		st.Series = []SeriesPoint{}
	}
	if st.BySource == nil {
		st.BySource = []SourceRow{}
	}
	if st.Languages == nil {
		st.Languages = []LocaleCount{}
	}
	if st.LatestInstalls == nil {
		st.LatestInstalls = []RecentInstall{}
	}
	st.GeneratedAt = now.UTC().Format(time.RFC3339)
	return st, nil
}
