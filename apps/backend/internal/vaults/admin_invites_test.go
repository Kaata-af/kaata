package vaults

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/admininvite"
	"github.com/matee/kaata-backend/internal/canonical"
)

func signAdminGrant(t *testing.T, g admininvite.Grant, key ed25519.PrivateKey) admininvite.Authorization {
	t.Helper()
	raw, err := canonical.Canonicalize(g.Tuple())
	if err != nil {
		t.Fatal(err)
	}
	return admininvite.Authorization{Grant: g, SignerDevicePubkey: base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey)), SigB64: base64.StdEncoding.EncodeToString(ed25519.Sign(key, raw))}
}
func adminAuthorization(t *testing.T, f *ownershipFixture) admininvite.Authorization {
	t.Helper()
	now := time.Now().UnixMilli()
	var maximum int64
	if err := f.pool.QueryRow(t.Context(), `SELECT COALESCE(MAX(hlc_physical_ms),0) FROM events WHERE vault_id=$1::uuid AND event_type IN ('vault_member_added','vault_member_role_changed','vault_member_removed','vault_device_added','vault_device_removed')`, f.vault).Scan(&maximum); err != nil {
		t.Fatal(err)
	}
	now = max(now, maximum+1)
	g := admininvite.Grant{Domain: admininvite.Domain, GrantID: uuid.NewString(), VaultID: f.vault, FromAccountID: f.owner, RecipientAccountID: f.to, Role: "manager", IssuedAtMS: now, ExpiresAtMS: now + admininvite.MaxLifetimeMS}
	if f.chainOwner != f.owner {
		g.FromChainAccountID = f.chainOwner
	}
	return signAdminGrant(t, g, f.ownerPriv)
}
func createAdminRequest(t *testing.T, f *ownershipFixture) AccountInviteResult {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET currency='AFN',legacy_currency='AFN',default_entry_currency='AFN' WHERE vault_id=$1::uuid`, f.vault); err != nil {
		t.Fatal(err)
	}
	a := adminAuthorization(t, f)
	out, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.to, Role: "manager", AdminAuthorization: &a})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAdminInviteAtomicAcceptanceAndRecovery(t *testing.T) {
	for _, local := range []bool{false, true} {
		t.Run(map[bool]string{false: "account_owner", true: "local_owner"}[local], func(t *testing.T) {
			f := newOwnershipFixture(t, local)
			request := createAdminRequest(t, f)
			if info, err := f.svc.AccountInviteInfo(t.Context(), f.to, request.InviteID); err != nil || info.Role != "manager" {
				t.Fatalf("pending admin info: %+v %v", info, err)
			}
			if books, err := f.svc.List(t.Context(), f.to); err != nil || len(books) != 0 {
				t.Fatalf("pending request granted access: %+v %v", books, err)
			}
			if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: request.InviteToken, AccountID: f.to}); !errors.Is(err, ErrAdminInviteUpgradeRequired) {
				t.Fatalf("old client accepted admin: %v", err)
			}
			if f.count(t, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.to) != 0 {
				t.Fatal("old client gained seat")
			}
			accepted, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: request.InviteToken, AccountID: f.to, AdminInviteVersion: 1})
			if err != nil || accepted.Role != "manager" || accepted.AdminInviteEventID == "" {
				t.Fatalf("admin acceptance: %+v %v", accepted, err)
			}
			var raw []byte
			var stamp int64
			var sig, pub string
			if err := f.pool.QueryRow(t.Context(), `SELECT payload,hlc_physical_ms,event_sig_b64,signer_device_pubkey FROM events WHERE event_id=$1::uuid`, accepted.AdminInviteEventID).Scan(&raw, &stamp, &sig, &pub); err != nil {
				t.Fatal(err)
			}
			var payload struct {
				Role  string            `json:"role"`
				Proof admininvite.Proof `json:"admin_invite"`
			}
			if json.Unmarshal(raw, &payload) != nil || payload.Role != "manager" || admininvite.VerifyProof(payload.Proof, admininvite.EventIdentity{VaultID: f.vault, EventID: accepted.AdminInviteEventID, TargetID: f.to, DeviceID: accepted.AdminInviteEventID, HLCDeviceID: accepted.AdminInviteEventID, HLCPhysicalMS: stamp}) != nil || sig == "" || pub != base64.StdEncoding.EncodeToString(f.serverPriv.Public().(ed25519.PublicKey)) {
				t.Fatal("missing stable dual proof")
			}
			for i := 0; i < 2; i++ {
				retry, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: request.InviteToken, AccountID: f.to, AdminInviteVersion: 1})
				if err != nil || retry.AdminInviteEventID != accepted.AdminInviteEventID {
					t.Fatalf("retry changed admin event: %+v %v", retry, err)
				}
			}
			if f.count(t, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid AND payload->'admin_invite' IS NOT NULL`, f.vault) != 1 {
				t.Fatal("duplicate admission event")
			}
			if f.count(t, `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind='vault_invite_accepted' AND source_id=$1::uuid`, request.InviteID) != 1 {
				t.Fatal("missing or duplicate accepted notification")
			}
			books, err := f.svc.List(t.Context(), f.to)
			if err != nil || len(books) != 1 || !books[0].JoinedByInvite || books[0].AdminInviteEventID != accepted.AdminInviteEventID {
				t.Fatalf("admin cannot recover original event: %+v %v", books, err)
			}
		})
	}
}

