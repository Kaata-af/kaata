package tabs

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func publishRequestRecipient(t *testing.T, f *tabFixture) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET discovery_enabled=TRUE WHERE id=$1::uuid`, f.acctB); err != nil {
		t.Fatal(err)
	}
}

func TestPeopleRequestUsesExplicitRecipientJoin(t *testing.T) {
	f := newTabFixture(t)
	publishRequestRecipient(t, f)
	in := groupInput(t, f, "notify")
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctA); !errors.Is(err, ErrNotFound) {
		t.Fatalf("self request: %v", err)
	}
	if _, err := f.svc.SendPeopleRequest(t.Context(), f.acctB, created.Group.ID, f.acctA); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider send: %v", err)
	}
	request, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB)
	if err != nil || again.ID != request.ID {
		t.Fatalf("send retry %+v %v", again, err)
	}
	list, err := f.svc.ListPeopleRequests(t.Context(), f.acctB)
	if err != nil || len(list) != 1 || list[0].Token != request.Token {
		t.Fatalf("inbox %+v %v", list, err)
	}
	mine, err := f.svc.Mine(t.Context(), f.acctB)
	if err != nil || len(mine.Groups) != 0 || len(mine.Tabs) != 0 {
		t.Fatalf("request bound recipient: %+v %v", mine, err)
	}
	preview, err := f.svc.PreviewGroup(t.Context(), request.Token, f.acctB)
	if err != nil || len(preview.Tabs) != 0 {
		t.Fatalf("preview %+v %v", preview, err)
	}
	raw, _ := json.Marshal(preview)
	if strings.Contains(string(raw), `"amount"`) || strings.Contains(string(raw), `"balance"`) {
		t.Fatalf("preview leaked financial data %s", raw)
	}
	outsider := seedAccount(t, f.pool, "outsider@example.test", "Outsider")
	for _, token := range []string{request.Token, in.InviteToken} {
		if _, err := f.svc.PreviewGroup(t.Context(), token, outsider); !errors.Is(err, ErrNotFound) {
			t.Fatalf("outsider preview with %s: %v", token, err)
		}
		join := joinGroupInput(f, in)
		join.Token = token
		join.AccountID = outsider
		if _, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join); !errors.Is(err, ErrNotFound) {
			t.Fatalf("outsider join %v", err)
		}
	}
	// Hiding the recipient's profile stops future requests, not this invitation.
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET discovery_enabled=FALSE WHERE id=$1::uuid`, f.acctB); err != nil {
		t.Fatal(err)
	}
	join := joinGroupInput(f, in)
	join.Token = request.Token
	joined, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
	if err != nil || joined.Group.Parties["b"].JoinedAtMS == nil {
		t.Fatalf("join %+v %v", joined, err)
	}
	if _, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join); err != nil {
		t.Fatalf("join retry %v", err)
	}
	list, err = f.svc.ListPeopleRequests(t.Context(), f.acctB)
	if err != nil || len(list) != 0 {
		t.Fatalf("accepted request still shown %+v %v", list, err)
	}
}

func TestPeopleRequestDeclineExpiryAndPublication(t *testing.T) {
	f := newTabFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET discovery_enabled=FALSE WHERE id=$1::uuid`, f.acctB); err != nil {
		t.Fatal(err)
	}
	in := groupInput(t, f, "notify")
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private recipient: %v", err)
	}
	publishRequestRecipient(t, f)
	request, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeclinePeopleRequest(t.Context(), f.acctA, request.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("sender declined recipient request: %v", err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.acctA); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{request.Token, in.InviteToken} {
		if _, err := f.svc.PreviewGroup(t.Context(), token, f.acctB); !errors.Is(err, ErrNotFound) {
			t.Fatalf("deleting sender preview: %v", err)
		}
	}
	if list, err := f.svc.ListPeopleRequests(t.Context(), f.acctB); err != nil || len(list) != 0 {
		t.Fatalf("deleting sender listed %+v %v", list, err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NULL WHERE id=$1::uuid`, f.acctA); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE people_requests SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1::uuid`, request.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.PreviewGroup(t.Context(), request.Token, f.acctB); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired preview: %v", err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE people_requests SET expires_at=NOW()+INTERVAL '1 day' WHERE id=$1::uuid`, request.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeclinePeopleRequest(t.Context(), f.acctB, request.ID); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{request.Token, in.InviteToken} {
		if _, err := f.svc.PreviewGroup(t.Context(), token, f.acctB); !errors.Is(err, ErrNotFound) {
			t.Fatalf("declined preview: %v", err)
		}
	}
	list, err := f.svc.ListPeopleRequests(t.Context(), f.acctB)
	if err != nil || len(list) != 0 {
		t.Fatalf("declined list %+v %v", list, err)
	}
	// Creating another financial group does not bypass a recipient's cooldown.
	next := in
	next.RequestID = uuid.NewString()
	next.RelationshipID = uuid.NewString()
	next.InviteToken, err = newPartyToken()
	if err != nil {
		t.Fatal(err)
	}
	next.Currencies = []GroupCurrencyInput{{Currency: "AFN"}}
	created, err = f.svc.CreateGroup(t.Context(), next)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB); !errors.Is(err, ErrPeopleRequestLimited) {
		t.Fatalf("cooldown: %v", err)
	}
}

func TestPeopleRequestInboxCapacity(t *testing.T) {
	f := newTabFixture(t)
	publishRequestRecipient(t, f)
	in := groupInput(t, f, "notify")
	in.Currencies = []GroupCurrencyInput{{Currency: "AFN"}}
	for i := 0; i < 51; i++ {
		in.RequestID, in.RelationshipID = uuid.NewString(), uuid.NewString()
		var err error
		in.InviteToken, err = newPartyToken()
		if err != nil {
			t.Fatal(err)
		}
		group, err := f.svc.CreateGroup(t.Context(), in)
		if err != nil {
			t.Fatal(err)
		}
		request, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, group.Group.ID, f.acctB)
		if i == 50 {
			if !errors.Is(err, ErrPeopleRequestInboxFull) {
				t.Fatalf("capacity: %v", err)
			}
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(t.Context(), `UPDATE people_requests SET created_at=NOW()-INTERVAL '2 days' WHERE id=$1::uuid`, request.ID); err != nil {
			t.Fatal(err)
		}
	}
	items, err := f.svc.ListPeopleRequests(t.Context(), f.acctB)
	if err != nil || len(items) != 50 {
		t.Fatalf("all pending requests remain visible: %d %v", len(items), err)
	}
}
