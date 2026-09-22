package tabs

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestContactBindingAndRestoreBoundary(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	relA, relB := uuid.NewString(), uuid.NewString()
	atA, atB := int64(1756000000000), int64(1757000000000)
	created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A",
		AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relA, LinkedAtMS: &atA})
	if err != nil {
		t.Fatal(err)
	}
	pb := f.party(t, created.InviteToken, created.Tab.ID)
	joined, err := f.svc.Join(ctx, pb, JoinInput{Label: "B", AccountID: &f.acctB,
		VaultID: &f.vaultB, RelationshipID: &relB, LinkedAtMS: &atB})
	if err != nil {
		t.Fatal(err)
	}
	// A later sign-in/launch must not move the cutoff or create a fake update.
	later := atB + 99999
	bound, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB,
		VaultID: &f.vaultB, RelationshipID: &relB, LinkedAtMS: &later})
	if err != nil {
		t.Fatal(err)
	}
	if bound.Tab.Rev != joined.Tab.Rev {
		t.Fatal("unchanged binding generated an update")
	}
	for _, tc := range []struct {
		account string
		cutoff  int64
	}{{f.acctA, atA}, {f.acctB, atB}} {
		mine, err := f.svc.Mine(ctx, tc.account)
		if err != nil {
			t.Fatal(err)
		}
		if len(mine.Tabs) != 1 || mine.Tabs[0].LinkedAtMS == nil || *mine.Tabs[0].LinkedAtMS != tc.cutoff {
			t.Fatalf("restore lost per-party cutover: %+v", mine)
		}
	}
	otherRel := uuid.NewString()
	_, err = f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB, VaultID: &f.vaultB, RelationshipID: &otherRel})
	if !errors.Is(err, ErrAlreadyLinked) {
		t.Fatalf("moved history to another contact: %v", err)
	}
	_, err = f.svc.Create(ctx, CreateInput{Currency: "USD", Label: "USD",
		AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &otherRel})
	if !errors.Is(err, ErrCurrencyMismatch) {
		t.Fatalf("mixed currency accepted: %v", err)
	}
	viewer := seedAccount(t, f.pool, "viewer-tab@example.com", "Viewer")
	seedMember(t, f.pool, f.vaultA, viewer, "viewer")
	_, err = f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Viewer",
		AccountID: &viewer, VaultID: &f.vaultA, RelationshipID: &otherRel})
	if !errors.Is(err, ErrRoleInsufficient) {
		t.Fatalf("viewer obtained write capability: %v", err)
	}
}

func TestConcurrentContactLinkOnlyOneWins(t *testing.T) {
	f := newTabFixture(t)
	rel := uuid.NewString()
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := f.svc.Create(context.Background(), CreateInput{Currency: "AFN", Label: "A",
				AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel})
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	wins, conflicts := 0, 0
	for err := range errs {
		if err == nil {
			wins++
		} else if errors.Is(err, ErrAlreadyLinked) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("wins=%d conflicts=%d", wins, conflicts)
	}
}

func TestAppendRetryAfterCloseReturnsOriginal(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	c := f.create(t, "A", "", "")
	pa := f.party(t, c.MyToken, c.Tab.ID)
	in := AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "12.5", OccurredAtMS: 1756000000000}
	first, err := f.svc.Append(ctx, pa, in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Close(ctx, f.party(t, c.InviteToken, c.Tab.ID)); err != nil {
		t.Fatal(err)
	}
	retried, err := f.svc.Append(ctx, pa, in)
	if err != nil {
		t.Fatal(err)
	}
	if retried.Created || retried.Entry.ID != first.Entry.ID || retried.Tab.Balance["a"] != "12.5" {
		t.Fatal("retry changed the frozen ledger")
	}
	in.ID = uuid.NewString()
	if _, err := f.svc.Append(ctx, pa, in); !errors.Is(err, ErrTabClosed) {
		t.Fatalf("new closed-tab append: %v", err)
	}
}
