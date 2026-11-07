package sync

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/memberreadmission"
)

var ErrMemberReadmissionConflict = errors.New("member return approval is no longer valid")
var errReadmittedDeviceRetired = fmt.Errorf("device was retired from this vault: %w", ErrNotMember)

const readmissionIDField = "readmission_invite_id"

// A returned account must not restore HTTPS sync to phones that still hold
// retired bindings. Unknown installs retain the normal account restore flow.
func checkReadmittedDevice(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, vaultID, accountID, installID string) error {
	if installID == "" {
		return nil
	}
	var retired bool
	err := db.QueryRow(ctx, `SELECT EXISTS (
	 SELECT 1 FROM vault_members vm JOIN events admission ON admission.event_id=vm.readmission_member_event_id
	 WHERE vm.vault_id=$1::uuid AND vm.account_id=$2::uuid AND vm.revoked_at IS NULL
	 AND EXISTS (SELECT 1 FROM vault_devices vd WHERE vd.vault_id=vm.vault_id AND vd.account_id=vm.account_id
	  AND (vd.device_id=$3::uuid OR vd.device_pubkey=(SELECT ed25519_pubkey FROM device_keys WHERE install_id=$3::uuid))
	  AND (vd.removed_at_ms IS NOT NULL OR vd.added_at_ms<admission.hlc_physical_ms))
	 AND NOT EXISTS (SELECT 1 FROM vault_devices rebound WHERE rebound.vault_id=vm.vault_id AND rebound.account_id=vm.account_id
	  AND rebound.device_id=$3::uuid AND rebound.removed_at_ms IS NULL AND rebound.added_at_ms>=admission.hlc_physical_ms))`,
		vaultID, accountID, installID).Scan(&retired)
	if err != nil {
		return err
	}
	if retired {
		return errReadmittedDeviceRetired
	}
	return nil
}

func readmissionPayload(ev *PushEvent) map[string]string {
	var payload map[string]string
	if json.Unmarshal(ev.Payload, &payload) != nil {
		return nil
	}
	return payload
}

