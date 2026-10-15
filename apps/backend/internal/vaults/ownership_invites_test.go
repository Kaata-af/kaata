package vaults

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/ownership"
	"github.com/matee/kaata-backend/internal/testutil"
)

type ownershipFixture struct {
	pool                                        *pgxpool.Pool
	svc                                         *Service
	vault, owner, to, other, device, chainOwner string
	ownerPriv, serverPriv                       ed25519.PrivateKey
	ownerPub                                    ed25519.PublicKey
}

func newOwnershipFixture(t *testing.T, local bool) *ownershipFixture {
	t.Helper()
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, server, _ := ed25519.GenerateKey(rand.Reader)
	f := &ownershipFixture{pool: pool, svc: NewService(pool), vault: uuid.NewString(), device: uuid.NewString(), ownerPriv: priv, ownerPub: pub, serverPriv: server}
	f.svc.SetOwnershipSigner(server)
	for _, p := range []struct {
		email string
		dest  *string
	}{{"owner@example.com", &f.owner}, {"recipient@gmail.com", &f.to}, {"outsider@example.com", &f.other}} {
		if err := pool.QueryRow(ctx, `INSERT INTO accounts(google_sub,email,email_verified) VALUES($1,$2,TRUE) RETURNING id::text`, uuid.NewString(), p.email).Scan(p.dest); err != nil {
			t.Fatal(err)
		}
	}
	f.chainOwner = f.owner
	if local {
		f.chainOwner = "local:abcdefghijklmnop"
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vaults(vault_id,owner_account_id,name,vault_trust_anchor_pubkey) VALUES($1::uuid,$2::uuid,'Family Shop',$3)`, f.vault, f.owner, []byte(pub)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,last_change_hlc_ms) VALUES($1::uuid,$2::uuid,'owner',NOW(),1)`, f.vault, f.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO installs(install_id,account_id) VALUES($1::uuid,$2::uuid)`, f.device, f.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO device_keys(install_id,ed25519_pubkey) VALUES($1::uuid,$2)`, f.device, []byte(pub)); err != nil {
		t.Fatal(err)
	}
	if !local {
		if _, err := pool.Exec(ctx, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms) VALUES($1::uuid,$2::uuid,$3,$4::uuid,1)`, f.vault, f.device, []byte(pub), f.owner); err != nil {
			t.Fatal(err)
		}
	}
	f.seedMemberEvent(t, "vault_member_added", f.chainOwner, "owner", 1)
	return f
}

func (f *ownershipFixture) seedMemberEvent(t *testing.T, kind, target, role string, stamp int64) {
	t.Helper()
	id := uuid.NewString()
	payload := map[string]any{"account_id": target}
	if role != "" {
		payload["role"] = role
	}
	env := map[string]any{"actor_account_id": nil, "device_id": f.device, "event_id": id, "event_type": kind, "hlc": map[string]any{"did": f.device, "pms": stamp, "l": 0}, "payload": payload, "payload_schema": 1, "relationship_id": nil, "target_id": target, "vault_id": f.vault}
	signable, _ := canonical.Canonicalize(env)
	raw, _ := json.Marshal(payload)
	var targetUUID, localID any = target, nil
	if strings.HasPrefix(target, "local:") {
		targetUUID = nil
		localID = target
	}
	_, err := f.pool.Exec(t.Context(), `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,event_type,schema_version,payload,server_seq,target_id,local_target_id,event_sig_b64,signer_device_pubkey)
 VALUES($1::uuid,$2::uuid,$3,0,$4::uuid,$4::uuid,$5,1,$6::jsonb,(SELECT COALESCE(MAX(server_seq),0)+1 FROM events WHERE vault_id=$2::uuid),$7::uuid,$8,$9,$10)`, id, f.vault, stamp, f.device, kind, string(raw), targetUUID, localID, base64.StdEncoding.EncodeToString(ed25519.Sign(f.ownerPriv, signable)), base64.StdEncoding.EncodeToString(f.ownerPub))
	if err != nil {
		t.Fatal(err)
	}
}

func (f *ownershipFixture) authorization(t *testing.T) ownership.Authorization {
	t.Helper()
	now := time.Now().UnixMilli()
	g := ownership.Grant{Domain: ownership.GrantDomain, TransferID: uuid.NewString(), VaultID: f.vault, FromAccountID: f.owner, RecipientEmailNormalized: "recipient@gmail.com", DemoteSelfTo: "editor", IssuedAtMS: now, ExpiresAtMS: now + ownership.MaxGrantLifetimeMS}
	if f.chainOwner != f.owner {
		g.FromChainAccountID = f.chainOwner
	}
	return signOwnershipGrant(t, g, f.ownerPriv)
}
func signOwnershipGrant(t *testing.T, g ownership.Grant, key ed25519.PrivateKey) ownership.Authorization {
	t.Helper()
	b, err := ownership.GrantBytes(g)
	if err != nil {
		t.Fatal(err)
	}
	return ownership.Authorization{Grant: g, SignerDevicePubkey: base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey)), SigB64: base64.StdEncoding.EncodeToString(ed25519.Sign(key, b))}
}
func (f *ownershipFixture) create(t *testing.T) string {
	t.Helper()
	out, err := f.svc.CreateOwnershipInvite(t.Context(), CreateOwnershipInviteInput{AccountID: f.owner, VaultID: f.vault, Authorization: f.authorization(t)})
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimPrefix(out.InviteURL, "https://kaata.af/i/")
}
func (f *ownershipFixture) count(t *testing.T, q string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := f.pool.QueryRow(t.Context(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestOwnershipInviteAtomicAcceptanceAndImmutableRetry(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new recipient", true: "existing editor"}[existing], func(t *testing.T) {
			f := newOwnershipFixture(t, false)
			ctx := t.Context()
			if existing {
				if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1::uuid,$2::uuid,'editor',NOW())`, f.vault, f.to); err != nil {
					t.Fatal(err)
				}
			}
			token := f.create(t)
			status, err := f.svc.OwnershipInviteStatus(ctx, f.vault, f.owner)
			if err != nil || status == nil || status.InviteEmail != "recipient@gmail.com" {
				t.Fatalf("pending %+v %v", status, err)
			}
			info, err := f.svc.InviteInfo(ctx, token)
			if err != nil || info.Kind != "ownership_transfer" || info.Role != "owner" {
				t.Fatalf("info %+v %v", info, err)
			}
			if _, err = f.svc.AcceptInvite(ctx, AcceptInviteInput{Token: token, AccountID: f.to}); !errors.Is(err, ErrInviteNotFound) {
				t.Fatalf("ordinary member endpoint accepted ownership token: %v", err)
			}
			input := AcceptInviteInput{Token: token, AccountID: f.to}
			out, err := f.svc.AcceptOwnershipInvite(ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			if out.Role != "owner" || out.OwnershipEventID == "" || !out.OwnershipTransferred {
				t.Fatalf("result %+v", out)
			}
			if f.count(t, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND ((account_id=$2::uuid AND role='editor') OR(account_id=$3::uuid AND role='owner')) AND revoked_at IS NULL`, f.vault, f.owner, f.to) != 2 {
				t.Fatal("roles did not atomically change")
			}
			if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid AND vault_epoch=1`, f.vault, f.to) != 1 {
				t.Fatal("canonical owner/epoch stale")
			}
			f.assertEvent(t, out.OwnershipEventID)
			retry, err := f.svc.AcceptOwnershipInvite(ctx, input)
			if err != nil || retry != out {
				t.Fatalf("retry %+v %v", retry, err)
			}
			if f.count(t, `SELECT COUNT(*) FROM events`) != 2 {
				t.Fatal("retry created another proof")
			}
			if _, err = f.svc.Archive(ctx, f.vault, f.owner); !errors.Is(err, ErrNotOwner) {
				t.Fatalf("old owner may archive: %v", err)
			}
			// A later role change must win over a lost-response retry.
			if _, err = f.pool.Exec(ctx, `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.to); err != nil {
				t.Fatal(err)
			}
			retry, err = f.svc.AcceptOwnershipInvite(ctx, input)
			if err != nil || retry.Role != "editor" || retry.OwnershipEventID != out.OwnershipEventID {
				t.Fatalf("later-demoted retry %+v %v", retry, err)
			}
			if _, err = f.pool.Exec(ctx, `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.to); err != nil {
				t.Fatal(err)
			}
			if _, err = f.svc.AcceptOwnershipInvite(ctx, input); !errors.Is(err, ErrInviteNotFound) {
				t.Fatalf("removed recipient resurrected: %v", err)
			}
		})
	}
}

