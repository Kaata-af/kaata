package admin

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/testutil"
)

// GET /v1/admin/growth — cohort retention math, growth-accounting classes
// (new / retained / resurrected / churned), adoption counts, and the operator
// exclusion (an operator-account install with weekly activity must not move a
// single number).
//
// Fixture timeline (weeks are ISO Monday-start UTC weeks; W0 = current week):
//
//	install A (acctA)  installed W-3, active W-3 W-2 W-1 W0  — the steady user
//	install B          installed W-3, active W-3 only         — churns at W-2
//	install C          installed W-3, active W-3 and W-1      — churn, resurrect, churn
//	install D          installed W0,  active W0               — brand new
//	install OP (opAcct) installed W-3, active every week      — operator, excluded
func TestGetGrowth(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	// Monday of the current ISO week in UTC — must match Postgres's
	// date_trunc('week', NOW() AT TIME ZONE 'UTC').
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	monday := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	week := func(k int) time.Time { return monday.AddDate(0, 0, 7*k) } // week(-3) = W-3 Monday
	label := func(k int) string { return week(k).Format("2006-01-02") }

	seedAccount := func(name string) string {
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO accounts (google_sub, email, email_verified, name)
			VALUES ($1, $2, TRUE, $3)
			RETURNING id::text
		`, "sub-"+uuid.NewString(), uuid.NewString()+"@gmail.com", name).Scan(&id); err != nil {
			t.Fatalf("seed account: %v", err)
		}
		return id
	}
	acctA := seedAccount("Ahmad Wali")
	acctE := seedAccount("Second Member")
	opAcct := seedAccount("Operator")

	seedInstall := func(accountID *string, installedAt time.Time, shares int64) string {
		id := uuid.NewString()
		if _, err := pool.Exec(ctx, `
			INSERT INTO installs (install_id, account_id, installed_at, first_seen_at, usage_shares_sent)
			VALUES ($1::uuid, $2::uuid, $3, $3, $4)
		`, id, accountID, installedAt, shares); err != nil {
			t.Fatalf("seed install: %v", err)
		}
		return id
	}
	active := func(installID string, day time.Time) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO install_active_days (install_id, active_date) VALUES ($1::uuid, $2::date)
		`, installID, day.Format("2006-01-02")); err != nil {
			t.Fatalf("seed active day: %v", err)
		}
	}

	instA := seedInstall(&acctA, week(-3), 0)
	instB := seedInstall(nil, week(-3), 3) // with_shares
	instC := seedInstall(nil, week(-3), 0)
	instD := seedInstall(nil, week(0), 0)
	instOP := seedInstall(&opAcct, week(-3), 9)

	for _, k := range []int{-3, -2, -1, 0} {
		active(instA, week(k))
		active(instOP, week(k))
	}
	active(instB, week(-3))
	active(instC, week(-3))
	active(instC, week(-1))
	active(instD, week(0))

	// Vaults: V1 (acctA-owned, 2 active members) carries the entry_settled
	// event; V2 (operator-owned, also multi-member) must be excluded from
	// with_settlements, and opAcct from multi_member.
	seedVault := func(owner string, memberAccts ...string) string {
		vid := uuid.NewString()
		if _, err := pool.Exec(ctx, `
			INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
			VALUES ($1::uuid, $2::uuid, 'Shop', 'AFN', 0)
		`, vid, owner); err != nil {
			t.Fatalf("seed vault: %v", err)
		}
		for i, acct := range memberAccts {
			role := "editor"
			if acct == owner {
				role = "owner"
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
				VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), $4::uuid)
			`, vid, acct, role, owner); err != nil {
				t.Fatalf("seed member %d: %v", i, err)
			}
		}
		return vid
	}
	settle := func(vaultID string) {
		dev := uuid.NewString()
		if _, err := pool.Exec(ctx, `
			INSERT INTO events (event_id, vault_id, hlc_physical_ms, hlc_logical, hlc_device_id,
			                    device_id, event_type, payload, server_seq)
			VALUES ($1::uuid, $2::uuid, 0, 0, $3::uuid, $3::uuid, 'entry_settled', '{}'::jsonb, 1)
		`, uuid.NewString(), vaultID, dev); err != nil {
			t.Fatalf("seed entry_settled: %v", err)
		}
	}
	v1 := seedVault(acctA, acctA, acctE)
	v2 := seedVault(opAcct, opAcct, acctA)
	settle(v1)
	settle(v2)

	svc := NewService(pool, []string{opAcct}, nil)
	g, err := svc.GetGrowth(ctx)
	if err != nil {
		t.Fatalf("GetGrowth: %v", err)
	}

	// --- weekly_cohorts: dense 12 weeks, oldest first --------------------
	if len(g.WeeklyCohorts) != growthWeeks {
		t.Fatalf("weekly_cohorts len = %d, want %d", len(g.WeeklyCohorts), growthWeeks)
	}
	for i, c := range g.WeeklyCohorts {
		wantWeek := label(i - (growthWeeks - 1))
		if c.Week != wantWeek {
			t.Errorf("cohort[%d].week = %s, want %s", i, c.Week, wantWeek)
		}
		if wantLen := growthWeeks - i; len(c.Retained) != wantLen {
			t.Errorf("cohort[%d].retained len = %d, want %d", i, len(c.Retained), wantLen)
		}
	}
	// W-3 cohort (index 8): A, B, C — operator's same-week install excluded.
	c3 := g.WeeklyCohorts[growthWeeks-1-3]
	if c3.Size != 3 {
		t.Errorf("W-3 cohort size = %d, want 3", c3.Size)
	}
	// retained: W+0 = {A,B,C}=3, W+1 = {A}=1, W+2 = {A,C}=2, W+3 = {A}=1.
	for i, want := range []int64{3, 1, 2, 1} {
		if c3.Retained[i] != want {
			t.Errorf("W-3 cohort retained[%d] = %d, want %d", i, c3.Retained[i], want)
		}
	}
	// W0 cohort (index 11): D alone, active in its install week.
	c0 := g.WeeklyCohorts[growthWeeks-1]
	if c0.Size != 1 || len(c0.Retained) != 1 || c0.Retained[0] != 1 {
		t.Errorf("W0 cohort = size %d retained %v, want size 1 retained [1]", c0.Size, c0.Retained)
	}
	// Every other week is an empty cohort.
	for i, c := range g.WeeklyCohorts {
		if i == growthWeeks-1-3 || i == growthWeeks-1 {
			continue
		}
		if c.Size != 0 {
			t.Errorf("cohort[%d] (%s) size = %d, want 0", i, c.Week, c.Size)
		}
	}

	// --- growth_accounting: dense 12 weeks, oldest first -----------------
	if len(g.GrowthAccounting) != growthWeeks {
		t.Fatalf("growth_accounting len = %d, want %d", len(g.GrowthAccounting), growthWeeks)
	}
	wantGA := map[string]GrowthWeek{
		label(-3): {New: 3},                          // A, B, C first active
		label(-2): {Retained: 1, Churned: 2},         // A stays; B, C go silent
		label(-1): {Retained: 1, Resurrected: 1},     // A stays; C comes back
		label(0):  {New: 1, Retained: 1, Churned: 1}, // D new; A stays; C gone again
	}
	for i, w := range g.GrowthAccounting {
		wantWeek := label(i - (growthWeeks - 1))
		if w.Week != wantWeek {
			t.Fatalf("growth_accounting[%d].week = %s, want %s", i, w.Week, wantWeek)
		}
		want := wantGA[w.Week] // zero value for the empty early weeks
		if w.New != want.New || w.Retained != want.Retained ||
			w.Resurrected != want.Resurrected || w.Churned != want.Churned {
			t.Errorf("week %s = {new %d retained %d resurrected %d churned %d}, want {%d %d %d %d}",
				w.Week, w.New, w.Retained, w.Resurrected, w.Churned,
				want.New, want.Retained, want.Resurrected, want.Churned)
		}
	}

	// --- adoption --------------------------------------------------------
	if g.Adoption.SignedIn != 1 { // A only; operator install excluded
		t.Errorf("adoption.signed_in = %d, want 1", g.Adoption.SignedIn)
	}
	if g.Adoption.WithShares != 1 { // B only; operator install excluded
		t.Errorf("adoption.with_shares = %d, want 1", g.Adoption.WithShares)
	}
	if g.Adoption.MultiMember != 2 { // acctA + acctE; opAcct excluded
		t.Errorf("adoption.multi_member = %d, want 2", g.Adoption.MultiMember)
	}
	if g.Adoption.WithSettlements != 1 { // v1 only; operator-owned v2 excluded
		t.Errorf("adoption.with_settlements = %d, want 1", g.Adoption.WithSettlements)
	}

	if g.GeneratedAt == "" {
		t.Error("generated_at is empty")
	}
}

// An empty database must still yield the dense 12-week shells (arrays, not
// JSON null) and all-zero adoption — the frontend renders "collecting since"
// states from these, never crashes on missing rows.
func TestGetGrowthEmpty(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, []string{}, nil)

	g, err := svc.GetGrowth(context.Background())
	if err != nil {
		t.Fatalf("GetGrowth: %v", err)
	}
	if len(g.WeeklyCohorts) != growthWeeks {
		t.Fatalf("weekly_cohorts len = %d, want %d", len(g.WeeklyCohorts), growthWeeks)
	}
	if len(g.GrowthAccounting) != growthWeeks {
		t.Fatalf("growth_accounting len = %d, want %d", len(g.GrowthAccounting), growthWeeks)
	}
	for i, c := range g.WeeklyCohorts {
		if c.Size != 0 {
			t.Errorf("cohort[%d].size = %d, want 0", i, c.Size)
		}
		if len(c.Retained) != growthWeeks-i {
			t.Errorf("cohort[%d].retained len = %d, want %d", i, len(c.Retained), growthWeeks-i)
		}
	}
	for _, w := range g.GrowthAccounting {
		if w.New != 0 || w.Retained != 0 || w.Resurrected != 0 || w.Churned != 0 {
			t.Errorf("week %s not all-zero: %+v", w.Week, w)
		}
	}
	if g.Adoption != (Adoption{}) {
		t.Errorf("adoption = %+v, want all-zero", g.Adoption)
	}
}
