package connectionnotice

import (
	"context"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/rolepolicy"
)

// Notice is an account-scoped outcome, never an invitation bearer credential.
// Callers hold all referenced account locks before their domain/vault locks.
type Notice struct {
	Kind, SourceID, RecipientID, ActorID, VaultID, Detail string
}

func Add(ctx context.Context, tx pgx.Tx, n Notice) error {
	for _, value := range []string{n.SourceID, n.RecipientID, n.ActorID} {
		if id, err := uuid.Parse(value); err != nil || id == uuid.Nil {
			return nil // Local-only chain identities cannot receive account alerts.
		}
	}
	_, err := tx.Exec(ctx, `INSERT INTO account_connection_notifications
 (event_kind,source_id,recipient_account_id,actor_account_id,actor_label,vault_id,vault_label,detail)
 SELECT $1,$2::uuid,recipient.id,actor.id,
 COALESCE(NULLIF(actor.display_name,''),NULLIF(actor.name,''),'Kaata user'),v.vault_id,v.name,NULLIF($6,'')
 FROM accounts actor CROSS JOIN accounts recipient
 LEFT JOIN vaults v ON v.vault_id=NULLIF($5,'')::uuid
 WHERE actor.id=$3::uuid AND recipient.id=$4::uuid AND actor.id<>recipient.id
 AND actor.disabled_at IS NULL AND actor.pending_delete_at IS NULL
 AND recipient.disabled_at IS NULL AND recipient.pending_delete_at IS NULL
 AND ($5='' OR (v.vault_id IS NOT NULL AND v.archived_at IS NULL AND v.purged_at IS NULL))
 ON CONFLICT(event_kind,source_id,recipient_account_id) DO NOTHING`,
		n.Kind, n.SourceID, n.ActorID, n.RecipientID, n.VaultID, n.Detail)
	return err
}

func Handled(ctx context.Context, tx pgx.Tx, kind, sourceID string) error {
	_, err := tx.Exec(ctx, `UPDATE account_connection_notifications SET read_at=COALESCE(read_at,NOW())
 WHERE event_kind=$1 AND source_id=$2::uuid`, kind, sourceID)
	return err
}

// AuditSource remains stable across delivery retries and distinct across later
// transitions of the same seat, including role A -> B -> A -> B.
func AuditSource(id int64) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("kaata:vault-audit:"+strconv.FormatInt(id, 10))).String()
}

// AdminAccounts is a pre-vault-lock snapshot. Callers must lock these account
// rows in sorted order alongside their other referenced accounts.
func AdminAccounts(ctx context.Context, tx pgx.Tx, vaultID string) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT account_id::text FROM vault_members
 WHERE vault_id=$1::uuid AND role IN ('owner','manager') AND accepted_at IS NOT NULL AND revoked_at IS NULL`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// MemberLeft only addresses currently authorized admins whose account rows the
// caller already locked. A concurrent new admin is picked up on their next view,
// never by acquiring a late account FK lock under the vault lock.
func MemberLeft(ctx context.Context, tx pgx.Tx, vaultID, actorID, sourceID string, locked []string) error {
	rows, err := tx.Query(ctx, `SELECT DISTINCT m.account_id::text FROM vault_members m
 WHERE m.vault_id=$1::uuid AND m.account_id=ANY($2::uuid[])
 AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL AND m.role IN ('owner','manager')
 AND (m.custom_role_id IS NULL OR EXISTS(SELECT 1 FROM vault_custom_roles cr
 WHERE cr.id=m.custom_role_id AND '`+rolepolicy.VaultMembers+`'=ANY(cr.permissions)))`, vaultID, locked)
	if err != nil {
		return err
	}
	var recipients []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		recipients = append(recipients, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, recipient := range recipients {
		if err := Add(ctx, tx, Notice{Kind: "vault_member_left", SourceID: sourceID, RecipientID: recipient, ActorID: actorID, VaultID: vaultID}); err != nil {
			return err
		}
	}
	return nil
}
