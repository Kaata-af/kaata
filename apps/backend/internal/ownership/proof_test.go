package ownership

import (
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
)

func proofFixture(t *testing.T) (Proof, EventIdentity) {
	t.Helper()
	g := Grant{Domain: GrantDomain, TransferID: "10000000-0000-4000-8000-000000000007",
		VaultID: "10000000-0000-4000-8000-000000000001", FromAccountID: "10000000-0000-4000-8000-000000000002",
		RecipientEmailNormalized: "recipient@example.com", DemoteSelfTo: "editor", IssuedAtMS: 2000, ExpiresAtMS: 6000}
	priv := ed25519.NewKeyFromSeed([]byte(strings.Repeat("a", 32)))
	b, err := GrantBytes(g)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := GrantHash(g)
	if err != nil {
		t.Fatal(err)
	}
	p := Proof{Authorization: Authorization{Grant: g, SignerDevicePubkey: base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)),
		SigB64: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, b))}, Receipt: Receipt{
		Domain: ReceiptDomain, TransferID: g.TransferID, VaultID: g.VaultID, GrantSHA256: hash,
		ToAccountID: "10000000-0000-4000-8000-000000000003", AcceptedAtMS: 3000,
		EventID: "10000000-0000-4000-8000-000000000008", VaultEpoch: 2}}
	return p, EventIdentity{VaultID: g.VaultID, EventID: p.Receipt.EventID, TargetID: p.Receipt.ToAccountID, HLCPhysicalMS: 3000}
}

func TestProofCanonicalCrossPlatform(t *testing.T) {
	p, e := proofFixture(t)
	b, err := GrantBytes(p.Authorization.Grant)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"demote_self_to":"editor","domain":"kaata-ownership-transfer-v1","expires_at_ms":6000,"from_account_id":"10000000-0000-4000-8000-000000000002","issued_at_ms":2000,"recipient_email_normalized":"recipient@example.com","transfer_id":"10000000-0000-4000-8000-000000000007","vault_id":"10000000-0000-4000-8000-000000000001"}`
	if string(b) != want {
		t.Fatalf("canonical mismatch: %s", b)
	}
	if err := VerifyProof(p, e); err != nil {
		t.Fatal(err)
	}
}

func TestProofRejectsChangedRecipientGrantAndReceipt(t *testing.T) {
	for name, mutate := range map[string]func(*Proof, *EventIdentity){
		"grant_email": func(p *Proof, _ *EventIdentity) {
			p.Authorization.Grant.RecipientEmailNormalized = "attacker@example.com"
		},
		"grant_domain": func(p *Proof, _ *EventIdentity) { p.Authorization.Grant.Domain = "member-witness" },
		"wrong_signer": func(p *Proof, _ *EventIdentity) {
			p.Authorization.SignerDevicePubkey = base64.StdEncoding.EncodeToString(make([]byte, 32))
		},
		"recipient":    func(_ *Proof, e *EventIdentity) { e.TargetID = "10000000-0000-4000-8000-000000000004" },
		"event_id":     func(_ *Proof, e *EventIdentity) { e.EventID = "10000000-0000-4000-8000-000000000004" },
		"vault":        func(_ *Proof, e *EventIdentity) { e.VaultID = "10000000-0000-4000-8000-000000000004" },
		"time":         func(_ *Proof, e *EventIdentity) { e.HLCPhysicalMS++ },
		"logical":      func(_ *Proof, e *EventIdentity) { e.HLCLogical++ },
		"hash":         func(p *Proof, _ *EventIdentity) { p.Receipt.GrantSHA256 = strings.Repeat("0", 64) },
		"expired":      func(p *Proof, e *EventIdentity) { p.Receipt.AcceptedAtMS = 7000; e.HLCPhysicalMS = 7000 },
		"before_grant": func(p *Proof, e *EventIdentity) { p.Receipt.AcceptedAtMS = 1500; e.HLCPhysicalMS = 1500 },
		"self": func(p *Proof, e *EventIdentity) {
			p.Receipt.ToAccountID = p.Authorization.Grant.FromAccountID
			e.TargetID = p.Receipt.ToAccountID
		},
		"zero_epoch": func(p *Proof, _ *EventIdentity) { p.Receipt.VaultEpoch = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			p, e := proofFixture(t)
			mutate(&p, &e)
			if VerifyProof(p, e) == nil {
				t.Fatal("accepted tampered proof")
			}
		})
	}
}

func TestAliasIsExplicitlySigned(t *testing.T) {
	p, _ := proofFixture(t)
	p.Authorization.Grant.FromChainAccountID = "local:abcdefghijklmnop"
	if VerifyAuthorization(p.Authorization) == nil {
		t.Fatal("unsigned alias accepted")
	}
	b, err := GrantBytes(p.Authorization.Grant)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"from_chain_account_id":"local:abcdefghijklmnop"`) {
		t.Fatal("alias omitted from signature")
	}
	p.Authorization.Grant.FromChainAccountID = "arbitrary"
	if p.Authorization.Grant.Validate() == nil {
		t.Fatal("malformed alias accepted")
	}
}
