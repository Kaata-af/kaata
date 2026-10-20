package admin

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// Match the directory after its reportedRows exclusion filter, including
// unidentified anonymous records and accounts that have no installations.
func assertStatsUserTotals(t *testing.T, svc *Service, accounts, anonymous int64) Stats {
	t.Helper()
	stats, err := svc.GetStats(t.Context(), "day", 1)
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	directory, err := svc.GetUsers(t.Context())
	if err != nil {
		t.Fatalf("GetUsers: %v", err)
	}
	var directoryAccounts, directoryAnonymous int64
	for _, row := range directory.Users {
		if !row.Excluded {
			directoryAccounts++
		}
	}
	for _, row := range directory.AnonymousInstalls {
		if !row.Excluded {
			directoryAnonymous++
		}
	}
	if stats.UsersAccounts != accounts || stats.UsersAnonymous != anonymous || stats.UsersTotal != accounts+anonymous {
		t.Errorf("stats users total/accounts/anonymous = %d/%d/%d, want %d/%d/%d", stats.UsersTotal, stats.UsersAccounts, stats.UsersAnonymous, accounts+anonymous, accounts, anonymous)
	}
	if stats.UsersAccounts != directoryAccounts || stats.UsersAnonymous != directoryAnonymous {
		t.Errorf("stats/directory user counts differ: stats=%d/%d directory=%d/%d", stats.UsersAccounts, stats.UsersAnonymous, directoryAccounts, directoryAnonymous)
	}
	return stats
}

