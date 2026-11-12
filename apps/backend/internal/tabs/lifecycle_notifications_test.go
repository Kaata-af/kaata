package tabs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSharedInvitationCancelLocksRecipientBeforeGroup(t *testing.T) {
	f := newHTTPFixture(t)
	publishRequestRecipient(t, f.tabFixture)
	in := groupInput(t, f.tabFixture, "review")
	made, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.SendPeopleRequest(t.Context(), f.acctA, made.Group.ID, f.acctB); err != nil {
		t.Fatal(err)
	}
	blocker, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(t.Context())
	if _, err = blocker.Exec(t.Context(), `SELECT 1 FROM accounts WHERE id=$1::uuid FOR UPDATE`, f.acctB); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	closed := make(chan error, 1)
	go func() { _, err := f.svc.CloseGroup(ctx, made.Group.ID, f.acctA, "a", true); closed <- err }()
	waiting := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err = f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
   AND query LIKE '%disabled_at IS NULL AND pending_delete_at IS NULL FROM accounts WHERE id=ANY%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("close did not wait for its recipient before taking the group lock")
	}
	// An account-deletion/pair transaction can still take the group lock: no
	// group->recipient-FK inversion while cancellation waits on the account.
	if _, err = blocker.Exec(ctx, `SELECT 1 FROM tab_groups WHERE id=$1::uuid FOR UPDATE NOWAIT`, made.Group.ID); err != nil {
		t.Fatalf("inverted cancellation locks: %v", err)
	}
	if err = blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-closed; err != nil {
		t.Fatal(err)
	}
	var notices int
	if err = f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind='shared_invite_cancelled'`).Scan(&notices); err != nil || notices != 1 {
		t.Fatal(notices, err)
	}
}

func TestSharedInvitationCancellationNotifiesUnboundRecipientOnce(t *testing.T) {
	f := newHTTPFixture(t)
	publishRequestRecipient(t, f.tabFixture)
	registerAccountPush(t, f, f.jwtFor(t, f.acctB), "ExpoPushToken[unbound_invitee_test]", legacyNotificationPreferences())
	in := groupInput(t, f.tabFixture, "review")
	made, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	request, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, made.Group.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.SendPeopleRequest(t.Context(), f.acctA, made.Group.ID, f.acctB); err != nil {
		t.Fatal(err)
	}
	page, err := f.svc.listInbox(t.Context(), f.acctB, "en", 0, connectionEventKinds)
	if err != nil || page.Unread != 1 || page.RequestUnread != 1 || len(page.Items) != 1 || page.Items[0].SourceID != request.ID {
		t.Fatalf("request history %+v %v", page, err)
	}
	for i := 0; i < 2; i++ {
		if _, err = f.svc.CloseGroup(t.Context(), made.Group.ID, f.acctA, "a", true); err != nil {
			t.Fatal(err)
		}
	}
	page, err = f.svc.listInbox(t.Context(), f.acctB, "en", 0, connectionEventKinds)
	if err != nil || page.Unread != 1 || page.RequestUnread != 0 || len(page.Items) != 2 || page.Items[0].Kind != "shared_invite_cancelled" || !page.Items[1].Read {
		t.Fatalf("cancel history %+v %v", page, err)
	}
	if accountPushCount(t, f, "account_connection_notifications") != 2 {
		t.Fatal("retry/multi-currency duplicate")
	}
	sends := []string{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		_ = json.NewDecoder(r.Body).Decode(&p)
		sends = append(sends, p["data"].(map[string]any)["kind"].(string))
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"cancel-ticket"}}`))
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	for i := 0; i < 3; i++ {
		more, err := f.svc.deliverAccountPush(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if !more {
			break
		}
	}
	if len(sends) != 1 || sends[0] != "shared_invite_cancelled" {
		t.Fatalf("stale request delivered or missing cancel: %v", sends)
	}
}

func TestGroupUnlinkIsOneNamedNotice(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	made, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.JoinGroup(t.Context(), made.Group.ID, joinGroupInput(f, in)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err = f.svc.CloseGroup(t.Context(), made.Group.ID, f.acctA, "a", false); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err = f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM tab_notifications WHERE event_kind='unlinked'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("unlinks %d err%v", n, err)
	}
	page, err := f.svc.listInbox(t.Context(), f.acctB, "en", 0, nil)
	if err != nil || len(page.Items) != 3 || page.Items[0].Kind != "unlinked" {
		t.Fatalf("unlink inbox %+v %v", page, err)
	}
	for _, item := range page.Items[1:] {
		if item.Kind != "entry_created" || item.EntryID == "" {
			t.Fatalf("opening missing clear amount/entry notification: %+v", item)
		}
	}
}

