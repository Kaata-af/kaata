package tabs

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/credit"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func acceptedRemovalEntry(t *testing.T, f *tabFixture, a, b Party, direction, amount string) Entry {
	t.Helper()
	e := f.append(t, a, direction, amount, 1_790_000_000_000).Entry
	r, err := f.svc.Accept(t.Context(), b, e.ID)
	if err != nil {
		t.Fatal(err)
	}
	return r.Entry
}

func requestRemoval(t *testing.T, f *tabFixture, p Party, e Entry) Entry {
	t.Helper()
	r, err := f.svc.Removal(t.Context(), p, e.ID, RemovalInput{Action: "request", RequestID: uuid.NewString(), ExpectedRev: &e.Rev})
	if err != nil {
		t.Fatal(err)
	}
	return r.Entry
}

func TestMutualRemovalPreservesBalanceAndEvidenceUntilAgreement(t *testing.T) {
	f := newTabFixture(t)
	a, b := settlementParties(t, f)
	original := acceptedRemovalEntry(t, f, a, b, "a_to_b", "12.34")
	request := RemovalInput{Action: "request", RequestID: uuid.NewString(), ExpectedRev: &original.Rev}
	proposed, err := f.svc.Removal(t.Context(), a, original.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if proposed.Entry.Rev != original.Rev+1 || proposed.Entry.RemovalState == nil || *proposed.Entry.RemovalState != "pending" || proposed.Tab.ConfirmedBalance["a"] != "12.34" || proposed.Entry.VoidedByEntryID != nil {
		t.Fatalf("pending changed balance: %+v", proposed)
	}
	retry, err := f.svc.Removal(t.Context(), a, original.ID, request)
	if err != nil || !reflect.DeepEqual(proposed, retry) {
		t.Fatalf("request retry: %+v %v", retry, err)
	}
	if _, err = f.svc.Void(t.Context(), a, original.ID); !errors.Is(err, ErrReviewFinal) {
		t.Fatalf("legacy void weakened: %v", err)
	}
	if _, err = f.svc.Removal(t.Context(), a, original.ID, RemovalInput{Action: "approve", RequestID: request.RequestID}); !errors.Is(err, ErrRemovalWrongParty) {
		t.Fatalf("self approval: %v", err)
	}
	decline := RemovalInput{Action: "decline", RequestID: request.RequestID, ExpectedRev: &proposed.Entry.Rev}
	declined, err := f.svc.Removal(t.Context(), b, original.ID, decline)
	if err != nil {
		t.Fatal(err)
	}
	if *declined.Entry.RemovalState != "declined" || declined.Tab.ConfirmedBalance["a"] != "12.34" || declined.Entry.VoidedByEntryID != nil {
		t.Fatalf("decline changed balance: %+v", declined)
	}
	if retry, err = f.svc.Removal(t.Context(), b, original.ID, decline); err != nil || !reflect.DeepEqual(declined, retry) {
		t.Fatalf("decline retry: %+v %v", retry, err)
	}
	// A fresh instance can be proposed by either party, independently of who
	// authored the original. The old decision can never target this instance.
	newRequest := RemovalInput{Action: "request", RequestID: uuid.NewString(), ExpectedRev: &declined.Entry.Rev}
	proposed, err = f.svc.Removal(t.Context(), b, original.ID, newRequest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Removal(t.Context(), b, original.ID, decline); !errors.Is(err, ErrRemovalConflict) {
		t.Fatalf("old decision applied: %v", err)
	}
	request.ExpectedRev = &proposed.Entry.Rev
	if _, err = f.svc.Removal(t.Context(), a, original.ID, request); !errors.Is(err, ErrRemovalConflict) {
		t.Fatalf("old ID reused: %v", err)
	}
	approve := RemovalInput{Action: "approve", RequestID: newRequest.RequestID, ExpectedRev: &proposed.Entry.Rev}
	approved, err := f.svc.Removal(t.Context(), a, original.ID, approve)
	if err != nil {
		t.Fatal(err)
	}
	if *approved.Entry.RemovalState != "approved" || approved.Entry.VoidedByEntryID == nil || approved.Tab.ConfirmedBalance["a"] != "0" || approved.Tab.Balance["a"] != "0" {
		t.Fatalf("approval: %+v", approved)
	}
	if retry, err = f.svc.Removal(t.Context(), a, original.ID, approve); err != nil || !reflect.DeepEqual(approved, retry) {
		t.Fatalf("approval retry: %+v %v", retry, err)
	}
	// The original acceptance evidence is unchanged; the new journal records
	// the requester as author and approving individual as reviewer.
	copy := approved.Entry
	copy.Rev = original.Rev
	copy.RemovalRequestID = nil
	copy.RemovalRequestedBy = nil
	copy.RemovalState = nil
	copy.VoidedByEntryID = nil
	if !reflect.DeepEqual(copy, original) {
		t.Fatal("original review evidence changed")
	}
	delta, err := f.svc.Get(t.Context(), a, proposed.Entry.Rev)
	if err != nil {
		t.Fatal(err)
	}
	if len(delta.Entries) != 2 {
		t.Fatalf("incremental pull missed pair: %+v", delta.Entries)
	}
	void := delta.Entries[1]
	if void.Kind != "void" || void.CreatedBy != "b" || void.AuthorAccountID == nil || *void.AuthorAccountID != f.acctB || void.ReviewerAccountID == nil || *void.ReviewerAccountID != f.acctA || void.ReviewerParty == nil || *void.ReviewerParty != "a" || void.VoidsEntryID == nil || *void.VoidsEntryID != original.ID || void.ReviewSemanticsVersion == nil || *void.ReviewSemanticsVersion != removalSemanticsVersion {
		t.Fatalf("reversal evidence: %+v", void)
	}
	var requests, notices, read int
	if err = f.pool.QueryRow(t.Context(), `SELECT count(*) FROM tab_entry_removal_requests WHERE entry_id=$1::uuid`, original.ID).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if err = f.pool.QueryRow(t.Context(), `SELECT count(*) FROM tab_notifications WHERE entry_id=$1::uuid AND event_kind LIKE 'entry_removal_%'`, original.ID).Scan(&notices); err != nil {
		t.Fatal(err)
	}
	if err = f.pool.QueryRow(t.Context(), `SELECT count(*) FROM tab_notifications n JOIN tab_notification_reads r ON r.notification_id=n.id WHERE n.entry_id=$1::uuid AND n.event_kind='entry_removal_requested'`, original.ID).Scan(&read); err != nil {
		t.Fatal(err)
	}
	if requests != 2 || notices != 4 || read != 2 {
		t.Fatalf("duplicate/missing audit requests=%d notices=%d reads=%d", requests, notices, read)
	}
}

func TestMutualRemovalEligibilityAndSettlementBoundary(t *testing.T) {
	f := newTabFixture(t)
	for _, state := range []string{"pending", "disputed", "opening", "notify", "notify_one_way", "voided", "closed", "settled", "carried"} {
		t.Run(state, func(t *testing.T) {
			a, b := settlementParties(t, f)
			e := f.append(t, a, "a_to_b", "10", 1_790_000_000_000).Entry
			want := ErrRemovalIneligible
			if state == "disputed" {
				_, err := f.svc.Dispute(t.Context(), b, e.ID, "")
				if err != nil {
					t.Fatal(err)
				}
			} else if state != "pending" && state != "voided" {
				e = mustAcceptRemoval(t, f, b, e)
			}
			switch state {
			case "opening":
				mustRemovalSQL(t, f, `UPDATE tab_entries SET kind='opening' WHERE id=$1::uuid`, e.ID)
			case "notify", "notify_one_way":
				mustRemovalSQL(t, f, `UPDATE tabs SET recording_mode=$2 WHERE id=$1::uuid`, a.TabID, state)
			case "voided":
				_, err := f.svc.Void(t.Context(), a, e.ID)
				if err != nil {
					t.Fatal(err)
				}
			case "closed":
				_, err := f.svc.Close(t.Context(), a)
				if err != nil {
					t.Fatal(err)
				}
				want = ErrTabClosed
			case "settled":
				acceptedRemovalEntry(t, f, a, b, "b_to_a", "10")
				_, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: currentSettlementRev(t, f, a)})
				if err != nil {
					t.Fatal(err)
				}
				want = ErrSettledRecord
			case "carried":
				laterA, laterB := settlementParties(t, f)
				opening := acceptedRemovalEntry(t, f, laterA, laterB, "a_to_b", "10")
				rel := uuid.NewString()
				mustRemovalSQL(t, f, `UPDATE tab_parties SET relationship_id=$2::uuid,history_order=CASE WHEN tab_id=$3::uuid THEN 1 ELSE 2 END WHERE role='a' AND tab_id IN ($1::uuid,$3::uuid)`, laterA.TabID, rel, a.TabID)
				mustRemovalSQL(t, f, `UPDATE tab_entries SET kind='opening' WHERE id=$1::uuid`, opening.ID)
				want = ErrRecordedHistoryFinal
			}
			before, err := f.svc.Get(t.Context(), a, 0)
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.svc.Removal(t.Context(), a, e.ID, RemovalInput{Action: "request", RequestID: uuid.NewString(), ExpectedRev: &e.Rev})
			if !errors.Is(err, want) {
				t.Fatalf("got %v want %v", err, want)
			}
			after, err := f.svc.Get(t.Context(), a, 0)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("ineligible removal mutated ledger")
			}
		})
	}
	t.Run("pending removal blocks zero settlement", func(t *testing.T) {
		a, b := settlementParties(t, f)
		e := acceptedRemovalEntry(t, f, a, b, "a_to_b", "10")
		acceptedRemovalEntry(t, f, a, b, "b_to_a", "10")
		pending := requestRemoval(t, f, a, e)
		if _, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: currentSettlementRev(t, f, a)}); !errors.Is(err, ErrSettlementPending) {
			t.Fatalf("settled unresolved removal: %v", err)
		}
		if _, err := f.svc.Removal(t.Context(), b, e.ID, RemovalInput{Action: "decline", RequestID: *pending.RemovalRequestID}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: currentSettlementRev(t, f, a)}); err != nil {
			t.Fatal(err)
		}
	})
}

