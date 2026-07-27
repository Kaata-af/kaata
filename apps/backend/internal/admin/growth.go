package admin

import (
	"context"
	"time"
)

// Growth analytics — GET /v1/admin/growth. Weekly cohort retention, weekly
// growth accounting (new / retained / resurrected / churned), and feature
// adoption, for the operator dashboard's Retention + Overview sections.
//
// Weeks are ISO weeks (Monday start) in UTC, matching date_trunc('week') in
// Postgres. All installs-based numbers apply the SAME operator exclusion as
// GetStats: keep = account_id IS NULL OR account_id NOT IN operatorAccountIDs
// (NULL-account local-only installs are kept). Activity comes from
// install_active_days, which accrues from the day per-day tracking deployed
// (migration 022) — cohorts installed before that show honest zeros, not
// backfilled history.

// growthWeeks is the reporting window: the current ISO week plus the 11 before
// it. Also the cap on cohort retained[] length (a cohort is tracked at most 12
// weeks out, W0..W11).
const growthWeeks = 12

type CohortRow struct {
	// Week is the cohort's ISO week start (Monday), date only.
	Week string `json:"week"`
	// Size = non-operator installs whose install time falls in this week
	// (COALESCE(installed_at, first_seen_at), same fallback as the stats series).
	Size int64 `json:"size"`
	// Retained[i] = installs from this cohort with ANY install_active_days row
	// in week+i. Index 0 == active during the install week itself. Length =
	// min(weeks elapsed + 1, 12) — future weeks simply don't exist yet.
	Retained []int64 `json:"retained"`
}

// GrowthWeek is one week of growth accounting, derived per-install from
// install_active_days week presence. new + retained + resurrected partition
// the week's active installs; churned is last week's actives that went silent.
type GrowthWeek struct {
	Week        string `json:"week"`
	New         int64  `json:"new"`         // first-ever-active week == this week
	Retained    int64  `json:"retained"`    // active this week AND previous week
	Resurrected int64  `json:"resurrected"` // active this week, not previous, active some earlier week
	Churned     int64  `json:"churned"`     // active previous week, NOT this week (positive number)
}

type Adoption struct {
	// SignedIn = non-operator installs with an account attached.
	SignedIn int64 `json:"signed_in"`
	// MultiMember = distinct non-operator accounts that are active members of a
	// vault with more than one active member (i.e. actually sharing a kaata).
	MultiMember int64 `json:"multi_member"`
	// WithShares = non-operator installs that sent at least one WhatsApp share.
	WithShares int64 `json:"with_shares"`
	// WithSettlements = distinct non-operator-owned vaults with >=1
	// entry_settled event (the settle-up feature actually used).
	WithSettlements int64 `json:"with_settlements"`
}

type Growth struct {
	// WeeklyCohorts — last 12 cohort weeks, oldest first, dense (empty weeks
	// appear with size 0 so the frontend grid stays rectangular).
	WeeklyCohorts []CohortRow `json:"weekly_cohorts"`
	// GrowthAccounting — last 12 weeks, oldest first, dense.
	GrowthAccounting []GrowthWeek `json:"growth_accounting"`
	Adoption         Adoption     `json:"adoption"`
	GeneratedAt      string       `json:"generated_at"`
}

