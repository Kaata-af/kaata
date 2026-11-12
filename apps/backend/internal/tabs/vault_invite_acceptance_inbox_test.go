package tabs

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/vaults"
)

func TestVaultInviteAcceptanceInbox(t *testing.T) {
	f := newHTTPFixture(t)
	books := vaults.NewService(f.pool)
	ctx := t.Context()
	manager := seedAccount(t, f.pool, "accept-manager@example.test", "Manager")
	seedMember(t, f.pool, f.vaultA, manager, "manager")
	flags := "include_connections=1&include_vault_invite_results=1&include_vault_invite_acceptances=1"
	list := func(account, query string) InboxPage {
		t.Helper()
		r := f.do(t, "GET", "/v1/tabs/inbox?locale=en&"+query, "Bearer "+f.jwtFor(t, account), nil)
		var page InboxPage
		if r.status != 200 || json.Unmarshal(r.body, &page) != nil {
			t.Fatalf("inbox: %d %s", r.status, r.body)
		}
		return page
	}
	invite, err := books.CreateAccountInvite(ctx, vaults.CreateAccountInviteInput{
		VaultID: f.vaultA, InviterAccID: manager, TargetAccountID: f.acctB, Role: "viewer",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := books.AcceptInvite(ctx, vaults.AcceptInviteInput{Token: invite.InviteToken, AccountID: f.acctA}); !errors.Is(err, vaults.ErrInviteNotFound) {
		t.Fatalf("foreign accept: %v", err)
	}
	if page := list(manager, flags); len(page.Items) != 0 {
		t.Fatalf("unaccepted request created a notification: %+v", page)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := books.AcceptInvite(ctx, vaults.AcceptInviteInput{Token: invite.InviteToken, AccountID: f.acctB}); err != nil {
			t.Fatal(err)
		}
	}
	page := list(manager, flags)
	if len(page.Items) != 1 || page.Unread != 1 {
		t.Fatalf("accept + retry should notify exactly once: %+v", page)
	}
	notice := page.Items[0]
	if notice.Kind != "vault_invite_accepted" || notice.ActorAccountID != f.acctB || notice.TabID != "" || notice.Rev != 0 ||
		!strings.Contains(notice.Body, "Ahmad\u2069 accepted your invitation to \u2068Saafi Store") {
		t.Fatalf("acceptance payload: %+v", notice)
	}
	for _, account := range []string{f.acctA, f.acctB} {
		if page := list(account, flags); len(page.Items) != 0 || page.Unread != 0 {
			t.Fatalf("non-inviter received an acceptance: %+v", page)
		}
	}
	for _, oldFlags := range []string{"", "include_connections=1", "include_connections=1&include_vault_invite_results=1", "include_vault_invite_acceptances=1"} {
		if page := list(manager, oldFlags); len(page.Items) != 0 || page.Unread != 0 || page.LatestID != "0" {
			t.Fatalf("old client sees unsupported notice/count: %+v", page)
		}
		r := f.do(t, "POST", "/v1/tabs/inbox/read?"+oldFlags, "Bearer "+f.jwtFor(t, manager), map[string]any{"through": notice.ID})
		if r.status != 200 || r.json(t)["marked"] != float64(0) {
			t.Fatalf("old client marked unseen notification: %d %s", r.status, r.body)
		}
	}
	r := f.do(t, "POST", "/v1/tabs/inbox/read?"+flags, "Bearer "+f.jwtFor(t, manager), map[string]any{"id": notice.ID})
	if r.status != 200 || r.json(t)["marked"] != float64(1) {
		t.Fatalf("mark acceptance read: %d %s", r.status, r.body)
	}
	if page := list(manager, flags); page.Unread != 0 || !page.Items[0].Read {
		t.Fatalf("read state lost: %+v", page)
	}
}

func TestVaultInviteAcceptedBody(t *testing.T) {
	for _, locale := range []string{"en", "fa", "ps"} {
		body := vaultInviteAcceptedBody(locale, " A\n\u202eB ", " C\tD ")
		if !strings.Contains(body, "\u2068AB\u2069") || !strings.Contains(body, "\u2068CD\u2069") {
			t.Errorf("%s unsafe or missing names: %q", locale, body)
		}
		if vaultInviteAcceptedBody(locale, "", "") == "" {
			t.Errorf("%s missing-name fallback is empty", locale)
		}
	}
}
