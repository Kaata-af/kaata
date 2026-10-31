package admin

import (
	"reflect"
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

// Browser authentication uses a fresh credential UUID for every login. Those
// rows must remain useful for account platforms without inflating installations,
// device estimates, acquisition, or active-install history.
func TestBrowserSessionsDoNotBecomeAppInstallations(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	now := activityTime(t, "2026-10-31T17:15:00Z")
	setActivityCutover(t, pool, "2026-09-01")
	if _, err := pool.Exec(ctx, `UPDATE analytics_calendar SET started_at='2026-09-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	account := seedActivityAccount(t, pool)
	excludedAccount := seedActivityAccount(t, pool)
	var browserIDs []string
	var phoneID string
	var latestBrowserID string
	for _, fixture := range []struct {
		account           *string
		platform, version string
	}{
		{&account, "ios", "1.0"},
		{&account, "android", "1.0"},
		{&account, "web", "web"},
		{&account, "web", "web"},
		{&account, "web", "web"},
		{&account, "unknown", "web"}, // affirmative legacy browser marker
		{nil, "unknown", "unknown"},  // native auth stub; never guess web
		{&excludedAccount, "android", "1.0"},
		{&excludedAccount, "web", "web"},
	} {
		id := seedActivityInstall(t, pool, fixture.account, "2026-10-31T10:00:00Z")
		if _, err := pool.Exec(ctx, `UPDATE installs SET platform=$2, app_version=$3,
		  last_seen_at='2026-10-31T10:00:00Z', app_locale='en' WHERE install_id=$1::uuid`, id, fixture.platform, fixture.version); err != nil {
			t.Fatal(err)
		}
		seedActivityHour(t, pool, id, "2026-10-31T10:00:00Z")
		if fixture.version == "web" {
			browserIDs = append(browserIDs, id)
			if fixture.account == &account {
				latestBrowserID = id
			}
		} else if fixture.platform == "ios" {
			phoneID = id
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE installs SET self_name='Mobile profile', self_phone='+93700000001',
	  shop_name='Mobile shop', source='qr' WHERE install_id=$1::uuid`, phoneID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE installs SET last_seen_at='2026-10-31T17:00:00Z' WHERE install_id=$1::uuid`, latestBrowserID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO outreach_exclusions(kind,id,reason) VALUES('account',$1,'fixture')`, excludedAccount); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return now }
	stats, err := svc.GetStats(ctx, "hour", 24)
	if err != nil {
		t.Fatal(err)
	}
	if stats.UsersTotal != 2 || stats.UsersAccounts != 1 || stats.UsersAnonymous != 1 ||
		stats.InstallsTotal != 3 || stats.ExcludedInstalls != 1 || stats.WebAccountsTotal != 1 || stats.WebActive7d != 1 ||
		stats.DAU != 3 || stats.WAU != 3 || stats.MAU != 3 || stats.DeviceEstimate.TotalInstalls != 3 {
		t.Fatalf("browser sessions distorted report: %+v", stats)
	}
	if len(stats.LatestInstalls) != 3 {
		t.Fatalf("recent app installs included browser sessions: %+v", stats.LatestInstalls)
	}
	for _, recent := range stats.LatestInstalls {
		for _, browser := range browserIDs {
			if recent.InstallID == browser {
				t.Fatal("browser credential appeared as a new app install")
			}
		}
	}
	var installs, active int64
	for _, point := range stats.Series {
		installs += point.Installs
		active += point.Active
	}
	if installs != 3 || active != 3 {
		t.Fatalf("hourly installation/activity totals=%d/%d, want 3/3", installs, active)
	}
	users, err := svc.GetUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if users.TotalInstalls != 4 || users.AnonymousCount != 1 || users.DeviceEstimate.TotalInstalls != 3 {
		t.Fatalf("directory raw app installs / excluded estimate disagree: %+v", users)
	}
	for _, user := range users.Users {
		if user.AccountID == account && (user.InstallCount != 2 || user.WebSessionCount != 4 ||
			!reflect.DeepEqual(user.Platforms, []string{"android", "ios", "web"}) || user.Platform != "web" ||
			user.LedgerName != "Mobile profile" || user.LedgerPhone != "+93700000001" || user.ShopName != "Mobile shop" || user.Source != "qr") {
			t.Fatalf("account platforms were lost or browser sessions counted as installations: %+v", user)
		}
		if user.AccountID == excludedAccount && user.ExcludedInstalls != 1 {
			t.Fatalf("browser test session counted as excluded app install: %+v", user)
		}
	}
	growth, err := svc.GetGrowth(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var cohortSize int64
	for _, cohort := range growth.WeeklyCohorts {
		cohortSize += cohort.Size
	}
	if cohortSize != 3 || growth.ExcludedInstalls != 1 || growth.GrowthAccounting[len(growth.GrowthAccounting)-1].Active != 3 {
		t.Fatalf("browser sessions distorted native growth/cohorts: %+v", growth)
	}
	comparison, err := svc.GetDayComparisons(ctx, nil, "today-yesterday")
	if err != nil {
		t.Fatal(err)
	}
	point := comparison.Days[0].Points[comparison.Days[0].CompletedHours]
	if point.Active == nil || point.Installs == nil || *point.Active != 3 || *point.Installs != 3 {
		t.Fatalf("browser sessions distorted day comparison: %+v", point)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM installs`).Scan(&count); err != nil || count != 9 {
		t.Fatalf("report changed authentication/session history: count=%d err=%v", count, err)
	}
}

func TestOutreachKeepsAllAccountPlatformsAndSessionIDs(t *testing.T) {
	stamp := time.Now()
	group := &outreachShopGroup{installs: []*outreachInstall{
		{installID: "web-2", platform: "web", firstSeen: stamp, lastSeen: stamp},
		{installID: "android", platform: "android", firstSeen: stamp, lastSeen: stamp, source: "qr", attribution: "ip_match"},
		{installID: "ios", platform: "ios", firstSeen: stamp, lastSeen: stamp},
		{installID: "web-1", platform: "web", firstSeen: stamp, lastSeen: stamp},
	}}
	got := buildOutreachShopkeeper(group, nil, nil).sk
	if !reflect.DeepEqual(got.Platforms, []string{"android", "ios", "web"}) || got.Platform != "web" ||
		got.InstallCount != 2 || got.WebSessionCount != 2 || len(got.InstallIDs) != 4 || got.Source != "qr" || got.Attribution != "ip_match" {
		t.Fatalf("outreach lost account platforms or exclusion identities: %+v", got)
	}
}
