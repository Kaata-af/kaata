package admin

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestFillWeeklyGrowth(t *testing.T) {
	now := activityTime(t, "2026-09-28T10:00:00Z")
	tracked := activityTime(t, "2026-09-01T00:00:00Z")
	tests := []struct {
		name          string
		week          GrowthWeek
		trackingSince time.Time
		wantActive    int64
		wantPrevious  int64
		wantRate      *float64
		wantTarget    *int64
		wantMet       *bool
	}{
		{"exact seven percent", GrowthWeek{Week: "2026-09-21", New: 7, Retained: 100}, tracked, 107, 100, growthFloat(7), growthInt(107), growthBool(true)},
		{"round whole device up", GrowthWeek{Week: "2026-09-21", Retained: 10}, tracked, 10, 10, growthFloat(0), growthInt(11), growthBool(false)},
		{"decline to zero", GrowthWeek{Week: "2026-09-21", Churned: 4}, tracked, 0, 4, growthFloat(-100), growthInt(5), growthBool(false)},
		{"zero baseline", GrowthWeek{Week: "2026-09-21", New: 1}, tracked, 1, 0, nil, nil, nil},
		{"current week provisional", GrowthWeek{Week: "2026-09-28", New: 7, Retained: 100}, tracked, 107, 100, nil, growthInt(107), nil},
		{"prior week partly tracked", GrowthWeek{Week: "2026-09-21", Retained: 100}, activityTime(t, "2026-09-20T12:00:00Z"), 100, 100, nil, nil, nil},
		{"this week partly tracked", GrowthWeek{Week: "2026-09-21", Retained: 100}, activityTime(t, "2026-09-21T12:00:00Z"), 100, 100, nil, nil, nil},
		{"tracking start unknown", GrowthWeek{Week: "2026-09-21", Retained: 100}, time.Time{}, 100, 100, nil, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			weeks := []GrowthWeek{tt.week}
			fillWeeklyGrowth(weeks, now, tt.trackingSince, "2026-09-01")
			w := weeks[0]
			if w.Active != tt.wantActive || w.PreviousActive != tt.wantPrevious || w.Change != tt.wantActive-tt.wantPrevious {
				t.Errorf("counts = %+v, want active=%d previous=%d", w, tt.wantActive, tt.wantPrevious)
			}
			if (w.GrowthRatePercent == nil) != (tt.wantRate == nil) || (w.GrowthRatePercent != nil && math.Abs(*w.GrowthRatePercent-*tt.wantRate) > 1e-9) {
				t.Errorf("growth rate = %v, want %v", w.GrowthRatePercent, tt.wantRate)
			}
			if (w.TargetActive == nil) != (tt.wantTarget == nil) || (w.TargetActive != nil && *w.TargetActive != *tt.wantTarget) {
				t.Errorf("target = %v, want %v", w.TargetActive, tt.wantTarget)
			}
			if (w.TargetMet == nil) != (tt.wantMet == nil) || (w.TargetMet != nil && *w.TargetMet != *tt.wantMet) {
				t.Errorf("target met = %v, want %v", w.TargetMet, tt.wantMet)
			}
		})
	}
}

