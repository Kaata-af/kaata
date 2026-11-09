package tabs

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func publishRequestRecipient(t *testing.T, f *tabFixture) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET discovery_enabled=TRUE WHERE id=$1::uuid`, f.acctB); err != nil {
		t.Fatal(err)
	}
}

func TestPeopleRequestHiddenRecipientRequiresActiveFriendship(t *testing.T) {
	f := newTabFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET discovery_enabled=FALSE WHERE id=$1::uuid`, f.acctB); err != nil {
		t.Fatal(err)
	}
	created, err := f.svc.CreateGroup(t.Context(), groupInput(t, f, "notify"))
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"pending", "declined", "cancelled", "removed", "accepted"} {
		if _, err := f.pool.Exec(t.Context(), `INSERT INTO account_friendships(account_low_id,account_high_id,requested_by,status,accepted_at)
 VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid),$1::uuid,$3,CASE WHEN $3='accepted' THEN NOW() END)
 ON CONFLICT(account_low_id,account_high_id) DO UPDATE SET status=EXCLUDED.status,accepted_at=EXCLUDED.accepted_at`, f.acctA, f.acctB, status); err != nil {
			t.Fatal(err)
		}
		request, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB)
		if status != "accepted" {
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("%s friendship allowed invitation: %v", status, err)
			}
			continue
		}
		if err != nil || request.ID == "" {
			t.Fatalf("accepted friend cannot receive request: %+v %v", request, err)
		}
	}
	mine, err := f.svc.Mine(t.Context(), f.acctB)
	if err != nil || len(mine.Groups) != 0 || len(mine.Tabs) != 0 {
		t.Fatalf("friendship or invitation granted financial access: %+v %v", mine, err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.acctB); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleting friend was eligible: %v", err)
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
		join := joinGroupInput(f, in)
		join.Token = token
		if _, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join); !errors.Is(err, ErrNotFound) {
			t.Fatalf("stale join after decline: %v", err)
		}
	}
	list, err := f.svc.ListPeopleRequests(t.Context(), f.acctB)
	if err != nil || len(list) != 0 {
		t.Fatalf("declined list %+v %v", list, err)
	}
	var declinedAt time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT declined_at FROM people_requests WHERE id=$1::uuid`, request.ID).Scan(&declinedAt); err != nil {
		t.Fatal(err)
	}
	declinedAtMS := declinedAt.UnixMilli()
	if err := f.svc.DeclinePeopleRequest(t.Context(), f.acctB, request.ID); err != nil {
		t.Fatalf("repeated decline: %v", err)
	}
	sender, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "a")
	if err != nil || len(sender.Tabs) != len(created.Tabs) {
		t.Fatalf("sender group after decline: %+v %v", sender, err)
	}
	mine, err := f.svc.Mine(t.Context(), f.acctA)
	if err != nil || len(mine.Tabs) != len(created.Tabs) {
		t.Fatalf("sender discovery after decline: %+v %v", mine, err)
	}
	for _, item := range mine.Tabs {
		if item.Tab.InvitationDeclinedAtMS == nil || *item.Tab.InvitationDeclinedAtMS != declinedAtMS {
			t.Fatalf("sender discovery omitted decline: %+v", item)
		}
	}
	for i, item := range sender.Tabs {
		before := created.Tabs[i].Tab
		if item.Tab.InvitationDeclinedAtMS == nil || *item.Tab.InvitationDeclinedAtMS != declinedAtMS ||
			item.Tab.ClosedAtMS != nil || !item.Tab.UnjoinedInvitation || item.Tab.Rev != before.Rev {
			t.Fatalf("decline changed financial state or was omitted: before=%+v after=%+v", before, item.Tab)
		}
		p, err := partyByAccountRoleQuery(t.Context(), f.pool, before.ID, f.acctA, "a")
		if err != nil {
			t.Fatal(err)
		}
		pull, err := f.svc.Get(t.Context(), p, before.Rev)
		if err != nil || len(pull.Entries) != 0 || pull.Tab.InvitationDeclinedAtMS == nil || *pull.Tab.InvitationDeclinedAtMS != declinedAtMS {
			t.Fatalf("delta pull at an unchanged revision omitted decline: %+v %v", pull, err)
		}
	}
	if mine, err := f.svc.Mine(t.Context(), f.acctB); err != nil || len(mine.Tabs) != 0 {
		t.Fatalf("decline granted recipient financial access: %+v %v", mine, err)
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
	if _, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB); !errors.Is(err, ErrPeopleRequestCooldown) {
		t.Fatalf("cooldown: %v", err)
	}
}

func TestPeopleRequestFreshInviteAfterPreviousEnds(t *testing.T) {
	for _, outcome := range []string{"joined", "cancelled", "expired", "declined"} {
		t.Run(outcome, func(t *testing.T) {
			ctx := t.Context()
			f := newTabFixture(t)
			publishRequestRecipient(t, f)
			in := groupInput(t, f, "notify")
			in.RelationshipID = uuid.NewString()
			in.Currencies = []GroupCurrencyInput{{Currency: "AFN"}}
			original, err := f.svc.CreateGroup(ctx, in)
			if err != nil {
				t.Fatal(err)
			}
			request, err := f.svc.SendPeopleRequest(ctx, f.acctA, original.Group.ID, f.acctB)
			if err != nil {
				t.Fatal(err)
			}
			switch outcome {
			case "joined":
				join := joinGroupInput(f, in)
				join.Token = request.Token
				join.Currencies = []GroupCurrencyInput{{Currency: "AFN"}}
				if _, err := f.svc.JoinGroup(ctx, original.Group.ID, join); err != nil {
					t.Fatal(err)
				}
			case "expired":
				if _, err := f.pool.Exec(ctx, `UPDATE people_requests SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1::uuid`, request.ID); err != nil {
					t.Fatal(err)
				}
				fallthrough
			case "declined":
				if err := f.svc.DeclinePeopleRequest(ctx, f.acctB, request.ID); err != nil {
					t.Fatal(err)
				}
				if _, err := f.svc.SendPeopleRequest(ctx, f.acctA, original.Group.ID, f.acctB); !errors.Is(err, ErrPeopleRequestEnded) {
					t.Fatalf("retry on ended group: %v", err)
				}
			}
			closed, err := f.svc.CloseGroup(ctx, original.Group.ID, f.acctA, "a", true)
			if err != nil {
				t.Fatal(err)
			}
			if outcome == "cancelled" {
				// A late tap on the old invitation must not block a new one.
				if err := f.svc.DeclinePeopleRequest(ctx, f.acctB, request.ID); err != nil {
					t.Fatal(err)
				}
				var recorded bool
				if err := f.pool.QueryRow(ctx, `SELECT declined_at IS NOT NULL FROM people_requests WHERE id=$1::uuid`, request.ID).Scan(&recorded); err != nil || recorded {
					t.Fatalf("late decline on closed request: %t, %v", recorded, err)
				}
				// Earlier clients could already have recorded this stale tap.
				if _, err := f.pool.Exec(ctx, `UPDATE people_requests r SET declined_at=g.closed_at+INTERVAL '1 microsecond'
 FROM tab_groups g WHERE g.id=r.group_id AND r.id=$1::uuid`, request.ID); err != nil {
					t.Fatal(err)
				}
			}
			in.RequestID = uuid.NewString()
			in.InviteToken, err = newPartyToken()
			if err != nil {
				t.Fatal(err)
			}
			prior := closed.Tabs[0].Tab
			in.Currencies = []GroupCurrencyInput{{
				Currency:                 "AFN",
				ExpectedPreviousTabID:    &prior.ID,
				ExpectedPreviousRev:      &prior.Rev,
				ExpectedHistoryRevisions: map[string]int64{prior.ID: prior.Rev},
			}}
			next, err := f.svc.CreateGroup(ctx, in)
			if err != nil {
				t.Fatal(err)
			}
			if outcome == "declined" {
				if _, err := f.svc.SendPeopleRequest(ctx, f.acctA, next.Group.ID, f.acctB); !errors.Is(err, ErrPeopleRequestCooldown) {
					t.Fatalf("closing a declined invitation bypassed the cooldown: %v", err)
				}
				if _, err := f.pool.Exec(ctx, `UPDATE people_requests SET declined_at=NOW()-INTERVAL '6 minutes' WHERE id=$1::uuid`, request.ID); err != nil {
					t.Fatal(err)
				}
				if err := f.svc.DeclinePeopleRequest(ctx, f.acctB, request.ID); err != nil {
					t.Fatal(err)
				}
			}
			fresh, err := f.svc.SendPeopleRequest(ctx, f.acctA, next.Group.ID, f.acctB)
			if err != nil || fresh.ID == request.ID || fresh.Token == request.Token {
				t.Fatalf("fresh invitation: %+v %v", fresh, err)
			}
			inbox, err := f.svc.ListPeopleRequests(ctx, f.acctB)
			if err != nil || len(inbox) != 1 || inbox[0].ID != fresh.ID {
				t.Fatalf("recipient inbox after re-inviting: %+v %v", inbox, err)
			}
		})
	}
}

func TestPeopleRequestDoesNotDuplicatePendingInvitesWithinKaata(t *testing.T) {
	f := newTabFixture(t)
	publishRequestRecipient(t, f)
	in := groupInput(t, f, "notify")
	in.Currencies = []GroupCurrencyInput{{Currency: "AFN"}}
	create := func(vaultID string) string {
		t.Helper()
		in.VaultID, in.RequestID, in.RelationshipID = vaultID, uuid.NewString(), uuid.NewString()
		var err error
		in.InviteToken, err = newPartyToken()
		if err != nil {
			t.Fatal(err)
		}
		group, err := f.svc.CreateGroup(t.Context(), in)
		if err != nil {
			t.Fatal(err)
		}
		return group.Group.ID
	}
	first, second := create(f.vaultA), create(f.vaultA)
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, group := range []string{first, second} {
		go func() {
			<-start
			_, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, group, f.acctB)
			results <- err
		}()
	}
	close(start)
	winner, loser := <-results, <-results
	if winner != nil {
		winner, loser = loser, winner
	}
	if winner != nil || !errors.Is(loser, ErrPeopleRequestPending) {
		t.Fatalf("pending collision: %v, %v", winner, loser)
	}
	otherVault := seedVault(t, f.pool, f.acctA, "Another book")
	if _, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, create(otherVault), f.acctB); err != nil {
		t.Fatalf("independent Kaata invite: %v", err)
	}
}

func TestPeopleRequestJoinAndDeclineSerialize(t *testing.T) {
	f := newTabFixture(t)
	publishRequestRecipient(t, f)
	in := groupInput(t, f, "notify")
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	request, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	join := joinGroupInput(f, in)
	join.Token = request.Token
	start := make(chan struct{})
	joined, declined := make(chan error, 1), make(chan error, 1)
	go func() {
		<-start
		_, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
		joined <- err
	}()
	go func() {
		<-start
		declined <- f.svc.DeclinePeopleRequest(t.Context(), f.acctB, request.ID)
	}()
	close(start)
	joinErr, declineErr := <-joined, <-declined
	switch {
	case joinErr == nil && errors.Is(declineErr, ErrGroupChanged):
	case declineErr == nil && errors.Is(joinErr, ErrNotFound):
	default:
		t.Fatalf("expected exactly one decision, got join %v, decline %v", joinErr, declineErr)
	}
	current, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "a")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range current.Tabs {
		if (item.Tab.InvitationDeclinedAtMS != nil) != (declineErr == nil) ||
			(item.Tab.Parties["b"].JoinedAtMS != nil) != (joinErr == nil) {
			t.Fatalf("sender state disagrees with winning decision: %+v", item.Tab)
		}
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
		sender := seedAccount(t, f.pool, fmt.Sprintf("sender-%d@example.test", i), "Sender")
		seedMember(t, f.pool, f.vaultA, sender, "editor")
		in.AccountID = sender
		group, err := f.svc.CreateGroup(t.Context(), in)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.SendPeopleRequest(t.Context(), sender, group.Group.ID, f.acctB)
		if i == 50 {
			if !errors.Is(err, ErrPeopleRequestInboxFull) {
				t.Fatalf("capacity: %v", err)
			}
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	items, err := f.svc.ListPeopleRequests(t.Context(), f.acctB)
	if err != nil || len(items) != 50 {
		t.Fatalf("all pending requests remain visible: %d %v", len(items), err)
	}
}
