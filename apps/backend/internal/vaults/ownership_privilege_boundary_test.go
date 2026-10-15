package vaults

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/db"
	"github.com/matee/kaata-backend/internal/ownership"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func (f *ownershipFixture) signedPush(t *testing.T, kind, target string, payload map[string]any, stamp int64, relationship ...string) syncapi.PushEvent {
	t.Helper()
	id := uuid.NewString()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var relationshipID *string
	var relWire any
	if len(relationship) > 0 {
		relationshipID = &relationship[0]
		relWire = relationship[0]
	}
	signable, err := canonical.Canonicalize(map[string]any{"actor_account_id": f.owner, "device_id": f.device, "event_id": id, "event_type": kind, "hlc": map[string]any{"did": f.device, "l": 0, "pms": stamp}, "payload": payload, "payload_schema": 1, "relationship_id": relWire, "target_id": target, "vault_id": f.vault})
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(f.ownerPriv, signable))
	pub := base64.StdEncoding.EncodeToString(f.ownerPub)
	return syncapi.PushEvent{EventID: id, HLC: syncapi.PushHLC{PhysicalMS: stamp, DeviceID: f.device}, EventType: kind, SchemaVersion: 1, TargetID: &target, RelationshipID: relationshipID, ActorAccountID: &f.owner, Payload: raw, EventSigB64: &sig, SignerDevicePubkeyB64: &pub}
}

