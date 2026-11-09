package tabs

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/vaults"
)

func TestVaultInviteRejectionInbox(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := t.Context()
	vaultService := vaults.NewService(f.pool)
	sender := seedAccount(t, f.pool, "manager@example.com", "Manager")
	seedMember(t, f.pool, f.vaultA, sender, "manager")
	jwtSender, jwtRecipient := f.jwtFor(t, sender), f.jwtFor(t, f.acctB)
	const legacyFlags = "include_connections=1"
	const bothFlags = legacyFlags + "&include_vault_invite_results=1"
	list := func(jwt, flags string) InboxPage {
		t.Helper()
		r := f.do(t, "GET", "/v1/tabs/inbox?locale=en&"+flags, "Bearer "+jwt, nil)
		var page InboxPage
		if r.status != 200 || json.Unmarshal(r.body, &page) != nil {
			t.Fatalf("inbox: %d %s", r.status, r.body)
		}
		return page
	}
	mark := func(jwt, flags string, selector map[string]any, want float64) {
		t.Helper()
		r := f.do(t, "POST", "/v1/tabs/inbox/read?"+flags, "Bearer "+jwt, selector)
		if r.status != 200 || r.json(t)["marked"] != want {
			t.Fatalf("mark: %d %s, want %g", r.status, r.body, want)
		}
	}
	createInvite := func() vaults.AccountInviteResult {
		t.Helper()
		invite, err := vaultService.CreateAccountInvite(ctx, vaults.CreateAccountInviteInput{
			VaultID: f.vaultA, InviterAccID: sender, TargetAccountID: f.acctB, Role: "viewer",
		})
		if err != nil {
			t.Fatal(err)
		}
		return invite
	}
	request := createInvite()
	if err := vaultService.DeclineAccountInvite(ctx, f.acctA, request.InviteID); !errors.Is(err, vaults.ErrInviteNotFound) {
		t.Fatalf("foreign rejection: %v", err)
	}
	if page := list(jwtSender, bothFlags); len(page.Items) != 0 {
		t.Fatalf("sending or foreign decline created a result: %+v", page)
	}
	if err := vaultService.DeclineAccountInvite(ctx, f.acctB, request.InviteID); err != nil {
		t.Fatal(err)
	}
	if err := vaultService.DeclineAccountInvite(ctx, f.acctB, request.InviteID); !errors.Is(err, vaults.ErrInviteNotFound) {
		t.Fatalf("decline retry: %v", err)
	}
	expired := createInvite()
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET invite_expires_at=NOW()-INTERVAL '1 day' WHERE invite_request_id=$1::uuid`, expired.InviteID); err != nil {
		t.Fatal(err)
	}
	if err := vaultService.DeclineAccountInvite(ctx, f.acctB, expired.InviteID); err != nil {
		t.Fatalf("dismiss expired request: %v", err)
	}
	revoked := createInvite()
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET revoked_at=NOW(),revoked_reason='invite_no_longer_valid' WHERE invite_request_id=$1::uuid`, revoked.InviteID); err != nil {
		t.Fatal(err)
	}
	if err := vaultService.DeclineAccountInvite(ctx, f.acctB, revoked.InviteID); !errors.Is(err, vaults.ErrInviteNotFound) {
		t.Fatalf("reject revoked request: %v", err)
	}
	page := list(jwtSender, bothFlags)
	if len(page.Items) != 1 || page.Unread != 1 {
		t.Fatalf("expected one result from the actual rejection: %+v", page)
	}
	notice := page.Items[0]
	if notice.Kind != "vault_invite_rejected" || notice.ActorAccountID != f.acctB ||
		notice.TabID != "" || notice.Role != "" || notice.EntryID != "" || notice.Rev != 0 ||
		notice.Read || page.LatestID != notice.ID ||
		!strings.Contains(notice.Body, "Ahmad\u2069 declined your invitation to \u2068Saafi Store") {
		t.Fatalf("rejection payload: %+v", notice)
	}
	for _, jwt := range []string{jwtRecipient, f.jwtFor(t, f.acctA)} {
		if page := list(jwt, bothFlags); len(page.Items) != 0 || page.Unread != 0 {
			t.Fatalf("non-sender saw the result: %+v", page)
		}
		mark(jwt, bothFlags, map[string]any{"id": notice.ID}, 0)
	}
	for _, flags := range []string{"", legacyFlags, "include_vault_invite_results=1"} {
		if page := list(jwtSender, flags); len(page.Items) != 0 || page.LatestID != "0" {
			t.Fatalf("client without both flags saw a rejection: %+v", page)
		}
		mark(jwtSender, flags, map[string]any{"through": notice.ID}, 0)
	}

	// Simulate a pre-migration process using the original table name.
	var friendID string
	if err := f.pool.QueryRow(ctx, `INSERT INTO account_friend_notifications
 (friend_request_id,recipient_account_id,actor_account_id,actor_label)
 VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'Ahmad') RETURNING id::text`, sender, f.acctB).Scan(&friendID); err != nil {
		t.Fatalf("old friend writer: %v", err)
	}
	tag, err := f.pool.Exec(ctx, `UPDATE account_friend_notifications SET read_at=NOW()
 WHERE recipient_account_id=$1::uuid AND id<=$2::bigint`, sender, friendID)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("old friend mark-all: %v %v", tag, err)
	}
	if page := list(jwtSender, legacyFlags); len(page.Items) != 1 || page.Items[0].Kind != "friend_accepted" || !page.Items[0].Read {
		t.Fatalf("legacy friend-only inbox: %+v", page)
	}
	if page := list(jwtSender, bothFlags); len(page.Items) != 2 || page.Unread != 1 || page.Items[1].ID != notice.ID {
		t.Fatalf("combined inbox: %+v", page)
	}
	mark(jwtSender, bothFlags, map[string]any{"id": notice.ID}, 1)
	mark(jwtSender, bothFlags, map[string]any{"id": notice.ID}, 0)
	if page := list(jwtSender, bothFlags); page.Unread != 0 || !page.Items[1].Read {
		t.Fatalf("read status did not persist: %+v", page)
	}
}

func TestVaultInviteRejectedBody(t *testing.T) {
	for _, locale := range []string{"en", "fa", "ps"} {
		body := vaultInviteRejectedBody(locale, " A\n\u202eB ", " C\tD ")
		if !strings.Contains(body, "\u2068AB\u2069") || !strings.Contains(body, "\u2068CD\u2069") {
			t.Errorf("%s unsafe or missing names: %q", locale, body)
		}
	}
}
