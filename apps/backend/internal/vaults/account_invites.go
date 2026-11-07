package vaults

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrInviteRecipientUnavailable = errors.New("recipient is unavailable")
	ErrInviteAlreadyMember        = errors.New("this person is already a member")
	ErrMemberReadmissionRequired  = errors.New("a previously removed member needs a new owner-signed admission")
	ErrInviteRoleConflict         = errors.New("a pending invitation already exists with a different role")
	ErrInvalidInviteAccount       = errors.New("target_account_id must be a uuid")
	ErrInviteSelf                 = errors.New("cannot invite yourself")
)

const maxPendingAccountInvites = 20
const maxAccountInviteInbox = 50

type CreateAccountInviteInput struct {
	VaultID, InviterAccID, TargetAccountID, Role string
}

type AccountInviteResult struct {
	InviteID    string    `json:"invite_id"`
	InviteToken string    `json:"invite_token"`
	Delivery    string    `json:"delivery"`
	ExpiresAt   time.Time `json:"expires_at"`
}

func accountInviteResult(id string, expiry time.Time) AccountInviteResult {
	return AccountInviteResult{InviteID: id, InviteToken: "v_" + id, Delivery: "in_app", ExpiresAt: expiry}
}

// Exact UUID selectors cannot be confused with the 43-character random tokens
// used by link/email invitations. Possession of a selector grants no authority.
func accountInviteSelector(token string) (string, bool) {
	if len(token) != 38 || !strings.HasPrefix(token, "v_") {
		return "", false
	}
	id, err := uuid.Parse(token[2:])
	if err != nil || id == uuid.Nil || id.String() != token[2:] {
		return "", false
	}
	return id.String(), true
}

type inviteAccountState struct{ active, discoverable bool }

// Account locks precede vault/member locks, matching deletion and sign-in.
// UPDATE also serializes different vaults inviting the same recipient so the
// inbox cap is hard, and protects the discoverability check until insertion.
func lockInviteAccounts(ctx context.Context, tx pgx.Tx, ids ...string) (map[string]inviteAccountState, error) {
	rows, err := tx.Query(ctx, `SELECT id::text,disabled_at IS NULL AND pending_delete_at IS NULL,discovery_enabled
 FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return nil, fmt.Errorf("lock invitation accounts: %w", err)
	}
	defer rows.Close()
	states := map[string]inviteAccountState{}
	for rows.Next() {
		var id string
		var state inviteAccountState
		if err := rows.Scan(&id, &state.active, &state.discoverable); err != nil {
			return nil, err
		}
		states[id] = state
	}
	return states, rows.Err()
}

func accountInviteVaultAvailable(ctx context.Context, tx pgx.Tx, vaultID string) (bool, error) {
	var available bool
	err := tx.QueryRow(ctx, `SELECT v.archived_at IS NULL AND v.purged_at IS NULL
 AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
 FROM vaults v JOIN accounts a ON a.id=v.owner_account_id WHERE v.vault_id=$1::uuid`, vaultID).Scan(&available)
	return available, err
}

func accountInviteMembershipConflict(ctx context.Context, tx pgx.Tx, vaultID, targetID string) error {
	var member, removed bool
	if err := tx.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL),
 EXISTS(SELECT 1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NOT NULL)`, vaultID, targetID).Scan(&member, &removed); err != nil {
		return err
	}
	if member {
		return ErrInviteAlreadyMember
	}
	// A server witness cannot resurrect removed chain membership. Keep this
	// path closed until coordinated owner-signed readmission is supported.
	if removed {
		return ErrMemberReadmissionRequired
	}
	return nil
}

