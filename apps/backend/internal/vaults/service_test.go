package vaults

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/testutil"
)

// GET /v1/vaults now carries a members array (the display-name channel for
// mobile members screens — the signed membership chain deliberately carries
// no mutable profiles). Covers: explicit display name, provider name, install
// fallback, verified emails and active co-member privacy.
func TestListAttachesMemberNames(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	emails := map[string]string{}
	seedAccount := func(name string) string {
		var id string
		email := uuid.NewString() + "@gmail.com"
		if err := pool.QueryRow(ctx, `
			INSERT INTO accounts (google_sub, email, email_verified, name)
			VALUES ($1, $2, TRUE, $3)
			RETURNING id::text
		`, "sub-"+uuid.NewString(), email, name).Scan(&id); err != nil {
			t.Fatalf("seed account: %v", err)
		}
		emails[id] = email
		return id
	}
	owner := seedAccount("Matee Saafi")
	editor := seedAccount("") // no provider name — must fall back to install self_name
	revoked := seedAccount("Gone Person")
	pending := seedAccount("Pending Person")
	disabled := seedAccount("Disabled Person")

	vaultID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Shop', 'AFN', 0)
	`, vaultID, owner); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	for _, m := range []struct {
		account, role string
		revoked       bool
	}{{owner, "owner", false}, {editor, "editor", false}, {revoked, "editor", true}} {
		revokedSQL := "NULL"
		if m.revoked {
			revokedSQL = "NOW()"
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, revoked_at)
			VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), $4::uuid, `+revokedSQL+`)
		`, vaultID, m.account, m.role, owner); err != nil {
			t.Fatalf("seed membership: %v", err)
		}
	}
	for _, account := range []string{pending, disabled} {
		if _, err := pool.Exec(ctx, `INSERT INTO vault_members
			(vault_id, account_id, role, invited_at, accepted_at, invited_by)
			VALUES ($1::uuid, $2::uuid, 'viewer', NOW(), CASE WHEN $2::uuid = $4::uuid THEN NULL ELSE NOW() END, $3::uuid)`,
			vaultID, account, owner, pending); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET disabled_at = NOW() WHERE id = $1::uuid`, disabled); err != nil {
		t.Fatal(err)
	}
	// Check-in-reported self identity for the nameless account.
	if _, err := pool.Exec(ctx, `
		INSERT INTO installs (install_id, account_id, self_name)
		VALUES ($1::uuid, $2::uuid, 'Ahmad Wali')
	`, uuid.NewString(), editor); err != nil {
		t.Fatalf("seed install: %v", err)
	}

	listings, err := svc.List(ctx, owner)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listings) != 1 {
		t.Fatalf("List returned %d vaults, want 1", len(listings))
	}
	got := map[string]VaultMember{}
	for _, m := range listings[0].Members {
		got[m.AccountID] = m
	}
	if len(got) != 2 {
		t.Fatalf("members = %v, want exactly owner+editor (revoked excluded)", listings[0].Members)
	}
	if m := got[owner]; m.Name != "Matee Saafi" || m.Role != "owner" {
		t.Fatalf("owner member = %+v, want name 'Matee Saafi' role 'owner'", m)
	}
	if m := got[editor]; m.Name != "Ahmad Wali" || m.Role != "editor" {
		t.Fatalf("editor member = %+v, want install-fallback name 'Ahmad Wali' role 'editor'", m)
	}
	if _, ok := got[revoked]; ok {
		t.Fatalf("revoked member leaked into members array")
	}
	for _, id := range []string{owner, editor} {
		if got[id].Email != emails[id] {
			t.Fatalf("member email = %q, want verified profile email %q", got[id].Email, emails[id])
		}
	}
	// Profile changes are live data, independent of signed admission history.
	if _, err := pool.Exec(ctx, `UPDATE accounts SET display_name = 'Ahmad Renamed', email_verified = FALSE WHERE id = $1::uuid`, editor); err != nil {
		t.Fatal(err)
	}
	listings, err = svc.List(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range listings[0].Members {
		if member.AccountID == editor && (member.Name != "Ahmad Renamed" || member.Email != "") {
			t.Fatalf("changed member = %+v, want fresh name and no unverified email", member)
		}
	}
	// Read-only members may see profiles of their own co-members too.
	if _, err := pool.Exec(ctx, `UPDATE vault_members SET role = 'viewer' WHERE account_id = $1::uuid`, editor); err != nil {
		t.Fatal(err)
	}
	listings, err = svc.List(ctx, editor)
	if err != nil || len(listings) != 1 || len(listings[0].Members) != 2 {
		t.Fatalf("member listing = %+v, err=%v", listings, err)
	}
	// The name a member chose in Kaata (their phone's profile) outranks the
	// Google/Apple profile name; members used to see only the provider's.
	if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id, account_id, self_name)
		VALUES ($1::uuid, $2::uuid, 'Matee')`, uuid.NewString(), owner); err != nil {
		t.Fatal(err)
	}
	listings, err = svc.List(ctx, editor)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range listings[0].Members {
		if member.AccountID == owner && member.Name != "Matee" {
			t.Fatalf("owner shown as %q, want the name chosen in Kaata over the provider's", member.Name)
		}
	}
	stranger := seedAccount("Stranger")
	listings, err = svc.List(ctx, stranger)
	if err != nil || len(listings) != 0 {
		t.Fatalf("stranger listing = %+v, err=%v", listings, err)
	}
	// Directly pin the second-query gate, including a revocation after the
	// first query had already selected this vault.
	for _, denied := range []string{stranger, revoked} {
		selected := []VaultListing{{VaultID: vaultID}}
		if err := svc.attachMembers(ctx, denied, selected); err != nil {
			t.Fatal(err)
		}
		if len(selected[0].Members) != 0 {
			t.Fatalf("unauthorized profiles leaked: %+v", selected[0].Members)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE vault_members SET revoked_at = NOW() WHERE account_id = $1::uuid`, editor); err != nil {
		t.Fatal(err)
	}
	selected := []VaultListing{{VaultID: vaultID}}
	if err := svc.attachMembers(ctx, editor, selected); err != nil {
		t.Fatal(err)
	}
	if len(selected[0].Members) != 0 {
		t.Fatalf("post-selection revocation leaked profiles: %+v", selected[0].Members)
	}
	wire, err := json.Marshal(selected[0])
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(wire, &fields); err != nil || string(fields["members"]) != "[]" {
		t.Fatalf("revoked caller must get authoritative members:[], got %s, err=%v", wire, err)
	}
}

// Roles v2 Phase B: the REST surface grants the new roles, and MANAGER
// callers operate strictly below manager rank on all three endpoints.
func TestPhaseBRestGrantsAndManagerCaps(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	seed := func(role string, vaultID, invitedBy string) string {
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO accounts (google_sub, email, email_verified, name)
			VALUES ($1, $2, TRUE, 'P')
			RETURNING id::text
		`, "sub-"+uuid.NewString(), uuid.NewString()+"@gmail.com").Scan(&id); err != nil {
			t.Fatalf("seed account: %v", err)
		}
		if role != "" {
			if _, err := pool.Exec(ctx, `
				INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
				VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), $4::uuid)
			`, vaultID, id, role, invitedBy); err != nil {
				t.Fatalf("seed membership: %v", err)
			}
		}
		return id
	}

	vaultID := uuid.NewString()
	var owner string
	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, $2, TRUE, 'Owner') RETURNING id::text
	`, "sub-"+uuid.NewString(), uuid.NewString()+"@gmail.com").Scan(&owner); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Shop', 'AFN', 0)
	`, vaultID, owner); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, vaultID, owner); err != nil {
		t.Fatalf("seed owner membership: %v", err)
	}
	manager := seed("manager", vaultID, owner)
	editor := seed("editor", vaultID, owner)

	// Owner grants manager + clerk via REST — Phase A gate is gone.
	if _, err := svc.SetMemberRole(ctx, vaultID, owner, editor, "clerk"); err != nil {
		t.Fatalf("owner SetMemberRole(clerk): %v", err)
	}
	if _, err := svc.SetMemberRole(ctx, vaultID, owner, editor, "manager"); err != nil {
		t.Fatalf("owner SetMemberRole(manager): %v", err)
	}
	if _, err := svc.SetMemberRole(ctx, vaultID, owner, editor, "editor"); err != nil {
		t.Fatalf("owner SetMemberRole(back to editor): %v", err)
	}

	// Clerk invites work; manager invites stay refused.
	if _, err := svc.CreateInvite(ctx, CreateInviteInput{
		VaultID: vaultID, InviterAccID: owner, Role: "clerk",
	}); err != nil {
		t.Fatalf("owner CreateInvite(clerk): %v", err)
	}
	if _, err := svc.CreateInvite(ctx, CreateInviteInput{
		VaultID: vaultID, InviterAccID: owner, Role: "manager",
	}); !errors.Is(err, ErrInvalidRole) {
		t.Fatalf("CreateInvite(manager) = %v, want ErrInvalidRole", err)
	}

	// Manager caller: below-cap actions succeed…
	if _, err := svc.SetMemberRole(ctx, vaultID, manager, editor, "clerk"); err != nil {
		t.Fatalf("manager SetMemberRole(editor→clerk): %v", err)
	}
	if _, err := svc.CreateInvite(ctx, CreateInviteInput{
		VaultID: vaultID, InviterAccID: manager, Role: "editor",
	}); err != nil {
		t.Fatalf("manager CreateInvite(editor): %v", err)
	}
	// …at-or-above-cap actions refuse.
	if _, err := svc.SetMemberRole(ctx, vaultID, manager, editor, "manager"); !errors.Is(err, ErrInvalidRole) {
		t.Fatalf("manager mints manager = %v, want ErrInvalidRole", err)
	}
	if _, err := svc.SetMemberRole(ctx, vaultID, manager, owner, "editor"); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("manager demotes owner = %v, want ErrNotOwner", err)
	}
	if _, err := svc.RevokeMember(ctx, RevokeInput{
		VaultID: vaultID, CallerID: manager, TargetID: owner,
	}); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("manager revokes owner = %v, want ErrNotOwner", err)
	}
	// Manager revokes a below-cap member: allowed.
	if _, err := svc.RevokeMember(ctx, RevokeInput{
		VaultID: vaultID, CallerID: manager, TargetID: editor,
	}); err != nil {
		t.Fatalf("manager revokes clerk-ranked member: %v", err)
	}
	// Editor caller: no member management at all.
	editor2 := seed("editor", vaultID, owner)
	if _, err := svc.SetMemberRole(ctx, vaultID, editor2, manager, "viewer"); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("editor SetMemberRole = %v, want ErrNotOwner", err)
	}
}

