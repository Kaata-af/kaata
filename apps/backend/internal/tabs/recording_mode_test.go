package tabs

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/credit"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func createNotify(t *testing.T, f *tabFixture, opening string) CreateResult {
	t.Helper()
	in := CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA}
	if opening != "" {
		in.Opening = &OpeningInput{Direction: "a_to_b", Amount: opening, OccurredAtMS: 100}
	}
	created, err := f.svc.Create(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func assertNoReview(t *testing.T, e Entry) {
	t.Helper()
	if e.ReviewerAccountID != nil || e.ReviewerParty != nil || e.ReviewerMemberRole != nil || e.ReviewSemanticsVersion != nil || e.ReviewerName != "" {
		t.Fatalf("invented peer review: %+v", e)
	}
}

func TestNotifyRecordsWithoutPeerReviewAndPreservesLegacyDefault(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	old := f.create(t, "A", "", "")
	if old.Tab.RecordingMode != "review" {
		t.Fatal("legacy default changed")
	}
	legacy := f.append(t, f.party(t, old.MyToken, old.Tab.ID), "a_to_b", "7", 101)
	if legacy.Entry.Status != "pending" || legacy.Tab.RecordedBalance["a"] != "0" {
		t.Fatal("old review semantics changed")
	}
	created := createNotify(t, f, "")
	a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	added := f.append(t, a, "a_to_b", "25.50", 102)
	if added.Entry.Status != "recorded" || added.Tab.RecordedBalance["a"] != "25.5" || added.Tab.RecordedBalance["b"] != "-25.5" || added.Tab.ConfirmedBalance["a"] != "0" || added.Tab.PendingBalance["a"] != "0" || !added.Tab.UnjoinedInvitation {
		t.Fatalf("wrong unreviewed record: %+v", added)
	}
	assertNoReview(t, added.Entry)
	replay, err := f.svc.Append(ctx, a, AppendInput{ID: added.Entry.ID, Direction: "a_to_b", Amount: "25.50", OccurredAtMS: 102})
	if err != nil || replay.Created || !reflect.DeepEqual(replay.Entry, added.Entry) {
		t.Fatalf("non-idempotent recorded append: %+v %v", replay, err)
	}
	for _, review := range []func() error{func() error { _, err := f.svc.Accept(ctx, b, added.Entry.ID); return err }, func() error { _, err := f.svc.Dispute(ctx, b, added.Entry.ID, ""); return err }} {
		if err := review(); !errors.Is(err, ErrReviewNotRequired) {
			t.Fatalf("recorded row accepted/rejected: %v", err)
		}
	}
	before, err := f.svc.Get(ctx, a, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Void(ctx, b, added.Entry.ID); !errors.Is(err, ErrNotAuthor) {
		t.Fatal(err)
	}
	after, err := f.svc.Get(ctx, a, 0)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("refused action changed financial state", err)
	}
	cancelled, err := f.svc.Void(ctx, a, added.Entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Voided.Status != "recorded" || cancelled.Voided.VoidedByEntryID == nil || cancelled.Void.Kind != "void" {
		t.Fatalf("missing withdrawal audit: %+v", cancelled)
	}
	assertNoReview(t, cancelled.Voided)
	got, err := f.svc.Get(ctx, a, 0)
	if err != nil || got.Tab.RecordedBalance["a"] != "0" || !got.Tab.UnjoinedInvitation {
		t.Fatalf("withdrawal lost original ownership: %+v %v", got, err)
	}
	if _, err := f.svc.Create(ctx, CreateInput{RecordingMode: "auto_accept", Currency: "AFN", Label: "A"}); !errors.Is(err, ErrInvalidRecordingMode) {
		t.Fatal(err)
	}
}

func TestNotifyOpeningJoinsWithoutReviewAndCannotBeSilentlyCancelled(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created := createNotify(t, f, "125")
	a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	if created.Entries[0].Status != "pending" || created.Tab.RecordedBalance["a"] != "0" || !created.Tab.UnjoinedInvitation {
		t.Fatal("unjoined opening absorbed original book")
	}
	joined, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB})
	if err != nil {
		t.Fatal(err)
	}
	if joined.Entries[0].Status != "recorded" || joined.Tab.RecordedBalance["a"] != "125" || joined.Tab.ConfirmedBalance["a"] != "0" || joined.Tab.PendingBalance["a"] != "0" || joined.Tab.UnjoinedInvitation || joined.Entries[0].Rev != joined.Tab.Rev {
		t.Fatalf("Join lost source or fabricated acceptance: %+v", joined)
	}
	assertNoReview(t, joined.Entries[0])
	beforeRefusal, err := f.svc.Get(ctx, a, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Void(ctx, a, created.Entries[0].ID); !errors.Is(err, ErrRecordedOpeningFinal) {
		t.Fatalf("recorded opening cancelled: %v", err)
	}
	unchanged, err := f.svc.Get(ctx, a, 0)
	if err != nil || !reflect.DeepEqual(unchanged, beforeRefusal) {
		t.Fatal("opening refusal altered balance/revision", err)
	}
	retry, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB})
	if err != nil || retry.Entries[0].Rev != joined.Entries[0].Rev {
		t.Fatal("Join retry re-recorded opening", err)
	}
}

