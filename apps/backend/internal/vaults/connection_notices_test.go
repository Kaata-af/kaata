package vaults

import "testing"

func TestMemberInviteAndRoleNoticesTrackTransitions(t *testing.T) {
	f := newGraceVaultFixture(t)
	ctx := t.Context()
	count := func(kind, recipient string, want int) {
		t.Helper()
		if got := graceVaultCount(t, f, `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind=$1 AND recipient_account_id=$2::uuid AND vault_id=$3::uuid`, kind, recipient, f.vault); got != want {
			t.Fatalf("%s notices=%d want%d", kind, got, want)
		}
	}
	first := accountInviteCreate(t, f, f.owner, f.joiner, "viewer")
	accountInviteCreate(t, f, f.owner, f.joiner, "viewer")
	count("vault_invite_requested", f.joiner, 1)
	second := accountInviteCreate(t, f, f.owner, f.joiner, "clerk")
	if first.InviteID == second.InviteID {
		t.Fatal("replacement reused selector")
	}
	count("vault_invite_cancelled", f.joiner, 1)
	count("vault_invite_requested", f.joiner, 2)
	if err := f.svc.DeclineAccountInvite(ctx, f.joiner, second.InviteID); err != nil {
		t.Fatal(err)
	}
	count("vault_invite_rejected", f.owner, 1)
	third := accountInviteCreate(t, f, f.owner, f.joiner, "editor")
	for range 2 {
		if _, err := f.svc.AcceptInvite(ctx, AcceptInviteInput{Token: third.InviteToken, AccountID: f.joiner}); err != nil {
			t.Fatal(err)
		}
	}
	count("vault_invite_accepted", f.owner, 1)
	if got := graceVaultCount(t, f, `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind='vault_invite_requested' AND read_at IS NULL`); got != 0 {
		t.Fatal("handled invitations remain unread")
	}
	for _, role := range []string{"viewer", "viewer", "clerk", "viewer"} {
		if _, err := f.svc.SetMemberRole(ctx, f.vault, f.owner, f.joiner, role); err != nil {
			t.Fatal(err)
		}
	}
	count("vault_member_role_changed", f.joiner, 3)
	if _, err := f.svc.RevokeMember(ctx, RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: f.joiner}); err != nil {
		t.Fatal(err)
	}
	_, _ = f.svc.RevokeMember(ctx, RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: f.joiner})
	count("vault_member_removed", f.joiner, 1)
	if _, err := f.svc.Leave(ctx, f.vault, f.editor); err != nil {
		t.Fatal(err)
	}
	_, _ = f.svc.Leave(ctx, f.vault, f.editor)
	count("vault_member_left", f.owner, 1)
	if got := graceVaultCount(t, f, `SELECT COUNT(*) FROM account_connection_notifications WHERE recipient_account_id=actor_account_id`); got != 0 {
		t.Fatal("self notification")
	}
}

func TestCustomRoleNoticeOnlyWhenEffectiveConfigurationChanges(t *testing.T) {
	f := newGraceVaultFixture(t)
	ctx := t.Context()
	count := func(want int) {
		t.Helper()
		if got := graceVaultCount(t, f, `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind='vault_member_role_changed' AND recipient_account_id=$1::uuid`, f.editor); got != want {
			t.Fatalf("custom role notices=%d want%d", got, want)
		}
	}
	role, err := f.svc.SaveCustomRole(ctx, f.vault, f.owner, CustomRole{Name: "Counter", BaseRole: "editor", Permissions: []string{"entry.create"}})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := f.svc.AssignCustomRole(ctx, f.vault, f.owner, f.editor, &role.ID); err != nil {
			t.Fatal(err)
		}
	}
	count(1)
	role.Name = "Cash desk"
	if _, err := f.svc.SaveCustomRole(ctx, f.vault, f.owner, role); err != nil {
		t.Fatal(err)
	}
	count(2)
	role.Permissions = []string{"person.edit", "entry.create"}
	for range 2 {
		if _, err := f.svc.SaveCustomRole(ctx, f.vault, f.owner, role); err != nil {
			t.Fatal(err)
		}
	}
	count(3)
	for range 2 {
		if err := f.svc.AssignCustomRole(ctx, f.vault, f.owner, f.editor, nil); err != nil {
			t.Fatal(err)
		}
	}
	count(4)
	if got := graceVaultCount(t, f, `SELECT COUNT(*) FROM account_connection_notifications WHERE recipient_account_id=$1::uuid`, f.joiner); got != 0 {
		t.Fatal("unassigned outsider received role change")
	}
}