func (f *ownershipFixture) assertEvent(t *testing.T, eventID string) {
	t.Helper()
	var raw []byte
	var pms int64
	var device, sig, pub string
	var actor *string
	if err := f.pool.QueryRow(t.Context(), `SELECT payload,hlc_physical_ms,device_id::text,event_sig_b64,signer_device_pubkey,account_id::text FROM events WHERE event_id=$1::uuid`, eventID).Scan(&raw, &pms, &device, &sig, &pub, &actor); err != nil {
		t.Fatal(err)
	}
	var p struct {
		AccountID string          `json:"account_id"`
		Role      string          `json:"role"`
		Proof     ownership.Proof `json:"ownership_transfer"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	if actor != nil || p.Role != "owner" || p.AccountID != f.to {
		t.Fatalf("event actor/payload invalid: %s", raw)
	}
	if err := ownership.VerifyProof(p.Proof, ownership.EventIdentity{VaultID: f.vault, EventID: eventID, TargetID: f.to, HLCPhysicalMS: pms}); err != nil {
		t.Fatal(err)
	}
	payload, _ := canonical.Decode(raw)
	b, err := canonical.Canonicalize(map[string]any{"actor_account_id": nil, "device_id": device, "event_id": eventID, "event_type": "vault_member_added", "hlc": map[string]any{"did": device, "l": 0, "pms": pms}, "payload": payload, "payload_schema": 1, "relationship_id": nil, "target_id": f.to, "vault_id": f.vault})
	if err != nil {
		t.Fatal(err)
	}
	signature, _ := base64.StdEncoding.DecodeString(sig)
	key, _ := base64.StdEncoding.DecodeString(pub)
	if !ed25519.Verify(key, b, signature) || pub != base64.StdEncoding.EncodeToString(f.serverPriv.Public().(ed25519.PublicKey)) {
		t.Fatal("not signed by pinned server key")
	}
}

func TestOwnershipInvitesRejectInvalidOrStaleAuthority(t *testing.T) {
	for _, scenario := range []string{"wrong mailbox", "unverified mailbox", "source pending deletion", "archived", "expired", "cancelled", "replaced", "source changed away and back", "owner device removed", "source proof missing", "recipient device removed", "signer unavailable"} {
		t.Run(scenario, func(t *testing.T) {
			f := newOwnershipFixture(t, false)
			token := f.create(t)
			ctx := t.Context()
			account := f.to
			installID := ""
			switch scenario {
			case "wrong mailbox":
				account = f.other
			case "unverified mailbox":
				_, _ = f.pool.Exec(ctx, `UPDATE accounts SET email_verified=FALSE WHERE id=$1::uuid`, f.to)
			case "source pending deletion":
				_, _ = f.pool.Exec(ctx, `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.owner)
			case "archived":
				_, _ = f.pool.Exec(ctx, `UPDATE vaults SET archived_at=NOW() WHERE vault_id=$1::uuid`, f.vault)
			case "expired":
				_, _ = f.pool.Exec(ctx, `UPDATE vault_ownership_invites SET expires_at=NOW()-INTERVAL '1 second'`)
			case "cancelled":
				if err := f.svc.CancelOwnershipInvite(ctx, f.vault, f.owner); err != nil {
					t.Fatal(err)
				}
			case "replaced":
				_ = f.create(t)
			case "source changed away and back":
				_, _ = f.pool.Exec(ctx, `UPDATE vault_members SET last_change_hlc_ms=last_change_hlc_ms+1 WHERE account_id=$1::uuid`, f.owner)
			case "owner device removed":
				_, _ = f.pool.Exec(ctx, `UPDATE vault_devices SET removed_at_ms=2 WHERE account_id=$1::uuid`, f.owner)
			case "source proof missing":
				_, _ = f.pool.Exec(ctx, `DELETE FROM events`)
			case "recipient device removed":
				installID = uuid.NewString()
				pub, _, _ := ed25519.GenerateKey(rand.Reader)
				if _, err := f.pool.Exec(ctx, `INSERT INTO installs(install_id,account_id)VALUES($1::uuid,$2::uuid)`, installID, f.to); err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(ctx, `INSERT INTO device_keys(install_id,ed25519_pubkey)VALUES($1::uuid,$2)`, installID, []byte(pub)); err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(ctx, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms,removed_at_ms)VALUES($1::uuid,$2::uuid,$3,$4::uuid,1,2)`, f.vault, installID, []byte(pub), f.to); err != nil {
					t.Fatal(err)
				}
			case "signer unavailable":
				f.svc.SetOwnershipSigner(nil)
			}
			before := f.count(t, `SELECT COUNT(*) FROM events`)
			if _, err := f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: token, AccountID: account, InstallID: installID}); err == nil {
				t.Fatal("invalid offer accepted")
			}
			if f.count(t, `SELECT COUNT(*) FROM events`) != before || f.count(t, `SELECT COUNT(*) FROM vaults WHERE owner_account_id=$1::uuid AND vault_epoch=0`, f.owner) != 1 {
				t.Fatal("refused transfer mutated durable state")
			}
		})
	}
}

func TestOwnershipInviteCreationRequiresSignedCurrentOwner(t *testing.T) {
	for _, scenario := range []string{"tampered email", "unbound key", "manager", "self", "missing source chain", "missing trust anchor", "oversized lifetime"} {
		t.Run(scenario, func(t *testing.T) {
			f := newOwnershipFixture(t, false)
			a := f.authorization(t)
			switch scenario {
			case "tampered email":
				a.Grant.RecipientEmailNormalized = "other@example.com"
			case "unbound key":
				_, priv, _ := ed25519.GenerateKey(rand.Reader)
				a = signOwnershipGrant(t, a.Grant, priv)
			case "manager":
				_, _ = f.pool.Exec(t.Context(), `UPDATE vault_members SET role='manager' WHERE account_id=$1::uuid`, f.owner)
			case "self":
				a.Grant.RecipientEmailNormalized = "owner@example.com"
				a = signOwnershipGrant(t, a.Grant, f.ownerPriv)
			case "missing source chain":
				_, _ = f.pool.Exec(t.Context(), `DELETE FROM events`)
			case "missing trust anchor":
				_, _ = f.pool.Exec(t.Context(), `UPDATE vaults SET vault_trust_anchor_pubkey=NULL`)
			case "oversized lifetime":
				a.Grant.ExpiresAtMS++ // already exactly seven days
			}
			if _, err := f.svc.CreateOwnershipInvite(t.Context(), CreateOwnershipInviteInput{AccountID: f.owner, VaultID: f.vault, Authorization: a}); err == nil {
				t.Fatal("invalid ownership authorization created")
			}
			if f.count(t, `SELECT COUNT(*) FROM vault_ownership_invites`) != 0 {
				t.Fatal("invalid authorization persisted")
			}
		})
	}
}

func TestOwnershipInviteConcurrentAcceptanceEmitsExactlyOneEvent(t *testing.T) {
	f := newOwnershipFixture(t, false)
	token := f.create(t)
	input := AcceptInviteInput{Token: token, AccountID: f.to}
	var wg sync.WaitGroup
	results := make(chan AcceptOwnershipInviteResult, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := f.svc.AcceptOwnershipInvite(context.Background(), input)
			if err != nil {
				errs <- err
			} else {
				results <- out
			}
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	first := ""
	for result := range results {
		if first == "" {
			first = result.OwnershipEventID
		}
		if result.OwnershipEventID != first {
			t.Fatal("concurrent proof identity changed")
		}
	}
	if first == "" || f.count(t, `SELECT COUNT(*) FROM events`) != 2 || f.count(t, `SELECT vault_epoch FROM vaults WHERE vault_id=$1::uuid`, f.vault) != 1 {
		t.Fatal("duplicate acceptance mutation")
	}
}

func TestOwnershipInviteOriginalLocalOwnerAndAliasCannotRevive(t *testing.T) {
	f := newOwnershipFixture(t, true)
	token := f.create(t)
	out, err := f.svc.AcceptOwnershipInvite(t.Context(), AcceptInviteInput{Token: token, AccountID: f.to})
	if err != nil {
		t.Fatal(err)
	}
	f.assertEvent(t, out.OwnershipEventID)
	// Restoring UUID ownership does not revive the local genesis alias, which
	// the first handover explicitly demoted on every replica.
	if _, err = f.pool.Exec(t.Context(), `UPDATE vault_members SET role='owner' WHERE account_id=$1::uuid`, f.owner); err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(t.Context(), `UPDATE vaults SET owner_account_id=$1::uuid`, f.owner); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.CreateOwnershipInvite(t.Context(), CreateOwnershipInviteInput{AccountID: f.owner, VaultID: f.vault, Authorization: f.authorization(t)}); !errors.Is(err, ErrInvalidOwnershipAuthorization) {
		t.Fatalf("demoted alias revived: %v", err)
	}
}

func TestDirectOwnershipTransferUpdatesCanonicalOwner(t *testing.T) {
	f := newOwnershipFixture(t, false)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,accepted_at)VALUES($1::uuid,$2::uuid,'editor',NOW())`, f.vault, f.to); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.TransferOwnership(t.Context(), TransferInput{AccountID: f.owner, VaultID: f.vault, ToAccountID: f.to, DemoteSelfTo: "editor"}); err != nil {
		t.Fatal(err)
	}
	if f.count(t, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, f.vault, f.to) != 1 {
		t.Fatal("canonical owner not transferred")
	}
}

