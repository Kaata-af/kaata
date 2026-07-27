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
	return &Service{pool: pool, operatorAccountIDs: operatorAccountIDs, operatorIPs: operatorIPs}
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
}

type LocaleCount struct {
	Locale string `json:"locale"`
	Count  int64  `json:"count"`
}

// SeriesPoint is one time bucket of the activity series. The bucket width
// (hour/day/week/month) is chosen by the caller, so usage can be inspected at
// any granularity. Active = distinct devices with ledger activity in the bucket
// (from events.server_received_at, which has the timestamp precision
// install_active_days — date-only — lacks).
type SeriesPoint struct {
	T        string `json:"t"`
	Installs int64  `json:"installs"`
	Active   int64  `json:"active"`
}

type Stats struct {
	// Funnel (installs): total → onboarded → made an entry → shared → active.
	InstallsTotal int64 `json:"installs_total"`
	Onboarded     int64 `json:"onboarded"`
	WithEntries   int64 `json:"with_entries"`
	WithShares    int64 `json:"with_shares"`
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
	ExcludedInstalls int64 `json:"excluded_installs"`
	ExcludedVisits   int64 `json:"excluded_visits"`
	// Engagement — from install_active_days. Accrues from the day per-day
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
	// Segmentation: installs by in-app language ('fa'/'en'/'unknown').
	Languages []LocaleCount `json:"languages"`
	// Bucketed activity series — installs + active devices per time bucket. The
	// bucket width is the caller's granularity choice (hour/day/week/month).
	Series []SeriesPoint `json:"series"`
	Bucket string        `json:"bucket"`
	Points int           `json:"points"`
	// Attribution.
	BySource []SourceRow `json:"by_source"`
	// Server "as of" timestamp (RFC3339) so the dashboard can show freshness.
	GeneratedAt string `json:"generated_at"`
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

	// Installs funnel. `keep` = NOT an operator install (operator account_ids in
	// $1; NULL-account local-only installs are kept). Computed once, then every
	// metric FILTERs on it. "active" is now RECENCY-WINDOWED via last_activity_at
	// instead of the old "ever touched a feature" (which counted every reinstall
	// of one dev phone). excluded_installs reports the noise we filtered.
	if err := s.pool.QueryRow(ctx, `
		SELECT
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
		  COUNT(*) FILTER (WHERE NOT keep)
		FROM (
		  SELECT *, (account_id IS NULL OR account_id::text <> ALL($1::text[])) AS keep
		  FROM installs
		) i
	`, s.operatorAccountIDs).Scan(
		&st.InstallsTotal, &st.Onboarded, &st.WithEntries, &st.WithShares,
		&st.Active7d, &st.Active30d, &st.EverActive, &st.DistinctAccounts,
		&st.EntriesSum, &st.CustomersSum, &st.SharesSum, &st.ExcludedInstalls,
	); err != nil {
		return st, err
	}

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

	// Activity series — new installs + distinct active devices per time BUCKET
	// (granularity from $2 date_trunc field / $3 step interval / $5 label fmt),
	// dense + zero-filled + ascending. Installs come from installs.installed_at;
	// "active" comes from events.server_received_at (full timestamp precision —
	// install_active_days is date-only, so events are what make HOURLY possible).
	// Operator excluded on both.
	rows, err := s.pool.Query(ctx, `
		WITH buckets AS (
		  SELECT generate_series(
		    date_trunc($2, NOW() AT TIME ZONE 'UTC') - ($4 - 1) * $3::interval,
		    date_trunc($2, NOW() AT TIME ZONE 'UTC'),
		    $3::interval
		  ) AS b
		),
		ins AS (
		  SELECT date_trunc($2, COALESCE(installed_at, first_seen_at) AT TIME ZONE 'UTC') AS b, COUNT(*) AS n
		  FROM installs
		  WHERE (account_id IS NULL OR account_id::text <> ALL($1::text[]))
		  GROUP BY 1
		),
		act AS (
		  SELECT date_trunc($2, server_received_at AT TIME ZONE 'UTC') AS b, COUNT(DISTINCT device_id) AS n
		  FROM events
		  WHERE (account_id IS NULL OR account_id::text <> ALL($1::text[]))
		  GROUP BY 1
		)
		SELECT to_char(buckets.b, $5), COALESCE(ins.n, 0), COALESCE(act.n, 0)
		FROM buckets
		LEFT JOIN ins ON ins.b = buckets.b
		LEFT JOIN act ON act.b = buckets.b
		ORDER BY buckets.b ASC
	`, s.operatorAccountIDs, spec.field, spec.interval, points, spec.format)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var p SeriesPoint
		if err := rows.Scan(&p.T, &p.Installs, &p.Active); err != nil {
			rows.Close()
			return st, err
		}
		st.Series = append(st.Series, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return st, err
	}

	// Engagement: DAU (today) / WAU (7d) / MAU (30d) — distinct non-operator
	// installs that phoned home in the window. From install_active_days (accrues
	// from deploy day; 0 until then).
	if err := s.pool.QueryRow(ctx, `
		SELECT
		  COUNT(DISTINCT ad.install_id) FILTER (WHERE ad.active_date >= CURRENT_DATE),
		  COUNT(DISTINCT ad.install_id) FILTER (WHERE ad.active_date >= CURRENT_DATE - 6),
		  COUNT(DISTINCT ad.install_id) FILTER (WHERE ad.active_date >= CURRENT_DATE - 29)
		FROM install_active_days ad
		JOIN installs i ON i.install_id = ad.install_id
		WHERE (i.account_id IS NULL OR i.account_id::text <> ALL($1::text[]))
	`, s.operatorAccountIDs).Scan(&st.DAU, &st.WAU, &st.MAU); err != nil {
		return st, err
	}

	// Day-N retention (eligible = had the chance; retained = active on exactly
	// day d0+N). Raw counts; frontend divides. Meaningful only for installs first
	// seen AFTER per-day tracking deployed.
	if err := s.pool.QueryRow(ctx, `
		WITH base AS (
		  SELECT i.install_id, i.first_seen_at::date AS d0
		  FROM installs i
		  WHERE (i.account_id IS NULL OR i.account_id::text <> ALL($1::text[]))
		)
		SELECT
		  COUNT(*) FILTER (WHERE d0 <= CURRENT_DATE - 1),
		  COUNT(*) FILTER (WHERE d0 <= CURRENT_DATE - 1  AND EXISTS (SELECT 1 FROM install_active_days a WHERE a.install_id = base.install_id AND a.active_date = base.d0 + 1)),
		  COUNT(*) FILTER (WHERE d0 <= CURRENT_DATE - 7),
		  COUNT(*) FILTER (WHERE d0 <= CURRENT_DATE - 7  AND EXISTS (SELECT 1 FROM install_active_days a WHERE a.install_id = base.install_id AND a.active_date = base.d0 + 7)),
		  COUNT(*) FILTER (WHERE d0 <= CURRENT_DATE - 30),
		  COUNT(*) FILTER (WHERE d0 <= CURRENT_DATE - 30 AND EXISTS (SELECT 1 FROM install_active_days a WHERE a.install_id = base.install_id AND a.active_date = base.d0 + 30))
		FROM base
	`, s.operatorAccountIDs).Scan(
		&st.RetD1Eligible, &st.RetD1Retained,
		&st.RetD7Eligible, &st.RetD7Retained,
		&st.RetD30Eligible, &st.RetD30Retained,
	); err != nil {
		return st, err
	}

	// Language split — installs by in-app language (app_locale).
	lrows, err := s.pool.Query(ctx, `
		SELECT COALESCE(NULLIF(app_locale, ''), 'unknown') AS locale, COUNT(*)
		FROM installs
		WHERE (account_id IS NULL OR account_id::text <> ALL($1::text[]))
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
	srows, err := s.pool.Query(ctx, `
		WITH w AS (
		  SELECT COALESCE(source, '(direct)') AS source, kind, ip, user_agent, visited_at, claimed_by_install_id,
		         (
		           (ip IS NULL OR ip <> ALL($1::text[]))
		           AND (user_agent IS NULL OR lower(user_agent) !~ $2)
		         ) AS keep
		  FROM web_visits
		)
		SELECT source,
		       COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'visit'),
		       COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'download'),
		       COUNT(DISTINCT (ip, user_agent, date_trunc('hour', visited_at))) FILTER (WHERE keep AND kind = 'store_click'),
		       COUNT(DISTINCT claimed_by_install_id) FILTER (WHERE keep AND claimed_by_install_id IS NOT NULL)
		FROM w
		GROUP BY source
		ORDER BY 2 DESC
		LIMIT 20
	`, s.operatorIPs, botUARegex)
	if err != nil {
		return st, err
	}
	for srows.Next() {
		var r SourceRow
		if err := srows.Scan(&r.Source, &r.Visits, &r.Downloads, &r.StoreClicks, &r.Attributed); err != nil {
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
	st.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	return st, nil
}
