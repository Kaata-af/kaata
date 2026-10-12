package admin

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Growth analytics — GET /v1/admin/growth. Weekly cohort retention, weekly
// growth accounting (new / retained / resurrected / churned), and feature
// adoption, for the operator dashboard's Retention + Overview sections.
//
// Weeks are ISO weeks (Monday start) in the reporting calendar: Kabul since
// migration 036, with earlier UTC date-only history preserved. All install
// metrics apply the SAME test-data exclusion as GetStats (reportExclusionCTEs:
// operator accounts plus the installs and accounts excluded as test data;
// signed-out installs are kept unless excluded). Activity comes from
// admin_active_days, which accrues from the day per-day tracking deployed
// (migration 022) — cohorts installed before that show honest zeros, not
// backfilled history.
//
// Completed weeks of the growth accounting are recorded the first time they
// are reported (admin_growth_weeks, migration 058) and reused while the
// exclusion rules are unchanged, so a closed week's count and 7% verdict
// cannot change because a device later signs in to another account, is
// merged, or loses its account link to a purge. Excluding or including test
// data, or editing OPERATOR_ACCOUNT_IDS, recalculates them once.

// growthWeeks is the reporting window: the current ISO week plus the 11 before
// it. Also the cap on cohort retained[] length (a cohort is tracked at most 12
// weeks out, W0..W11).
const growthWeeks = 12

// The benchmark applies to weekly active devices, not sign-ups, cumulative
// installs, revenue, or unique people. Signed-out use has no durable person
// identity, and an install's current account cannot label historical activity.
const growthTargetPercent int64 = 7

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

	Active                   int64    `json:"active"`
	PreviousActive           int64    `json:"previous_active"`
	Change                   int64    `json:"change"`
	Complete                 bool     `json:"complete"`          // Monday–Sunday has ended in Kabul
	TrackingComplete         bool     `json:"tracking_complete"` // tracking existed before this week started
	PreviousTrackingComplete bool     `json:"previous_tracking_complete"`
	CalendarComparable       bool     `json:"calendar_comparable"` // excludes UTC/Kabul transition week and its following comparison
	GrowthRatePercent        *float64 `json:"growth_rate_percent"` // null for provisional/incomplete tracking/zero baseline
	TargetActive             *int64   `json:"target_active"`       // also available for this unfinished week's goal
	TargetMet                *bool    `json:"target_met"`          // null until a comparable week has ended
	// RecordedAt is when this completed week's counts were recorded
	// (admin_growth_weeks), RFC3339 UTC; "" for the unfinished week, which is
	// always live.
	RecordedAt string `json:"recorded_at"`
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
	GrowthAccounting      []GrowthWeek `json:"growth_accounting"`
	Adoption              Adoption     `json:"adoption"`
	GeneratedAt           string       `json:"generated_at"`
	ActivityTimezoneSince string       `json:"activity_timezone_since"`
	ActivityTrackingSince string       `json:"activity_tracking_since"`
	GrowthTargetPercent   int64        `json:"growth_target_percent"`
	// ExcludedInstalls = installs every metric above leaves out as operator
	// or test data (reportExclusionCTEs), so the page can say how many.
	ExcludedInstalls int64 `json:"excluded_installs"`
}