func (s *Service) CreateAccountInvite(ctx context.Context, in CreateAccountInviteInput) (AccountInviteResult, error) {
	parsed, err := uuid.Parse(in.TargetAccountID)
	if err != nil || parsed == uuid.Nil || parsed.String() != in.TargetAccountID {
		return AccountInviteResult{}, ErrInvalidInviteAccount
	}
	if in.InviterAccID == in.TargetAccountID {
		return AccountInviteResult{}, ErrInviteSelf
	}
	if in.Role != "editor" && in.Role != "clerk" && in.Role != "viewer" {
		return AccountInviteResult{}, ErrInvalidRole
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AccountInviteResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	states, err := lockInviteAccounts(ctx, tx, in.InviterAccID, in.TargetAccountID)
	if err != nil {
		return AccountInviteResult{}, err
	}
	if !states[in.InviterAccID].active {
		return AccountInviteResult{}, ErrNotMember
	}
	if _, err := requireOwnerOrManager(ctx, tx, in.VaultID, in.InviterAccID); err != nil {
		return AccountInviteResult{}, err
	}
	available, err := accountInviteVaultAvailable(ctx, tx, in.VaultID)
	if err != nil {
		return AccountInviteResult{}, err
	}
	if !available {
		return AccountInviteResult{}, ErrInviteNotFound
	}
	if !states[in.TargetAccountID].active {
		return AccountInviteResult{}, ErrInviteRecipientUnavailable
	}
	if err := accountInviteMembershipConflict(ctx, tx, in.VaultID, in.TargetAccountID); err != nil {
		return AccountInviteResult{}, err
	}
	// A request whose original inviter lost authority must not trap a new
	// authorized inviter behind an unusable pending row. This and expiration
	// retain evidence while freeing the pending unique key; rollback preserves
	// the old row if creating a replacement is not permitted.
	if _, err := tx.Exec(ctx, `UPDATE vault_members vm SET revoked_at=NOW(),revoked_reason='invite_no_longer_valid',updated_at=NOW()
 WHERE vm.vault_id=$1::uuid AND vm.invite_account_id=$2::uuid AND vm.accepted_at IS NULL AND vm.revoked_at IS NULL
 AND (vm.invite_expires_at<=NOW() OR NOT EXISTS(SELECT 1 FROM vault_members authority JOIN accounts a ON a.id=authority.account_id
 WHERE authority.vault_id=vm.vault_id AND authority.account_id=vm.invited_by AND authority.accepted_at IS NOT NULL
 AND authority.revoked_at IS NULL AND authority.role IN ('owner','manager') AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL))`, in.VaultID, in.TargetAccountID); err != nil {
		return AccountInviteResult{}, err
	}
	var id, role string
	var expiry time.Time
	err = tx.QueryRow(ctx, `SELECT invite_request_id::text,role,invite_expires_at FROM vault_members
 WHERE vault_id=$1::uuid AND invite_account_id=$2::uuid AND accepted_at IS NULL AND revoked_at IS NULL
 AND invite_expires_at>NOW() FOR UPDATE`, in.VaultID, in.TargetAccountID).Scan(&id, &role, &expiry)
	if err == nil {
		if role != in.Role {
			return AccountInviteResult{}, ErrInviteRoleConflict
		}
		// A lost create reply retries the same invitation without resetting its
		// expiry or changing the grant, even if discovery was turned off later.
		return accountInviteResult(id, expiry), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AccountInviteResult{}, err
	}
	if !states[in.TargetAccountID].discoverable {
		// Discovery opt-out hides the directory, not an established friendship.
		// Account locks still protect activity and friendship mutations; this
		// alternative grants no membership and does not bypass inviter authority.
		var friends bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account_friendships
 WHERE account_low_id=LEAST($1::uuid,$2::uuid) AND account_high_id=GREATEST($1::uuid,$2::uuid)
 AND status='accepted')`, in.InviterAccID, in.TargetAccountID).Scan(&friends); err != nil {
			return AccountInviteResult{}, err
		}
		if !friends {
			return AccountInviteResult{}, ErrInviteRecipientUnavailable
		}
	}
	var vaultPending, recipientPending int
	// Count every unexpired pending request, including temporarily inactive
	// invitations: restoring an account/role must not overflow the bounded inbox.
	if err := tx.QueryRow(ctx, `SELECT
 COUNT(*) FILTER (WHERE vault_id=$1::uuid),COUNT(*) FILTER (WHERE invite_account_id=$2::uuid)
 FROM vault_members WHERE invite_request_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL
 AND invite_expires_at>NOW() AND (vault_id=$1::uuid OR invite_account_id=$2::uuid)`, in.VaultID, in.TargetAccountID).Scan(&vaultPending, &recipientPending); err != nil {
		return AccountInviteResult{}, err
	}
	if vaultPending >= maxPendingAccountInvites || recipientPending >= maxAccountInviteInbox {
		return AccountInviteResult{}, ErrTooManyPendingInvites
	}
	id, expiry = uuid.NewString(), time.Now().UTC().Truncate(time.Microsecond).Add(inviteTTL)
	if _, err := tx.Exec(ctx, `INSERT INTO vault_members(vault_id,role,invited_by,invite_account_id,invite_request_id,invite_expires_at)
 VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6)`, in.VaultID, in.Role, in.InviterAccID, in.TargetAccountID, id, expiry); err != nil {
		return AccountInviteResult{}, err
	}
	if _, err := writeAudit(ctx, tx, in.VaultID, &in.InviterAccID, "invite_issued", &in.TargetAccountID,
		map[string]any{"kind": "account", "role": in.Role, "invite_id": id}); err != nil {
		return AccountInviteResult{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE vaults SET vault_epoch=vault_epoch+1 WHERE vault_id=$1::uuid`, in.VaultID); err != nil {
		return AccountInviteResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AccountInviteResult{}, err
	}
	return accountInviteResult(id, expiry), nil
}

