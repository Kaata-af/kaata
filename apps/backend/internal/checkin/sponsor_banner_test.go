package checkin

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestCheckInSponsorFailureKeepsUpdate(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `
		INSERT INTO app_releases (platform, version, min_supported_version, play_store_url)
		VALUES ('android', '2.0.0', '2.0.0', 'https://play.google.com/store/apps/details?id=af.kaata');
		INSERT INTO sponsor_campaigns (sponsor, title, body, starts_at, ends_at, is_active)
		VALUES ('Supplier', 'Test offer', 'See the product', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour', TRUE);
	`); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, "", nil)
	req := Request{InstallID: uuid.NewString(), AppVersion: "1.0.0", Platform: "android"}
	res, err := svc.Handle(ctx, req, "")
	if err != nil || res.SponsorBanner == nil || res.SponsorBanner.Title != "Test offer" {
		t.Fatalf("campaign missing from check-in: %+v (%v)", res.SponsorBanner, err)
	}
	if _, err := pool.Exec(ctx, "ALTER TABLE sponsor_campaigns RENAME TO sponsor_campaigns_unavailable"); err != nil {
		t.Fatal(err)
	}
	res, err = svc.Handle(ctx, req, "")
	if err != nil || res.Update == nil || !res.ForceUpdate || res.SponsorBanner != nil {
		t.Fatalf("campaign failure affected check-in: %+v (%v)", res, err)
	}
	encoded, err := json.Marshal(res)
	if err != nil || !bytes.Contains(encoded, []byte(`"sponsor_banner":null`)) {
		t.Fatalf("expected explicit null for unavailable campaign: %s (%v)", encoded, err)
	}
}
