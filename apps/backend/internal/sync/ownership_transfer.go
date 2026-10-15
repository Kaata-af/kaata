package sync

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/ownership"
)

func hasOwnershipTransfer(ev *PushEvent) bool {
	if ev.EventType != EventVaultMemberAdded {
		return false
	}
	var p map[string]json.RawMessage
	if json.Unmarshal(ev.Payload, &p) != nil {
		return false
	}
	_, ok := p["ownership_transfer"]
	return ok
}

func ownershipTransferredBefore(ctx context.Context, tx pgx.Tx, vaultID string, atMS int64) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM events WHERE vault_id=$1::uuid
	 AND redacted_at IS NULL AND event_type='vault_member_added'
	 AND payload->'ownership_transfer'->'receipt'->>'domain'=$3 AND hlc_physical_ms<=$2)`,
		vaultID, atMS, ownership.ReceiptDomain).Scan(&exists)
	return exists, err
}

// Unknown historical membership changes cannot arrive after a handover and
// mint fresh authority from a retired owner's backdated signature. Previously
// stored history remains relayable; money history keeps its lawful-at-HLC rule.
func requiresCurrentMembershipAuthority(ctx context.Context, tx pgx.Tx, vaultID, eventID string) (bool, error) {
	var guard bool
	err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM events WHERE vault_id=$1::uuid AND event_id=$2::uuid)
	 AND (EXISTS(SELECT 1 FROM events WHERE vault_id=$1::uuid AND redacted_at IS NULL AND
	  ((event_type='vault_member_role_changed' AND payload->>'role'='owner') OR
	   (event_type='vault_member_added' AND payload->'ownership_transfer' IS NOT NULL)))
	 OR EXISTS(SELECT 1 FROM vault_audit_log WHERE vault_id=$1::uuid AND kind='ownership_transferred'))`,
		vaultID, eventID).Scan(&guard)
	return guard, err
}

func anchorCurrentlyOwns(ctx context.Context, tx pgx.Tx, vaultID, pubkey string) (bool, error) {
	var account string
	err := tx.QueryRow(ctx, `SELECT payload->>'account_id' FROM events WHERE vault_id=$1::uuid AND redacted_at IS NULL
	 AND event_type='vault_member_added' AND payload->>'role'='owner' AND signer_device_pubkey=$2
	 ORDER BY hlc_physical_ms,hlc_logical,hlc_device_id,event_id LIMIT 1`, vaultID, pubkey).Scan(&account)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return aliasOwnerBefore(ctx, tx, vaultID, account, 9007199254740991)
}

func repairCanonicalOwner(ctx context.Context, tx pgx.Tx, vaultID string) error {
	_, err := tx.Exec(ctx, `UPDATE vaults v SET owner_account_id=(SELECT account_id FROM vault_members m
	 WHERE m.vault_id=v.vault_id AND m.role='owner' AND m.revoked_at IS NULL AND m.accepted_at IS NOT NULL
	 ORDER BY m.last_change_hlc_ms DESC NULLS LAST,m.id DESC,m.account_id ASC LIMIT 1)
	 WHERE v.vault_id=$1::uuid AND NOT EXISTS(SELECT 1 FROM vault_members current
	 WHERE current.vault_id=v.vault_id AND current.account_id=v.owner_account_id AND current.role='owner'
	 AND current.revoked_at IS NULL AND current.accepted_at IS NOT NULL)
	 AND EXISTS(SELECT 1 FROM vault_members owner WHERE owner.vault_id=v.vault_id AND owner.role='owner'
	 AND owner.revoked_at IS NULL AND owner.accepted_at IS NOT NULL)`, vaultID)
	return err
}

// The original owner can remain keyed by a pre-sign-in local identity in
// signed history while REST membership uses their real account UUID. Only
// that exact anchor genesis identity may affect the owner's operational row.
// Registration ties the anchor key to the current canonical account, rather
// than trusting actor_account_id or translating arbitrary local staff IDs.
func localAnchorOwnerAccount(ctx context.Context, tx pgx.Tx, vaultID string, ev *PushEvent, alias string) (string, error) {
	if !localAccountTargetPattern.MatchString(alias) {
		return "", nil
	}
	pub, err := base64.StdEncoding.DecodeString(derefStr(ev.SignerDevicePubkeyB64))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return "", nil
	}
	var account string
	err = tx.QueryRow(ctx, `SELECT v.owner_account_id::text FROM vaults v
	 JOIN vault_members m ON m.vault_id=v.vault_id AND m.account_id=v.owner_account_id
	 WHERE v.vault_id=$1::uuid AND v.vault_trust_anchor_pubkey=$2 AND m.role='owner'
	 AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
	 AND EXISTS(SELECT 1 FROM device_keys dk JOIN installs i ON i.install_id=dk.install_id
	  WHERE i.account_id=v.owner_account_id AND dk.ed25519_pubkey=$2)
	 AND $3=(SELECT e.payload->>'account_id' FROM events e WHERE e.vault_id=v.vault_id
	  AND e.redacted_at IS NULL AND e.event_type='vault_member_added' AND e.payload->>'role'='owner'
	  AND e.signer_device_pubkey=$4 ORDER BY e.hlc_physical_ms,e.hlc_logical,e.hlc_device_id,e.event_id LIMIT 1)`,
		vaultID, pub, alias, derefStr(ev.SignerDevicePubkeyB64)).Scan(&account)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return account, err
}

