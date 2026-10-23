package tabs

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

// Closing a shared account stops future collaboration, not review of the
// finite proposals already received. In particular a claimed repayment must
// never become unchallengeable merely because its author unlinks first.
func TestHTTPClosedSharedAccountKeepsPendingReviewAndCancellation(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	jwtA, jwtB := "Bearer "+f.jwtFor(t, f.acctA), "Bearer "+f.jwtFor(t, f.acctB)
	c := f.createOverHTTP(t, jwtA)
	base := "/v1/tabs/" + c.Tab.ID
	if got := f.do(t, "POST", base+"/join", jwtB, map[string]any{"token": c.InviteToken, "label": "B"}); got.status != 200 {
		t.Fatal(string(got.body))
	}
	pa, err := f.svc.PartyByAccount(ctx, c.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := f.svc.PartyByAccount(ctx, c.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	loan := f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli()).Entry
	accepted, err := f.svc.Accept(ctx, pb, loan.ID, loan.Rev)
	if err != nil {
		t.Fatal(err)
	}
	repayment := f.append(t, pb, "b_to_a", "100", time.Now().UnixMilli()).Entry
	toAccept := f.append(t, pa, "a_to_b", "15", time.Now().UnixMilli()).Entry
	toCancel := f.append(t, pb, "b_to_a", "15", time.Now().UnixMilli()).Entry
	if got := f.do(t, "POST", base+"/close", jwtB, map[string]any{}); got.status != 200 {
		t.Fatal(string(got.body))
	}
	closed, err := f.svc.Get(ctx, pa, 0)
	if err != nil {
		t.Fatal(err)
	}
	if closed.Tab.ConfirmedBalance["a"] != "100" || closed.Tab.ConfirmedBalance["b"] != "-100" ||
		closed.Tab.PendingBalance["a"] != "-100" || closed.Tab.PendingBalance["b"] != "100" ||
		closed.Tab.Balance["a"] != "0" || closed.Tab.Balance["b"] != "0" || closed.Tab.PendingForYou != 2 {
		t.Fatalf("closed balance hid accepted loan or pending claims: %+v", closed.Tab)
	}
	// The account that created a proposal still cannot accept/reject it.
	if got := f.do(t, "POST", base+"/entries/"+repayment.ID+"/accept", jwtB, map[string]any{}); got.status != 403 {
		t.Fatalf("self review after close: %d %s", got.status, got.body)
	}
	if got := f.do(t, "POST", base+"/entries/"+repayment.ID+"/void", jwtA, map[string]any{}); got.status != 403 {
		t.Fatalf("cancel other party after close: %d %s", got.status, got.body)
	}
	stranger := "Bearer " + f.jwtFor(t, seedAccount(t, f.pool, "closed-stranger@example.test", "Stranger"))
	if got := f.do(t, "POST", base+"/entries/"+repayment.ID+"/dispute", stranger, map[string]any{}); got.status != 404 {
		t.Fatalf("stranger review after close: %d %s", got.status, got.body)
	}
	for _, action := range []struct{ id, verb, jwt string }{
		{repayment.ID, "dispute", jwtA}, {toAccept.ID, "accept", jwtB}, {toCancel.ID, "void", jwtB},
	} {
		if got := f.do(t, "POST", base+"/entries/"+action.id+"/"+action.verb, action.jwt, map[string]any{}); got.status != 200 && got.status != 201 {
			t.Fatalf("%s pending after close: %d %s", action.verb, got.status, got.body)
		}
	}
	final, err := f.svc.Get(ctx, pa, 0)
	if err != nil {
		t.Fatal(err)
	}
	if final.Tab.ClosedAtMS == nil || final.Tab.ConfirmedBalance["a"] != "115" || final.Tab.ConfirmedBalance["b"] != "-115" ||
		final.Tab.PendingBalance["a"] != "0" || final.Tab.PendingBalance["b"] != "0" ||
		final.Tab.Balance["a"] != "115" || final.Tab.PendingForYou != 0 || len(final.Entries) != 5 {
		t.Fatalf("pending review did not correct the closed balance: %+v", final.Tab)
	}
	foundLoan := false
	for _, e := range final.Entries {
		if e.ID == loan.ID {
			foundLoan = true
			if !reflect.DeepEqual(e, accepted.Entry) {
				t.Fatal("reviewing another proposal changed the accepted loan's evidence")
			}
		}
	}
	if !foundLoan {
		t.Fatal("resolving closed proposals erased the accepted loan")
	}
	for _, action := range []struct{ id, verb, jwt string }{
		{loan.ID, "void", jwtA}, {loan.ID, "dispute", jwtB}, {repayment.ID, "accept", jwtA},
	} {
		got := f.do(t, "POST", base+"/entries/"+action.id+"/"+action.verb, action.jwt, map[string]any{})
		if got.status != 409 || got.json(t)["error_code"] != "review_final" {
			t.Fatalf("final decision changed after close: %d %s", got.status, got.body)
		}
	}
	// New entries, links, binding changes and settlement remain closed.
	for _, req := range []struct {
		path string
		body map[string]any
	}{
		{"/entries", map[string]any{"id": uuid.NewString(), "direction": "a_to_b", "amount": "1", "occurred_at_ms": time.Now().UnixMilli()}},
		{"/join", map[string]any{"token": c.MyToken, "label": "A"}},
		{"/bind", map[string]any{"token": c.MyToken}},
		{"/label", map[string]any{"label": "Changed"}},
		{"/regenerate-link", map[string]any{}},
		{"/settlements", map[string]any{"id": uuid.NewString(), "expected_rev": final.Tab.Rev}},
	} {
		got := f.do(t, "POST", base+req.path, jwtA, req.body)
		if got.status != 409 || got.json(t)["error_code"] != "tab_closed" {
			t.Fatalf("new action %s on closed account: %d %s", req.path, got.status, got.body)
		}
	}
	unchanged, err := f.svc.Get(ctx, pa, 0)
	if err != nil || !reflect.DeepEqual(final, unchanged) {
		t.Fatalf("refused closed/final actions changed history: %v", err)
	}
}

func TestConcurrentReviewAndCancellationAfterCloseOnlyOneWins(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	for _, verdict := range []string{"accepted", "disputed"} {
		for range 8 {
			c := f.create(t, "A", "", "")
			pa, pb := f.party(t, c.MyToken, c.Tab.ID), f.party(t, c.InviteToken, c.Tab.ID)
			entry := f.append(t, pa, "a_to_b", "10", time.Now().UnixMilli()).Entry
			if _, err := f.svc.Close(ctx, pb); err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			go func() { <-start; _, err := f.svc.Void(ctx, pa, entry.ID); results <- err }()
			go func() { <-start; _, err := f.svc.setStatus(ctx, pb, entry.ID, verdict, nil); results <- err }()
			close(start)
			wins, refused := 0, 0
			for range 2 {
				err := <-results
				if err == nil {
					wins++
				} else if errors.Is(err, ErrReviewFinal) || errors.Is(err, ErrAlreadyVoided) {
					refused++
				} else {
					t.Fatal(err)
				}
			}
			if wins != 1 || refused != 1 {
				t.Fatalf("closed race wins=%d refused=%d", wins, refused)
			}
			got, err := f.svc.Get(ctx, pa, 0)
			if err != nil {
				t.Fatal(err)
			}
			if got.Tab.ClosedAtMS == nil || got.Tab.PendingBalance["a"] != "0" || got.Tab.PendingForYou != 0 {
				t.Fatalf("race reopened account or left unresolved proposal: %+v", got.Tab)
			}
			var decisions int
			if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tab_notifications WHERE tab_id=$1::uuid
			 AND entry_id=$2::uuid AND event_kind IN ('entry_accepted','entry_rejected','entry_voided')`, c.Tab.ID, entry.ID).Scan(&decisions); err != nil || decisions != 1 {
				t.Fatalf("race decision count=%d err=%v", decisions, err)
			}
		}
	}
}

func TestDeletedActorCannotReviewClosedHistoryButSurvivingPartyCan(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	c, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Join(ctx, f.party(t, c.InviteToken, c.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
		t.Fatal(err)
	}
	pa, err := f.svc.PartyByAccount(ctx, c.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := f.svc.PartyByAccount(ctx, c.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	fromA := f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli()).Entry
	fromB := f.append(t, pb, "b_to_a", "100", time.Now().UnixMilli()).Entry
	if err := auth.NewService(f.pool, "", "").DeleteAccount(ctx, f.acctB); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(ctx, pb, fromA.ID); !errors.Is(err, ErrAuthRequired) {
		t.Fatalf("stale deleted actor reviewed history: %v", err)
	}
	if _, err := f.svc.Void(ctx, pb, fromB.ID); !errors.Is(err, ErrAuthRequired) {
		t.Fatalf("stale deleted actor cancelled history: %v", err)
	}
	if _, err := f.svc.Dispute(ctx, pa, fromB.ID, "Payment not received"); err != nil {
		t.Fatalf("surviving participant cannot reject a pending claim: %v", err)
	}
	if _, err := f.svc.Void(ctx, pa, fromA.ID); err != nil {
		t.Fatalf("surviving participant cannot withdraw own pending claim: %v", err)
	}
	got, err := f.svc.Get(ctx, pa, 0)
	if err != nil || got.Tab.ClosedReason == nil || *got.Tab.ClosedReason != "account_deleted" || got.Tab.PendingBalance["a"] != "0" || len(got.Entries) != 3 {
		t.Fatalf("deleted-account resolution changed closure or lost history: %+v err=%v", got, err)
	}
}
