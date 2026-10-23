package tabs

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/db"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func TestHistoryOrderBelongsToFirstScopedBindingNotInvitationOrBusinessDates(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	early, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Early invitation", AccountID: &f.acctA})
	if err != nil {
		t.Fatal(err)
	}
	if early.Tab.Parties["a"].HistoryOrder != nil || early.Tab.Parties["b"].HistoryOrder != nil {
		t.Fatal("unscoped invitation consumed a checkpoint order")
	}
	// Order travels as a decimal string, including outside JavaScript's safe
	// integer range. Clients must not round distinct bindings into a tie.
	if _, err := f.pool.Exec(ctx, "SELECT setval('tab_party_history_order_seq',9007199254740993,false)"); err != nil {
		t.Fatal(err)
	}
	rel1, rel2, relB := uuid.NewString(), uuid.NewString(), uuid.NewString()
	at := int64(1756000000000)
	later, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "First binding", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel1, LinkedAtMS: &at})
	if err != nil {
		t.Fatal(err)
	}
	backdated := at - 999999
	bound, err := f.svc.Bind(ctx, f.party(t, early.MyToken, early.Tab.ID), BindInput{AccountID: f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel2, LinkedAtMS: &backdated})
	if err != nil {
		t.Fatal(err)
	}
	joined, err := f.svc.Join(ctx, f.party(t, early.InviteToken, early.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB,
		VaultID: &f.vaultB, RelationshipID: &relB, LinkedAtMS: &backdated})
	if err != nil {
		t.Fatal(err)
	}
	order := func(v *string) int64 {
		t.Helper()
		if v == nil {
			t.Fatal("scoped binding has no server order")
		}
		n, err := strconv.ParseInt(*v, 10, 64)
		if err != nil || n <= 0 {
			t.Fatalf("invalid decimal-string order %v: %v", v, err)
		}
		return n
	}
	first, second, third := order(later.Tab.Parties["a"].HistoryOrder), order(bound.Tab.Parties["a"].HistoryOrder), order(joined.Tab.Parties["b"].HistoryOrder)
	if first >= second || second >= third {
		t.Fatalf("order followed invitation/business dates instead of actual binding: %d %d %d", first, second, third)
	}
	raw, err := json.Marshal(later.Tab)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil || wire["parties"].(map[string]any)["a"].(map[string]any)["history_order"] != "9007199254740993" {
		t.Fatalf("history order lost precision on the wire: %s %v", raw, err)
	}
	retried, err := f.svc.Bind(ctx, f.party(t, early.MyToken, early.Tab.ID), BindInput{AccountID: f.acctA, LinkedAtMS: &at})
	if err != nil || order(retried.Tab.Parties["a"].HistoryOrder) != second {
		t.Fatalf("same-scope recovery moved checkpoint: %+v %v", retried, err)
	}
	for _, acct := range []string{f.acctA, f.acctB} {
		mine, err := f.svc.Mine(ctx, acct)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range mine.Tabs {
			if !reflect.DeepEqual(item.HistoryOrder, item.Tab.Parties[item.Role].HistoryOrder) {
				t.Fatalf("restore metadata disagrees with party order: %+v", item)
			}
		}
	}
}