func TestOwnershipBoundaryPreservesStoredMembershipAndLawfulOfflineTallies(t *testing.T) {
	f := newOwnershipFixture(t, false)
	ctx := t.Context()
	svc := syncapi.NewService(f.pool)
	svc.SetWitnessPubkeys([]ed25519.PublicKey{f.serverPriv.Public().(ed25519.PublicKey)})
	// Capture the exact stored genesis envelope, including its signed null actor.
	var genesis syncapi.PushEvent
	genesis.EventType = "vault_member_added"
	genesis.SchemaVersion = 1
	genesis.TargetID = &f.owner
	if err := f.pool.QueryRow(ctx, `SELECT event_id::text,hlc_physical_ms,hlc_logical,hlc_device_id::text,payload,event_sig_b64,signer_device_pubkey FROM events WHERE vault_id=$1::uuid ORDER BY server_seq LIMIT 1`, f.vault).Scan(&genesis.EventID, &genesis.HLC.PhysicalMS, &genesis.HLC.Logical, &genesis.HLC.DeviceID, &genesis.Payload, &genesis.EventSigB64, &genesis.SignerDevicePubkeyB64); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO vault_audit_log(vault_id,kind,target_id,payload,occurred_at)VALUES($1::uuid,'invite_accepted',$2::uuid,'{"role":"owner"}'::jsonb,to_timestamp(0.001))`, f.vault, f.owner); err != nil {
		t.Fatal(err)
	}
	rel, person := uuid.NewString(), uuid.NewString()
	contact := f.signedPush(t, "person_added", person, map[string]any{"user_id": person, "name": "Offline customer", "phone_e164": nil, "relationship_context": "peer"}, 2, rel)
	first, err := svc.PushEvents(ctx, syncapi.PushInput{AccountID: f.owner, VaultID: f.vault, DeviceID: f.device, Events: []syncapi.PushEvent{contact}})
	if err != nil || len(first.Accepted) != 1 {
		t.Fatalf("contact %+v %v", first, err)
	}
	token := f.create(t)
	if _, err = f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: token, AccountID: f.to}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.SetMemberRole(ctx, f.vault, f.to, f.owner, "viewer"); err != nil {
		t.Fatal(err)
	}
	svc.InvalidateMembership(f.vault, f.owner)
	entry := uuid.NewString()
	offline := f.signedPush(t, "entry_created", entry, map[string]any{"entry_id": entry, "relationship_id": rel, "type": "debt", "amount_afn": 125, "note": "Queued before handover"}, 3, rel)
	result, err := svc.PushEvents(ctx, syncapi.PushInput{AccountID: f.owner, VaultID: f.vault, DeviceID: f.device, Events: []syncapi.PushEvent{genesis, offline}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Accepted) != 1 || result.Accepted[0].EventID != offline.EventID || len(result.Duplicates) != 1 || result.Duplicates[0] != genesis.EventID || len(result.Rejected) != 0 {
		t.Fatalf("handover blocked original history: %+v", result)
	}
	if f.count(t, `SELECT COUNT(*) FROM events WHERE event_id=$1::uuid`, offline.EventID) != 1 || f.count(t, `SELECT COUNT(*) FROM vault_members WHERE account_id=$1::uuid AND role='viewer'`, f.owner) != 1 {
		t.Fatal("lawful history changed current authority")
	}
}

func TestOwnershipHandoverRejectsBackdatedPrivilegedSettings(t *testing.T) {
	for _, kind := range []string{"archive", "normal setting", "shop profile"} {
		t.Run(kind, func(t *testing.T) {
			f := newOwnershipFixture(t, false)
			ctx := t.Context()
			if _, err := f.pool.Exec(ctx, `INSERT INTO vault_audit_log(vault_id,kind,target_id,payload,occurred_at)VALUES($1::uuid,'invite_accepted',$2::uuid,'{"role":"owner"}'::jsonb,to_timestamp(0.001))`, f.vault, f.owner); err != nil {
				t.Fatal(err)
			}
			token := f.create(t)
			if _, err := f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: token, AccountID: f.to}); err != nil {
				t.Fatal(err)
			}
			eventType := "vault_setting_set"
			payload := map[string]any{"key": "archived_at", "value": 123}
			if kind == "normal setting" {
				payload = map[string]any{"key": "name", "value": "Forged name"}
			}
			if kind == "shop profile" {
				eventType = "shop_profile_updated"
				payload = map[string]any{"shop_name": "Forged name"}
			}
			attack := f.signedPush(t, eventType, uuid.NewString(), payload, 3)
			svc := syncapi.NewService(f.pool)
			out, err := svc.PushEvents(ctx, syncapi.PushInput{AccountID: f.owner, VaultID: f.vault, DeviceID: f.device, Events: []syncapi.PushEvent{attack}})
			if err != nil {
				t.Fatal(err)
			}
			if len(out.Accepted) != 0 || len(out.Rejected) != 1 {
				t.Fatalf("former owner backdated privileged setting accepted: %+v", out)
			}
		})
	}
}

func TestDirectChainHandoverUpdatesOwnerAndFormerOwnerPurgePreservesBook(t *testing.T) {
	for _, local := range []bool{false, true} {
		t.Run(map[bool]string{false: "UUID owner", true: "original local alias owner"}[local], func(t *testing.T) {
			f := newOwnershipFixture(t, local)
			ctx := t.Context()
			if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,last_change_hlc_ms)VALUES($1::uuid,$2::uuid,'editor',NOW(),2)`, f.vault, f.to); err != nil {
				t.Fatal(err)
			}
			f.seedMemberEvent(t, "vault_member_added", f.to, "editor", 2)
			promote := f.signedPush(t, "vault_member_role_changed", f.to, map[string]any{"account_id": f.to, "role": "owner"}, 3)
			demote := f.signedPush(t, "vault_member_role_changed", f.chainOwner, map[string]any{"account_id": f.chainOwner, "role": "editor"}, 4)
			svc := syncapi.NewService(f.pool)
			svc.SetWitnessPubkeys([]ed25519.PublicKey{f.serverPriv.Public().(ed25519.PublicKey)})
			out, err := svc.PushEvents(ctx, syncapi.PushInput{AccountID: f.owner, VaultID: f.vault, DeviceID: f.device, Events: []syncapi.PushEvent{promote, demote}})
			if err != nil || len(out.Accepted) != 2 {
				t.Fatalf("direct handover %+v %v", out, err)
			}
			if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, f.vault, f.to) != 1 {
				t.Fatal("direct chain handover left canonical owner at former founder")
			}
			if f.count(t, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND role='editor' AND revoked_at IS NULL`, f.vault, f.owner) != 1 {
				t.Fatal("direct handover left actual former owner privileged")
			}
			pub, priv, _ := ed25519.GenerateKey(nil)
			device := uuid.NewString()
			if _, err = f.pool.Exec(ctx, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms)VALUES($1::uuid,$2::uuid,$3,$4::uuid,2)`, f.vault, device, []byte(pub), f.to); err != nil {
				t.Fatal(err)
			}
			now := time.Now().UnixMilli()
			a := signOwnershipGrant(t, ownership.Grant{Domain: ownership.GrantDomain, TransferID: uuid.NewString(), VaultID: f.vault, FromAccountID: f.to, RecipientEmailNormalized: "outsider@example.com", DemoteSelfTo: "editor", IssuedAtMS: now, ExpiresAtMS: now + ownership.MaxGrantLifetimeMS}, priv)
			invitation, err := f.svc.CreateOwnershipInvite(ctx, CreateOwnershipInviteInput{AccountID: f.to, VaultID: f.vault, Authorization: a})
			if err != nil {
				t.Fatalf("new direct owner cannot invite successor: %v", err)
			}
			events := f.count(t, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vault)
			if err = auth.NewService(f.pool, "", "").DeleteAccount(ctx, f.owner); err != nil {
				t.Fatal(err)
			}
			if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, f.vault, f.to) != 1 || f.count(t, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vault) != events {
				t.Fatal("former founder account purge deleted transferred book or history")
			}
			if _, err = f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: strings.TrimPrefix(invitation.InviteURL, "https://kaata.af/i/"), AccountID: f.other}); err != nil {
				t.Fatalf("successor offer broke after former founder purge: %v", err)
			}
		})
	}
}

