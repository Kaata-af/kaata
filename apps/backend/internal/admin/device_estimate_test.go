package admin

import (
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestDeviceEstimatePreservesInstallsAndReportsCoverage(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	realAccount := seedActivityAccount(t, pool)
	operator := seedActivityAccount(t, pool)
	testAccount := seedActivityAccount(t, pool)
	androidOne := seedActivityInstall(t, pool, &realAccount, "2026-10-01T00:00:00Z")
	androidReinstall := seedActivityInstall(t, pool, &realAccount, "2026-10-02T00:00:00Z")
	iphone := seedActivityInstall(t, pool, nil, "2026-10-03T00:00:00Z")
	unknownOne := seedActivityInstall(t, pool, nil, "2026-10-04T00:00:00Z")
	seedActivityInstall(t, pool, nil, "2026-10-05T00:00:00Z")
	opInstall := seedActivityInstall(t, pool, &operator, "2026-10-06T00:00:00Z")
	testInstall := seedActivityInstall(t, pool, &testAccount, "2026-10-07T00:00:00Z")
	manualTest := seedActivityInstall(t, pool, nil, "2026-10-08T00:00:00Z")
	legacyOperator := seedActivityInstall(t, pool, nil, "2026-10-09T00:00:00Z")
	seedCredential(t, pool, legacyOperator, operator)
	for _, device := range []struct{ install, kind, hash string }{
		{androidOne, "android_id", strings.Repeat("a", 64)},
		{androidReinstall, "android_id", strings.Repeat("a", 64)},
		// The kind namespaces a match, even if a client reports the same hash.
		{iphone, "ios_idfv", strings.Repeat("a", 64)},
		// A test installation with the same hash must not exclude a real row.
		{opInstall, "android_id", strings.Repeat("a", 64)},
		{testInstall, "android_id", strings.Repeat("b", 64)},
		{manualTest, "ios_idfv", strings.Repeat("c", 64)},
		{legacyOperator, "android_id", strings.Repeat("d", 64)},
	} {
		if _, err := pool.Exec(ctx, `UPDATE installs SET device_id_kind=$2, device_id_hash=$3 WHERE install_id=$1::uuid`,
			device.install, device.kind, device.hash); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewService(pool, []string{operator}, nil)
	for _, exclusion := range []struct{ kind, id string }{{"account", testAccount}, {"install", manualTest}} {
		if _, err := svc.SetOutreachExclusion(ctx, exclusion.kind, exclusion.id, true, "testing"); err != nil {
			t.Fatal(err)
		}
	}
	check := func(want DeviceEstimate) {
		t.Helper()
		stats, err := svc.GetStats(ctx, "day", 1)
		if err != nil {
			t.Fatal(err)
		}
		users, err := svc.GetUsers(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if stats.DeviceEstimate != want || users.DeviceEstimate != want {
			t.Errorf("estimates stats=%+v users=%+v, want %+v", stats.DeviceEstimate, users.DeviceEstimate, want)
		}
		if stats.InstallsTotal != 5 {
			t.Errorf("install history was merged: total=%d, want 5", stats.InstallsTotal)
		}
		for _, user := range users.Users {
			if user.AccountID == realAccount && user.InstallCount != 2 {
				t.Errorf("linked install history changed: %d, want 2", user.InstallCount)
			}
		}
	}
	check(DeviceEstimate{EstimatedDevices: 4, IdentifiedDevices: 2, IdentifiedInstalls: 3, UnidentifiedInstalls: 2, TotalInstalls: 5})
	// A later upgraded app can supply an identifier, reducing uncertainty
	// without changing the number or history of recorded installations.
	if _, err := pool.Exec(ctx, `UPDATE installs SET device_id_kind='android_id', device_id_hash=$2 WHERE install_id=$1::uuid`,
		unknownOne, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	check(DeviceEstimate{EstimatedDevices: 3, IdentifiedDevices: 2, IdentifiedInstalls: 4, UnidentifiedInstalls: 1, TotalInstalls: 5})
}

func TestDeviceEstimateWithoutPlatformIdentifiers(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, nil, nil)
	for count := int64(0); count <= 2; count++ {
		if count > 0 {
			seedActivityInstall(t, pool, nil, "2026-10-01T00:00:00Z")
		}
		stats, err := svc.GetStats(t.Context(), "day", 1)
		if err != nil {
			t.Fatal(err)
		}
		want := DeviceEstimate{EstimatedDevices: count, UnidentifiedInstalls: count, TotalInstalls: count}
		if stats.DeviceEstimate != want {
			t.Errorf("unidentified estimate=%+v, want %+v", stats.DeviceEstimate, want)
		}
	}
}
