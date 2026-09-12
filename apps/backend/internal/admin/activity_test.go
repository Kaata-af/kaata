package admin

import (
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/db"
	"github.com/matee/kaata-backend/internal/testutil"
)

// These fixtures contain check-ins without ledger events. Anonymous installs,
// and signed-in people who only opened the app, must appear in both the chart
// and DAU. Kabul midnight is 19:30 UTC, not a UTC hour boundary.
func TestGetStatsActivityKabulMidnight(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")

	account := seedActivityAccount(t, pool)
	operator := seedActivityAccount(t, pool)
	anonymous := seedActivityInstall(t, pool, nil, "2026-09-12T10:00:00Z")
	signedIn := seedActivityInstall(t, pool, &account, "2026-09-13T19:29:59Z")
	opInstall := seedActivityInstall(t, pool, &operator, "2026-09-13T19:29:59Z")
	seedActivityHour(t, pool, anonymous, "2026-09-12T10:00:00Z")
	seedActivityHour(t, pool, anonymous, "2026-09-13T18:00:00Z")
	seedActivityHour(t, pool, signedIn, "2026-09-13T19:29:59Z")
	seedActivityHour(t, pool, opInstall, "2026-09-13T19:29:59Z")

	svc := NewService(pool, []string{operator}, nil)
	now := activityTime(t, "2026-09-13T19:29:59Z")
	svc.now = func() time.Time { return now }

	before, err := svc.GetStats(ctx, "day", 3)
	if err != nil {
		t.Fatalf("GetStats before midnight: %v", err)
	}
	assertActivityToday(t, before, "2026-09-13", 2)
	if before.ActivityTimezoneSince != "2026-09-01" {
		t.Errorf("activity timezone cutover = %q, want 2026-09-01", before.ActivityTimezoneSince)
	}
	if got := before.Series[len(before.Series)-1].Installs; got != 1 {
		t.Errorf("installs before midnight = %d, want 1 (operator excluded)", got)
	}

	// Merely moving the clock across local midnight must start a new empty day.
	now = activityTime(t, "2026-09-13T19:30:00Z")
	after, err := svc.GetStats(ctx, "day", 3)
	if err != nil {
		t.Fatalf("GetStats at midnight: %v", err)
	}
	assertActivityToday(t, after, "2026-09-14", 0)
	if got := after.Series[len(after.Series)-2].Active; got != 2 {
		t.Errorf("yesterday active = %d, want 2", got)
	}
	if after.WAU != 2 || after.MAU != 2 {
		t.Errorf("WAU/MAU at midnight = %d/%d, want 2/2", after.WAU, after.MAU)
	}

	seedActivityHour(t, pool, anonymous, "2026-09-13T19:30:00Z")
	seedActivityHour(t, pool, opInstall, "2026-09-13T19:30:00Z")
	day, err := svc.GetStats(ctx, "day", 3)
	if err != nil {
		t.Fatalf("GetStats after first check-in: %v", err)
	}
	assertActivityToday(t, day, "2026-09-14", 1)

	hour, err := svc.GetStats(ctx, "hour", 2)
	if err != nil {
		t.Fatalf("GetStats hourly: %v", err)
	}
	if len(hour.Series) != 2 {
		t.Fatalf("hour series length = %d, want 2", len(hour.Series))
	}
	if got := hour.Series[0]; got.T != "2026-09-13T23:00" || got.Active != 1 {
		t.Errorf("previous local hour = %+v, want 2026-09-13T23:00 active=1", got)
	}
	if got := hour.Series[1]; got.T != "2026-09-14T00:00" || got.Active != 1 {
		t.Errorf("current local hour = %+v, want 2026-09-14T00:00 active=1", got)
	}

	// The same install in another hour remains one active install per day,
	// week, and month. The new local Monday also starts the weekly bucket.
	seedActivityHour(t, pool, anonymous, "2026-09-13T20:30:00Z")
	now = activityTime(t, "2026-09-13T20:40:00Z")
	for _, tc := range []struct {
		bucket string
		label  string
		active int64
	}{
		{"day", "2026-09-14", 1},
		{"week", "2026-09-14", 1},
		{"month", "2026-09", 2},
	} {
		t.Run(tc.bucket, func(t *testing.T) {
			st, err := svc.GetStats(ctx, tc.bucket, 2)
			if err != nil {
				t.Fatalf("GetStats: %v", err)
			}
			got := st.Series[len(st.Series)-1]
			if got.T != tc.label || got.Active != tc.active {
				t.Errorf("latest bucket = %+v, want %s active=%d", got, tc.label, tc.active)
			}
			if st.DAU != 1 || st.WAU != 2 || st.MAU != 2 {
				t.Errorf("DAU/WAU/MAU = %d/%d/%d, want 1/2/2", st.DAU, st.WAU, st.MAU)
			}
		})
	}
}

