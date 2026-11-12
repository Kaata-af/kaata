// Package admininvite defines the owner's narrowly scoped, single-use consent
// to invite an administrator. A server witness alone never grants this role.
package admininvite

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/canonical"
)

const Domain = "kaata-admin-invite-v1"
const ReceiptDomain = "kaata-admin-invite-acceptance-v1"
const MaxLifetimeMS int64 = 7 * 24 * 60 * 60 * 1000

// PendingSQL uses vm as the invitation alias. A changed owner seat invalidates
// pending Admin consent even if that account later becomes owner again.
const PendingSQL = `(vm.role<>'manager' OR (vm.admin_authorization IS NOT NULL AND EXISTS(
 SELECT 1 FROM vault_members admin_owner WHERE admin_owner.id=vm.admin_invite_owner_member_id
 AND admin_owner.vault_id=vm.vault_id AND admin_owner.account_id=vm.invited_by
 AND admin_owner.role='owner' AND admin_owner.accepted_at IS NOT NULL AND admin_owner.revoked_at IS NULL
 AND COALESCE(admin_owner.last_change_hlc_ms,0)=vm.admin_invite_owner_change_ms
 AND admin_owner.updated_at=vm.admin_invite_owner_updated_at)))`

var ErrInvalid = errors.New("invalid administrator invitation authorization")
var localAccount = regexp.MustCompile(`^local:[A-Za-z0-9_-]{16}$`)

type Grant struct {
	Domain             string `json:"domain"`
	GrantID            string `json:"grant_id"`
	VaultID            string `json:"vault_id"`
	FromAccountID      string `json:"from_account_id"`
	FromChainAccountID string `json:"from_chain_account_id,omitempty"`
	RecipientAccountID string `json:"recipient_account_id"`
	Role               string `json:"role"`
	IssuedAtMS         int64  `json:"issued_at_ms"`
	ExpiresAtMS        int64  `json:"expires_at_ms"`
}

type Authorization struct {
	Grant              Grant  `json:"grant"`
	SignerDevicePubkey string `json:"signer_device_pubkey"`
	SigB64             string `json:"sig_b64"`
}

type Receipt struct {
	Domain       string `json:"domain"`
	GrantID      string `json:"grant_id"`
	VaultID      string `json:"vault_id"`
	GrantSHA256  string `json:"grant_sha256"`
	ToAccountID  string `json:"to_account_id"`
	AcceptedAtMS int64  `json:"accepted_at_ms"`
	EventID      string `json:"event_id"`
	VaultEpoch   int64  `json:"vault_epoch"`
}
type Proof struct {
	Authorization Authorization `json:"authorization"`
	Receipt       Receipt       `json:"receipt"`
}
type EventIdentity struct {
	VaultID, EventID, TargetID string
	DeviceID, HLCDeviceID      string
	HLCPhysicalMS, HLCLogical  int64
}

func GrantHash(g Grant) (string, error) {
	raw, err := canonical.Canonicalize(g.Tuple())
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:]), nil
}

func validUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

func (g Grant) ChainAccountID() string {
	if g.FromChainAccountID != "" {
		return g.FromChainAccountID
	}
	return g.FromAccountID
}

func (g Grant) Tuple() map[string]any {
	tuple := map[string]any{"domain": g.Domain, "grant_id": g.GrantID, "vault_id": g.VaultID,
		"from_account_id": g.FromAccountID, "recipient_account_id": g.RecipientAccountID,
		"role": g.Role, "issued_at_ms": g.IssuedAtMS, "expires_at_ms": g.ExpiresAtMS}
	if g.FromChainAccountID != "" {
		tuple["from_chain_account_id"] = g.FromChainAccountID
	}
	return tuple
}

func (a Authorization) Tuple() map[string]any {
	return map[string]any{"grant": a.Grant.Tuple(), "signer_device_pubkey": a.SignerDevicePubkey, "sig_b64": a.SigB64}
}

func Verify(a Authorization) error {
	g := a.Grant
	if g.Domain != Domain || !validUUID(g.GrantID) || !validUUID(g.VaultID) || !validUUID(g.FromAccountID) ||
		(g.FromChainAccountID != "" && !validUUID(g.FromChainAccountID) && !localAccount.MatchString(g.FromChainAccountID)) ||
		(!validUUID(g.RecipientAccountID) || g.RecipientAccountID == g.FromAccountID) ||
		g.Role != "manager" || g.IssuedAtMS <= 0 || g.ExpiresAtMS > 9007199254740991 ||
		g.ExpiresAtMS <= g.IssuedAtMS || g.ExpiresAtMS-g.IssuedAtMS > MaxLifetimeMS {
		return ErrInvalid
	}
	pub, err := base64.StdEncoding.DecodeString(a.SignerDevicePubkey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return ErrInvalid
	}
	sig, err := base64.StdEncoding.DecodeString(a.SigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ErrInvalid
	}
	message, err := canonical.Canonicalize(g.Tuple())
	if err != nil || !ed25519.Verify(pub, message, sig) {
		return ErrInvalid
	}
	return nil
}

func ValidAcceptance(a Authorization, vaultID, accountID, inviterID string, acceptedAtMS, witnessedAtMS int64) bool {
	g := a.Grant
	return Verify(a) == nil && g.VaultID == vaultID && g.FromAccountID == inviterID && accountID != g.FromAccountID && accountID != g.ChainAccountID() &&
		g.RecipientAccountID == accountID &&
		acceptedAtMS >= g.IssuedAtMS && acceptedAtMS <= g.ExpiresAtMS && acceptedAtMS <= witnessedAtMS
}

// VerifyProof additionally binds the server's event signature to the exact
// owner grant and one immutable acceptance; a renewed witness cannot replay it.
func VerifyProof(p Proof, e EventIdentity) error {
	g, r := p.Authorization.Grant, p.Receipt
	hash, err := GrantHash(g)
	if err != nil || !ValidAcceptance(p.Authorization, r.VaultID, r.ToAccountID, g.FromAccountID, r.AcceptedAtMS, r.AcceptedAtMS) ||
		r.Domain != ReceiptDomain || r.GrantID != g.GrantID || r.GrantSHA256 != hash || !validUUID(r.ToAccountID) || !validUUID(r.EventID) ||
		r.VaultEpoch <= 0 || r.VaultEpoch > 9007199254740991 || e.VaultID != r.VaultID || e.EventID != r.EventID ||
		e.TargetID != r.ToAccountID || e.EventID != g.GrantID || e.DeviceID != g.GrantID || e.HLCDeviceID != g.GrantID || e.HLCPhysicalMS != g.IssuedAtMS || e.HLCLogical != 0 {
		return ErrInvalid
	}
	return nil
}
