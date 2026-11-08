package sync

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestTallyNoteRolesAndPayload(t *testing.T) {
	for _, role := range []string{"viewer", "clerk", "editor", "manager", "owner"} {
		if !CheckEventPermissionByRole(role, EventTallyNoteAdded) ||
			CheckEventPermissionByRole(role, EventTallyNoteRemoved) != (role == "manager" || role == "owner") {
			t.Fatalf("unexpected note authority for %s", role)
		}
	}
	if CheckEventPermissionByRole("viewer", EventEntryCreated) || CheckEventPermissionByRole("viewer", EventPersonNoteSet) {
		t.Fatal("viewer received financial or contact-profile authority")
	}
	id, rel := uuid.NewString(), uuid.NewString()
	ev := PushEvent{EventType: EventTallyNoteAdded, EventID: id, TargetID: &id, RelationshipID: &rel,
		SchemaVersion: 1, HLC: PushHLC{DeviceID: uuid.NewString()}}
	for _, item := range []struct {
		payload string
		valid   bool
	}{
		{`{"note":"` + strings.Repeat("💬", 500) + `"}`, true},
		{`{"note":"` + strings.Repeat("💬", 501) + `"}`, false},
		{`{"note":"I took 500 from Amin.\nPlease record it."}`, true},
		{`{"note":""}`, false},
		{`{"note":"\u0085 spaces"}`, false},
		{`{"note":"x\u0000y"}`, false},
		{`{"note":"check this","amount_afn":500}`, false},
		{`{"note":null}`, false},
		{`[]`, false},
	} {
		ev.Payload = json.RawMessage(item.payload)
		if _, ok := normalizeTallyNote(&ev); ok != item.valid {
			t.Fatalf("unexpected validity for %q", item.payload)
		}
	}
	ev.EventType = EventTallyNoteRemoved
	ev.EventID = uuid.NewString()
	ev.Payload = json.RawMessage(`{}`)
	if _, ok := normalizeTallyNote(&ev); !ok {
		t.Fatal("rejected empty removal payload")
	}
	ev.Payload = json.RawMessage(`{"note":"rewritten"}`)
	if _, ok := normalizeTallyNote(&ev); ok {
		t.Fatal("accepted a removal that also changes note text")
	}
}

