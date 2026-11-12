package auth

import (
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestPersonProfileActivityScopesAndSeparatesRequests(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, "", emailTestSecret)
	viewer := seedGoogleAccount(t, pool, "profile-owner@example.test", uuid.NewString())
	peer := seedGoogleAccount(t, pool, "profile-peer@example.test", uuid.NewString())
	manager := seedGoogleAccount(t, pool, "profile-manager@example.test", uuid.NewString())
	stranger := seedGoogleAccount(t, pool, "profile-other@example.test", uuid.NewString())
	book, peerBook, group, relA, relB, request := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, fixture := range []struct{ id, owner string }{{book, viewer}, {peerBook, peer}} {
		exec(`INSERT INTO vaults(vault_id,owner_account_id,name,currency) VALUES($1,$2,'Profile fixture','AFN')`, fixture.id, fixture.owner)
		exec(`INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1,$2,'owner',NOW())`, fixture.id, fixture.owner)
	}
	exec(`INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1,$2,'manager',NOW())`, book, manager)
	exec(`INSERT INTO tab_groups(id,recording_mode,invite_token_hash,request_hash,a_account_id,a_vault_id,a_relationship_id)
 VALUES($1,'review',$2,'fixture',$3,$4,$5)`, group, uuid.NewString(), viewer, book, relA)
	exec(`INSERT INTO people_requests(id,group_id,sender_account_id,recipient_account_id) VALUES($1,$2,$3,$4)`, request, group, viewer, peer)
	exec(`INSERT INTO vault_members(vault_id,role,invited_by,invite_account_id,invite_request_id,invite_expires_at)
 VALUES($1,'clerk',$2,$3,$4,NOW()+INTERVAL '1 day')`, book, viewer, peer, uuid.NewString())
	check := func(actor, target, vault string, want *PersonProfileActivity) {
		t.Helper()
		got, err := svc.loadPersonProfileActivity(t.Context(), actor, target, vault)
		if err != nil || (got == nil) != (want == nil) || (got != nil && want != nil && *got != *want) {
			t.Fatalf("activity=%+v, want %+v (err=%v)", got, want, err)
		}
	}
	check(viewer, peer, book, &PersonProfileActivity{SharedTally: "pending", KaataInvitationRole: "clerk", ExistingRelationshipID: relA})
	check(viewer, peer, "", nil)
	check(viewer, peer, "not-a-book", nil)
	check(viewer, peer, peerBook, nil)
	check(viewer, stranger, book, nil)
	check(manager, peer, book, nil) // another member cannot read the sender's pending requests
	check(peer, viewer, peerBook, nil)
	exec(`UPDATE people_requests SET declined_at=NOW() WHERE id=$1`, request)
	check(viewer, peer, book, &PersonProfileActivity{SharedTally: "declined", KaataInvitationRole: "clerk", ExistingRelationshipID: relA})
	check(manager, peer, book, nil)
	check(peer, viewer, peerBook, nil)
	exec(`UPDATE people_requests SET declined_at=NULL WHERE id=$1`, request)
	exec(`UPDATE tab_groups SET b_account_id=$2,b_vault_id=$3,b_relationship_id=$4,b_joined_at=NOW() WHERE id=$1`, group, peer, peerBook, relB)
	check(viewer, peer, book, &PersonProfileActivity{SharedTally: "active", KaataInvitationRole: "clerk", ExistingRelationshipID: relA})
	check(peer, viewer, peerBook, &PersonProfileActivity{SharedTally: "active", ExistingRelationshipID: relB})
	exec(`UPDATE vault_members SET account_id=invite_account_id,accepted_at=NOW() WHERE vault_id=$1 AND invite_account_id=$2`, book, peer)
	check(viewer, peer, book, &PersonProfileActivity{SharedTally: "active", KaataMemberRole: "clerk", ExistingRelationshipID: relA})
	check(manager, peer, book, &PersonProfileActivity{SharedTally: "active", KaataMemberRole: "clerk", ExistingRelationshipID: relA})
	exec(`UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1 AND account_id=$2`, book, peer)
	check(peer, viewer, book, nil)
	check(peer, viewer, peerBook, &PersonProfileActivity{SharedTally: "active", ExistingRelationshipID: relB})
	// A direct group account binding does not override a revoked Kaata seat.
	exec(`UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1 AND account_id=$2`, book, viewer)
	check(viewer, peer, book, nil)
	check(peer, viewer, peerBook, &PersonProfileActivity{SharedTally: "active", ExistingRelationshipID: relB})
	exec(`UPDATE vault_members SET revoked_at=NULL WHERE vault_id=$1 AND account_id=$2`, book, viewer)
	exec(`INSERT INTO vault_members(vault_id,role,invited_by,invite_account_id,invite_request_id,invite_expires_at,
 readmission_from_id,readmission_owner_member_id,readmission_owner_change_ms)
 SELECT $1,'viewer',$2,$3,$4,NOW()+INTERVAL '1 day',source.id,owner.id,COALESCE(owner.last_change_hlc_ms,0)
 FROM vault_members source JOIN vault_members owner ON owner.vault_id=source.vault_id AND owner.account_id=$2
 WHERE source.vault_id=$1 AND source.account_id=$3 AND source.revoked_at IS NOT NULL`, book, viewer, peer, uuid.NewString())
	check(viewer, peer, book, &PersonProfileActivity{SharedTally: "active", KaataInvitationRole: "viewer", ExistingRelationshipID: relA})
	// Changing the owner seat invalidates consent; don't advertise a stale request.
	exec(`UPDATE vault_members SET last_change_hlc_ms=1 WHERE vault_id=$1 AND account_id=$2`, book, viewer)
	check(viewer, peer, book, &PersonProfileActivity{SharedTally: "active", ExistingRelationshipID: relA})
	exec(`UPDATE tab_groups SET closed_at=NOW() WHERE id=$1`, group)
	exec(`UPDATE vault_members SET invite_expires_at=NOW()-INTERVAL '1 second' WHERE vault_id=$1 AND invite_account_id=$2`, book, peer)
	check(viewer, peer, book, &PersonProfileActivity{ExistingRelationshipID: relA})
	exec(`UPDATE vaults SET archived_at=NOW() WHERE vault_id=$1`, book)
	check(viewer, peer, book, nil)
}
