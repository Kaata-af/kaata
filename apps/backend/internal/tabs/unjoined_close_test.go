package tabs

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

// The phone uses the committed Close response to distinguish withdrawing an
// untouched invitation from leaving an account another person has joined.
// Keep the evidence available in recovery reads, including after a lost reply.
func TestCloseKeepsUnjoinedInvitationEvidenceWithoutInventingAcceptance(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
		VaultID: &f.vaultA, Opening: &OpeningInput{Direction: "a_to_b", Amount: "125", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	a := f.party(t, created.MyToken, created.Tab.ID)
	closed, err := f.svc.Close(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	if !created.Tab.UnjoinedInvitation || !closed.Tab.UnjoinedInvitation || closed.Tab.ClosedAtMS == nil || closed.Tab.Parties["b"].JoinedAtMS != nil || closed.Tab.Parties["b"].Bound {
		t.Fatalf("close lost untouched invitation evidence: %+v", closed.Tab)
	}
	if len(closed.Entries) != 1 || closed.Entries[0].Status != "pending" || closed.Entries[0].ReviewerParty != nil ||
		closed.Tab.ConfirmedBalance["a"] != "0" || closed.Tab.PendingBalance["a"] != "125" {
		t.Fatalf("close fabricated a review or erased the proposed opening: %+v", closed)
	}
	if got, err := f.svc.Get(ctx, a, 0); err != nil || !reflect.DeepEqual(got, closed) {
		t.Fatalf("recovery read differs: %+v, %v", got, err)
	}
	if got, err := f.svc.Close(ctx, a); err != nil || !reflect.DeepEqual(got, closed) {
		t.Fatalf("close retry differs: %+v, %v", got, err)
	}
	mine, err := f.svc.Mine(ctx, f.acctA)
	if err != nil || len(mine.Tabs) != 1 || !reflect.DeepEqual(mine.Tabs[0].Tab, closed.Tab) {
		t.Fatalf("another device cannot recover cancellation evidence: %+v, %v", mine, err)
	}
	if _, err := f.svc.Join(ctx, f.party(t, created.InviteToken, created.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB}); !errors.Is(err, ErrTabClosed) {
		t.Fatalf("late invite joined after closure: %v", err)
	}
}

func TestCloseRacingFirstJoinReturnsCommittedParticipation(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	for i := 0; i < 12; i++ {
		created := f.create(t, "A", "a_to_b", "125")
		a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
		start := make(chan struct{})
		closeResult := make(chan TabResponse, 1)
		closeErr := make(chan error, 1)
		joinErr := make(chan error, 1)
		go func() {
			<-start
			response, err := f.svc.Close(ctx, a)
			closeResult <- response
			closeErr <- err
		}()
		go func() {
			<-start
			_, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB})
			joinErr <- err
		}()
		close(start)
		closed, closeFailure, joinFailure := <-closeResult, <-closeErr, <-joinErr
		if closeFailure != nil {
			t.Fatal(closeFailure)
		}
		if joinFailure != nil && !errors.Is(joinFailure, ErrTabClosed) {
			t.Fatal(joinFailure)
		}
		joined := joinFailure == nil
		if closed.Tab.UnjoinedInvitation == joined || (closed.Tab.Parties["b"].JoinedAtMS != nil) != joined || closed.Tab.Parties["b"].Bound != joined {
			t.Fatalf("stale close evidence: join=%v, response=%+v", joinFailure, closed.Tab)
		}
		if len(closed.Entries) != 1 || closed.Entries[0].Status != "pending" || closed.Entries[0].VoidedByEntryID != nil {
			t.Fatalf("racing close altered opening: %+v", closed.Entries)
		}
		if recovered, err := f.svc.Get(ctx, a, 0); err != nil || !reflect.DeepEqual(recovered, closed) {
			t.Fatalf("close result was not authoritative: %+v, %v", recovered, err)
		}
	}
}

