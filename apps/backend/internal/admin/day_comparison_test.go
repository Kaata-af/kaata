package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

func assertComparisonPoint(t *testing.T, day ComparedDay, hour int, active, installs *int64) {
	t.Helper()
	if len(day.Points) != 25 {
		t.Fatalf("%s has %d points, want all 25 boundaries", day.Date, len(day.Points))
	}
	point := day.Points[hour]
	if point.Hour != hour || !reflect.DeepEqual(point.Active, active) || !reflect.DeepEqual(point.Installs, installs) {
		t.Errorf("%s point %d = %+v, want active=%v installs=%v", day.Date, hour, point, active, installs)
	}
}

func comparisonCount(count int64) *int64 { return &count }

func assertHourlyComparisonPoint(t *testing.T, day ComparedDay, hour int, active, installs *int64) {
	t.Helper()
	if len(day.Points) != 25 {
		t.Fatalf("%s has %d points, want all 25 boundaries", day.Date, len(day.Points))
	}
	point := day.Points[hour]
	if !reflect.DeepEqual(point.HourlyActive, active) || !reflect.DeepEqual(point.HourlyInstalls, installs) {
		t.Errorf("%s hour preceding %d = %+v, want active=%v installs=%v", day.Date, hour, point, active, installs)
	}
}

