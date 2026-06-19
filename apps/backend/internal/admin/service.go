// Package admin serves operator-only analytics — the funnel + usage aggregates
// the backend already captures (installs, web_visits), surfaced for the admin
// dashboard (docs/backlog.md "Admin dashboard") so the operator can see the data
// without hand-writing SQL. Read-only; guarded by httpx.AdminKeyMiddleware.
package admin

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

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

type Stats struct {
	// Funnel (installs): total → onboarded → made an entry → shared → still active.
	InstallsTotal int64 `json:"installs_total"`
	Onboarded     int64 `json:"onboarded"`
	WithEntries   int64 `json:"with_entries"`
	WithShares    int64 `json:"with_shares"`
	Active        int64 `json:"active"`
	// Lifetime usage sums across all installs.
	EntriesSum   int64 `json:"entries_sum"`
	CustomersSum int64 `json:"customers_sum"`
	SharesSum    int64 `json:"shares_sum"`
	// Web funnel.
	Visits    int64 `json:"visits"`
	Downloads int64 `json:"downloads"`
	// Time series + attribution.
	InstallsByDay []DayCount  `json:"installs_by_day"`
	BySource      []SourceRow `json:"by_source"`
}

func (s *Service) GetStats(ctx context.Context) (Stats, error) {
	var st Stats

	if err := s.pool.QueryRow(ctx, `
		SELECT
		  COUNT(*),
		  COUNT(*) FILTER (WHERE has_onboarded),
		  COUNT(*) FILTER (WHERE usage_entries_created > 0),
		  COUNT(*) FILTER (WHERE usage_shares_sent > 0),
		  COUNT(*) FILTER (WHERE last_activity_at IS NOT NULL),
		  COALESCE(SUM(usage_entries_created), 0),
		  COALESCE(SUM(usage_customers_added), 0),
		  COALESCE(SUM(usage_shares_sent), 0)
		FROM installs
	`).Scan(
		&st.InstallsTotal, &st.Onboarded, &st.WithEntries, &st.WithShares, &st.Active,
		&st.EntriesSum, &st.CustomersSum, &st.SharesSum,
	); err != nil {
		return st, err
	}

	if err := s.pool.QueryRow(ctx, `
		SELECT
		  COUNT(*) FILTER (WHERE kind = 'visit'),
		  COUNT(*) FILTER (WHERE kind = 'download')
		FROM web_visits
	`).Scan(&st.Visits, &st.Downloads); err != nil {
		return st, err
	}

	// Installs per day (last 30 days), newest first. installed_at is device wall
	// clock; fall back to first_seen_at (server) when the device didn't report one.
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(date_trunc('day', COALESCE(installed_at, first_seen_at)), 'YYYY-MM-DD') AS day,
		       COUNT(*)
		FROM installs
		GROUP BY day
		ORDER BY day DESC
		LIMIT 30
	`)
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

	// Web visits/downloads + attributed installs per marketing source.
	srows, err := s.pool.Query(ctx, `
		SELECT COALESCE(source, '(direct)') AS source,
		       COUNT(*) FILTER (WHERE kind = 'visit'),
		       COUNT(*) FILTER (WHERE kind = 'download'),
		       COUNT(DISTINCT claimed_by_install_id) FILTER (WHERE claimed_by_install_id IS NOT NULL)
		FROM web_visits
		GROUP BY COALESCE(source, '(direct)')
		ORDER BY 2 DESC
		LIMIT 20
	`)
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
	return st, nil
}
