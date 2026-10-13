package admin

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// One "this is test data" decision applies to every install metric: an
// operator account, an account or install excluded by hand, and devices
// linked to such an account through a credential or a deletion receipt.
func TestReportExclusionsApplyToEveryInstallMetric(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")
	setTrackingStart(t, pool, "2026-09-01T00:00:00Z")

	real := seedActivityAccount(t, pool)
	operator := seedActivityAccount(t, pool)
	testAccount := seedActivityAccount(t, pool)
	retiredOperator := seedActivityAccount(t, pool)

	realPhone := seedActivityInstall(t, pool, &real, "2026-09-01T08:00:00Z")
	signedOut := seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z")
	opPhone := seedActivityInstall(t, pool, &operator, "2026-09-01T08:00:00Z")
	testPhone := seedActivityInstall(t, pool, &testAccount, "2026-09-01T08:00:00Z")
	robot := seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z")
	legacyCredential := seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z")
	seedCredential(t, pool, legacyCredential, operator)
	// A device of an operator account that was since purged: account_id is
	// NULL, only the deletion receipt remembers the account.
	purged := seedActivityInstall(t, pool, &retiredOperator, "2026-09-01T08:00:00Z")
	all := []string{realPhone, signedOut, opPhone, testPhone, robot, legacyCredential, purged}
	for _, install := range all {
		seedActivityHour(t, pool, install, "2026-09-14T08:00:00Z")
		seedActivityHour(t, pool, install, "2026-09-21T08:00:00Z")
		seedActivityHour(t, pool, install, "2026-09-28T08:00:00Z")
	}
	purgeAccount(t, pool, retiredOperator, purged)

	// Books for the vault-level adoption count: one real, one owned by the
	// excluded account, one excluded by hand.
	realBook := seedSettledVault(t, pool, real, testAccount)
	seedSettledVault(t, pool, testAccount)
	excludedBook := seedSettledVault(t, pool, real)

	svc := NewService(pool, []string{operator, retiredOperator}, nil)
	svc.now = func() time.Time { return activityTime(t, "2026-09-28T10:00:00Z") }
	for _, x := range []struct{ kind, id string }{
		{"account", testAccount}, {"install", robot}, {"vault", excludedBook},
	} {
		if _, err := svc.SetOutreachExclusion(ctx, x.kind, x.id, true, "test data"); err != nil {
			t.Fatalf("exclude %s: %v", x.kind, err)
		}
	}

	st, err := svc.GetStats(ctx, "day", 3)
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if st.InstallsTotal != 2 || st.ExcludedInstalls != 5 {
		t.Errorf("installs total/excluded = %d/%d, want 2/5", st.InstallsTotal, st.ExcludedInstalls)
	}
	if st.DAU != 2 || st.WAU != 2 || st.MAU != 2 {
		t.Errorf("DAU/WAU/MAU = %d/%d/%d, want 2/2/2", st.DAU, st.WAU, st.MAU)
	}
	if got := st.Series[len(st.Series)-1]; got.Active != 2 {
		t.Errorf("today's chart point = %+v, want 2 active", got)
	}

	g, err := svc.GetGrowth(ctx)
	if err != nil {
		t.Fatalf("GetGrowth: %v", err)
	}
	if g.ExcludedInstalls != 5 {
		t.Errorf("growth excluded installs = %d, want 5", g.ExcludedInstalls)
	}
	last := growthWeek(t, g, "2026-09-19")
	if last.Active != 2 || last.PreviousActive != 2 || !last.Complete || last.RecordedAt == "" {
		t.Errorf("last completed week = %+v, want 2 active from 2, recorded", last)
	}
	cohort := g.WeeklyCohorts[growthWeeks-5] // 2026-08-29, the install week
	if cohort.Week != "2026-08-29" || cohort.Size != 2 {
		t.Errorf("install cohort = %+v, want week 2026-08-29 size 2", cohort)
	}
	if g.Adoption.SignedIn != 1 || g.Adoption.MultiMember != 1 || g.Adoption.WithSettlements != 1 {
		t.Errorf("adoption = %+v, want signed_in 1 (real), multi_member 1 (real only), settlements 1 (%s)",
			g.Adoption, realBook)
	}
}

