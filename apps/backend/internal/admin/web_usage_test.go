package admin

import (
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestWebUsageCountsDistinctBrowserAccountsByKabulDay(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	now := activityTime(t, "2026-11-10T19:33:00Z") // November 11, 00:03 in Kabul.
	tracking := activityTime(t, "2026-11-09T20:00:00Z")
	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET applied_at=$1
		WHERE name='097_admin_web_workspace_activity.sql'`, tracking); err != nil {
		t.Fatal(err)
	}
	seed := func(account *string, firstSeen, platform, version string) string {
		t.Helper()
		id := seedActivityInstall(t, pool, account, firstSeen)
		if _, err := pool.Exec(ctx, `UPDATE installs SET platform=$2, app_version=$3 WHERE install_id=$1`, id, platform, version); err != nil {
			t.Fatal(err)
		}
		return id
	}
	heartbeat := func(install, account, at string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO web_workspace_days (install_id, account_id, active_day, last_seen_at)
			VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'Asia/Kabul')::date, $3)`, install, account, activityTime(t, at)); err != nil {
			t.Fatal(err)
		}
	}
	mixed := seedActivityAccount(t, pool)
	browser := seed(&mixed, "2026-11-03T19:31:00Z", "unknown", "web")
	second := seed(&mixed, "2026-11-10T19:30:00Z", "web", "web")
	seed(&mixed, "2026-11-10T19:33:00Z", "ios", "2.3.2") // The phone checked in more recently.
	heartbeat(browser, mixed, "2026-11-10T19:29:00Z")
	heartbeat(browser, mixed, "2026-11-10T19:31:00Z")
	heartbeat(second, mixed, "2026-11-10T19:32:00Z")
	beforeTracking := seedActivityAccount(t, pool)
	beforeBrowser := seed(&beforeTracking, "2026-10-27T10:00:00Z", "web", "web")
	heartbeat(beforeBrowser, beforeTracking, "2026-11-09T19:59:00Z") // Before coverage began, despite same Kabul date.
	heartbeat(beforeBrowser, beforeTracking, "2026-11-08T20:00:00Z")

	newUser := seedActivityAccount(t, pool)
	newBrowser := seed(&newUser, "2026-11-10T19:28:00Z", "web", "web")
	heartbeat(newBrowser, newUser, "2026-11-10T19:28:00Z") // Inclusive five-minute boundary across midnight.
	signInOnly := seedActivityAccount(t, pool)
	seed(&signInOnly, "2026-11-10T19:31:00Z", "web", "web")
	stale := seedActivityAccount(t, pool)
	staleBrowser := seed(&stale, "2026-10-27T10:00:00Z", "web", "web")
	heartbeat(staleBrowser, stale, "2026-11-10T19:27:59Z")
	// A different account on the same install is not proof of that account's activity.
	heartbeat(staleBrowser, signInOnly, "2026-11-10T19:31:00Z")
	future := seedActivityAccount(t, pool)
	futureBrowser := seed(&future, "2026-10-27T10:00:00Z", "web", "web")
	heartbeat(futureBrowser, future, "2026-11-10T19:34:00Z")

	operator := seedActivityAccount(t, pool)
	excluded := seedActivityAccount(t, pool)
	excludedInstall := seedActivityAccount(t, pool)
	disabled := seedActivityAccount(t, pool)
	deleting := seedActivityAccount(t, pool)
	for _, account := range []string{operator, excluded, excludedInstall, disabled, deleting} {
		id := seed(&account, "2026-11-10T19:30:00Z", "web", "web")
		heartbeat(id, account, "2026-11-10T19:32:00Z")
		if account == excludedInstall {
			if _, err := pool.Exec(ctx, `INSERT INTO outreach_exclusions(kind,id,reason) VALUES ('install',$1,'fixture')`, id); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO outreach_exclusions(kind,id,reason) VALUES ('account',$1,'fixture')`, excluded); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET disabled_at=NOW() WHERE id=$1`, disabled); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1`, deleting); err != nil {
		t.Fatal(err)
	}
	seed(nil, "2026-11-10T19:30:00Z", "web", "web")

	svc := NewService(pool, []string{operator}, nil)
	svc.now = func() time.Time { return now }
	got, err := svc.GetWebUsage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.RecentAccounts != 2 || got.FirstSignIns7d != 2 || got.FirstSignInsPrevious7d != 1 {
		t.Fatalf("recent=%d new=%d previous=%d", got.RecentAccounts, got.FirstSignIns7d, got.FirstSignInsPrevious7d)
	}
	// Mixed and stale returned. Multiple browsers and days for mixed still
	// count once; the new user's check-in on their first Kabul day is excluded.
	if got.ReturningAccounts7d == nil || *got.ReturningAccounts7d != 2 || !got.Returning7dPartial {
		t.Fatalf("expected two returning accounts with partial weekly coverage: %+v", got)
	}
	if got.GeneratedAt != now.Format(time.RFC3339Nano) || got.TrackingStartedAt != tracking.Format(time.RFC3339Nano) ||
		len(got.Days) != 30 || got.Days[0].Day != "2026-10-13" {
		t.Fatalf("unexpected coverage: %+v", got)
	}
	byDay := make(map[string]WebUsageDay, len(got.Days))
	for _, day := range got.Days {
		byDay[day.Day] = day
	}
	if d := byDay["2026-11-04"]; d.ActiveAccounts != nil || d.FirstSignIns != 1 || d.IsPartial {
		t.Fatalf("first web sign-ins before heartbeat tracking: %+v", d)
	}
	if d := byDay["2026-11-09"]; d.ActiveAccounts != nil || d.ReturningAccounts != nil || d.IsPartial {
		t.Fatalf("history was fabricated before the first tracked day: %+v", d)
	}
	if d := byDay["2026-11-10"]; d.ActiveAccounts == nil || *d.ActiveAccounts != 3 || d.FirstSignIns != 1 || !d.IsPartial {
		t.Fatalf("first tracking day should show observed partial activity: %+v", d)
	}
	if d := byDay["2026-11-10"]; d.ReturningAccounts == nil || *d.ReturningAccounts != 2 {
		t.Fatalf("first-day activity was counted as returning: %+v", d)
	}
	if d := byDay["2026-11-11"]; d.ActiveAccounts == nil || *d.ActiveAccounts != 1 || d.FirstSignIns != 1 || !d.IsPartial {
		t.Fatalf("current day should deduplicate web activity across browsers: %+v", d)
	}
	if d := byDay["2026-11-11"]; d.ReturningAccounts == nil || *d.ReturningAccounts != 1 {
		t.Fatalf("returning accounts were counted more than once across browsers: %+v", d)
	}
}

func TestWebUsageReturningCoverageAndSevenDayBoundary(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	const migration = "097_admin_web_workspace_activity.sql"
	now := activityTime(t, "2026-11-10T19:33:00Z") // November 11, 00:03 in Kabul.
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return now }

	account := seedActivityAccount(t, pool)
	install := seedActivityInstall(t, pool, &account, "2026-11-01T13:00:00Z")
	if _, err := pool.Exec(ctx, `UPDATE installs SET platform='web', app_version='web' WHERE install_id=$1`, install); err != nil {
		t.Fatal(err)
	}
	// A real return just before Kabul midnight is visible in the daily report
	// but outside the latest seven Kabul dates.
	if _, err := pool.Exec(ctx, `INSERT INTO web_workspace_days (install_id, account_id, active_day, last_seen_at)
		VALUES ($1, $2, '2026-11-04', '2026-11-04T19:29:59Z')`, install, account); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET applied_at='2026-11-04T19:00:00Z' WHERE name=$1`, migration); err != nil {
		t.Fatal(err)
	}
	got, err := svc.GetWebUsage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.ReturningAccounts7d == nil || *got.ReturningAccounts7d != 0 || got.Returning7dPartial {
		t.Fatalf("expected full coverage with no returns inside the weekly window: %+v", got)
	}
	if day := got.Days[len(got.Days)-8]; day.Day != "2026-11-04" || day.ReturningAccounts == nil || *day.ReturningAccounts != 1 {
		t.Fatalf("return outside the weekly window was lost from daily history: %+v", day)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO web_workspace_days (install_id, account_id, active_day, last_seen_at)
		VALUES ($1, $2, '2026-11-05', '2026-11-04T19:30:00Z')`, install, account); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE schema_migrations SET applied_at='2026-11-04T19:30:00Z' WHERE name=$1`, migration); err != nil {
		t.Fatal(err)
	}
	got, err = svc.GetWebUsage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.ReturningAccounts7d == nil || *got.ReturningAccounts7d != 1 || got.Returning7dPartial {
		t.Fatalf("return at Kabul midnight should be included in a complete window: %+v", got)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM schema_migrations WHERE name=$1`, migration); err != nil {
		t.Fatal(err)
	}
	got, err = svc.GetWebUsage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.ReturningAccounts7d != nil || got.Returning7dPartial || got.Days[len(got.Days)-1].ReturningAccounts != nil {
		t.Fatalf("untracked returns should be unavailable: %+v", got)
	}
}
