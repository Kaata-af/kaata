package tabs

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestUnresolvedClosedHistoryBlocksNewPeriodWithoutChangingEitherRecord(t *testing.T) {
	for _, route := range []string{"create", "join", "bind", "partial bind"} {
		t.Run(route, func(t *testing.T) {
			f := newTabFixture(t)
			ctx := context.Background()
			rel := uuid.NewString()
			old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &rel})
			if err != nil {
				t.Fatal(err)
			}
			pa := f.party(t, old.MyToken, old.Tab.ID)
			pending := f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli()).Entry
			if _, err := f.svc.Close(ctx, pa); err != nil {
				t.Fatal(err)
			}
			before, err := f.svc.Get(ctx, pa, 0)
			if err != nil {
				t.Fatal(err)
			}
			var candidate *CreateResult
			if route != "create" {
				in := CreateInput{Currency: "AFN", Label: "Candidate", AccountID: &f.acctA}
				if route == "partial bind" {
					in.VaultID = &f.vaultA // The request below supplies only the contact half.
				}
				c, err := f.svc.Create(ctx, in)
				if err != nil {
					t.Fatal(err)
				}
				candidate = &c
			}
			var tabsBefore, tabsAfter int
			var previousTabID *string
			var previousRev *int64
			if err := f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tabs").Scan(&tabsBefore); err != nil {
				t.Fatal(err)
			}
			try := func() error {
				switch route {
				case "create":
					_, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "New period", AccountID: &f.acctA,
						ExpectedPreviousTabID: previousTabID, ExpectedPreviousRev: previousRev,
						VaultID: &f.vaultA, RelationshipID: &rel, Opening: &OpeningInput{
							Direction: "a_to_b", Amount: "100", OccurredAtMS: time.Now().UnixMilli()}})
					return err
				case "join":
					_, err := f.svc.Join(ctx, f.party(t, candidate.MyToken, candidate.Tab.ID), JoinInput{
						ExpectedPreviousTabID: previousTabID, ExpectedPreviousRev: previousRev,
						Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel})
					return err
				default:
					in := BindInput{AccountID: f.acctA, VaultID: &f.vaultA, RelationshipID: &rel,
						ExpectedPreviousTabID: previousTabID, ExpectedPreviousRev: previousRev}
					if route == "partial bind" {
						in.VaultID = nil
					}
					_, err := f.svc.Bind(ctx, f.party(t, candidate.MyToken, candidate.Tab.ID), in)
					return err
				}
			}
			if err := try(); !errors.Is(err, ErrSharedHistoryPending) {
				t.Fatalf("new %s bypassed closed pending history: %v", route, err)
			}
			if status, code, _ := mapServiceError(ErrSharedHistoryPending); status != 409 || code != "shared_history_pending" {
				t.Fatalf("wrong protocol error %d %s", status, code)
			}
			if err := f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tabs").Scan(&tabsAfter); err != nil || tabsBefore != tabsAfter {
				t.Fatalf("refused link left an extra tab: %d/%d %v", tabsBefore, tabsAfter, err)
			}
			after, err := f.svc.Get(ctx, pa, 0)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("refused link changed the previous period: %v", err)
			}
			if candidate != nil {
				var boundContact *string
				if err := f.pool.QueryRow(ctx, `SELECT relationship_id::text FROM tab_parties WHERE tab_id=$1::uuid AND role='a'`, candidate.Tab.ID).Scan(&boundContact); err != nil || boundContact != nil {
					t.Fatalf("refused binding mutated the candidate: %v %v", boundContact, err)
				}
			}
			// Neither leaving nor a previous decision is undone. Resolve the old
			// pending row, then retry exactly the previously refused link.
			if _, err := f.svc.Void(ctx, pa, pending.ID); err != nil {
				t.Fatal(err)
			}
			if err := try(); !errors.Is(err, ErrSharedHistoryChanged) {
				t.Fatalf("old client bypassed required carry-over receipt: %v", err)
			}
			previousTabID, previousRev = &old.Tab.ID, &before.Tab.Rev
			if err := try(); !errors.Is(err, ErrSharedHistoryChanged) {
				t.Fatalf("stale carry-over receipt was accepted: %v", err)
			}
			resolved, err := f.svc.Get(ctx, pa, 0)
			if err != nil {
				t.Fatal(err)
			}
			previousRev = &resolved.Tab.Rev
			if err := try(); err != nil {
				t.Fatalf("resolved closed history still prevents %s: %v", route, err)
			}
		})
	}
}