func TestWeeklyGrowthKabulMondayAndHistoricalCoverage(t *testing.T) {
	weeks := []GrowthWeek{{Week: "2026-09-21", New: 7, Retained: 100}}
	tracked := activityTime(t, "2026-08-01T00:00:00Z")
	fillWeeklyGrowth(weeks, activityTime(t, "2026-09-27T19:29:59Z"), tracked, "2026-09-01")
	if weeks[0].Complete || weeks[0].GrowthRatePercent != nil || weeks[0].TargetMet != nil {
		t.Fatalf("one second before Kabul Monday got completed verdict: %+v", weeks[0])
	}
	fillWeeklyGrowth(weeks, activityTime(t, "2026-09-27T19:30:00Z"), tracked, "2026-09-01")
	if !weeks[0].Complete || weeks[0].GrowthRatePercent == nil || math.Abs(*weeks[0].GrowthRatePercent-7) > 1e-9 {
		t.Fatalf("Kabul Monday must complete last week: %+v", weeks[0])
	}

	// Before migration 036, date-only weeks start at UTC midnight. Tracking
	// that began Sunday 21:00 UTC is therefore available for the Monday week,
	// even though this instant is already Monday in Kabul.
	legacy := []GrowthWeek{{Week: "2026-08-17", Retained: 100}}
	fillWeeklyGrowth(legacy, activityTime(t, "2026-09-28T10:00:00Z"), activityTime(t, "2026-08-09T21:00:00Z"), "2026-09-01")
	if !legacy[0].TrackingComplete || !legacy[0].PreviousTrackingComplete || legacy[0].GrowthRatePercent == nil {
		t.Fatalf("legacy UTC coverage incorrectly reinterpreted as Kabul: %+v", legacy[0])
	}
	// Recomputing with incomplete coverage must clear an earlier verdict.
	fillWeeklyGrowth(legacy, activityTime(t, "2026-09-28T10:00:00Z"), activityTime(t, "2026-08-18T00:00:00Z"), "2026-09-01")
	if legacy[0].GrowthRatePercent != nil || legacy[0].TargetActive != nil || legacy[0].TargetMet != nil {
		t.Fatalf("stale verdict survived a coverage change: %+v", legacy[0])
	}
}

func TestWeeklyGrowthCalendarTransition(t *testing.T) {
	now := activityTime(t, "2026-09-28T10:00:00Z")
	tracked := activityTime(t, "2026-08-01T00:00:00Z")
	tests := []struct {
		name       string
		cutover    string
		week       string
		comparable bool
	}{
		{"last fully UTC comparison", "2026-09-01", "2026-08-24", true},
		{"midweek cutover", "2026-09-01", "2026-08-31", false},
		{"mixed previous week baseline", "2026-09-01", "2026-09-07", false},
		{"first two fully Kabul weeks", "2026-09-01", "2026-09-14", true},
		{"Sunday cutover same ISO week", "2026-09-06", "2026-08-31", false},
		{"Monday cutover may be mid-day", "2026-09-07", "2026-09-07", false},
		{"Monday cutover next baseline", "2026-09-07", "2026-09-14", false},
		{"unknown calendar cutover", "", "2026-09-21", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			weeks := []GrowthWeek{{Week: tt.week, New: 7, Retained: 100}}
			fillWeeklyGrowth(weeks, now, tracked, tt.cutover)
			w := weeks[0]
			if w.CalendarComparable != tt.comparable {
				t.Errorf("calendar_comparable = %v, want %v", w.CalendarComparable, tt.comparable)
			}
			if w.Active != 107 || w.PreviousActive != 100 || w.Change != 7 || !w.Complete || !w.TrackingComplete || !w.PreviousTrackingComplete {
				t.Fatalf("calendar gate must preserve counts and tracking coverage: %+v", w)
			}
			if tt.comparable {
				if w.GrowthRatePercent == nil || w.TargetActive == nil || w.TargetMet == nil || !*w.TargetMet {
					t.Errorf("valid calendar comparison lacks verdict: %+v", w)
				}
			} else if w.GrowthRatePercent != nil || w.TargetActive != nil || w.TargetMet != nil {
				t.Errorf("calendar transition received a verdict: %+v", w)
			}
		})
	}
	// Current-week goals must also avoid using the transition week's baseline.
	current := []GrowthWeek{{Week: "2026-09-28", Retained: 100}}
	fillWeeklyGrowth(current, now, tracked, "2026-09-21")
	if current[0].Complete || current[0].CalendarComparable || current[0].TargetActive != nil {
		t.Errorf("provisional transition comparison must have no target: %+v", current[0])
	}
}

