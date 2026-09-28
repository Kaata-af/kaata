package tabs

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func (f *httpFixture) inboxPage(t *testing.T, jwt string) InboxPage {
	t.Helper()
	r := f.do(t, "GET", "/v1/tabs/inbox?locale=en", "Bearer "+jwt, nil)
	if r.status != 200 {
		t.Fatalf("inbox: %d %s", r.status, r.body)
	}
	var page InboxPage
	if err := json.Unmarshal(r.body, &page); err != nil {
		t.Fatal(err)
	}
	return page
}

// markRead posts one read body and returns the status and the `marked` count.
func (f *httpFixture) markRead(t *testing.T, jwt string, body any) (int, int) {
	t.Helper()
	r := f.do(t, "POST", "/v1/tabs/inbox/read", "Bearer "+jwt, body)
	if r.status != 200 {
		return r.status, 0
	}
	var out struct {
		OK     bool `json:"ok"`
		Marked int  `json:"marked"`
	}
	if err := json.Unmarshal(r.body, &out); err != nil || !out.OK {
		t.Fatalf("read response: %s", r.body)
	}
	return r.status, out.Marked
}

// Handled means read: the phone knows the tab and the tally or revision it
// dealt with, not the inbox id, so those selectors mark reads too. Reads stay
// per row and per account: an outsider marks nothing, a notice created after
// the mark is a new unread row, and the 2.0.0 {id}/{through} bodies are
// unchanged.
func TestInboxReadByEntryRevAndThroughRev(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	c := f.createOverHTTP(t, "")
	tab := c.Tab.ID
	pa, pb := f.party(t, c.MyToken, tab), f.party(t, c.InviteToken, tab)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	jwtA, jwtB := f.jwtFor(t, f.acctA), f.jwtFor(t, f.acctB)
	now := time.Now().UnixMilli()

	// {tab_id, entry_id}: every notice about that tally.
	e1 := f.append(t, pa, "a_to_b", "10", now)
	if page := f.inboxPage(t, jwtB); page.Unread != 1 {
		t.Fatalf("unread=%d", page.Unread)
	}
	if status, marked := f.markRead(t, jwtB, map[string]any{"tab_id": tab, "entry_id": e1.Entry.ID}); status != 200 || marked != 1 {
		t.Fatalf("entry read: %d marked=%d", status, marked)
	}
	if page := f.inboxPage(t, jwtB); page.Unread != 0 || !page.Items[0].Read {
		t.Fatalf("%+v", page)
	}
	if _, marked := f.markRead(t, jwtB, map[string]any{"tab_id": tab, "entry_id": e1.Entry.ID}); marked != 0 {
		t.Fatalf("second mark counted %d", marked)
	}

	// Reads are per row, not per tally forever: B's own tally is rejected by A
	// AFTER B marked everything about it, and the rejection is a new unread row.
	e2 := f.append(t, pb, "b_to_a", "20", now)
	if _, marked := f.markRead(t, jwtB, map[string]any{"tab_id": tab, "entry_id": e2.Entry.ID}); marked != 0 {
		t.Fatalf("author had a notice about its own tally: %d", marked)
	}
	if r := f.do(t, "POST", "/v1/tabs/"+tab+"/entries/"+e2.Entry.ID+"/dispute", "Bearer "+jwtA, map[string]string{"reason": "wrong amount"}); r.status != 200 {
		t.Fatalf("reject: %d %s", r.status, r.body)
	}
	page := f.inboxPage(t, jwtB)
	if page.Unread != 1 || page.Items[0].Kind != "entry_rejected" || page.Items[0].EntryID != e2.Entry.ID || page.Items[0].Read {
		t.Fatalf("rejection after mark: %+v", page)
	}

	// {tab_id, rev}: exactly that revision.
	if _, marked := f.markRead(t, jwtB, map[string]any{"tab_id": tab, "rev": page.Items[0].Rev + 1000}); marked != 0 {
		t.Fatalf("unknown rev marked %d", marked)
	}
	if status, marked := f.markRead(t, jwtB, map[string]any{"tab_id": tab, "rev": page.Items[0].Rev}); status != 200 || marked != 1 {
		t.Fatalf("rev read: %d marked=%d", status, marked)
	}
	if page := f.inboxPage(t, jwtB); page.Unread != 0 {
		t.Fatalf("unread=%d", page.Unread)
	}

	// {tab_id, through_rev}: everything up to the locally applied revision;
	// later rows stay unread. A numeric string is accepted like the number.
	e3 := f.append(t, pa, "a_to_b", "30", now)
	e4 := f.append(t, pa, "a_to_b", "40", now)
	if page := f.inboxPage(t, jwtB); page.Unread != 2 {
		t.Fatalf("unread=%d", page.Unread)
	}
	if status, marked := f.markRead(t, jwtB, map[string]any{"tab_id": tab, "through_rev": fmt.Sprint(e3.Entry.Rev)}); status != 200 || marked != 1 {
		t.Fatalf("through_rev read: %d marked=%d", status, marked)
	}
	page = f.inboxPage(t, jwtB)
	if page.Unread != 1 || page.Items[0].EntryID != e4.Entry.ID || page.Items[0].Read || !page.Items[1].Read {
		t.Fatalf("through_rev: %+v", page)
	}

	// An outsider's tab selectors mark nothing on anyone's rows.
	outsider := f.jwtFor(t, seedAccount(t, f.pool, "outsider-reads@example.com", "Outsider"))
	for _, body := range []map[string]any{
		{"tab_id": tab, "entry_id": e4.Entry.ID},
		{"tab_id": tab, "rev": e4.Entry.Rev},
		{"tab_id": tab, "through_rev": e4.Entry.Rev},
	} {
		if status, marked := f.markRead(t, outsider, body); status != 200 || marked != 0 {
			t.Fatalf("outsider %v: %d marked=%d", body, status, marked)
		}
	}
	if page := f.inboxPage(t, jwtB); page.Unread != 1 {
		t.Fatal("outsider marked the recipient's row")
	}

	// Zero or several selectors, non-uuid ids and non-positive revisions are 400.
	for _, body := range []any{
		map[string]any{},
		map[string]any{"id": "1", "through": "1"},
		map[string]any{"tab_id": tab},
		map[string]any{"entry_id": e4.Entry.ID},
		map[string]any{"rev": e4.Entry.Rev},
		map[string]any{"tab_id": tab, "entry_id": e4.Entry.ID, "rev": e4.Entry.Rev},
		map[string]any{"tab_id": tab, "rev": e4.Entry.Rev, "through_rev": e4.Entry.Rev},
		map[string]any{"id": "1", "tab_id": tab, "entry_id": e4.Entry.ID},
		map[string]any{"id": "1", "tab_id": tab},
		map[string]any{"tab_id": "not-a-uuid", "entry_id": e4.Entry.ID},
		map[string]any{"tab_id": tab, "entry_id": "not-a-uuid"},
		map[string]any{"tab_id": tab, "rev": 0},
		map[string]any{"tab_id": tab, "rev": -1},
		map[string]any{"tab_id": tab, "through_rev": 1.5},
		map[string]any{"tab_id": tab, "through_rev": "abc"},
		map[string]any{"id": "0"},
		map[string]any{"through": "x"},
		"not json",
	} {
		if r := f.do(t, "POST", "/v1/tabs/inbox/read", "Bearer "+jwtB, body); r.status != 400 {
			t.Fatalf("body %v: %d %s", body, r.status, r.body)
		}
	}
	if page := f.inboxPage(t, jwtB); page.Unread != 1 {
		t.Fatal("an invalid body marked something")
	}

	// The 2.0.0 client's {id} body is unchanged (and now reports marked).
	if status, marked := f.markRead(t, jwtB, map[string]string{"id": page.Items[0].ID}); status != 200 || marked != 1 {
		t.Fatalf("id read: %d marked=%d", status, marked)
	}
	if page := f.inboxPage(t, jwtB); page.Unread != 0 {
		t.Fatalf("unread=%d", page.Unread)
	}
	if r := f.do(t, "POST", "/v1/tabs/inbox/read", "", map[string]any{"tab_id": tab, "rev": 1}); r.status != 401 {
		t.Fatalf("anonymous read: %d", r.status)
	}
}

