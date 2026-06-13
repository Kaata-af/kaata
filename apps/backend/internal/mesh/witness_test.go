package mesh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/testutil"
)

const testJWTSecret = "0123456789abcdef0123456789abcdef"

// witnessFixture: one vault, an owner account whose membership is
// self-seeded (vault-creation style), and the server signing keypair —
// generated fresh per test so signatures can be verified in-test.
type witnessFixture struct {
	pool       *pgxpool.Pool
	svc        *Service
	router     http.Handler
	serverPub  ed25519.PublicKey
	vaultID    string
	ownerAcct  string
	ownerInst  string
	ownerDevB  string // base64 of the owner's registered device pubkey
	ownerPriv  ed25519.PrivateKey
	ownerEmail string
}

func newWitnessFixture(t *testing.T) *witnessFixture {
	t.Helper()
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	serverPub, serverPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate server key: %v", err)
	}
	svc := NewService(pool, serverPriv, base64.StdEncoding.EncodeToString(serverPub), "")
	h := NewHandler(svc)

	r := chi.NewRouter()
	r.Group(func(pr chi.Router) {
		pr.Use(auth.RequireSession(testJWTSecret))
		pr.Post("/v1/vaults/{vault_id}/witness", h.Witness)
	})

	f := &witnessFixture{
		pool:       pool,
		svc:        svc,
		router:     r,
		serverPub:  serverPub,
		vaultID:    uuid.NewString(),
		ownerInst:  uuid.NewString(),
		ownerEmail: "owner@gmail.com",
	}

	f.ownerAcct = f.seedAccount(t, f.ownerEmail)
	f.seedInstall(t, f.ownerInst)
	devPub, devPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate device key: %v", err)
	}
	f.ownerPriv = devPriv
	f.ownerDevB = base64.StdEncoding.EncodeToString(devPub)
	if err := svc.RegisterKey(ctx, f.ownerInst, devPub); err != nil {
		t.Fatalf("register device key: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Witness Shop', 'AFN', 0)
	`, f.vaultID, f.ownerAcct); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	// Owner row, vault-creation style: invited_by = self, no invite_email.
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, f.vaultID, f.ownerAcct); err != nil {
		t.Fatalf("seed owner membership: %v", err)
	}
	return f
}

func (f *witnessFixture) seedAccount(t *testing.T, email string) string {
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

func (f *witnessFixture) seedInstall(t *testing.T, installID string) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(), `
		INSERT INTO installs (install_id) VALUES ($1::uuid)
	`, installID); err != nil {
		t.Fatalf("seed install: %v", err)
	}
}

// post fires POST /v1/vaults/{vault}/witness. withAuth="" means no header.
func (f *witnessFixture) post(t *testing.T, vaultID, accountID, installID string, withAuth bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/vaults/"+vaultID+"/witness", nil)
	if withAuth {
		tok, err := auth.SignSession(testJWTSecret, accountID, installID, "google", "sub-x")
		if err != nil {
			t.Fatalf("mint jwt: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	return rec
}

type witnessWireResponse struct {
	ServerKeyID   string `json:"server_key_id"`
	DeviceWitness struct {
		SigB64     string `json:"sig_b64"`
		IssuedAtMS int64  `json:"issued_at_ms"`
	} `json:"device_witness"`
	MemberWitness *struct {
		SigB64           string `json:"sig_b64"`
		IssuedAtMS       int64  `json:"issued_at_ms"`
		InviterAccountID string `json:"inviter_account_id"`
		Role             string `json:"role"`
	} `json:"member_witness"`
}

func verifyTupleSig(t *testing.T, pub ed25519.PublicKey, tuple map[string]any, sigB64 string) {
	t.Helper()
	canonicalBytes, err := canonical.Canonicalize(tuple)
	if err != nil {
		t.Fatalf("canonicalize tuple: %v", err)
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		t.Fatalf("decode sig: %v", err)
	}
	if !ed25519.Verify(pub, canonicalBytes, sig) {
		t.Errorf("signature does not verify over canonical tuple %s", canonicalBytes)
	}
}

// TestWitnessDeviceRoundTrip: the owner gets a device witness whose
// signature verifies, in-test, against the server pubkey over the §8.1
// canonical tuple — and NO member witness (self-seeded owner row is not a
// brokered invite).
func TestWitnessDeviceRoundTrip(t *testing.T) {
	f := newWitnessFixture(t)

	rec := f.post(t, f.vaultID, f.ownerAcct, f.ownerInst, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST witness = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var res witnessWireResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if res.ServerKeyID != "primary" {
		t.Errorf("server_key_id = %q, want primary", res.ServerKeyID)
	}
	if res.DeviceWitness.IssuedAtMS <= 0 {
		t.Errorf("device_witness.issued_at_ms = %d, want > 0", res.DeviceWitness.IssuedAtMS)
	}
	verifyTupleSig(t, f.serverPub,
		DeviceWitnessTuple(f.vaultID, f.ownerAcct, f.ownerInst, f.ownerDevB, res.DeviceWitness.IssuedAtMS),
		res.DeviceWitness.SigB64,
	)
	if res.MemberWitness != nil {
		t.Errorf("owner must get member_witness = null, got %+v", *res.MemberWitness)
	}
	// Wire contract: the member_witness key must be present (null), not
	// omitted.
	if body := rec.Body.String(); !jsonHasNullKey(body, "member_witness") {
		t.Errorf("response must carry member_witness:null, got %s", body)
	}
}

func jsonHasNullKey(body, key string) bool {
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		return false
	}
	raw, ok := m[key]
	return ok && string(raw) == "null"
}

// TestWitnessMemberWitnessForInvitedMember: an accepted brokered-invite
// member gets BOTH witnesses; the member witness names the inviter and
// role and verifies over the canonical member tuple.
func TestWitnessMemberWitnessForInvitedMember(t *testing.T) {
	f := newWitnessFixture(t)
	ctx := context.Background()

	memberAcct := f.seedAccount(t, "member@gmail.com")
	memberInst := uuid.NewString()
	f.seedInstall(t, memberInst)
	memPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate member device key: %v", err)
	}
	if err := f.svc.RegisterKey(ctx, memberInst, memPub); err != nil {
		t.Fatalf("register member key: %v", err)
	}
	// Accepted invite row: invited_by = owner (≠ self), invite_email set.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (
			vault_id, account_id, role, invited_by, invited_at,
			invite_email, invite_token_hash, invite_expires_at, accepted_at
		) VALUES ($1::uuid, $2::uuid, 'editor', $3::uuid, NOW(),
		          'member@gmail.com', 'testhash-'||$2, NOW() + INTERVAL '7 days', NOW())
	`, f.vaultID, memberAcct, f.ownerAcct); err != nil {
		t.Fatalf("seed invited membership: %v", err)
	}

	rec := f.post(t, f.vaultID, memberAcct, memberInst, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST witness = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var res witnessWireResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if res.MemberWitness == nil {
		t.Fatalf("invited member must get a member_witness, got null (%s)", rec.Body.String())
	}
	if res.MemberWitness.InviterAccountID != f.ownerAcct {
		t.Errorf("inviter_account_id = %s, want %s", res.MemberWitness.InviterAccountID, f.ownerAcct)
	}
	if res.MemberWitness.Role != "editor" {
		t.Errorf("role = %s, want editor", res.MemberWitness.Role)
	}
	verifyTupleSig(t, f.serverPub,
		MemberWitnessTuple(f.vaultID, memberAcct, f.ownerAcct, "editor", res.MemberWitness.IssuedAtMS),
		res.MemberWitness.SigB64,
	)
	// Device witness rides along too.
	verifyTupleSig(t, f.serverPub,
		DeviceWitnessTuple(f.vaultID, memberAcct, memberInst, base64.StdEncoding.EncodeToString(memPub), res.DeviceWitness.IssuedAtMS),
		res.DeviceWitness.SigB64,
	)
}

// TestWitnessNeverIssuesOwnerMemberWitness (SEC FIX 3): even if a
// brokered-invite vault_members row somehow carries role=owner (data drift /
// a future code path past the CreateInvite editor/viewer cap), IssueWitness
// must NOT return a member_witness for it — a witness can never mint an
// owner. The device witness still rides along (the account does have a seat).
func TestWitnessNeverIssuesOwnerMemberWitness(t *testing.T) {
	f := newWitnessFixture(t)
	ctx := context.Background()

	memberAcct := f.seedAccount(t, "ownerinvitee@gmail.com")
	memberInst := uuid.NewString()
	f.seedInstall(t, memberInst)
	memPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate member device key: %v", err)
	}
	if err := f.svc.RegisterKey(ctx, memberInst, memPub); err != nil {
		t.Fatalf("register member key: %v", err)
	}
	// Brokered-invite row (invited_by ≠ self, invite_email set) BUT role=owner.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (
			vault_id, account_id, role, invited_by, invited_at,
			invite_email, invite_token_hash, invite_expires_at, accepted_at
		) VALUES ($1::uuid, $2::uuid, 'owner', $3::uuid, NOW(),
		          'ownerinvitee@gmail.com', 'testhash-'||$2, NOW() + INTERVAL '7 days', NOW())
	`, f.vaultID, memberAcct, f.ownerAcct); err != nil {
		t.Fatalf("seed owner-role brokered membership: %v", err)
	}

	rec := f.post(t, f.vaultID, memberAcct, memberInst, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST witness = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var res witnessWireResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if res.MemberWitness != nil {
		t.Errorf("owner-role brokered member must get member_witness = null, got %+v", *res.MemberWitness)
	}
	// Device witness still present — the account holds a seat.
	if res.DeviceWitness.SigB64 == "" {
		t.Errorf("device witness must still be issued for a seated account")
	}
}

// TestWitnessRequiresAuth: no JWT → 401 before any work.
func TestWitnessRequiresAuth(t *testing.T) {
	f := newWitnessFixture(t)
	if rec := f.post(t, f.vaultID, "", "", false); rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated POST = %d, want 401", rec.Code)
	}
}

// TestWitnessUnregisteredDeviceKey: a member install without a registered
// device key gets 412 (same contract as VMC issuance — register-key first,
// then retry).
func TestWitnessUnregisteredDeviceKey(t *testing.T) {
	f := newWitnessFixture(t)

	bareInst := uuid.NewString()
	f.seedInstall(t, bareInst)
	rec := f.post(t, f.vaultID, f.ownerAcct, bareInst, true)
	if rec.Code != http.StatusPreconditionFailed {
		t.Errorf("unregistered-key POST = %d (%s), want 412", rec.Code, rec.Body.String())
	}
}

// TestWitnessNonMember: a registered device whose account holds no seat in
// the vault gets 403 — the server refuses to attest device control "for
// vault V" to outsiders.
func TestWitnessNonMember(t *testing.T) {
	f := newWitnessFixture(t)
	ctx := context.Background()

	strangerAcct := f.seedAccount(t, "stranger@gmail.com")
	strangerInst := uuid.NewString()
	f.seedInstall(t, strangerInst)
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	if err := f.svc.RegisterKey(ctx, strangerInst, pub); err != nil {
		t.Fatalf("register key: %v", err)
	}

	rec := f.post(t, f.vaultID, strangerAcct, strangerInst, true)
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-member POST = %d (%s), want 403", rec.Code, rec.Body.String())
	}
}
