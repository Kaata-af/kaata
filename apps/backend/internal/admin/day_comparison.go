package admin

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var ErrDayComparisonDate = errors.New("invalid day comparison date")

// DayComparisonPoint is a cumulative count before a Kabul hour boundary.
// Hour 0 is midnight; hour 24 is the following midnight. Nil means that the
// hour has not completed or that full-day-prefix activity was not tracked.
type DayComparisonPoint struct {
	Hour           int    `json:"hour"`
	Active         *int64 `json:"active"`
	Installs       *int64 `json:"installs"`
	HourlyActive   *int64 `json:"hourly_active"`
	HourlyInstalls *int64 `json:"hourly_installs"`
}

type ComparedDay struct {
	Date              string               `json:"date"`
	CompletedHours    int                  `json:"completed_hours"`
	ActivityAvailable bool                 `json:"activity_available"`
	Points            []DayComparisonPoint `json:"points"`
}

type DayComparison struct {
	Days          []ComparedDay `json:"days"`
	Day           ComparedDay   `json:"day"`
	CompareDay    ComparedDay   `json:"compare_day"`
	GeneratedAt   string        `json:"generated_at"`
	TrackingSince string        `json:"tracking_since"`
	MinDate       string        `json:"min_date"`
	MaxDate       string        `json:"max_date"`
}

// Comparison dates are server-owned Kabul dates, independent of the browser,
// the Go host's timezone, and the database session timezone. Kabul has no DST
// in this bounded reporting window, so every day contains exactly 24 hours.
func comparisonCalendar(now time.Time) (time.Time, DayComparison) {
	kabul := time.FixedZone("Asia/Kabul", 4*60*60+30*60)
	local := now.In(kabul)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, kabul)
	return today, DayComparison{
		GeneratedAt: now.UTC().Format(time.RFC3339Nano),
		MinDate:     today.AddDate(0, 0, -89).Format("2006-01-02"),
		MaxDate:     today.Format("2006-01-02"),
	}
}

// Legacy pairs can deliberately compare a date with itself. Preserve that
// behavior independently of the distinct-date rule for the new selection API.
func dayComparisonDates(now time.Time, day, compareDay string) ([2]time.Time, DayComparison, error) {
	today, calendar := comparisonCalendar(now)
	if day == "" {
		day = calendar.MaxDate
	}
	if compareDay == "" {
		compareDay = today.AddDate(0, 0, -1).Format("2006-01-02")
	}
	resolved, out, err := resolveComparisonDates(now, []string{day, compareDay}, false)
	var dates [2]time.Time
	if err == nil {
		copy(dates[:], resolved)
	}
	return dates, out, err
}

func dayComparisonsDates(now time.Time, days []string, preset string) ([]time.Time, DayComparison, error) {
	today, out := comparisonCalendar(now)
	if preset != "" {
		if days != nil {
			return nil, out, fmt.Errorf("%w: choose days or preset", ErrDayComparisonDate)
		}
		var offsets []int
		switch preset {
		case "today-yesterday":
			offsets = []int{0, 1}
		case "last7":
			offsets = []int{0, 1, 2, 3, 4, 5, 6}
		case "last7-complete":
			offsets = []int{1, 2, 3, 4, 5, 6, 7}
		case "same-weekday":
			offsets = []int{0, 7, 14, 21, 28}
		default:
			return nil, out, fmt.Errorf("%w: unknown preset", ErrDayComparisonDate)
		}
		days = make([]string, len(offsets))
		for index, offset := range offsets {
			days[index] = today.AddDate(0, 0, -offset).Format("2006-01-02")
		}
	}
	return resolveComparisonDates(now, days, true)
}

func resolveComparisonDates(now time.Time, labels []string, distinct bool) ([]time.Time, DayComparison, error) {
	today, out := comparisonCalendar(now)
	if len(labels) < 2 || len(labels) > 7 {
		return nil, out, fmt.Errorf("%w: choose two through seven dates", ErrDayComparisonDate)
	}
	minimum := today.AddDate(0, 0, -89)
	dates := make([]time.Time, len(labels))
	out.Days = make([]ComparedDay, len(labels))
	seen := make(map[string]bool, len(labels))
	for index, value := range labels {
		date, err := time.ParseInLocation("2006-01-02", value, today.Location())
		if err != nil || date.Format("2006-01-02") != value || date.Before(minimum) || date.After(today) {
			return nil, out, fmt.Errorf("%w: use YYYY-MM-DD from %s through %s", ErrDayComparisonDate, out.MinDate, out.MaxDate)
		}
		if distinct && seen[value] {
			return nil, out, fmt.Errorf("%w: dates must be distinct", ErrDayComparisonDate)
		}
		seen[value] = true
		dates[index] = date
		out.Days[index] = ComparedDay{Date: value, CompletedHours: 24, Points: make([]DayComparisonPoint, 0, 25)}
		if date.Equal(today) {
			out.Days[index].CompletedHours = now.In(today.Location()).Hour()
		}
	}
	out.Day, out.CompareDay = out.Days[0], out.Days[1]
	return dates, out, nil
}

// GetDayComparison is the original two-date service contract. Both it and the
// multi-date API use one captured instant and one bounded SQL snapshot.
func (s *Service) GetDayComparison(ctx context.Context, day, compareDay string) (DayComparison, error) {
	now := s.now()
	dates, out, err := dayComparisonDates(now, day, compareDay)
	if err != nil {
		return out, err
	}
	return s.queryDayComparison(ctx, now, dates[:], out)
}