// aliasOwnerBefore reconstructs an original local identity from accepted,
// signed membership history. Operational vault_members cannot hold local IDs.
func aliasOwnerBefore(ctx context.Context, tx pgx.Tx, vaultID, alias string, atMS int64) (bool, error) {
	var kind string
	var payload []byte
	err := tx.QueryRow(ctx, `SELECT event_type,payload FROM events WHERE vault_id=$1::uuid
	 AND redacted_at IS NULL AND hlc_physical_ms<$3
	 AND event_type IN ('vault_member_added','vault_member_role_changed','vault_member_removed')
	 AND (COALESCE(local_target_id,target_id::text)=$2 OR
	  payload->'ownership_transfer'->'authorization'->'grant'->>'from_chain_account_id'=$2 OR
	  payload->'ownership_transfer'->'authorization'->'grant'->>'from_account_id'=$2)
	 ORDER BY hlc_physical_ms DESC,hlc_logical DESC,hlc_device_id DESC,event_id DESC LIMIT 1`,
		vaultID, alias, atMS).Scan(&kind, &payload)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var p memberAddedWire
	if json.Unmarshal(payload, &p) != nil {
		return false, nil
	}
	if p.OwnershipTransfer != nil && (p.OwnershipTransfer.Authorization.Grant.ChainAccountID() == alias ||
		p.OwnershipTransfer.Authorization.Grant.FromAccountID == alias) {
		return false, nil
	}
	return kind != EventVaultMemberRemoved && p.Role == "owner", nil
}

func (s *Service) verifyOwnershipTransfer(ctx context.Context, tx pgx.Tx, vaultID string, anchor []byte,
	ev *PushEvent, signerPub []byte) (bool, error) {
	var p memberAddedWire
	if json.Unmarshal(ev.Payload, &p) != nil || p.OwnershipTransfer == nil || p.Role != "owner" ||
		ev.TargetID == nil || p.AccountID != *ev.TargetID || ev.ActorAccountID != nil || ev.RelationshipID != nil ||
		ev.SchemaVersion != 1 {
		return false, nil
	}
	proof := *p.OwnershipTransfer
	if ownership.VerifyProof(proof, ownership.EventIdentity{VaultID: vaultID, EventID: ev.EventID,
		TargetID: *ev.TargetID, HLCPhysicalMS: ev.HLC.PhysicalMS, HLCLogical: ev.HLC.Logical}) != nil {
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
	g := proof.Authorization.Grant
	var reused bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events WHERE vault_id=$1::uuid
	 AND event_id!=$2::uuid AND redacted_at IS NULL AND event_type='vault_member_added'
	 AND payload->'ownership_transfer'->'authorization'->'grant'->>'transfer_id'=$3)`,
		vaultID, ev.EventID, g.TransferID).Scan(&reused); err != nil {
		return false, err
	}
	if reused {
		return false, nil
	}
	authPub, _ := base64.StdEncoding.DecodeString(proof.Authorization.SignerDevicePubkey)
	if len(authPub) != ed25519.PublicKeySize {
		return false, nil
	}
	var removed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vault_devices WHERE vault_id=$1::uuid
	 AND device_pubkey=$2 AND removed_at_ms IS NOT NULL AND removed_at_ms<$3)`,
		vaultID, authPub, ev.HLC.PhysicalMS).Scan(&removed); err != nil {
		return false, err
	}
	if removed {
		return false, nil
	}
	chainID := g.ChainAccountID()
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
	// The anchor genesis implicitly bound a local-only owner, whose ID cannot
	// be represented by vault_devices.account_id's UUID column.
	if bytes.Equal(authPub, anchor) {
		var genesisAccount string
		err := tx.QueryRow(ctx, `SELECT payload->>'account_id' FROM events WHERE vault_id=$1::uuid
		 AND redacted_at IS NULL AND event_type='vault_member_added' AND payload->>'role'='owner'
		 AND signer_device_pubkey=$2 AND hlc_physical_ms<$3
		 ORDER BY hlc_physical_ms,hlc_logical,hlc_device_id,event_id LIMIT 1`,
			vaultID, proof.Authorization.SignerDevicePubkey, ev.HLC.PhysicalMS).Scan(&genesisAccount)
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return err == nil && genesisAccount == chainID, err
	}
	return false, nil
}

func foldOwnershipTransfer(ctx context.Context, tx pgx.Tx, vaultID string, ev *PushEvent, p ownership.Proof) ([]string, error) {
	from, to := p.Authorization.Grant.FromAccountID, p.Receipt.ToAccountID
	// The issuing service normally committed these writes with this event.
	// This guarded fold also makes replay/relay unable to undo a later role.
	for _, cell := range []struct{ id, role string }{{to, "owner"}, {from, "editor"}} {
		_, err := tx.Exec(ctx, `UPDATE vault_members SET role=$3,updated_at=NOW(),last_change_hlc_ms=$4
		 WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL
		 AND (last_change_hlc_ms IS NULL OR last_change_hlc_ms<=$4)`, vaultID, cell.id, cell.role, ev.HLC.PhysicalMS)
		if err != nil {
			return nil, fmt.Errorf("fold ownership handover: %w", err)
		}
	}
	_, err := tx.Exec(ctx, `UPDATE vaults SET owner_account_id=$2::uuid,
	 vault_epoch=GREATEST(vault_epoch,$3) WHERE vault_id=$1::uuid AND owner_account_id=$4::uuid
	 AND NOT EXISTS (SELECT 1 FROM events WHERE vault_id=$1::uuid AND event_type='vault_member_added'
	  AND payload->'ownership_transfer'->'receipt'->>'domain'=$5 AND hlc_physical_ms>$6)`,
		vaultID, to, p.Receipt.VaultEpoch, from, ownership.ReceiptDomain, ev.HLC.PhysicalMS)
	if err != nil {
		return nil, err
	}
	return []string{from, to}, nil
}