func TestTallyNotePushRecoveryAndRoleBoundaries(t *testing.T) {
	f := newM2Fixture(t)
	ctx := t.Context()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := f.pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	viewer := f.seedAccount(t, "viewer-note@example.test")
	manager := f.seedAccount(t, "manager-note@example.test")
	outsider := f.seedAccount(t, "outsider-note@example.test")
	viewerDevice, managerDevice := uuid.NewString(), uuid.NewString()
	viewerKey, viewerPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	managerKey, managerPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1,$2,'viewer',NOW()),($1,$3,'manager',NOW())`, f.vaultID, viewer, manager)
	// A legacy book can authenticate a viewer via the account's registered
	// installation, while the manager below uses the vault's chain binding.
	exec(`INSERT INTO installs(install_id,account_id) VALUES($1,$2)`, viewerDevice, viewer)
	exec(`INSERT INTO device_keys(install_id,ed25519_pubkey) VALUES($1,$2)`, viewerDevice, []byte(viewerKey))
	exec(`INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms) VALUES($1,$2,$3,$4,$5)`, f.vaultID, managerDevice, []byte(managerKey), manager, f.pms)
	rel, personID := uuid.NewString(), uuid.NewString()
	person := f.membershipEvent(EventPersonAdded, f.anchorDeviceID, f.ownerAcct, personID, map[string]any{"user_id": personID, "name": "Amin"})
	person.RelationshipID = &rel
	requireAccepted(t, f.pushAs(t, f.ownerAcct, person), 1)
	newNote := func(contact string) PushEvent {
		ev := f.membershipEvent(EventTallyNoteAdded, viewerDevice, viewer, "", map[string]any{"note": "I took 500 from Amin 💬"})
		ev.TargetID = &ev.EventID
		ev.RelationshipID = &contact
		f.signEvent(t, &ev, viewerPriv)
		return ev
	}
	added := newNote(rel)
	missingContact := newNote(uuid.NewString())
	requireRejectedReason(t, f.pushAs(t, viewer, missingContact), missingContact.EventID, "tally_note_contact_unavailable")
	entry := f.membershipEvent(EventEntryCreated, viewerDevice, viewer, uuid.NewString(), map[string]any{"amount_afn": 500})
	entry.RelationshipID = &rel
	requireRejectedReason(t, f.pushAs(t, viewer, entry), entry.EventID, "insufficient_role")
	newRemoval := func(device, author string, key ed25519.PrivateKey) PushEvent {
		ev := f.membershipEvent(EventTallyNoteRemoved, device, author, added.EventID, map[string]any{})
		ev.RelationshipID = &rel
		f.signEvent(t, &ev, key)
		return ev
	}
	viewerDelete := newRemoval(viewerDevice, viewer, viewerPriv)
	requireRejectedReason(t, f.pushAs(t, viewer, viewerDelete), viewerDelete.EventID, "insufficient_role")
	pushRelay := func(event PushEvent) *PushResponse {
		t.Helper()
		rec := pushHTTP(t, f, viewer, event)
		var response PushResponse
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &response) != nil {
			t.Fatalf("relay response: %d %s", rec.Code, rec.Body.String())
		}
		return &response
	}
	forgedDelete := newRemoval(viewerDevice, manager, viewerPriv)
	requireRejectedReason(t, pushRelay(forgedDelete), forgedDelete.EventID, RejectReasonMembershipUnverified)
	validDelete := newRemoval(managerDevice, manager, managerPriv)
	requireAccepted(t, pushRelay(validDelete), 1)     // Mesh relay of a manager's signature.
	requireAccepted(t, f.pushAs(t, viewer, added), 1) // Arrives after deletion.

	page, err := f.svc.noteHistoryEvents(ctx, viewer, f.vaultID, tallyNoteFilter, 0, 1)
	if err != nil || len(page.Events) != 1 || !page.HasMore || page.Events[0].EventID != validDelete.EventID {
		t.Fatalf("removal page: %+v %v", page, err)
	}
	page, err = f.svc.noteHistoryEvents(ctx, viewer, f.vaultID, tallyNoteFilter, page.NextAfterServerSeq, 1)
	if err != nil || len(page.Events) != 1 || page.HasMore || page.Events[0].EventID != added.EventID ||
		page.Events[0].EventSigB64 == nil || *page.Events[0].EventSigB64 != *added.EventSigB64 {
		t.Fatalf("creation page: %+v %v", page, err)
	}
	if _, err := f.svc.noteHistoryEvents(ctx, outsider, f.vaultID, tallyNoteFilter, 0, 10); !errors.Is(err, ErrNotMember) {
		t.Fatalf("outsider access: %v", err)
	}
	if err := generateSnapshotForVault(ctx, f.pool, snapshotCandidate{vaultID: f.vaultID}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.svc.LatestSnapshot(ctx, f.vaultID)
	if err != nil || len(snapshot.Entries) != 0 || len(snapshot.TallyNoteEvents) != 2 || len(snapshot.Events) != 0 {
		t.Fatalf("snapshot lost signed notes or created a financial row: %+v %v", snapshot, err)
	}
	if snapshot.TallyNoteEvents[0].EventID != added.EventID || snapshot.TallyNoteEvents[1].EventID != validDelete.EventID {
		t.Fatalf("snapshot did not preserve HLC-ordered note history: %+v", snapshot.TallyNoteEvents)
	}
	exec(`UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1 AND account_id=$2`, f.vaultID, viewer)
	if _, err := f.svc.noteHistoryEvents(ctx, viewer, f.vaultID, tallyNoteFilter, 0, 10); !errors.Is(err, ErrNotMember) {
		t.Fatalf("revoked viewer read: %v", err)
	}
	afterRevocation := newNote(rel)
	requireRejectedReason(t, f.pushAs(t, manager, afterRevocation), afterRevocation.EventID, "insufficient_role")
	removedDevice := newRemoval(managerDevice, manager, managerPriv)
	exec(`UPDATE vault_devices SET removed_at_ms=$3 WHERE vault_id=$1 AND device_id=$2`, f.vaultID, managerDevice, f.pms+1)
	requireRejectedReason(t, f.pushAs(t, manager, removedDevice), removedDevice.EventID, RejectReasonMembershipUnverified)
}

func TestTallyNoteCanBePreSignInHistoryCutoff(t *testing.T) {
	f := newM2Fixture(t)
	rel, personID := uuid.NewString(), uuid.NewString()
	person := f.membershipEvent(EventPersonAdded, f.anchorDeviceID, "", personID, map[string]any{"user_id": personID, "name": "Amin"})
	person.RelationshipID = &rel
	f.signEvent(t, &person, f.anchorPriv)
	note := f.membershipEvent(EventTallyNoteAdded, f.anchorDeviceID, "", "", map[string]any{"note": "Check the delivery"})
	note.TargetID, note.RelationshipID = &note.EventID, &rel
	f.signEvent(t, &note, f.anchorPriv)
	binding := f.membershipEvent(EventAccountBound, f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{
		"account_id": f.ownerAcct, "retroactive_through_event_id": note.EventID, "from_user_id": uuid.NewString(),
	})
	f.signEvent(t, &binding, f.anchorPriv)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms) VALUES($1,$2,$3,$4,$5)`, f.vaultID, f.anchorDeviceID, []byte(f.anchorPub), f.ownerAcct, binding.HLC.PhysicalMS); err != nil {
		t.Fatal(err)
	}
	requireAccepted(t, f.pushAs(t, f.ownerAcct, binding), 1)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, note), 1)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, person), 1)
	page, err := f.svc.noteHistoryEvents(t.Context(), f.ownerAcct, f.vaultID, tallyNoteFilter, 0, 10)
	if err != nil || len(page.Events) != 1 || page.Events[0].AccountID != nil || page.Events[0].EventID != note.EventID {
		t.Fatalf("Ninja note's nullable author was not preserved: %+v %v", page, err)
	}
}