func TestGetStatsUserTotalsMatchDirectoryAndLinkage(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	assertStatsUserTotals(t, svc, 0, 0)

	account := seedActivityAccount(t, pool)
	other := seedActivityAccount(t, pool)
	seedActivityAccount(t, pool) // dormant account without any installation
	explicit := seedActivityInstall(t, pool, &account, "2026-10-01T00:00:00Z")
	seedActivityInstall(t, pool, &account, "2026-10-02T00:00:00Z")
	seedActivityInstall(t, pool, &account, "2026-10-03T00:00:00Z")
	legacy := seedActivityInstall(t, pool, nil, "2026-10-04T00:00:00Z")
	revoked := seedActivityInstall(t, pool, nil, "2026-10-05T00:00:00Z")
	ambiguous := seedActivityInstall(t, pool, nil, "2026-10-06T00:00:00Z")
	plain := seedActivityInstall(t, pool, nil, "2026-10-07T00:00:00Z")
	matching := seedActivityInstall(t, pool, nil, "2026-10-08T00:00:00Z")
	for _, credential := range []struct {
		install, provider, account string
		revoked                    bool
	}{
		{legacy, "google", account, false},
		{legacy, "apple", account, false}, // two providers prove one account
		{explicit, "google", other, false},
		{explicit, "apple", account, false}, // explicit account overrides credential conflict
		{revoked, "google", account, true},
		{ambiguous, "google", account, false},
		{ambiguous, "apple", other, false},
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO auth_credentials (install_id, provider, provider_sub, account_id, revoked_at)
			VALUES ($1::uuid, $2, $3, $4::uuid, CASE WHEN $5::boolean THEN NOW() ELSE NULL END)
		`, credential.install, credential.provider, "stats-users-"+credential.install+credential.provider, credential.account, credential.revoked); err != nil {
			t.Fatal(err)
		}
	}
	// A matching self-reported profile is not sufficient identity evidence.
	if _, err := pool.Exec(ctx, `
		UPDATE installs SET self_name = 'Same person', self_phone = '+93700000001'
		WHERE install_id IN ($1::uuid, $2::uuid)
	`, explicit, matching); err != nil {
		t.Fatal(err)
	}
	stats := assertStatsUserTotals(t, svc, 3, 4)
	if stats.InstallsTotal != 8 {
		t.Errorf("installation history changed: got %d, want 8", stats.InstallsTotal)
	}

	// Signing an anonymous device into an existing account removes its extra
	// directory row; another installation is not another signed-in user.
	linkTestInstall(t, pool, plain, &account)
	assertStatsUserTotals(t, svc, 3, 3)
	// A first sign-in replaces an anonymous record with the new account once.
	newAccount := seedActivityAccount(t, pool)
	linkTestInstall(t, pool, matching, &newAccount)
	assertStatsUserTotals(t, svc, 4, 2)
	// Unlinking restores the anonymous directory record without losing it.
	linkTestInstall(t, pool, plain, nil)
	assertStatsUserTotals(t, svc, 4, 3)
}

func TestGetStatsUserTotalsMatchDirectoryExclusions(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	real := seedActivityAccount(t, pool)
	seedActivityAccount(t, pool) // a real zero-install account still counts
	testAccount := seedActivityAccount(t, pool)
	operator := seedActivityAccount(t, pool)
	retiredOperator := seedActivityAccount(t, pool)
	realTestDevice := seedActivityInstall(t, pool, &real, "2026-10-01T00:00:00Z")
	seedActivityInstall(t, pool, &testAccount, "2026-10-01T00:00:00Z")
	seedActivityInstall(t, pool, &operator, "2026-10-01T00:00:00Z")
	seedActivityInstall(t, pool, nil, "2026-10-01T00:00:00Z") // real unidentified Ninja user
	robot := seedActivityInstall(t, pool, nil, "2026-10-01T00:00:00Z")
	retired := seedActivityInstall(t, pool, &retiredOperator, "2026-10-01T00:00:00Z")
	purgeAccount(t, pool, retiredOperator, retired)
	deletedTest := seedActivityInstall(t, pool, nil, "2026-10-01T00:00:00Z")
	if _, err := pool.Exec(ctx, `UPDATE installs SET account_deleted_at = NOW(), deletion_account_id = $2::uuid WHERE install_id = $1::uuid`, deletedTest, testAccount); err != nil {
		t.Fatal(err)
	}
	legacyOperator := seedActivityInstall(t, pool, nil, "2026-10-01T00:00:00Z")
	legacyTest := seedActivityInstall(t, pool, nil, "2026-10-01T00:00:00Z")
	seedCredential(t, pool, legacyOperator, operator)
	seedCredential(t, pool, legacyTest, testAccount)
	// Even revoked credentials preserve the fact that this was a test device.
	if _, err := pool.Exec(ctx, `UPDATE auth_credentials SET revoked_at = NOW() WHERE install_id IN ($1::uuid, $2::uuid)`, legacyOperator, legacyTest); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, []string{operator, retiredOperator}, nil)
	for _, exclusion := range []struct{ kind, id string }{
		{"account", testAccount}, {"install", robot}, {"install", realTestDevice},
	} {
		if _, err := svc.SetOutreachExclusion(ctx, exclusion.kind, exclusion.id, true, "testing"); err != nil {
			t.Fatal(err)
		}
	}
	stats := assertStatsUserTotals(t, svc, 2, 1)
	if stats.InstallsTotal != 1 {
		t.Errorf("kept installations = %d, want 1; a real account survives exclusion of its only test device", stats.InstallsTotal)
	}
	// Including the test account restores the account and its two currently
	// unlinked old devices, matching the existing directory's exclusion rules.
	if _, err := svc.SetOutreachExclusion(ctx, "account", testAccount, false, ""); err != nil {
		t.Fatal(err)
	}
	assertStatsUserTotals(t, svc, 3, 3)
}

func TestGetStatsUserTotalsSingleSnapshotDuringSignIn(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	seedActivityAccount(t, pool)
	install := seedActivityInstall(t, pool, nil, "2026-10-01T00:00:00Z")
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
		stats Stats
		err   error
	}
	finished := make(chan result, 1)
	go func() {
		stats, err := NewService(reportPool, nil, nil).GetStats(ctx, "day", 1)
		finished <- result{stats, err}
	}()
	select {
	case <-tracer.read:
	case <-time.After(3 * time.Second):
		t.Fatal("stats did not reach its user count query")
	}
	// The aggregate query has completed. Commit a first sign-in before the
	// remaining stats queries continue: it must not mix old/new user splits.
	account := seedActivityAccount(t, pool)
	linkTestInstall(t, pool, install, &account)
	resume()
	select {
	case res := <-finished:
		if res.err != nil {
			t.Fatal(res.err)
		}
		if res.stats.UsersTotal != 2 || res.stats.UsersAccounts != 1 || res.stats.UsersAnonymous != 1 {
			t.Fatalf("user splits crossed snapshots: total/accounts/anonymous = %d/%d/%d, want 2/1/1", res.stats.UsersTotal, res.stats.UsersAccounts, res.stats.UsersAnonymous)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stats did not finish")
	}
	assertStatsUserTotals(t, NewService(pool, nil, nil), 2, 0)
}

func TestStatsUserTotalsJSONIncludesZeroCounts(t *testing.T) {
	encoded, err := json.Marshal(Stats{})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"users_total", "users_accounts", "users_anonymous"} {
		if string(fields[key]) != "0" {
			t.Errorf("%s = %s, want an explicit zero count", key, fields[key])
		}
	}
}