func TestNotifyBindingDoesNotSubstituteForJoiningOrAnOpeningReview(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created := createNotify(t, f, "125")
	b := f.party(t, created.InviteToken, created.Tab.ID)
	bound, err := f.svc.Bind(ctx, b, BindInput{AccountID: f.acctB})
	if err != nil {
		t.Fatal(err)
	}
	if bound.Tab.Parties["b"].JoinedAtMS != nil || bound.Entries[0].Status != "pending" {
		t.Fatal("binding silently recorded opening")
	}
	b = f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Append(ctx, b, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "5", OccurredAtMS: 101}); !errors.Is(err, ErrJoinRequired) {
		t.Fatalf("bound-but-unjoined party appended: %v", err)
	}
	if _, err := f.svc.Accept(ctx, b, created.Entries[0].ID); !errors.Is(err, ErrReviewNotRequired) {
		t.Fatalf("notify opening treated as review proposal: %v", err)
	}
	if got, err := f.svc.Get(ctx, b, 0); err != nil || !reflect.DeepEqual(got, bound) {
		t.Fatal("refused pre-join action mutated money", err)
	}
	if _, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
		t.Fatal(err)
	}
	if got := f.append(t, b, "b_to_a", "5", 102); got.Entry.Status != "recorded" || got.Tab.RecordedBalance["a"] != "120" {
		t.Fatalf("joined party cannot record repayment: %+v", got)
	}
}

func TestNotifyJoinDoesNotReviveWithdrawnOpening(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created := createNotify(t, f, "125")
	a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	withdrawn, err := f.svc.Void(ctx, a, created.Entries[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB})
	if err != nil {
		t.Fatal(err)
	}
	if joined.Tab.RecordedBalance["a"] != "0" || joined.Tab.ConfirmedBalance["a"] != "0" || joined.Tab.PendingBalance["a"] != "0" || len(joined.Entries) != 2 {
		t.Fatalf("Join revived withdrawn money: %+v", joined)
	}
	if !reflect.DeepEqual(joined.Entries[0], withdrawn.Voided) {
		t.Fatal("Join rewrote withdrawn opening evidence")
	}
	assertNoReview(t, joined.Entries[0])
}

func TestNotifyUnusedCancellationPreservesPrivateExposureAndOwnRecordedTallies(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	relationship, boundary := uuid.NewString(), int64(200)
	pushPrivateCreditEntry(t, f, relationship, "debt", "125", 100)
	created, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &boundary, Opening: &OpeningInput{Direction: "a_to_b", Amount: "125", OccurredAtMS: 100}})
	if err != nil {
		t.Fatal(err)
	}
	a := f.party(t, created.MyToken, created.Tab.ID)
	added := f.append(t, a, "a_to_b", "10", 250)
	if !added.Tab.UnjoinedInvitation || readPrivateCreditBalance(t, f, relationship) != 13500 {
		t.Fatal("own recorded tally absorbed/doubled private source")
	}
	closed, err := f.svc.Close(ctx, a, true)
	if err != nil {
		t.Fatal(err)
	}
	if !closed.Tab.UnjoinedInvitation || readPrivateCreditBalance(t, f, relationship) != 13500 || closed.Tab.RecordedBalance["a"] != "10" {
		t.Fatalf("unused close lost financial source: %+v %v", closed, err)
	}
	for _, e := range closed.Entries {
		if e.ID == created.Entries[0].ID && e.VoidedByEntryID == nil {
			t.Fatal("opening not withdrawn")
		}
		if e.ID == added.Entry.ID && e.VoidedByEntryID != nil {
			t.Fatal("ordinary recorded tally erased")
		}
		assertNoReview(t, e)
	}
}

