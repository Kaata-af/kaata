package sync

// M2 membership-chain push tests (docs/m2-membership-chain.md §8.2, §9).
// Real Postgres via testutil; real Ed25519 keys generated per test. The
// canonicalization these signatures depend on is pinned cross-side in
// internal/canonical/canonical_test.go; TestCanonicalSignableEventHandBuilt
// below additionally pins the event-envelope shape against a hand-built
// string (independent of the production canonicalizer's own output).

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/mesh"
	"github.com/matee/kaata-backend/internal/testutil"
)

type m2Fixture struct {
	pool *pgxpool.Pool
	svc  *Service

	vaultID    string
	ownerAcct  string
	anchorPub  ed25519.PublicKey
	anchorPriv ed25519.PrivateKey
	// anchorDeviceID is the owner device's id — used as hlc.device_id on
	// events "authored" by the anchor device.
	anchorDeviceID string

	serverPub  ed25519.PublicKey
	serverPriv ed25519.PrivateKey

	// monotonically increasing HLC physical clock for event ordering.
	pms int64
}

func newM2Fixture(t *testing.T) *m2Fixture {
	t.Helper()
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	anchorPub, anchorPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate anchor key: %v", err)
	}
	serverPub, serverPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate server key: %v", err)
	}

	svc := NewService(pool)
	svc.SetWitnessPubkeys([]ed25519.PublicKey{serverPub})

	f := &m2Fixture{
		pool:           pool,
		svc:            svc,
		vaultID:        uuid.NewString(),
		anchorPub:      anchorPub,
		anchorPriv:     anchorPriv,
		anchorDeviceID: uuid.NewString(),
		serverPub:      serverPub,
		serverPriv:     serverPriv,
		pms:            time.Now().UnixMilli(),
	}
	f.ownerAcct = f.seedAccount(t, "owner@gmail.com")

	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, vault_trust_anchor_pubkey)
		VALUES ($1::uuid, $2::uuid, 'Anchored Shop', 'AFN', 0, $3)
	`, f.vaultID, f.ownerAcct, []byte(anchorPub)); err != nil {
		t.Fatalf("seed anchored vault: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, f.vaultID, f.ownerAcct); err != nil {
		t.Fatalf("seed owner membership: %v", err)
	}
	return f
}

func (f *m2Fixture) seedAccount(t *testing.T, email string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(context.Background(), `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, $2, TRUE, 'T')
		RETURNING id::text
	`, "sub-"+uuid.NewString(), email).Scan(&id); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	return id
}

// nextPMS hands out strictly increasing HLC physical times.
func (f *m2Fixture) nextPMS() int64 {
	f.pms++
	return f.pms
}

// membershipEvent builds an UNSIGNED membership push event authored on
// authorDeviceID at the next HLC tick. Callers sign it via signEvent.
func (f *m2Fixture) membershipEvent(
	eventType, authorDeviceID, actorAccountID, targetID string,
	payload map[string]any,
) PushEvent {
	raw, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	ev := PushEvent{
		EventID:       uuid.NewString(),
		HLC:           PushHLC{PhysicalMS: f.nextPMS(), Logical: 0, DeviceID: authorDeviceID},
		EventType:     eventType,
		SchemaVersion: 1,
		Payload:       raw,
	}
	if actorAccountID != "" {
		a := actorAccountID
		ev.ActorAccountID = &a
	}
	if targetID != "" {
		tgt := targetID
		ev.TargetID = &tgt
	}
	return ev
}

// signEvent stamps the event with its author signature + signer pubkey,
// exactly as the mobile signer would.
func (f *m2Fixture) signEvent(t *testing.T, ev *PushEvent, priv ed25519.PrivateKey) {
	t.Helper()
	canonicalBytes, err := canonicalSignableEvent(f.vaultID, ev)
	if err != nil {
		t.Fatalf("canonicalize signable event: %v", err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, canonicalBytes))
	pub := base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
	ev.EventSigB64 = &sig
	ev.SignerDevicePubkeyB64 = &pub
}

func (f *m2Fixture) pushAs(t *testing.T, accountID string, events ...PushEvent) *PushResponse {
	t.Helper()
	res, err := f.svc.PushEvents(context.Background(), PushInput{
		AccountID: accountID,
		VaultID:   f.vaultID,
		DeviceID:  f.anchorDeviceID,
		Events:    events,
	})
	if err != nil {
		t.Fatalf("PushEvents: %v", err)
	}
	return res
}

func (f *m2Fixture) vaultEpoch(t *testing.T) int64 {
	t.Helper()
	var epoch int64
	if err := f.pool.QueryRow(context.Background(), `
		SELECT vault_epoch FROM vaults WHERE vault_id = $1::uuid
	`, f.vaultID).Scan(&epoch); err != nil {
		t.Fatalf("read vault_epoch: %v", err)
	}
	return epoch
}

// memberRow reads the ACTIVE vault_members row for an account ("" = none).
func (f *m2Fixture) memberRow(t *testing.T, accountID string) string {
	t.Helper()
	var role string
	err := f.pool.QueryRow(context.Background(), `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
	`, f.vaultID, accountID).Scan(&role)
	if err != nil {
		return ""
	}
	return role
}

type deviceRow struct {
	accountID   string
	pubkey      []byte
	addedAtMS   int64
	removedAtMS *int64
	exists      bool
}

func (f *m2Fixture) deviceRow(t *testing.T, deviceID string) deviceRow {
	t.Helper()
	var d deviceRow
	err := f.pool.QueryRow(context.Background(), `
		SELECT account_id::text, device_pubkey, added_at_ms, removed_at_ms
		  FROM vault_devices
		 WHERE vault_id = $1::uuid AND device_id = $2::uuid
	`, f.vaultID, deviceID).Scan(&d.accountID, &d.pubkey, &d.addedAtMS, &d.removedAtMS)
	if err != nil {
		return deviceRow{}
	}
	d.exists = true
	return d
}

// deviceWitness builds the witness payload object the mobile invite-accept
// flow would attach, signed by the test's server key.
func (f *m2Fixture) deviceWitness(t *testing.T, accountID, deviceID, devicePubB64 string, issuedAtMS int64) map[string]any {
	t.Helper()
	canonicalBytes, err := canonical.Canonicalize(
		mesh.DeviceWitnessTuple(f.vaultID, accountID, deviceID, devicePubB64, issuedAtMS),
	)
	if err != nil {
		t.Fatalf("canonicalize witness tuple: %v", err)
	}
	return map[string]any{
		"sig_b64":       base64.StdEncoding.EncodeToString(ed25519.Sign(f.serverPriv, canonicalBytes)),
		"server_key_id": "primary",
		"issued_at_ms":  issuedAtMS,
	}
}

// memberWitness builds the witness payload object the mobile invite-accept
// flow attaches to a self-emitted vault_member_added, signed by the test's
// server key over the §8.1 member tuple.
func (f *m2Fixture) memberWitness(t *testing.T, accountID, inviterAccountID, role string, issuedAtMS int64) map[string]any {
	t.Helper()
	canonicalBytes, err := canonical.Canonicalize(
		mesh.MemberWitnessTuple(f.vaultID, accountID, inviterAccountID, role, issuedAtMS),
	)
	if err != nil {
		t.Fatalf("canonicalize member witness tuple: %v", err)
	}
	return map[string]any{
		"sig_b64":            base64.StdEncoding.EncodeToString(ed25519.Sign(f.serverPriv, canonicalBytes)),
		"server_key_id":      "primary",
		"issued_at_ms":       issuedAtMS,
		"inviter_account_id": inviterAccountID,
	}
}

func b64pub(priv ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
}

// auditKindAt reads the most recent vault_audit_log row for (target) whose
// occurred_at <= the given HLC ms, returning its kind ("" if none) — the
// same predicate roleAtHLC uses. Used to assert FIX 2 fold-audit rows land
// at the event's HLC.
func (f *m2Fixture) auditKindAt(t *testing.T, target string, hlcMS int64) string {
	t.Helper()
	var kind string
	err := f.pool.QueryRow(context.Background(), `
		SELECT kind FROM vault_audit_log
		 WHERE vault_id = $1::uuid AND target_id = $2::uuid
		   AND occurred_at <= to_timestamp($3::bigint / 1000.0)
		 ORDER BY occurred_at DESC, id DESC LIMIT 1
	`, f.vaultID, target, hlcMS).Scan(&kind)
	if err != nil {
		return ""
	}
	return kind
}

func requireAccepted(t *testing.T, res *PushResponse, n int) {
	t.Helper()
	if len(res.Accepted) != n || len(res.Rejected) != 0 {
		t.Fatalf("push = accepted:%d duplicates:%d rejected:%+v, want %d accepted",
			len(res.Accepted), len(res.Duplicates), res.Rejected, n)
	}
}

func requireRejectedUnverified(t *testing.T, res *PushResponse, eventID string) {
	t.Helper()
	if len(res.Accepted) != 0 || len(res.Rejected) != 1 {
		t.Fatalf("push = accepted:%d rejected:%+v, want exactly 1 rejection", len(res.Accepted), res.Rejected)
	}
	if res.Rejected[0].EventID != eventID || res.Rejected[0].Reason != RejectReasonMembershipUnverified {
		t.Fatalf("rejected[0] = %+v, want {%s membership_unverified}", res.Rejected[0], eventID)
	}
}

// ==========================================================================
// 1. Anchor-signed admissions
// ==========================================================================

// TestAnchorSignedMemberAddedAcceptedAndFolded: the chain-root flow. An
// owner-device (anchor) signed vault_member_added admits a staff account
// offline-QR style; the server verifies against the anchor, accepts, folds
// a vault_members row, bumps vault_epoch, and stores the sig material.
// Includes the genesis-shaped self-admission (owner, own account) which
// folds as a no-op against the creation-seeded owner row.
func TestAnchorSignedMemberAddedAcceptedAndFolded(t *testing.T) {
	f := newM2Fixture(t)
	staff := f.seedAccount(t, "staff@gmail.com")
	epochBefore := f.vaultEpoch(t)

	// Genesis-shaped self-admission (role owner, own account).
	genesis := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "role": "owner"})
	f.signEvent(t, &genesis, f.anchorPriv)

	// Staff admission.
	add := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &add, f.anchorPriv)

	res := f.pushAs(t, f.ownerAcct, genesis, add)
	requireAccepted(t, res, 2)

	if role := f.memberRow(t, staff); role != "editor" {
		t.Errorf("folded staff role = %q, want editor", role)
	}
	if role := f.memberRow(t, f.ownerAcct); role != "owner" {
		t.Errorf("owner role after self-admission fold = %q, want owner (idempotent)", role)
	}
	if epochAfter := f.vaultEpoch(t); epochAfter <= epochBefore {
		t.Errorf("vault_epoch = %d, want > %d (fold bumps like SetMemberRole)", epochAfter, epochBefore)
	}

	// Signature material persisted on the events row.
	var storedSig, storedPub *string
	if err := f.pool.QueryRow(context.Background(), `
		SELECT event_sig_b64, signer_device_pubkey FROM events WHERE event_id = $1::uuid
	`, add.EventID).Scan(&storedSig, &storedPub); err != nil {
		t.Fatalf("read stored sig: %v", err)
	}
	if storedSig == nil || *storedSig != *add.EventSigB64 {
		t.Errorf("stored event_sig_b64 = %v, want %s", storedSig, *add.EventSigB64)
	}
	if storedPub == nil || *storedPub != *add.SignerDevicePubkeyB64 {
		t.Errorf("stored signer_device_pubkey = %v, want %s", storedPub, *add.SignerDevicePubkeyB64)
	}
}

// TestForgedAnchorSignatureRejected (§9.1): a member_added signed by a key
// that is NOT the anchor (and not bound, and unwitnessed) is rejected even
// though the wire claims the anchor's pubkey would never verify it.
func TestForgedAnchorSignatureRejected(t *testing.T) {
	f := newM2Fixture(t)
	staff := f.seedAccount(t, "staff@gmail.com")
	_, roguePriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate rogue key: %v", err)
	}

	add := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &add, roguePriv)

	res := f.pushAs(t, f.ownerAcct, add)
	requireRejectedUnverified(t, res, add.EventID)
	if role := f.memberRow(t, staff); role != "" {
		t.Errorf("rejected event must not fold; staff role = %q", role)
	}
}

// ==========================================================================
// 2. Device binding: owner-signed, bound-device authority, witness path
// ==========================================================================

// TestOwnerSignedDeviceAddedAcceptedAndFolded: anchor-signed
// vault_device_added binds a second owner device into vault_devices; that
// second device's signature then carries owner authority for a
// role-change (the bound-device arm + roleAtHLC).
func TestOwnerSignedDeviceAddedAcceptedAndFolded(t *testing.T) {
	f := newM2Fixture(t)
	staff := f.seedAccount(t, "staff@gmail.com")

	// Bind owner device #2 — anchor-signed (QR path, owner present).
	_, dev2Priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate device2 key: %v", err)
	}
	dev2ID := uuid.NewString()
	bind := f.membershipEvent("vault_device_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "device_id": dev2ID, "device_pubkey": b64pub(dev2Priv)})
	f.signEvent(t, &bind, f.anchorPriv)

	// Staff admission so there is a member to re-role.
	add := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "viewer"})
	f.signEvent(t, &add, f.anchorPriv)

	requireAccepted(t, f.pushAs(t, f.ownerAcct, bind, add), 2)

	d := f.deviceRow(t, dev2ID)
	if !d.exists || d.accountID != f.ownerAcct || d.removedAtMS != nil {
		t.Fatalf("device2 fold = %+v, want bound to owner, unremoved", d)
	}
	if d.addedAtMS != bind.HLC.PhysicalMS {
		t.Errorf("device2 added_at_ms = %d, want event HLC %d", d.addedAtMS, bind.HLC.PhysicalMS)
	}

	// Device #2 (NOT the anchor) signs an owner-grade role change —
	// authorized via the vault_devices binding + roleAtHLC(owner).
	dev2Wire := uuid.NewString() // its own hlc.device_id
	reRole := f.membershipEvent("vault_member_role_changed", dev2Wire, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &reRole, dev2Priv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, reRole), 1)

	if role := f.memberRow(t, staff); role != "editor" {
		t.Errorf("staff role after bound-device re-role = %q, want editor", role)
	}
}

// TestWitnessedDeviceAddedAccepted: the online path — a staff member's new
// device self-signs its vault_device_added carrying a fresh server witness
// over the §8.1 device tuple. No owner signature anywhere in the event.
func TestWitnessedDeviceAddedAccepted(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	staff := f.seedAccount(t, "staff@gmail.com")
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, f.vaultID, staff, f.ownerAcct); err != nil {
		t.Fatalf("seed staff membership: %v", err)
	}

	_, devPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate staff device key: %v", err)
	}
	devID := uuid.NewString()
	devPub := b64pub(devPriv)

	ev := f.membershipEvent("vault_device_added", devID, staff, staff, nil)
	witness := f.deviceWitness(t, staff, devID, devPub, ev.HLC.PhysicalMS)
	payload, _ := json.Marshal(map[string]any{
		"account_id": staff, "device_id": devID, "device_pubkey": devPub, "witness": witness,
	})
	ev.Payload = payload
	f.signEvent(t, &ev, devPriv) // self-signed by the named device

	res := f.pushAs(t, staff, ev)
	requireAccepted(t, res, 1)

	d := f.deviceRow(t, devID)
	if !d.exists || d.accountID != staff || d.removedAtMS != nil {
		t.Fatalf("witnessed device fold = %+v, want bound to staff", d)
	}
}

// TestWitnessStaleRejected: same flow, but the witness was issued >7 days
// before the event HLC → "membership_unverified", no fold. (§2 freshness.)
func TestWitnessStaleRejected(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	staff := f.seedAccount(t, "staff@gmail.com")
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, f.vaultID, staff, f.ownerAcct); err != nil {
		t.Fatalf("seed staff membership: %v", err)
	}

	_, devPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate staff device key: %v", err)
	}
	devID := uuid.NewString()
	devPub := b64pub(devPriv)

	ev := f.membershipEvent("vault_device_added", devID, staff, staff, nil)
	staleIssued := ev.HLC.PhysicalMS - (8 * 24 * 60 * 60 * 1000) // 8 days old
	witness := f.deviceWitness(t, staff, devID, devPub, staleIssued)
	payload, _ := json.Marshal(map[string]any{
		"account_id": staff, "device_id": devID, "device_pubkey": devPub, "witness": witness,
	})
	ev.Payload = payload
	f.signEvent(t, &ev, devPriv)

	res := f.pushAs(t, staff, ev)
	requireRejectedUnverified(t, res, ev.EventID)
	if d := f.deviceRow(t, devID); d.exists {
		t.Errorf("stale-witness event must not fold, got %+v", d)
	}
}

// ==========================================================================
// 3. Non-owner authority (§9.2)
// ==========================================================================

// TestNonOwnerSignedMemberRemovedRejected: an editor's bound device signs a
// vault_member_removed against the owner — rejected (no anchor, no owner
// role at HLC, no witness rule for removals), and the owner survives.
func TestNonOwnerSignedMemberRemovedRejected(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	staff := f.seedAccount(t, "staff@gmail.com")
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, f.vaultID, staff, f.ownerAcct); err != nil {
		t.Fatalf("seed staff membership: %v", err)
	}
	_, staffPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate staff key: %v", err)
	}
	staffDevID := uuid.NewString()
	staffPub, _ := base64.StdEncoding.DecodeString(b64pub(staffPriv))
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_devices (vault_id, device_id, device_pubkey, account_id, added_at_ms)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)
	`, f.vaultID, staffDevID, staffPub, staff, f.nextPMS()); err != nil {
		t.Fatalf("seed staff device binding: %v", err)
	}

	coup := f.membershipEvent("vault_member_removed", staffDevID, staff, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct})
	f.signEvent(t, &coup, staffPriv)

	res := f.pushAs(t, staff, coup)
	requireRejectedUnverified(t, res, coup.EventID)
	if role := f.memberRow(t, f.ownerAcct); role != "owner" {
		t.Errorf("owner role after rejected coup = %q, want owner", role)
	}
}