// Audit #19: invitations introduced the owner by the Google/Apple name. Both
// the token preview (kaata.af invite page, joiner's stored owner name) and the
// signed-in pending list use the Members order: Kaata display name, then the
// name used in Kaata on the latest phone, then the provider name.
func TestInvitationsNameTheInviterAsKaataDoes(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	var owner, invitee string
	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (google_sub, email, email_verified, name, display_name)
		VALUES ($1, $2, TRUE, 'Google Name', 'Kaata Name') RETURNING id::text
	`, "sub-"+uuid.NewString(), uuid.NewString()+"@gmail.com").Scan(&owner); err != nil {
		t.Fatal(err)
	}
	inviteeEmail := uuid.NewString() + "@gmail.com"
	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, $2, TRUE, 'Joiner') RETURNING id::text
	`, "sub-"+uuid.NewString(), inviteeEmail).Scan(&invitee); err != nil {
		t.Fatal(err)
	}
	vaultID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Shop', 'AFN', 0)
	`, vaultID, owner); err != nil {
		t.Fatal(err)
	}
	token := "invite-token-" + uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, role, invited_by, invited_at,
			invite_email, invite_token_hash, invite_expires_at, invite_attempts)
		VALUES ($1::uuid, 'editor', $2::uuid, NOW(), $3, $4, NOW() + INTERVAL '1 day', 0)
	`, vaultID, owner, NormalizeInviteEmail(inviteeEmail), hashInviteToken(token)); err != nil {
		t.Fatal(err)
	}
	expect := func(want string) {
		t.Helper()
		info, err := svc.InviteInfo(ctx, token)
		if err != nil || info.InviterName != want {
			t.Fatalf("invite preview names %q (%v), want %q", info.InviterName, err, want)
		}
		pending, err := svc.ListPendingInvites(ctx, invitee)
		if err != nil || len(pending) != 1 || pending[0].InviterName != want {
			t.Fatalf("pending invites %+v (%v), want inviter %q", pending, err, want)
		}
	}
	expect("Kaata Name")
	if _, err := pool.Exec(ctx, `UPDATE accounts SET display_name = NULL WHERE id = $1::uuid`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO installs (install_id, account_id, self_name) VALUES ($1::uuid, $2::uuid, 'Shop Name')
	`, uuid.NewString(), owner); err != nil {
		t.Fatal(err)
	}
	expect("Shop Name")
	if _, err := pool.Exec(ctx, `UPDATE installs SET self_name = '' WHERE account_id = $1::uuid`, owner); err != nil {
		t.Fatal(err)
	}
	expect("Google Name")
}