func TestDayComparisonCumulativeDistinctInstallsAndExclusions(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `UPDATE analytics_calendar SET started_at='2026-09-01T08:04:05Z'`); err != nil {
		t.Fatal(err)
	}
	account, operator, testAccount, retiredOperator := seedActivityAccount(t, pool), seedActivityAccount(t, pool), seedActivityAccount(t, pool), seedActivityAccount(t, pool)
	first := seedActivityInstall(t, pool, &account, "2026-10-20T19:30:00Z") // Today midnight.
	second := seedActivityInstall(t, pool, &account, "2026-10-20T20:29:59.999999Z")
	third := seedActivityInstall(t, pool, nil, "2026-10-20T20:30:00Z") // Exactly the 01:00 cutoff.
	yesterday := seedActivityInstall(t, pool, nil, "2026-10-20T07:45:00Z")
	seedActivityInstall(t, pool, nil, "2026-10-20T19:29:59.999999Z") // Yesterday, just before midnight.
	fastClock := seedActivityInstall(t, pool, nil, "2026-10-20T21:45:00Z")
	earlierDevice := seedActivityInstall(t, pool, nil, "2026-10-21T00:00:00Z")
	unfinished := seedActivityInstall(t, pool, nil, "2026-10-21T07:30:00Z") // Today 12:00, unfinished.
	futureObserved := seedActivityInstall(t, pool, nil, "2026-10-21T08:00:00Z")
	if _, err := pool.Exec(ctx, `UPDATE installs SET installed_at=CASE install_id
	 WHEN $1::uuid THEN NULL WHEN $2::uuid THEN '2026-10-22T00:00:00Z'::timestamptz
	 WHEN $3::uuid THEN '2026-10-20T23:29:59.999999Z'::timestamptz
	 ELSE '2026-10-20T20:00:00Z'::timestamptz END
	 WHERE install_id IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`, second, fastClock, earlierDevice, futureObserved); err != nil {
		t.Fatal(err)
	}
	// Activity units stay installations even if two share an account and a
	// recognized phone identifier. This is deliberately not a device estimate.
	if _, err := pool.Exec(ctx, `UPDATE installs SET device_id_kind='android_id',device_id_hash=$3
	 WHERE install_id IN ($1::uuid,$2::uuid)`, first, second, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	for _, event := range []struct{ install, at string }{
		{first, "2026-10-20T19:30:00Z"},
		{first, "2026-10-20T21:30:00Z"},
		{first, "2026-10-21T06:30:00Z"},
		{second, "2026-10-20T20:30:00Z"},
		{third, "2026-10-20T21:30:00Z"},
		{yesterday, "2026-10-19T19:30:00Z"},
		{yesterday, "2026-10-20T18:30:00Z"},
		{yesterday, "2026-10-20T19:30:00Z"},
		{yesterday, "2026-10-20T22:30:00Z"},
		{unfinished, "2026-10-21T07:30:00Z"},
	} {
		seedActivityHour(t, pool, event.install, event.at)
	}
	opInstall := seedActivityInstall(t, pool, &operator, "2026-10-20T20:00:00Z")
	testInstall := seedActivityInstall(t, pool, &testAccount, "2026-10-20T20:00:00Z")
	manual := seedActivityInstall(t, pool, nil, "2026-10-20T20:00:00Z")
	legacy := seedActivityInstall(t, pool, nil, "2026-10-20T20:00:00Z")
	seedCredential(t, pool, legacy, operator)
	retired := seedActivityInstall(t, pool, &retiredOperator, "2026-10-20T20:00:00Z")
	purgeAccount(t, pool, retiredOperator, retired)
	for _, install := range []string{opInstall, testInstall, manual, legacy, retired} {
		seedActivityHour(t, pool, install, "2026-10-20T19:30:00Z")
	}
	svc := NewService(pool, []string{operator, retiredOperator}, nil)
	for _, excluded := range []struct{ kind, id string }{{"account", testAccount}, {"install", manual}} {
		if _, err := svc.SetOutreachExclusion(ctx, excluded.kind, excluded.id, true, "comparison fixture"); err != nil {
			t.Fatal(err)
		}
	}
	now := activityTime(t, "2026-10-21T07:47:30.123456Z") // Kabul 12:17.
	clockReads := 0
	svc.now = func() time.Time { clockReads++; return now }
	result, err := svc.GetDayComparison(ctx, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if clockReads != 1 || result.GeneratedAt != "2026-10-21T07:47:30.123456Z" || result.Day.Date != "2026-10-21" || result.CompareDay.Date != "2026-10-20" || result.MinDate != "2026-07-24" || result.MaxDate != "2026-10-21" {
		t.Fatalf("wrong server calendar or captured instant: reads=%d result=%+v", clockReads, result)
	}
	if result.Day.CompletedHours != 12 || result.CompareDay.CompletedHours != 24 || !result.Day.ActivityAvailable || !result.CompareDay.ActivityAvailable {
		t.Fatalf("wrong completed coverage: day=%+v compare=%+v", result.Day, result.CompareDay)
	}
	if len(result.Days) != 2 || !reflect.DeepEqual(result.Day, result.Days[0]) || !reflect.DeepEqual(result.CompareDay, result.Days[1]) {
		t.Fatalf("legacy aliases and ordered days disagree: %+v", result)
	}
	assertComparisonPoint(t, result.Day, 0, comparisonCount(0), comparisonCount(0))
	assertComparisonPoint(t, result.Day, 1, comparisonCount(2), comparisonCount(2))
	assertComparisonPoint(t, result.Day, 2, comparisonCount(3), comparisonCount(3))
	assertComparisonPoint(t, result.Day, 3, comparisonCount(4), comparisonCount(4))
	for hour := 4; hour <= 12; hour++ {
		assertComparisonPoint(t, result.Day, hour, comparisonCount(4), comparisonCount(5))
	}
	for hour := 13; hour <= 24; hour++ {
		assertComparisonPoint(t, result.Day, hour, nil, nil)
		assertHourlyComparisonPoint(t, result.Day, hour, nil, nil)
	}
	assertHourlyComparisonPoint(t, result.Day, 0, nil, nil)
	assertHourlyComparisonPoint(t, result.Day, 1, comparisonCount(2), comparisonCount(2))
	assertHourlyComparisonPoint(t, result.Day, 2, comparisonCount(1), comparisonCount(1))
	// At 02:00–03:00 both a returning install and a newly active one appear:
	// the true hourly count is two, while cumulative distinct increases by one.
	assertHourlyComparisonPoint(t, result.Day, 3, comparisonCount(2), comparisonCount(1))
	assertHourlyComparisonPoint(t, result.Day, 12, comparisonCount(1), comparisonCount(0))
	assertComparisonPoint(t, result.CompareDay, 0, comparisonCount(0), comparisonCount(0))
	assertComparisonPoint(t, result.CompareDay, 1, comparisonCount(1), comparisonCount(0))
	assertComparisonPoint(t, result.CompareDay, 12, comparisonCount(1), comparisonCount(0))
	assertComparisonPoint(t, result.CompareDay, 13, comparisonCount(1), comparisonCount(1))
	assertComparisonPoint(t, result.CompareDay, 24, comparisonCount(1), comparisonCount(2))
	assertHourlyComparisonPoint(t, result.CompareDay, 24, comparisonCount(1), comparisonCount(1))
	wire, err := json.Marshal(result)
	if err != nil || !strings.Contains(string(wire), `"hour":13,"active":null,"installs":null,"hourly_active":null,"hourly_installs":null`) {
		t.Fatalf("future points must use explicit JSON null: %s err=%v", wire, err)
	}
}

func TestDayComparisonCoverageMidnightAndTimezone(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `UPDATE analytics_calendar SET started_at='2026-10-19T19:30:00.000001Z'`); err != nil {
		t.Fatal(err)
	}
	install := seedActivityInstall(t, pool, nil, "2026-10-19T19:30:00Z")
	seedActivityHour(t, pool, install, "2026-10-19T19:30:00Z")
	seedActivityHour(t, pool, install, "2026-10-20T06:30:00Z")
	now := activityTime(t, "2026-10-21T07:47:30Z")
	var baseline DayComparison
	for _, zone := range []string{"UTC", "America/Los_Angeles", "Pacific/Auckland"} {
		t.Run(zone, func(t *testing.T) {
			config := pool.Config()
			params := make(map[string]string, len(config.ConnConfig.RuntimeParams)+1)
			for key, value := range config.ConnConfig.RuntimeParams {
				params[key] = value
			}
			params["timezone"] = zone
			config.ConnConfig.RuntimeParams = params
			zonedPool, err := pgxpool.NewWithConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			defer zonedPool.Close()
			svc := NewService(zonedPool, nil, nil)
			// The returned time can carry any host zone. Browser timezone headers
			// also cannot change this endpoint's fixed Kabul calendar.
			svc.now = func() time.Time { return now.In(time.FixedZone(zone, -7*60*60)) }
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/v1/admin/day-comparison?day=2026-10-20&compare_day=2026-10-21&timezone="+zone, nil)
			r.Header.Set("X-Timezone", zone)
			NewHandler(svc).DayComparison(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("comparison handler=%d %s", w.Code, w.Body.String())
			}
			var result DayComparison
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.TrackingSince != "2026-10-19T19:30:00.000001Z" || result.Day.ActivityAvailable || !result.CompareDay.ActivityAvailable {
				t.Fatalf("fractional tracking boundary lost: %+v", result)
			}
			for hour := range 25 {
				installs := int64(1)
				if hour == 0 {
					installs = 0
				}
				assertComparisonPoint(t, result.Day, hour, nil, &installs)
			}
			// Prefix coverage is unavailable for this partial tracking day, but
			// later complete hours are still valid hourly observations.
			assertHourlyComparisonPoint(t, result.Day, 0, nil, nil)
			assertHourlyComparisonPoint(t, result.Day, 1, nil, comparisonCount(1))
			assertHourlyComparisonPoint(t, result.Day, 2, comparisonCount(0), comparisonCount(0))
			assertHourlyComparisonPoint(t, result.Day, 12, comparisonCount(1), comparisonCount(0))
			assertComparisonPoint(t, result.CompareDay, 12, comparisonCount(0), comparisonCount(0))
			assertComparisonPoint(t, result.CompareDay, 13, nil, nil)
			assertHourlyComparisonPoint(t, result.CompareDay, 13, nil, nil)
			if zone == "UTC" {
				baseline = result
			} else if !reflect.DeepEqual(result, baseline) {
				t.Errorf("comparison depends on session/host/browser timezone %s", zone)
			}
		})
	}
	// Exactly midnight is fully tracked; even one microsecond after it above
	// made the entire day's activity prefixes unknown rather than false zeroes.
	if _, err := pool.Exec(ctx, `UPDATE analytics_calendar SET started_at='2026-10-19T19:30:00Z'`); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return activityTime(t, "2026-10-20T19:30:00Z") }
	midnight, err := svc.GetDayComparison(ctx, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if midnight.Day.CompletedHours != 0 || !midnight.Day.ActivityAvailable || !midnight.CompareDay.ActivityAvailable {
		t.Fatalf("midnight coverage=%+v", midnight)
	}
	assertComparisonPoint(t, midnight.Day, 0, comparisonCount(0), comparisonCount(0))
	assertHourlyComparisonPoint(t, midnight.Day, 0, nil, nil)
	for hour := 1; hour <= 24; hour++ {
		assertComparisonPoint(t, midnight.Day, hour, nil, nil)
		assertHourlyComparisonPoint(t, midnight.Day, hour, nil, nil)
	}
	assertComparisonPoint(t, midnight.CompareDay, 24, comparisonCount(1), comparisonCount(1))
	// Selecting the same date twice remains two independently named series.
	same, err := svc.GetDayComparison(ctx, "2026-10-20", "2026-10-20")
	if err != nil || !reflect.DeepEqual(same.Day, same.CompareDay) {
		t.Fatalf("same-date comparison=%+v err=%v", same, err)
	}
	if len(same.Days) != 2 || !reflect.DeepEqual(same.Days[0], same.Days[1]) {
		t.Fatal("legacy duplicate dates must remain supported")
	}
}

