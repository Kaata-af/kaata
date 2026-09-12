package admin

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// This is the transition performed by sign-in: the same installation becomes
// account-linked. Its original timeline and activity rows must survive.
func TestGetUsersInstallBecomesAccountLinked(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	install := seedActivityInstall(t, pool, nil, "2026-09-01T10:00:00Z")
	seedActivityHour(t, pool, install, "2026-09-01T10:00:00Z")
	if _, err := pool.Exec(ctx, `
		UPDATE installs SET self_name = 'Test shopkeeper', self_phone = '+93700000001',
		  shop_name = 'Test shop', usage_entries_created = 7, check_in_count = 3,
		  has_onboarded = TRUE WHERE install_id = $1::uuid
	`, install); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, nil, nil)
	before, err := svc.GetUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if before.SignedInCount != 0 || before.AnonymousCount != 1 || before.TotalInstalls != 1 {
		t.Fatalf("before sign-in: signed=%d anonymous=%d installs=%d", before.SignedInCount, before.AnonymousCount, before.TotalInstalls)
	}
	account := seedActivityAccount(t, pool)
	linkTestInstall(t, pool, install, &account)
	after, err := svc.GetUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if after.SignedInCount != 1 || after.AnonymousCount != 0 || after.TotalInstalls != 1 {
		t.Fatalf("after sign-in: signed=%d anonymous=%d installs=%d", after.SignedInCount, after.AnonymousCount, after.TotalInstalls)
	}
	u := after.Users[0]
	if u.AccountID != account || u.InstallCount != 1 || u.FirstSeen != before.AnonymousInstalls[0].FirstSeen ||
		u.InstalledAt != before.AnonymousInstalls[0].InstalledAt || u.LedgerName != "Test shopkeeper" || !u.HasOnboarded {
		t.Fatalf("account did not preserve original install telemetry: %+v", u)
	}
	var activity, entries, checkins int
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT COUNT(*) FROM install_active_hours WHERE install_id = i.install_id),
		 usage_entries_created, check_in_count FROM installs i WHERE install_id = $1::uuid
	`, install).Scan(&activity, &entries, &checkins); err != nil {
		t.Fatal(err)
	}
	if activity != 1 || entries != 7 || checkins != 3 {
		t.Fatalf("history changed: %d/%d/%d", activity, entries, checkins)
	}
}

// A common name or unverified self-reported number is not sufficient evidence
// to associate an older installation with an account. Keep both install records
// (and activity history), even when this resembles a reinstall by one person.
func TestGetUsersPreservesUnlinkedInstallWithMatchingProfile(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	account := seedActivityAccount(t, pool)
	old := seedActivityInstall(t, pool, nil, "2026-08-01T10:00:00Z")
	current := seedActivityInstall(t, pool, &account, "2026-09-01T10:00:00Z")
	if _, err := pool.Exec(ctx, `
		UPDATE installs SET self_name = 'Same name', self_phone = '+93700000002', shop_name = 'Same shop'
		WHERE install_id IN ($1::uuid, $2::uuid)
	`, old, current); err != nil {
		t.Fatal(err)
	}
	got, err := NewService(pool, nil, nil).GetUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.SignedInCount != 1 || got.AnonymousCount != 1 || got.TotalInstalls != 2 ||
		got.AnonymousInstalls[0].InstallID != old || got.Users[0].InstallCount != 1 {
		t.Fatalf("distinct installations were merged: signed=%d anonymous=%d installs=%d", got.SignedInCount, got.AnonymousCount, got.TotalInstalls)
	}
}

// Migration 006 linked existing credentials to accounts but left the install
// binding empty. Resolve only unambiguous, non-revoked credential evidence for
// the report, consistently across profile, timeline, counts and operator filters.
func TestGetUsersResolvesLegacyCredentialWithoutRewritingHistory(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	account := seedActivityAccount(t, pool)
	other := seedActivityAccount(t, pool)
	operator := seedActivityAccount(t, pool)
	legacy := seedActivityInstall(t, pool, nil, "2026-08-01T10:00:00Z")
	explicit := seedActivityInstall(t, pool, &account, "2026-09-01T10:00:00Z")
	revoked := seedActivityInstall(t, pool, nil, "2026-09-02T10:00:00Z")
	ambiguous := seedActivityInstall(t, pool, nil, "2026-09-03T10:00:00Z")
	unlinked := seedActivityInstall(t, pool, nil, "2026-09-04T10:00:00Z")
	opLegacy := seedActivityInstall(t, pool, nil, "2026-09-05T10:00:00Z")
	for _, cred := range []struct {
		install, provider, account string
		revoked                    bool
	}{
		{legacy, "google", account, false},
		{legacy, "apple", account, false},  // two providers, one proven account
		{explicit, "google", other, false}, // explicit binding still wins
		{revoked, "google", account, true},
		{ambiguous, "google", account, false},
		{ambiguous, "apple", other, false},
		{opLegacy, "google", operator, false},
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO auth_credentials (install_id, provider, provider_sub, account_id, revoked_at)
			VALUES ($1::uuid, $2, $3, $4::uuid, CASE WHEN $5::boolean THEN NOW() ELSE NULL END)
		`, cred.install, cred.provider, "users-test-"+cred.install+cred.provider, cred.account, cred.revoked); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		UPDATE installs SET last_seen_at = '2026-09-13T10:00:00Z',
		  last_activity_at = '2026-09-12T10:00:00Z', has_onboarded = TRUE,
		  self_name = 'Legacy shopkeeper', self_phone = '+93700000003', shop_name = 'Legacy shop',
		  platform = 'android', app_version = '0.4.0', app_locale = 'fa', source = 'qr',
		  usage_entries_created = 9, check_in_count = 4
		WHERE install_id = $1::uuid
	`, legacy); err != nil {
		t.Fatal(err)
	}
	seedActivityHour(t, pool, legacy, "2026-09-12T10:00:00Z")
	got, err := NewService(pool, []string{operator}, nil).GetUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.SignedInCount != 2 || got.AnonymousCount != 3 || got.TotalInstalls != 5 {
		t.Fatalf("inconsistent credential grouping totals: signed=%d anonymous=%d installs=%d", got.SignedInCount, got.AnonymousCount, got.TotalInstalls)
	}
	byID := map[string]UserRow{}
	for _, u := range got.Users {
		byID[u.AccountID] = u
	}
	u, exists := byID[account]
	if !exists || u.InstallCount != 2 || u.InstalledAt != "2026-08-01T10:00:00Z" ||
		u.FirstSeen != "2026-08-01T10:00:00Z" || u.LastSeen != "2026-09-13T10:00:00Z" ||
		u.LastActivityAt != "2026-09-12T10:00:00Z" || !u.HasOnboarded {
		t.Fatalf("legacy install timeline/count was not folded into the account: %+v", u)
	}
	if u.LedgerName != "Legacy shopkeeper" || u.LedgerPhone != "+93700000003" ||
		u.ShopName != "Legacy shop" || u.Platform != "android" || u.AppVersion != "0.4.0" || u.Locale != "fa" || u.Source != "qr" {
		t.Fatalf("latest legacy install profile was not folded into the account: %+v", u)
	}
	if otherUser, exists := byID[other]; !exists || otherUser.InstallCount != 0 || otherUser.LastSeen != "" {
		t.Fatalf("conflicting credentials overrode explicit binding or ambiguity: %+v", otherUser)
	}
	if _, exists := byID[operator]; exists {
		t.Fatal("operator account was not excluded")
	}
	wantAnonymous := map[string]bool{revoked: true, ambiguous: true, unlinked: true}
	for _, install := range got.AnonymousInstalls {
		if !wantAnonymous[install.InstallID] {
			t.Errorf("unexpected anonymous installation: %s", install.InstallID)
		}
		delete(wantAnonymous, install.InstallID)
	}
	if len(wantAnonymous) != 0 {
		t.Fatalf("lost unresolved anonymous installations: %v", wantAnonymous)
	}
	var binding *string
	var activity, entries, checkins int
	if err := pool.QueryRow(ctx, `
		SELECT account_id::text,
		 (SELECT COUNT(*) FROM install_active_hours WHERE install_id = i.install_id),
		 usage_entries_created, check_in_count FROM installs i WHERE install_id = $1::uuid
	`, legacy).Scan(&binding, &activity, &entries, &checkins); err != nil {
		t.Fatal(err)
	}
	if binding != nil || activity != 1 || entries != 9 || checkins != 4 {
		t.Fatalf("report rewrote historical installation: binding=%v activity/entries/checkins=%d/%d/%d", binding, activity, entries, checkins)
	}
}

// Pause the report after its account query without adding a production test
// hook. The other pool commits a linkage change before subsequent report queries.
// Without REPEATABLE READ, sign-in loses the anonymous install between sections;
// unlinking makes the account and anonymous sections disagree about ownership.
func TestGetUsersConsistentSnapshotDuringLinkChange(t *testing.T) {
	for _, link := range []bool{true, false} {
		name := "unlink"
		if link {
			name = "sign-in"
		}
		t.Run(name, func(t *testing.T) {
			pool := testutil.ConnectTestDB(t)
			ctx := t.Context()
			account := seedActivityAccount(t, pool)
			var initial *string
			if !link {
				initial = &account
			}
			install := seedActivityInstall(t, pool, initial, "2026-09-01T10:00:00Z")
			tracer := &usersSnapshotTracer{read: make(chan struct{}), resume: make(chan struct{})}
			var resumeOnce sync.Once
			resume := func() { resumeOnce.Do(func() { close(tracer.resume) }) }
			defer resume()
			cfg := pool.Config().Copy()
			cfg.ConnConfig.Tracer = tracer
			reportPool, err := pgxpool.NewWithConfig(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(reportPool.Close)
			type result struct {
				data UsersResult
				err  error
			}
			finished := make(chan result, 1)
			go func() { data, err := NewService(reportPool, nil, nil).GetUsers(ctx); finished <- result{data, err} }()
			select {
			case <-tracer.read:
			case <-time.After(3 * time.Second):
				t.Fatal("report did not reach account query")
			}
			var target *string
			if link {
				target = &account
			}
			linkTestInstall(t, pool, install, target)
			resume()
			var got UsersResult
			select {
			case res := <-finished:
				if res.err != nil {
					t.Fatal(res.err)
				}
				got = res.data
			case <-time.After(3 * time.Second):
				t.Fatal("report did not finish")
			}
			if got.SignedInCount != 1 || got.TotalInstalls != 1 {
				t.Fatalf("incoherent report totals: %+v", got)
			}
			wantAnonymous, wantLinked := 0, 1
			if link {
				wantAnonymous, wantLinked = 1, 0
			}
			if got.AnonymousCount != wantAnonymous || got.Users[0].InstallCount != wantLinked {
				t.Fatalf("report crossed snapshots: anonymous=%d linked=%d, want %d/%d", got.AnonymousCount, got.Users[0].InstallCount, wantAnonymous, wantLinked)
			}
			// The next complete report observes the committed transition.
			after, err := NewService(pool, nil, nil).GetUsers(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if after.TotalInstalls != 1 || after.AnonymousCount != wantLinked || after.Users[0].InstallCount != wantAnonymous {
				t.Fatalf("next report did not see link transition: %+v", after)
			}
		})
	}
}

func linkTestInstall(t *testing.T, pool *pgxpool.Pool, install string, account *string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET account_id = $2::uuid WHERE install_id = $1::uuid`, install, account); err != nil {
		t.Fatal(err)
	}
}

type usersSnapshotKey struct{}
type usersSnapshotTracer struct {
	once   sync.Once
	read   chan struct{}
	resume chan struct{}
}

func (t *usersSnapshotTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, usersSnapshotKey{}, strings.Contains(data.SQL, "FROM accounts a"))
}

func (t *usersSnapshotTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if match, _ := ctx.Value(usersSnapshotKey{}).(bool); !match {
		return
	}
	t.once.Do(func() {
		close(t.read)
		select {
		case <-t.resume:
		case <-ctx.Done():
		}
	})
}
