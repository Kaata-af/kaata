package mesh

// M2 membership chain (docs/m2-membership-chain.md §8.1): the witness
// endpoint. The server's only remaining trust role in M2 is ATTESTATION —
// it signs two narrow statements with the existing mesh signing key:
//
//   device witness: "account A controls device D (pubkey P) for vault V"
//     — provable because the caller presented a JWT for (A, D) and D's
//       pubkey was registered via /v1/devices/register-key.
//   member witness: "owner-account O invited account A at role R into V"
//     — provable because the server brokered the email invite (the
//       vault_members row records invited_by + invite_email).
//
// The signatures cover canonical-JSON tuples (internal/canonical — same
// canonicalizer as mobile event signing). Mobile attaches them as the
// `witness` field on self-emitted vault_member_added / vault_device_added
// events; every replica (including this server's push path,
// internal/sync/membership.go) verifies them against the pinned server
// pubkey set with ±7d freshness vs the event HLC.
//
// The server can never admit anyone the owner didn't invite: a member
// witness exists only when a brokered invite row does, and a device witness
// alone admits nothing (the chain rules require it to be attached to an
// event signed by the named device itself).

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/httpx"
)

// WitnessServerKeyID identifies which server signing key produced the
// witness signatures. "primary" = MESH_SIGNING_PRIVKEY_PRIMARY. A future
// key rotation introduces a second id; verifiers accept the pinned SET.
const WitnessServerKeyID = "primary"

// DeviceWitnessTuple builds the canonical attestation input for
// "account controls device". Keys sort lexicographically under
// canonical.Canonicalize; the exact string for a sample tuple is pinned in
// internal/canonical/canonical_test.go and mirrored by mobile selftests.
func DeviceWitnessTuple(vaultID, accountID, deviceID, devicePubkeyB64 string, issuedAtMS int64) map[string]any {
	return map[string]any{
		"account_id":        accountID,
		"device_id":         deviceID,
		"device_pubkey_b64": devicePubkeyB64,
		"issued_at_ms":      issuedAtMS,
		"vault_id":          vaultID,
	}
}

// MemberWitnessTuple builds the canonical attestation input for
// "inviter admitted account at role".
func MemberWitnessTuple(vaultID, accountID, inviterAccountID, role string, issuedAtMS int64) map[string]any {
	return map[string]any{
		"account_id":         accountID,
		"inviter_account_id": inviterAccountID,
		"issued_at_ms":       issuedAtMS,
		"role":               role,
		"vault_id":           vaultID,
	}
}

// DeviceWitness is the always-present half of the witness response.
type DeviceWitness struct {
	SigB64     string `json:"sig_b64"`
	IssuedAtMS int64  `json:"issued_at_ms"`
}

// MemberWitness is present only when the caller's membership originated
// from a server-brokered invite (owner intent the server can attest to).
type MemberWitness struct {
	SigB64           string `json:"sig_b64"`
	IssuedAtMS       int64  `json:"issued_at_ms"`
	InviterAccountID string `json:"inviter_account_id"`
	Role             string `json:"role"`
}

// WitnessResult is the POST /v1/vaults/:vault_id/witness response body.
// MemberWitness is a pointer so the wire shape is `null` (not omitted) for
// non-invited members — owners and QR-admitted devices get device_witness
// only.
type WitnessResult struct {
	ServerKeyID   string         `json:"server_key_id"`
	DeviceWitness DeviceWitness  `json:"device_witness"`
	MemberWitness *MemberWitness `json:"member_witness"`
}

