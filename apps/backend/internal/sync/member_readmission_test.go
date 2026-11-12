package sync

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/mesh"
	"github.com/matee/kaata-backend/internal/vaults"
)

func TestOwnerReadmissionPublishesOnlyTheConsentingDeviceAtomically(t *testing.T) {
	f := newM2Fixture(t)
	ctx := t.Context()
	books := vaults.NewService(f.pool)
	books.SetMembershipInvalidator(f.svc)
	keys := mesh.NewService(f.pool, f.serverPriv, base64.StdEncoding.EncodeToString(f.serverPub), "")
	guest := f.seedAccount(t, "returning-member@example.test")
	guestDevice, otherDevice := uuid.NewString(), uuid.NewString()
	guestPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	otherPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	register := func(account, device string, pub ed25519.PublicKey) {
		t.Helper()
		if _, err := f.pool.Exec(ctx, `INSERT INTO installs(install_id,account_id) VALUES($1::uuid,$2::uuid)`, device, account); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(ctx, `INSERT INTO auth_credentials(install_id,account_id,provider,provider_sub)
		 SELECT $1::uuid,id,'google',google_sub FROM accounts WHERE id=$2::uuid`, device, account); err != nil {
			t.Fatal(err)
		}
		if err := keys.RegisterKey(ctx, device, pub); err != nil {
			t.Fatal(err)
		}
	}
	register(f.ownerAcct, f.anchorDeviceID, f.anchorPub)
	register(guest, guestDevice, guestPub)
	register(guest, otherDevice, otherPub)
	ownerEvent := func(eventType, target string, payload map[string]any) PushEvent {
		event := f.membershipEvent(eventType, f.anchorDeviceID, f.ownerAcct, target, payload)
		f.signEvent(t, &event, f.anchorPriv)
		return event
	}
	requireAccepted(t, f.pushAs(t, f.ownerAcct, ownerEvent(EventVaultMemberAdded, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "role": "owner"})), 1)
	issue := vaults.CreateAccountInviteInput{VaultID: f.vaultID, InviterAccID: f.ownerAcct, TargetAccountID: guest, Role: "editor"}
	oldInvite, err := books.CreateAccountInvite(ctx, issue)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := books.AcceptInvite(ctx, vaults.AcceptInviteInput{Token: oldInvite.InviteToken, AccountID: guest, InstallID: guestDevice}); err != nil {
		t.Fatal(err)
	}
	f.pms = max(f.pms, time.Now().UnixMilli())
	devicePayload := func(id string, pub ed25519.PublicKey) map[string]any {
		return map[string]any{"account_id": guest, "device_id": id, "device_pubkey": base64.StdEncoding.EncodeToString(pub)}
	}
	requireAccepted(t, f.pushAs(t, f.ownerAcct,
		ownerEvent(EventVaultMemberAdded, guest, map[string]any{"account_id": guest, "role": "editor"}),
		ownerEvent(EventVaultDeviceAdded, guestDevice, devicePayload(guestDevice, guestPub)),
		ownerEvent(EventVaultDeviceAdded, otherDevice, devicePayload(otherDevice, otherPub))), 3)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, ownerEvent(EventVaultMemberRemoved, guest,
		map[string]any{"account_id": guest})), 1)

	issue.Role, issue.ReadmitRemoved = "clerk", true
	returnInvite, err := books.CreateAccountInvite(ctx, issue)
	if err != nil || returnInvite.InviteID == oldInvite.InviteID {
		t.Fatalf("new invite: %+v, %v", returnInvite, err)
	}
	consent := vaults.AcceptInviteInput{Token: returnInvite.InviteToken, AccountID: guest, InstallID: guestDevice, MemberReadmission: true}
	checkNotices := func(want int) {
		t.Helper()
		var got int
		if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind='vault_invite_accepted' AND source_id=$1::uuid`, returnInvite.InviteID).Scan(&got); err != nil || got != want {
			t.Fatalf("completed readmission notifications = %d, want %d: %v", got, want, err)
		}
	}
	result, err := books.AcceptInvite(ctx, consent)
	if err != nil || !result.ReadmissionPending || f.memberRow(t, guest) != "" {
		t.Fatalf("consent granted access prematurely: %+v, %v", result, err)
	}
	checkNotices(0)
	ready, err := books.ListMemberReadmissions(ctx, f.vaultID, f.ownerAcct)
	if err != nil || len(ready) != 1 || ready[0].DeviceID != guestDevice {
		t.Fatalf("owner requests: %+v, %v", ready, err)
	}
	member := ownerEvent(EventVaultMemberAdded, guest, map[string]any{
		"account_id": guest, "role": "clerk", readmissionIDField: returnInvite.InviteID,
	})
	payload := devicePayload(guestDevice, guestPub)
	payload[readmissionIDField] = returnInvite.InviteID
	device := ownerEvent(EventVaultDeviceAdded, guestDevice, payload)
	member.HLC.PhysicalMS = ready[0].AfterMS + 1
	device.HLC.PhysicalMS, device.HLC.Logical = member.HLC.PhysicalMS, 1
	f.signEvent(t, &member, f.anchorPriv)
	f.signEvent(t, &device, f.anchorPriv)
	if ordinary := f.pushAs(t, f.ownerAcct, member, device); len(ordinary.Rejected) != 2 {
		t.Fatalf("ordinary push bypassed the return transaction: %+v", ordinary)
	}
	approval := PushInput{AccountID: f.ownerAcct, VaultID: f.vaultID, DeviceID: f.anchorDeviceID,
		Session:             &auth.SessionClaims{AccountID: f.ownerAcct, InstallID: f.anchorDeviceID},
		ReadmissionInviteID: returnInvite.InviteID, Events: []PushEvent{member, device}}
	brokenDevice := device
	brokenDevice.EventSigB64 = member.EventSigB64
	approval.Events[1] = brokenDevice
	if _, err := f.svc.PushEvents(ctx, approval); !errors.Is(err, ErrMemberReadmissionConflict) {
		t.Fatalf("bad device signature did not roll back pair: %v", err)
	}
	if f.memberRow(t, guest) != "" || f.deviceRow(t, guestDevice).removedAtMS == nil {
		t.Fatal("failed pair restored access")
	}
	checkNotices(0)
	approval.Events[1] = device
	response, err := f.svc.PushEvents(ctx, approval)
	if err != nil {
		t.Fatal(err)
	}
	requireAccepted(t, response, 2)
	checkNotices(1)
	if f.memberRow(t, guest) != "clerk" || f.deviceRow(t, guestDevice).removedAtMS != nil || f.deviceRow(t, otherDevice).removedAtMS == nil {
		t.Fatal("approval restored the wrong role or device")
	}
	if err := checkReadmittedDevice(ctx, f.pool, f.vaultID, guest, guestDevice); err != nil {
		t.Fatalf("restored device could not sync: %v", err)
	}
	if err := checkReadmittedDevice(ctx, f.pool, f.vaultID, guest, otherDevice); !errors.Is(err, errReadmittedDeviceRetired) {
		t.Fatalf("retired device could sync: %v", err)
	}
	if witness, err := keys.IssueWitness(ctx, f.vaultID, guest, guestDevice); err != nil || witness.MemberWitness != nil {
		t.Fatalf("owner-signed return requested a redundant member witness: %v", err)
	}
	if _, err := keys.IssueWitness(ctx, f.vaultID, guest, otherDevice); !errors.Is(err, mesh.ErrDeviceRemoved) {
		t.Fatalf("retired device received a witness: %v", err)
	}
	result, err = books.AcceptInvite(ctx, consent)
	if err != nil || result.ReadmissionPending || result.ReadmissionMemberEventID != member.EventID || result.ReadmissionDeviceEventID != device.EventID {
		t.Fatalf("completed retry did not report the committed pair: %+v, %v", result, err)
	}
	checkNotices(1)
	if _, err := books.AcceptInvite(ctx, vaults.AcceptInviteInput{Token: oldInvite.InviteToken, AccountID: guest, InstallID: guestDevice}); !errors.Is(err, vaults.ErrInviteNotFound) {
		t.Fatalf("old token resumed after removal: %v", err)
	}
}