func TestBoundCounterpartyRemainsVisibleEvenWithoutJoinTimestamp(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created := f.create(t, "A", "a_to_b", "125")
	b := f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Bind(ctx, b, BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	closed, err := f.svc.Close(ctx, f.party(t, created.MyToken, created.Tab.ID))
	if err != nil {
		t.Fatal(err)
	}
	if closed.Tab.UnjoinedInvitation || closed.Tab.Parties["b"].JoinedAtMS != nil || !closed.Tab.Parties["b"].Bound {
		t.Fatalf("legacy binding evidence lost: %+v", closed.Tab.Parties["b"])
	}
}

func TestHTTPOptInCloseWithdrawsOnlyUntouchedOpeningAndPreservesPrivateSource(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := t.Context()
	relationship, boundary := uuid.NewString(), int64(200)
	pushPrivateCreditEntry(t, f.tabFixture, relationship, "debt", "125", 100)
	before, err := syncapi.LoadVaultProjection(ctx, f.pool, f.vaultA)
	if err != nil {
		t.Fatal(err)
	}
	created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &boundary,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "125", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	a := f.party(t, created.MyToken, created.Tab.ID)
	ordinary := f.append(t, a, "a_to_b", "10", 250).Entry
	base, jwtA := "/v1/tabs/"+created.Tab.ID, "Bearer "+f.jwtFor(t, f.acctA)
	response := f.do(t, "POST", base+"/close", jwtA, map[string]any{"withdraw_unjoined_opening": true})
	var closed TabResponse
	if response.status != 200 || json.Unmarshal(response.body, &closed) != nil {
		t.Fatalf("opt-in close: %d %s", response.status, response.body)
	}
	if !closed.Tab.UnjoinedInvitation || closed.Tab.ClosedAtMS == nil || len(closed.Entries) != 3 ||
		closed.Tab.PendingBalance["a"] != "10" || closed.Tab.ConfirmedBalance["a"] != "0" {
		t.Fatalf("wrong invitation cleanup: %+v", closed)
	}
	for _, entry := range closed.Entries {
		switch entry.ID {
		case created.Entries[0].ID:
			if entry.Status != "pending" || entry.VoidedByEntryID == nil || entry.ReviewerParty != nil {
				t.Fatalf("opening was reviewed instead of withdrawn: %+v", entry)
			}
		case ordinary.ID:
			if entry.Status != "pending" || entry.VoidedByEntryID != nil {
				t.Fatalf("ordinary proposal changed: %+v", entry)
			}
		default:
			if entry.Kind != "void" || entry.CreatedBy != "a" || entry.AuthorAccountID == nil || *entry.AuthorAccountID != f.acctA || entry.ReviewerParty != nil {
				t.Fatalf("wrong withdrawal evidence: %+v", entry)
			}
		}
	}
	if got := readPrivateCreditBalance(t, f.tabFixture, relationship); got != 13500 {
		t.Fatalf("original private125 plus genuine pending10 exposure=%d", got)
	}
	after, err := syncapi.LoadVaultProjection(ctx, f.pool, f.vaultA)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("invitation cleanup changed private events: %+v, %v", after, err)
	}
	var retry TabResponse
	retryResponse := f.do(t, "POST", base+"/close", jwtA, map[string]any{"withdraw_unjoined_opening": true})
	if retryResponse.status != 200 || json.Unmarshal(retryResponse.body, &retry) != nil || !reflect.DeepEqual(closed, retry) {
		t.Fatalf("cleanup retry not idempotent: %d %s", retryResponse.status, retryResponse.body)
	}
	if _, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Again", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &relationship,
		ExpectedPreviousTabID: &created.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev}); !errors.Is(err, ErrSharedHistoryPending) {
		t.Fatalf("ordinary pending proposal no longer blocks a replacement: %v", err)
	}
}

func TestOptInCloseCanCleanLegacyClosedInvitationOnceAndRelink(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	relationship := uuid.NewString()
	created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &relationship,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "125", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	a := f.party(t, created.MyToken, created.Tab.ID)
	legacyClosed, err := f.svc.Close(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	cleaned, err := f.svc.Close(ctx, a, true)
	if err != nil {
		t.Fatal(err)
	}
	if !cleaned.Tab.UnjoinedInvitation || cleaned.Tab.Rev != legacyClosed.Tab.Rev+1 ||
		!reflect.DeepEqual(cleaned.Tab.ClosedAtMS, legacyClosed.Tab.ClosedAtMS) || len(cleaned.Entries) != 2 || cleaned.Entries[0].VoidedByEntryID == nil {
		t.Fatalf("legacy cleanup changed closure or failed to withdraw opening: %+v", cleaned)
	}
	if retry, err := f.svc.Close(ctx, a, true); err != nil || !reflect.DeepEqual(retry, cleaned) {
		t.Fatalf("legacy cleanup retry changed record: %+v, %v", retry, err)
	}
	if _, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Again", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &relationship,
		ExpectedPreviousTabID: &created.Tab.ID, ExpectedPreviousRev: &cleaned.Tab.Rev,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "125", OccurredAtMS: 200}}); err != nil {
		t.Fatalf("withdrawn invitation still blocks a fresh invitation: %v", err)
	}
}

