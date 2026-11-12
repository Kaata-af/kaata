package admininvite

import (
	"github.com/matee/kaata-backend/internal/canonical"
	"testing"
)

func TestMobileAdminGrantCanonicalVector(t *testing.T) {
	g := Grant{Domain: Domain, GrantID: "10000000-0000-4000-8000-000000000007", VaultID: "10000000-0000-4000-8000-000000000001", FromAccountID: "10000000-0000-4000-8000-000000000002", RecipientAccountID: "10000000-0000-4000-8000-000000000003", Role: "manager", IssuedAtMS: 2000, ExpiresAtMS: 6000}
	a := Authorization{Grant: g, SignerDevicePubkey: "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=", SigB64: "MBICX645Msoed4SJFeP3bIs5a7KLpsWcp9WHP3bs7dZZJVEiW1zF9Rvj5pftBdIXfi1/UCwT7N+Cqr/iM2bcAA=="}
	if err := Verify(a); err != nil {
		t.Fatal(err)
	}
	hash, err := GrantHash(g)
	if err != nil || hash != "4819f6f94bf2fcc2f65829420ea1546aef96d74134f4f71009b6487385d5cf7a" {
		t.Fatalf("cross-language hash: %s %v", hash, err)
	}
	raw, _ := canonical.Canonicalize(g.Tuple())
	if string(raw) != `{"domain":"kaata-admin-invite-v1","expires_at_ms":6000,"from_account_id":"10000000-0000-4000-8000-000000000002","grant_id":"10000000-0000-4000-8000-000000000007","issued_at_ms":2000,"recipient_account_id":"10000000-0000-4000-8000-000000000003","role":"manager","vault_id":"10000000-0000-4000-8000-000000000001"}` {
		t.Fatal(string(raw))
	}
	p := Proof{Authorization: a, Receipt: Receipt{Domain: ReceiptDomain, GrantID: g.GrantID, VaultID: g.VaultID, GrantSHA256: hash, ToAccountID: g.RecipientAccountID, AcceptedAtMS: 3000, EventID: g.GrantID, VaultEpoch: 2}}
	e := EventIdentity{VaultID: g.VaultID, EventID: p.Receipt.EventID, TargetID: g.RecipientAccountID, DeviceID: g.GrantID, HLCDeviceID: g.GrantID, HLCPhysicalMS: g.IssuedAtMS}
	if err := VerifyProof(p, e); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Proof){func(p *Proof) { p.Receipt.ToAccountID = g.FromAccountID }, func(p *Proof) { p.Receipt.ToAccountID = "10000000-0000-4000-8000-000000000004" }, func(p *Proof) { p.Receipt.AcceptedAtMS = 7000 }, func(p *Proof) { p.Receipt.EventID = "10000000-0000-4000-8000-000000000009" }, func(p *Proof) { p.Authorization.Grant.RecipientAccountID = "*" }, func(p *Proof) { p.Authorization.Grant.Role = "owner" }} {
		bad := p
		mutate(&bad)
		if VerifyProof(bad, e) == nil {
			t.Fatal("tampered admin proof accepted")
		}
	}
}
