package tabs

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestActualWriterReviewerAndNoSelfNotification(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	c := f.createOverHTTP(t, "")
	pa := f.party(t, c.MyToken, c.Tab.ID)
	if _, err := f.svc.Bind(ctx, pa, BindInput{AccountID: f.acctA, VaultID: &f.vaultA}); err != nil {
		t.Fatal(err)
	}
	pb := f.party(t, c.InviteToken, c.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	writer := seedAccount(t, f.pool, "writer@example.com", "Writer Name")
	reviewer := seedAccount(t, f.pool, "reviewer@example.com", "Reviewer Name")
	seedMember(t, f.pool, f.vaultA, writer, "editor")
	seedMember(t, f.pool, f.vaultB, writer, "editor") // same user can access both sides
	seedMember(t, f.pool, f.vaultB, reviewer, "editor")
	if _, err := f.pool.Exec(ctx, "DELETE FROM tab_notifications"); err != nil {
		t.Fatal(err)
	} // isolate tally events from initial linking notices
	for _, acct := range []string{writer, reviewer} {
		if _, err := f.pool.Exec(ctx, `INSERT INTO tab_push_subscriptions(tab_id,role,install_id,token,account_id)
   VALUES($1::uuid,'b',$2::uuid,$3,$4::uuid)`, c.Tab.ID, uuid.NewString(), "ExpoPushToken["+acct+"]", acct); err != nil {
			t.Fatal(err)
		}
	}
	id := uuid.NewString()
	r := f.do(t, "POST", "/v1/tabs/"+c.Tab.ID+"/entries", "Bearer "+f.jwtFor(t, writer), map[string]any{
		"id": id, "direction": "a_to_b", "amount": "500.25", "occurred_at_ms": time.Now().UnixMilli(),
		"author_name": "Forged Shop", "author_account_id": f.acctA,
	}, "a")
	if r.status != 200 && r.status != 201 {
		t.Fatalf("append: %d %s", r.status, r.body)
	}
	var added AppendResult
	if err := json.Unmarshal(r.body, &added); err != nil {
		t.Fatal(err)
	}
	if added.Entry.AuthorName != "Writer Name" || added.Entry.AuthorAccountID == nil || *added.Entry.AuthorAccountID != writer {
		t.Fatalf("wrong author: %+v", added.Entry)
	}
	if added.Tab.Parties["a"].AccountName != "Matee" || added.Tab.Parties["b"].AccountName != "Ahmad" {
		t.Fatalf("account names mixed with store labels: %+v", added.Tab.Parties)
	}
	var jobs int
	if err := f.pool.QueryRow(ctx, "SELECT count(*) FROM tab_push_outbox").Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 {
		t.Fatalf("self notified through opposite membership: %d jobs", jobs)
	}
	own, err := f.svc.listInbox(ctx, writer, "en", 0)
	if err != nil || len(own.Items) != 0 || own.Unread != 0 {
		t.Fatalf("own inbox: %+v %v", own, err)
	}
	peer, err := f.svc.listInbox(ctx, reviewer, "en", 0)
	if err != nil || len(peer.Items) != 1 || !strings.Contains(peer.Items[0].Body, "Writer Name") {
		t.Fatalf("peer inbox: %+v %v", peer, err)
	}
	r = f.do(t, "POST", "/v1/tabs/"+c.Tab.ID+"/entries/"+id+"/accept", "Bearer "+f.jwtFor(t, reviewer), map[string]any{}, "b")
	if r.status != 200 {
		t.Fatalf("accept: %d %s", r.status, r.body)
	}
	authorInbox, err := f.svc.listInbox(ctx, writer, "en", 0)
	if err != nil || len(authorInbox.Items) != 1 || !strings.Contains(authorInbox.Items[0].Body, "Reviewer Name") {
		t.Fatalf("review actor: %+v %v", authorInbox, err)
	}
	// Review does not replace the immutable author snapshot.
	var name string
	if err = f.pool.QueryRow(ctx, "SELECT author_name FROM tab_entries WHERE id=$1::uuid", id).Scan(&name); err != nil || name != "Writer Name" {
		t.Fatalf("author changed: %s %v", name, err)
	}
}

func TestPushTokenMovesToCurrentInstallation(t *testing.T) {
	f := newHTTPFixture(t)
	f.svc.push = &pushClient{} // enable registration only; never contact Expo
	c := f.createOverHTTP(t, "")
	if _, err := f.svc.Bind(context.Background(), f.party(t, c.InviteToken, c.Tab.ID), BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	path := "/v1/tabs/" + c.Tab.ID + "/notifications"
	token := "ExpoPushToken[one_physical_phone_123456]"
	register := func(jwt string) {
		t.Helper()
		r := f.do(t, "POST", path, "Bearer "+jwt, map[string]any{"install_id": uuid.NewString(), "token": token, "locale": "en"})
		if r.status != 200 {
			t.Fatalf("register: %s", r.body)
		}
	}
	register(f.jwtFor(t, f.acctB))
	pa := f.party(t, c.MyToken, c.Tab.ID)
	f.append(t, pa, "a_to_b", "10", time.Now().UnixMilli())
	register(f.jwtFor(t, f.acctB)) // reinstall, same token, new authenticated install
	var subs, jobs int
	if err := f.pool.QueryRow(context.Background(), "SELECT count(*) FROM tab_push_subscriptions").Scan(&subs); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(context.Background(), "SELECT count(*) FROM tab_push_outbox").Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if subs != 1 || jobs != 0 {
		t.Fatalf("old installation retained: subs=%d jobs=%d", subs, jobs)
	}
	jwtA := f.jwtFor(t, f.acctA)
	register(jwtA) // same physical phone now signs into the other account
	register(jwtA) // idempotent refresh
	var account string
	if err := f.pool.QueryRow(context.Background(), "SELECT account_id::text FROM tab_push_subscriptions").Scan(&account); err != nil || account != f.acctA {
		t.Fatalf("stale account: %s %v", account, err)
	}
}