func TestOptInCloseNeverWithdrawsParticipatingOrReviewedOpening(t *testing.T) {
	for _, participation := range []string{"joined", "bound", "formerly bound", "peer authored", "accepted", "disputed", "account deleted"} {
		t.Run(participation, func(t *testing.T) {
			f := newTabFixture(t)
			ctx := t.Context()
			created := f.create(t, "A", "a_to_b", "125")
			a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
			var err error
			switch participation {
			case "joined":
				_, err = f.svc.Join(ctx, b, JoinInput{Label: "B"})
			case "bound", "formerly bound":
				_, err = f.svc.Bind(ctx, b, BindInput{AccountID: f.acctB})
				if err == nil && participation == "formerly bound" {
					_, err = f.pool.Exec(ctx, `UPDATE tab_parties SET account_id=NULL WHERE tab_id=$1::uuid AND role='b'`, created.Tab.ID)
				}
			case "peer authored":
				_, err = f.svc.Append(ctx, b, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "10", OccurredAtMS: 200})
			case "accepted":
				_, err = f.svc.Accept(ctx, b, created.Entries[0].ID)
			case "disputed":
				_, err = f.svc.Dispute(ctx, b, created.Entries[0].ID, "Wrong opening")
			case "account deleted":
				_, err = f.pool.Exec(ctx, `UPDATE tabs SET closed_at=NOW(),closed_by='b',closed_reason='account_deleted' WHERE id=$1::uuid`, created.Tab.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			before, err := f.svc.Get(ctx, a, 0)
			if err != nil {
				t.Fatal(err)
			}
			closed, err := f.svc.Close(ctx, a, true)
			if err != nil {
				t.Fatal(err)
			}
			if closed.Tab.UnjoinedInvitation || !reflect.DeepEqual(before.Entries, closed.Entries) {
				t.Fatalf("real participation classified as untouched or entries changed: %+v", closed)
			}
		})
	}
}

func TestOptInCloseSerializesInvitationWithdrawalWithFirstJoin(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	for i := 0; i < 12; i++ {
		created := f.create(t, "A", "a_to_b", "125")
		a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
		start := make(chan struct{})
		closeResult := make(chan TabResponse, 1)
		closeErr, joinErr := make(chan error, 1), make(chan error, 1)
		go func() {
			<-start
			response, err := f.svc.Close(ctx, a, true)
			closeResult <- response
			closeErr <- err
		}()
		go func() {
			<-start
			_, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB})
			joinErr <- err
		}()
		close(start)
		closed, closeFailure, joinFailure := <-closeResult, <-closeErr, <-joinErr
		if closeFailure != nil || (joinFailure != nil && !errors.Is(joinFailure, ErrTabClosed)) {
			t.Fatalf("race failures: close=%v join=%v", closeFailure, joinFailure)
		}
		joined := joinFailure == nil
		if closed.Tab.UnjoinedInvitation == joined || (closed.Entries[0].VoidedByEntryID == nil) != joined ||
			closed.Entries[0].Status != "pending" || closed.Entries[0].ReviewerParty != nil {
			t.Fatalf("join/withdrawal produced inconsistent evidence: joined=%t %+v", joined, closed)
		}
	}
}