// The database server/session timezone must not change calendar buckets,
// window boundaries, or retention. Use separate pools so every connection
// executes with the requested timezone, including after a pool reconnect.
func TestGetStatsActivityIgnoresSessionTimezone(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")
	install := seedActivityInstall(t, pool, nil, "2026-09-12T19:30:00Z")
	seedActivityHour(t, pool, install, "2026-09-12T19:30:00Z")
	seedActivityHour(t, pool, install, "2026-09-13T19:30:00Z")
	now := activityTime(t, "2026-09-13T19:30:00Z")

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
				t.Fatalf("create timezone pool: %v", err)
			}
			defer zonedPool.Close()
			svc := NewService(zonedPool, nil, nil)
			svc.now = func() time.Time { return now }
			st, err := svc.GetStats(ctx, "day", 3)
			if err != nil {
				t.Fatalf("GetStats: %v", err)
			}
			assertActivityToday(t, st, "2026-09-14", 1)
			if st.RetD1Eligible != 1 || st.RetD1Retained != 1 {
				t.Errorf("D1 eligible/retained = %d/%d, want 1/1", st.RetD1Eligible, st.RetD1Retained)
			}
			if zone == "UTC" {
				baseline = st
			} else if !reflect.DeepEqual(st, baseline) {
				t.Errorf("stats depend on session timezone %s:\n got %+v\nwant %+v", zone, st, baseline)
			}
		})
	}
}

