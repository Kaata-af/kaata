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
	Hour     int    `json:"hour"`
	Active   *int64 `json:"active"`
	Installs *int64 `json:"installs"`
}

type ComparedDay struct {
	Date              string               `json:"date"`
	CompletedHours    int                  `json:"completed_hours"`
	ActivityAvailable bool                 `json:"activity_available"`
	Points            []DayComparisonPoint `json:"points"`
}

type DayComparison struct {
	Day           ComparedDay `json:"day"`
	CompareDay    ComparedDay `json:"compare_day"`
	GeneratedAt   string      `json:"generated_at"`
	TrackingSince string      `json:"tracking_since"`
	MinDate       string      `json:"min_date"`
	MaxDate       string      `json:"max_date"`
}

// Comparison dates are server-owned Kabul dates, independent of the browser,
// the Go host's timezone, and the database session timezone. Kabul has no DST
// in this bounded reporting window, so every day contains exactly 24 hours.
func dayComparisonDates(now time.Time, day, compareDay string) ([2]time.Time, DayComparison, error) {
	kabul := time.FixedZone("Asia/Kabul", 4*60*60+30*60)
	local := now.In(kabul)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, kabul)
	minimum := today.AddDate(0, 0, -89)
	out := DayComparison{
		GeneratedAt: now.UTC().Format(time.RFC3339Nano),
		MinDate:     minimum.Format("2006-01-02"),
		MaxDate:     today.Format("2006-01-02"),
	}
	if day == "" {
		day = out.MaxDate
	}
	if compareDay == "" {
		compareDay = today.AddDate(0, 0, -1).Format("2006-01-02")
	}
	var dates [2]time.Time
	for index, value := range []string{day, compareDay} {
		date, err := time.ParseInLocation("2006-01-02", value, kabul)
		if err != nil || date.Format("2006-01-02") != value || date.Before(minimum) || date.After(today) {
			return dates, out, fmt.Errorf("%w: use YYYY-MM-DD from %s through %s", ErrDayComparisonDate, out.MinDate, out.MaxDate)
		}
		dates[index] = date
		selected := &out.Day
		if index == 1 {
			selected = &out.CompareDay
		}
		selected.Date = value
		selected.CompletedHours = 24
		if date.Equal(today) {
			selected.CompletedHours = local.Hour()
		}
		selected.Points = make([]DayComparisonPoint, 0, 25)
	}
	return dates, out, nil
}

// GetDayComparison reads both dates and both metrics in one statement's
// snapshot, with one captured server instant. Activity is distinct installs
// across each entire prefix, not a sum of independently distinct hour counts.
func (s *Service) GetDayComparison(ctx context.Context, day, compareDay string) (DayComparison, error) {
	now := s.now()
	dates, out, err := dayComparisonDates(now, day, compareDay)
	if err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `
		WITH `+reportExclusionCTEs+`,
		days(idx, starts_at, completed_hours) AS (
		  VALUES (0, $3::timestamptz, $5::int), (1, $4::timestamptz, $6::int)
		), kept_installs AS (
		  SELECT install_id, LEAST(installed_at, first_seen_at) AS installed_at
		  FROM installs
		  WHERE first_seen_at <= $2::timestamptz
		    AND install_id NOT IN (SELECT install_id FROM report_excluded_installs)
		), first_activity AS (
		  SELECT d.idx, h.install_id, MIN(h.active_hour) AS first_hour
		  FROM days d
		  JOIN install_active_hours h ON h.active_hour >= d.starts_at
		    AND h.active_hour < d.starts_at + d.completed_hours * INTERVAL '1 hour'
		  JOIN kept_installs i ON i.install_id = h.install_id
		  GROUP BY d.idx, h.install_id
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
		            ELSE (SUM(COALESCE(i.n, 0)) OVER (PARTITION BY d.idx ORDER BY h.hour))::bigint END
		FROM days d CROSS JOIN generate_series(0, 24) AS h(hour)
		CROSS JOIN analytics_calendar c
		LEFT JOIN activity_buckets a ON a.idx = d.idx AND a.hour = h.hour
		LEFT JOIN install_buckets i ON i.idx = d.idx AND i.hour = h.hour
		ORDER BY d.idx, h.hour
	`, s.operatorAccountIDs, now, dates[0], dates[1], out.Day.CompletedHours, out.CompareDay.CompletedHours)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var index int
		var point DayComparisonPoint
		var tracking time.Time
		if err := rows.Scan(&index, &point.Hour, &tracking, &point.Active, &point.Installs); err != nil {
			return out, err
		}
		selected := &out.Day
		if index == 1 {
			selected = &out.CompareDay
		}
		selected.ActivityAvailable = !dates[index].Before(tracking)
		selected.Points = append(selected.Points, point)
		out.TrackingSince = tracking.UTC().Format(time.RFC3339Nano)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Day.Points) != 25 || len(out.CompareDay.Points) != 25 {
		return out, errors.New("day comparison calendar unavailable")
	}
	return out, nil
}