func TestNotifyRecordedZeroChapterAndItsEntriesStayCleared(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created := createNotify(t, f, "")
	a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
		t.Fatal(err)
	}
	a = f.party(t, created.MyToken, created.Tab.ID)
	a.ActorAccountID = f.acctA
	loan := f.append(t, a, "a_to_b", "20", 100)
	paid := f.append(t, a, "b_to_a", "20", 101)
	marker, err := f.svc.Settle(ctx, a, SettleInput{ID: uuid.NewString(), ExpectedRev: paid.Tab.Rev})
	if err != nil {
		t.Fatal(err)
	}
	if marker.Tab.RecordedBalance["a"] != "0" || marker.Tab.ConfirmedBalance["a"] != "0" {
		t.Fatal(marker)
	}
	if _, err := f.svc.Void(ctx, a, loan.Entry.ID); !errors.Is(err, ErrSettledRecord) {
		t.Fatalf("cleared recorded chapter was modified: %v", err)
	}
	current, err := f.svc.Get(ctx, a, 0)
	if err != nil || current.Tab.Rev != marker.Tab.Rev || current.Tab.RecordedBalance["a"] != "0" {
		t.Fatal("settled refusal changed account", err)
	}
}

func TestNotifyJoinCloseRacePreservesOneAuthoritativeOpeningState(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	for i := 0; i < 8; i++ {
		created := createNotify(t, f, "125")
		a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
		start := make(chan struct{})
		closed := make(chan error, 1)
		joined := make(chan error, 1)
		go func() { <-start; _, err := f.svc.Close(ctx, a, true); closed <- err }()
		go func() {
			<-start
			_, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB})
			joined <- err
		}()
		close(start)
		closeErr, joinErr := <-closed, <-joined
		if closeErr != nil || joinErr != nil && !errors.Is(joinErr, ErrTabClosed) {
			t.Fatal(closeErr, joinErr)
		}
		got, err := f.svc.Get(ctx, a, 0)
		if err != nil {
			t.Fatal(err)
		}
		opening := got.Entries[0]
		assertNoReview(t, opening)
		if joinErr == nil {
			if opening.Status != "recorded" || opening.VoidedByEntryID != nil || got.Tab.RecordedBalance["a"] != "125" || got.Tab.UnjoinedInvitation {
				t.Fatalf("joined opening lost: %+v", got)
			}
		} else if opening.Status != "pending" || opening.VoidedByEntryID == nil || got.Tab.RecordedBalance["a"] != "0" || !got.Tab.UnjoinedInvitation {
			t.Fatalf("closed unused source not retained: %+v", got)
		}
	}
}

func recordingHTTP(t *testing.T, f *httpFixture, method, path, authz string, body any) httpResult {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, f.server.URL+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", authz)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kaata-Tab-Recording", "1")
	req.Header.Set("X-Kaata-Currencies", "1")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return httpResult{status: response.StatusCode, header: response.Header, body: data}
}

