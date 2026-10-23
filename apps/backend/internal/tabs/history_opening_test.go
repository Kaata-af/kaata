package tabs

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestNonzeroAcceptedHistoryRequiresUsableOpeningForNewBinding(t *testing.T) {
	for _, route := range []string{"create", "join", "bind", "partial bind"} {
		states := []string{"absent", "pending", "accepted", "disputed", "cancelled"}
		if route == "create" {
			states = states[:2] // A newly created opening is always pending.
		}
		for _, state := range states {
			t.Run(route+"/"+state, func(t *testing.T) {
				f := newTabFixture(t)
				ctx := context.Background()
				rel := uuid.NewString()
				old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Accepted loan", AccountID: &f.acctA,
					VaultID: &f.vaultA, RelationshipID: &rel,
					Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 100}})
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
				var opening *OpeningInput
				if state != "absent" {
					opening = &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 200}
				}
				if route == "create" {
					// A post-close private repayment can make the app compute zero
					// and omit Opening. It cannot absorb this accepted shared loan.
					_, err = f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "New period", AccountID: &f.acctA,
						VaultID: &f.vaultA, RelationshipID: &rel, Opening: opening,
						ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev})
				} else {
					in := CreateInput{Currency: "AFN", Label: "Candidate", AccountID: &f.acctA, Opening: opening}
					if route == "partial bind" {
						in.VaultID = &f.vaultA
					}
					candidate, createErr := f.svc.Create(ctx, in)
					if createErr != nil {
						t.Fatal(createErr)
					}
					p := f.party(t, candidate.MyToken, candidate.Tab.ID)
					if state == "accepted" || state == "disputed" {
						_, reviewErr := f.svc.setStatus(ctx, f.party(t, candidate.InviteToken, candidate.Tab.ID), candidate.Entries[0].ID, state, nil)
						if reviewErr != nil {
							t.Fatal(reviewErr)
						}
					} else if state == "cancelled" {
						if _, cancelErr := f.svc.Void(ctx, p, candidate.Entries[0].ID); cancelErr != nil {
							t.Fatal(cancelErr)
						}
					}
					if route == "join" {
						_, err = f.svc.Join(ctx, p, JoinInput{Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel,
							ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev})
					} else {
						binding := BindInput{AccountID: f.acctA, VaultID: &f.vaultA, RelationshipID: &rel,
							ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev}
						if route == "partial bind" {
							binding.VaultID = nil
						}
						_, err = f.svc.Bind(ctx, p, binding)
					}
				}
				usable := state == "pending" || state == "accepted"
				if usable && err != nil {
					t.Fatalf("usable opening was refused: %v", err)
				}
				if !usable && !errors.Is(err, ErrSharedHistoryOpeningRequired) {
					t.Fatalf("missing/unusable opening hid accepted history: %v", err)
				}
				after, readErr := f.svc.Get(ctx, pa, 0)
				if readErr != nil || !reflect.DeepEqual(closed, after) {
					t.Fatalf("new binding changed the accepted historical record: %v", readErr)
				}
			})
		}
	}
	if status, code, _ := mapServiceError(ErrSharedHistoryOpeningRequired); status != 409 || code != "shared_history_opening_required" {
		t.Fatalf("wrong opening-required response: %d %s", status, code)
	}
}

