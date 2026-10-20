package checkin

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/matee/kaata-backend/internal/testutil"
)

func deviceEstimateString(value string) *string { return &value }

func TestValidatedDeviceEstimate(t *testing.T) {
	hash := strings.Repeat("a1", 32)
	for _, tc := range []struct {
		name, platform string
		hash, kind     *string
		valid          bool
	}{
		{"android", "android", &hash, deviceEstimateString("android_id"), true},
		{"ios", "ios", &hash, deviceEstimateString("ios_idfv"), true},
		{"older client", "android", nil, nil, false},
		{"hash missing", "android", nil, deviceEstimateString("android_id"), false},
		{"kind missing", "android", &hash, nil, false},
		{"empty", "android", deviceEstimateString(""), deviceEstimateString("android_id"), false},
		{"raw android ID", "android", deviceEstimateString("a1b2c3d4e5f67890"), deviceEstimateString("android_id"), false},
		{"raw IDFV", "ios", deviceEstimateString(uuid.NewString()), deviceEstimateString("ios_idfv"), false},
		{"uppercase", "android", deviceEstimateString(strings.ToUpper(hash)), deviceEstimateString("android_id"), false},
		{"nonhex", "android", deviceEstimateString(strings.Repeat("g", 64)), deviceEstimateString("android_id"), false},
		{"too long", "android", deviceEstimateString(hash + "a"), deviceEstimateString("android_id"), false},
		{"ios kind on android", "android", &hash, deviceEstimateString("ios_idfv"), false},
		{"android kind on ios", "ios", &hash, deviceEstimateString("android_id"), false},
		{"unknown kind", "android", &hash, deviceEstimateString("mac"), false},
		{"unknown platform", "web", &hash, deviceEstimateString("android_id"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gotHash, gotKind := validatedDeviceEstimate(tc.platform, tc.hash, tc.kind)
			if !tc.valid {
				if gotHash != nil || gotKind != nil {
					t.Fatalf("invalid optional pair accepted: %v %v", gotHash, gotKind)
				}
				return
			}
			if gotHash == nil || gotKind == nil || *gotHash != *tc.hash || *gotKind != *tc.kind {
				t.Fatal("valid pair was changed or dropped")
			}
		})
	}
}

