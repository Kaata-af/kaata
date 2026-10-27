package tabs

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/credit"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

type checkpointCreditFixture struct {
	*tabFixture
	old, current CreateResult
	a, b         Party
	relA, relB   string
}

func newCheckpointCreditFixture(t *testing.T) *checkpointCreditFixture {
	t.Helper()
	f := &checkpointCreditFixture{tabFixture: newTabFixture(t), relA: uuid.NewString(), relB: uuid.NewString()}
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	ctx := context.Background()
	var err error
	f.old, err = f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Old accepted 300", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &f.relA, Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Join(ctx, f.party(t, f.old.InviteToken, f.old.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB,
		VaultID: &f.vaultB, RelationshipID: &f.relB}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(ctx, f.party(t, f.old.InviteToken, f.old.Tab.ID), f.old.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	closed, err := f.svc.Close(ctx, f.party(t, f.old.MyToken, f.old.Tab.ID))
	if err != nil {
		t.Fatal(err)
	}
	f.current, err = f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Pending 100 checkpoint", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &f.relA, Opening: &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: 200},
		ExpectedPreviousTabID: &f.old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Join(ctx, f.party(t, f.current.InviteToken, f.current.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB,
		VaultID: &f.vaultB, RelationshipID: &f.relB, ExpectedPreviousTabID: &f.old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev}); err != nil {
		t.Fatal(err)
	}
	f.a, err = f.svc.PartyByAccount(ctx, f.current.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	f.b, err = f.svc.PartyByAccount(ctx, f.current.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *checkpointCreditFixture) balance(t *testing.T, vault, rel string) int64 {
	t.Helper()
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	got, err := syncapi.CreditBalance(context.Background(), tx, vault, rel)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestCreditRejectedOpeningCannotErasePriorExposure(t *testing.T) {
	f := newCheckpointCreditFixture(t)
	ctx := context.Background()
	if _, err := f.svc.Dispute(ctx, f.b, f.current.Entries[0].ID, "Opening not agreed"); err != nil {
		t.Fatal(err)
	}
	clerk := seedAccount(t, f.pool, "checkpoint-clerk@example.test", "Clerk")
	seedMember(t, f.pool, f.vaultA, clerk, "clerk")
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms)
	 VALUES($1::uuid,$2::uuid,35000,35000,'clerk_block',1)`, f.vaultA, f.relA); err != nil {
		t.Fatal(err)
	}
	p, err := f.svc.PartyByAccount(ctx, f.current.Tab.ID, clerk)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.balance(t, f.vaultA, f.relA); got != 30000 {
		t.Fatalf("rejected new opening hid old accepted 300: %d", got)
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "100", OccurredAtMS: 300}); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("old 300 + new 100 bypassed cap 350: %v", err)
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "50", OccurredAtMS: 301}); err != nil {
		t.Fatalf("exact cap should remain allowed: %v", err)
	}
	if got := f.balance(t, f.vaultA, f.relA); got != 35000 {
		t.Fatalf("recorded pending exposure did not include current row: %d", got)
	}
}

func TestCreditOpeningRemovalChecksActualRevealedHistoricalBalance(t *testing.T) {
	for _, action := range []string{"cancel", "reject"} {
		t.Run(action, func(t *testing.T) {
			f := newCheckpointCreditFixture(t)
			ctx := context.Background()
			vault, rel := f.vaultA, f.relA
			if action == "reject" {
				vault, rel = f.vaultB, f.relB
			}
			editor := seedAccount(t, f.pool, "checkpoint-editor@example.test", "Editor")
			seedMember(t, f.pool, vault, editor, "editor")
			if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms)
			 VALUES($1::uuid,$2::uuid,25000,25000,'clerk_block',true,1)`, vault, rel); err != nil {
				t.Fatal(err)
			}
			p, err := f.svc.PartyByAccount(ctx, f.current.Tab.ID, editor)
			if err != nil {
				t.Fatal(err)
			}
			before, err := f.svc.Get(ctx, f.a, 0)
			if err != nil {
				t.Fatal(err)
			}
			change := func() error {
				if action == "cancel" {
					_, err := f.svc.Void(ctx, p, f.current.Entries[0].ID)
					return err
				}
				_, err := f.svc.Dispute(ctx, p, f.current.Entries[0].ID, "Not agreed")
				return err
			}
			if err := change(); !errors.Is(err, credit.ErrLimit) {
				t.Fatalf("opening 100 removal reveals 300, not zero, beyond cap 250: %v", err)
			}
			after, err := f.svc.Get(ctx, f.a, 0)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("refused checkpoint removal changed decisions/history: %v", err)
			}
			if _, err := f.pool.Exec(ctx, `UPDATE customer_credit_limits SET max_collect_minor=35000,max_pay_minor=35000 WHERE vault_id=$1::uuid AND relationship_id=$2::uuid`, vault, rel); err != nil {
				t.Fatal(err)
			}
			if err := change(); err != nil {
				t.Fatalf("actual revealed balance 300 fits cap 350: %v", err)
			}
			want := int64(30000)
			if action == "reject" {
				want = -want
			}
			if got := f.balance(t, vault, rel); got != want {
				t.Fatalf("wrong balance after opening removal: %d want %d", got, want)
			}
		})
	}
}