// GetDayComparisons accepts either an ordered custom date list or a named
// preset. Hourly activity measures all distinct installs in that hour, including
// returning installs that do not increase the cumulative distinct count.
func (s *Service) GetDayComparisons(ctx context.Context, days []string, preset string) (DayComparison, error) {
	now := s.now()
	dates, out, err := dayComparisonsDates(now, days, preset)
	if err != nil {
		return out, err
	}
	return s.queryDayComparison(ctx, now, dates, out)
}

func (s *Service) queryDayComparison(ctx context.Context, now time.Time, dates []time.Time, out DayComparison) (DayComparison, error) {
	completed := make([]int32, len(out.Days))
	for index, day := range out.Days {
		completed[index] = int32(day.CompletedHours)
	}
	rows, err := s.pool.Query(ctx, `
		WITH `+reportExclusionCTEs+`,
		days(idx, starts_at, completed_hours) AS (
		  SELECT (selected.ord - 1)::int, selected.starts_at, selected.completed_hours
		  FROM unnest($3::timestamptz[], $4::int[]) WITH ORDINALITY
		    AS selected(starts_at, completed_hours, ord)
		), kept_installs AS (
		  SELECT install_id, LEAST(installed_at, first_seen_at) AS installed_at
		  FROM installs
		  WHERE first_seen_at <= $2::timestamptz
		    AND install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		), activity_rows AS (
		  SELECT d.idx, h.install_id, h.active_hour,
		         FLOOR(EXTRACT(EPOCH FROM (h.active_hour - d.starts_at)) / 3600)::int + 1 AS hour
		  FROM days d
		  JOIN install_active_hours h ON h.active_hour >= d.starts_at
		    AND h.active_hour < d.starts_at + d.completed_hours * INTERVAL '1 hour'
		  JOIN kept_installs i ON i.install_id = h.install_id
		), first_activity AS (
		  SELECT idx, install_id, MIN(active_hour) AS first_hour
		  FROM activity_rows GROUP BY idx, install_id
		), hourly_activity AS (
		  SELECT idx, hour, COUNT(DISTINCT install_id) AS n
		  FROM activity_rows GROUP BY idx, hour
		), activity_buckets AS (
		  SELECT a.idx, FLOOR(EXTRACT(EPOCH FROM (a.first_hour - d.starts_at)) / 3600)::int + 1 AS hour,
		         COUNT(*) AS n
		  FROM first_activity a JOIN days d USING (idx)
		  GROUP BY a.idx, hour
		), install_buckets AS (
		  SELECT d.idx, FLOOR(EXTRACT(EPOCH FROM (i.installed_at - d.starts_at)) / 3600)::int + 1 AS hour,
		         COUNT(*) AS n
		  FROM days d JOIN kept_installs i ON i.installed_at >= d.starts_at
		    AND i.installed_at < d.starts_at + d.completed_hours * INTERVAL '1 hour'
		  GROUP BY d.idx, hour
		)
		SELECT d.idx, h.hour, c.started_at,
		       CASE WHEN h.hour > d.completed_hours OR d.starts_at < c.started_at THEN NULL
		            ELSE (SUM(COALESCE(a.n, 0)) OVER (PARTITION BY d.idx ORDER BY h.hour))::bigint END,
		       CASE WHEN h.hour > d.completed_hours THEN NULL
		            ELSE (SUM(COALESCE(i.n, 0)) OVER (PARTITION BY d.idx ORDER BY h.hour))::bigint END,
		       CASE WHEN h.hour = 0 OR h.hour > d.completed_hours
		              OR d.starts_at + (h.hour - 1) * INTERVAL '1 hour' < c.started_at THEN NULL
		            ELSE COALESCE(hourly.n, 0) END,
		       CASE WHEN h.hour = 0 OR h.hour > d.completed_hours THEN NULL ELSE COALESCE(i.n, 0) END
		FROM days d CROSS JOIN generate_series(0, 24) AS h(hour)
		CROSS JOIN analytics_calendar c
		LEFT JOIN activity_buckets a ON a.idx = d.idx AND a.hour = h.hour
		LEFT JOIN hourly_activity hourly ON hourly.idx = d.idx AND hourly.hour = h.hour
		LEFT JOIN install_buckets i ON i.idx = d.idx AND i.hour = h.hour
		ORDER BY d.idx, h.hour
	`, s.operatorAccountIDs, now, dates, completed)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var index int
		var point DayComparisonPoint
		var tracking time.Time
		if err := rows.Scan(&index, &point.Hour, &tracking, &point.Active, &point.Installs, &point.HourlyActive, &point.HourlyInstalls); err != nil {
			return out, err
		}
		if index < 0 || index >= len(out.Days) {
			return out, errors.New("invalid day comparison index")
		}
		selected := &out.Days[index]
		selected.ActivityAvailable = !dates[index].Before(tracking)
		selected.Points = append(selected.Points, point)
		out.TrackingSince = tracking.UTC().Format(time.RFC3339Nano)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, day := range out.Days {
		if len(day.Points) != 25 {
			return out, errors.New("day comparison calendar unavailable")
		}
	}
	out.Day, out.CompareDay = out.Days[0], out.Days[1]
	return out, nil
}