// A UTC-only historical day stays on its recorded date. After the declared
// cutover, UTC rows must not leak into the local calendar or double count the
// canonical activity view. In particular, a UTC September 1 check-in at
// 19:30 belongs exclusively to Kabul September 2.
func TestAdminActiveDaysPreservesLegacyCalendar(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")
	install := seedActivityInstall(t, pool, nil, "2026-08-31T10:00:00Z")
	if _, err := pool.Exec(ctx, `
		INSERT INTO install_active_days (install_id, active_date, had_usage)
		VALUES ($1::uuid, '2026-08-31', TRUE), ($1::uuid, '2026-09-01', FALSE)
	`, install); err != nil {
		t.Fatalf("seed legacy days: %v", err)
	}
	seedActivityHour(t, pool, install, "2026-09-01T19:30:00Z")
	seedActivityHour(t, pool, install, "2026-09-01T20:30:00Z")
	rows, err := pool.Query(ctx, `
		SELECT active_date::text FROM admin_active_days
		WHERE install_id = $1::uuid ORDER BY active_date
	`, install)
	if err != nil {
		t.Fatalf("read canonical days: %v", err)
	}
	defer rows.Close()
	var days []string
	for rows.Next() {
		var day string
		if err := rows.Scan(&day); err != nil {
			t.Fatalf("scan active day: %v", err)
		}
		days = append(days, day)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate active days: %v", err)
	}
	if want := []string{"2026-08-31", "2026-09-02"}; !reflect.DeepEqual(days, want) {
		t.Errorf("canonical active dates = %v, want %v", days, want)
	}
	var legacyRows int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM install_active_days WHERE install_id = $1::uuid`, install).Scan(&legacyRows); err != nil {
		t.Fatalf("read preserved legacy rows: %v", err)
	}
	if legacyRows != 2 {
		t.Errorf("legacy rows = %d, want 2 unchanged", legacyRows)
	}
}

// Exercise the real forward migration over existing records. ConnectTestDB
// provides an isolated, reset test schema; only that fixture schema is rewound.
// Seed only evidence the old deployment actually knew: UTC days plus the most
// recent check-in timestamp. Auth-only install stubs must not gain activity.
func TestActivityMigrationPreservesHistoryAndSeedsToday(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `
		DROP VIEW admin_active_days, admin_install_dates;
		DROP TABLE install_active_hours, analytics_calendar;
		DELETE FROM schema_migrations WHERE name = '036_kabul_activity.sql';
	`); err != nil {
		t.Fatalf("rewind activity migration in test schema: %v", err)
	}
	var now time.Time
	if err := pool.QueryRow(ctx, `SELECT NOW()`).Scan(&now); err != nil {
		t.Fatalf("read migration reference time: %v", err)
	}
	operator := seedActivityAccount(t, pool)
	anonymous := seedActivityInstall(t, pool, nil, now.Format(time.RFC3339Nano))
	opInstall := seedActivityInstall(t, pool, &operator, now.Format(time.RFC3339Nano))
	stub := seedActivityInstall(t, pool, nil, now.Format(time.RFC3339Nano))
	old := seedActivityInstall(t, pool, nil, now.Add(-48*time.Hour).Format(time.RFC3339Nano))
	for _, id := range []string{anonymous, opInstall, old} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO install_active_days (install_id, active_date, had_usage)
			SELECT install_id, (last_seen_at AT TIME ZONE 'UTC')::date, TRUE
			FROM installs WHERE install_id = $1::uuid
		`, id); err != nil {
			t.Fatalf("seed pre-migration activity: %v", err)
		}
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("apply activity migration: %v", err)
	}
	var legacyCount, legacyUsageCount, seededCount, stubOrOldCount int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*), COUNT(*) FILTER (WHERE had_usage) FROM install_active_days
	`).Scan(&legacyCount, &legacyUsageCount); err != nil {
		t.Fatalf("read preserved UTC history: %v", err)
	}
	if legacyCount != 3 || legacyUsageCount != 3 {
		t.Errorf("legacy rows/usage rows = %d/%d, want 3/3 unchanged", legacyCount, legacyUsageCount)
	}
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*), COUNT(*) FILTER (WHERE install_id IN ($1::uuid, $2::uuid))
		FROM install_active_hours
	`, stub, old).Scan(&seededCount, &stubOrOldCount); err != nil {
		t.Fatalf("read seeded activity hours: %v", err)
	}
	if seededCount != 2 || stubOrOldCount != 0 {
		t.Errorf("seeded hours/stub-or-old hours = %d/%d, want 2/0", seededCount, stubOrOldCount)
	}
	var movedLegacyDates int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM install_active_days d JOIN installs i USING (install_id)
		WHERE d.active_date <> (i.last_seen_at AT TIME ZONE 'UTC')::date
	`).Scan(&movedLegacyDates); err != nil {
		t.Fatalf("check preserved UTC dates: %v", err)
	}
	if movedLegacyDates != 0 {
		t.Errorf("migration moved %d legacy dates, want none", movedLegacyDates)
	}
	svc := NewService(pool, []string{operator}, nil)
	svc.now = func() time.Time { return now }
	st, err := svc.GetStats(ctx, "day", 3)
	if err != nil {
		t.Fatalf("GetStats after migration: %v", err)
	}
	kabul := time.FixedZone("Asia/Kabul", 4*60*60+30*60)
	assertActivityToday(t, st, now.In(kabul).Format("2006-01-02"), 1)
}

func TestGetGrowthStartsWeekAtKabulMidnight(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")
	install := seedActivityInstall(t, pool, nil, "2026-09-13T19:29:59Z")
	seedActivityHour(t, pool, install, "2026-09-13T19:29:59Z")
	svc := NewService(pool, nil, nil)
	now := activityTime(t, "2026-09-13T19:29:59Z")
	svc.now = func() time.Time { return now }
	before, err := svc.GetGrowth(ctx)
	if err != nil {
		t.Fatalf("GetGrowth before Monday: %v", err)
	}
	if got := before.GrowthAccounting[len(before.GrowthAccounting)-1]; got.Week != "2026-09-07" || got.New != 1 {
		t.Errorf("Sunday growth = %+v, want week 2026-09-07 new=1", got)
	}

	now = activityTime(t, "2026-09-13T19:30:00Z")
	seedActivityHour(t, pool, install, "2026-09-13T19:30:00Z")
	after, err := svc.GetGrowth(ctx)
	if err != nil {
		t.Fatalf("GetGrowth at Monday midnight: %v", err)
	}
	if got := after.GrowthAccounting[len(after.GrowthAccounting)-1]; got.Week != "2026-09-14" || got.New != 0 || got.Retained != 1 || got.Churned != 0 {
		t.Errorf("Monday growth = %+v, want week 2026-09-14 retained=1", got)
	}
	cohort := after.WeeklyCohorts[len(after.WeeklyCohorts)-2]
	if cohort.Week != "2026-09-07" || cohort.Size != 1 || !reflect.DeepEqual(cohort.Retained, []int64{1, 1}) {
		t.Errorf("Sunday cohort after Monday rollover = %+v, want week 2026-09-07 size=1 retained=[1 1]", cohort)
	}
}

func setActivityCutover(t *testing.T, pool *pgxpool.Pool, date string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `UPDATE analytics_calendar SET kabul_since = $1::date WHERE singleton`, date); err != nil {
		t.Fatalf("set activity cutover: %v", err)
	}
}

func seedActivityAccount(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(t.Context(), `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, $2, TRUE, 'Activity test') RETURNING id::text
	`, "activity-"+uuid.NewString(), uuid.NewString()+"@example.test").Scan(&id); err != nil {
		t.Fatalf("seed activity account: %v", err)
	}
	return id
}

func seedActivityInstall(t *testing.T, pool *pgxpool.Pool, account *string, at string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO installs (install_id, account_id, installed_at, first_seen_at, last_seen_at)
		VALUES ($1::uuid, $2::uuid, $3, $3, $3)
	`, id, account, activityTime(t, at)); err != nil {
		t.Fatalf("seed activity install: %v", err)
	}
	return id
}

func seedActivityHour(t *testing.T, pool *pgxpool.Pool, install, at string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO install_active_hours (install_id, active_hour)
		VALUES ($1::uuid, date_trunc('hour', $2::timestamptz AT TIME ZONE 'Asia/Kabul') AT TIME ZONE 'Asia/Kabul')
		ON CONFLICT DO NOTHING
	`, install, activityTime(t, at)); err != nil {
		t.Fatalf("seed activity hour: %v", err)
	}
}

func activityTime(t *testing.T, value string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse fixture time: %v", err)
	}
	return at
}

func assertActivityToday(t *testing.T, st Stats, label string, want int64) {
	t.Helper()
	if len(st.Series) == 0 {
		t.Fatal("activity series is empty")
	}
	last := st.Series[len(st.Series)-1]
	if last.T != label || last.Active != want || st.DAU != want {
		t.Errorf("today = %s chart=%d DAU=%d, want %s chart=DAU=%d", last.T, last.Active, st.DAU, label, want)
	}
}