func TestOwnershipCanonicalPointerMigrationRepairsOnlyStaleOwners(t *testing.T) {
	f := newOwnershipFixture(t, false)
	ctx := t.Context()
	control, ownerless := uuid.NewString(), uuid.NewString()
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.owner); err != nil {
		t.Fatal(err)
	}
	for _, seat := range []struct {
		account string
		stamp   int64
	}{{f.to, 10}, {f.other, 20}} {
		if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,last_change_hlc_ms)VALUES($1::uuid,$2::uuid,'owner',NOW(),$3)`, f.vault, seat.account, seat.stamp); err != nil {
			t.Fatal(err)
		}
	}
	for _, vault := range []string{control, ownerless} {
		if _, err := f.pool.Exec(ctx, `INSERT INTO vaults(vault_id,owner_account_id,name)VALUES($1::uuid,$2::uuid,'Control')`, vault, f.owner); err != nil {
			t.Fatal(err)
		}
	}
	for _, seat := range []struct {
		account string
		stamp   int64
	}{{f.owner, 1}, {f.to, 30}} {
		if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,last_change_hlc_ms)VALUES($1::uuid,$2::uuid,'owner',NOW(),$3)`, control, seat.account, seat.stamp); err != nil {
			t.Fatal(err)
		}
	}
	// Recreate precisely the pre-064 schema boundary on this disposable fixture.
	if _, err := f.pool.Exec(ctx, `DROP TABLE vault_ownership_invites; DELETE FROM schema_migrations WHERE name='064_ownership_transfer_invites.sql'`); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, f.pool); err != nil {
		t.Fatal(err)
	}
	if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, f.vault, f.other) != 1 {
		t.Fatal("migration did not choose most recently promoted active owner")
	}
	if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id IN($1::uuid,$2::uuid) AND owner_account_id=$3::uuid`, control, ownerless, f.owner) != 2 {
		t.Fatal("migration changed valid or ownerless control")
	}
	if err := auth.NewService(f.pool, "", "").DeleteAccount(ctx, f.owner); err != nil {
		t.Fatal(err)
	}
	if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, f.vault, f.other) != 1 || f.count(t, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vault) != 1 {
		t.Fatal("repaired transferred book lost on former owner's purge")
	}
}

func TestRESTOwnerDemotionLeaveAndRevocationRepairCanonicalPointer(t *testing.T) {
	for _, action := range []string{"demote", "leave", "revoke"} {
		t.Run(action, func(t *testing.T) {
			f := newOwnershipFixture(t, false)
			ctx := t.Context()
			if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,last_change_hlc_ms)VALUES($1::uuid,$2::uuid,'owner',NOW(),2)`, f.vault, f.to); err != nil {
				t.Fatal(err)
			}
			var err error
			switch action {
			case "demote":
				_, err = f.svc.SetMemberRole(ctx, f.vault, f.to, f.owner, "editor")
			case "leave":
				_, err = f.svc.Leave(ctx, f.vault, f.owner)
			case "revoke":
				_, err = f.svc.RevokeMember(ctx, RevokeInput{VaultID: f.vault, CallerID: f.to, TargetID: f.owner})
			}
			if err != nil {
				t.Fatal(err)
			}
			if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, f.vault, f.to) != 1 {
				t.Fatal("REST membership mutation left a stale canonical owner")
			}
		})
	}
}