func mustAcceptRemoval(t *testing.T, f *tabFixture, p Party, e Entry) Entry {
	t.Helper()
	r, err := f.svc.Accept(t.Context(), p, e.ID)
	if err != nil {
		t.Fatal(err)
	}
	return r.Entry
}
func mustRemovalSQL(t *testing.T, f *tabFixture, query string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func TestMutualRemovalConcurrentDecisionsAndRequests(t *testing.T) {
	f := newTabFixture(t)
	a, b := settlementParties(t, f)
	for i := 0; i < 4; i++ {
		e := acceptedRemovalEntry(t, f, a, b, "a_to_b", "1")
		start := make(chan struct{})
		responses := make(chan error, 2)
		for j := 0; j < 2; j++ {
			go func() {
				<-start
				_, err := f.svc.Removal(t.Context(), a, e.ID, RemovalInput{Action: "request", RequestID: uuid.NewString(), ExpectedRev: &e.Rev})
				responses <- err
			}()
		}
		close(start)
		wins := 0
		for j := 0; j < 2; j++ {
			err := <-responses
			if err == nil {
				wins++
			} else if !errors.Is(err, ErrStaleReview) && !errors.Is(err, ErrRemovalConflict) {
				t.Fatal(err)
			}
		}
		if wins != 1 {
			t.Fatalf("request winners=%d", wins)
		}
		var requestID string
		if err := f.pool.QueryRow(t.Context(), `SELECT removal_request_id::text FROM tab_entries WHERE id=$1::uuid`, e.ID).Scan(&requestID); err != nil {
			t.Fatal(err)
		}
		start = make(chan struct{})
		wins = 0
		for _, action := range []string{"approve", "decline"} {
			go func(action string) {
				<-start
				_, err := f.svc.Removal(t.Context(), b, e.ID, RemovalInput{Action: action, RequestID: requestID})
				responses <- err
			}(action)
		}
		close(start)
		for j := 0; j < 2; j++ {
			err := <-responses
			if err == nil {
				wins++
			} else if !errors.Is(err, ErrRemovalConflict) {
				t.Fatal(err)
			}
		}
		if wins != 1 {
			t.Fatalf("decision winners=%d", wins)
		}
		var notices int
		if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM tab_notifications WHERE entry_id=$1::uuid AND event_kind IN ('entry_removal_approved','entry_removal_declined')`, e.ID).Scan(&notices); err != nil {
			t.Fatal(err)
		}
		if notices != 1 {
			t.Fatalf("decision notices=%d", notices)
		}
	}
}

func TestHTTPMutualRemovalSessionRoleAndRequestGuards(t *testing.T) {
	f := newHTTPFixture(t)
	a, b := settlementParties(t, f.tabFixture)
	e := acceptedRemovalEntry(t, f.tabFixture, a, b, "a_to_b", "1")
	path := "/v1/tabs/" + a.TabID + "/entries/" + e.ID + "/removal"
	jwtA := "Bearer " + f.jwtFor(t, f.acctA)
	jwtB := "Bearer " + f.jwtFor(t, f.acctB)
	body := map[string]any{"action": "request", "request_id": uuid.NewString(), "expected_rev": e.Rev}
	if r := f.do(t, "POST", path, "", body); r.status != 404 {
		t.Fatalf("anonymous: %d %s", r.status, r.body)
	}
	for _, bad := range []map[string]any{{"action": "request", "request_id": uuid.NewString()}, {"action": "request", "request_id": uuid.NewString(), "expected_rev": 0}, {"action": "remove", "request_id": uuid.NewString(), "expected_rev": e.Rev}, {"action": "request", "request_id": "00000000-0000-0000-0000-000000000000", "expected_rev": e.Rev}} {
		if r := f.do(t, "POST", path, jwtA, bad); r.status != 400 || r.json(t)["error_code"] != "invalid_removal" {
			t.Fatalf("invalid: %d %s", r.status, r.body)
		}
	}
	stale := map[string]any{"action": "request", "request_id": uuid.NewString(), "expected_rev": e.Rev - 1}
	if r := f.do(t, "POST", path, jwtA, stale); r.status != 409 || r.json(t)["error_code"] != "stale_review" {
		t.Fatalf("stale: %d %s", r.status, r.body)
	}
	if r := f.do(t, "POST", path, jwtA, body); r.status != 200 || r.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("request: %d %s", r.status, r.body)
	}
	decision := map[string]any{"action": "approve", "request_id": body["request_id"]}
	seedMember(t, f.pool, f.vaultB, f.acctA, "editor")
	if r := f.do(t, "POST", path, jwtA, decision, "b"); r.status != 403 || r.json(t)["error_code"] != "removal_wrong_party" {
		t.Fatalf("dual-side account approved itself: %d %s", r.status, r.body)
	}
	for _, role := range []string{"viewer", "clerk"} {
		mustRemovalSQL(t, f.tabFixture, `UPDATE vault_members SET role=$3 WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultB, f.acctB, role)
		if _, err := f.svc.Removal(t.Context(), b, e.ID, RemovalInput{Action: "approve", RequestID: body["request_id"].(string)}); !errors.Is(err, ErrRoleInsufficient) {
			t.Fatalf("stale resolved owner authority survived %s: %v", role, err)
		}
		if r := f.do(t, "POST", path, jwtB, decision); r.status != 403 {
			t.Fatalf("%s approved: %d %s", role, r.status, r.body)
		}
	}
	mustRemovalSQL(t, f.tabFixture, `UPDATE vault_members SET role='owner' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultB, f.acctB)
	if r := f.do(t, "POST", path, jwtB, decision); r.status != 200 {
		t.Fatalf("approve: %d %s", r.status, r.body)
	} else {
		var out EntryResponse
		if err := json.Unmarshal(r.body, &out); err != nil || out.Entry.RemovalState == nil || *out.Entry.RemovalState != "approved" {
			t.Fatalf("wire: %s %v", r.body, err)
		}
	}
}

func TestMutualRemovalDurableEvidenceAndRevokedRequester(t *testing.T) {
	f := newTabFixture(t)
	a, b := settlementParties(t, f)
	staff := seedAccount(t, f.pool, "removal-staff@example.com", "Staff")
	seedMember(t, f.pool, f.vaultA, staff, "editor")
	p, err := f.svc.PartyByAccount(t.Context(), a.TabID, staff)
	if err != nil {
		t.Fatal(err)
	}
	e := acceptedRemovalEntry(t, f, a, b, "a_to_b", "10")
	pending := requestRemoval(t, f, p, e)
	mustRemovalSQL(t, f, `UPDATE vault_members SET role='viewer' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, staff)
	if _, err = f.svc.Removal(t.Context(), b, e.ID, RemovalInput{Action: "approve", RequestID: *pending.RemovalRequestID}); !errors.Is(err, ErrRemovalIneligible) {
		t.Fatalf("removed requester authority survived: %v", err)
	}
	mustRemovalSQL(t, f, `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, staff)
	approved, err := f.svc.Removal(t.Context(), b, e.ID, RemovalInput{Action: "approve", RequestID: *pending.RemovalRequestID})
	if err != nil {
		t.Fatal(err)
	}
	mustRemovalSQL(t, f, `DELETE FROM vault_members WHERE account_id=$1::uuid`, staff)
	mustRemovalSQL(t, f, `DELETE FROM accounts WHERE id=$1::uuid`, staff)
	if retried, err := f.svc.Removal(t.Context(), b, e.ID, RemovalInput{Action: "approve", RequestID: *pending.RemovalRequestID}); err != nil || !reflect.DeepEqual(retried, approved) {
		t.Fatalf("completed approval retry after requester erasure: %+v %v", retried, err)
	}
	var actor, evidence string
	var liveAuthor *string
	if err = f.pool.QueryRow(t.Context(), `SELECT r.requester_account_id::text,e.author_evidence_account_id::text,e.author_account_id::text
	 FROM tab_entry_removal_requests r JOIN tab_entries e ON e.id=$2::uuid WHERE r.id=$1::uuid`, *pending.RemovalRequestID, *approved.Entry.VoidedByEntryID).Scan(&actor, &evidence, &liveAuthor); err != nil {
		t.Fatal(err)
	}
	if actor != staff || evidence != staff || liveAuthor != nil {
		t.Fatalf("erasure lost attribution: actor=%s evidence=%s live=%v", actor, evidence, liveAuthor)
	}
	// The two-way current-request references must not strand a deleted tab.
	mustRemovalSQL(t, f, `DELETE FROM tabs WHERE id=$1::uuid`, a.TabID)
	var count int
	if err = f.pool.QueryRow(t.Context(), `SELECT count(*) FROM tab_entry_removal_requests WHERE id=$1::uuid`, *pending.RemovalRequestID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("request cleanup count=%d error=%v", count, err)
	}
}

func TestMutualRemovalChecksRequesterAndApproverCredit(t *testing.T) {
	f := newTabFixture(t)
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	for _, restrictedSide := range []string{"requester", "approver"} {
		t.Run(restrictedSide, func(t *testing.T) {
			a, b := settlementParties(t, f)
			rel := uuid.NewString()
			mustRemovalSQL(t, f, `UPDATE tab_parties SET relationship_id=$2::uuid,history_order=nextval('tab_party_history_order_seq'),linked_at_ms=0 WHERE tab_id=$1::uuid AND role='a'`, a.TabID, rel)
			var err error
			a, err = f.svc.PartyByAccount(t.Context(), a.TabID, f.acctA)
			if err != nil {
				t.Fatal(err)
			}
			acceptedRemovalEntry(t, f, a, b, "a_to_b", "160")
			payment := acceptedRemovalEntry(t, f, a, b, "b_to_a", "80")
			editor := seedAccount(t, f.pool, "editor-"+uuid.NewString()+"@example.com", "Editor")
			seedMember(t, f.pool, f.vaultA, editor, "editor")
			p, err := f.svc.PartyByAccount(t.Context(), a.TabID, editor)
			if err != nil {
				t.Fatal(err)
			}
			mustRemovalSQL(t, f, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',true,1)`, f.vaultA, rel)
			requester, approver := p, b
			if restrictedSide == "approver" {
				requester, approver = b, p
			}
			pending := requestRemoval(t, f, requester, payment)
			before, err := f.svc.Get(t.Context(), a, 0)
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.svc.Removal(t.Context(), approver, payment.ID, RemovalInput{Action: "approve", RequestID: *pending.RemovalRequestID})
			if !errors.Is(err, credit.ErrLimit) {
				t.Fatalf("%s bypassed cap: %v", restrictedSide, err)
			}
			after, err := f.svc.Get(t.Context(), a, 0)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("credit refusal partially committed")
			}
		})
	}
}