func TestNotifyHTTPRequiresCapabilityBeforeFinancialReadsOrWrites(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := t.Context()
	authA, authB := "Bearer "+f.jwtFor(t, f.acctA), "Bearer "+f.jwtFor(t, f.acctB)
	if result := f.do(t, "POST", "/v1/tabs", authA, map[string]any{"recording_mode": "notify", "currency": "AFN", "label": "A"}); result.status != 426 || result.json(t)["error_code"] != "recording_upgrade_required" {
		t.Fatalf("unsafe legacy create: %d %s", result.status, result.body)
	}
	response := recordingHTTP(t, f, "POST", "/v1/tabs", authA, map[string]any{"recording_mode": "notify", "currency": "AFN", "label": "A"})
	if response.status != 201 {
		t.Fatalf("guarded notify create: %s", response.body)
	}
	var created CreateResponse
	if err := json.Unmarshal(response.body, &created); err != nil {
		t.Fatal(err)
	}
	a := f.party(t, created.MyToken, created.Tab.ID)
	entry := f.append(t, a, "a_to_b", "10", 100).Entry
	base := "/v1/tabs/" + created.Tab.ID
	before, err := f.svc.Get(ctx, a, 0)
	if err != nil {
		t.Fatal(err)
	}
	routes := []struct {
		method, path, auth string
		body               any
	}{
		{"GET", base, authA, nil}, {"GET", "/v1/tabs/mine", authA, nil},
		{"POST", "/v1/tabs/by-token", authB, map[string]any{"token": created.InviteToken}},
		{"POST", base + "/join", authB, map[string]any{"token": created.InviteToken, "label": "B"}},
		{"POST", base + "/bind", authA, map[string]any{}},
		{"POST", base + "/entries", authA, map[string]any{}}, {"POST", base + "/label", authA, map[string]any{}},
		{"POST", base + "/entries/" + entry.ID + "/accept", authA, map[string]any{}},
		{"POST", base + "/entries/" + entry.ID + "/dispute", authA, map[string]any{}},
		{"POST", base + "/entries/" + entry.ID + "/void", authA, map[string]any{}},
		{"POST", base + "/settlements", authA, map[string]any{}}, {"POST", base + "/close", authA, map[string]any{}},
		{"POST", base + "/regenerate-link", authA, map[string]any{}}, {"POST", base + "/notifications", authA, map[string]any{}},
	}
	for _, route := range routes {
		t.Run(route.method+route.path, func(t *testing.T) {
			result := f.do(t, route.method, route.path, route.auth, route.body)
			if result.status != 426 || result.json(t)["error_code"] != "recording_upgrade_required" {
				t.Fatalf("legacy request escaped guard: %d %s", result.status, result.body)
			}
		})
	}
	after, err := f.svc.Get(ctx, a, 0)
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatal("unsupported requests changed financial state", err)
	}
	if got := recordingHTTP(t, f, "GET", base, authA, nil); got.status != 200 {
		t.Fatalf("new client read blocked: %d %s", got.status, got.body)
	}
	outsider := seedAccount(t, f.pool, "outside@example.com", "Outside")
	if got := f.do(t, "GET", base, "Bearer "+f.jwtFor(t, outsider), nil); got.status != 404 {
		t.Fatalf("mode existence leaked to outsider: %d", got.status)
	}
	legacy := f.createOverHTTP(t, authA)
	if legacy.Tab.RecordingMode != "review" {
		t.Fatal("legacy mode default changed")
	}
	if got := f.do(t, "GET", "/v1/tabs/"+legacy.Tab.ID, authA, nil); got.status != 200 {
		t.Fatalf("legacy review read changed: %d %s", got.status, got.body)
	}
}

