package sync

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/google/uuid"
)

// Roles v2 (docs/roles-v2-design.md) server-side chain rules:
//   - the five-role vocabulary folds into vault_members (CHECK relaxed by 033)
//   - a MANAGER-bound device authors member events strictly below manager
//   - a witness can never admit at manager (or owner)
//
// These must stay in lockstep with the mobile fold (lib/trust/chain.ts) and
// gate (lib/projection/role-gate.ts) manager arms.

// managerFixture: genesis owner + a manager member with their own bound
// device key, so manager-signed events exercise the 2b-manager arm.
func newManagerFixture(t *testing.T) (f *m2Fixture, managerAcct string, managerPriv ed25519.PrivateKey) {
	t.Helper()
	f = newM2Fixture(t)
	managerAcct = f.seedAccount(t, "manager@gmail.com")

	genesis := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "role": "owner"})
	f.signEvent(t, &genesis, f.anchorPriv)

	addManager := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, managerAcct,
		map[string]any{"account_id": managerAcct, "role": "manager"})
	f.signEvent(t, &addManager, f.anchorPriv)

	_, managerPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate manager key: %v", err)
	}
	bind := f.membershipEvent("vault_device_added", f.anchorDeviceID, f.ownerAcct, managerAcct,
		map[string]any{"account_id": managerAcct, "device_id": uuid.NewString(), "device_pubkey": b64pub(managerPriv)})
	f.signEvent(t, &bind, f.anchorPriv)

	requireAccepted(t, f.pushAs(t, f.ownerAcct, genesis, addManager, bind), 3)
	if role := f.memberRow(t, managerAcct); role != "manager" {
		t.Fatalf("manager fold = %q, want manager (033 CHECK must admit it)", role)
	}
	return f, managerAcct, managerPriv
}

func TestManagerAuthorsBelowCapAcceptedAndFolded(t *testing.T) {
	f, managerAcct, managerPriv := newManagerFixture(t)
	staff := f.seedAccount(t, "staff@gmail.com")

	// Manager admits a clerk — below the cap on both grant and target.
	addClerk := f.membershipEvent("vault_member_added", uuid.NewString(), managerAcct, staff,
		map[string]any{"account_id": staff, "role": "clerk"})
	f.signEvent(t, &addClerk, managerPriv)
	requireAccepted(t, f.pushAs(t, managerAcct, addClerk), 1)
	if role := f.memberRow(t, staff); role != "clerk" {
		t.Fatalf("clerk fold via manager = %q, want clerk", role)
	}

	// Manager promotes the clerk to editor — still below the cap.
	promote := f.membershipEvent("vault_member_role_changed", uuid.NewString(), managerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &promote, managerPriv)
	requireAccepted(t, f.pushAs(t, managerAcct, promote), 1)
	if role := f.memberRow(t, staff); role != "editor" {
		t.Fatalf("editor fold via manager = %q, want editor", role)
	}

	// Manager removes the editor — target below the cap.
	remove := f.membershipEvent("vault_member_removed", uuid.NewString(), managerAcct, staff,
		map[string]any{"account_id": staff})
	f.signEvent(t, &remove, managerPriv)
	requireAccepted(t, f.pushAs(t, managerAcct, remove), 1)
	if role := f.memberRow(t, staff); role != "" {
		t.Fatalf("staff still active after manager removal, role = %q", role)
	}
}

