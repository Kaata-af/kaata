package tabs

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestNotificationReviewRevisionBalanceAndIdempotency(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	c := f.create(t, "A", "", "")
	pa, pb := f.party(t, c.MyToken, c.Tab.ID), f.party(t, c.InviteToken, c.Tab.ID)
	for role, acct := range map[string]string{"a": f.acctA, "b": f.acctB} {
		p := pa
		if role == "b" {
			p = pb
		}
		if _, err := f.svc.Bind(ctx, p, BindInput{AccountID: acct}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := f.pool.Exec(ctx, `INSERT INTO tab_push_subscriptions(tab_id,role,install_id,token,account_id)
 VALUES($1::uuid,'a',$2::uuid,'ExpoPushToken[synthetic_test_123456]',$3::uuid)`, c.Tab.ID, uuid.NewString(), f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	added := f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli())
	rejected, err := f.svc.Dispute(ctx, pb, added.Entry.ID, "", added.Entry.Rev)
	if err != nil {
		t.Fatal(err)
	}
	if rejected.Tab.Balance["a"] != "0" || rejected.Tab.Balance["b"] != "0" {
		t.Fatal(rejected.Tab.Balance)
	}
	var kind, entry string
	if err = f.pool.QueryRow(ctx, "SELECT event_kind,entry_id::text FROM tab_push_outbox").Scan(&kind, &entry); err != nil {
		t.Fatal(err)
	}
	if kind != "entry_rejected" || entry != added.Entry.ID {
		t.Fatalf("%s %s", kind, entry)
	}
	repeated, err := f.svc.Dispute(ctx, pb, added.Entry.ID, "", added.Entry.Rev)
	if err != nil || repeated.Entry.Rev != rejected.Entry.Rev {
		t.Fatalf("duplicate changed state: %+v %v", repeated, err)
	}
	var jobs int
	_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_push_outbox").Scan(&jobs)
	if jobs != 1 {
		t.Fatalf("duplicate alerts: %d", jobs)
	}
	if _, err = f.svc.Accept(ctx, pb, added.Entry.ID, added.Entry.Rev); !errors.Is(err, ErrReviewFinal) {
		t.Fatalf("stale alert: %v", err)
	}
	if _, err = f.svc.Accept(ctx, pb, added.Entry.ID, rejected.Entry.Rev); !errors.Is(err, ErrReviewFinal) {
		t.Fatalf("latest revision must not reopen a rejected tally: %v", err)
	}
	// Trying again is a NEW tally, not a status change on the rejected history.
	fresh := f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli())
	accepted, err := f.svc.Accept(ctx, pb, fresh.Entry.ID, fresh.Entry.Rev)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Tab.Balance["a"] != "100" || accepted.Tab.Balance["b"] != "-100" {
		t.Fatal(accepted.Tab.Balance)
	}
	if _, err = f.svc.Accept(ctx, pa, fresh.Entry.ID, accepted.Entry.Rev); !errors.Is(err, ErrOwnEntry) {
		t.Fatalf("own review: %v", err)
	}
}

func TestAppOnlyClaimDoesNotAuthorizeForwardedLink(t *testing.T) {
	f := newHTTPFixture(t)
	c := f.createOverHTTP(t, "")
	path := "/v1/tabs/" + c.Tab.ID
	for _, route := range []string{path + "/entries", path + "/join", path + "/label", path + "/close", path + "/notifications"} {
		got := f.do(t, "POST", route, "Tab "+c.InviteToken, map[string]any{"label": "B"})
		if got.status != 401 && got.status != 404 {
			t.Fatalf("capability authorized %s: %d", route, got.status)
		}
	}
	if got := f.do(t, "POST", "/v1/tabs", "", map[string]any{"label": "A", "currency": "AFN"}); got.status != 401 {
		t.Fatal(got.status)
	}
	jwtB := "Bearer " + f.jwtFor(t, f.acctB)
	joined := f.do(t, "POST", path+"/join", jwtB, map[string]any{"token": c.InviteToken, "label": "B"})
	if joined.status != 200 {
		t.Fatalf("join %s", joined.body)
	}
	stranger := "Bearer " + f.jwtFor(t, seedAccount(t, f.pool, "forwarded@example.com", "Stranger"))
	for _, route := range []string{"/v1/tabs/by-token", path + "/join", path + "/bind"} {
		got := f.do(t, "POST", route, stranger, map[string]any{"token": c.InviteToken, "label": "S"})
		if got.status != 404 {
			t.Fatalf("forwarded invitation leaked %s: %d", route, got.status)
		}
	}
	// FK SET NULL during account deletion must not re-open an invitation.
	if _, err := f.pool.Exec(context.Background(), "UPDATE tab_parties SET account_id=NULL WHERE tab_id=$1::uuid AND role='b'", c.Tab.ID); err != nil {
		t.Fatal(err)
	}
	got := f.do(t, "POST", path+"/join", stranger, map[string]any{"token": c.InviteToken, "label": "S"})
	if got.status != 404 {
		t.Fatalf("deleted account became claimable: %d", got.status)
	}
}

func TestConcurrentInvitationClaimsCannotReplaceEachOther(t *testing.T) {
	f := newTabFixture(t)
	c := f.create(t, "A", "", "")
	p := f.party(t, c.InviteToken, c.Tab.ID) // both callers resolved BEFORE either claimed it
	ctx := context.Background()
	if _, err := f.svc.Join(ctx, p, JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Join(ctx, p, JoinInput{Label: "A", AccountID: &f.acctA}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale claim replaced owner: %v", err)
	}
	if _, err := f.svc.Bind(ctx, p, BindInput{AccountID: f.acctA}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale bind replaced owner: %v", err)
	}
}
