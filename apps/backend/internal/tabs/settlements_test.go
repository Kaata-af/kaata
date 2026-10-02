package tabs

import (
	"errors"
	"net/http"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func settlementParties(t *testing.T, f *tabFixture) (Party, Party) {
	t.Helper()
	created, err := f.svc.Create(t.Context(), CreateInput{Currency: "AFN", Label: "A",
		AccountID: &f.acctA, VaultID: &f.vaultA})
	if err != nil {
		t.Fatal(err)
	}
	invite := f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Join(t.Context(), invite, JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	a, err := f.svc.PartyByAccount(t.Context(), created.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.svc.PartyByAccount(t.Context(), created.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	return a, b
}

func currentSettlementRev(t *testing.T, f *tabFixture, p Party) int64 {
	t.Helper()
	res, err := f.svc.Get(t.Context(), p, 0)
	if err != nil {
		t.Fatal(err)
	}
	return res.Tab.Rev
}

func acceptedSettlementPair(t *testing.T, f *tabFixture, a, b Party) int64 {
	t.Helper()
	x := f.append(t, a, "a_to_b", "12.34", 1_750_000_000_000)
	y := f.append(t, b, "b_to_a", "12.34", 1_750_000_000_001)
	if _, err := f.svc.Accept(t.Context(), b, x.Entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(t.Context(), a, y.Entry.ID); err != nil {
		t.Fatal(err)
	}
	return currentSettlementRev(t, f, a)
}

func TestSettlementRequiresReviewedExactZeroAndNewActivity(t *testing.T) {
	f := newTabFixture(t)
	a, b := settlementParties(t, f)
	settle := func(want error) {
		t.Helper()
		_, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: currentSettlementRev(t, f, a)})
		if !errors.Is(err, want) {
			t.Fatalf("settle error = %v, want %v", err, want)
		}
	}
	settle(ErrSettlementEmpty)
	x := f.append(t, a, "a_to_b", "0.3", 1_750_000_000_000)
	y := f.append(t, b, "b_to_a", "0.1", 1_750_000_000_001)
	z := f.append(t, b, "b_to_a", "0.2", 1_750_000_000_002)
	settle(ErrSettlementPending) // net zero alone cannot imply review.
	if _, err := f.svc.Accept(t.Context(), b, x.Entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(t.Context(), a, y.Entry.ID); err != nil {
		t.Fatal(err)
	}
	settle(ErrSettlementPending)
	if _, err := f.svc.Accept(t.Context(), a, z.Entry.ID); err != nil {
		t.Fatal(err)
	}
	before := currentSettlementRev(t, f, a)
	res, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: before})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created || res.Settlement.ThroughSeq != 3 || res.Tab.Balance["a"] != "0" || res.Tab.ClosedAtMS != nil {
		t.Fatalf("incorrect zero chapter: %+v", res)
	}
	if _, err := f.svc.Settle(t.Context(), b, SettleInput{ID: uuid.NewString(), ExpectedRev: before}); !errors.Is(err, ErrStaleSettlement) {
		t.Fatalf("stale check must precede empty chapter: %v", err)
	}
	settle(ErrSettlementEmpty)
	unbalanced := f.append(t, a, "a_to_b", "0.01", 1_750_000_000_003)
	if _, err := f.svc.Accept(t.Context(), b, unbalanced.Entry.ID); err != nil {
		t.Fatal(err)
	}
	settle(ErrSettlementNotZero)
}

func TestSettlementRetainsSharedHistoryAndIdempotentEvidence(t *testing.T) {
	f := newTabFixture(t)
	a, b := settlementParties(t, f)
	before := acceptedSettlementPair(t, f, a, b)
	id := uuid.NewString()
	res, err := f.svc.Settle(t.Context(), a, SettleInput{ID: id, ExpectedRev: before})
	if err != nil {
		t.Fatal(err)
	}
	marker := res.Settlement
	if marker.ActorAccountID != f.acctA || marker.ActorName != "Matee" || marker.ActorMemberRole != "account" || marker.CreatedBy != "a" || marker.SemanticsVersion != settlementSemanticsVersion || marker.SettledAtMS <= 0 {
		t.Fatalf("missing action evidence: %+v", marker)
	}
	delta, err := f.svc.Get(t.Context(), b, before)
	if err != nil || len(delta.Settlements) != 1 || delta.Settlements[0] != marker || len(delta.Entries) != 0 || delta.Full {
		t.Fatalf("counterparty delta = %+v, %v", delta, err)
	}
	// A backdated later entry belongs after the chapter by server seq.
	late := f.append(t, b, "a_to_b", "5", 1)
	if late.Entry.Seq <= marker.ThroughSeq {
		t.Fatal("later backdated entry crossed the chapter boundary")
	}
	retry, err := f.svc.Settle(t.Context(), a, SettleInput{ID: id, ExpectedRev: before})
	if err != nil || retry.Created || retry.Settlement != marker {
		t.Fatalf("uncertain response retry changed evidence: %+v, %v", retry, err)
	}
	if _, err := f.svc.Settle(t.Context(), b, SettleInput{ID: id, ExpectedRev: before}); !errors.Is(err, ErrIDTaken) {
		t.Fatalf("other party must not claim actor's request: %v", err)
	}
	if _, err := f.svc.Close(t.Context(), b); err != nil {
		t.Fatal(err)
	}
	retry, err = f.svc.Settle(t.Context(), a, SettleInput{ID: id, ExpectedRev: before})
	if err != nil || retry.Settlement != marker || retry.Created {
		t.Fatalf("saved marker retry after closure: %+v, %v", retry, err)
	}
	if _, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: retry.Tab.Rev}); !errors.Is(err, ErrTabClosed) {
		t.Fatalf("new marker on closed tab: %v", err)
	}
	if err := auth.NewService(f.pool, "test", "secret").DeleteAccount(t.Context(), f.acctA); err != nil {
		t.Fatal(err)
	}
	full, err := f.svc.Get(t.Context(), b, 0)
	if err != nil || !full.Full || len(full.Entries) != 3 || len(full.Settlements) != 1 || full.Settlements[0] != marker {
		t.Fatalf("deletion changed retained chapter/history: %+v, %v", full, err)
	}
}

