package admin

import (
	"strings"
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestFirstRecognizedDevicesSeparatesResetsFromNewPhones(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-11-01")
	account := seedActivityAccount(t, pool)
	testAccount := seedActivityAccount(t, pool)
	if _, err := pool.Exec(ctx, `UPDATE accounts SET created_at='2026-11-01T19:00:00Z' WHERE id IN ($1,$2)`, account, testAccount); err != nil {
		t.Fatal(err)
	}
	seed := func(account *string, firstSeen, identifier string) string {
		t.Helper()
		id := seedActivityInstall(t, pool, account, firstSeen)
		if _, err := pool.Exec(ctx, `UPDATE installs SET platform='android', app_version='2.3.2',
			device_id_hash=NULLIF($2,''), device_id_kind=CASE WHEN $2 <> '' THEN 'android_id' END
			WHERE install_id=$1`, id, strings.Repeat(identifier, 64)); err != nil {
			t.Fatal(err)
		}
		return id
	}
	firstPhone := seed(&account, "2026-11-01T19:00:00Z", "a")
	reset := seed(&account, "2026-11-09T19:31:00Z", "a")
	newPhone := seed(&account, "2026-11-09T19:32:00Z", "b")
	unknownDevice := seed(&account, "2026-11-09T19:33:00Z", "")
	seed(&testAccount, "2026-11-01T19:10:00Z", "c")
	testReset := seed(nil, "2026-11-09T19:34:00Z", "c")
	if _, err := pool.Exec(ctx, `UPDATE installs SET installed_at='2026-11-09T19:29:59Z' WHERE install_id=$1`, newPhone); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, []string{testAccount}, nil)
	svc.now = func() time.Time { return activityTime(t, "2026-11-09T21:00:00Z") }
	for _, bucket := range []struct {
		kind, expected string
		points         int
	}{
		{"day", "2026-11-10", 12},
		{"hour", "2026-11-10T00:00", 24},
	} {
		stats, err := svc.GetStats(ctx, bucket.kind, bucket.points)
		if err != nil {
			t.Fatal(err)
		}
		firstSeen := map[string]int64{}
		for _, point := range stats.Series {
			if point.FirstRecognizedDevices > 0 {
				firstSeen[point.T] = point.FirstRecognizedDevices
			}
		}
		wantDays := 1
		if bucket.kind == "day" {
			wantDays++ // The first phone appears only in the longer daily range.
			if firstSeen["2026-11-01"] != 1 {
				t.Fatalf("first phone disappeared from historical device acquisition: %v", firstSeen)
			}
		}
		if len(firstSeen) != wantDays || firstSeen[bucket.expected] != 1 || stats.InstallsTotal != 5 {
			t.Fatalf("%s recognized devices %v or setup total %d incorrect", bucket.kind, firstSeen, stats.InstallsTotal)
		}
		feed := map[string]RecentInstall{}
		for _, row := range stats.LatestInstalls {
			feed[row.InstallID] = row
		}
		if feed[firstPhone].DeviceStatus != "first_recognized" || feed[firstPhone].ExistingAccount ||
			feed[reset].DeviceStatus != "returning" || !feed[reset].ExistingAccount ||
			feed[newPhone].DeviceStatus != "first_recognized" || !feed[newPhone].ExistingAccount ||
			feed[unknownDevice].DeviceStatus != "unverified" || !feed[unknownDevice].ExistingAccount ||
			feed[testReset].DeviceStatus != "returning" || feed[testReset].ExistingAccount {
			t.Fatalf("recent setups mixed up device and account identity: %+v", feed)
		}
	}
}
