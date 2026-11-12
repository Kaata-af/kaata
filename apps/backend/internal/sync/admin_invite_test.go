package sync

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/admininvite"
	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/mesh"
	"github.com/matee/kaata-backend/internal/vaults"
)

func TestAdminInviteStableChainAndDeviceAdmission(t *testing.T) {
	f := newM2Fixture(t)
	ctx := t.Context()
	genesis := f.membershipEvent(EventVaultMemberAdded, f.anchorDeviceID, f.ownerAcct, f.ownerAcct, map[string]any{"account_id": f.ownerAcct, "role": "owner"})
	f.signEvent(t, &genesis, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, genesis), 1)
	bindOwner := f.membershipEvent(EventVaultDeviceAdded, f.anchorDeviceID, f.ownerAcct, f.ownerAcct, map[string]any{"account_id": f.ownerAcct, "device_id": f.anchorDeviceID, "device_pubkey": base64.StdEncoding.EncodeToString(f.anchorPub)})
	f.signEvent(t, &bindOwner, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, bindOwner), 1)
	guest := f.seedAccount(t, "admin@invitation.test")
	books := vaults.NewService(f.pool)
	books.SetMembershipInvalidator(f.svc)
	books.SetOwnershipSigner(f.serverPriv)
	stamp := max(time.Now().UnixMilli(), f.pms+1)
	g := admininvite.Grant{Domain: admininvite.Domain, GrantID: uuid.NewString(), VaultID: f.vaultID, FromAccountID: f.ownerAcct, RecipientAccountID: guest, Role: "manager", IssuedAtMS: stamp, ExpiresAtMS: stamp + admininvite.MaxLifetimeMS}
	message, _ := canonical.Canonicalize(g.Tuple())
	a := admininvite.Authorization{Grant: g, SignerDevicePubkey: base64.StdEncoding.EncodeToString(f.anchorPub), SigB64: base64.StdEncoding.EncodeToString(ed25519.Sign(f.anchorPriv, message))}
	request, err := books.CreateAccountInvite(ctx, vaults.CreateAccountInviteInput{VaultID: f.vaultID, InviterAccID: f.ownerAcct, TargetAccountID: guest, Role: "manager", AdminAuthorization: &a})
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := books.AcceptInvite(ctx, vaults.AcceptInviteInput{Token: request.InviteToken, AccountID: guest, AdminInviteVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	var event PushEvent
	event.EventType = EventVaultMemberAdded
	event.SchemaVersion = 1
	event.TargetID = &guest
	if err := f.pool.QueryRow(ctx, `SELECT event_id::text,hlc_physical_ms,hlc_logical,hlc_device_id::text,payload,event_sig_b64,signer_device_pubkey FROM events WHERE event_id=$1::uuid`, accepted.AdminInviteEventID).Scan(&event.EventID, &event.HLC.PhysicalMS, &event.HLC.Logical, &event.HLC.DeviceID, &event.Payload, &event.EventSigB64, &event.SignerDevicePubkeyB64); err != nil {
		t.Fatal(err)
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := f.svc.verifyMembershipEvent(ctx, tx, f.vaultID, guest, f.anchorPub, &event)
	_ = tx.Rollback(ctx)
	if err != nil || !ok {
		t.Fatalf("stable Admin proof rejected: %v %v", ok, err)
	}
	for _, kind := range []string{"new_event", "later_time", "different_author", "different_target"} {
		bad := event
		switch kind {
		case "new_event":
			bad.EventID = uuid.NewString()
		case "later_time":
			bad.HLC.PhysicalMS++
		case "different_author":
			bad.HLC.DeviceID = uuid.NewString()
		case "different_target":
			other := f.seedAccount(t, uuid.NewString()+"@test.af")
			bad.TargetID = &other
		}
		f.signEvent(t, &bad, f.serverPriv)
		requireRejectedUnverified(t, f.pushAs(t, f.ownerAcct, bad), bad.EventID)
	}
	keys := mesh.NewService(f.pool, f.serverPriv, base64.StdEncoding.EncodeToString(f.serverPub), "")
	device := uuid.NewString()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := f.pool.Exec(ctx, `INSERT INTO installs(install_id,account_id) VALUES($1::uuid,$2::uuid)`, device, guest); err != nil {
		t.Fatal(err)
	}
	if err := keys.RegisterKey(ctx, device, pub); err != nil {
		t.Fatal(err)
	}
	w, err := keys.IssueWitness(ctx, f.vaultID, guest, device)
	if err != nil || w.MemberWitness != nil {
		t.Fatalf("Admin received an ordinary member witness: %+v %v", w, err)
	}
	f.pms = max(time.Now().UnixMilli(), stamp+1)
	binding := f.membershipEvent(EventVaultDeviceAdded, device, guest, guest, map[string]any{"account_id": guest, "device_id": device, "device_pubkey": base64.StdEncoding.EncodeToString(pub), "witness": map[string]any{"sig_b64": w.DeviceWitness.SigB64, "issued_at_ms": w.DeviceWitness.IssuedAtMS, "server_key_id": w.ServerKeyID}})
	f.signEvent(t, &binding, priv)
	requireAccepted(t, f.pushAs(t, guest, binding), 1)
	if row := f.deviceRow(t, device); !row.exists || row.accountID != guest || row.removedAtMS != nil {
		t.Fatal("Admin device could not finish setup")
	}
	roleChange := f.membershipEvent(EventVaultMemberRoleChng, f.anchorDeviceID, f.ownerAcct, guest, map[string]any{"account_id": guest, "role": "viewer"})
	f.signEvent(t, &roleChange, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, roleChange), 1)
	// Re-announcing the original immutable identity can only be a duplicate.
	f.pushAs(t, f.ownerAcct, event)
	if f.memberRow(t, guest) != "viewer" {
		t.Fatal("old Admin admission undid later demotion")
	}
	var payload map[string]any
	if json.Unmarshal(event.Payload, &payload) != nil {
		t.Fatal("proof payload missing")
	}
}
