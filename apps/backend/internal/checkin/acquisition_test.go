package checkin

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestPlayAcquisitionOverridesLegacyEstimateAndPinsSource(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, "", nil)
	const ip = "192.0.2.20"
	if _, err := pool.Exec(ctx, `INSERT INTO web_visits(kind,source,ip,visited_at) VALUES
		('store_click','qr_test',$1,NOW()-INTERVAL '2 minutes'),('store_click','facebook_ads',$1,NOW())`, ip); err != nil {
		t.Fatal(err)
	}
	fresh := time.Now().Add(-time.Hour).UnixMilli()
	old := time.Now().Add(-48 * time.Hour).UnixMilli()
	req := Request{InstallID: uuid.NewString(), AppVersion: "1.0.0", Platform: "android", InstalledAtUnixMS: &fresh}
	check := func(input Request, address, source, method string) {
		t.Helper()
		if _, err := svc.Handle(ctx, input, address); err != nil {
			t.Fatal(err)
		}
		var gotSource, gotMethod string
		if err := pool.QueryRow(ctx, `SELECT COALESCE(source,''),COALESCE(attribution_method,'') FROM installs WHERE install_id=$1`, input.InstallID).Scan(&gotSource, &gotMethod); err != nil {
			t.Fatal(err)
		}
		if gotSource != source || gotMethod != method {
			t.Fatalf("source/method = %q/%q, want %q/%q", gotSource, gotMethod, source, method)
		}
	}
	check(req, ip, "qr_test", "ip_match")
	req.InstallReferrerSource = "facebook_ads"
	check(req, ip, "facebook_ads", "play_referrer")
	req.InstallReferrerSource = "organic_posts"
	check(req, ip, "facebook_ads", "play_referrer")
	// The canonical store click cannot be claimed by a second device on the same IP.
	check(Request{InstallID: uuid.NewString(), Platform: "android", InstalledAtUnixMS: &fresh}, ip, "", "")
	check(Request{InstallID: uuid.NewString(), Platform: "ios", InstalledAtUnixMS: &fresh, InstallReferrerSource: "bill_share"}, "", "", "")
	check(Request{InstallID: uuid.NewString(), Platform: "android", InstalledAtUnixMS: &fresh, InstallReferrerSource: "anything"}, "", "", "")
	check(Request{InstallID: uuid.NewString(), Platform: "android", InstalledAtUnixMS: &old, InstallReferrerSource: "bill_share"}, "", "", "")
	upgraded := Request{InstallID: uuid.NewString(), Platform: "android", InstalledAtUnixMS: &old}
	check(upgraded, "", "", "")
	upgraded.InstalledAtUnixMS, upgraded.InstallReferrerSource = &fresh, "organic_posts"
	check(upgraded, "", "", "")
	late := Request{InstallID: uuid.NewString(), Platform: "android", InstalledAtUnixMS: &fresh}
	check(late, "", "", "")
	if _, err := pool.Exec(ctx, `UPDATE installs SET first_seen_at=NOW()-INTERVAL '2 days' WHERE install_id=$1`, late.InstallID); err != nil {
		t.Fatal(err)
	}
	late.InstallReferrerSource = "bill_share"
	check(late, "", "", "")
}
