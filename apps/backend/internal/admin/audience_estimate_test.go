package admin

import (
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestAudienceEstimateDeduplicatesResetsWithoutCollapsingAccounts(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	account := seedActivityAccount(t, pool)
	sharedAccount := seedActivityAccount(t, pool)
	seedActivityAccount(t, pool) // An account without a recorded installation still counts.
	operator := seedActivityAccount(t, pool)
	testAccount := seedActivityAccount(t, pool)
	seed := func(account *string, day, platform, kind, hash string) string {
		t.Helper()
		id := seedActivityInstall(t, pool, account, "2026-10-"+day+"T00:00:00Z")
		if _, err := pool.Exec(ctx, `
			UPDATE installs SET platform=$2, device_id_kind=$3, device_id_hash=$4 WHERE install_id=$1::uuid
		`, id, platform, kind, strings.Repeat(hash, 64)); err != nil {
			t.Fatal(err)
		}
		return id
	}
	seed(&account, "01", "android", "android_id", "a")
	seed(&sharedAccount, "02", "android", "android_id", "a")
	reset := seed(nil, "03", "android", "android_id", "a")
	firstAnonymous := seed(nil, "04", "android", "android_id", "b")
	seed(nil, "05", "android", "android_id", "b")
	seed(nil, "06", "ios", "ios_idfv", "b") // The identifier kind namespaces a match.
	unknown := seedActivityInstall(t, pool, nil, "2026-10-07T00:00:00Z")
	if _, err := pool.Exec(ctx, `UPDATE installs SET self_name='Activity test' WHERE install_id=$1`, unknown); err != nil {
		t.Fatal(err)
	}
	seed(&operator, "08", "android", "android_id", "c")
	seed(nil, "09", "android", "android_id", "c") // Fresh setup before the operator signs in.
	seed(&testAccount, "10", "android", "android_id", "d")
	seed(nil, "11", "android", "android_id", "d")
	manual := seed(nil, "12", "android", "android_id", "e")
	seed(nil, "13", "web", "android_id", "f") // Browser setup never enters the native estimate.

	svc := NewService(pool, []string{operator}, nil)
	for _, exclusion := range []struct{ kind, id string }{{"account", testAccount}, {"install", manual}} {
		if _, err := svc.SetOutreachExclusion(ctx, exclusion.kind, exclusion.id, true, "testing"); err != nil {
			t.Fatal(err)
		}
	}
	check := func(rawAccounts, rawAnonymous int64, want AudienceEstimate) {
		t.Helper()
		stats := assertStatsUserTotals(t, svc, rawAccounts, rawAnonymous)
		if stats.AudienceEstimate != want || stats.InstallsTotal != 9 {
			t.Fatalf("audience estimate=%+v, installs=%d, want %+v and 9", stats.AudienceEstimate, stats.InstallsTotal, want)
		}
	}
	want := AudienceEstimate{
		EstimatedUsers: 6, SignedInAccounts: 3, SignedOutRecognizedDevices: 2,
		SignedOutUnidentifiedInstalls: 1, RepeatSignedOutSetups: 4,
	}
	check(3, 7, want)
	linkTestInstall(t, pool, reset, &account)
	want.RepeatSignedOutSetups--
	check(3, 6, want)

	newAccount := seedActivityAccount(t, pool)
	linkTestInstall(t, pool, firstAnonymous, &newAccount)
	want.SignedInAccounts++
	want.SignedOutRecognizedDevices--
	check(4, 5, want)
}

func TestAudienceEstimateUsesProvenCurrentAccountLinks(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	if got := assertStatsUserTotals(t, svc, 0, 0).AudienceEstimate; got != (AudienceEstimate{}) {
		t.Fatalf("empty audience estimate=%+v", got)
	}
	account := seedActivityAccount(t, pool)
	legacy := seedActivityInstall(t, pool, nil, "2026-10-01T00:00:00Z")
	reset := seedActivityInstall(t, pool, nil, "2026-10-02T00:00:00Z")
	if _, err := pool.Exec(ctx, `
		UPDATE installs SET platform='android', device_id_kind='android_id', device_id_hash=$3
		WHERE install_id IN ($1::uuid, $2::uuid)
	`, legacy, reset, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	seedCredential(t, pool, legacy, account)
	want := AudienceEstimate{EstimatedUsers: 1, SignedInAccounts: 1, RepeatSignedOutSetups: 1}
	if got := assertStatsUserTotals(t, svc, 1, 1).AudienceEstimate; got != want {
		t.Fatalf("audience with active credential=%+v, want %+v", got, want)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_credentials SET revoked_at=NOW() WHERE install_id=$1`, legacy); err != nil {
		t.Fatal(err)
	}
	want.EstimatedUsers++
	want.SignedOutRecognizedDevices++
	if got := assertStatsUserTotals(t, svc, 1, 2).AudienceEstimate; got != want {
		t.Fatalf("audience with only revoked credential=%+v, want %+v", got, want)
	}
}
