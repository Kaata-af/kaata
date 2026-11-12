package sync

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/admininvite"
)

func hasAdminInvite(ev *PushEvent) bool {
	if ev.EventType != EventVaultMemberAdded {
		return false
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(ev.Payload, &payload) != nil {
		return false
	}
	_, ok := payload["admin_invite"]
	return ok
}

// An Admin admission needs both signatures: owner intent for this exact account
// and a pinned-server acceptance binding one durable event. A member witness
// remains unable to create Admin authority, including after key compromise.
func (s *Service) verifyAdminInvite(ctx context.Context, tx pgx.Tx, vaultID string, anchor []byte, ev *PushEvent, signerPub []byte) (bool, error) {
	var payload struct {
		AccountID string             `json:"account_id"`
		Role      string             `json:"role"`
		Proof     *admininvite.Proof `json:"admin_invite"`
	}
	if json.Unmarshal(ev.Payload, &payload) != nil || payload.Proof == nil || payload.Role != "manager" || ev.TargetID == nil || payload.AccountID != *ev.TargetID || ev.ActorAccountID != nil || ev.RelationshipID != nil || ev.SchemaVersion != 1 {
		return false, nil
	}
	proof := *payload.Proof
	if admininvite.VerifyProof(proof, admininvite.EventIdentity{VaultID: vaultID, EventID: ev.EventID, TargetID: *ev.TargetID, DeviceID: ev.HLC.DeviceID, HLCDeviceID: ev.HLC.DeviceID, HLCPhysicalMS: ev.HLC.PhysicalMS, HLCLogical: ev.HLC.Logical}) != nil {
		return false, nil
	}
	pinned := false
	for _, pub := range s.witnessPubkeys {
		if bytes.Equal(pub, signerPub) {
			pinned = true
			break
		}
	}
	if !pinned {
		return false, nil
	}
	var reused, accepted bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events WHERE vault_id=$1::uuid AND event_id<>$2::uuid AND redacted_at IS NULL AND event_type='vault_member_added' AND payload#>>'{admin_invite,authorization,grant,grant_id}'=$3),
 EXISTS(SELECT 1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$4::uuid AND admin_invite_event_id=$2::uuid AND admin_authorization#>>'{grant,grant_id}'=$3 AND accepted_at IS NOT NULL AND revoked_at IS NULL)`, vaultID, ev.EventID, proof.Authorization.Grant.GrantID, *ev.TargetID).Scan(&reused, &accepted); err != nil {
		return false, err
	}
	if reused || !accepted {
		return false, nil
	}
	authPub, _ := base64.StdEncoding.DecodeString(proof.Authorization.SignerDevicePubkey)
	if len(authPub) != ed25519.PublicKeySize {
		return false, nil
	}
	var removed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vault_devices WHERE vault_id=$1::uuid AND device_pubkey=$2 AND removed_at_ms IS NOT NULL AND removed_at_ms<$3)`, vaultID, authPub, ev.HLC.PhysicalMS).Scan(&removed); err != nil {
		return false, err
	}
	if removed {
		return false, nil
	}
	chainID := proof.Authorization.Grant.ChainAccountID()
	owner, err := aliasOwnerBefore(ctx, tx, vaultID, chainID, ev.HLC.PhysicalMS)
	if err != nil || !owner {
		return false, err
	}
	accounts, err := boundAccountsForPubkey(ctx, tx, vaultID, authPub, ev.HLC.PhysicalMS-1)
	if err != nil {
		return false, err
	}
	for _, account := range accounts {
		if account == chainID {
			return true, nil
		}
	}
	if bytes.Equal(authPub, anchor) {
		var genesis string
		err := tx.QueryRow(ctx, `SELECT payload->>'account_id' FROM events WHERE vault_id=$1::uuid AND redacted_at IS NULL AND event_type='vault_member_added' AND payload->>'role'='owner' AND signer_device_pubkey=$2 AND hlc_physical_ms<$3 ORDER BY hlc_physical_ms,hlc_logical,hlc_device_id,event_id LIMIT 1`, vaultID, proof.Authorization.SignerDevicePubkey, ev.HLC.PhysicalMS).Scan(&genesis)
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return err == nil && genesis == chainID, err
	}
	return false, nil
}