func TestSettlementPushSurvivesImmediateUnlink(t *testing.T) {
	f := newHTTPFixture(t)
	a, b := settlementParties(t, f.tabFixture)
	rev := acceptedSettlementPair(t, f.tabFixture, a, b)
	got := f.do(t, "POST", "/v1/tabs/"+a.TabID+"/notifications", "Bearer "+f.jwtFor(t, f.acctB), map[string]any{"install_id": uuid.NewString(), "token": "ExpoPushToken[settlement_then_unlink]", "locale": "en"})
	if got.status != 200 {
		t.Fatal(got.status, string(got.body))
	}
	id := uuid.NewString()
	for i := 0; i < 2; i++ {
		if _, err := f.svc.Settle(t.Context(), a, SettleInput{ID: id, ExpectedRev: rev}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.Close(t.Context(), a); err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		_ = json.NewDecoder(r.Body).Decode(&p)
		kind := p["data"].(map[string]any)["kind"].(string)
		if p["data"].(map[string]any)["notification_id"] == nil {
			t.Error("missing durable tray notification cursor")
		}
		kinds[kind]++
		_, _ = fmt.Fprintf(w, `{"data":{"status":"ok","id":%q}}`, kind)
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	for i := 0; i < 3; i++ {
		more, err := f.svc.deliverPush(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if !more {
			break
		}
	}
	if kinds["settled"] != 1 || kinds["unlinked"] != 1 || len(kinds) != 2 {
		t.Fatal(kinds)
	}
}

func TestClosedTabStillPushesFinancialResultsAndUnlink(t *testing.T) {
	f := newHTTPFixture(t)
	made, err := f.svc.Create(t.Context(), CreateInput{Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA})
	if err != nil {
		t.Fatal(err)
	}
	gotA := f.do(t, "POST", "/v1/tabs/"+made.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, f.acctA), map[string]any{"install_id": uuid.NewString(), "token": "ExpoPushToken[accept_before_unlink]", "locale": "en"})
	if gotA.status != 200 {
		t.Fatal(gotA.status, string(gotA.body))
	}
	if _, err = f.svc.Join(t.Context(), f.party(t, made.InviteToken, made.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	pa, _ := f.svc.PartyByAccount(t.Context(), made.Tab.ID, f.acctA)
	pb, _ := f.svc.PartyByAccount(t.Context(), made.Tab.ID, f.acctB)
	for i, account := range []string{f.acctB} {
		got := f.do(t, "POST", "/v1/tabs/"+made.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, account), map[string]any{"install_id": uuid.NewString(), "token": fmt.Sprintf("ExpoPushToken[closed_result_test_%d]", i), "locale": "en"})
		if got.status != 200 {
			t.Fatal(got.status, string(got.body))
		}
	}
	e1 := f.append(t, pa, "a_to_b", "1", time.Now().UnixMilli())
	e2 := f.append(t, pa, "a_to_b", "2", time.Now().UnixMilli())
	e3 := f.append(t, pa, "a_to_b", "3", time.Now().UnixMilli())
	if _, err = f.svc.Close(t.Context(), pa); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Accept(t.Context(), pb, e1.Entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Dispute(t.Context(), pb, e2.Entry.ID, "Wrong amount"); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Void(t.Context(), pa, e3.Entry.ID); err != nil {
		t.Fatal(err)
	}
	gotKinds := map[string]int{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		_ = json.NewDecoder(r.Body).Decode(&p)
		kind := p["data"].(map[string]any)["kind"].(string)
		gotKinds[kind]++
		if p["collapseId"] == nil || p["tag"] != p["collapseId"] {
			t.Error("tab retry presentation not stable")
		}
		_, _ = fmt.Fprintf(w, `{"data":{"status":"ok","id":%q}}`, "receipt-"+kind)
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	for i := 0; i < 12; i++ {
		more, err := f.svc.deliverPush(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if !more {
			break
		}
	}
	for _, kind := range []string{"invitation_accepted", "unlinked", "entry_accepted", "entry_rejected", "entry_voided"} {
		if gotKinds[kind] != 1 {
			t.Errorf("missing/duplicate %s: %v", kind, gotKinds)
		}
	}
	if gotKinds["entry_created"] != 0 {
		t.Fatal("stale proposal request rang after close")
	}
}

func TestConnectionPendingBadgeCountSurvivesPagination(t *testing.T) {
	f := newHTTPFixture(t)
	low, high := f.acctA, f.acctB
	if low > high {
		low, high = high, low
	}
	source := uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO account_friendships(id,account_low_id,account_high_id,requested_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`, source, low, high, f.acctA); err != nil {
		t.Fatal(err)
	}
	seedConnectionNotice(t, f, "friend_requested", source, f.acctB)
	for i := 0; i < 51; i++ {
		seedConnectionNotice(t, f, "friend_accepted", uuid.NewString(), f.acctB)
	}
	page, err := f.svc.listInbox(t.Context(), f.acctB, "en", 0, connectionEventKinds)
	if err != nil || len(page.Items) != 50 || page.Unread != 52 || page.RequestUnread != 1 {
		t.Fatalf("paginated unread %+v %v", page, err)
	}
}