func TestManagerCannotExceedCap(t *testing.T) {
	f, managerAcct, managerPriv := newManagerFixture(t)
	staff := f.seedAccount(t, "staff@gmail.com")

	addEditor := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &addEditor, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, addEditor), 1)

	// (a) Granting manager — the new role is AT the cap.
	mintManager := f.membershipEvent("vault_member_role_changed", uuid.NewString(), managerAcct, staff,
		map[string]any{"account_id": staff, "role": "manager"})
	f.signEvent(t, &mintManager, managerPriv)
	res := f.pushAs(t, managerAcct, mintManager)
	requireRejectedUnverified(t, res, mintManager.EventID)
	if role := f.memberRow(t, staff); role != "editor" {
		t.Fatalf("staff role after refused manager-mint = %q, want editor", role)
	}

	// (b) Touching the OWNER — the target is above the cap.
	demoteOwner := f.membershipEvent("vault_member_role_changed", uuid.NewString(), managerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "role": "editor"})
	f.signEvent(t, &demoteOwner, managerPriv)
	requireRejectedUnverified(t, f.pushAs(t, managerAcct, demoteOwner), demoteOwner.EventID)
	if role := f.memberRow(t, f.ownerAcct); role != "owner" {
		t.Fatalf("owner role after refused manager demotion = %q, want owner", role)
	}

	// (c) Removing the OWNER.
	removeOwner := f.membershipEvent("vault_member_removed", uuid.NewString(), managerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct})
	f.signEvent(t, &removeOwner, managerPriv)
	requireRejectedUnverified(t, f.pushAs(t, managerAcct, removeOwner), removeOwner.EventID)
	if role := f.memberRow(t, f.ownerAcct); role != "owner" {
		t.Fatalf("owner removed by manager; role = %q, want owner", role)
	}
}

// A witnessed admission at role=manager must be refused even with a VALID
// server witness signature over the manager tuple — the witness arm can
// never mint member-management authority.
func TestWitnessedManagerAdmissionRejected(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()
	joiner := f.seedAccount(t, "joiner@gmail.com")

	genesis := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "role": "owner"})
	f.signEvent(t, &genesis, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, genesis), 1)

	// The REST AcceptInvite grants the push-gate ACL seat (editor) before the
	// device pushes its witnessed self-admission — mirror that here so the
	// event reaches the chain verifier, whose CAP is what we're testing.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, f.vaultID, joiner, f.ownerAcct); err != nil {
		t.Fatalf("seed joiner ACL membership: %v", err)
	}

	_, joinerPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate joiner key: %v", err)
	}
	issuedAt := f.nextPMS()
	add := f.membershipEvent("vault_member_added", uuid.NewString(), joiner, joiner,
		map[string]any{
			"account_id": joiner,
			"role":       "manager",
			"witness":    f.memberWitness(t, joiner, f.ownerAcct, "manager", issuedAt),
		})
	// Keep the event HLC near the witness issue time so freshness passes and
	// the CAP is what rejects.
	add.HLC.PhysicalMS = issuedAt
	f.signEvent(t, &add, joinerPriv)

	requireRejectedUnverified(t, f.pushAs(t, joiner, add), add.EventID)
	if role := f.memberRow(t, joiner); role != "editor" {
		t.Fatalf("witnessed manager admission changed role = %q, want editor (ACL seat untouched)", role)
	}
}

// Tier sanity for the widened legacy ACL: clerks append, never amend.
func TestClerkTierRequirements(t *testing.T) {
	for _, tc := range []struct {
		event, want string
	}{
		{"entry_created", "clerk"},
		{"person_added", "clerk"},
		{"entry_amended", "editor"},
		{"entry_deleted", "editor"},
		{"person_renamed", "editor"},
		{"shop_profile_updated", "manager"},
		{"vault_setting_set", "manager"},
		{"vault_member_role_changed", "owner"},
	} {
		got, ok := requiredRoleFor(tc.event)
		if !ok || got != tc.want {
			t.Errorf("requiredRoleFor(%s) = %q ok=%v, want %q", tc.event, got, ok, tc.want)
		}
	}
	if !roleSatisfies("clerk", "clerk") || roleSatisfies("clerk", "editor") {
		t.Error("clerk must satisfy clerk-tier and fail editor-tier")
	}
	if !roleSatisfies("manager", "editor") || roleSatisfies("manager", "owner") {
		t.Error("manager must satisfy editor-tier and fail owner-tier")
	}
	if roleSatisfies("unknown_role", "clerk") {
		t.Error("unknown roles must rank below every tier (fail closed)")
	}
}
