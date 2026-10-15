// Package ownership defines the narrowly scoped, owner-authorized handover
// proof shared by the invitation service and the membership verifiers.
package ownership

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/canonical"
)

const GrantDomain = "kaata-ownership-transfer-v1"
const ReceiptDomain = "kaata-ownership-transfer-acceptance-v1"
const MaxGrantLifetimeMS int64 = 7 * 24 * 60 * 60 * 1000
const maxSafeInteger int64 = 9007199254740991

var ErrInvalidProof = errors.New("invalid ownership transfer proof")

type Grant struct {
	Domain                   string `json:"domain"`
	TransferID               string `json:"transfer_id"`
	VaultID                  string `json:"vault_id"`
	FromAccountID            string `json:"from_account_id"`
	FromChainAccountID       string `json:"from_chain_account_id,omitempty"`
	RecipientEmailNormalized string `json:"recipient_email_normalized"`
	DemoteSelfTo             string `json:"demote_self_to"`
	IssuedAtMS               int64  `json:"issued_at_ms"`
	ExpiresAtMS              int64  `json:"expires_at_ms"`
}

type Authorization struct {
	Grant              Grant  `json:"grant"`
	SignerDevicePubkey string `json:"signer_device_pubkey"`
	SigB64             string `json:"sig_b64"`
}

type Receipt struct {
	Domain       string `json:"domain"`
	TransferID   string `json:"transfer_id"`
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

// EventIdentity binds a receipt to one immutable member-added envelope. The
// caller separately verifies its pinned-server signature and owner authority.
type EventIdentity struct {
	VaultID       string
	EventID       string
	TargetID      string
	HLCPhysicalMS int64
	HLCLogical    int64
}

func validUUID(s string) bool {
	u, err := uuid.Parse(s)
	return err == nil && u != uuid.Nil && u.String() == s
}

var localAccountPattern = regexp.MustCompile(`^local:[A-Za-z0-9_-]{16}$`)

func (g Grant) ChainAccountID() string {
	if g.FromChainAccountID != "" {
		return g.FromChainAccountID
	}
	return g.FromAccountID
}

// NormalizeEmail deliberately matches vaults.NormalizeInviteEmail without
// importing vaults (which consumes this package).
func NormalizeEmail(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	at := strings.LastIndexByte(s, '@')
	if at < 0 {
		return s
	}
	local, domain := s[:at], s[at+1:]
	if domain == "gmail.com" || domain == "googlemail.com" {
		if plus := strings.IndexByte(local, '+'); plus >= 0 {
			local = local[:plus]
		}
		return strings.ReplaceAll(local, ".", "") + "@gmail.com"
	}
	return s
}

func (g Grant) Validate() error {
	email := g.RecipientEmailNormalized
	at := strings.LastIndexByte(email, '@')
	if g.Domain != GrantDomain || !validUUID(g.TransferID) || !validUUID(g.VaultID) ||
		!validUUID(g.FromAccountID) || g.DemoteSelfTo != "editor" ||
		(g.FromChainAccountID != "" && !validUUID(g.FromChainAccountID) && !localAccountPattern.MatchString(g.FromChainAccountID)) ||
		g.IssuedAtMS <= 0 || g.ExpiresAtMS > maxSafeInteger ||
		g.ExpiresAtMS <= g.IssuedAtMS || g.ExpiresAtMS-g.IssuedAtMS > MaxGrantLifetimeMS ||
		len(email) > 254 || at <= 0 || at == len(email)-1 ||
		strings.ContainsAny(email, " \t\r\n\x00") || strings.Count(email, "@") != 1 ||
		NormalizeEmail(email) != email {
		return ErrInvalidProof
	}
	return nil
}

func GrantBytes(g Grant) ([]byte, error) {
	if err := g.Validate(); err != nil {
		return nil, err
	}
	tuple := map[string]any{
		"domain": g.Domain, "transfer_id": g.TransferID, "vault_id": g.VaultID,
		"from_account_id": g.FromAccountID, "recipient_email_normalized": g.RecipientEmailNormalized,
		"demote_self_to": g.DemoteSelfTo, "issued_at_ms": g.IssuedAtMS, "expires_at_ms": g.ExpiresAtMS,
	}
	if g.FromChainAccountID != "" {
		tuple["from_chain_account_id"] = g.FromChainAccountID
	}
	return canonical.Canonicalize(tuple)
}

func GrantHash(g Grant) (string, error) {
	b, err := GrantBytes(g)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

// VerifyAuthorization proves possession of the signing key only. Callers MUST
// also prove the key belongs to Grant.FromAccountID's active owner device.
func VerifyAuthorization(a Authorization) error {
	b, err := GrantBytes(a.Grant)
	if err != nil {
		return err
	}
	pub, err := base64.StdEncoding.DecodeString(a.SignerDevicePubkey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return ErrInvalidProof
	}
	sig, err := base64.StdEncoding.DecodeString(a.SigB64)
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(pub, b, sig) {
		return ErrInvalidProof
	}
	return nil
}

func VerifyProof(p Proof, e EventIdentity) error {
	if err := VerifyAuthorization(p.Authorization); err != nil {
		return err
	}
	g, r := p.Authorization.Grant, p.Receipt
	hash, err := GrantHash(g)
	if err != nil {
		return err
	}
	if r.Domain != ReceiptDomain || r.TransferID != g.TransferID || r.VaultID != g.VaultID ||
		r.GrantSHA256 != hash || !validUUID(r.ToAccountID) || r.ToAccountID == g.FromAccountID || r.ToAccountID == g.ChainAccountID() ||
		!validUUID(r.EventID) || r.AcceptedAtMS < g.IssuedAtMS || r.AcceptedAtMS > g.ExpiresAtMS ||
		r.VaultEpoch <= 0 || r.VaultEpoch > maxSafeInteger ||
		e.VaultID != r.VaultID || e.EventID != r.EventID || e.TargetID != r.ToAccountID ||
		e.HLCPhysicalMS != r.AcceptedAtMS || e.HLCLogical != 0 {
		return ErrInvalidProof
	}
	return nil
}