func TestOwnershipFreshGrantReadmitsAccountWithoutRevivingRemovedDevice(t *testing.T) {
	f := newOwnershipFixture(t, false)
	ctx := t.Context()
	f.seedMemberEvent(t, "vault_member_removed", f.to, "", 2)
	if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,revoked_at)VALUES($1::uuid,$2::uuid,'editor',NOW(),NOW())`, f.vault, f.to); err != nil {
		t.Fatal(err)
	}
	oldDevice, newDevice := uuid.NewString(), uuid.NewString()
	oldPub, _, _ := ed25519.GenerateKey(rand.Reader)
	newPub, _, _ := ed25519.GenerateKey(rand.Reader)
	for _, d := range []struct {
		id  string
		pub []byte
	}{{oldDevice, oldPub}, {newDevice, newPub}} {
		if _, err := f.pool.Exec(ctx, `INSERT INTO installs(install_id,account_id)VALUES($1::uuid,$2::uuid)`, d.id, f.to); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(ctx, `INSERT INTO device_keys(install_id,ed25519_pubkey)VALUES($1::uuid,$2)`, d.id, d.pub); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms,removed_at_ms)VALUES($1::uuid,$2::uuid,$3,$4::uuid,1,2)`, f.vault, oldDevice, []byte(oldPub), f.to); err != nil {
		t.Fatal(err)
	}
	token := f.create(t)
	if _, err := f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: token, AccountID: f.to, InstallID: oldDevice}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("removed device accepted: %v", err)
	}
	out, err := f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: token, AccountID: f.to, InstallID: newDevice})
	if err != nil || out.Role != "owner" {
		t.Fatalf("new device admission %+v %v", out, err)
	}
	if f.count(t, `SELECT COUNT(*) FROM vault_members WHERE account_id=$1::uuid AND role='owner' AND revoked_at IS NULL`, f.to) != 1 || f.count(t, `SELECT COUNT(*) FROM vault_members WHERE account_id=$1::uuid AND revoked_at IS NOT NULL`, f.to) != 1 {
		t.Fatal("re-admission reused revoked membership seat")
	}
	if f.count(t, `SELECT COUNT(*) FROM vault_devices WHERE device_id=$1::uuid AND removed_at_ms=2`, oldDevice) != 1 {
		t.Fatal("removed device revived")
	}
}