func TestSettlementPreservesCancelledAndRejectedHistory(t *testing.T) {
	f := newTabFixture(t)
	a, b := settlementParties(t, f)
	rejected := f.append(t, a, "a_to_b", "50", 100)
	if _, err := f.svc.Dispute(t.Context(), b, rejected.Entry.ID, "not correct"); err != nil {
		t.Fatal(err)
	}
	cancelled := f.append(t, a, "a_to_b", "30", 101)
	if _, err := f.svc.Void(t.Context(), a, cancelled.Entry.ID); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: currentSettlementRev(t, f, a)})
	if err != nil || res.Settlement.ThroughSeq != 3 {
		t.Fatalf("rejected/cancelled zero history should form a chapter: %+v, %v", res, err)
	}
	full, err := f.svc.Get(t.Context(), b, 0)
	if err != nil || len(full.Entries) != 3 || full.Entries[0].Status != "disputed" || full.Entries[1].VoidedByEntryID == nil {
		t.Fatalf("zero marker removed decision history: %+v, %v", full, err)
	}
}

func TestSettlementRequiresCurrentEditorAuthority(t *testing.T) {
	f := newTabFixture(t)
	a, b := settlementParties(t, f)
	rev := acceptedSettlementPair(t, f, a, b)
	staff := seedAccount(t, f.pool, "settler@example.test", "Staff")
	seedMember(t, f.pool, f.vaultA, staff, "editor")
	p, err := f.svc.PartyByAccount(t.Context(), a.TabID, staff)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='clerk' WHERE account_id=$1::uuid`, staff); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Settle(t.Context(), p, SettleInput{ID: uuid.NewString(), ExpectedRev: rev}); !errors.Is(err, ErrRoleInsufficient) {
		t.Fatalf("stale editor authority: %v", err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='editor' WHERE account_id=$1::uuid`, staff); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.Settle(t.Context(), p, SettleInput{ID: uuid.NewString(), ExpectedRev: rev})
	if err != nil || res.Settlement.ActorAccountID != staff || res.Settlement.ActorMemberRole != "editor" || res.Settlement.ActorName != "Staff" {
		t.Fatalf("editor evidence: %+v, %v", res, err)
	}
}