// TestSelfSignedMemberRemovedIsAcceptedAsLeave: rule (b3) — a member's OWN
// bound device signing a vault_member_removed for the member's OWN account is
// the "leave kaata" flow and must be accepted + folded (membership revoked,
// devices removed), even though the signer is not an owner. Contrast with
// TestNonOwnerSignedMemberRemovedRejected above: same signer, different
// target — removing anyone ELSE stays owner-only.
func TestSelfSignedMemberRemovedIsAcceptedAsLeave(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	staff := f.seedAccount(t, "staff@gmail.com")
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, f.vaultID, staff, f.ownerAcct); err != nil {
		t.Fatalf("seed staff membership: %v", err)
	}
	_, staffPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate staff key: %v", err)
	}
	staffDevID := uuid.NewString()
	staffPub, _ := base64.StdEncoding.DecodeString(b64pub(staffPriv))
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_devices (vault_id, device_id, device_pubkey, account_id, added_at_ms)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)
	`, f.vaultID, staffDevID, staffPub, staff, f.nextPMS()); err != nil {
		t.Fatalf("seed staff device binding: %v", err)
	}

	leave := f.membershipEvent("vault_member_removed", staffDevID, staff, staff,
		map[string]any{"account_id": staff})
	f.signEvent(t, &leave, staffPriv)

	requireAccepted(t, f.pushAs(t, staff, leave), 1)
	if role := f.memberRow(t, staff); role != "" {
		t.Errorf("staff still active after self-leave fold: role %q", role)
	}
	d := f.deviceRow(t, staffDevID)
	if !d.exists || d.removedAtMS == nil {
		t.Errorf("staff device after self-leave = %+v, want removed", d)
	}

	// Last-owner guard survives the carve-out: the OWNER's own device
	// self-leaving as the sole owner is accepted into the log (replica-first)
	// but must NOT fold the vault into zero active owners.
	ownerLeave := f.membershipEvent("vault_member_removed", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct})
	f.signEvent(t, &ownerLeave, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, ownerLeave), 1)
	if role := f.memberRow(t, f.ownerAcct); role != "owner" {
		t.Errorf("sole owner revoked by self-leave fold: role %q, want owner", role)
	}
}

// TestOwnerSignedMemberRemovedFoldsMembershipAndDevices: the legitimate
// removal — anchor-signed — revokes the vault_members row AND removes all
// the account's devices (§2: removal takes the devices too).
func TestOwnerSignedMemberRemovedFoldsMembershipAndDevices(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	staff := f.seedAccount(t, "staff@gmail.com")
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, f.vaultID, staff, f.ownerAcct); err != nil {
		t.Fatalf("seed staff membership: %v", err)
	}
	staffDevID := uuid.NewString()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_devices (vault_id, device_id, device_pubkey, account_id, added_at_ms)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)
	`, f.vaultID, staffDevID, make([]byte, 32), staff, f.nextPMS()); err != nil {
		t.Fatalf("seed staff device: %v", err)
	}

	remove := f.membershipEvent("vault_member_removed", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff})
	f.signEvent(t, &remove, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, remove), 1)

	if role := f.memberRow(t, staff); role != "" {
		t.Errorf("staff still active after removal fold: role %q", role)
	}
	d := f.deviceRow(t, staffDevID)
	if !d.exists || d.removedAtMS == nil || *d.removedAtMS != remove.HLC.PhysicalMS {
		t.Errorf("staff device after member removal = %+v, want removed_at_ms %d", d, remove.HLC.PhysicalMS)
	}
}