func TestNotifyMigrationPreservesExistingReviewsAndDefaults(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created := f.create(t, "A", "", "")
	a, b := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
		t.Fatal(err)
	}
	b = f.party(t, created.InviteToken, created.Tab.ID)
	accepted := f.append(t, a, "a_to_b", "12.50", 100).Entry
	rejected := f.append(t, a, "a_to_b", "6", 101).Entry
	f.append(t, a, "b_to_a", "2", 102)
	if _, err := f.svc.Accept(ctx, b, accepted.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Dispute(ctx, b, rejected.ID, "Duplicate"); err != nil {
		t.Fatal(err)
	}
	before, err := f.svc.Get(ctx, a, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Recreate the preceding schema shape inside this test-only database, then
	// execute the shipped additive migration over real review history.
	if _, err := f.pool.Exec(ctx, `ALTER TABLE tabs DROP COLUMN recording_mode;
	 ALTER TABLE tabs DROP COLUMN notify_opening_source_revisions;
	 ALTER TABLE tab_entries DROP CONSTRAINT tab_entries_status_check;
	 ALTER TABLE tab_entries ADD CONSTRAINT tab_entries_status_check CHECK(status IN ('pending','accepted','disputed'));`); err != nil {
		t.Fatal(err)
	}
	ddl, err := os.ReadFile(filepath.Join("..", "db", "migrations", "069_notification_only_tabs.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, string(ddl)); err != nil {
		t.Fatal(err)
	}
	after, err := f.svc.Get(ctx, a, 0)
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("upgrade rewrote financial/review history: before=%+v after=%+v error=%v", before, after, err)
	}
}

func TestNotifyMixedHistoryKeepsOriginalPrivateOffsetsAndCheckpoints(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	relationship, firstBoundary, nextBoundary, lastBoundary := uuid.NewString(), int64(200), int64(500), int64(800)
	old, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Old", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &firstBoundary, Opening: &OpeningInput{Direction: "a_to_b", Amount: "120", OccurredAtMS: 100}})
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
	closedOld, err := f.svc.Close(ctx, f.party(t, old.MyToken, old.Tab.ID))
	if err != nil {
		t.Fatal(err)
	}
	pushPrivateCreditEntry(t, f, relationship, "payment", "20", 350)
	next, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "Notify", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &nextBoundary, ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closedOld.Tab.Rev, Opening: &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: 400}})
	if err != nil {
		t.Fatal(err)
	}
	if got := readPrivateCreditBalance(t, f, relationship); got != 10000 {
		t.Fatalf("unused notify opening doubled prior120-private20: %d", got)
	}
	joined, err := f.svc.Join(ctx, f.party(t, next.InviteToken, next.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB})
	if err != nil {
		t.Fatal(err)
	}
	if joined.Tab.RecordedBalance["a"] != "100" || joined.Tab.ConfirmedBalance["a"] != "0" || readPrivateCreditBalance(t, f, relationship) != 10000 {
		t.Fatal("recorded checkpoint lost original private offset")
	}
	closedNext, err := f.svc.Close(ctx, f.party(t, next.MyToken, next.Tab.ID))
	if err != nil {
		t.Fatal(err)
	}
	last, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Review again", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &lastBoundary, ExpectedPreviousTabID: &next.Tab.ID, ExpectedPreviousRev: &closedNext.Tab.Rev, ExpectedHistoryRevisions: map[string]int64{old.Tab.ID: closedOld.Tab.Rev, next.Tab.ID: closedNext.Tab.Rev}, Opening: &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: 700}})
	if err != nil {
		t.Fatal(err)
	}
	if got := readPrivateCreditBalance(t, f, relationship); got != 10000 {
		t.Fatalf("review replacement duplicated recorded checkpoint: %d", got)
	}
	peer := f.party(t, last.InviteToken, last.Tab.ID)
	if _, err := f.svc.Join(ctx, peer, JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(ctx, peer, last.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	if got := readPrivateCreditBalance(t, f, relationship); got != 10000 {
		t.Fatalf("accepted replacement lost recorded history: %d", got)
	}
	if old.Tab.RecordingMode != "review" || next.Tab.RecordingMode != "notify" || last.Tab.RecordingMode != "review" {
		t.Fatal("existing mode converted")
	}
}

func TestNotifyRecordedExposureStillEnforcesClerkCreditLimits(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	relationship, boundary := uuid.NewString(), int64(200)
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	created, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship, LinkedAtMS: &boundary})
	if err != nil {
		t.Fatal(err)
	}
	clerk := seedAccount(t, f.pool, "recording-clerk@example.com", "Clerk")
	seedMember(t, f.pool, f.vaultA, clerk, "clerk")
	p, err := f.svc.PartyByAccount(ctx, created.Tab.ID, clerk)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',1)`, f.vaultA, relationship); err != nil {
		t.Fatal(err)
	}
	first := f.append(t, p, "a_to_b", "100", 250)
	if first.Entry.Status != "recorded" {
		t.Fatal("clerk tally not recorded")
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "0.01", OccurredAtMS: 251}); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("recorded exposure bypassed credit: %v", err)
	}
	if got := readPrivateCreditBalance(t, f, relationship); got != 10000 {
		t.Fatalf("refusal changed recorded exposure: %d", got)
	}
	f.append(t, p, "b_to_a", "0.01", 252)
	if got := readPrivateCreditBalance(t, f, relationship); got != 9999 {
		t.Fatalf("recorded repayment lost precision: %d", got)
	}
}