func TestConcurrentSettlementsAndAppendHaveOneStableBoundary(t *testing.T) {
	f := newTabFixture(t)
	a, b := settlementParties(t, f)
	rev := acceptedSettlementPair(t, f, a, b)
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, party := range []Party{a, b} {
		wg.Add(1)
		go func(p Party) {
			defer wg.Done()
			<-start
			_, err := f.svc.Settle(t.Context(), p, SettleInput{ID: uuid.NewString(), ExpectedRev: rev})
			results <- err
		}(party)
	}
	close(start)
	wg.Wait()
	close(results)
	winners, stale := 0, 0
	for err := range results {
		if err == nil {
			winners++
		} else if errors.Is(err, ErrStaleSettlement) {
			stale++
		} else {
			t.Fatal(err)
		}
	}
	if winners != 1 || stale != 1 {
		t.Fatalf("concurrent results: winners=%d stale=%d", winners, stale)
	}
	// Race the next marker against a new entry. Either the marker wins with
	// a fixed earlier seq, or the append wins and makes the view stale.
	rev = acceptedSettlementPair(t, f, a, b)
	start = make(chan struct{})
	type settledResult struct {
		res SettlementResponse
		err error
	}
	settled := make(chan settledResult, 1)
	appended := make(chan AppendResult, 1)
	appendErr := make(chan error, 1)
	go func() {
		<-start
		res, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: rev})
		settled <- settledResult{res, err}
	}()
	go func() {
		<-start
		res, err := f.svc.Append(t.Context(), b, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "9", OccurredAtMS: 1})
		appended <- res
		appendErr <- err
	}()
	close(start)
	sr, ar := <-settled, <-appended
	if err := <-appendErr; err != nil {
		t.Fatal(err)
	}
	if sr.err == nil {
		if sr.res.Settlement.ThroughSeq >= ar.Entry.Seq {
			t.Fatal("settlement included an unreviewed concurrent append")
		}
	} else if !errors.Is(sr.err, ErrStaleSettlement) {
		t.Fatal(sr.err)
	}
}

func TestHTTPSettlementProtocol(t *testing.T) {
	f := newHTTPFixture(t)
	a, b := settlementParties(t, f.tabFixture)
	rev := acceptedSettlementPair(t, f.tabFixture, a, b)
	path := "/v1/tabs/" + a.TabID + "/settlements"
	body := map[string]any{"id": uuid.NewString(), "expected_rev": rev}
	if got := f.do(t, http.MethodPost, path, "", body); got.status != http.StatusNotFound {
		t.Fatalf("anonymous settle: %d %s", got.status, got.body)
	}
	jwt := "Bearer " + f.jwtFor(t, f.acctA)
	if got := f.do(t, http.MethodPost, path, jwt, map[string]any{"id": uuid.NewString()}); got.status != http.StatusBadRequest {
		t.Fatalf("missing expected_rev: %d %s", got.status, got.body)
	}
	created := f.do(t, http.MethodPost, path, jwt, body)
	if created.status != http.StatusCreated || created.json(t)["settlement"] == nil || created.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("settle: %d %s", created.status, created.body)
	}
	if got := f.do(t, http.MethodPost, path, jwt, body); got.status != http.StatusOK {
		t.Fatalf("retry: %d %s", got.status, got.body)
	}
	if got := f.do(t, http.MethodPost, path, jwt, map[string]any{"id": uuid.NewString(), "expected_rev": rev}); got.status != http.StatusConflict || got.json(t)["error_code"] != "stale_settlement" {
		t.Fatalf("stale: %d %s", got.status, got.body)
	}
}