func TestHistoryOrderMigrationPreservesExistingPeriodOrderAndEvidence(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel1, rel2 := uuid.NewString(), uuid.NewString()
	first, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "First joined", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel1})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Second joined", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel2})
	if err != nil {
		t.Fatal(err)
	}
	pa := f.party(t, first.MyToken, first.Tab.ID)
	entry := f.append(t, pa, "a_to_b", "100", 1756000000000).Entry
	if _, err := f.svc.Accept(ctx, f.party(t, first.InviteToken, first.Tab.ID), entry.ID); err != nil {
		t.Fatal(err)
	}
	before, err := f.svc.Get(ctx, pa, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Model the pre-migration schema and deliberately inverted creation vs
	// join dates. Only the dedicated test database is reset by this fixture.
	if _, err := f.pool.Exec(ctx, `UPDATE tabs SET created_at=CASE WHEN id=$1::uuid THEN TIMESTAMPTZ '2026-06-02 00:00:00+00' ELSE TIMESTAMPTZ '2026-06-01 00:00:00+00' END`, first.Tab.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE tab_parties SET joined_at=CASE WHEN tab_id=$1::uuid THEN TIMESTAMPTZ '2026-06-01 00:00:00+00' ELSE TIMESTAMPTZ '2026-06-02 00:00:00+00' END WHERE role='a'`, first.Tab.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE tab_parties SET linked_at_ms=CASE WHEN tab_id=$1::uuid THEN 100 ELSE 200 END WHERE role='a'`, first.Tab.ID); err != nil {
		t.Fatal(err)
	}
	rerunHistoryOrderMigration(t, f)
	var firstOrder, secondOrder int64
	if err := f.pool.QueryRow(ctx, `SELECT history_order FROM tab_parties WHERE tab_id=$1::uuid AND role='a'`, first.Tab.ID).Scan(&firstOrder); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT history_order FROM tab_parties WHERE tab_id=$1::uuid AND role='a'`, second.Tab.ID).Scan(&secondOrder); err != nil || firstOrder >= secondOrder {
		t.Fatalf("backfill changed the existing period order: %d %d %v", firstOrder, secondOrder, err)
	}
	after, err := f.svc.Get(ctx, pa, 0)
	if err != nil || !reflect.DeepEqual(before.Entries, after.Entries) {
		t.Fatalf("order backfill changed accepted entry/evidence: %v", err)
	}
	rel3 := uuid.NewString()
	third, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Future binding", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel3})
	if err != nil {
		t.Fatal(err)
	}
	thirdOrder, err := strconv.ParseInt(*third.Tab.Parties["a"].HistoryOrder, 10, 64)
	if err != nil || thirdOrder <= secondOrder {
		t.Fatalf("sequence did not resume after backfill: %d %d %v", secondOrder, thirdOrder, err)
	}
}

func rerunHistoryOrderMigration(t *testing.T, f *tabFixture) {
	t.Helper()
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `ALTER TABLE tab_parties DROP COLUMN history_order;
	 DROP SEQUENCE tab_party_history_order_seq;
	 DELETE FROM schema_migrations WHERE name='067_tab_party_history_order.sql'`); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, f.pool); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryOrderMigrationKeepsDelayedActiveBindingAboveClosedPeriod(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	early, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Early unscoped invitation", AccountID: &f.acctA,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "80", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	at := int64(200)
	old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Prior scoped period", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &at,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "120", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(ctx, f.party(t, old.InviteToken, old.Tab.ID), old.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	closed, err := f.svc.Close(ctx, f.party(t, old.MyToken, old.Tab.ID))
	if err != nil {
		t.Fatal(err)
	}
	backdated := int64(100)
	if _, err := f.svc.Bind(ctx, f.party(t, early.MyToken, early.Tab.ID), BindInput{AccountID: f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &backdated,
		ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE tab_parties SET joined_at=CASE WHEN tab_id=$1::uuid THEN TIMESTAMPTZ '2026-06-01 00:00:00+00' ELSE TIMESTAMPTZ '2026-06-02 00:00:00+00' END WHERE role='a'`, early.Tab.ID); err != nil {
		t.Fatal(err)
	}
	rerunHistoryOrderMigration(t, f)
	readBalance := func() int64 {
		t.Helper()
		tx, err := f.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		got, err := syncapi.CreditBalance(ctx, tx, f.vaultA, rel)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := readBalance(); got != 8000 {
		t.Fatalf("backfill replaced active delayed binding with older balance: %d", got)
	}
	if _, err := f.svc.Close(ctx, f.party(t, early.MyToken, early.Tab.ID)); err != nil {
		t.Fatal(err)
	}
	if got := readBalance(); got != 8000 {
		t.Fatalf("closing delayed binding restored older balance after migration: %d", got)
	}
}