func pushPrivateCreditEntry(t *testing.T, f *tabFixture, relationship, kind, amount string, recorded int64) {
	t.Helper()
	id, device := uuid.NewString(), uuid.NewString()
	payload, err := json.Marshal(map[string]any{"entry_id": id, "relationship_id": relationship, "type": kind,
		"amount_afn": json.Number(amount), "occurred_at_ms": recorded, "recorded_at_ms": recorded})
	if err != nil {
		t.Fatal(err)
	}
	result, err := syncapi.NewService(f.pool).PushEvents(t.Context(), syncapi.PushInput{AccountID: f.acctA,
		VaultID: f.vaultA, DeviceID: device, Events: []syncapi.PushEvent{{EventID: uuid.NewString(),
			EventType: "entry_created", SchemaVersion: 1, TargetID: &id, RelationshipID: &relationship,
			ActorAccountID: &f.acctA, HLC: syncapi.PushHLC{PhysicalMS: recorded, DeviceID: device}, Payload: payload}}})
	if err != nil || len(result.Accepted) != 1 {
		t.Fatalf("record original private tally: %+v, %v", result, err)
	}
}

func readPrivateCreditBalance(t *testing.T, f *tabFixture, relationship string) int64 {
	t.Helper()
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	got, err := syncapi.CreditBalance(t.Context(), tx, f.vaultA, relationship, "AFN")
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestCancelledUntouchedOpeningCannotEraseOriginalPrivateCreditExposure(t *testing.T) {
	for _, participation := range []string{"untouched", "closed untouched", "joined", "bound", "peer authored"} {
		t.Run(participation, func(t *testing.T) {
			f := newTabFixture(t)
			relationship, boundary := uuid.NewString(), int64(200)
			pushPrivateCreditEntry(t, f, relationship, "debt", "125", 100)
			created, err := f.svc.Create(t.Context(), CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &boundary,
				Opening: &OpeningInput{Direction: "a_to_b", Amount: "125", OccurredAtMS: 100}})
			if err != nil {
				t.Fatal(err)
			}
			a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
			switch participation {
			case "closed untouched":
				_, err = f.svc.Close(t.Context(), a)
			case "joined":
				_, err = f.svc.Join(t.Context(), b, JoinInput{Label: "B", AccountID: &f.acctB})
			case "bound":
				_, err = f.svc.Bind(t.Context(), b, BindInput{AccountID: f.acctB})
			case "peer authored":
				_, err = f.svc.Append(t.Context(), b, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "10", OccurredAtMS: 250})
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.Void(t.Context(), a, created.Entries[0].ID); err != nil {
				t.Fatal(err)
			}
			want := int64(0)
			if participation == "untouched" || participation == "closed untouched" {
				want = 12500
			} else if participation == "peer authored" {
				want = 1000
			}
			if got := readPrivateCreditBalance(t, f, relationship); got != want {
				t.Fatalf("credit exposure after opening cancellation=%d, want %d", got, want)
			}
		})
	}
}

func TestCancelledUntouchedReplacementPreservesAcceptedHistoryAndPrivateOffsets(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	relationship, firstBoundary, nextBoundary := uuid.NewString(), int64(200), int64(500)
	old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &firstBoundary,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "120", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	b := f.party(t, old.InviteToken, old.Tab.ID)
	if _, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(ctx, b, old.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	closed, err := f.svc.Close(ctx, f.party(t, old.MyToken, old.Tab.ID))
	if err != nil {
		t.Fatal(err)
	}
	pushPrivateCreditEntry(t, f, relationship, "payment", "20", 350)
	next, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &nextBoundary,
		ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: 400}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Void(ctx, f.party(t, next.MyToken, next.Tab.ID), next.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	if got := readPrivateCreditBalance(t, f, relationship); got != 10000 {
		t.Fatalf("accepted120 less original private payment20 became %d, want 10000", got)
	}
}

func TestUntouchedInvitationWithoutOpeningCannotAbsorbPrivateExposure(t *testing.T) {
	f := newTabFixture(t)
	relationship, boundary := uuid.NewString(), int64(200)
	pushPrivateCreditEntry(t, f, relationship, "debt", "125", 100)
	created, err := f.svc.Create(t.Context(), CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA,
		VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &boundary})
	if err != nil {
		t.Fatal(err)
	}
	if !created.Tab.UnjoinedInvitation || readPrivateCreditBalance(t, f, relationship) != 12500 {
		t.Fatal("unused invitation without carry-over opening absorbed the original source")
	}
	if _, err := f.svc.Close(t.Context(), f.party(t, created.MyToken, created.Tab.ID), true); err != nil {
		t.Fatal(err)
	}
	if readPrivateCreditBalance(t, f, relationship) != 12500 {
		t.Fatal("closing a zero-opening invitation absorbed the original source")
	}
}
