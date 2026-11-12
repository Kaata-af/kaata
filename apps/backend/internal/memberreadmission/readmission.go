// Package memberreadmission shares the fail-closed consent checks between the
// invitation API and atomic signed-event publication without coupling services.
package memberreadmission

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/admininvite"
)

var ErrNotReady = errors.New("member readmission is no longer ready")

// PendingSQL uses the invitation alias vm. A fresh removal, replacement owner
// seat, or any active membership invalidates an old conditional grant.
const PendingSQL = `vm.readmission_from_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM vault_members source WHERE source.id=vm.readmission_from_id
  AND source.vault_id=vm.vault_id AND source.account_id=vm.invite_account_id
  AND source.accepted_at IS NOT NULL AND source.revoked_at IS NOT NULL
  AND source.id=(SELECT latest.id FROM vault_members latest
   WHERE latest.vault_id=vm.vault_id AND latest.account_id=vm.invite_account_id
    AND latest.accepted_at IS NOT NULL AND latest.revoked_at IS NOT NULL
   ORDER BY latest.revoked_at DESC,latest.id DESC LIMIT 1))
 AND EXISTS(SELECT 1 FROM vault_members owner WHERE owner.id=vm.readmission_owner_member_id
  AND owner.vault_id=vm.vault_id AND owner.account_id=vm.invited_by
  AND owner.role='owner' AND owner.accepted_at IS NOT NULL AND owner.revoked_at IS NULL
  AND COALESCE(owner.last_change_hlc_ms,0)=vm.readmission_owner_change_ms)
 AND NOT EXISTS(SELECT 1 FROM vault_members active WHERE active.vault_id=vm.vault_id
  AND active.account_id=vm.invite_account_id AND active.accepted_at IS NOT NULL AND active.revoked_at IS NULL)`

// A member-wide removal may be undone for this one consenting device. An
// explicit device removal is independent authority and must never be bypassed,
// including by changing the device ID while keeping the revoked public key.
const deviceAllowedSQL = `NOT EXISTS(SELECT 1 FROM vault_devices conflicting
 WHERE conflicting.vault_id=vm.vault_id AND conflicting.account_id<>vm.invite_account_id
 AND (conflicting.device_id=vm.readmission_install_id OR conflicting.device_pubkey=vm.readmission_device_pubkey))
 AND NOT EXISTS(SELECT 1 FROM vault_devices other JOIN vault_members source ON source.id=vm.readmission_from_id
 WHERE other.vault_id=vm.vault_id AND other.account_id=vm.invite_account_id
 AND other.device_id<>vm.readmission_install_id AND other.removed_at_ms IS NULL
 AND other.added_at_ms<=COALESCE(source.last_change_hlc_ms,0))
 AND NOT EXISTS(SELECT 1 FROM events e
 WHERE e.vault_id=vm.vault_id AND e.event_type='vault_device_removed'
 AND (e.payload->>'device_id'=vm.readmission_install_id::text OR EXISTS(
  SELECT 1 FROM vault_devices vd WHERE vd.vault_id=vm.vault_id
   AND vd.device_pubkey=vm.readmission_device_pubkey AND vd.device_id::text=e.payload->>'device_id')))
 AND NOT EXISTS(SELECT 1 FROM vault_devices vd JOIN vault_members source ON source.id=vm.readmission_from_id
 WHERE vd.vault_id=vm.vault_id AND (vd.device_id=vm.readmission_install_id OR vd.device_pubkey=vm.readmission_device_pubkey)
 AND vd.removed_at_ms IS NOT NULL AND vd.removed_at_ms>COALESCE(source.last_change_hlc_ms,0))`

type Ready struct {
	ID           int64
	AccountID    string
	Role         string
	DeviceID     string
	DevicePubkey string
	AfterMS      int64
}

