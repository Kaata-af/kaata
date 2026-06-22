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
	Source     string `json:"source"`
	Visits     int64  `json:"visits"`
	Downloads  int64  `json:"downloads"`
	Attributed int64  `json:"attributed"`
}

type LocaleCount struct {
	Locale string `json:"locale"`
	Count  int64  `json:"count"`
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
	RawVisits int64 `json:"raw_visits"`
	// Signal quality: how much was removed as operator/bot noise.
	ExcludedInstalls int64 `json:"excluded_installs"`
	ExcludedVisits   int64 `json:"excluded_visits"`
	// Engagement — from install_active_days. Accrues from the day per-day
	// tracking deploys; 0 until then (frontend shows a "collecting since" state).
	DAU      int64      `json:"dau"`
	WAU      int64      `json:"wau"`
	MAU      int64      `json:"mau"`
	DauByDay []DayCount `json:"dau_by_day"`
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
	// Time series + attribution. The day-series span the requested window.
	InstallsByDay []DayCount  `json:"installs_by_day"`
	BySource      []SourceRow `json:"by_source"`
	// Days echoes the timeline window the series cover (so the UI can label it).
	Days int `json:"days"`
	// Server "as of" timestamp (RFC3339) so the dashboard can show freshness.
	GeneratedAt string `json:"generated_at"`
}

// GetStats computes the dashboard aggregates over a `days`-day timeline window
// (drives the installs/day + DAU/day series). The point-in-time KPIs
// (active_7d/30d, DAU/WAU/MAU, retention) use their own fixed windows.
func (s *Service) GetStats(ctx context.Context, days int) (Stats, error) {
	if days < 1 {
		days = 30
	}
	if days > 365 {
		days = 365
	}
	var st Stats
	st.Days = days

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
		  COUNT(*) FILTER (WHERE kind = 'visit'),
		  COUNT(*) FILTER (WHERE NOT keep)
		FROM w
	`, s.operatorIPs, botUARegex).Scan(&st.Visits, &st.Downloads, &st.RawVisits, &st.ExcludedVisits); err != nil {
		return st, err
	}

	// Installs per day — DENSE rolling 30-day calendar (zero-fill gap days),
	// UTC-pinned so device wall clocks can't shift a row into the wrong day,
	// ascending so the frontend renders left→right without reversing. Operator
	// installs excluded.
	rows, err := s.pool.Query(ctx, `
		WITH days AS (
		  SELECT generate_series((CURRENT_DATE - ($2 - 1) * INTERVAL '1 day')::date, CURRENT_DATE, INTERVAL '1 day')::date AS d
		)
		SELECT to_char(days.d, 'YYYY-MM-DD') AS day, COUNT(i.install_id)
		FROM days
		LEFT JOIN installs i
		  ON date_trunc('day', COALESCE(i.installed_at, i.first_seen_at) AT TIME ZONE 'UTC')::date = days.d
		 AND (i.account_id IS NULL OR i.account_id::text <> ALL($1::text[]))
		GROUP BY days.d
		ORDER BY days.d ASC
	`, s.operatorAccountIDs, days)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var d DayCount
		if err := rows.Scan(&d.Day, &d.Count); err != nil {
			rows.Close()
			return st, err
		}
		st.InstallsByDay = append(st.InstallsByDay, d)
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

	// DAU per day across the window (dense, zero-filled, ascending).
	drows, err := s.pool.Query(ctx, `
		WITH days AS (
		  SELECT generate_series((CURRENT_DATE - ($2 - 1) * INTERVAL '1 day')::date, CURRENT_DATE, INTERVAL '1 day')::date AS d
		),
		act AS (
		  SELECT ad.active_date, ad.install_id
		  FROM install_active_days ad
		  JOIN installs i ON i.install_id = ad.install_id
		  WHERE (i.account_id IS NULL OR i.account_id::text <> ALL($1::text[]))
		)
		SELECT to_char(days.d, 'YYYY-MM-DD'), COUNT(DISTINCT act.install_id)
		FROM days LEFT JOIN act ON act.active_date = days.d
		GROUP BY days.d ORDER BY days.d ASC
	`, s.operatorAccountIDs, days)
	if err != nil {
		return st, err
	}
	for drows.Next() {
		var d DayCount
		if err := drows.Scan(&d.Day, &d.Count); err != nil {
			drows.Close()
			return st, err
		}
		st.DauByDay = append(st.DauByDay, d)
	}
	drows.Close()
	if err := drows.Err(); err != nil {
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
		if err := srows.Scan(&r.Source, &r.Visits, &r.Downloads, &r.Attributed); err != nil {
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
	if st.InstallsByDay == nil {
		st.InstallsByDay = []DayCount{}
	}
	if st.BySource == nil {
		st.BySource = []SourceRow{}
	}
	if st.DauByDay == nil {
		st.DauByDay = []DayCount{}
	}
	if st.Languages == nil {
		st.Languages = []LocaleCount{}
	}
	st.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	return st, nil
}