func TestNotifyRecordedSourcesFreezeAfterEitherPartyCarriesThemForward(t *testing.T) {
	for _, mode := range []string{"notify", "review"} {
		t.Run(mode, func(t *testing.T) {
			f := newTabFixture(t)
			ctx := t.Context()
			recipientRelationship := uuid.NewString()
			old := createNotify(t, f, "")
			if _, err := f.svc.Join(ctx, f.party(t, old.InviteToken, old.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB, RelationshipID: &recipientRelationship}); err != nil {
				t.Fatal(err)
			}
			a := f.party(t, old.MyToken, old.Tab.ID)
			original := f.append(t, a, "a_to_b", "10", 100).Entry
			closed, err := f.svc.Close(ctx, a)
			if err != nil {
				t.Fatal(err)
			}
			// Only the old recipient's scope is carried: the original author has
			// no relationship binding. Freeze must examine both parties' histories.
			next, err := f.svc.Create(ctx, CreateInput{RecordingMode: mode, Currency: "AFN", Label: "B next", AccountID: &f.acctB, VaultID: &f.vaultB, RelationshipID: &recipientRelationship, ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev, Opening: &OpeningInput{Direction: "b_to_a", Amount: "10", OccurredAtMS: 200}})
			if err != nil {
				t.Fatal(err)
			}
			peer := f.party(t, next.InviteToken, next.Tab.ID)
			if _, err := f.svc.Join(ctx, peer, JoinInput{Label: "A", AccountID: &f.acctA}); err != nil {
				t.Fatal(err)
			}
			if mode == "review" {
				if _, err := f.svc.Accept(ctx, peer, next.Entries[0].ID); err != nil {
					t.Fatal(err)
				}
			}
			oldBefore, err := f.svc.Get(ctx, a, 0)
			if err != nil {
				t.Fatal(err)
			}
			currentBefore, err := f.svc.Get(ctx, f.party(t, next.MyToken, next.Tab.ID), 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.Void(ctx, a, original.ID); !errors.Is(err, ErrRecordedHistoryFinal) {
				t.Fatalf("carried recorded source remained mutable: %v", err)
			}
			oldAfter, err := f.svc.Get(ctx, a, 0)
			if err != nil || !reflect.DeepEqual(oldBefore, oldAfter) {
				t.Fatal("refused source withdrawal changed original audit/balance/revision", err)
			}
			currentAfter, err := f.svc.Get(ctx, f.party(t, next.MyToken, next.Tab.ID), 0)
			if err != nil || !reflect.DeepEqual(currentBefore, currentAfter) {
				t.Fatal("refused source withdrawal changed carry-over", err)
			}
		})
	}
}

func TestNotifyPendingReplacementDoesNotFreezeRecordedSource(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	relationship := uuid.NewString()
	old, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship})
	if err != nil {
		t.Fatal(err)
	}
	a := f.party(t, old.MyToken, old.Tab.ID)
	original := f.append(t, a, "a_to_b", "10", 100).Entry
	closed, err := f.svc.Close(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	next, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "Pending invite", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship, ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev, Opening: &OpeningInput{Direction: "a_to_b", Amount: "10", OccurredAtMS: 200}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Void(ctx, a, original.ID); err != nil {
		t.Fatalf("unused pending invitation froze source: %v", err)
	}
	got, err := f.svc.Get(ctx, f.party(t, next.MyToken, next.Tab.ID), 0)
	if err != nil || got.Entries[0].Status != "pending" || got.Tab.RecordedBalance["a"] != "0" || got.Tab.ConfirmedBalance["a"] != "0" {
		t.Fatal("source withdrawal acknowledged unused opening", err)
	}
	before := got
	b := f.party(t, next.InviteToken, next.Tab.ID)
	if _, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB}); !errors.Is(err, ErrOpeningSourceChanged) {
		t.Fatalf("stale source became an authoritative opening: %v", err)
	}
	after, err := f.svc.Get(ctx, f.party(t, next.MyToken, next.Tab.ID), 0)
	if err != nil || !reflect.DeepEqual(before, after) || f.party(t, next.InviteToken, next.Tab.ID).JoinedAt != nil {
		t.Fatal("stale Join changed invitation/balance/revision", err)
	}
	// The sender can cancel this unused proposal and create a fresh zero link.
	cancelled, err := f.svc.Close(ctx, f.party(t, next.MyToken, next.Tab.ID), true)
	if err != nil {
		t.Fatal(err)
	}
	oldAfter, err := f.svc.Get(ctx, a, 0)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "Fresh", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship, ExpectedPreviousTabID: &next.Tab.ID, ExpectedPreviousRev: &cancelled.Tab.Rev, ExpectedHistoryRevisions: map[string]int64{old.Tab.ID: oldAfter.Tab.Rev, next.Tab.ID: cancelled.Tab.Rev}})
	if err != nil {
		t.Fatalf("could not recreate stale invitation: %v", err)
	}
	joined, err := f.svc.Join(ctx, f.party(t, fresh.InviteToken, fresh.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB})
	if err != nil || joined.Tab.RecordedBalance["a"] != "0" || len(joined.Entries) != 0 {
		t.Fatal("fresh invitation restored cancelled carry", err)
	}
}