// GetGrowth computes the growth dashboard aggregates. Read-only; a handful of
// small queries over installs / install_active_days / vault_members / events —
// fleet is ~100 installs, so per-install lateral scans are fine.
func (s *Service) GetGrowth(ctx context.Context) (Growth, error) {
	now := s.now()
	var g Growth
	if err := s.pool.QueryRow(ctx, `SELECT to_char(kabul_since, 'YYYY-MM-DD') FROM analytics_calendar`).Scan(&g.ActivityTimezoneSince); err != nil {
		return g, err
	}
	var trackingSince time.Time
	if err := s.pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE name = '022_analytics_tracking.sql'`).Scan(&trackingSince); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return g, err
	}
	// Migration timestamps are recorded by db.Migrate on every real deploy.
	// If an old/manual schema has lost this record, activity can still be
	// reported, but its coverage is unknown and no weekly verdict is claimed.
	if !trackingSince.IsZero() {
		g.ActivityTrackingSince = trackingSince.UTC().Format(time.RFC3339)
	}
	g.GrowthTargetPercent = growthTargetPercent
	// The fingerprint the recorded weeks must match, read before the
	// accounting: freezeClosedWeeks reads it again and records nothing if an
	// exclusion changed in between, so no week is recorded under rules its
	// counts were not computed with.
	rules, err := s.exclusionRules(ctx)
	if err != nil {
		return g, err
	}

	// 1. Cohort sizes — dense 12-week series (generate_series) LEFT JOINed with
	//    install weeks, so empty cohort weeks still emit a row. Same keep
	//    predicate + installed_at fallback as GetStats' installs series.
	rows, err := s.pool.Query(ctx, `
		WITH `+reportExclusionCTEs+`,
		cur AS (
		  SELECT date_trunc('week', $3::timestamptz AT TIME ZONE 'Asia/Kabul')::date AS w
		),
		weeks AS (
		  SELECT generate_series((SELECT w FROM cur) - 7 * ($2 - 1), (SELECT w FROM cur), '7 days'::interval)::date AS w
		),
		base AS (
		  SELECT date_trunc('week', d.installed_date::timestamp)::date AS cw
		  FROM installs JOIN admin_install_dates d USING (install_id)
		  WHERE install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		)
		SELECT to_char(weeks.w, 'YYYY-MM-DD'), COUNT(base.cw)
		FROM weeks
		LEFT JOIN base ON base.cw = weeks.w
		GROUP BY weeks.w
		ORDER BY weeks.w ASC
	`, s.operatorAccountIDs, growthWeeks, now)
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
		WITH `+reportExclusionCTEs+`,
		cur AS (
		  SELECT date_trunc('week', $3::timestamptz AT TIME ZONE 'Asia/Kabul')::date AS w
		),
		base AS (
		  SELECT install_id,
		         date_trunc('week', d.installed_date::timestamp)::date AS cw
		  FROM installs JOIN admin_install_dates d USING (install_id)
		  WHERE install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		),
		act AS (
		  SELECT DISTINCT install_id, date_trunc('week', active_date::timestamp)::date AS aw
		  FROM admin_active_days
		  WHERE active_date <= ($3::timestamptz AT TIME ZONE 'Asia/Kabul')::date
		)
		SELECT to_char(b.cw, 'YYYY-MM-DD'), (act.aw - b.cw) / 7 AS wk_offset, COUNT(DISTINCT b.install_id)
		FROM base b
		JOIN act ON act.install_id = b.install_id
		WHERE b.cw >= (SELECT w FROM cur) - 7 * ($2 - 1)
		  AND act.aw >= b.cw
		  AND (act.aw - b.cw) / 7 < $2
		GROUP BY 1, 2
	`, s.operatorAccountIDs, growthWeeks, now)
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
		WITH `+reportExclusionCTEs+`,
		cur AS (
		  SELECT date_trunc('week', $3::timestamptz AT TIME ZONE 'Asia/Kabul')::date AS w
		),
		weeks AS (
		  SELECT generate_series((SELECT w FROM cur) - 7 * ($2 - 1), (SELECT w FROM cur), '7 days'::interval)::date AS w
		),
		aw AS (
		  SELECT DISTINCT a.install_id, date_trunc('week', a.active_date::timestamp)::date AS w
		  FROM admin_active_days a
		  WHERE a.install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		    AND a.active_date <= ($3::timestamptz AT TIME ZONE 'Asia/Kabul')::date
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
	`, s.operatorAccountIDs, growthWeeks, now)
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
	if err := s.freezeClosedWeeks(ctx, g.GrowthAccounting, now, rules); err != nil {
		return g, err
	}
	fillWeeklyGrowth(g.GrowthAccounting, now, trackingSince, g.ActivityTimezoneSince)

	// 4. Adoption. signed_in / with_shares reuse the GetStats keep subquery
	//    verbatim; multi_member counts non-excluded accounts sharing a vault
	//    that has >1 active (accepted, not revoked) member; with_settlements
	//    counts vaults with at least one entry_settled event that are neither
	//    owned by an excluded account nor excluded themselves (the only place a
	//    vault exclusion reaches the install metrics).
	if err := s.pool.QueryRow(ctx, `
		WITH `+reportExclusionCTEs+`
		SELECT
		  COUNT(*) FILTER (WHERE keep AND account_id IS NOT NULL),
		  COUNT(*) FILTER (WHERE keep AND usage_shares_sent > 0),
		  (
		    SELECT COUNT(DISTINCT vm.account_id)
		    FROM vault_members vm
		    WHERE vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		      AND vm.account_id IS NOT NULL
		      AND vm.account_id::text NOT IN (SELECT id FROM report_excluded_accounts)
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
		      AND v.owner_account_id::text NOT IN (SELECT id FROM report_excluded_accounts)
		      AND v.vault_id::text NOT IN (SELECT id FROM outreach_exclusions WHERE kind = 'vault')
		  ),
		  COUNT(*) FILTER (WHERE NOT keep)
		FROM (
		  SELECT *, (install_id NOT IN (SELECT install_id FROM report_excluded_installs)) AS keep
		  FROM installs
		) i
	`, s.operatorAccountIDs).Scan(
		&g.Adoption.SignedIn, &g.Adoption.WithShares,
		&g.Adoption.MultiMember, &g.Adoption.WithSettlements,
		&g.ExcludedInstalls,
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
	g.GeneratedAt = now.UTC().Format(time.RFC3339)
	return g, nil
}

// kabulWeekStart is the current reporting week's Monday in Kabul,
// "YYYY-MM-DD" — the same week the SQL above calls `cur`. A week labelled
// earlier than it has ended.
func kabulWeekStart(now time.Time) string {
	kabul := time.FixedZone("Asia/Kabul", 4*60*60+30*60)
	local := now.In(kabul)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, kabul)
	return today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7)).Format("2006-01-02")
}

// freezeClosedWeeks records every completed week's accounting the first time
// it is reported and replaces the live counts with the recorded ones, so a
// closed week keeps the numbers (and therefore the 7% verdict) it was first
// reported with. Device links still change after the fact — a sign-in to
// another account, an identity merge, a purge that nulls installs.account_id
// — and a recount would move devices into or out of weeks that are over.
// Activity itself cannot change (check-ins are stamped with the server's
// clock, and installs are never deleted), so what is recorded is what the
// week was.
//
// A row recorded under other exclusion rules is recalculated once: excluding
// or including test data, or editing OPERATOR_ACCOUNT_IDS, is a deliberate
// correction of the past. rules is the fingerprint read before the
// accounting queries; if the rules changed while they ran, nothing is
// recorded and the live counts are returned, so no week is ever recorded
// under rules it was not computed with. The unfinished week is always live.
func (s *Service) freezeClosedWeeks(ctx context.Context, weeks []GrowthWeek, now time.Time, rules string) error {
	current := kabulWeekStart(now)
	var labels []string
	var news, retained, resurrected, churned []int64
	for _, w := range weeks {
		if w.Week >= current {
			continue
		}
		labels = append(labels, w.Week)
		news = append(news, w.New)
		retained = append(retained, w.Retained)
		resurrected = append(resurrected, w.Resurrected)
		churned = append(churned, w.Churned)
	}
	if len(labels) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	latest, err := s.exclusionRules(ctx)
	if err != nil {
		return err
	}
	if latest != rules {
		return nil // an exclusion changed mid-report; record on the next read
	}
	// Insert weeks never recorded; replace weeks recorded under other rules;
	// leave every other recorded week exactly as it is. Concurrent readers
	// under the same rules converge on whichever row committed first.
	if _, err := tx.Exec(ctx, `
		INSERT INTO admin_growth_weeks AS g
		  (week, rules, new_installs, retained, resurrected, churned, recorded_at)
		SELECT t.week::date, $2, t.n, t.r, t.z, t.c, $7
		FROM unnest($1::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[]) AS t(week, n, r, z, c)
		ON CONFLICT (week) DO UPDATE SET
		  rules = EXCLUDED.rules,
		  new_installs = EXCLUDED.new_installs,
		  retained = EXCLUDED.retained,
		  resurrected = EXCLUDED.resurrected,
		  churned = EXCLUDED.churned,
		  recorded_at = EXCLUDED.recorded_at
		WHERE g.rules <> EXCLUDED.rules
	`, labels, rules, news, retained, resurrected, churned, now); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT to_char(week, 'YYYY-MM-DD'), new_installs, retained, resurrected, churned, recorded_at
		FROM admin_growth_weeks
		WHERE week = ANY($1::text[]::date[]) AND rules = $2
	`, labels, rules)
	if err != nil {
		return err
	}
	type recordedWeek struct {
		new, retained, resurrected, churned int64
		at                                  time.Time
	}
	recorded := map[string]recordedWeek{}
	for rows.Next() {
		var week string
		var r recordedWeek
		if err := rows.Scan(&week, &r.new, &r.retained, &r.resurrected, &r.churned, &r.at); err != nil {
			rows.Close()
			return err
		}
		recorded[week] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for i := range weeks {
		if r, ok := recorded[weeks[i].Week]; ok {
			weeks[i].New, weeks[i].Retained = r.new, r.retained
			weeks[i].Resurrected, weeks[i].Churned = r.resurrected, r.churned
			weeks[i].RecordedAt = r.at.UTC().Format(time.RFC3339)
		}
	}
	return nil
}