func TestCreditAcceptedOpeningAbsorbsOlderRowsAndOlderReviewsHaveZeroDelta(t *testing.T) {
	f := newCheckpointCreditFixture(t)
	ctx := context.Background()
	if _, err := f.svc.Accept(ctx, f.b, f.current.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	if got := f.balance(t, f.vaultA, f.relA); got != 10000 {
		t.Fatalf("accepted opening failed to fold old 300: %d", got)
	}
	editor := seedAccount(t, f.pool, "legacy-checkpoint-editor@example.test", "Editor")
	seedMember(t, f.pool, f.vaultA, editor, "editor")
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms)
	 VALUES($1::uuid,$2::uuid,15000,15000,'clerk_block',true,1)`, f.vaultA, f.relA); err != nil {
		t.Fatal(err)
	}
	// Before the new link guard existed, closed periods could retain pending
	// rows beneath a newer accepted checkpoint. Model that legacy state only
	// in this dedicated test database; resolving it must have zero exposure.
	for i, author := range []string{"a", "b"} {
		id := uuid.NewString()
		if _, err := f.pool.Exec(ctx, `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at_ms,status)
		 VALUES($1::uuid,$2::uuid,$3,$3,$4,'b_to_a',100000,'entry',100,'pending')`, id, f.old.Tab.ID, i*2+2, author); err != nil {
			t.Fatal(err)
		}
		p, err := f.svc.PartyByAccount(ctx, f.old.Tab.ID, editor)
		if err != nil {
			t.Fatal(err)
		}
		if author == "a" {
			_, err = f.svc.Void(ctx, p, id)
		} else {
			_, err = f.svc.Dispute(ctx, p, id, "Legacy claim not agreed")
		}
		if err != nil {
			t.Fatalf("absorbed old %s review incorrectly increased exposure: %v", author, err)
		}
	}
	if got := f.balance(t, f.vaultA, f.relA); got != 10000 {
		t.Fatalf("review of absorbed old history changed latest exposure: %d", got)
	}
}

func TestLegacyMixedCurrencyHistoryKeepsCreditAndSettlementSeparate(t *testing.T) {
	f := newCheckpointCreditFixture(t)
	ctx := context.Background()
	if _, err := f.svc.Dispute(ctx, f.b, f.current.Entries[0].ID, "Not agreed"); err != nil {
		t.Fatal(err)
	}
	// Model a pre-guard migration: AFN +300, then USD -300 in a closed
	// period without an opening, followed by the current reviewed raw zero.
	// Those unlike units must never become a zero credit exposure/marker.
	legacy, err := f.svc.Create(ctx, CreateInput{Currency: "USD", Label: "Legacy USD rows", AccountID: &f.acctA})
	if err != nil {
		t.Fatal(err)
	}
	legacyA := f.party(t, legacy.MyToken, legacy.Tab.ID)
	payment := f.append(t, legacyA, "b_to_a", "300", 150).Entry
	if _, err := f.svc.Accept(ctx, f.party(t, legacy.InviteToken, legacy.Tab.ID), payment.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Close(ctx, legacyA); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE tab_parties SET vault_id=$1::uuid,relationship_id=$2::uuid,linked_at_ms=150,
	 history_order=nextval('tab_party_history_order_seq') WHERE tab_id=$3::uuid AND role='a'`, f.vaultA, f.relA, legacy.Tab.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE tab_parties SET history_order=nextval('tab_party_history_order_seq')
	 WHERE tab_id=$1::uuid AND role='a'`, f.current.Tab.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE tabs SET currency='USD' WHERE id=$1::uuid`, f.current.Tab.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE vaults SET currency='USD' WHERE vault_id IN ($1::uuid,$2::uuid)`, f.vaultA, f.vaultB); err != nil {
		t.Fatal(err)
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	afnBalance, readErr := syncapi.CreditBalance(ctx, tx, f.vaultA, f.relA, "AFN")
	usdBalance, usdErr := syncapi.CreditBalance(ctx, tx, f.vaultA, f.relA, "USD")
	_ = tx.Rollback(ctx)
	if readErr != nil || usdErr != nil || afnBalance != 30000 || usdBalance != -30000 {
		t.Fatalf("currencies must retain separate exposure: AFN=%d USD=%d %v %v", afnBalance, usdBalance, readErr, usdErr)
	}
	before, err := f.svc.Get(ctx, f.a, 0)
	if err != nil || before.Tab.Balance["a"] != "0" {
		t.Fatalf("fixture must have a current-tab raw zero: %+v %v", before.Tab, err)
	}
	if _, err := f.svc.Settle(ctx, f.b, SettleInput{ID: uuid.NewString(), ExpectedRev: before.Tab.Rev}); !errors.Is(err, ErrSettlementNotZero) {
		t.Fatalf("mixed accepted totals certified a false zero: %v", err)
	}
	after, err := f.svc.Get(ctx, f.a, 0)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("mixed-currency refusal changed history or markers: %v", err)
	}
}
