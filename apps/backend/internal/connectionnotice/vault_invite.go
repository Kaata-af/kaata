// Package connectionnotice records account-scoped connection outcomes in the
// same transaction as the action, shared by invitation and signed sync flows.
package connectionnotice

import (
	"context"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// VaultInviteAccepted records completed membership, never preliminary
// readmission consent. The caller holds the referenced account locks before
// the vault lock. A stable source also covers link/email invitations, whose
// membership seat has no account-invitation UUID. Retries cannot add duplicates.
func VaultInviteAccepted(ctx context.Context, tx pgx.Tx, memberID int64) error {
	source := uuid.NewSHA1(uuid.NameSpaceOID, []byte("kaata:vault-invite:"+strconv.FormatInt(memberID, 10)))
	_, err := tx.Exec(ctx, `INSERT INTO account_connection_notifications
 (event_kind,source_id,recipient_account_id,actor_account_id,actor_label,vault_label)
 SELECT 'vault_invite_accepted',COALESCE(vm.invite_request_id,$2::uuid),vm.invited_by,vm.account_id,
 COALESCE(NULLIF(actor.display_name,''),NULLIF(actor.name,''),'Kaata user'),v.name
 FROM vault_members vm JOIN vaults v ON v.vault_id=vm.vault_id
 JOIN accounts actor ON actor.id=vm.account_id JOIN accounts recipient ON recipient.id=vm.invited_by
 WHERE vm.id=$1 AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
 AND vm.invited_by<>vm.account_id AND v.archived_at IS NULL AND v.purged_at IS NULL
 AND actor.disabled_at IS NULL AND actor.pending_delete_at IS NULL
 AND recipient.disabled_at IS NULL AND recipient.pending_delete_at IS NULL
 AND (vm.readmission_from_id IS NULL OR
  (vm.readmission_member_event_id IS NOT NULL AND vm.readmission_device_event_id IS NOT NULL))
 AND EXISTS(SELECT 1 FROM vault_members authority WHERE authority.vault_id=vm.vault_id
  AND authority.account_id=vm.invited_by AND authority.accepted_at IS NOT NULL AND authority.revoked_at IS NULL)
 ON CONFLICT(event_kind,source_id) DO NOTHING`, memberID, source)
	return err
}