// ==========================================================================
// 4. Legacy regression (anchor-less vaults / unsigned events)
// ==========================================================================

// TestLegacyUnsignedMembershipEventOnAnchorlessVault: pre-M2 behavior is
// byte-identical — an unsigned vault_member_added on a NULL-anchor vault is
// accepted via the JWT+roleAtHLC ACL (owner), and is NOT folded (the Phase 4
// endpoints remain the writers for legacy flows).
func TestLegacyUnsignedMembershipEventOnAnchorlessVault(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	// A second, anchor-less vault owned by the same account.
	legacyVault := uuid.NewString()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Legacy Shop', 'AFN', 0)
	`, legacyVault, f.ownerAcct); err != nil {
		t.Fatalf("seed legacy vault: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, legacyVault, f.ownerAcct); err != nil {
		t.Fatalf("seed legacy membership: %v", err)
	}
	staff := f.seedAccount(t, "staff@gmail.com")

	payload, _ := json.Marshal(map[string]any{"account_id": staff, "role": "editor"})
	tgt := staff
	ev := PushEvent{
		EventID:        uuid.NewString(),
		HLC:            PushHLC{PhysicalMS: f.nextPMS(), Logical: 0, DeviceID: f.anchorDeviceID},
		EventType:      "vault_member_added",
		SchemaVersion:  1,
		ActorAccountID: &f.ownerAcct,
		TargetID:       &tgt,
		Payload:        payload,
		// No event_sig_b64 / signer_device_pubkey: old client.
	}
	res, err := f.svc.PushEvents(ctx, PushInput{
		AccountID: f.ownerAcct,
		VaultID:   legacyVault,
		DeviceID:  f.anchorDeviceID,
		Events:    []PushEvent{ev},
	})
	if err != nil {
		t.Fatalf("PushEvents: %v", err)
	}
	if len(res.Accepted) != 1 || len(res.Rejected) != 0 {
		t.Fatalf("legacy push = %+v, want 1 accepted (JWT ACL regression)", res)
	}

	// NOT folded: vault_members untouched for legacy-path events.
	var active bool
	if err := f.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
		)
	`, legacyVault, staff).Scan(&active); err != nil {
		t.Fatalf("read fold state: %v", err)
	}
	if active {
		t.Errorf("legacy unsigned event must NOT fold into vault_members")
	}

	// And an editor pushing the same unsigned governance event still gets
	// the legacy insufficient_role rejection.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, legacyVault, staff, f.ownerAcct); err != nil {
		t.Fatalf("seed editor: %v", err)
	}
	payload2, _ := json.Marshal(map[string]any{"account_id": staff, "role": "owner"})
	ev2 := PushEvent{
		EventID:        uuid.NewString(),
		HLC:            PushHLC{PhysicalMS: f.nextPMS(), Logical: 0, DeviceID: uuid.NewString()},
		EventType:      "vault_member_role_changed",
		SchemaVersion:  1,
		ActorAccountID: &staff,
		TargetID:       &tgt,
		Payload:        payload2,
	}
	res2, err := f.svc.PushEvents(ctx, PushInput{
		AccountID: staff, VaultID: legacyVault, DeviceID: ev2.HLC.DeviceID, Events: []PushEvent{ev2},
	})
	if err != nil {
		t.Fatalf("PushEvents (editor): %v", err)
	}
	if len(res2.Rejected) != 1 || res2.Rejected[0].Reason != "insufficient_role" {
		t.Errorf("editor unsigned governance push = %+v, want insufficient_role", res2)
	}
}