func TestDeviceEstimatePreservesInstallHistoryAndPinsFirstValidPair(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, "", nil)
	first, second, ios := uuid.NewString(), uuid.NewString(), uuid.NewString()
	hash, kind := strings.Repeat("a1", 32), "android_id"
	accountA := seedCheckInAccount(t, pool)
	var accountB string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts(email) VALUES('another-device-test@example.test') RETURNING id::text`).Scan(&accountB); err != nil {
		t.Fatal(err)
	}
	installed := time.Now().Add(-30 * 24 * time.Hour).Truncate(time.Millisecond)
	installedMS, usage, onboarded := installed.UnixMilli(), 3, true
	req := Request{InstallID: first, AppVersion: "1.0.0", Platform: "android",
		InstalledAtUnixMS: &installedMS, UsageEntriesCreated: &usage, HasOnboarded: &onboarded}
	if _, err := svc.Handle(WithActorAccountID(ctx, accountA), req, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO install_active_days(install_id,active_date,had_usage) VALUES($1,'2025-01-01',TRUE)`, first); err != nil {
		t.Fatal(err)
	}
	// An existing installation can learn its identity after upgrading without
	// creating a new install or changing its account, usage, or start date.
	req.UsageEntriesCreated = nil
	req.InstalledAtUnixMS = nil
	req.DeviceIDHash, req.DeviceIDKind = &hash, &kind
	if _, err := svc.Handle(ctx, req, ""); err != nil {
		t.Fatal(err)
	}
	for _, pair := range []struct{ hash, kind *string }{
		{nil, nil}, // Old client after the first new-client check-in.
		{deviceEstimateString("raw-android-id"), &kind},
		{&hash, nil},
		{&hash, deviceEstimateString("ios_idfv")},
		{deviceEstimateString(strings.Repeat("b2", 32)), &kind}, // First valid value stays pinned.
	} {
		req.DeviceIDHash, req.DeviceIDKind = pair.hash, pair.kind
		if _, err := svc.Handle(ctx, req, ""); err != nil {
			t.Fatalf("optional telemetry failed check-in: %v", err)
		}
	}
	var intact bool
	if err := pool.QueryRow(ctx, `SELECT device_id_hash=$2 AND device_id_kind=$3
	 AND account_id=$4::uuid AND installed_at=$5 AND check_in_count=7
	 AND usage_entries_created=3 AND has_onboarded
	 AND EXISTS(SELECT 1 FROM install_active_days WHERE install_id=$1::uuid AND active_date='2025-01-01' AND had_usage)
	 FROM installs WHERE install_id=$1`, first, hash, kind, accountA, installed).Scan(&intact); err != nil || !intact {
		t.Fatalf("upgrade or optional check-in changed history: intact=%v err=%v", intact, err)
	}
	// Reinstalling on the same phone preserves independent installation and
	// account histories. Equal device digests never link or merge accounts.
	req.InstallID, req.DeviceIDHash, req.DeviceIDKind = second, &hash, &kind
	if _, err := svc.Handle(WithActorAccountID(ctx, accountB), req, ""); err != nil {
		t.Fatal(err)
	}
	var installs int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM installs WHERE device_id_hash=$1 AND device_id_kind=$2`, hash, kind).Scan(&installs); err != nil || installs != 2 {
		t.Fatalf("same-device installs merged: installs=%d err=%v", installs, err)
	}
	if err := pool.QueryRow(ctx, `SELECT account_id=$2::uuid AND check_in_count=1 FROM installs WHERE install_id=$1`, second, accountB).Scan(&intact); err != nil || !intact {
		t.Fatalf("second install inherited another account/history: intact=%v err=%v", intact, err)
	}
	req.InstallID, req.Platform, req.DeviceIDKind = ios, "ios", deviceEstimateString("ios_idfv")
	if _, err := svc.Handle(ctx, req, ""); err != nil {
		t.Fatalf("iOS digest: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT device_id_kind='ios_idfv' AND device_id_hash=$2 AND account_id IS NULL FROM installs WHERE install_id=$1`, ios, hash).Scan(&intact); err != nil || !intact {
		t.Fatalf("iOS estimate: intact=%v err=%v", intact, err)
	}
	// A malformed pair on a fresh install is ignored without discarding the
	// check-in itself, so raw OS identifiers never reach storage.
	req.InstallID, req.DeviceIDHash = uuid.NewString(), deviceEstimateString(uuid.NewString())
	if _, err := svc.Handle(ctx, req, ""); err != nil {
		t.Fatalf("malformed new-install telemetry: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT device_id_kind IS NULL AND device_id_hash IS NULL AND check_in_count=1 FROM installs WHERE install_id=$1`, req.InstallID).Scan(&intact); err != nil || !intact {
		t.Fatalf("raw identity persisted: intact=%v err=%v", intact, err)
	}
}

func TestDeviceEstimateSchemaRejectsUnpairedOrRawIdentity(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	hash := strings.Repeat("a1", 32)
	for _, pair := range []struct{ hash, kind *string }{
		{&hash, nil},
		{nil, deviceEstimateString("android_id")},
		{deviceEstimateString("raw-android-id"), deviceEstimateString("android_id")},
		{deviceEstimateString(strings.ToUpper(hash)), deviceEstimateString("android_id")},
		{&hash, deviceEstimateString("mac")},
	} {
		_, err := pool.Exec(t.Context(), `INSERT INTO installs(install_id,device_id_hash,device_id_kind) VALUES($1,$2,$3)`, uuid.NewString(), pair.hash, pair.kind)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Fatalf("invalid pair escaped schema constraint: %v", err)
		}
	}
}
