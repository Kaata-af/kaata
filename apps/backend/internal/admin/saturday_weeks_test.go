package admin

import (
	"os"
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestSaturdayWeekBoundaryMatchesKabulAndSQL(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	for _, tt := range []struct{ at, want string }{
		{"2026-09-18T19:29:59Z", "2026-09-12"}, // Friday 23:59:59
		{"2026-09-18T19:30:00Z", "2026-09-19"}, // Saturday 00:00
		{"2026-09-20T19:30:00Z", "2026-09-19"}, // Monday is not a rollover
		{"2026-12-31T19:30:00Z", "2026-12-26"}, // New Year Friday
		{"2027-01-01T19:30:00Z", "2027-01-02"}, // First Saturday of next year
	} {
		t.Run(tt.at, func(t *testing.T) {
			at := activityTime(t, tt.at)
			if got := kabulWeekStart(at); got != tt.want {
				t.Errorf("Go reporting week = %s, want %s", got, tt.want)
			}
			var got string
			if err := pool.QueryRow(t.Context(), `SELECT to_char(admin_bucket_start('week', $1::timestamptz AT TIME ZONE 'Asia/Kabul'), 'YYYY-MM-DD')`, at).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("SQL reporting week = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestSaturdayMigrationPreservesMondayHistoryAndRecountsActualWindows(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	// Replay the actual upgrade over a populated migration-058 table. The
	// deliberately different Monday count must never become a Saturday count.
	if _, err := pool.Exec(ctx, `
		ALTER TABLE admin_growth_weeks DROP COLUMN week_starts_on;
		DROP FUNCTION admin_bucket_start(TEXT, TIMESTAMP);
		INSERT INTO admin_growth_weeks(week,rules,new_installs,retained,resurrected,churned,recorded_at)
		VALUES('2026-09-21','legacy-monday-rules',999,88,7,6,'2026-09-28T10:00:00Z');
	`); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../db/migrations/060_admin_saturday_weeks.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("upgrade populated Monday history: %v", err)
	}
	setActivityCutover(t, pool, "2026-09-01")
	setTrackingStart(t, pool, "2026-09-01T00:00:00Z")
	first := seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z")
	second := seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z")
	seedActivityHour(t, pool, first, "2026-09-18T19:29:59Z")
	seedActivityHour(t, pool, second, "2026-09-18T19:30:00Z")
	seedActivityHour(t, pool, first, "2026-09-25T19:29:59Z") // Friday counts too
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return activityTime(t, "2026-09-25T19:30:00Z") }
	g := mustGrowth(t, svc)
	if g.WeekStartsOn != int(time.Saturday) {
		t.Fatalf("API week starts on %d, want Saturday", g.WeekStartsOn)
	}
	previous := growthWeek(t, g, "2026-09-12")
	last := growthWeek(t, g, "2026-09-19")
	if previous.Active != 1 || last.Active != 2 || last.PreviousActive != 1 || !last.Complete || last.GrowthRatePercent == nil || *last.GrowthRatePercent != 100 {
		t.Fatalf("Saturday windows = previous %+v, completed %+v; want 1 then 2 active, +100%%", previous, last)
	}
	st, err := svc.GetStats(ctx, "week", 3)
	if err != nil {
		t.Fatal(err)
	}
	if st.WeekStartsOn != 6 || len(st.Series) != 3 || st.Series[0].T != "2026-09-12" || st.Series[0].Active != 1 || st.Series[1].T != "2026-09-19" || st.Series[1].Active != 2 || st.Series[2].T != "2026-09-26" || st.Series[2].Active != 0 {
		t.Fatalf("activity series disagrees with growth windows: %+v", st.Series)
	}
	var starts, newCount, retained, resurrected, churned int
	var rules string
	if err := pool.QueryRow(ctx, `SELECT week_starts_on,rules,new_installs,retained,resurrected,churned FROM admin_growth_weeks WHERE week='2026-09-21'`).Scan(&starts, &rules, &newCount, &retained, &resurrected, &churned); err != nil {
		t.Fatal(err)
	}
	if starts != 1 || rules != "legacy-monday-rules" || newCount != 999 || retained != 88 || resurrected != 7 || churned != 6 {
		t.Fatalf("legacy Monday aggregate was rewritten: %d %s %d %d %d %d", starts, rules, newCount, retained, resurrected, churned)
	}
	var frozen, unfinished int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FILTER (WHERE week='2026-09-19'), COUNT(*) FILTER (WHERE week='2026-09-26') FROM admin_growth_weeks WHERE week_starts_on=6`).Scan(&frozen, &unfinished); err != nil {
		t.Fatal(err)
	}
	if frozen != 1 || unfinished != 0 {
		t.Errorf("Saturday aggregates frozen/current = %d/%d, want 1/0", frozen, unfinished)
	}
}
