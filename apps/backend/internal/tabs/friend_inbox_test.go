package tabs

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/auth"
)

func TestFriendAcceptanceInbox(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := t.Context()
	friendships := auth.NewService(f.pool, "", testJWTSecret)
	jwtSender, jwtFriend := f.jwtFor(t, f.acctA), f.jwtFor(t, f.acctB)
	const inboxURL = "/v1/tabs/inbox?locale=en&include_connections=1"
	const readURL = "/v1/tabs/inbox/read?include_connections=1"
	list := func(jwt, query string) InboxPage {
		t.Helper()
		r := f.do(t, "GET", inboxURL+query, "Bearer "+jwt, nil)
		var page InboxPage
		if r.status != 200 || json.Unmarshal(r.body, &page) != nil {
			t.Fatalf("inbox: %d %s", r.status, r.body)
		}
		return page
	}
	mark := func(jwt string, selector map[string]any, want float64) {
		t.Helper()
		r := f.do(t, "POST", readURL, "Bearer "+jwt, selector)
		if r.status != 200 || r.json(t)["marked"] != want {
			t.Fatalf("mark: %d %s, want %g", r.status, r.body, want)
		}
	}

	request, err := friendships.SendFriendRequest(ctx, f.acctA, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	if page := list(jwtSender, ""); len(page.Items) != 0 {
		t.Fatalf("pending friend request created an outcome notice: %+v", page)
	}
	// This happens without either account having any shared tally.
	for range 2 {
		if _, err = friendships.AcceptFriendRequest(ctx, f.acctB, request.ID); err != nil {
			t.Fatal(err)
		}
	}
	page := list(jwtSender, "")
	if len(page.Items) != 1 || page.Unread != 1 {
		t.Fatalf("sender's notice: %+v", page)
	}
	notice := page.Items[0]
	if notice.Kind != "friend_accepted" || notice.ActorAccountID != f.acctB ||
		notice.TabID != "" || notice.Role != "" || notice.EntryID != "" || notice.Rev != 0 ||
		notice.Read || notice.CreatedAtMS <= 0 || page.LatestID != notice.ID ||
		!strings.Contains(notice.Body, "Ahmad\u2069 accepted your friend request") {
		t.Fatalf("sender's notice payload: %+v", notice)
	}
	if page := list(jwtFriend, ""); len(page.Items) != 0 || page.Unread != 0 {
		t.Fatalf("accepting account received its own notice: %+v", page)
	}
	if page := f.inboxPage(t, jwtSender); len(page.Items) != 0 || page.Unread != 0 || page.LatestID != "0" {
		t.Fatalf("legacy inbox included a friend notice: %+v", page)
	}
	if status, marked := f.markRead(t, jwtSender, map[string]any{"through": notice.ID}); status != 200 || marked != 0 {
		t.Fatalf("legacy mark-all: status %d, marked %d", status, marked)
	}
	mark(jwtFriend, map[string]any{"id": notice.ID}, 0)
	mark(jwtFriend, map[string]any{"through": notice.ID}, 0)
	mark(jwtSender, map[string]any{"id": notice.ID}, 1)
	mark(jwtSender, map[string]any{"id": notice.ID}, 0)
	if page := list(f.jwtFor(t, f.acctA), ""); page.Unread != 0 || !page.Items[0].Read {
		t.Fatalf("read did not follow the account: %+v", page)
	}

	// Add a shared-tally notice between friend notices and force a page
	// boundary. The single cursor keeps both streams sorted without overlap.
	created := f.createOverHTTP(t, "Bearer "+jwtSender)
	friendParty := f.party(t, created.InviteToken, created.Tab.ID)
	if _, err = f.svc.Bind(ctx, friendParty, BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	tabPage := f.inboxPage(t, jwtSender)
	if len(tabPage.Items) != 1 || tabPage.Unread != 1 {
		t.Fatalf("shared-tab fixture: %+v", tabPage)
	}
	seedNotices := func(count int) {
		t.Helper()
		if _, err := f.pool.Exec(ctx, `INSERT INTO account_friend_notifications
 (friend_request_id,recipient_account_id,actor_account_id,actor_label)
 SELECT gen_random_uuid(),$1::uuid,$2::uuid,'Ahmad' FROM generate_series(1,$3::int)`, f.acctA, f.acctB, count); err != nil {
			t.Fatal(err)
		}
	}
	seedNotices(50)
	page = list(jwtSender, "")
	if len(page.Items) != 50 || page.Unread != 51 || page.LatestID != page.Items[0].ID || page.NextBefore != page.Items[49].ID {
		t.Fatalf("mixed inbox first page: %+v", page)
	}
	next := list(jwtSender, "&before="+page.NextBefore)
	if len(next.Items) != 2 || next.Items[0].ID != tabPage.Items[0].ID || next.Items[1].ID != notice.ID || next.NextBefore != "" {
		t.Fatalf("mixed inbox next page: %+v", next)
	}
	mark(jwtSender, map[string]any{"tab_id": created.Tab.ID, "through_rev": 9999}, 1)
	if page := list(jwtSender, ""); page.Unread != 50 {
		t.Fatalf("tab read changed friend notices: unread=%d", page.Unread)
	}
	seedNotices(1)
	mark(jwtSender, map[string]any{"through": page.LatestID}, 50)
	if page := list(jwtSender, ""); page.Unread != 1 || page.Items[0].Read {
		t.Fatalf("mark-all touched a newer notice: unread=%d", page.Unread)
	}
}

func TestFriendAcceptanceInboxBody(t *testing.T) {
	for _, c := range []struct {
		locale, named, anonymous string
	}{
		{"en", " accepted your friend request.", "Your friend request was accepted."},
		{"fa", " درخواست دوستی شما را پذیرفت.", "درخواست دوستی شما پذیرفته شد."},
		{"ps", " ستاسو د ملګرتیا غوښتنه ومنله.", "ستاسو د ملګرتیا غوښتنه ومنل شوه."},
	} {
		if body := friendAcceptedBody(c.locale, " A\n\u202eB "); body != "\u2068AB\u2069"+c.named {
			t.Errorf("%s safe actor label = %q", c.locale, body)
		}
		if body := friendAcceptedBody(c.locale, " \n "); body != c.anonymous {
			t.Errorf("%s generic notice = %q", c.locale, body)
		}
	}
}
