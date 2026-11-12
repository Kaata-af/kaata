package vaults

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/admininvite"
	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/ownership"
)

var ErrInvalidAdminAuthorization = errors.New("invalid administrator invitation authorization; refresh and try again")
var ErrAdminInviteUpgradeRequired = errors.New("update Kaata to accept this Admin invitation")

// validateAdminInvite holds the same owner/device checks as a handover. This
// preserves the guarantee that a compromised witness signer cannot mint Admins.
func validateAdminInvite(ctx context.Context, tx pgx.Tx, a *admininvite.Authorization, vaultID, ownerID, recipient string) ([]byte, any, any, any, error) {
	if a == nil || admininvite.Verify(*a) != nil || a.Grant.VaultID != vaultID ||
		a.Grant.FromAccountID != ownerID || a.Grant.RecipientAccountID != recipient {
		return nil, nil, nil, nil, ErrInvalidAdminAuthorization
	}
	now := time.Now()
	if a.Grant.IssuedAtMS < now.Add(-5*time.Minute).UnixMilli() || a.Grant.IssuedAtMS > now.Add(5*time.Minute).UnixMilli() || a.Grant.ExpiresAtMS <= now.UnixMilli() {
		return nil, nil, nil, nil, ErrInvalidAdminAuthorization
	}
	if err := requireOwner(ctx, tx, vaultID, ownerID); err != nil {
		return nil, nil, nil, nil, err
	}
	bound, err := ownershipSignerBound(ctx, tx, ownership.Authorization{Grant: ownership.Grant{VaultID: vaultID, FromAccountID: ownerID, FromChainAccountID: a.Grant.FromChainAccountID}, SignerDevicePubkey: a.SignerDevicePubkey})
	if err != nil {
		return nil, nil, nil, nil, err
	}
	if !bound {
		return nil, nil, nil, nil, ErrInvalidAdminAuthorization
	}
	var membershipMaximum int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(hlc_physical_ms),0) FROM events WHERE vault_id=$1::uuid AND event_type IN ('vault_member_added','vault_member_role_changed','vault_member_removed','vault_device_added','vault_device_removed')`, vaultID).Scan(&membershipMaximum); err != nil {
		return nil, nil, nil, nil, err
	}
	if a.Grant.IssuedAtMS <= membershipMaximum {
		return nil, nil, nil, nil, ErrInvalidAdminAuthorization
	}
	var memberID, changed int64
	var updated time.Time
	if err := tx.QueryRow(ctx, `SELECT id,COALESCE(last_change_hlc_ms,0),updated_at FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND role='owner' AND accepted_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE`, vaultID, ownerID).Scan(&memberID, &changed, &updated); err != nil {
		return nil, nil, nil, nil, err
	}
	raw, err := json.Marshal(a)
	return raw, memberID, changed, updated, err
}

// PendingAdminInviteSQL is evaluated with vm as the invitation alias. Demotion
// and later promotion never revives consent tied to an earlier owner seat.
const pendingAdminInviteSQL = admininvite.PendingSQL

// Commit the original admission with the ACL change. Unlike an ordinary
// invitation, Admin recovery never depends on issuing another member witness.
func (s *Service) persistAdminAdmission(ctx context.Context, tx pgx.Tx, memberID int64, vaultID, accountID string, a admininvite.Authorization) (string, error) {
	if len(s.ownershipSigner) != ed25519.PrivateKeySize {
		return "", ErrOwnershipSigningUnavailable
	}
	var epoch int64
	if err := tx.QueryRow(ctx, `SELECT vault_epoch FROM vaults WHERE vault_id=$1::uuid`, vaultID).Scan(&epoch); err != nil {
		return "", err
	}
	stamp := a.Grant.IssuedAtMS
	acceptedAt := time.Now().UnixMilli()
	if stamp > acceptedAt {
		acceptedAt = stamp
	}
	eventID := a.Grant.GrantID
	hash, err := admininvite.GrantHash(a.Grant)
	if err != nil {
		return "", err
	}
	proof := admininvite.Proof{Authorization: a, Receipt: admininvite.Receipt{Domain: admininvite.ReceiptDomain, GrantID: a.Grant.GrantID, VaultID: vaultID, GrantSHA256: hash, ToAccountID: accountID, AcceptedAtMS: acceptedAt, EventID: eventID, VaultEpoch: epoch}}
	if err := admininvite.VerifyProof(proof, admininvite.EventIdentity{VaultID: vaultID, EventID: eventID, TargetID: accountID, DeviceID: eventID, HLCDeviceID: eventID, HLCPhysicalMS: stamp}); err != nil {
		return "", ErrInviteNotFound
	}
	pub := s.ownershipSigner.Public().(ed25519.PublicKey)
	deviceID := a.Grant.GrantID
	raw, err := json.Marshal(map[string]any{"account_id": accountID, "role": "manager", "admin_invite": proof})
	if err != nil {
		return "", err
	}
	payload, err := canonical.Decode(raw)
	if err != nil {
		return "", err
	}
	envelope := map[string]any{"actor_account_id": nil, "device_id": deviceID, "event_id": eventID, "event_type": "vault_member_added", "hlc": map[string]any{"did": deviceID, "l": 0, "pms": stamp}, "payload": payload, "payload_schema": 1, "relationship_id": nil, "target_id": accountID, "vault_id": vaultID}
	message, err := canonical.Canonicalize(envelope)
	if err != nil {
		return "", err
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(s.ownershipSigner, message))
	if _, err := tx.Exec(ctx, `INSERT INTO events(event_id,vault_id,server_seq,event_type,schema_version,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,account_id,target_id,payload,event_sig_b64,signer_device_pubkey)
 VALUES($1::uuid,$2::uuid,(SELECT COALESCE(MAX(server_seq),0)+1 FROM events WHERE vault_id=$2::uuid),'vault_member_added',1,$3,0,$4::uuid,$4::uuid,NULL,$5::uuid,$6::jsonb,$7,$8)`, eventID, vaultID, stamp, deviceID, accountID, string(raw), sig, base64.StdEncoding.EncodeToString(pub)); err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `UPDATE vault_members SET admin_invite_event_id=$2::uuid,last_change_hlc_ms=$3 WHERE id=$1`, memberID, eventID, stamp)
	return eventID, err
}