// Shared by authenticated preview and inbox reads. Discovery itself is not
// rechecked: turning it off stops new requests, not already-issued requests.
const liveAccountInviteSQL = `vm.invite_account_id=$1::uuid AND ` + liveAccountInviteStateSQL

const liveAccountInviteStateSQL = `vm.invite_request_id IS NOT NULL
 AND vm.accepted_at IS NULL AND vm.revoked_at IS NULL AND vm.invite_expires_at>NOW()
 AND v.archived_at IS NULL AND v.purged_at IS NULL
 AND inviter.disabled_at IS NULL AND inviter.pending_delete_at IS NULL
 AND recipient.disabled_at IS NULL AND recipient.pending_delete_at IS NULL
 AND vault_owner.disabled_at IS NULL AND vault_owner.pending_delete_at IS NULL
 AND EXISTS(SELECT 1 FROM vault_members authority WHERE authority.vault_id=vm.vault_id
  AND authority.account_id=vm.invited_by AND authority.accepted_at IS NOT NULL
  AND authority.revoked_at IS NULL AND authority.role IN ('owner','manager'))
 AND NOT EXISTS(SELECT 1 FROM vault_members existing WHERE existing.vault_id=vm.vault_id
  AND existing.account_id=vm.invite_account_id AND existing.accepted_at IS NOT NULL)`

func (s *Service) AccountInviteInfo(ctx context.Context, accountID, inviteID string) (InviteInfoResult, error) {
	if _, ok := accountInviteSelector("v_" + inviteID); !ok {
		return InviteInfoResult{}, ErrInviteNotFound
	}
	var out InviteInfoResult
	var email string
	var expiry time.Time
	err := s.pool.QueryRow(ctx, `SELECT v.name,vm.role,`+inviterNameSQL("inviter")+`,COALESCE(inviter.email,''),vm.invite_expires_at
 FROM vault_members vm JOIN vaults v ON v.vault_id=vm.vault_id
 JOIN accounts inviter ON inviter.id=vm.invited_by
 JOIN accounts recipient ON recipient.id=vm.invite_account_id
 JOIN accounts vault_owner ON vault_owner.id=v.owner_account_id
 WHERE `+liveAccountInviteSQL+` AND vm.invite_request_id=$2::uuid`, accountID, inviteID).
		Scan(&out.VaultName, &out.Role, &out.InviterName, &email, &expiry)
	if errors.Is(err, pgx.ErrNoRows) {
		return InviteInfoResult{}, ErrInviteNotFound
	}
	if err != nil {
		return InviteInfoResult{}, err
	}
	out.InviterEmailRedacted, out.ExpiresAt = redactEmail(email), expiry.UTC().Format(time.RFC3339)
	return out, nil
}