// fillWeeklyGrowth derives the baseline from accounting, so even the oldest
// displayed week compares against its real previous week outside the window.
// Only completed and fully observed weeks receive a growth rate or verdict.
// Historical DATE-only rows retain the reporting calendar they were written
// in; the migration-036 cutover is disclosed separately by the API.
func fillWeeklyGrowth(weeks []GrowthWeek, now, trackingSince time.Time, kabulSince string) {
	kabul := time.FixedZone("Asia/Kabul", 4*60*60+30*60)
	currentMonday := kabulWeekStart(now)
	cutoverDate, cutoverErr := time.Parse("2006-01-02", kabulSince)
	cutoverMonday := cutoverDate.AddDate(0, 0, -((int(cutoverDate.Weekday()) + 6) % 7))
	transitionWeek := cutoverMonday.Format("2006-01-02")
	followingWeek := cutoverMonday.AddDate(0, 0, 7).Format("2006-01-02")
	weekStart := func(label string) time.Time {
		zone := kabul
		if label < kabulSince {
			zone = time.UTC
		}
		// Week labels are generated by PostgreSQL to_char, never user input.
		start, _ := time.ParseInLocation("2006-01-02", label, zone)
		return start
	}
	for i := range weeks {
		w := &weeks[i]
		w.GrowthRatePercent, w.TargetActive, w.TargetMet = nil, nil, nil
		w.Active = w.New + w.Retained + w.Resurrected
		w.PreviousActive = w.Retained + w.Churned
		w.Change = w.Active - w.PreviousActive
		w.Complete = w.Week < currentMonday
		start := weekStart(w.Week)
		w.TrackingComplete = !trackingSince.IsZero() && !start.Before(trackingSince)
		previousLabel := start.AddDate(0, 0, -7).Format("2006-01-02")
		w.PreviousTrackingComplete = !trackingSince.IsZero() && !weekStart(previousLabel).Before(trackingSince)
		// Migration 036's week combines legacy UTC dates with Kabul-hour
		// activity and can only seed the rollout day's latest known check-in.
		// Keep its observed counts, but do not claim a comparable growth rate
		// in that week or use it as the next week's benchmark baseline. Even a
		// Monday cutover can be a mid-day deploy with partial hourly history.
		w.CalendarComparable = cutoverErr == nil && w.Week != transitionWeek && w.Week != followingWeek
		if !w.TrackingComplete || !w.PreviousTrackingComplete || !w.CalendarComparable || w.PreviousActive == 0 {
			continue
		}
		// Integer arithmetic avoids ceil(100*1.07) accidentally becoming 108
		// because of binary floating-point rounding. Split quotient/remainder
		// also avoids multiplying the entire install count by the percentage.
		extra := w.PreviousActive/100*growthTargetPercent + (w.PreviousActive%100*growthTargetPercent+99)/100
		target := w.PreviousActive + extra
		w.TargetActive = &target
		if w.Complete {
			rate := float64(w.Change) / float64(w.PreviousActive) * 100
			met := w.Active >= target
			w.GrowthRatePercent = &rate
			w.TargetMet = &met
		}
	}
}
