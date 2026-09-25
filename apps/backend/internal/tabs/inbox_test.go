package tabs

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestNotificationDetails(t *testing.T) {
	for _, locale := range []string{"en", "fa"} {
		for _, kind := range []string{"entry_created", "entry_accepted", "entry_rejected", "entry_voided"} {
			for _, currency := range []string{"AFN", "USD", "AED"} {
				body := detailedPushBody(kind, locale, "احمد", 50025, "a_to_b", currency, "b")
				if !strings.Contains(body, "احمد") || !strings.Contains(body, "\u2066−500.25 "+currency+"\u2069") {
					t.Fatal(body)
				}
				opposite := detailedPushBody(kind, locale, "Matee", 50025, "a_to_b", currency, "a")
				if !strings.Contains(opposite, "+500.25") {
					t.Fatal(opposite)
				}
			}
		}
	}
	if got := notificationLabel("X\n\u202eY"); got != "XY" {
		t.Fatal(got)
	}
}

func TestInboxHistoryAccessAndReads(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	c := f.createOverHTTP(t, "")
	pa := f.party(t, c.MyToken, c.Tab.ID)
	pb := f.party(t, c.InviteToken, c.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SetLabel(ctx, pb, "Ahmad"); err != nil {
		t.Fatal(err)
	}
	jwtA, jwtB := f.jwtFor(t, f.acctA), f.jwtFor(t, f.acctB)
	added := f.append(t, pa, "a_to_b", "500.25", time.Now().UnixMilli())
	readPage := func(jwt, query string) InboxPage {
		t.Helper()
		r := f.do(t, "GET", "/v1/tabs/inbox?locale=en"+query, "Bearer "+jwt, nil)
		if r.status != 200 {
			t.Fatalf("inbox: %d %s", r.status, r.body)
		}
		var page InboxPage
		if err := json.Unmarshal(r.body, &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	b := readPage(jwtB, "")
	if len(b.Items) != 1 || b.Unread != 1 || b.Items[0].EntryID != added.Entry.ID || !strings.Contains(b.Items[0].Body, "−500.25 AFN") {
		t.Fatalf("%+v", b)
	}
	// Push is disabled and no device is subscribed: history still exists.
	var jobs int
	_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_push_outbox").Scan(&jobs)
	if jobs != 0 {
		t.Fatal("unexpected push job")
	}
	// Same-party append retry must not duplicate the notification.
	if _, err := f.svc.Append(ctx, pa, AppendInput{ID: added.Entry.ID, Direction: "a_to_b", Amount: "500.25", OccurredAtMS: time.Now().UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if got := readPage(jwtB, ""); len(got.Items) != 1 {
		t.Fatal("duplicate append notification")
	}
	// Reads belong to accounts, not installations.
	mark := f.do(t, "POST", "/v1/tabs/inbox/read", "Bearer "+jwtB, map[string]string{"id": b.Items[0].ID})
	if mark.status != 200 {
		t.Fatal(string(mark.body))
	}
	if got := readPage(f.jwtFor(t, f.acctB), ""); got.Unread != 0 || !got.Items[0].Read {
		t.Fatal("read lost across phones")
	}
	// An outsider sees nothing and cannot mark B's future records as read.
	outsider := seedAccount(t, f.pool, "outsider-inbox@example.com", "Outsider")
	jwtOther := f.jwtFor(t, outsider)
	if got := readPage(jwtOther, ""); len(got.Items) != 0 || got.Unread != 0 {
		t.Fatal("cross-account leak")
	}
	f.append(t, pa, "a_to_b", "1", time.Now().UnixMilli())
	b = readPage(jwtB, "")
	_ = f.do(t, "POST", "/v1/tabs/inbox/read", "Bearer "+jwtOther, map[string]string{"id": b.Items[0].ID})
	if got := readPage(jwtB, ""); got.Unread != 1 {
		t.Fatal("outsider marked recipient read")
	}
	// Outcome history is separate from creation and survives further changes.
	r := f.do(t, "POST", "/v1/tabs/"+c.Tab.ID+"/entries/"+added.Entry.ID+"/dispute", "Bearer "+jwtB, map[string]string{"reason": ""})
	if r.status != 200 {
		t.Fatalf("reject: %s", r.body)
	}
	a := readPage(jwtA, "")
	found := false
	for _, n := range a.Items {
		if n.Kind == "entry_rejected" {
			found = true
			if !strings.Contains(n.Body, "Ahmad") || !strings.Contains(n.Body, "+500.25 AFN") {
				t.Fatal(n.Body)
			}
		}
	}
	if !found {
		t.Fatal("missing rejection")
	}
	// Read-only vault members may see notices, but revoked members immediately lose access.
	member := seedAccount(t, f.pool, "inbox-member@example.com", "Viewer")
	seedMember(t, f.pool, f.vaultB, member, "viewer")
	jwtMember := f.jwtFor(t, member)
	if got := readPage(jwtMember, ""); len(got.Items) != 2 || got.Unread != 2 {
		t.Fatalf("member inbox: %+v", got)
	}
	if _, err := f.pool.Exec(ctx, "UPDATE vault_members SET revoked_at=NOW() WHERE account_id=$1::uuid", member); err != nil {
		t.Fatal(err)
	}
	if got := readPage(jwtMember, ""); len(got.Items) != 0 {
		t.Fatal("revoked member retained server access")
	}
	// Pagination is stable and mark-all stops at the displayed high-water id.
	for i := 0; i < 51; i++ {
		f.append(t, pa, "b_to_a", fmt.Sprint(i+1), time.Now().UnixMilli())
	}
	first := readPage(jwtB, "")
	second := readPage(jwtB, "&before="+first.NextBefore)
	if len(first.Items) != 50 || len(second.Items) != 3 || second.NextBefore != "" {
		t.Fatalf("pages %d/%d", len(first.Items), len(second.Items))
	}
	seen := map[string]bool{}
	for _, n := range first.Items {
		seen[n.ID] = true
	}
	for _, n := range second.Items {
		if seen[n.ID] {
			t.Fatal("overlapping pages")
		}
	}
	f.append(t, pa, "a_to_b", "2", time.Now().UnixMilli())
	mark = f.do(t, "POST", "/v1/tabs/inbox/read", "Bearer "+jwtB, map[string]string{"through": first.LatestID})
	if mark.status != 200 {
		t.Fatal(string(mark.body))
	}
	if got := readPage(jwtB, ""); got.Unread != 1 {
		t.Fatalf("mark all swallowed later arrival: %d", got.Unread)
	}
	if r := f.do(t, "GET", "/v1/tabs/inbox", "", nil); r.status != 401 {
		t.Fatal("anonymous inbox")
	}
	if r := f.do(t, "GET", "/v1/tabs/inbox?before=oops", "Bearer "+jwtB, nil); r.status != 400 {
		t.Fatal("bad cursor")
	}
}