func TestNotifyOpeningWithoutStoredSourceFailsClosed(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created := createNotify(t, f, "10")
	if _, err := f.pool.Exec(ctx, `UPDATE tabs SET notify_opening_source_revisions=NULL WHERE id=$1::uuid`, created.Tab.ID); err != nil {
		t.Fatal(err)
	}
	a := f.party(t, created.MyToken, created.Tab.ID)
	before, err := f.svc.Get(ctx, a, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Join(ctx, f.party(t, created.InviteToken, created.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB}); !errors.Is(err, ErrOpeningSourceChanged) {
		t.Fatalf("unbacked opening recorded: %v", err)
	}
	after, err := f.svc.Get(ctx, a, 0)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("unbacked Join changed state", err)
	}
	status, code, _ := mapServiceError(ErrOpeningSourceChanged)
	if status != http.StatusConflict || code != "opening_source_changed" {
		t.Fatalf("wrong recovery contract: %d %s", status, code)
	}
}

func TestNotifyRecordedWithdrawalSerializesWithLaterOpeningAcknowledgement(t *testing.T) {
	for _, mode := range []string{"notify", "review"} {
		t.Run(mode, func(t *testing.T) {
			f := newTabFixture(t)
			ctx := t.Context()
			for i := 0; i < 8; i++ {
				relationship := uuid.NewString()
				old, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship})
				if err != nil {
					t.Fatal(err)
				}
				a := f.party(t, old.MyToken, old.Tab.ID)
				original := f.append(t, a, "a_to_b", "10", 100).Entry
				closed, err := f.svc.Close(ctx, a)
				if err != nil {
					t.Fatal(err)
				}
				next, err := f.svc.Create(ctx, CreateInput{RecordingMode: mode, Currency: "AFN", Label: "Next", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship, ExpectedPreviousTabID: &old.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev, Opening: &OpeningInput{Direction: "a_to_b", Amount: "10", OccurredAtMS: 200}})
				if err != nil {
					t.Fatal(err)
				}
				b := f.party(t, next.InviteToken, next.Tab.ID)
				if mode == "review" {
					if _, err := f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
						t.Fatal(err)
					}
				}
				start := make(chan struct{})
				voided := make(chan error, 1)
				acknowledged := make(chan error, 1)
				go func() { <-start; _, err := f.svc.Void(ctx, a, original.ID); voided <- err }()
				go func() {
					<-start
					var err error
					if mode == "notify" {
						_, err = f.svc.Join(ctx, b, JoinInput{Label: "B", AccountID: &f.acctB})
					} else {
						_, err = f.svc.Accept(ctx, b, next.Entries[0].ID)
					}
					acknowledged <- err
				}()
				close(start)
				voidErr, ackErr := <-voided, <-acknowledged
				if mode == "notify" && voidErr == nil {
					if !errors.Is(ackErr, ErrOpeningSourceChanged) {
						t.Fatalf("source withdrawal winner allowed stale Join: %v", ackErr)
					}
				} else if ackErr != nil || voidErr != nil && !errors.Is(voidErr, ErrRecordedHistoryFinal) {
					t.Fatalf("history checkpoint race failed: void=%v ack=%v", voidErr, ackErr)
				}
				oldState, err := f.svc.Get(ctx, a, 0)
				if err != nil {
					t.Fatal(err)
				}
				if (oldState.Entries[0].VoidedByEntryID != nil) != (voidErr == nil) {
					t.Fatal("race lost source withdrawal audit")
				}
				current, err := f.svc.Get(ctx, f.party(t, next.MyToken, next.Tab.ID), 0)
				wantBalance := "10"
				if mode == "notify" && voidErr == nil {
					wantBalance = "0"
					if current.Entries[0].Status != "pending" || current.Tab.Rev != next.Tab.Rev || current.Tab.Parties["b"].JoinedAtMS != nil {
						t.Fatal("stale Join partially changed invitation")
					}
				}
				if err != nil || current.Tab.RecordedBalance["a"] != wantBalance {
					t.Fatal("race altered authoritative carry-over", err)
				}
				if _, err := f.svc.Void(ctx, a, original.ID); voidErr != nil && !errors.Is(err, ErrRecordedHistoryFinal) {
					t.Fatalf("post-checkpoint source edit escaped: %v", err)
				}
			}
		})
	}
}