func TestAdminInviteRequiresExactOwnerAuthorization(t *testing.T) {
	f := newOwnershipFixture(t, false)
	for _, scenario := range []string{"missing", "recipient", "tampered", "unbound", "wildcard", "expired", "wrong_vault"} {
		a := adminAuthorization(t, f)
		switch scenario {
		case "recipient":
			a.Grant.RecipientAccountID = f.other
			a = signAdminGrant(t, a.Grant, f.ownerPriv)
		case "tampered":
			a.Grant.GrantID = uuid.NewString()
		case "unbound":
			_, priv, _ := ed25519.GenerateKey(rand.Reader)
			a = signAdminGrant(t, a.Grant, priv)
		case "wildcard":
			a.Grant.RecipientAccountID = "*"
			a = signAdminGrant(t, a.Grant, f.ownerPriv)
		case "expired":
			a.Grant.IssuedAtMS = time.Now().Add(-time.Hour).UnixMilli()
			a.Grant.ExpiresAtMS = time.Now().Add(-time.Minute).UnixMilli()
			a = signAdminGrant(t, a.Grant, f.ownerPriv)
		case "wrong_vault":
			a.Grant.VaultID = uuid.NewString()
			a = signAdminGrant(t, a.Grant, f.ownerPriv)
		}
		var authorization *admininvite.Authorization = &a
		if scenario == "missing" {
			authorization = nil
		}
		if _, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.to, Role: "manager", AdminAuthorization: authorization}); !errors.Is(err, ErrInvalidAdminAuthorization) {
			t.Fatalf("%s accepted: %v", scenario, err)
		}
	}
	if _, err := f.svc.CreateInvite(t.Context(), CreateInviteInput{VaultID: f.vault, InviterAccID: f.owner, Role: "manager"}); !errors.Is(err, ErrInvalidRole) {
		t.Fatalf("public Admin link allowed: %v", err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1::uuid,$2::uuid,'manager',NOW())`, f.vault, f.other); err != nil {
		t.Fatal(err)
	}
	a := adminAuthorization(t, f)
	if _, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.other, TargetAccountID: f.to, Role: "manager", AdminAuthorization: &a}); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("admin appointed peer: %v", err)
	}
}

func TestAdminInviteOwnerChangesAndSignerFailureStayAtomic(t *testing.T) {
	for _, scenario := range []string{"same_stamp_owner_change", "removed_key", "missing_server_key"} {
		t.Run(scenario, func(t *testing.T) {
			f := newOwnershipFixture(t, false)
			request := createAdminRequest(t, f)
			switch scenario {
			case "same_stamp_owner_change":
				for _, role := range []string{"editor", "owner"} {
					if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role=$3,updated_at=NOW() WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.owner, role); err != nil {
						t.Fatal(err)
					}
				}
			case "removed_key":
				if _, err := f.pool.Exec(t.Context(), `UPDATE vault_devices SET removed_at_ms=2 WHERE vault_id=$1::uuid`, f.vault); err != nil {
					t.Fatal(err)
				}
			case "missing_server_key":
				f.svc.SetOwnershipSigner(nil)
			}
			if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: request.InviteToken, AccountID: f.to, AdminInviteVersion: 1}); err == nil {
				t.Fatal("invalid authority/signing succeeded")
			}
			if f.count(t, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.to) != 0 || f.count(t, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid AND payload->'admin_invite' IS NOT NULL`, f.vault) != 0 || f.count(t, `SELECT COUNT(*) FROM account_connection_notifications WHERE source_id=$1::uuid AND event_kind='vault_invite_accepted'`, request.InviteID) != 0 {
				t.Fatal("failure leaked ACL/event/accepted notice")
			}
		})
	}
}

func TestAdminInviteReturningMemberWaitsForOwnerSignedApproval(t *testing.T) {
	f := newOwnershipFixture(t, false)
	request := createAdminRequest(t, f)
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: request.InviteToken, AccountID: f.to, AdminInviteVersion: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.RevokeMember(t.Context(), RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: f.to}); err != nil {
		t.Fatal(err)
	}
	device := uuid.NewString()
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO installs(install_id,account_id) VALUES($1::uuid,$2::uuid)`, device, f.to); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO auth_credentials(install_id,provider,provider_sub,account_id) VALUES($1::uuid,'google',$2::text,$2::uuid)`, device, f.to); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO device_keys(install_id,ed25519_pubkey) VALUES($1::uuid,$2)`, device, []byte(pub)); err != nil {
		t.Fatal(err)
	}
	a := adminAuthorization(t, f)
	returning, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.to, Role: "manager", ReadmitRemoved: true, AdminAuthorization: &a})
	if err != nil || !returning.MemberReadmission {
		t.Fatalf("return invite: %+v %v", returning, err)
	}
	consent, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: returning.InviteToken, AccountID: f.to, InstallID: device, MemberReadmission: true, AdminInviteVersion: 1})
	if err != nil || !consent.ReadmissionPending || consent.Role != "manager" {
		t.Fatalf("return consent: %+v %v", consent, err)
	}
	if books, err := f.svc.List(t.Context(), f.to); err != nil || len(books) != 0 {
		t.Fatalf("consent granted access: %+v %v", books, err)
	}
	ready, err := f.svc.ListMemberReadmissions(t.Context(), f.vault, f.owner)
	if err != nil || len(ready) != 1 || ready[0].Role != "manager" {
		t.Fatalf("owner cannot approve return: %+v %v", ready, err)
	}
}