func TestOpeningGuardPreservesInitialAndSameBindingRecovery(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	initial, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Initial zero account", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, ExpectedHistoryRevisions: map[string]int64{}})
	if err != nil {
		t.Fatalf("initial no-history account needs no opening: %v", err)
	}
	pa := f.party(t, initial.MyToken, initial.Tab.ID)
	if _, err := f.svc.Bind(ctx, pa, BindInput{AccountID: f.acctA}); err != nil {
		t.Fatalf("same-binding restore without opening/receipt: %v", err)
	}
	if _, err := f.svc.Join(ctx, pa, JoinInput{Label: "A", AccountID: &f.acctA}); err != nil {
		t.Fatalf("same-binding join without opening/receipt: %v", err)
	}
	// A carried proposal can still be withdrawn. This does not revoke old
	// evidence, and recovering that existing binding must keep working.
	loan := f.append(t, pa, "a_to_b", "300", 100).Entry
	if _, err := f.svc.Accept(ctx, f.party(t, initial.InviteToken, initial.Tab.ID), loan.ID); err != nil {
		t.Fatal(err)
	}
	closed, err := f.svc.Close(ctx, pa)
	if err != nil {
		t.Fatal(err)
	}
	newPeriod, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Carried proposal", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 200},
		ExpectedPreviousTabID: &initial.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev})
	if err != nil {
		t.Fatal(err)
	}
	newA := f.party(t, newPeriod.MyToken, newPeriod.Tab.ID)
	if _, err := f.svc.Void(ctx, newA, newPeriod.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Bind(ctx, newA, BindInput{AccountID: f.acctA}); err != nil {
		t.Fatalf("recovery wrongly applied new-binding opening requirement: %v", err)
	}
}

func TestOpeningRequirementUsesAcceptedCheckpointsAndEachPeriodPartyRole(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	first, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "First", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(ctx, f.party(t, first.InviteToken, first.Tab.ID), first.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	closed1, err := f.svc.Close(ctx, f.party(t, first.MyToken, first.Tab.ID))
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Other party creates next period", AccountID: &f.acctB,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 200}})
	if err != nil {
		t.Fatal(err)
	}
	secondB := f.party(t, second.InviteToken, second.Tab.ID)
	if _, err := f.svc.Join(ctx, secondB, JoinInput{Label: "Our book is party B now", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, ExpectedPreviousTabID: &first.Tab.ID, ExpectedPreviousRev: &closed1.Tab.Rev}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(ctx, secondB, second.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	closed2, err := f.svc.Close(ctx, secondB)
	if err != nil {
		t.Fatal(err)
	}
	// The latest accepted opening replaces the first +300 checkpoint. Its
	// -300 must not be summed with that older +300 and mistaken for zero.
	if _, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "False zero", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, ExpectedPreviousTabID: &second.Tab.ID, ExpectedPreviousRev: &closed2.Tab.Rev,
		ExpectedHistoryRevisions: map[string]int64{first.Tab.ID: closed1.Tab.Rev, second.Tab.ID: closed2.Tab.Rev}}); !errors.Is(err, ErrSharedHistoryOpeningRequired) {
		t.Fatalf("accepted checkpoint was double-counted with older history: %v", err)
	}
	third, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Third", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, ExpectedPreviousTabID: &second.Tab.ID, ExpectedPreviousRev: &closed2.Tab.Rev,
		ExpectedHistoryRevisions: map[string]int64{first.Tab.ID: closed1.Tab.Rev, second.Tab.ID: closed2.Tab.Rev},
		Opening:                  &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: 300}})
	if err != nil {
		t.Fatal(err)
	}
	thirdA, thirdB := f.party(t, third.MyToken, third.Tab.ID), f.party(t, third.InviteToken, third.Tab.ID)
	normal := f.append(t, thirdA, "a_to_b", "300", 301).Entry
	if _, err := f.svc.Accept(ctx, thirdB, normal.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Dispute(ctx, thirdB, third.Entries[0].ID, "Opening not agreed"); err != nil {
		t.Fatal(err)
	}
	closed3, err := f.svc.Close(ctx, thirdA)
	if err != nil {
		t.Fatal(err)
	}
	// -300 in party-B period plus +300 in party-A period is actually zero.
	// The rejected opening is neither money nor a replacement checkpoint.
	if _, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Actual accepted zero", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &rel, ExpectedPreviousTabID: &third.Tab.ID, ExpectedPreviousRev: &closed3.Tab.Rev,
		ExpectedHistoryRevisions: map[string]int64{first.Tab.ID: closed1.Tab.Rev, second.Tab.ID: closed2.Tab.Rev, third.Tab.ID: closed3.Tab.Rev}}); err != nil {
		t.Fatalf("signed accepted history is zero but opening still required: %v", err)
	}
}