// A completed week keeps the count and verdict it was first reported with:
// a device's account link changing afterwards cannot move devices into or out
// of it. Only a deliberate change to the exclusion rules recalculates it.
func TestClosedWeeksKeepTheirCountsWhenDeviceLinksChange(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	setActivityCutover(t, pool, "2026-09-01")
	setTrackingStart(t, pool, "2026-09-01T00:00:00Z")

	operator := seedActivityAccount(t, pool)
	reviewer := seedActivityAccount(t, pool)
	stranger := seedActivityAccount(t, pool)
	var real []string
	for range 3 {
		real = append(real, seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z"))
	}
	opPhone := seedActivityInstall(t, pool, &operator, "2026-09-01T08:00:00Z")
	reviewPhone := seedActivityInstall(t, pool, &reviewer, "2026-09-01T08:00:00Z")
	for _, install := range append(append([]string{}, real...), opPhone, reviewPhone) {
		seedActivityHour(t, pool, install, "2026-09-14T08:00:00Z")
		seedActivityHour(t, pool, install, "2026-09-21T08:00:00Z")
	}
	// A fourth real device is new in the last completed week: 4 from 3.
	newcomer := seedActivityInstall(t, pool, nil, "2026-09-21T08:00:00Z")
	seedActivityHour(t, pool, newcomer, "2026-09-21T08:00:00Z")

	svc := NewService(pool, []string{operator, reviewer}, nil)
	now := activityTime(t, "2026-09-28T10:00:00Z")
	svc.now = func() time.Time { return now }
	first := growthWeek(t, mustGrowth(t, svc), "2026-09-19")
	if first.Active != 4 || first.PreviousActive != 3 || first.TargetMet == nil || !*first.TargetMet {
		t.Fatalf("first report = %+v, want 4 from 3, target met", first)
	}

	// The reviewer account is deleted and purged, and the operator's phone
	// signs in to somebody else's account. Neither may rewrite the week.
	purgeAccount(t, pool, reviewer, reviewPhone)
	if _, err := pool.Exec(ctx, `UPDATE installs SET account_id = $2::uuid WHERE install_id = $1::uuid`, opPhone, stranger); err != nil {
		t.Fatal(err)
	}
	now = activityTime(t, "2026-09-29T10:00:00Z")
	after := growthWeek(t, mustGrowth(t, svc), "2026-09-19")
	if after.Active != first.Active || after.PreviousActive != first.PreviousActive ||
		after.RecordedAt != first.RecordedAt || after.TargetMet == nil || *after.TargetMet != *first.TargetMet {
		t.Fatalf("closed week changed after link changes: %+v, first %+v", after, first)
	}
	if first.RecordedAt != "2026-09-28T10:00:00Z" {
		t.Errorf("recorded_at = %q, want the first report's time", first.RecordedAt)
	}

	// Excluding test data is a deliberate correction: the closed weeks are
	// recalculated once under the new rules, then kept again. (The purged
	// reviewer's phone stays out through its deletion receipt; the phone now
	// signed in to another account is counted from this recalculation on.)
	if _, err := svc.SetOutreachExclusion(ctx, "install", newcomer, true, "robot"); err != nil {
		t.Fatal(err)
	}
	now = activityTime(t, "2026-09-30T10:00:00Z")
	corrected := growthWeek(t, mustGrowth(t, svc), "2026-09-19")
	if corrected.Active != 4 || corrected.PreviousActive != 4 || corrected.RecordedAt != "2026-09-30T10:00:00Z" ||
		corrected.TargetMet == nil || *corrected.TargetMet {
		t.Fatalf("after excluding the newcomer = %+v, want 4 from 4 (operator phone now counted), below target, re-recorded", corrected)
	}
	now = activityTime(t, "2026-10-01T10:00:00Z")
	if again := growthWeek(t, mustGrowth(t, svc), "2026-09-19"); again.RecordedAt != corrected.RecordedAt || again.Active != corrected.Active {
		t.Errorf("unchanged rules recalculated the week: %+v", again)
	}
	// Undo is a rule change too.
	if _, err := svc.SetOutreachExclusion(ctx, "install", newcomer, false, ""); err != nil {
		t.Fatal(err)
	}
	if undone := growthWeek(t, mustGrowth(t, svc), "2026-09-19"); undone.Active != 5 || undone.PreviousActive != 4 {
		t.Errorf("after undo = %+v, want 5 from 4", undone)
	}
	// The unfinished week is never recorded.
	var recorded int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM admin_growth_weeks WHERE week >= '2026-09-26' AND week_starts_on = 6`).Scan(&recorded); err != nil {
		t.Fatal(err)
	}
	if recorded != 0 {
		t.Errorf("recorded %d unfinished weeks, want 0", recorded)
	}
}

// The fingerprint covers exactly what decides the excluded installs.
func TestExclusionRulesFingerprint(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	a, b := uuid.NewString(), uuid.NewString()
	rules := func(ops ...string) string {
		t.Helper()
		got, err := NewService(pool, ops, nil).exclusionRules(ctx)
		if err != nil {
			t.Fatalf("exclusionRules: %v", err)
		}
		return got
	}
	base := rules(a, b)
	if rules(b, a, a) != base {
		t.Error("operator order or duplicates changed the fingerprint")
	}
	if rules(a) == base {
		t.Error("removing an operator account kept the fingerprint")
	}
	svc := NewService(pool, []string{a, b}, nil)
	if _, err := svc.SetOutreachExclusion(ctx, "vault", uuid.NewString(), true, "test data"); err != nil {
		t.Fatal(err)
	}
	if rules(a, b) != base {
		t.Error("a vault exclusion changed the install fingerprint")
	}
	install := uuid.NewString()
	if _, err := svc.SetOutreachExclusion(ctx, "install", install, true, "test data"); err != nil {
		t.Fatal(err)
	}
	withInstall := rules(a, b)
	if withInstall == base {
		t.Error("an install exclusion kept the fingerprint")
	}
	if _, err := svc.SetOutreachExclusion(ctx, "install", install, true, "a new reason"); err != nil {
		t.Fatal(err)
	}
	if rules(a, b) != withInstall {
		t.Error("a new reason changed the fingerprint")
	}
}

// The Users page marks exactly the rows the reports leave out, with why.
func TestGetUsersMarksExcludedRows(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	real := seedActivityAccount(t, pool)
	testAccount := seedActivityAccount(t, pool)
	operator := seedActivityAccount(t, pool)
	seedActivityInstall(t, pool, &real, "2026-09-01T08:00:00Z")
	realTablet := seedActivityInstall(t, pool, &real, "2026-09-02T08:00:00Z")
	seedActivityInstall(t, pool, &testAccount, "2026-09-01T08:00:00Z")
	robot := seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z")
	opRetired := seedActivityInstall(t, pool, &operator, "2026-09-01T08:00:00Z")
	purgeAccount(t, pool, operator, opRetired)
	testRetired := seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z")
	if _, err := pool.Exec(ctx, `UPDATE installs SET account_deleted_at = NOW(), deletion_account_id = $2::uuid WHERE install_id = $1::uuid`, testRetired, testAccount); err != nil {
		t.Fatal(err)
	}
	plain := seedActivityInstall(t, pool, nil, "2026-09-01T08:00:00Z")

	svc := NewService(pool, []string{operator}, nil)
	if _, err := svc.SetOutreachExclusion(ctx, "account", testAccount, true, "QA account"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetOutreachExclusion(ctx, "install", robot, true, "pre-launch robot"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetOutreachExclusion(ctx, "install", realTablet, true, "my test tablet"); err != nil {
		t.Fatal(err)
	}
	res, err := svc.GetUsers(ctx)
	if err != nil {
		t.Fatalf("GetUsers: %v", err)
	}
	users := map[string]UserRow{}
	for _, u := range res.Users {
		users[u.AccountID] = u
	}
	if u := users[real]; u.Excluded || u.InstallCount != 2 || u.ExcludedInstalls != 1 {
		t.Errorf("real account = excluded %v devices %d excluded devices %d, want false/2/1", u.Excluded, u.InstallCount, u.ExcludedInstalls)
	}
	if u := users[testAccount]; !u.Excluded || u.ExclusionReason != "QA account" || u.ExcludedInstalls != u.InstallCount || u.InstallCount != 1 {
		t.Errorf("test account = %+v, want excluded with its reason and its one device", u)
	}
	want := map[string][2]string{
		robot:       {"install", "pre-launch robot"},
		opRetired:   {"operator", ""},
		testRetired: {"account", ""},
		plain:       {"", ""},
	}
	for _, in := range res.AnonymousInstalls {
		w, ok := want[in.InstallID]
		if !ok {
			t.Errorf("unexpected anonymous install %s", in.InstallID)
			continue
		}
		delete(want, in.InstallID)
		if in.Excluded != (w[0] != "") || in.ExcludedBy != w[0] || in.ExclusionReason != w[1] {
			t.Errorf("install %s = excluded %v by %q reason %q, want by %q reason %q",
				in.InstallID, in.Excluded, in.ExcludedBy, in.ExclusionReason, w[0], w[1])
		}
	}
	if len(want) != 0 {
		t.Errorf("anonymous installs missing: %v", want)
	}
}

func setTrackingStart(t *testing.T, pool *pgxpool.Pool, at string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `UPDATE schema_migrations SET applied_at = $1::timestamptz WHERE name = '022_analytics_tracking.sql'`, at); err != nil {
		t.Fatalf("set activity tracking start: %v", err)
	}
}

func seedCredential(t *testing.T, pool *pgxpool.Pool, install, account string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO auth_credentials (install_id, provider, provider_sub, account_id)
		VALUES ($1::uuid, 'google', $2, $3::uuid)
	`, install, "sub-"+uuid.NewString(), account); err != nil {
		t.Fatalf("seed credential: %v", err)
	}
}