// TestLegacySelfLeaveOnAnchorlessVaultAcceptedAndFolded: the legacy-path
// self-leave allowance — a member's OWN vault_member_removed (target ==
// pushing JWT account) on an anchor-less vault is accepted WITHOUT owner
// role and folded (revoked_at set), matching what the REST /leave endpoint
// does. Removing anyone ELSE stays owner-only (forged actor_account_id
// cannot widen it — authorization keys on the SESSION account).
func TestLegacySelfLeaveOnAnchorlessVaultAcceptedAndFolded(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	legacyVault := uuid.NewString()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Legacy Shop', 'AFN', 0)
	`, legacyVault, f.ownerAcct); err != nil {
		t.Fatalf("seed legacy vault: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, legacyVault, f.ownerAcct); err != nil {
		t.Fatalf("seed legacy owner membership: %v", err)
	}
	staff := f.seedAccount(t, "staff@gmail.com")
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, legacyVault, staff, f.ownerAcct); err != nil {
		t.Fatalf("seed staff membership: %v", err)
	}

	// Staff self-leave, unsigned (legacy path), pushed under staff's own JWT.
	payload, _ := json.Marshal(map[string]any{"account_id": staff})
	tgt := staff
	leave := PushEvent{
		EventID:        uuid.NewString(),
		HLC:            PushHLC{PhysicalMS: f.nextPMS(), Logical: 0, DeviceID: uuid.NewString()},
		EventType:      "vault_member_removed",
		SchemaVersion:  1,
		ActorAccountID: &staff,
		TargetID:       &tgt,
		Payload:        payload,
	}
	res, err := f.svc.PushEvents(ctx, PushInput{
		AccountID: staff, VaultID: legacyVault, DeviceID: leave.HLC.DeviceID,
		Events: []PushEvent{leave},
	})
	if err != nil {
		t.Fatalf("PushEvents (self-leave): %v", err)
	}
	if len(res.Accepted) != 1 || len(res.Rejected) != 0 {
		t.Fatalf("legacy self-leave push = %+v, want 1 accepted", res)
	}
	var active bool
	if err := f.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
		)
	`, legacyVault, staff).Scan(&active); err != nil {
		t.Fatalf("read fold state: %v", err)
	}
	if active {
		t.Errorf("legacy self-leave must FOLD (revoke the membership row)")
	}

	// A second editor pushing a removal of ANOTHER member (spoofed
	// actor_account_id = owner) is NOT self-leave for the pushing session.
	// PRE-EXISTING legacy-path property (unchanged by this diff): the
	// unsigned-event ACL trusts the wire's actor_account_id, so the event is
	// ACCEPTED into the log — but the session-account guard keeps
	// legacySelfLeave false, so it must NOT fold: the owner's membership row
	// survives. (Wire-actor authentication is exactly what the M2 chain
	// replaced the legacy path for.)
	staff2 := f.seedAccount(t, "staff2@gmail.com")
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, legacyVault, staff2, f.ownerAcct); err != nil {
		t.Fatalf("seed staff2 membership: %v", err)
	}
	coupPayload, _ := json.Marshal(map[string]any{"account_id": f.ownerAcct})
	ownerTgt := f.ownerAcct
	coup := PushEvent{
		EventID:        uuid.NewString(),
		HLC:            PushHLC{PhysicalMS: f.nextPMS(), Logical: 0, DeviceID: uuid.NewString()},
		EventType:      "vault_member_removed",
		SchemaVersion:  1,
		ActorAccountID: &ownerTgt, // spoofed: claims the owner authored it
		TargetID:       &ownerTgt,
		Payload:        coupPayload,
	}
	res2, err := f.svc.PushEvents(ctx, PushInput{
		AccountID: staff2, VaultID: legacyVault, DeviceID: coup.HLC.DeviceID,
		Events: []PushEvent{coup},
	})
	if err != nil {
		t.Fatalf("PushEvents (coup): %v", err)
	}
	if len(res2.Accepted) != 1 {
		t.Fatalf("spoofed-actor removal = %+v, want legacy log-accept without fold", res2)
	}
	var ownerActive bool
	if err := f.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
		)
	`, legacyVault, f.ownerAcct).Scan(&ownerActive); err != nil {
		t.Fatalf("read owner state: %v", err)
	}
	if !ownerActive {
		t.Errorf("owner revoked by spoofed legacy removal — session-account guard failed")
	}
}

// ==========================================================================
// 5. vault_devices fold lifecycle
// ==========================================================================

// TestVaultDevicesFoldAddRemoveReAdd: add → remove → re-add converges to a
// live binding with refreshed added_at_ms and cleared removed_at_ms.
func TestVaultDevicesFoldAddRemoveReAdd(t *testing.T) {
	f := newM2Fixture(t)

	_, devPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate device key: %v", err)
	}
	devID := uuid.NewString()
	devPub := b64pub(devPriv)

	add := f.membershipEvent("vault_device_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "device_id": devID, "device_pubkey": devPub})
	f.signEvent(t, &add, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, add), 1)
	if d := f.deviceRow(t, devID); !d.exists || d.removedAtMS != nil || d.addedAtMS != add.HLC.PhysicalMS {
		t.Fatalf("after add: %+v", d)
	}

	remove := f.membershipEvent("vault_device_removed", f.anchorDeviceID, f.ownerAcct, "",
		map[string]any{"device_id": devID})
	f.signEvent(t, &remove, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, remove), 1)
	if d := f.deviceRow(t, devID); !d.exists || d.removedAtMS == nil || *d.removedAtMS != remove.HLC.PhysicalMS {
		t.Fatalf("after remove: %+v, want removed_at_ms %d", d, remove.HLC.PhysicalMS)
	}

	// The removed device's own signature must carry no authority now: it
	// cannot re-add itself (no anchor, binding removed, no witness).
	selfReAdd := f.membershipEvent("vault_device_added", devID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "device_id": devID, "device_pubkey": devPub})
	f.signEvent(t, &selfReAdd, devPriv)
	requireRejectedUnverified(t, f.pushAs(t, f.ownerAcct, selfReAdd), selfReAdd.EventID)

	reAdd := f.membershipEvent("vault_device_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "device_id": devID, "device_pubkey": devPub})
	f.signEvent(t, &reAdd, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, reAdd), 1)
	d := f.deviceRow(t, devID)
	if !d.exists || d.removedAtMS != nil || d.addedAtMS != reAdd.HLC.PhysicalMS {
		t.Fatalf("after re-add: %+v, want live binding at %d", d, reAdd.HLC.PhysicalMS)
	}
}

// ==========================================================================
// 6. Wire round-trip + canonical pinning
// ==========================================================================

// TestEventSigRoundTripsOnPull: signature material survives push → pull
// verbatim; legacy rows serialize the keys as null (present, not omitted).
func TestEventSigRoundTripsOnPull(t *testing.T) {
	f := newM2Fixture(t)
	staff := f.seedAccount(t, "staff@gmail.com")

	signed := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &signed, f.anchorPriv)

	legacy := PushEvent{
		EventID:        uuid.NewString(),
		HLC:            PushHLC{PhysicalMS: f.nextPMS(), Logical: 0, DeviceID: f.anchorDeviceID},
		EventType:      "entry_created",
		SchemaVersion:  1,
		ActorAccountID: &f.ownerAcct,
		Payload:        json.RawMessage(`{}`),
	}
	requireAccepted(t, f.pushAs(t, f.ownerAcct, signed, legacy), 2)

	res, err := f.svc.PullEvents(context.Background(), PullInput{
		AccountID: f.ownerAcct, VaultID: f.vaultID, Limit: 100,
	})
	if err != nil {
		t.Fatalf("PullEvents: %v", err)
	}
	byID := map[string]PulledEvent{}
	for _, ev := range res.Events {
		byID[ev.EventID] = ev
	}

	got := byID[signed.EventID]
	if got.EventSigB64 == nil || *got.EventSigB64 != *signed.EventSigB64 {
		t.Errorf("pulled event_sig_b64 = %v, want %s", got.EventSigB64, *signed.EventSigB64)
	}
	if got.SignerDevicePubkey == nil || *got.SignerDevicePubkey != *signed.SignerDevicePubkeyB64 {
		t.Errorf("pulled signer_device_pubkey = %v, want %s", got.SignerDevicePubkey, *signed.SignerDevicePubkeyB64)
	}

	raw, err := json.Marshal(byID[legacy.EventID])
	if err != nil {
		t.Fatalf("marshal pulled legacy event: %v", err)
	}
	if !strings.Contains(string(raw), `"event_sig_b64":null`) ||
		!strings.Contains(string(raw), `"signer_device_pubkey":null`) {
		t.Errorf("legacy pulled event must serialize sig keys as null, got %s", raw)
	}
}

// ==========================================================================
// 7. SEC FIX 1 — batch-order independence
// ==========================================================================

// rejectedReason returns the reject reason for eventID in res, or "" if the
// event was not rejected.
func rejectedReason(res *PushResponse, eventID string) string {
	for _, r := range res.Rejected {
		if r.EventID == eventID {
			return r.Reason
		}
	}
	return ""
}

func accepted(res *PushResponse, eventID string) bool {
	for _, a := range res.Accepted {
		if a.EventID == eventID {
			return true
		}
	}
	return false
}

// TestBatchOrderIndependence (SEC FIX 1): a batch containing an
// anchor-signed vault_member_added of X and an anchor-signed
// vault_member_removed of X folds to the same FINAL state regardless of WIRE
// order — because the push loop sorts by (HLC, event_id) before verify+fold.
// We construct the removal at a STRICTLY HIGHER HLC than the admission, so
// the lawful fold order is admission-then-removal: X is admitted (its
// admission evaluated against pre-removal state) and then removed. Both wire
// permutations must converge: X ends up removed, both events accepted.
func TestBatchOrderIndependence(t *testing.T) {
	run := func(t *testing.T, removalFirstOnWire bool) {
		f := newM2Fixture(t)
		x := f.seedAccount(t, "x@gmail.com")

		add := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, x,
			map[string]any{"account_id": x, "role": "editor"})
		// Force removal to a higher HLC than the admission.
		remove := f.membershipEvent("vault_member_removed", f.anchorDeviceID, f.ownerAcct, x,
			map[string]any{"account_id": x})
		if remove.HLC.PhysicalMS <= add.HLC.PhysicalMS {
			remove.HLC.PhysicalMS = add.HLC.PhysicalMS + 1
		}
		f.signEvent(t, &add, f.anchorPriv)
		f.signEvent(t, &remove, f.anchorPriv)

		var res *PushResponse
		if removalFirstOnWire {
			res = f.pushAs(t, f.ownerAcct, remove, add)
		} else {
			res = f.pushAs(t, f.ownerAcct, add, remove)
		}

		// Both events accepted into the log in either wire order.
		if !accepted(res, add.EventID) || !accepted(res, remove.EventID) {
			t.Fatalf("both events must be accepted, got %+v", res)
		}
		// Deterministic FINAL state: X removed.
		if role := f.memberRow(t, x); role != "" {
			t.Errorf("final state: X must be removed, got role %q (removalFirstOnWire=%v)", role, removalFirstOnWire)
		}
	}

	t.Run("admit_then_remove_on_wire", func(t *testing.T) { run(t, false) })
	t.Run("remove_then_admit_on_wire", func(t *testing.T) { run(t, true) })
}

// ==========================================================================
// 8. SEC FIX 2 — chain folds feed lawful-at-HLC role resolution
// ==========================================================================

// TestChainDemotionIsLawfulAtHLC (SEC FIX 2 / invariant #3): after a chain
// vault_member_role_changed demotes an editor's account to viewer at HLC T,
// an editor-grade event that account AUTHORED at HLC < T is still accepted
// (lawful-at-HLC), and one it authored at HLC > T is rejected. This only
// holds if foldMembershipEvent wrote a vault_audit_log row at occurred_at=T
// so roleAtHLC reconstructs the chain-driven role instead of falling back to
// the current (demoted) role for every event.
func TestChainDemotionIsLawfulAtHLC(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	staff := f.seedAccount(t, "staff@gmail.com")

	// Staff bound device — it will author ledger events.
	_, staffPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate staff key: %v", err)
	}
	staffDevID := uuid.NewString()
	staffWireDev := uuid.NewString()

	// 1. Owner admits staff as editor (chain), then binds staff's device.
	admit := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &admit, f.anchorPriv)
	bind := f.membershipEvent("vault_device_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "device_id": staffDevID, "device_pubkey": b64pub(staffPriv)})
	f.signEvent(t, &bind, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, admit, bind), 2)

	admitT := admit.HLC.PhysicalMS

	// 2. Owner demotes staff editor → viewer at HLC T, well after admission
	// (leave a window between admit and demote for the "before T" event).
	demote := f.membershipEvent("vault_member_role_changed", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "viewer"})
	demote.HLC.PhysicalMS = admitT + 1000 // clear window above the admission
	f.signEvent(t, &demote, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, demote), 1)
	demoteT := demote.HLC.PhysicalMS

	// FIX 2: a fold-audit row must exist for staff at occurred_at = T.
	if kind := f.auditKindAt(t, staff, demoteT); kind != "role_changed" {
		t.Fatalf("expected a role_changed fold-audit row at HLC %d, got kind %q", demoteT, kind)
	}
	if role := f.memberRow(t, staff); role != "viewer" {
		t.Fatalf("staff current role after demote = %q, want viewer", role)
	}

	// 3. An editor-grade ledger event AUTHORED BEFORE T is still accepted
	// (lawful-at-HLC: staff was an editor then).
	beforeT := demoteT - 5
	preEvent := PushEvent{
		EventID:        uuid.NewString(),
		HLC:            PushHLC{PhysicalMS: beforeT, Logical: 0, DeviceID: staffWireDev},
		EventType:      "entry_created",
		SchemaVersion:  1,
		ActorAccountID: &staff,
		Payload:        json.RawMessage(`{}`),
	}
	resPre, err := f.svc.PushEvents(ctx, PushInput{
		AccountID: staff, VaultID: f.vaultID, DeviceID: staffWireDev, Events: []PushEvent{preEvent},
	})
	if err != nil {
		t.Fatalf("push pre-demote event: %v", err)
	}
	if !accepted(resPre, preEvent.EventID) {
		t.Errorf("pre-demote editor event must be accepted (lawful-at-HLC), got %+v", resPre)
	}

	// 4. An editor-grade event AUTHORED AFTER T is rejected (viewer then).
	afterT := demoteT + 5
	postEvent := PushEvent{
		EventID:        uuid.NewString(),
		HLC:            PushHLC{PhysicalMS: afterT, Logical: 0, DeviceID: staffWireDev},
		EventType:      "entry_created",
		SchemaVersion:  1,
		ActorAccountID: &staff,
		Payload:        json.RawMessage(`{}`),
	}
	resPost, err := f.svc.PushEvents(ctx, PushInput{
		AccountID: staff, VaultID: f.vaultID, DeviceID: staffWireDev, Events: []PushEvent{postEvent},
	})
	if err != nil {
		t.Fatalf("push post-demote event: %v", err)
	}
	if accepted(resPost, postEvent.EventID) {
		t.Errorf("post-demote editor event must be REJECTED (viewer at HLC), got accepted: %+v", resPost)
	}
	if r := rejectedReason(resPost, postEvent.EventID); r != "insufficient_role" {
		t.Errorf("post-demote rejection reason = %q, want insufficient_role", r)
	}
}

// ==========================================================================
// 9. SEC FIX 3 — witnessed admission can never mint an owner
// ==========================================================================

// TestWitnessedMemberAddedOwnerRejected (SEC FIX 3): a self-emitted
// vault_member_added carrying a VALID server witness but role=owner is
// rejected with membership_unverified — a witness can never create an owner.
// The same event with role=editor (everything else identical) is accepted,
// proving it's the owner role specifically that's capped, not the witness.
func TestWitnessedMemberAddedOwnerRejected(t *testing.T) {
	f := newM2Fixture(t)

	// A relay (the owner) pushes self-emitted witnessed admissions on behalf
	// of two freshly-invited accounts. The pusher must be a member to push;
	// the admission's account is whoever the witness names — that's the
	// attack surface FIX 3 caps.
	build := func(t *testing.T, account string, priv ed25519.PrivateKey, role string) PushEvent {
		ev := f.membershipEvent("vault_member_added", uuid.NewString(), account, account, nil)
		w := f.memberWitness(t, account, f.ownerAcct, role, ev.HLC.PhysicalMS)
		payload, _ := json.Marshal(map[string]any{
			"account_id": account, "role": role, "witness": w,
		})
		ev.Payload = payload
		f.signEvent(t, &ev, priv)
		return ev
	}

	// role=owner with a witness signed over the owner tuple → rejected.
	ownerInvitee := f.seedAccount(t, "ownerinvitee@gmail.com")
	_, ownerPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	ownerEv := build(t, ownerInvitee, ownerPriv, "owner")
	resOwner := f.pushAs(t, f.ownerAcct, ownerEv)
	requireRejectedUnverified(t, resOwner, ownerEv.EventID)
	if role := f.memberRow(t, ownerInvitee); role != "" {
		t.Errorf("witnessed owner admission must not fold; account role = %q", role)
	}

	// role=editor, otherwise identical flow → accepted (control: the witness
	// path itself works; only the owner role is capped).
	editorInvitee := f.seedAccount(t, "editorinvitee@gmail.com")
	_, editorPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	editorEv := build(t, editorInvitee, editorPriv, "editor")
	resEditor := f.pushAs(t, f.ownerAcct, editorEv)
	requireAccepted(t, resEditor, 1)
	if role := f.memberRow(t, editorInvitee); role != "editor" {
		t.Errorf("witnessed editor admission must fold; account role = %q, want editor", role)
	}
}

// ==========================================================================
// 10. SEC FIX 5 — witnessed device-add requires an active member
// ==========================================================================

// TestWitnessedDeviceAddedNonMemberRejected (SEC FIX 5): a witnessed
// vault_device_added whose named account is NOT an active member is rejected
// with membership_unverified, mirroring the mobile fold's
// unknown_member_account refusal. A device witness proves device control,
// not a vault seat.
func TestWitnessedDeviceAddedNonMemberRejected(t *testing.T) {
	f := newM2Fixture(t)

	// Outsider account with NO vault_members row.
	outsider := f.seedAccount(t, "outsider@gmail.com")
	_, devPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate device key: %v", err)
	}
	devID := uuid.NewString()
	devPub := b64pub(devPriv)

	ev := f.membershipEvent("vault_device_added", devID, outsider, outsider, nil)
	witness := f.deviceWitness(t, outsider, devID, devPub, ev.HLC.PhysicalMS)
	payload, _ := json.Marshal(map[string]any{
		"account_id": outsider, "device_id": devID, "device_pubkey": devPub, "witness": witness,
	})
	ev.Payload = payload
	f.signEvent(t, &ev, devPriv) // self-signed by the named device, valid witness

	// Relayed by the owner (a member): the pusher is authorized to push, but
	// the event names a NON-member account — FIX 5 must refuse the binding.
	res := f.pushAs(t, f.ownerAcct, ev)
	requireRejectedUnverified(t, res, ev.EventID)
	if d := f.deviceRow(t, devID); d.exists {
		t.Errorf("non-member witnessed device must not fold, got %+v", d)
	}
}

// ==========================================================================
// 11. SEC FIX 4 — HLC arbitration: stale chain change does not clobber
// ==========================================================================

// TestStaleChainRoleChangeDoesNotClobber (SEC FIX 4): a newer chain
// role_change wins; a STALE chain role_change (lower HLC) arriving afterward
// must NOT clobber it. We apply a demote→editor at HLC T2, then push an
// older promote→owner at HLC T1 < T2. The older event is accepted into the
// log (replica-first) but its fold is skipped by the last_change_hlc_ms
// guard, so the member stays editor.
func TestStaleChainRoleChangeDoesNotClobber(t *testing.T) {
	f := newM2Fixture(t)

	staff := f.seedAccount(t, "staff@gmail.com")
	admit := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "viewer"})
	f.signEvent(t, &admit, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, admit), 1)

	// Newer change first: viewer → editor at HLC T2.
	newer := f.membershipEvent("vault_member_role_changed", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &newer, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, newer), 1)
	if role := f.memberRow(t, staff); role != "editor" {
		t.Fatalf("after newer role_change, staff = %q, want editor", role)
	}

	// Stale change: a role_change at an HLC BEFORE T2 (promote → owner). It
	// is signed validly by the anchor, so it's authorized and accepted into
	// the log — but its fold must lose the HLC arbitration and NOT clobber
	// the editor role.
	stale := f.membershipEvent("vault_member_role_changed", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "owner"})
	stale.HLC.PhysicalMS = newer.HLC.PhysicalMS - 100 // strictly older
	f.signEvent(t, &stale, f.anchorPriv)
	res := f.pushAs(t, f.ownerAcct, stale)
	if !accepted(res, stale.EventID) {
		t.Fatalf("stale event must still be accepted into the log, got %+v", res)
	}
	if role := f.memberRow(t, staff); role != "editor" {
		t.Errorf("stale chain role_change clobbered newer state: staff = %q, want editor", role)
	}
}

// TestCanonicalSignableEventHandBuilt pins the Go event canonicalization
// against a string assembled by hand (no shared code with the production
// canonicalizer), so a drift in internal/canonical cannot self-validate.
// The same bytes are what mobile lib/event-sig.ts canonicalizeEvent emits.
func TestCanonicalSignableEventHandBuilt(t *testing.T) {
	actor := "a1b2c3d4-0000-4000-8000-000000000001"
	target := "a1b2c3d4-0000-4000-8000-000000000006"
	dev := "a1b2c3d4-0000-4000-8000-000000000002"
	vault := "a1b2c3d4-0000-4000-8000-000000000003"
	ev := PushEvent{
		EventID:        "a1b2c3d4-0000-4000-8000-000000000005",
		HLC:            PushHLC{PhysicalMS: 1750000000000, Logical: 2, DeviceID: dev},
		EventType:      "vault_member_removed",
		SchemaVersion:  1,
		ActorAccountID: &actor,
		TargetID:       &target,
		Payload:        json.RawMessage(`{"account_id":"a1b2c3d4-0000-4000-8000-000000000006"}`),
	}
	got, err := canonicalSignableEvent(vault, &ev)
	if err != nil {
		t.Fatalf("canonicalSignableEvent: %v", err)
	}
	want := `{"actor_account_id":"` + actor + `",` +
		`"device_id":"` + dev + `",` +
		`"event_id":"a1b2c3d4-0000-4000-8000-000000000005",` +
		`"event_type":"vault_member_removed",` +
		`"hlc":{"did":"` + dev + `","l":2,"pms":1750000000000},` +
		`"payload":{"account_id":"` + target + `"},` +
		`"payload_schema":1,` +
		`"relationship_id":null,` +
		`"target_id":"` + target + `",` +
		`"vault_id":"` + vault + `"}`
	if string(got) != want {
		t.Errorf("canonical mismatch:\n got %s\nwant %s", got, want)
	}
}

// ==========================================================================
// M5: snapshot carries the trust anchor + the FULL membership chain
// ==========================================================================

// TestSnapshotCarriesAnchorAndMembershipChain (docs/m5-recovery.md §3.1): a
// recovering device restores from GET /v1/sync/snapshot, which must now (a)
// pin the ORIGINAL trust anchor (not adopt itself) and (b) carry the vault's
// FULL membership chain in HLC order REGARDLESS of the snapshot cursor — the
// chain events live at or below up_to_server_seq, so the cursor-bound tail
// alone never carries them. We plant the snapshot cursor ABOVE every event so
// the tail is empty, proving membership_events is cursor-independent.
func TestSnapshotCarriesAnchorAndMembershipChain(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()
	staff := f.seedAccount(t, "staff@gmail.com")

	// A three-event membership chain: genesis (owner self-admit) →
	// staff member_added → owner device #2 bind.
	genesis := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "role": "owner"})
	f.signEvent(t, &genesis, f.anchorPriv)

	add := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &add, f.anchorPriv)

	_, dev2Priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate device2 key: %v", err)
	}
	dev2ID := uuid.NewString()
	bind := f.membershipEvent("vault_device_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "device_id": dev2ID, "device_pubkey": b64pub(dev2Priv)})
	f.signEvent(t, &bind, f.anchorPriv)

	requireAccepted(t, f.pushAs(t, f.ownerAcct, genesis, add, bind), 3)

	// Plant an empty snapshot at a cursor ABOVE every event's server_seq, so
	// the post-cursor tail is empty. membership_events must STILL carry the
	// chain — that's the whole point.
	var maxSeq int64
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) FROM events WHERE vault_id = $1::uuid
	`, f.vaultID).Scan(&maxSeq); err != nil {
		t.Fatalf("read max server_seq: %v", err)
	}
	emptyProjection, err := ProjectionToJSON(NewProjection())
	if err != nil {
		t.Fatalf("serialize empty projection: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_snapshots (vault_id, up_to_server_seq, snapshot, schema_version, byte_size)
		VALUES ($1::uuid, $2, $3::jsonb, $4, $5)
	`, f.vaultID, maxSeq, string(emptyProjection), SnapshotSchemaVersion, len(emptyProjection)); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}

	snap, err := f.svc.LatestSnapshot(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("LatestSnapshot: %v", err)
	}

	// (a) The original anchor is pinned, std-base64 of the seeded anchor pub.
	wantAnchor := base64.StdEncoding.EncodeToString(f.anchorPub)
	if snap.Vault.VaultTrustAnchorPubkey == nil {
		t.Fatalf("snapshot vault_trust_anchor_pubkey is nil, want %s", wantAnchor)
	}
	if *snap.Vault.VaultTrustAnchorPubkey != wantAnchor {
		t.Errorf("snapshot anchor = %s, want %s", *snap.Vault.VaultTrustAnchorPubkey, wantAnchor)
	}

	// (b) The tail is empty (cursor is above everything) but the membership
	// chain is fully present — proving membership_events ignores the cursor.
	if len(snap.Events) != 0 {
		t.Errorf("snapshot tail = %d events, want 0 (cursor above all)", len(snap.Events))
	}
	if len(snap.MembershipEvents) != 3 {
		t.Fatalf("membership_events = %d, want 3 (genesis, add, bind)", len(snap.MembershipEvents))
	}

	// HLC order: genesis < add < bind (membershipEvent ticks nextPMS).
	wantOrder := []string{genesis.EventID, add.EventID, bind.EventID}
	for i, ev := range snap.MembershipEvents {
		if ev.EventID != wantOrder[i] {
			t.Errorf("membership_events[%d] = %s, want %s (HLC order)", i, ev.EventID, wantOrder[i])
		}
		if !IsMembershipEventType(ev.EventType) {
			t.Errorf("membership_events[%d] type = %q is not a membership type", i, ev.EventType)
		}
		// Signature material must round-trip so the recovering device can
		// verify the chain end-to-end.
		if ev.EventSigB64 == nil || ev.SignerDevicePubkey == nil {
			t.Errorf("membership_events[%d] missing sig material: sig=%v pub=%v",
				i, ev.EventSigB64, ev.SignerDevicePubkey)
		}
	}

	// Wire contract: the key is present and is a non-null array even when the
	// chain is non-empty (mobile iterates without a null guard).
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	if !strings.Contains(string(raw), `"membership_events":[`) {
		t.Errorf("snapshot must serialize membership_events as an array, got %s", raw)
	}
}