func TestClosedPendingHistoryOnlyBlocksItsOwnContactScope(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel, otherRel := uuid.NewString(), uuid.NewString()
	old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel})
	if err != nil {
		t.Fatal(err)
	}
	pa := f.party(t, old.MyToken, old.Tab.ID)
	f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli())
	if _, err := f.svc.Close(ctx, pa); err != nil {
		t.Fatal(err)
	}
	for _, in := range []CreateInput{
		{Currency: "AFN", Label: "Different contact", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &otherRel},
		{Currency: "AFN", Label: "Different book", AccountID: &f.acctB, VaultID: &f.vaultB, RelationshipID: &rel},
	} {
		if _, err := f.svc.Create(ctx, in); err != nil {
			t.Fatalf("unrelated contact was blocked by pending history: %v", err)
		}
	}
}

func TestConcurrentLastVerdictCannotAdmitStaleCarryOver(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	for range 8 {
		rel := uuid.NewString()
		old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Old", AccountID: &f.acctA,
			VaultID: &f.vaultA, RelationshipID: &rel})
		if err != nil {
			t.Fatal(err)
		}
		pa := f.party(t, old.MyToken, old.Tab.ID)
		proposal := f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli()).Entry
		closed, err := f.svc.Close(ctx, pa)
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		cancelResult := make(chan error, 1)
		linkResult := make(chan error, 1)
		go func() { <-start; _, err := f.svc.Void(ctx, pa, proposal.ID); cancelResult <- err }()
		go func() {
			<-start
			_, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Stale carry", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &rel, ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev,
				Opening: &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: time.Now().UnixMilli()}})
			linkResult <- err
		}()
		close(start)
		if err := <-cancelResult; err != nil {
			t.Fatal(err)
		}
		if err := <-linkResult; !errors.Is(err, ErrSharedHistoryPending) && !errors.Is(err, ErrSharedHistoryChanged) {
			t.Fatalf("stale carry-over raced past the last verdict: %v", err)
		}
		fresh, err := f.svc.Get(ctx, pa, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Fresh carry", AccountID: &f.acctA,
			VaultID: &f.vaultA, RelationshipID: &rel, ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &fresh.Tab.Rev}); err != nil {
			t.Fatalf("fresh zero carry-over could not start: %v", err)
		}
	}
}

func TestClosedHistoryCannotBeCarriedIntoAnotherCurrency(t *testing.T) {
	for _, route := range []string{"create", "join", "bind", "partial bind"} {
		t.Run(route, func(t *testing.T) {
			f := newTabFixture(t)
			ctx := context.Background()
			rel := uuid.NewString()
			old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "AFN history", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &rel,
				Opening: &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: 100}})
			if err != nil {
				t.Fatal(err)
			}
			pa := f.party(t, old.MyToken, old.Tab.ID)
			if _, err := f.svc.Accept(ctx, f.party(t, old.InviteToken, old.Tab.ID), old.Entries[0].ID); err != nil {
				t.Fatal(err)
			}
			closed, err := f.svc.Close(ctx, pa)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(ctx, `UPDATE vaults SET currency='USD' WHERE vault_id=$1::uuid`, f.vaultA); err != nil {
				t.Fatal(err)
			}
			if route == "create" {
				_, err = f.svc.Create(ctx, CreateInput{Currency: "USD", Label: "USD carry", AccountID: &f.acctA,
					VaultID: &f.vaultA, RelationshipID: &rel, ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev,
					Opening: &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: 100}})
			} else {
				in := CreateInput{Currency: "USD", Label: "USD candidate", AccountID: &f.acctA}
				if route == "partial bind" {
					in.VaultID = &f.vaultA
				}
				candidate, createErr := f.svc.Create(ctx, in)
				if createErr != nil {
					t.Fatal(createErr)
				}
				p := f.party(t, candidate.MyToken, candidate.Tab.ID)
				if route == "join" {
					_, err = f.svc.Join(ctx, p, JoinInput{Label: "USD join", AccountID: &f.acctA,
						VaultID: &f.vaultA, RelationshipID: &rel, ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev})
				} else {
					binding := BindInput{AccountID: f.acctA, VaultID: &f.vaultA, RelationshipID: &rel,
						ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev}
					if route == "partial bind" {
						binding.VaultID = nil
					}
					_, err = f.svc.Bind(ctx, p, binding)
				}
			}
			if !errors.Is(err, ErrSharedHistoryChanged) {
				t.Fatalf("%s silently carried AFN history into USD: %v", route, err)
			}
			after, err := f.svc.Get(ctx, pa, 0)
			if err != nil || !reflect.DeepEqual(closed, after) {
				t.Fatalf("refused currency change rewrote the AFN record: %v", err)
			}
			otherRel := uuid.NewString()
			if _, err := f.svc.Create(ctx, CreateInput{Currency: "USD", Label: "Unrelated USD contact", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &otherRel}); err != nil {
				t.Fatalf("currency check leaked into another contact: %v", err)
			}
		})
	}
}