// Readmission uses normal signed membership events so replicas can verify the
// same owner authority, but a fresh pair can only enter through the dedicated
// atomic request. Relays can still acknowledge an already committed event.
func isUncommittedReadmissionEvent(ctx context.Context, tx pgx.Tx, vaultID string, ev *PushEvent) (bool, error) {
	if !IsMembershipEventType(ev.EventType) {
		return false, nil
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(ev.Payload, &payload) != nil {
		return false, nil
	}
	if _, ok := payload[readmissionIDField]; !ok {
		return false, nil
	}
	var fresh bool
	err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM events WHERE vault_id=$1::uuid AND event_id=$2::uuid)`, vaultID, ev.EventID).Scan(&fresh)
	return fresh, err
}

func loadReadmissionForPush(ctx context.Context, tx pgx.Tx, in PushInput, role string, archived bool, anchor []byte, ordered []PushEvent) (int64, error) {
	if role != "owner" || archived || len(anchor) != ed25519.PublicKeySize || len(ordered) != 2 ||
		in.Session == nil || in.Session.AccountID != in.AccountID || in.Session.InstallID != in.DeviceID {
		return 0, ErrMemberReadmissionConflict
	}
	request, err := memberreadmission.LoadReadyForApproval(ctx, tx, in.VaultID, in.ReadmissionInviteID, in.AccountID)
	if errors.Is(err, memberreadmission.ErrNotReady) {
		return 0, ErrMemberReadmissionConflict
	}
	if err != nil {
		return 0, err
	}
	member, device := &ordered[0], &ordered[1]
	memberPayload, devicePayload := readmissionPayload(member), readmissionPayload(device)
	if member.EventType != EventVaultMemberAdded || device.EventType != EventVaultDeviceAdded ||
		member.EventID == device.EventID ||
		len(memberPayload) != 3 || len(devicePayload) != 4 ||
		memberPayload["account_id"] != request.AccountID || memberPayload["role"] != request.Role ||
		devicePayload["account_id"] != request.AccountID || devicePayload["device_id"] != request.DeviceID ||
		devicePayload["device_pubkey"] != request.DevicePubkey ||
		memberPayload[readmissionIDField] != in.ReadmissionInviteID || devicePayload[readmissionIDField] != in.ReadmissionInviteID ||
		derefStr(member.TargetID) != request.AccountID || derefStr(device.TargetID) != request.DeviceID ||
		member.HLC.PhysicalMS <= request.AfterMS || device.HLC.PhysicalMS != member.HLC.PhysicalMS ||
		member.HLC.Logical != 0 || device.HLC.Logical != 1 {
		return 0, ErrMemberReadmissionConflict
	}
	signer := derefStr(member.SignerDevicePubkeyB64)
	for _, ev := range ordered {
		if ev.SchemaVersion != 1 || ev.HLC.DeviceID != in.DeviceID || ev.AuthorSeq != nil || ev.RelationshipID != nil ||
			derefStr(ev.ActorAccountID) != in.AccountID || signer == "" || derefStr(ev.SignerDevicePubkeyB64) != signer || derefStr(ev.EventSigB64) == "" {
			return 0, ErrMemberReadmissionConflict
		}
	}
	pub, err := base64.StdEncoding.DecodeString(signer)
	if err != nil || len(pub) != ed25519.PublicKeySize || signer == request.DevicePubkey {
		return 0, ErrMemberReadmissionConflict
	}
	// A JWT proves the current owner account. The exact signed key must also
	// belong to that install and be an active owner device in the chain.
	var registered, canonicalOwner bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM device_keys dk JOIN installs i USING (install_id)
	 WHERE dk.install_id=$1::uuid AND i.account_id=$2::uuid AND i.account_deleted_at IS NULL AND dk.ed25519_pubkey=$3 FOR SHARE OF i,dk),
	 EXISTS(SELECT 1 FROM vaults WHERE vault_id=$4::uuid AND owner_account_id=$2::uuid)`, in.DeviceID, in.AccountID, pub, in.VaultID).Scan(&registered, &canonicalOwner); err != nil {
		return 0, err
	}
	if !registered {
		return 0, ErrMemberReadmissionConflict
	}
	removed, err := isRemovedDevicePubkey(ctx, tx, in.VaultID, pub)
	if err != nil {
		return 0, err
	}
	if removed {
		return 0, ErrMemberReadmissionConflict
	}
	if canonicalOwner && bytes.Equal(pub, anchor) {
		owner, err := anchorCurrentlyOwns(ctx, tx, in.VaultID, signer)
		if err != nil {
			return 0, err
		}
		if owner {
			return request.ID, nil
		}
	}
	accounts, err := boundAccountsForPubkey(ctx, tx, in.VaultID, pub, 9007199254740991)
	if err != nil {
		return 0, err
	}
	for _, accountID := range accounts {
		if accountID == in.AccountID {
			return request.ID, nil
		}
	}
	return 0, ErrMemberReadmissionConflict
}

func finishReadmissionPush(ctx context.Context, tx pgx.Tx, vaultID string, seatID int64, ordered []PushEvent) error {
	device := readmissionPayload(&ordered[1])
	pub, err := base64.StdEncoding.DecodeString(device["device_pubkey"])
	if err != nil {
		return ErrMemberReadmissionConflict
	}
	// Both events must actually change the operational state. In particular a
	// stale bind that the ordinary fold ignores cannot unlock this membership.
	tag, err := tx.Exec(ctx, `UPDATE vault_members vm SET readmission_member_event_id=$2::uuid,readmission_device_event_id=$3::uuid
	 WHERE vm.id=$1 AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
	 AND EXISTS (SELECT 1 FROM vault_devices vd WHERE vd.vault_id=$4::uuid AND vd.account_id=vm.account_id
	 AND vd.device_id=$5::uuid AND vd.device_pubkey=$6 AND vd.added_at_ms=$7 AND vd.removed_at_ms IS NULL)`,
		seatID, ordered[0].EventID, ordered[1].EventID, vaultID, device["device_id"], pub, ordered[1].HLC.PhysicalMS)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrMemberReadmissionConflict
	}
	return nil
}
