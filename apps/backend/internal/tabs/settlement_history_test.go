package tabs

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
)

func TestHTTPSettlementCannotHideOtherPartysAcceptedOrPendingHistory(t *testing.T) {
	for _, scenario := range []string{"accepted loan behind rejected opening", "legacy pending behind accepted zero"} {
		t.Run(scenario, func(t *testing.T) {
			f := newHTTPFixture(t)
			ctx := context.Background()
			relA, relB := uuid.NewString(), uuid.NewString()
			old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Old A-scoped loan", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &relA, Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 100}})
			if err != nil {
				t.Fatal(err)
			}
			// B has account access to this old record, but no old book/contact
			// scope. Looking only at B's current scope would miss A's history.
			if _, err := f.svc.Join(ctx, f.party(t, old.InviteToken, old.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.Accept(ctx, f.party(t, old.InviteToken, old.Tab.ID), old.Entries[0].ID); err != nil {
				t.Fatal(err)
			}
			closed, err := f.svc.Close(ctx, f.party(t, old.MyToken, old.Tab.ID))
			if err != nil {
				t.Fatal(err)
			}
			current, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "New period", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &relA, Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 200},
				ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.Join(ctx, f.party(t, current.InviteToken, current.Tab.ID), JoinInput{Label: "B's first book scope", AccountID: &f.acctB,
				VaultID: &f.vaultB, RelationshipID: &relB}); err != nil {
				t.Fatal(err)
			}
			a, err := f.svc.PartyByAccount(ctx, current.Tab.ID, f.acctA)
			if err != nil {
				t.Fatal(err)
			}
			b, err := f.svc.PartyByAccount(ctx, current.Tab.ID, f.acctB)
			if err != nil {
				t.Fatal(err)
			}
			wantCode := "settlement_not_zero"
			if scenario == "accepted loan behind rejected opening" {
				if _, err := f.svc.Dispute(ctx, b, current.Entries[0].ID, "Opening not agreed"); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := f.svc.Accept(ctx, b, current.Entries[0].ID); err != nil {
					t.Fatal(err)
				}
				payment := f.append(t, b, "b_to_a", "300", 201).Entry
				if _, err := f.svc.Accept(ctx, a, payment.ID); err != nil {
					t.Fatal(err)
				}
				// Model pre-guard legacy unresolved history under a newer zero
				// checkpoint. Neither a future acceptance nor deletion is implied.
				if _, err := f.pool.Exec(ctx, `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at_ms,status)
				 VALUES($1::uuid,$2::uuid,2,2,'a','a_to_b',100,'entry',101,'pending')`, uuid.NewString(), old.Tab.ID); err != nil {
					t.Fatal(err)
				}
				wantCode = "settlement_pending"
			}
			currentView, err := f.svc.Get(ctx, a, 0)
			if err != nil || currentView.Tab.Balance["a"] != "0" || currentView.Tab.PendingForYou != 0 {
				t.Fatalf("fixture is not a current-tab reviewed zero: %+v %v", currentView.Tab, err)
			}
			got := f.do(t, "POST", fmt.Sprintf("/v1/tabs/%s/settlements", current.Tab.ID), "Bearer "+f.jwtFor(t, f.acctB),
				map[string]any{"id": uuid.NewString(), "expected_rev": currentView.Tab.Rev})
			if got.status != 409 || got.json(t)["error_code"] != wantCode {
				t.Fatalf("opposite caller certified misleading zero: %d %s", got.status, got.body)
			}
			var markers int
			if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tab_settlements WHERE tab_id=$1::uuid`, current.Tab.ID).Scan(&markers); err != nil || markers != 0 {
				t.Fatalf("refused settlement wrote a marker: %d %v", markers, err)
			}
		})
	}
}

func TestSettlementAcceptedOpeningAndReviewedZeroStillSucceedsAcrossHistory(t *testing.T) {
	f := newCheckpointCreditFixture(t)
	ctx := context.Background()
	if _, err := f.svc.Accept(ctx, f.b, f.current.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	payment := f.append(t, f.b, "b_to_a", "100", 201).Entry
	if _, err := f.svc.Accept(ctx, f.a, payment.ID); err != nil {
		t.Fatal(err)
	}
	rev := currentSettlementRev(t, f.tabFixture, f.a)
	id := uuid.NewString()
	marker, err := f.svc.Settle(ctx, f.b, SettleInput{ID: id, ExpectedRev: rev})
	if err != nil || !marker.Created || marker.Settlement.ThroughSeq != 2 {
		t.Fatalf("actual reviewed zero behind accepted checkpoint was refused: %+v %v", marker, err)
	}
	retry, err := f.svc.Settle(ctx, f.b, SettleInput{ID: id, ExpectedRev: rev})
	if err != nil || retry.Created || retry.Settlement.ID != id || retry.Settlement.Rev != marker.Settlement.Rev {
		t.Fatalf("settlement idempotent retry semantics changed: %+v %v", retry, err)
	}
}