func TestDayComparisonsSevenDaysPreserveRequestedOrder(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `UPDATE analytics_calendar SET started_at='2026-09-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	labels := []string{"2026-10-17", "2026-10-21", "2026-10-15", "2026-10-20", "2026-10-16", "2026-10-19", "2026-10-18"}
	kabul := time.FixedZone("Asia/Kabul", 4*60*60+30*60)
	for index, label := range labels {
		start, err := time.ParseInLocation("2006-01-02", label, kabul)
		if err != nil {
			t.Fatal(err)
		}
		for count := 0; count <= index; count++ {
			install := seedActivityInstall(t, pool, nil, start.Add(5*time.Minute).Format(time.RFC3339))
			seedActivityHour(t, pool, install, start.Format(time.RFC3339))
			seedActivityHour(t, pool, install, start.Add(time.Hour).Format(time.RFC3339))
		}
	}
	svc := NewService(pool, nil, nil)
	clockReads := 0
	svc.now = func() time.Time { clockReads++; return activityTime(t, "2026-10-21T07:47:30Z") }
	result, err := svc.GetDayComparisons(ctx, labels, "")
	if err != nil {
		t.Fatal(err)
	}
	if clockReads != 1 || len(result.Days) != len(labels) {
		t.Fatalf("clock reads=%d days=%d, want one captured instant and seven days", clockReads, len(result.Days))
	}
	for index, day := range result.Days {
		if day.Date != labels[index] {
			t.Errorf("day[%d]=%s, want requested %s", index, day.Date, labels[index])
		}
		count := comparisonCount(int64(index + 1))
		assertComparisonPoint(t, day, 2, count, count)
		assertHourlyComparisonPoint(t, day, 1, count, count)
		assertHourlyComparisonPoint(t, day, 2, count, comparisonCount(0))
	}
	if !reflect.DeepEqual(result.Day, result.Days[0]) || !reflect.DeepEqual(result.CompareDay, result.Days[1]) {
		t.Fatal("legacy aliases must use the first two requested days")
	}
	for _, query := range []string{"days=" + strings.Join(labels, ","), "preset=last7", "preset=last7-complete", "preset=same-weekday", "preset=today-yesterday"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/v1/admin/day-comparison?"+query, nil)
		NewHandler(svc).DayComparison(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("valid multi-day query %s=%d %s", query, w.Code, w.Body.String())
		}
		var response DayComparison
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(response.Day, response.Days[0]) || !reflect.DeepEqual(response.CompareDay, response.Days[1]) {
			t.Fatal("HTTP response aliases disagree with ordered days")
		}
		if strings.HasPrefix(query, "days=") && !reflect.DeepEqual(response, result) {
			t.Fatal("custom-date HTTP response changed requested order or metrics")
		}
	}
}

func TestDayComparisonsHourlyCoverageUsesExactBucketStart(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	install := seedActivityInstall(t, pool, nil, "2026-10-19T19:30:00Z")
	seedActivityHour(t, pool, install, "2026-10-20T04:30:00Z") // Kabul 09:00.
	seedActivityHour(t, pool, install, "2026-10-20T05:30:00Z") // Returning at 10:00.
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return activityTime(t, "2026-10-21T07:47:30Z") }
	for _, tc := range []struct {
		started string
		hour10  *int64
	}{
		{"2026-10-20T04:30:00Z", comparisonCount(1)},
		{"2026-10-20T04:30:00.000001Z", nil},
	} {
		if _, err := pool.Exec(ctx, `UPDATE analytics_calendar SET started_at=$1::timestamptz`, tc.started); err != nil {
			t.Fatal(err)
		}
		result, err := svc.GetDayComparisons(ctx, []string{"2026-10-20", "2026-10-21"}, "")
		if err != nil {
			t.Fatal(err)
		}
		if result.Day.ActivityAvailable || result.Day.Points[24].Active != nil || result.TrackingSince != tc.started {
			t.Fatalf("mid-day cutover invented whole-day coverage: %+v", result)
		}
		assertHourlyComparisonPoint(t, result.Day, 9, nil, comparisonCount(0))
		assertHourlyComparisonPoint(t, result.Day, 10, tc.hour10, comparisonCount(0))
		assertHourlyComparisonPoint(t, result.Day, 11, comparisonCount(1), comparisonCount(0))
		assertHourlyComparisonPoint(t, result.Day, 12, comparisonCount(0), comparisonCount(0))
	}
}

func TestDayComparisonsPresetCalendarAtKabulMidnight(t *testing.T) {
	for _, tc := range []struct {
		preset string
		before []string
		after  []string
	}{
		{"today-yesterday", []string{"2026-10-20", "2026-10-19"}, []string{"2026-10-21", "2026-10-20"}},
		{"last7", []string{"2026-10-20", "2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14"}, []string{"2026-10-21", "2026-10-20", "2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15"}},
		{"last7-complete", []string{"2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13"}, []string{"2026-10-20", "2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14"}},
		{"same-weekday", []string{"2026-10-20", "2026-10-13", "2026-10-06", "2026-09-29", "2026-09-22"}, []string{"2026-10-21", "2026-10-14", "2026-10-07", "2026-09-30", "2026-09-23"}},
	} {
		for _, instant := range []struct {
			name, now string
			want      []string
		}{{"before", "2026-10-20T19:29:59.999999Z", tc.before}, {"at midnight", "2026-10-20T19:30:00Z", tc.after}} {
			t.Run(tc.preset+"/"+instant.name, func(t *testing.T) {
				_, result, err := dayComparisonsDates(activityTime(t, instant.now), nil, tc.preset)
				if err != nil {
					t.Fatal(err)
				}
				var labels []string
				for _, day := range result.Days {
					labels = append(labels, day.Date)
					if tc.preset == "last7-complete" && day.CompletedHours != 24 {
						t.Error("complete preset included an unfinished day")
					}
				}
				if !reflect.DeepEqual(labels, instant.want) {
					t.Errorf("preset dates=%v, want %v", labels, instant.want)
				}
				if instant.name == "at midnight" && tc.preset != "last7-complete" && result.Days[0].CompletedHours != 0 {
					t.Error("new Kabul day must have zero completed hours")
				}
			})
		}
	}
}

func TestDayComparisonsRejectInvalidSelectionBeforeDatabase(t *testing.T) {
	now := activityTime(t, "2026-10-21T07:47:30Z")
	svc := NewService(nil, nil, nil)
	svc.now = func() time.Time { return now }
	for _, tc := range []struct {
		name, preset string
		days         []string
	}{
		{"missing", "", nil},
		{"empty list", "", []string{}},
		{"one date", "", []string{"2026-10-21"}},
		{"duplicate", "", []string{"2026-10-21", "2026-10-21"}},
		{"empty date", "", []string{"2026-10-21", ""}},
		{"invalid calendar", "", []string{"2026-10-21", "2026-02-30"}},
		{"future", "", []string{"2026-10-21", "2026-10-22"}},
		{"out of range", "", []string{"2026-10-21", "2026-07-23"}},
		{"eight dates", "", []string{"2026-10-21", "2026-10-20", "2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14"}},
		{"unknown preset", "week", nil},
		{"mixed selection", "last7", []string{"2026-10-21", "2026-10-20"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.GetDayComparisons(t.Context(), tc.days, tc.preset); !errors.Is(err, ErrDayComparisonDate) {
				t.Fatalf("invalid selection reached database or wrong error: %v", err)
			}
		})
	}
	for _, query := range []string{
		"days=", "days=2026-10-21", "days=2026-10-21,2026-10-21", "days=2026-10-21,", "days=,",
		"days=2026-10-21,2026-10-22", "days=2026-10-21,2026-07-23", "days=2026-10-21,2026-02-30",
		"days=2026-10-21,2026-10-20,2026-10-19,2026-10-18,2026-10-17,2026-10-16,2026-10-15,2026-10-14",
		"preset=", "preset=week", "preset=last7&days=2026-10-21,2026-10-20",
		"preset=last7&day=2026-10-21", "preset=last7&compare_day=", "days=2026-10-21,2026-10-20&day=",
		"days=2026-10-21,2026-10-20&days=2026-10-19,2026-10-18", "preset=last7&preset=same-weekday",
	} {
		t.Run(query, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/v1/admin/day-comparison?"+query, nil)
			NewHandler(svc).DayComparison(w, r)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("invalid multi-date query status=%d, want400: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestDayComparisonDatesValidateServerWindow(t *testing.T) {
	now := activityTime(t, "2026-10-20T20:00:00Z") // October 21 in Kabul.
	dates, defaults, err := dayComparisonDates(now, "", "")
	if err != nil || defaults.Day.Date != "2026-10-21" || defaults.CompareDay.Date != "2026-10-20" || defaults.Day.CompletedHours != 0 || defaults.CompareDay.CompletedHours != 24 || defaults.MinDate != "2026-07-24" {
		t.Fatalf("defaults=%+v dates=%v err=%v", defaults, dates, err)
	}
	if _, _, err := dayComparisonDates(now, "2026-07-24", "2026-10-21"); err != nil {
		t.Fatalf("inclusive valid boundaries: %v", err)
	}
	svc := NewService(nil, nil, nil)
	svc.now = func() time.Time { return now }
	for _, value := range []string{"2026-07-23", "2026-10-22", "2026-02-30", "2026-10-32", "2026-1-01", "2026-10-21T00:00:00Z", "yesterday", " 2026-10-21"} {
		for _, parameter := range []string{"day", "compare_day"} {
			t.Run(parameter+"/"+value, func(t *testing.T) {
				day, compare := value, ""
				if parameter == "compare_day" {
					day, compare = "", value
				}
				if _, err := svc.GetDayComparison(t.Context(), day, compare); !errors.Is(err, ErrDayComparisonDate) {
					t.Fatalf("invalid date reached database or wrong error: %v", err)
				}
				w := httptest.NewRecorder()
				r := httptest.NewRequest(http.MethodGet, "/v1/admin/day-comparison?"+parameter+"="+strings.ReplaceAll(value, " ", "%20"), nil)
				NewHandler(svc).DayComparison(w, r)
				if w.Code != http.StatusBadRequest {
					t.Fatalf("invalid date status=%d, want400: %s", w.Code, w.Body.String())
				}
			})
		}
	}
}
