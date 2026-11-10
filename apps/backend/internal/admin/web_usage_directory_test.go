package admin

import (
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestUsersKeepsWebAndPhoneCheckInsSeparate(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	const (
		now       = "2026-11-10T11:00:00Z"
		webSeen   = "2026-11-10T10:57:00Z"
		phoneSeen = "2026-11-10T10:59:00Z"
	)
	mixed := seedActivityAccount(t, pool)
	loginOnly := seedActivityAccount(t, pool)
	for _, fixture := range []struct {
		account, platform, version, seen string
		checkIns                         int
		webActivity, excluded            bool
	}{
		{mixed, "web", "web", webSeen, 0, true, false},
		{mixed, "android", "2.3.2", phoneSeen, 2, false, false},
		{mixed, "web", "web", "2026-11-10T10:58:00Z", 0, true, true},
		{loginOnly, "ios", "2.3.2", phoneSeen, 0, false, false},
		{loginOnly, "web", "web", webSeen, 0, false, false},
	} {
		id := seedActivityInstall(t, pool, &fixture.account, fixture.seen)
		if _, err := pool.Exec(ctx, `UPDATE installs SET platform=$2, app_version=$3, check_in_count=$4
			WHERE install_id=$1::uuid`, id, fixture.platform, fixture.version, fixture.checkIns); err != nil {
			t.Fatal(err)
		}
		if fixture.webActivity {
			if _, err := pool.Exec(ctx, `INSERT INTO web_workspace_days (install_id, account_id, active_day, last_seen_at)
				VALUES ($1::uuid, $2::uuid, DATE '2026-11-10', $3)`, id, fixture.account, activityTime(t, fixture.seen)); err != nil {
				t.Fatal(err)
			}
		}
		if fixture.excluded {
			if _, err := pool.Exec(ctx, `INSERT INTO outreach_exclusions (kind,id,reason) VALUES ('install',$1,'test')`, id); err != nil {
				t.Fatal(err)
			}
		}
	}
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return activityTime(t, now) }
	users, err := svc.GetUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(users.Users) != 2 {
		t.Fatalf("got %d accounts, want 2", len(users.Users))
	}
	for _, row := range users.Users {
		switch row.AccountID {
		case mixed:
			if row.LastWebActiveAt != webSeen || row.LastMobileSeenAt != phoneSeen || row.Platform != "android" || row.LastSeen != phoneSeen {
				t.Fatalf("activity sources were combined or test activity leaked in: %+v", row)
			}
		case loginOnly:
			if row.LastWebActiveAt != "" || row.LastMobileSeenAt != "" {
				t.Fatalf("sign-in stubs were treated as activity: %+v", row)
			}
		default:
			t.Fatal("unexpected account")
		}
	}
}
