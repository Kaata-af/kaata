package auth

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/admininvite"
	"github.com/matee/kaata-backend/internal/memberreadmission"
	"github.com/matee/kaata-backend/internal/rolepolicy"
)

// This is a summary for the viewer's selected Kaata. A friendship itself
// never provides access to any of these records. No tokens or balances leave
// the server, and unjoined invites are only summarized for their own sender.
type PersonProfileActivity struct {
	SharedTally            string `json:"shared_tally,omitempty"`
	KaataInvitationRole    string `json:"kaata_invitation_role,omitempty"`
	KaataMemberRole        string `json:"kaata_member_role,omitempty"`
	ExistingRelationshipID string `json:"existing_relationship_id,omitempty"`
}

func (s *Service) loadPersonProfileActivity(ctx context.Context, viewer, target, vault string) (*PersonProfileActivity, error) {
	id, err := uuid.Parse(vault)
	if err != nil || id == uuid.Nil || id.String() != vault {
		return nil, nil
	}
	var out PersonProfileActivity
	err = s.pool.QueryRow(ctx, `WITH authorized AS (
 SELECT v.vault_id FROM vaults v JOIN vault_members m USING(vault_id)
 JOIN accounts owner ON owner.id=v.owner_account_id JOIN accounts viewer ON viewer.id=m.account_id
 WHERE v.vault_id=$3::uuid AND m.account_id=$1::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
 AND v.archived_at IS NULL AND v.purged_at IS NULL
 AND owner.disabled_at IS NULL AND owner.pending_delete_at IS NULL
 AND viewer.disabled_at IS NULL AND viewer.pending_delete_at IS NULL
), pair_groups AS (
 SELECT CASE WHEN g.a_vault_id=$3::uuid THEN g.a_relationship_id ELSE g.b_relationship_id END::text AS relationship_id,
 CASE WHEN g.closed_at IS NULL AND g.b_joined_at IS NOT NULL AND g.a_account_id IS NOT NULL
       AND g.b_account_id IS NOT NULL THEN 'active'
      WHEN g.closed_at IS NULL AND g.b_joined_at IS NULL AND NOT g.b_account_bound_once
       AND r.sender_account_id=$1::uuid AND r.recipient_account_id=$2::uuid
       THEN CASE WHEN r.declined_at IS NOT NULL THEN 'declined'
                 WHEN r.expires_at>NOW() THEN 'pending' ELSE '' END
      ELSE '' END AS state,
 g.created_at,g.id
 FROM authorized v JOIN tab_groups g ON g.a_vault_id=v.vault_id OR g.b_vault_id=v.vault_id
 LEFT JOIN people_requests r ON r.group_id=g.id
 WHERE (g.a_vault_id=v.vault_id AND (g.b_account_id=$2::uuid OR
        (g.b_account_id IS NULL AND r.sender_account_id=$1::uuid AND r.recipient_account_id=$2::uuid)))
    OR (g.b_vault_id=v.vault_id AND g.a_account_id=$2::uuid)
), chosen_group AS (
 SELECT relationship_id,state FROM pair_groups
 ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'declined' THEN 2 ELSE 3 END,created_at DESC,id DESC LIMIT 1
)
SELECT COALESCE((SELECT state FROM chosen_group),''),
 COALESCE((SELECT relationship_id FROM chosen_group),''),
 COALESCE((SELECT vm.role FROM vault_members vm
  JOIN vault_members authority ON authority.vault_id=vm.vault_id AND authority.account_id=$1::uuid
  WHERE vm.vault_id=v.vault_id AND vm.invited_by=$1::uuid AND vm.invite_account_id=$2::uuid
   AND vm.invite_request_id IS NOT NULL AND vm.accepted_at IS NULL AND vm.revoked_at IS NULL
   AND vm.invite_expires_at>NOW() AND vm.role IN ('manager','editor','clerk','viewer') AND `+admininvite.PendingSQL+`
   AND authority.accepted_at IS NOT NULL AND authority.revoked_at IS NULL AND authority.role IN ('owner','manager')
   AND (authority.custom_role_id IS NULL OR EXISTS(SELECT 1 FROM vault_custom_roles cr
    WHERE cr.id=authority.custom_role_id AND '`+rolepolicy.VaultMembers+`'=ANY(cr.permissions)))
   AND ((vm.readmission_from_id IS NULL AND NOT EXISTS (SELECT 1 FROM vault_members existing WHERE existing.vault_id=vm.vault_id
    AND existing.account_id=$2::uuid AND existing.accepted_at IS NOT NULL)) OR (`+memberreadmission.PendingSQL+`))
  ORDER BY vm.invited_at DESC,vm.id DESC LIMIT 1),''),
 COALESCE((SELECT member.role FROM vault_members member WHERE member.vault_id=v.vault_id
  AND member.account_id=$2::uuid AND member.accepted_at IS NOT NULL AND member.revoked_at IS NULL LIMIT 1),'')
FROM authorized v`, viewer, target, vault).Scan(&out.SharedTally, &out.ExistingRelationshipID, &out.KaataInvitationRole, &out.KaataMemberRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if out == (PersonProfileActivity{}) {
		return nil, nil
	}
	return &out, nil
}
