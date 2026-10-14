package admin

import (
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// The hourly chart counts a device once in each Kabul hour, without summing
// those counts into DAU. The recent-install feed must exclude the same test
// data, including deleted-account and legacy-credential links.
func TestHourlyStatsKabulBoundariesAndExclusions(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")
	if _, err := pool.Exec(ctx, `UPDATE analytics_calendar SET started_at = '2026-09-01T08:04:05Z'`); err != nil {
		t.Fatal(err)
	}
	real := seedActivityAccount(t, pool)
	operator := seedActivityAccount(t, pool)
	testAccount := seedActivityAccount(t, pool)
	retiredOperator := seedActivityAccount(t, pool)
	realPhone := seedActivityInstall(t, pool, &real, "2026-09-13T19:29:57Z")
	anonymous := seedActivityInstall(t, pool, nil, "2026-09-13T19:30:04Z")
	opPhone := seedActivityInstall(t, pool, &operator, "2026-09-13T19:29:57Z")
	testPhone := seedActivityInstall(t, pool, &testAccount, "2026-09-13T19:29:57Z")
	excludedInstall := seedActivityInstall(t, pool, nil, "2026-09-13T19:29:57Z")
	legacyCredential := seedActivityInstall(t, pool, nil, "2026-09-13T19:29:57Z")
	seedCredential(t, pool, legacyCredential, operator)
	purged := seedActivityInstall(t, pool, &retiredOperator, "2026-09-13T19:29:57Z")
	purgeAccount(t, pool, retiredOperator, purged)
	for _, id := range []string{realPhone, opPhone, testPhone, excludedInstall, legacyCredential, purged} {
		seedActivityHour(t, pool, id, "2026-09-13T19:29:59Z")
		seedActivityHour(t, pool, id, "2026-09-13T19:30:00Z")
		seedActivityHour(t, pool, id, "2026-09-13T20:00:00Z") // same Kabul hour
	}
	seedActivityHour(t, pool, anonymous, "2026-09-13T19:30:04Z")
	seedActivityHour(t, pool, anonymous, "2026-09-13T20:30:00Z") // future hour

	svc := NewService(pool, []string{operator, retiredOperator}, nil)
	for _, x := range []struct{ kind, id string }{{"account", testAccount}, {"install", excludedInstall}} {
		if _, err := svc.SetOutreachExclusion(ctx, x.kind, x.id, true, "test data"); err != nil {
			t.Fatal(err)
		}
	}
	now := activityTime(t, "2026-09-13T20:12:34Z")
	svc.now = func() time.Time { return now }
	st, err := svc.GetStats(ctx, "hour", 3)
	if err != nil {
		t.Fatal(err)
	}
	want := []SeriesPoint{
		{T: "2026-09-13T22:00", Installs: 0, Active: 0},
		{T: "2026-09-13T23:00", Installs: 1, Active: 1},
		{T: "2026-09-14T00:00", Installs: 1, Active: 2},
	}
	if !reflect.DeepEqual(st.Series, want) {
		t.Errorf("series = %+v, want %+v", st.Series, want)
	}
	if st.DAU != 2 || st.WAU != 2 || st.MAU != 2 {
		t.Errorf("DAU/WAU/MAU = %d/%d/%d, want 2/2/2", st.DAU, st.WAU, st.MAU)
	}
	if st.HourlyTrackingSince != "2026-09-01T08:04:05Z" || st.GeneratedAt != "2026-09-13T20:12:34Z" {
		t.Errorf("hourly tracking/as of = %q/%q", st.HourlyTrackingSince, st.GeneratedAt)
	}
	if len(st.LatestInstalls) != 2 || st.LatestInstalls[0].InstallID != anonymous || st.LatestInstalls[1].InstallID != realPhone {
		t.Errorf("latest installs = %+v, want only the two real installs newest first", st.LatestInstalls)
	}
}

// An old installed_at backfill or a fast device clock must not move a server-
// observed install into a later hour. A genuine earlier device time remains
// visible; missing device timestamps fall back to server first_seen_at.
func TestHourlyStatsEffectiveInstallTimeAndTimezone(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")
	// One microsecond after the hour is an incomplete hour. Preserve this
	// precision in the API so the dashboard cannot treat it as fully tracked.
	if _, err := pool.Exec(ctx, `UPDATE analytics_calendar SET started_at = '2026-10-14T19:30:00.000001Z'`); err != nil {
		t.Fatal(err)
	}
	account := seedActivityAccount(t, pool)
	fastClock := seedActivityInstall(t, pool, &account, "2026-10-14T19:29:57Z")
	earlierDevice := seedActivityInstall(t, pool, nil, "2026-10-14T19:45:12Z")
	missingTime := seedActivityInstall(t, pool, nil, "2026-10-14T19:30:04Z")
	futureObserved := seedActivityInstall(t, pool, nil, "2026-10-14T20:10:00Z")
	if _, err := pool.Exec(ctx, `
		UPDATE installs SET installed_at = CASE install_id
		  WHEN $1::uuid THEN '2026-10-14T21:00:00Z'::timestamptz
		  WHEN $2::uuid THEN '2026-10-14T19:10:09Z'::timestamptz
		  WHEN $3::uuid THEN NULL
		  ELSE '2026-10-14T18:00:00Z'::timestamptz END,
		  self_name = 'Device name', platform = 'android'
		WHERE install_id IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
	`, fastClock, earlierDevice, missingTime, futureObserved); err != nil {
		t.Fatal(err)
	}
	now := activityTime(t, "2026-10-14T20:05:06Z")
	var baseline Stats
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
			svc.now = func() time.Time { return now }
			st, err := svc.GetStats(ctx, "hour", 2)
			if err != nil {
				t.Fatal(err)
			}
			want := []SeriesPoint{{T: "2026-10-14T23:00", Installs: 2}, {T: "2026-10-15T00:00", Installs: 1}}
			if !reflect.DeepEqual(st.Series, want) {
				t.Errorf("series = %+v, want %+v", st.Series, want)
			}
			wantRecent := []RecentInstall{
				{InstallID: missingTime, Name: "Device name", Platform: "android", InstalledAt: "2026-10-14T19:30:04Z", FirstSeenAt: "2026-10-14T19:30:04Z"},
				{InstallID: fastClock, Name: "Activity test", Platform: "android", InstalledAt: "2026-10-14T19:29:57Z", FirstSeenAt: "2026-10-14T19:29:57Z"},
				{InstallID: earlierDevice, Name: "Device name", Platform: "android", InstalledAt: "2026-10-14T19:10:09Z", FirstSeenAt: "2026-10-14T19:45:12Z"},
			}
			if !reflect.DeepEqual(st.LatestInstalls, wantRecent) {
				t.Errorf("recent feed = %+v, want %+v", st.LatestInstalls, wantRecent)
			}
			if st.HourlyTrackingSince != "2026-10-14T19:30:00.000001Z" {
				t.Errorf("hourly tracking boundary = %q", st.HourlyTrackingSince)
			}
			if zone == "UTC" {
				baseline = st
			} else if !reflect.DeepEqual(st, baseline) {
				t.Errorf("stats depend on database timezone %s", zone)
			}
		})
	}
}

func TestLatestInstallsBoundedAndEmptyArrays(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return activityTime(t, "2026-10-15T12:00:00Z") }
	empty, err := svc.GetStats(ctx, "hour", 24)
	if err != nil {
		t.Fatal(err)
	}
	if empty.LatestInstalls == nil || len(empty.LatestInstalls) != 0 {
		t.Errorf("empty latest installs = %#v, want an empty non-nil slice", empty.LatestInstalls)
	}
	var ids []string
	for n := range 12 {
		at := activityTime(t, "2026-10-15T10:00:00Z").Add(time.Duration(n) * time.Minute)
		ids = append(ids, seedActivityInstall(t, pool, nil, at.Format(time.RFC3339)))
	}
	st, err := svc.GetStats(ctx, "hour", 24)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.LatestInstalls) != 10 {
		t.Fatalf("latest feed length = %d, want 10", len(st.LatestInstalls))
	}
	for n, row := range st.LatestInstalls {
		if row.InstallID != ids[11-n] || row.Name != "" || row.Platform != "" {
			t.Errorf("feed[%d] = %+v, want id=%s with empty optional profile fields", n, row, ids[11-n])
		}
	}
}