// purgeAccount leaves the database the way a completed account deletion does
// (auth.hardDeleteAccount): the install is retired with a deletion receipt,
// its account link is cleared and the account row is gone.
func purgeAccount(t *testing.T, pool *pgxpool.Pool, account, install string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
		UPDATE installs SET account_deleted_at = NOW(), deletion_account_id = $2::uuid, account_id = NULL
		WHERE install_id = $1::uuid
	`, install, account); err != nil {
		t.Fatalf("retire install: %v", err)
	}
	if _, err := pool.Exec(t.Context(), `DELETE FROM accounts WHERE id = $1::uuid`, account); err != nil {
		t.Fatalf("delete account: %v", err)
	}
}

func seedSettledVault(t *testing.T, pool *pgxpool.Pool, owner string, members ...string) string {
	t.Helper()
	ctx := t.Context()
	vault := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Shop', 'AFN', 0)
	`, vault, owner); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	for _, account := range append([]string{owner}, members...) {
		role := "editor"
		if account == owner {
			role = "owner"
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
			VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), $4::uuid)
		`, vault, account, role, owner); err != nil {
			t.Fatalf("seed member: %v", err)
		}
	}
	device := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO events (event_id, vault_id, hlc_physical_ms, hlc_logical, hlc_device_id,
		                    device_id, event_type, payload, server_seq)
		VALUES ($1::uuid, $2::uuid, 0, 0, $3::uuid, $3::uuid, 'entry_settled', '{}'::jsonb, 1)
	`, uuid.NewString(), vault, device); err != nil {
		t.Fatalf("seed entry_settled: %v", err)
	}
	return vault
}

func mustGrowth(t *testing.T, svc *Service) Growth {
	t.Helper()
	g, err := svc.GetGrowth(context.Background())
	if err != nil {
		t.Fatalf("GetGrowth: %v", err)
	}
	return g
}

func growthWeek(t *testing.T, g Growth, week string) GrowthWeek {
	t.Helper()
	for _, w := range g.GrowthAccounting {
		if w.Week == week {
			return w
		}
	}
	t.Fatalf("week %s not in growth accounting", week)
	return GrowthWeek{}
}