func (s *Service) DeclineAccountInvite(ctx context.Context, accountID, inviteID string) error {
	if _, ok := accountInviteSelector("v_" + inviteID); !ok {
		return ErrInviteNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	states, err := lockInviteAccounts(ctx, tx, accountID)
	if err != nil {
		return err
	}
	if !states[accountID].active {
		return ErrInviteNotFound
	}
	var vaultID string
	err = tx.QueryRow(ctx, `SELECT vault_id::text FROM vault_members WHERE invite_request_id=$1::uuid AND invite_account_id=$2::uuid`, inviteID, accountID).Scan(&vaultID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInviteNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM vaults WHERE vault_id=$1::uuid FOR UPDATE`, vaultID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE vault_members SET revoked_at=NOW(),revoked_by=$2::uuid,revoked_reason='declined',updated_at=NOW()
 WHERE invite_request_id=$1::uuid AND invite_account_id=$2::uuid AND accepted_at IS NULL AND revoked_at IS NULL`, inviteID, accountID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrInviteNotFound
	}
	if _, err := writeAudit(ctx, tx, vaultID, &accountID, "invite_declined", &accountID, map[string]any{"invite_id": inviteID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) listPendingAccountInvites(ctx context.Context, accountID string) ([]PendingInvite, error) {
	rows, err := s.pool.Query(ctx, `SELECT vm.invite_request_id::text,vm.vault_id::text,v.name,
 `+inviterNameSQL("inviter")+`,vm.role,vm.invited_at,vm.invite_expires_at
 FROM vault_members vm JOIN vaults v ON v.vault_id=vm.vault_id
 JOIN accounts inviter ON inviter.id=vm.invited_by
 JOIN accounts recipient ON recipient.id=vm.invite_account_id
 JOIN accounts vault_owner ON vault_owner.id=v.owner_account_id
 WHERE `+liveAccountInviteSQL+` ORDER BY vm.invited_at DESC LIMIT $2`, accountID, maxAccountInviteInbox)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]PendingInvite, 0)
	for rows.Next() {
		var p PendingInvite
		if err := rows.Scan(&p.InviteID, &p.VaultID, &p.VaultName, &p.InviterName, &p.Role, &p.InvitedAt, &p.ExpiresAt); err != nil {
			return nil, err
		}
		p.InviteToken = "v_" + p.InviteID
		out = append(out, p)
	}
	return out, rows.Err()
}

// Resolve the recipient before any attempt/audit mutation. Lock both account
// identities before the vault so deletion, opt-out, and acceptance serialize.
// A completed acceptance only needs the recipient lock: later inviter removal
// must not break a lost-response retry of a still-active membership.
func lockAccountInviteForAccept(ctx context.Context, tx pgx.Tx, inviteID, recipientID string) (string, error) {
	var inviter string
	var accepted bool
	err := tx.QueryRow(ctx, `SELECT COALESCE(invited_by::text,''),accepted_at IS NOT NULL
 FROM vault_members WHERE invite_request_id=$1::uuid AND invite_account_id=$2::uuid`, inviteID, recipientID).Scan(&inviter, &accepted)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInviteNotFound
	}
	if err != nil {
		return "", err
	}
	ids := []string{recipientID}
	if !accepted {
		if inviter == "" {
			return "", ErrInviteNotFound
		}
		ids = append(ids, inviter)
	}
	states, err := lockInviteAccounts(ctx, tx, ids...)
	if err != nil {
		return "", err
	}
	if !states[recipientID].active || (!accepted && !states[inviter].active) {
		return "", ErrInviteNotFound
	}
	if accepted {
		return "", nil
	}
	return inviter, nil
}