// LoadReady must run inside a transaction holding the vault row lock. Callers
// that mutate account state lock those accounts before taking the vault lock.
// This function takes no account locks, preserving that global lock order.
func LoadReady(ctx context.Context, tx pgx.Tx, vaultID, inviteID, ownerID string) (Ready, error) {
	var out Ready
	err := tx.QueryRow(ctx, `SELECT vm.id,vm.invite_account_id::text,vm.role,
 vm.readmission_install_id::text,encode(vm.readmission_device_pubkey,'base64'),
 GREATEST(vm.readmission_after_ms,
  COALESCE((SELECT MAX(hlc_physical_ms) FROM events WHERE vault_id=vm.vault_id
   AND event_type IN ('vault_member_added','vault_member_role_changed','vault_member_removed','vault_device_added','vault_device_removed')),0),
  COALESCE((SELECT last_change_hlc_ms FROM vault_members WHERE id=vm.readmission_from_id),0),
  COALESCE((SELECT last_change_hlc_ms FROM vault_members WHERE id=vm.readmission_owner_member_id),0),
  COALESCE((SELECT MAX(GREATEST(added_at_ms,COALESCE(removed_at_ms,0))) FROM vault_devices WHERE vault_id=vm.vault_id),0))
 FROM vault_members vm JOIN vaults v ON v.vault_id=vm.vault_id
 JOIN accounts recipient ON recipient.id=vm.invite_account_id
 JOIN accounts inviter ON inviter.id=vm.invited_by
 JOIN accounts vault_owner ON vault_owner.id=v.owner_account_id
 JOIN installs i ON i.install_id=vm.readmission_install_id AND i.account_id=vm.invite_account_id
 JOIN device_keys dk ON dk.install_id=i.install_id AND dk.ed25519_pubkey=vm.readmission_device_pubkey
 WHERE vm.vault_id=$1::uuid AND vm.invite_request_id=$2::uuid AND vm.invited_by=$3::uuid
 AND vm.readmission_consented_at IS NOT NULL AND vm.accepted_at IS NULL AND vm.revoked_at IS NULL
 AND vm.invite_expires_at>NOW() AND vm.role IN ('manager','editor','clerk','viewer')
 AND v.archived_at IS NULL AND v.purged_at IS NULL AND i.account_deleted_at IS NULL
 AND recipient.disabled_at IS NULL AND recipient.pending_delete_at IS NULL
 AND inviter.disabled_at IS NULL AND inviter.pending_delete_at IS NULL
 AND vault_owner.disabled_at IS NULL AND vault_owner.pending_delete_at IS NULL
 AND EXISTS(SELECT 1 FROM auth_credentials c WHERE c.install_id=i.install_id
  AND c.account_id=vm.invite_account_id AND c.revoked_at IS NULL)
 AND `+PendingSQL+` AND `+admininvite.PendingSQL+` AND `+deviceAllowedSQL, vaultID, inviteID, ownerID).
		Scan(&out.ID, &out.AccountID, &out.Role, &out.DeviceID, &out.DevicePubkey, &out.AfterMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ready{}, ErrNotReady
	}
	return out, err
}

// LoadReadyForApproval additionally holds the recipient's exact current device
// and one live credential until commit. RegisterKey/SignOut do not take vault
// locks, so account/vault locks alone cannot protect this snapshot. Installs
// precede credentials, matching the sign-in lock order.
func LoadReadyForApproval(ctx context.Context, tx pgx.Tx, vaultID, inviteID, ownerID string) (Ready, error) {
	ready, err := LoadReady(ctx, tx, vaultID, inviteID, ownerID)
	if err != nil {
		return Ready{}, err
	}
	var current bool
	err = tx.QueryRow(ctx, `SELECT TRUE FROM installs i JOIN device_keys dk USING(install_id)
 WHERE i.install_id=$1::uuid AND i.account_id=$2::uuid AND i.account_deleted_at IS NULL
 AND encode(dk.ed25519_pubkey,'base64')=$3 FOR SHARE OF i,dk`, ready.DeviceID, ready.AccountID, ready.DevicePubkey).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ready{}, ErrNotReady
	}
	if err != nil {
		return Ready{}, err
	}
	err = tx.QueryRow(ctx, `SELECT TRUE FROM auth_credentials WHERE install_id=$1::uuid
 AND account_id=$2::uuid AND revoked_at IS NULL ORDER BY provider LIMIT 1 FOR SHARE`, ready.DeviceID, ready.AccountID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ready{}, ErrNotReady
	}
	if err != nil {
		return Ready{}, err
	}
	return LoadReady(ctx, tx, vaultID, inviteID, ownerID)
}
