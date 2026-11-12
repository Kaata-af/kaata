package tabs

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSharedInvitationResultsNotifyOncePerGroup(t *testing.T) {
	for _, mode := range []string{"review", "notify", "notify_one_way"} {
		for _, accepted := range []bool{false, true} {
			t.Run(mode+map[bool]string{true: "/accepted", false: "/declined"}[accepted], func(t *testing.T) {
				f := newTabFixture(t)
				publishRequestRecipient(t, f)
				in := groupInput(t, f, mode)
				created, err := f.svc.CreateGroup(t.Context(), in)
				if err != nil {
					t.Fatal(err)
				}
				request, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB)
				if err != nil {
					t.Fatal(err)
				}
				for _, leg := range created.Tabs {
					if _, err := f.pool.Exec(t.Context(), `INSERT INTO tab_push_subscriptions(tab_id,role,account_id,install_id,token)
 VALUES($1::uuid,'a',$2::uuid,$3::uuid,'ExpoPushToken[invitation_test]')`, leg.Tab.ID, f.acctA, uuid.NewString()); err != nil {
						t.Fatal(err)
					}
				}
				// The same HTTP operation may be retried after losing its response.
				for attempt := 0; attempt < 2; attempt++ {
					if accepted {
						join := joinGroupInput(f, in)
						// Keep a stable destination across retries.
						join.RelationshipID = in.RelationshipID
						join.Token = request.Token
						_, err = f.svc.JoinGroup(t.Context(), created.Group.ID, join)
					} else {
						err = f.svc.DeclinePeopleRequest(t.Context(), f.acctB, request.ID)
					}
					if err != nil {
						t.Fatal(err)
					}
				}
				kind := "invitation_declined"
				if accepted {
					kind = "invitation_accepted"
				}
				page, err := f.svc.listInbox(t.Context(), f.acctA, "en", 0, nil)
				if err != nil || len(page.Items) != 1 || page.Unread != 1 || page.Items[0].Kind != kind {
					t.Fatalf("one durable result expected: %+v %v", page, err)
				}
				if !strings.Contains(page.Items[0].Body, "shared account invitation") {
					t.Fatal(page.Items[0].Body)
				}
				var jobs int
				if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM tab_push_outbox WHERE event_kind=$1`, kind).Scan(&jobs); err != nil || jobs != 1 {
					t.Fatalf("one push expected, got %d: %v", jobs, err)
				}
				pending, err := f.svc.ListPeopleRequests(t.Context(), f.acctB)
				if err != nil || len(pending) != 0 {
					t.Fatalf("handled invitation still pending: %+v %v", pending, err)
				}
				for _, locale := range []string{"en", "fa", "ps"} {
					if pushBodyFor(kind, locale, false) == pushBodyFor("updated", locale, false) {
						t.Fatalf("missing %s result copy", locale)
					}
				}
			})
		}
	}
}

func TestSharedInvitationExpiryMetadataDoesNotChangeMoney(t *testing.T) {
	f := newTabFixture(t)
	publishRequestRecipient(t, f)
	in := groupInput(t, f, "notify")
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	for _, leg := range created.Tabs {
		if leg.Tab.InvitationExpiresAtMS != nil {
			t.Fatal("public link unexpectedly expires")
		}
	}
	request, err := f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	sent, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "a")
	if err != nil {
		t.Fatal(err)
	}
	for i, leg := range sent.Tabs {
		if leg.Tab.InvitationExpiresAtMS == nil || *leg.Tab.InvitationExpiresAtMS <= time.Now().UnixMilli() || leg.Tab.Rev != created.Tabs[i].Tab.Rev+1 {
			t.Fatalf("send did not publish expiry: %+v", leg.Tab)
		}
		if leg.Tab.Balance["a"] != created.Tabs[i].Tab.Balance["a"] {
			t.Fatal("sending changed money")
		}
	}
	if _, err = f.svc.SendPeopleRequest(t.Context(), f.acctA, created.Group.ID, f.acctB); err != nil {
		t.Fatal(err)
	}
	retry, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "a")
	if err != nil || retry.Group.Rev != sent.Group.Rev {
		t.Fatalf("send retry bumped revision: %+v %v", retry.Group, err)
	}
	if _, err = f.pool.Exec(t.Context(), `UPDATE people_requests SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1::uuid`, request.ID); err != nil {
		t.Fatal(err)
	}
	expired, err := f.svc.Mine(t.Context(), f.acctA, f.vaultA)
	if err != nil {
		t.Fatal(err)
	}
	for _, leg := range expired.Tabs {
		if leg.Tab.InvitationExpiresAtMS == nil || *leg.Tab.InvitationExpiresAtMS > time.Now().UnixMilli() {
			t.Fatalf("expiry hidden from sender: %+v", leg.Tab)
		}
	}
	for _, token := range []string{request.Token, in.InviteToken} {
		if _, err = f.svc.PreviewGroup(t.Context(), token, f.acctB); !errors.Is(err, ErrNotFound) {
			t.Fatalf("expired invitation remained usable: %v", err)
		}
	}
}

func TestSharedGroupMembershipOverlapKeepsBothBookPerspectives(t *testing.T) {
	f := newTabFixture(t)
	seedMember(t, f.pool, f.vaultA, f.acctB, "viewer")
	seedMember(t, f.pool, f.vaultB, f.acctA, "clerk")
	in := groupInput(t, f, "review")
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	join := joinGroupInput(f, in)
	joined, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
	if err != nil {
		t.Fatalf("member could not accept independent shared account: %v", err)
	}
	for _, account := range []string{f.acctA, f.acctB} {
		for _, scope := range []struct{ vault, role, relationship string }{
			{f.vaultA, "a", in.RelationshipID}, {f.vaultB, "b", join.RelationshipID},
		} {
			mine, err := f.svc.Mine(t.Context(), account, scope.vault)
			if err != nil || len(mine.Tabs) != 2 || len(mine.Groups) != 1 {
				t.Fatalf("scoped discovery: %+v %v", mine, err)
			}
			for _, tab := range mine.Tabs {
				if tab.Role != scope.role || tab.RelationshipID == nil || *tab.RelationshipID != scope.relationship || tab.Tab.You != scope.role {
					t.Fatalf("wrong book perspective: %+v", tab)
				}
				if tab.Tab.Access == nil {
					t.Fatal("discovery omitted caller permissions")
				}
				if account == f.acctB && scope.role == "a" && (tab.Tab.Access.Append || tab.Tab.Access.Review || tab.Tab.Access.Manage) {
					t.Fatalf("viewer discovery inherited other side's owner rights: %+v", tab.Tab.Access)
				}
				if account == f.acctA && scope.role == "b" && (!tab.Tab.Access.Append || tab.Tab.Access.Review || tab.Tab.Access.Manage) {
					t.Fatalf("clerk discovery inherited other side's owner rights: %+v", tab.Tab.Access)
				}
			}
			if mine.Groups[0].You != scope.role {
				t.Fatalf("wrong group perspective: %+v", mine.Groups[0])
			}
		}
	}
	tabID := joined.Tabs[0].Tab.ID
	member, err := f.svc.partyByAccountRole(t.Context(), tabID, f.acctB, "a")
	if err != nil || member.MemberRole != "viewer" {
		t.Fatalf("member perspective: %+v %v", member, err)
	}
	if _, err = f.svc.Append(t.Context(), member, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "1", OccurredAtMS: 200}); !errors.Is(err, ErrRoleInsufficient) {
		t.Fatalf("viewer gained write access from direct other-side account: %v", err)
	}
	memberView, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctB, "a")
	if err != nil || memberView.Tabs[0].Tab.Access == nil || memberView.Tabs[0].Tab.Access.Append {
		t.Fatalf("group read lost member permissions: %+v %v", memberView, err)
	}
	clerk, err := f.svc.partyByAccountRole(t.Context(), tabID, f.acctA, "b")
	if err != nil {
		t.Fatal(err)
	}
	written, err := f.svc.Append(t.Context(), clerk, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "1", OccurredAtMS: 200})
	if err != nil || written.Tab.Access == nil || !written.Tab.Access.Append || written.Tab.Access.Review || written.Tab.Access.Manage {
		t.Fatalf("mutation response lost scoped permissions: %+v %v", written.Tab.Access, err)
	}
	direct, err := f.svc.PartyByAccount(t.Context(), tabID, f.acctB)
	if err != nil || direct.Role != "b" {
		t.Fatalf("legacy direct participant default: %+v %v", direct, err)
	}
	observer := seedAccount(t, f.pool, "both-books@example.test", "Both books")
	seedMember(t, f.pool, f.vaultA, observer, "editor")
	seedMember(t, f.pool, f.vaultB, observer, "editor")
	if _, err := f.svc.PartyByAccount(t.Context(), tabID, observer); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ambiguous member request picked a side: %v", err)
	}
	for _, role := range []string{"a", "b"} {
		if p, err := f.svc.partyByAccountRole(t.Context(), tabID, observer, role); err != nil || p.Role != role {
			t.Fatalf("explicit member side: %+v %v", p, err)
		}
	}
	outsider := seedAccount(t, f.pool, "unrelated-book@example.test", "Unrelated")
	if mine, err := f.svc.Mine(t.Context(), outsider, f.vaultA); err != nil || len(mine.Tabs) != 0 {
		t.Fatalf("scope granted unauthorized access: %+v %v", mine, err)
	}
	// Revoking the job in the other Kaata does not revoke the independent
	// shared account in this person's own book (the two-phone regression).
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, f.acctB); err != nil {
		t.Fatal(err)
	}
	if mine, err := f.svc.Mine(t.Context(), f.acctB, f.vaultA); err != nil || len(mine.Tabs) != 0 {
		t.Fatalf("removed membership still discovered the host's book: %+v %v", mine, err)
	}
	if _, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctB, "a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member still read the host's perspective: %v", err)
	}
	if own, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctB, "b"); err != nil || own.Group.Parties["b"].JoinedAtMS == nil || own.Tabs[0].Tab.Access == nil || !own.Tabs[0].Tab.Access.Manage {
		t.Fatalf("removing membership damaged the independent shared account: %+v %v", own, err)
	}
	// Returning as a Viewer adds a new seat; the revoked historical row stays.
	// This is the physical Samsung regression: its own B side worked while
	// scoped discovery incorrectly hid the readmitted A side forever.
	seedMember(t, f.pool, f.vaultA, f.acctB, "viewer")
	for _, scope := range []struct{ vault, role string }{{f.vaultA, "a"}, {f.vaultB, "b"}} {
		mine, err := f.svc.Mine(t.Context(), f.acctB, scope.vault)
		if err != nil || len(mine.Tabs) != 2 || len(mine.Groups) != 1 || mine.Groups[0].You != scope.role {
			t.Fatalf("readmitted scoped discovery: %+v %v", mine, err)
		}
		for _, item := range mine.Tabs {
			if item.Role != scope.role || item.Tab.Parties["b"].JoinedAtMS == nil || item.Tab.Access == nil || (scope.role == "a" && (item.Tab.Access.Append || item.Tab.Access.Review || item.Tab.Access.Manage)) {
				t.Fatalf("readmitted wrong perspective/permissions: %+v", item)
			}
		}
	}
	if memberView, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctB, "a"); err != nil || memberView.Tabs[0].Tab.Access == nil || memberView.Tabs[0].Tab.Access.Append {
		t.Fatalf("readmitted group view: %+v %v", memberView, err)
	}
}

func TestSharedNotificationsKeepBothPartySubscriptionsOnOnePhone(t *testing.T) {
	f := newHTTPFixture(t)
	created := f.createOverHTTP(t, "")
	if _, err := f.svc.Bind(t.Context(), f.party(t, created.MyToken, created.Tab.ID), BindInput{AccountID: f.acctA, VaultID: &f.vaultA}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Bind(t.Context(), f.party(t, created.InviteToken, created.Tab.ID), BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	observer := seedAccount(t, f.pool, "observer@example.test", "Observer")
	seedMember(t, f.pool, f.vaultA, observer, "viewer")
	seedMember(t, f.pool, f.vaultB, observer, "viewer")
	jwt := f.jwtFor(t, observer)
	path := "/v1/tabs/" + created.Tab.ID + "/notifications"
	registration := map[string]any{"install_id": uuid.NewString(), "token": "ExpoPushToken[both_party_test]", "locale": "en"}
	for _, role := range []string{"a", "b", "a"} {
		result := f.do(t, "POST", path, "Bearer "+jwt, registration, role)
		if result.status != 200 {
			t.Fatalf("register %s: %d %s", role, result.status, result.body)
		}
	}
	var count int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM tab_push_subscriptions WHERE account_id=$1::uuid`, observer).Scan(&count); err != nil || count != 2 {
		t.Fatalf("registration lost one perspective: %d, %v", count, err)
	}
	for _, account := range []string{f.acctA, f.acctB} {
		party, err := f.svc.PartyByAccount(t.Context(), created.Tab.ID, account)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.svc.SetLabel(t.Context(), party, "Changed label"); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(DISTINCT s.role) FROM tab_push_outbox o JOIN tab_push_subscriptions s ON s.id=o.subscription_id WHERE s.account_id=$1::uuid`, observer).Scan(&count); err != nil || count != 2 {
		t.Fatalf("missing alerts for one perspective: %d, %v", count, err)
	}
	registration["token"] = ""
	result := f.do(t, "POST", path, "Bearer "+jwt, registration, "a")
	if result.status != 200 {
		t.Fatalf("unregister: %d %s", result.status, result.body)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM tab_push_subscriptions WHERE account_id=$1::uuid AND role='b'`, observer).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unregister removed the other perspective: %d, %v", count, err)
	}
}
