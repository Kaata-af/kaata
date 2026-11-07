package sync

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/mesh"
	"github.com/matee/kaata-backend/internal/vaults"
)

// Exercise the complete server boundary: create + accept the real invitation,
// discover the already-accepted seat without its token, obtain real signatures,
// and publish the guest's signed admission for the owner's next pull.
func TestBrokeredInviteAdmissionRecovery(t *testing.T) {
	for _, scenario := range []struct {
		name, kind, role string
		manager          bool
	}{
		{"direct_owner", "direct", "clerk", false},
		{"direct_former_manager", "direct", "editor", true},
		{"legacy_link", "link", "editor", false},
		{"legacy_email", "email", "viewer", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newM2Fixture(t)
			ctx := t.Context()
			books := vaults.NewService(f.pool)
			books.SetMembershipInvalidator(f.svc)
			witnesses := mesh.NewService(f.pool, f.serverPriv, base64.StdEncoding.EncodeToString(f.serverPub), "")
			exec := func(sql string, args ...any) {
				t.Helper()
				if _, err := f.pool.Exec(ctx, sql, args...); err != nil {
					t.Fatal(err)
				}
			}
			genesis := f.membershipEvent(EventVaultMemberAdded, f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
				map[string]any{"account_id": f.ownerAcct, "role": "owner"})
			f.signEvent(t, &genesis, f.anchorPriv)
			requireAccepted(t, f.pushAs(t, f.ownerAcct, genesis), 1)
			inviter := f.ownerAcct
			if scenario.manager {
				inviter = f.seedAccount(t, "inviter@recovery.test")
				manager := f.membershipEvent(EventVaultMemberAdded, f.anchorDeviceID, f.ownerAcct, inviter,
					map[string]any{"account_id": inviter, "role": "manager"})
				f.signEvent(t, &manager, f.anchorPriv)
				requireAccepted(t, f.pushAs(t, f.ownerAcct, manager), 1)
			}
			guest := f.seedAccount(t, "guest@recovery.test")
			device := uuid.NewString()
			pub, priv, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			exec(`INSERT INTO installs(install_id,account_id) VALUES($1::uuid,$2::uuid)`, device, guest)
			if err := witnesses.RegisterKey(ctx, device, pub); err != nil {
				t.Fatal(err)
			}
			var token string
			if scenario.kind == "direct" {
				request, err := books.CreateAccountInvite(ctx, vaults.CreateAccountInviteInput{
					VaultID: f.vaultID, InviterAccID: inviter, TargetAccountID: guest, Role: scenario.role,
				})
				if err != nil {
					t.Fatal(err)
				}
				token = request.InviteToken
			} else {
				email := ""
				if scenario.kind == "email" {
					email = "guest@recovery.test"
				}
				request, err := books.CreateInvite(ctx, vaults.CreateInviteInput{
					VaultID: f.vaultID, InviterAccID: inviter, Email: email, Role: scenario.role,
				})
				if err != nil {
					t.Fatal(err)
				}
				token = strings.TrimPrefix(request.InviteURL, "https://kaata.af/i/")
			}
			if _, err := witnesses.IssueWitness(ctx, f.vaultID, guest, device); !errors.Is(err, mesh.ErrNotMember) {
				t.Fatalf("pending invitation granted a witness: %v", err)
			}
			if listed, err := books.List(ctx, guest); err != nil || len(listed) != 0 {
				t.Fatalf("pending invitation granted discovery: %+v %v", listed, err)
			}
			if _, err := books.AcceptInvite(ctx, vaults.AcceptInviteInput{Token: token, AccountID: guest, InstallID: device}); err != nil {
				t.Fatal(err)
			}
			// Model an old accepted seat whose phone lost its vault/journal. No
			// new invite or acceptance is involved in the recovery below.
			exec(`UPDATE vault_members SET invite_expires_at=NOW()-INTERVAL '30 days'
 WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, guest)
			exec(`UPDATE accounts SET discovery_enabled=FALSE WHERE id=$1::uuid`, guest)
			if scenario.manager {
				if _, err := books.RevokeMember(ctx, vaults.RevokeInput{VaultID: f.vaultID, CallerID: f.ownerAcct, TargetID: inviter}); err != nil {
					t.Fatal(err)
				}
			}
			listed, err := books.List(ctx, guest)
			if err != nil || len(listed) != 1 || !listed[0].JoinedByInvite {
				t.Fatalf("accepted seat cannot be rediscovered: %+v %v", listed, err)
			}
			ownerBooks, err := books.List(ctx, f.ownerAcct)
			if err != nil || len(ownerBooks) != 1 || ownerBooks[0].JoinedByInvite {
				t.Fatalf("owner advertised invite recovery: %+v %v", ownerBooks, err)
			}
			ownerJSON, _ := json.Marshal(ownerBooks[0])
			if strings.Contains(string(ownerJSON), "joined_by_invite") {
				t.Fatal("false discovery marker changed the legacy owner response")
			}
			if scenario.kind == "direct" {
				if _, err := books.CreateAccountInvite(ctx, vaults.CreateAccountInviteInput{VaultID: f.vaultID, InviterAccID: f.ownerAcct, TargetAccountID: guest, Role: scenario.role}); !errors.Is(err, vaults.ErrInviteAlreadyMember) {
					t.Fatalf("expected existing server seat: %v", err)
				}
			}
			witness, err := witnesses.IssueWitness(ctx, f.vaultID, guest, device)
			if err != nil || witness.MemberWitness == nil || witness.MemberWitness.Role != scenario.role || witness.MemberWitness.InviterAccountID != inviter {
				t.Fatalf("accepted invite lacks usable member witness: %+v %v", witness, err)
			}
			f.pms = witness.DeviceWitness.IssuedAtMS
			member := f.membershipEvent(EventVaultMemberAdded, device, guest, guest, map[string]any{
				"account_id": guest, "role": scenario.role, "witness": map[string]any{
					"sig_b64": witness.MemberWitness.SigB64, "issued_at_ms": witness.MemberWitness.IssuedAtMS,
					"inviter_account_id": witness.MemberWitness.InviterAccountID, "server_key_id": witness.ServerKeyID,
				},
			})
			binding := f.membershipEvent(EventVaultDeviceAdded, device, guest, guest, map[string]any{
				"account_id": guest, "device_id": device, "device_pubkey": base64.StdEncoding.EncodeToString(pub),
				"witness": map[string]any{"sig_b64": witness.DeviceWitness.SigB64, "issued_at_ms": witness.DeviceWitness.IssuedAtMS, "server_key_id": witness.ServerKeyID},
			})
			f.signEvent(t, &member, priv)
			f.signEvent(t, &binding, priv)
			pushed, err := f.svc.PushEvents(ctx, PushInput{AccountID: guest, VaultID: f.vaultID, DeviceID: device, Events: []PushEvent{member, binding}})
			if err != nil {
				t.Fatal(err)
			}
			requireAccepted(t, pushed, 2)
			pulled, err := f.svc.PullEvents(ctx, PullInput{AccountID: f.ownerAcct, VaultID: f.vaultID, Limit: 100})
			if err != nil {
				t.Fatal(err)
			}
			seen := map[string]bool{}
			for _, ev := range pulled.Events {
				if ev.EventID == member.EventID || ev.EventID == binding.EventID {
					seen[ev.EventID] = ev.EventSigB64 != nil && ev.SignerDevicePubkey != nil
				}
			}
			if !seen[member.EventID] || !seen[binding.EventID] {
				t.Fatalf("owner cannot pull the signed guest admission: %+v", seen)
			}
			if row := f.deviceRow(t, device); !row.exists || row.accountID != guest || row.removedAtMS != nil {
				t.Fatalf("guest device did not bind: %+v", row)
			}
			var seats int
			if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, guest).Scan(&seats); err != nil || seats != 1 {
				t.Fatalf("repair duplicated membership: %d %v", seats, err)
			}

			if scenario.name == "direct_owner" {
				if _, err := books.SetMemberRole(ctx, f.vaultID, f.ownerAcct, guest, "manager"); err != nil {
					t.Fatal(err)
				}
				w, err := witnesses.IssueWitness(ctx, f.vaultID, guest, device)
				if err != nil || w.MemberWitness != nil {
					t.Fatalf("direct marker granted manager admission: %+v %v", w, err)
				}
				listed, err := books.List(ctx, guest)
				if err != nil || len(listed) != 1 || listed[0].JoinedByInvite {
					t.Fatalf("manager advertised automatic invite recovery: %+v %v", listed, err)
				}
				f.pms = time.Now().UnixMilli()
				remove := f.membershipEvent(EventVaultDeviceRemoved, f.anchorDeviceID, f.ownerAcct, guest,
					map[string]any{"account_id": guest, "device_id": device})
				f.signEvent(t, &remove, f.anchorPriv)
				requireAccepted(t, f.pushAs(t, f.ownerAcct, remove), 1)
				if _, err := witnesses.IssueWitness(ctx, f.vaultID, guest, device); !errors.Is(err, mesh.ErrDeviceRemoved) {
					t.Fatalf("removed device got a witness: %v", err)
				}
				if _, err := books.RevokeMember(ctx, vaults.RevokeInput{VaultID: f.vaultID, CallerID: f.ownerAcct, TargetID: guest}); err != nil {
					t.Fatal(err)
				}
				if _, err := witnesses.IssueWitness(ctx, f.vaultID, guest, device); !errors.Is(err, mesh.ErrNotMember) {
					t.Fatalf("revoked member got a witness: %v", err)
				}
				if listed, err := books.List(ctx, guest); err != nil || len(listed) != 0 {
					t.Fatalf("revoked seat remained discoverable: %+v %v", listed, err)
				}
			}
		})
	}
}