// GetGrowth computes the growth dashboard aggregates. Read-only; a handful of
// small queries over installs / install_active_days / vault_members / events —
// fleet is ~100 installs, so per-install lateral scans are fine.
func (s *Service) GetGrowth(ctx context.Context) (Growth, error) {
	var g Growth

	// 1. Cohort sizes — dense 12-week series (generate_series) LEFT JOINed with
	//    install weeks, so empty cohort weeks still emit a row. Same keep
	//    predicate + installed_at fallback as GetStats' installs series.
	rows, err := s.pool.Query(ctx, `
		WITH cur AS (
		  SELECT date_trunc('week', NOW() AT TIME ZONE 'UTC')::date AS w
		),
		weeks AS (
		  SELECT generate_series((SELECT w FROM cur) - 7 * ($2 - 1), (SELECT w FROM cur), '7 days'::interval)::date AS w
		),
		base AS (
		  SELECT date_trunc('week', COALESCE(installed_at, first_seen_at) AT TIME ZONE 'UTC')::date AS cw
		  FROM installs
		  WHERE (account_id IS NULL OR account_id::text <> ALL($1::text[]))
		)
		SELECT to_char(weeks.w, 'YYYY-MM-DD'), COUNT(base.cw)
		FROM weeks
		LEFT JOIN base ON base.cw = weeks.w
		GROUP BY weeks.w
		ORDER BY weeks.w ASC
	`, s.operatorAccountIDs, growthWeeks)
	if err != nil {
		return g, err
	}
	weekIdx := map[string]int{} // cohort week label -> index into g.WeeklyCohorts
	for rows.Next() {
		var c CohortRow
		if err := rows.Scan(&c.Week, &c.Size); err != nil {
			rows.Close()
			return g, err
		}
		weekIdx[c.Week] = len(g.WeeklyCohorts)
		g.WeeklyCohorts = append(g.WeeklyCohorts, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return g, err
	}
	// Rows are ascending, so cohort i has lived (len-1-i) full weeks past its
	// install week → retained[] length = weeks elapsed + 1 (capped at 12 by the
	// window itself). Pre-zeroed; the sparse counts below fill in.
	for i := range g.WeeklyCohorts {
		g.WeeklyCohorts[i].Retained = make([]int64, len(g.WeeklyCohorts)-i)
	}

	// 2. Cohort retention — sparse (cohort week, week offset, installs) rows.
	//    offset = whole weeks between the install week and the activity week;
	//    offset 0 is the install week itself. Activity before the install week
	//    (clock skew / reinstall edge) is dropped rather than mis-bucketed.
	rrows, err := s.pool.Query(ctx, `
		WITH cur AS (
		  SELECT date_trunc('week', NOW() AT TIME ZONE 'UTC')::date AS w
		),
		base AS (
		  SELECT install_id,
		         date_trunc('week', COALESCE(installed_at, first_seen_at) AT TIME ZONE 'UTC')::date AS cw
		  FROM installs
		  WHERE (account_id IS NULL OR account_id::text <> ALL($1::text[]))
		),
		act AS (
		  SELECT DISTINCT install_id, date_trunc('week', active_date::timestamp)::date AS aw
		  FROM install_active_days
		)
		SELECT to_char(b.cw, 'YYYY-MM-DD'), (act.aw - b.cw) / 7 AS wk_offset, COUNT(DISTINCT b.install_id)
		FROM base b
		JOIN act ON act.install_id = b.install_id
		WHERE b.cw >= (SELECT w FROM cur) - 7 * ($2 - 1)
		  AND act.aw >= b.cw
		  AND (act.aw - b.cw) / 7 < $2
		GROUP BY 1, 2
	`, s.operatorAccountIDs, growthWeeks)
	if err != nil {
		return g, err
	}
	for rrows.Next() {
		var week string
		var offset int
		var n int64
		if err := rrows.Scan(&week, &offset, &n); err != nil {
			rrows.Close()
			return g, err
		}
		if i, ok := weekIdx[week]; ok && offset >= 0 && offset < len(g.WeeklyCohorts[i].Retained) {
			g.WeeklyCohorts[i].Retained[offset] = n
		}
	}
	rrows.Close()
	if err := rrows.Err(); err != nil {
		return g, err
	}

	// 3. Growth accounting — per week, classify every install by its active-week
	//    set: new (first-ever-active week is this week), retained (also active
	//    the week before), resurrected (silent last week but active some earlier
	//    week), churned (active last week, silent this week). LEFT JOIN LATERAL
	//    keeps the dense week series even when there are zero installs.
	grows, err := s.pool.Query(ctx, `
		WITH cur AS (
		  SELECT date_trunc('week', NOW() AT TIME ZONE 'UTC')::date AS w
		),
		weeks AS (
		  SELECT generate_series((SELECT w FROM cur) - 7 * ($2 - 1), (SELECT w FROM cur), '7 days'::interval)::date AS w
		),
		aw AS (
		  SELECT DISTINCT a.install_id, date_trunc('week', a.active_date::timestamp)::date AS w
		  FROM install_active_days a
		  JOIN installs i ON i.install_id = a.install_id
		  WHERE (i.account_id IS NULL OR i.account_id::text <> ALL($1::text[]))
		),
		firsts AS (
		  SELECT install_id, MIN(w) AS first_w FROM aw GROUP BY install_id
		)
		SELECT to_char(weeks.w, 'YYYY-MM-DD'),
		       COUNT(*) FILTER (WHERE t.this AND t.first_w = weeks.w),
		       COUNT(*) FILTER (WHERE t.this AND t.prev),
		       COUNT(*) FILTER (WHERE t.this AND NOT t.prev AND t.first_w < weeks.w),
		       COUNT(*) FILTER (WHERE t.prev AND NOT t.this)
		FROM weeks
		LEFT JOIN LATERAL (
		  SELECT f.first_w,
		         EXISTS (SELECT 1 FROM aw WHERE aw.install_id = f.install_id AND aw.w = weeks.w) AS this,
		         EXISTS (SELECT 1 FROM aw WHERE aw.install_id = f.install_id AND aw.w = weeks.w - 7) AS prev
		  FROM firsts f
		) t ON TRUE
		GROUP BY weeks.w
		ORDER BY weeks.w ASC
	`, s.operatorAccountIDs, growthWeeks)
	if err != nil {
		return g, err
	}
	for grows.Next() {
		var w GrowthWeek
		if err := grows.Scan(&w.Week, &w.New, &w.Retained, &w.Resurrected, &w.Churned); err != nil {
			grows.Close()
			return g, err
		}
		g.GrowthAccounting = append(g.GrowthAccounting, w)
	}
	grows.Close()
	if err := grows.Err(); err != nil {
		return g, err
	}

	// 4. Adoption. signed_in / with_shares reuse the GetStats keep subquery
	//    verbatim; multi_member counts non-operator accounts sharing a vault
	//    that has >1 active (accepted, not revoked) member; with_settlements
	//    counts non-operator-OWNED vaults with at least one entry_settled event.
	if err := s.pool.QueryRow(ctx, `
		SELECT
		  COUNT(*) FILTER (WHERE keep AND account_id IS NOT NULL),
		  COUNT(*) FILTER (WHERE keep AND usage_shares_sent > 0),
		  (
		    SELECT COUNT(DISTINCT vm.account_id)
		    FROM vault_members vm
		    WHERE vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		      AND vm.account_id IS NOT NULL
		      AND vm.account_id::text <> ALL($1::text[])
		      AND vm.vault_id IN (
		        SELECT vault_id FROM vault_members
		        WHERE accepted_at IS NOT NULL AND revoked_at IS NULL AND account_id IS NOT NULL
		        GROUP BY vault_id
		        HAVING COUNT(*) > 1
		      )
		  ),
		  (
		    SELECT COUNT(DISTINCT e.vault_id)
		    FROM events e
		    JOIN vaults v ON v.vault_id = e.vault_id
		    WHERE e.event_type = 'entry_settled'
		      AND v.owner_account_id::text <> ALL($1::text[])
		  )
		FROM (
		  SELECT *, (account_id IS NULL OR account_id::text <> ALL($1::text[])) AS keep
		  FROM installs
		) i
	`, s.operatorAccountIDs).Scan(
		&g.Adoption.SignedIn, &g.Adoption.WithShares,
		&g.Adoption.MultiMember, &g.Adoption.WithSettlements,
	); err != nil {
		return g, err
	}

	// Never emit JSON null for the slices — the dashboard expects arrays.
	if g.WeeklyCohorts == nil {
		g.WeeklyCohorts = []CohortRow{}
	}
	if g.GrowthAccounting == nil {
		g.GrowthAccounting = []GrowthWeek{}
	}
	g.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	return g, nil
}