// IssueWitness mints the witness signatures for the calling
// (account, install) on vaultID. Caller identity comes from JWT claims
// (handler-enforced); this function only checks the facts it attests:
//   - the install has a registered device key (else ErrDeviceKeyNotRegistered);
//   - the account is an ACTIVE accepted member (else ErrNotMember);
//   - member witness only when the membership row records a brokered invite:
//     invited_by set to a DIFFERENT account AND invite_email present.
//     Owner rows (invited_by = self, no invite_email) and QR-promoted rows
//     (invited_by NULL) yield member_witness = null.
func (s *Service) IssueWitness(ctx context.Context, vaultID, accountID, installID string) (WitnessResult, error) {
	if s.signingPriv == nil {
		return WitnessResult{}, ErrSigningUnavailable
	}
	if _, err := uuid.Parse(vaultID); err != nil {
		return WitnessResult{}, fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(accountID); err != nil {
		return WitnessResult{}, fmt.Errorf("account_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(installID); err != nil {
		return WitnessResult{}, fmt.Errorf("install_id must be a uuid: %w", err)
	}

	// Device pubkey: the fact the device witness attests.
	var pubkey []byte
	err := s.pool.QueryRow(ctx, `
		SELECT ed25519_pubkey FROM device_keys WHERE install_id = $1::uuid
	`, installID).Scan(&pubkey)
	if errors.Is(err, pgx.ErrNoRows) {
		return WitnessResult{}, ErrDeviceKeyNotRegistered
	}
	if err != nil {
		return WitnessResult{}, fmt.Errorf("read device key: %w", err)
	}
	if len(pubkey) != ed25519.PublicKeySize {
		return WitnessResult{}, fmt.Errorf("stored device key has wrong length %d", len(pubkey))
	}

	// Active membership gates BOTH witnesses — the device witness tuple
	// names the vault, so we refuse to attest device control "for vault V"
	// to accounts with no seat in V (no witness farming).
	var (
		role        string
		invitedBy   *string
		inviteEmail *string
	)
	err = s.pool.QueryRow(ctx, `
		SELECT role, invited_by::text, invite_email
		  FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
	`, vaultID, accountID).Scan(&role, &invitedBy, &inviteEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return WitnessResult{}, ErrNotMember
	}
	if err != nil {
		return WitnessResult{}, fmt.Errorf("read membership: %w", err)
	}

	now := time.Now().UnixMilli()
	pubB64 := base64.StdEncoding.EncodeToString(pubkey)

	deviceCanonical, err := canonical.Canonicalize(
		DeviceWitnessTuple(vaultID, accountID, installID, pubB64, now),
	)
	if err != nil {
		return WitnessResult{}, fmt.Errorf("canonicalize device witness: %w", err)
	}
	res := WitnessResult{
		ServerKeyID: WitnessServerKeyID,
		DeviceWitness: DeviceWitness{
			SigB64:     base64.StdEncoding.EncodeToString(ed25519.Sign(s.signingPriv, deviceCanonical)),
			IssuedAtMS: now,
		},
	}

	// SEC FIX 3 (defense-in-depth): never issue a member_witness for an
	// owner role. A member witness attests "owner O invited account A at
	// role R"; the chain verifier caps witnessed admissions to editor/viewer
	// (a witness can never mint an owner — owner promotion requires an
	// owner-signed role change / the anchor). The invite system already caps
	// CreateInvite to editor/viewer, so a brokered-invite row should never
	// carry role=owner — but if one ever does (data drift, a future code
	// path), refuse to sign the owner tuple rather than hand out a witness
	// the verifier will reject anyway. The device witness still rides along.
	if invitedBy != nil && *invitedBy != accountID && inviteEmail != nil && *inviteEmail != "" && role != "owner" {
		memberCanonical, err := canonical.Canonicalize(
			MemberWitnessTuple(vaultID, accountID, *invitedBy, role, now),
		)
		if err != nil {
			return WitnessResult{}, fmt.Errorf("canonicalize member witness: %w", err)
		}
		res.MemberWitness = &MemberWitness{
			SigB64:           base64.StdEncoding.EncodeToString(ed25519.Sign(s.signingPriv, memberCanonical)),
			IssuedAtMS:       now,
			InviterAccountID: *invitedBy,
			Role:             role,
		}
	}
	return res, nil
}

// Witness — POST /v1/vaults/:vault_id/witness (PROTECTED, 60/hr per account
// — same budget as the other mesh issuance endpoints).
//
// vault_id from the URL; (account_id, install_id) strictly from JWT claims —
// there is no request body. Error mapping: 503 when the signing key is
// unconfigured, 412 when the device key isn't registered yet (client should
// POST /v1/devices/register-key and retry), 403 for non-members.
func (h *Handler) Witness(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	vaultID := chi.URLParam(r, "vault_id")
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}

	res, err := h.svc.IssueWitness(r.Context(), vaultID, claims.AccountID, claims.InstallID)
	if err != nil {
		switch {
		case errors.Is(err, ErrSigningUnavailable):
			httpx.Error(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, ErrDeviceKeyNotRegistered):
			httpx.Error(w, http.StatusPreconditionFailed, err.Error())
		case errors.Is(err, ErrNotMember):
			httpx.Error(w, http.StatusForbidden, err.Error())
		default:
			httpx.Error(w, http.StatusInternalServerError, "witness issuance failed")
		}
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}