func TestOwnershipConsumedLinkCannotUndoLaterTransfer(t *testing.T) {
	f := newOwnershipFixture(t, false)
	ctx := t.Context()
	token := f.create(t)
	first, err := f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: token, AccountID: f.to})
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	device := uuid.NewString()
	if _, err = f.pool.Exec(ctx, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms)VALUES($1::uuid,$2::uuid,$3,$4::uuid,1)`, f.vault, device, []byte(pub), f.to); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	a := signOwnershipGrant(t, ownership.Grant{Domain: ownership.GrantDomain, TransferID: uuid.NewString(), VaultID: f.vault, FromAccountID: f.to, RecipientEmailNormalized: "outsider@example.com", DemoteSelfTo: "editor", IssuedAtMS: now, ExpiresAtMS: now + ownership.MaxGrantLifetimeMS}, priv)
	created, err := f.svc.CreateOwnershipInvite(ctx, CreateOwnershipInviteInput{AccountID: f.to, VaultID: f.vault, Authorization: a})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: strings.TrimPrefix(created.InviteURL, "https://kaata.af/i/"), AccountID: f.other})
	if err != nil {
		t.Fatal(err)
	}
	if first.OwnershipEventID == second.OwnershipEventID {
		t.Fatal("handover reused event")
	}
	retry, err := f.svc.AcceptOwnershipInvite(ctx, AcceptInviteInput{Token: token, AccountID: f.to})
	if err != nil || retry.Role != "editor" || retry.OwnershipEventID != first.OwnershipEventID {
		t.Fatalf("old link replay %+v %v", retry, err)
	}
	if f.count(t, `SELECT COUNT(*) FROM vaults WHERE owner_account_id=$1::uuid AND vault_epoch=2`, f.other) != 1 || f.count(t, `SELECT COUNT(*) FROM events`) != 3 {
		t.Fatal("old link changed later handover")
	}
}