func TestOwnershipMigrationRepairsCorroboratedHistoricalLocalAliasHandover(t *testing.T) {
	for _, scenario := range []string{"corroborated old transfer", "missing registered key", "later actual UUID owner grant", "later alias owner grant"} {
		t.Run(scenario, func(t *testing.T) {
			f := newOwnershipFixture(t, true)
			ctx := t.Context()
			if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,last_change_hlc_ms)VALUES($1::uuid,$2::uuid,'owner',NOW(),3)`, f.vault, f.to); err != nil {
				t.Fatal(err)
			}
			f.seedMemberEvent(t, "vault_member_added", f.to, "editor", 2)
			f.seedMemberEvent(t, "vault_member_role_changed", f.to, "owner", 3)
			f.seedMemberEvent(t, "vault_member_role_changed", f.chainOwner, "editor", 4)
			switch scenario {
			case "missing registered key":
				if _, err := f.pool.Exec(ctx, `DELETE FROM device_keys`); err != nil {
					t.Fatal(err)
				}
			case "later actual UUID owner grant":
				f.seedMemberEvent(t, "vault_member_role_changed", f.owner, "owner", 5)
			case "later alias owner grant":
				f.seedMemberEvent(t, "vault_member_role_changed", f.chainOwner, "owner", 5)
			}
			if _, err := f.pool.Exec(ctx, `DROP TABLE vault_ownership_invites;DELETE FROM schema_migrations WHERE name='064_ownership_transfer_invites.sql'`); err != nil {
				t.Fatal(err)
			}
			if err := db.Migrate(ctx, f.pool); err != nil {
				t.Fatal(err)
			}
			expectedRole, expectedOwner := "owner", f.owner
			if scenario == "corroborated old transfer" {
				expectedRole = "editor"
				expectedOwner = f.to
			}
			if f.count(t, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND role=$3 AND revoked_at IS NULL`, f.vault, f.owner, expectedRole) != 1 || f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, f.vault, expectedOwner) != 1 {
				t.Fatal("legacy alias repair did not preserve strictly corroborated boundaries")
			}
			if scenario == "corroborated old transfer" {
				events := f.count(t, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vault)
				if err := auth.NewService(f.pool, "", "").DeleteAccount(ctx, f.owner); err != nil {
					t.Fatal(err)
				}
				if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, f.vault, f.to) != 1 || f.count(t, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vault) != events {
					t.Fatal("repaired historical alias handover lost on former founder purge")
				}
			}
		})
	}
}

func TestOwnershipHandoverRejectsNewBackdatedPrivilegedMembership(t *testing.T) {
	for _, kind := range []string{"new owner", "new admin", "promote untouched editor", "remove untouched editor"} {
		t.Run(kind, func(t *testing.T) {
			f := newOwnershipFixture(t, false)
			ctx := t.Context()
			if kind == "promote untouched editor" || kind == "remove untouched editor" {
				if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,last_change_hlc_ms)VALUES($1::uuid,$2::uuid,'editor',NOW(),2)`, f.vault, f.other); err != nil {
					t.Fatal(err)
				}
				f.seedMemberEvent(t, "vault_member_added", f.other, "editor", 2)
			}
			token := f.create(t)
			if _, err := f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: token, AccountID: f.to}); err != nil {
				t.Fatal(err)
			}
			eventType := "vault_member_added"
			role := "owner"
			if kind == "new admin" {
				role = "manager"
			}
			if kind == "promote untouched editor" {
				eventType = "vault_member_role_changed"
			}
			if kind == "remove untouched editor" {
				eventType = "vault_member_removed"
			}
			payload := map[string]any{"account_id": f.other}
			if eventType != "vault_member_removed" {
				payload["role"] = role
			}
			attack := f.signedPush(t, eventType, f.other, payload, 3)
			svc := syncapi.NewService(f.pool)
			svc.SetWitnessPubkeys([]ed25519.PublicKey{f.serverPriv.Public().(ed25519.PublicKey)})
			out, err := svc.PushEvents(ctx, syncapi.PushInput{AccountID: f.owner, VaultID: f.vault, DeviceID: f.device, Events: []syncapi.PushEvent{attack}})
			if err != nil {
				t.Fatal(err)
			}
			if len(out.Accepted) != 0 || len(out.Rejected) != 1 {
				t.Fatalf("former owner's new backdated control mutation accepted: %+v", out)
			}
			if f.count(t, `SELECT COUNT(*) FROM events WHERE event_id=$1::uuid`, attack.EventID) != 0 {
				t.Fatal("refused backdated event persisted")
			}
			if kind == "promote untouched editor" || kind == "remove untouched editor" {
				if f.count(t, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND role='editor' AND revoked_at IS NULL`, f.vault, f.other) != 1 {
					t.Fatal("untouched member authority changed")
				}
			} else if f.count(t, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.other) != 0 {
				t.Fatal("new backdated membership materialized")
			}
		})
	}
}