func TestGetGrowthWeeklyActiveDevices(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")
	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET applied_at = '2026-09-01T00:00:00Z' WHERE name = '022_analytics_tracking.sql'`); err != nil {
		t.Fatalf("set activity tracking start: %v", err)
	}
	account := seedActivityAccount(t, pool)
	operator := seedActivityAccount(t, pool)
	firstPhone := seedActivityInstall(t, pool, &account, "2026-09-01T08:00:00Z")
	secondPhone := seedActivityInstall(t, pool, &account, "2026-09-01T08:00:00Z")
	anonymous := seedActivityInstall(t, pool, nil, "2026-09-21T08:00:00Z")
	opPhone := seedActivityInstall(t, pool, &operator, "2026-09-01T08:00:00Z")
	future := seedActivityInstall(t, pool, nil, "2026-10-01T08:00:00Z")
	for _, install := range []string{firstPhone, secondPhone, opPhone} {
		seedActivityHour(t, pool, install, "2026-09-14T08:00:00Z")
		seedActivityHour(t, pool, install, "2026-09-21T08:00:00Z")
	}
	seedActivityHour(t, pool, anonymous, "2026-09-21T08:00:00Z")
	seedActivityHour(t, pool, firstPhone, "2026-09-21T09:00:00Z")
	seedActivityHour(t, pool, firstPhone, "2026-09-22T08:00:00Z")
	seedActivityHour(t, pool, firstPhone, "2026-09-28T08:00:00Z")
	seedActivityHour(t, pool, opPhone, "2026-09-28T08:00:00Z")
	seedActivityHour(t, pool, future, "2026-10-01T08:00:00Z")
	svc := NewService(pool, []string{operator}, nil)
	svc.now = func() time.Time { return activityTime(t, "2026-09-28T10:00:00Z") }
	g, err := svc.GetGrowth(ctx)
	if err != nil {
		t.Fatalf("GetGrowth: %v", err)
	}
	if g.GrowthTargetPercent != 7 || g.ActivityTrackingSince != "2026-09-01T00:00:00Z" {
		t.Errorf("growth metadata = target %d tracking %q", g.GrowthTargetPercent, g.ActivityTrackingSince)
	}
	last := g.GrowthAccounting[len(g.GrowthAccounting)-2]
	if last.Week != "2026-09-21" || last.Active != 3 || last.PreviousActive != 2 || last.Change != 1 || !last.Complete || !last.TrackingComplete || !last.PreviousTrackingComplete {
		t.Fatalf("last completed week = %+v, want 3 distinct devices from baseline 2", last)
	}
	if last.GrowthRatePercent == nil || *last.GrowthRatePercent != 50 || last.TargetActive == nil || *last.TargetActive != 3 || last.TargetMet == nil || !*last.TargetMet {
		t.Errorf("last completed growth = %+v, want +50%% target 3 met", last)
	}
	current := g.GrowthAccounting[len(g.GrowthAccounting)-1]
	if current.Week != "2026-09-28" || current.Active != 1 || current.PreviousActive != 3 || current.Complete || current.GrowthRatePercent != nil || current.TargetMet != nil || current.TargetActive == nil || *current.TargetActive != 4 {
		t.Fatalf("provisional week = %+v, want 1 active target 4 without verdict", current)
	}
	// Nulls must remain explicit in JSON rather than becoming a misleading 0%.
	encoded, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"growth_rate_percent", "target_met"} {
		value, present := response[key]
		if !present || value != nil {
			t.Errorf("provisional JSON %s = %v (present=%v), want explicit null", key, value, present)
		}
	}
	// A damaged/manual migration log must not fabricate historical coverage.
	if _, err := pool.Exec(ctx, `DELETE FROM schema_migrations WHERE name = '022_analytics_tracking.sql'`); err != nil {
		t.Fatal(err)
	}
	unknown, err := svc.GetGrowth(ctx)
	if err != nil {
		t.Fatalf("GetGrowth with unknown tracking start: %v", err)
	}
	if unknown.ActivityTrackingSince != "" {
		t.Errorf("unknown tracking timestamp = %q, want empty", unknown.ActivityTrackingSince)
	}
	for _, w := range unknown.GrowthAccounting {
		if w.TrackingComplete || w.PreviousTrackingComplete || w.GrowthRatePercent != nil || w.TargetActive != nil || w.TargetMet != nil {
			t.Errorf("unknown coverage claimed a comparison: %+v", w)
		}
	}
}

func growthFloat(v float64) *float64 { return &v }
func growthInt(v int64) *int64       { return &v }
func growthBool(v bool) *bool        { return &v }