// A review is the strongest "I saw this": accepting, rejecting or cancelling
// a tally reads the ACTING account's own notices about it inside the
// decision's transaction, on every path (HTTP here; the OS action buttons and
// a second phone reach the same code). The counterparty's outcome notice is a
// fresh unread row, and a kaata member's review reads the member's rows, not
// the bound owner's.
func TestReviewMarksOwnNoticeRead(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	c := f.createOverHTTP(t, "")
	tab := c.Tab.ID
	pa, pb := f.party(t, c.MyToken, tab), f.party(t, c.InviteToken, tab)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	jwtA, jwtB := f.jwtFor(t, f.acctA), f.jwtFor(t, f.acctB)
	now := time.Now().UnixMilli()

	e1 := f.append(t, pa, "a_to_b", "10", now)
	if page := f.inboxPage(t, jwtB); page.Unread != 1 {
		t.Fatalf("unread=%d", page.Unread)
	}
	if r := f.do(t, "POST", "/v1/tabs/"+tab+"/entries/"+e1.Entry.ID+"/accept", "Bearer "+jwtB, nil); r.status != 200 {
		t.Fatalf("accept: %d %s", r.status, r.body)
	}
	// Another phone on the same account: read without any read call.
	if page := f.inboxPage(t, f.jwtFor(t, f.acctB)); page.Unread != 0 || len(page.Items) != 1 || !page.Items[0].Read {
		t.Fatalf("accept did not read own notice: %+v", page)
	}
	// A never read anything (its rows include the bind's `updated` notice).
	if page := f.inboxPage(t, jwtA); page.Items[0].Kind != "entry_accepted" || page.Items[0].Read || page.Unread != len(page.Items) {
		t.Fatalf("author's outcome notice: %+v", page)
	}

	// Reject by a kaata member of party B's vault.
	e2 := f.append(t, pa, "a_to_b", "20", now)
	member := seedAccount(t, f.pool, "editor-reads@example.com", "Editor")
	seedMember(t, f.pool, f.vaultB, member, "editor")
	jwtM := f.jwtFor(t, member)
	if page := f.inboxPage(t, jwtM); page.Unread != 2 {
		t.Fatalf("member unread=%d", page.Unread)
	}
	if r := f.do(t, "POST", "/v1/tabs/"+tab+"/entries/"+e2.Entry.ID+"/dispute", "Bearer "+jwtM, map[string]string{"reason": "no"}); r.status != 200 {
		t.Fatalf("member reject: %d %s", r.status, r.body)
	}
	if page := f.inboxPage(t, jwtM); page.Unread != 1 || page.Items[0].EntryID != e2.Entry.ID || !page.Items[0].Read || page.Items[1].Read {
		t.Fatalf("member reject did not read the member's notice: %+v", page)
	}
	if page := f.inboxPage(t, jwtB); page.Unread != 1 || page.Items[0].EntryID != e2.Entry.ID || page.Items[0].Read {
		t.Fatalf("member's review read the owner's notice: %+v", page)
	}

	// Cancel: the author has no notice about its own pending tally, so the
	// void path marks nothing and must not fail; the counterparty gets the
	// outcome as a new unread row, and its earlier creation row stays as is.
	e3 := f.append(t, pb, "b_to_a", "30", now)
	if r := f.do(t, "POST", "/v1/tabs/"+tab+"/entries/"+e3.Entry.ID+"/void", "Bearer "+jwtB, nil); r.status != 201 {
		t.Fatalf("void: %d %s", r.status, r.body)
	}
	page := f.inboxPage(t, jwtA)
	if page.Unread != len(page.Items) || page.Items[0].Kind != "entry_voided" || page.Items[0].EntryID != e3.Entry.ID || page.Items[1].Kind != "entry_created" || page.Items[1].Read {
		t.Fatalf("void outcome: %+v", page)
	}
	if page := f.inboxPage(t, jwtB); page.Unread != 1 {
		t.Fatalf("void changed the author's inbox: %+v", page)
	}
}
