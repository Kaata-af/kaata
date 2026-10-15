package sync

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestArchiveSettingPayloadRequiresOwner(t *testing.T) {
	for _, value := range []string{`"1700000000000"`, `""`, `null`, `42`, `{}`} {
		required, ok := requiredRoleForPayload(EventVaultSettingSet, json.RawMessage(`{"key":"archived_at","value":`+value+`}`))
		if !ok || required != "owner" {
			t.Fatalf("archive value %s requires %q, want owner", value, required)
		}
	}
	for _, key := range []string{"name", "currency", "date_format"} {
		required, ok := requiredRoleForPayload(EventVaultSettingSet, json.RawMessage(`{"key":"`+key+`","value":"USD"}`))
		if !ok || required != "manager" {
			t.Fatalf("setting %s requires %q, want manager", key, required)
		}
	}
}

// Both ordinary uploads and signed anchored uploads use the payload-aware
// lawful-at-HLC gate before the setting can enter events or mirror to vaults.
func TestArchiveSettingPermissionAcrossUploadPaths(t *testing.T) {
	for _, signed := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "signed_chain"}[signed], func(t *testing.T) {
			f, manager, managerKey := newManagerFixture(t)
			editor := f.seedAccount(t, "editor-"+uuid.NewString()+"@shop.af")
			if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,invited_by)
			 VALUES($1::uuid,$2::uuid,'editor',NOW(),$3::uuid)`, f.vaultID, editor, f.ownerAcct); err != nil {
				t.Fatal(err)
			}
			if !signed {
				if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET vault_trust_anchor_pubkey=NULL WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
					t.Fatal(err)
				}
			}
			setting := func(actor, key, value string) PushEvent {
				ev := f.membershipEvent(EventVaultSettingSet, f.anchorDeviceID, actor, f.vaultID, map[string]any{"key": key, "value": value})
				if signed {
					if actor == f.ownerAcct {
						f.signEvent(t, &ev, f.anchorPriv)
					} else {
						f.signEvent(t, &ev, managerKey)
					}
				}
				return ev
			}
			for _, actor := range []string{manager, editor} {
				for _, value := range []string{"1700000000000", ""} {
					ev := setting(actor, "archived_at", value)
					got := f.pushAs(t, actor, ev)
					if len(got.Accepted) != 0 || len(got.Rejected) != 1 || got.Rejected[0].Reason != "insufficient_role" || got.Rejected[0].RequiredRole != "owner" {
						t.Fatalf("non-owner archive/unarchive accepted: %+v", got)
					}
					var recorded bool
					if err := f.pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM events WHERE event_id=$1::uuid)`, ev.EventID).Scan(&recorded); err != nil || recorded {
						t.Fatalf("refused archive entered history=%v err=%v", recorded, err)
					}
				}
			}
			// Daily settings keep manager authority under the same upload path.
			for _, item := range [][2]string{{"name", "Admin shop"}, {"currency", "USD"}} {
				got := f.pushAs(t, manager, setting(manager, item[0], item[1]))
				if len(got.Accepted) != 1 || len(got.Rejected) != 0 {
					t.Fatalf("admin %s failed: %+v", item[0], got)
				}
			}
			for _, value := range []string{"1700000000000", ""} {
				got := f.pushAs(t, f.ownerAcct, setting(f.ownerAcct, "archived_at", value))
				if len(got.Accepted) != 1 || len(got.Rejected) != 0 {
					t.Fatalf("owner archive/unarchive failed: %+v", got)
				}
				var archived bool
				if err := f.pool.QueryRow(t.Context(), `SELECT archived_at IS NOT NULL FROM vaults WHERE vault_id=$1::uuid`, f.vaultID).Scan(&archived); err != nil || archived != (value != "") {
					t.Fatalf("archive mirror=%v value=%q err=%v", archived, value, err)
				}
			}
		})
	}
}
