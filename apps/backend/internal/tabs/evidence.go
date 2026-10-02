package tabs

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// reviewSemanticsVersion identifies the API's one-time accept/reject action.
// It does not claim that legal consent text was displayed or an identity was
// verified. Historical reviews remain unversioned.
const reviewSemanticsVersion = "tally-review-v1"

func (s *Service) beginMutation(ctx context.Context, accountID *string) (pgx.Tx, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, err
	}
	if err := lockActor(ctx, tx, accountID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// evidenceRole snapshots the authority actually used for this action. A
// directly bound account is distinguished from a member acting for a party.
func (p Party) evidenceRole() *string {
	if p.actorAccount() == nil {
		return nil
	}
	role := p.MemberRole
	if role == "" {
		role = "account"
	}
	return &role
}

// lockActor serializes a write with account erasure. Call BEFORE the tab row
// lock: account deletion follows the same account -> tab lock order.
func lockActor(ctx context.Context, tx pgx.Tx, accountID *string) error {
	if accountID == nil || *accountID == "" {
		return nil
	}
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE id=$1::uuid FOR KEY SHARE`, *accountID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrAuthRequired
	}
	if err != nil {
		return fmt.Errorf("lock action account: %w", err)
	}
	return nil
}

// recheckParty runs under the tab lock. HTTP resolution can precede a delete,
// revocation or role change; never write using that stale authorization. The
// no-actor branch supports the service's legacy internal/token-only callers;
// the HTTP resolver always supplies the authenticated ActorAccountID.
func recheckParty(ctx context.Context, tx pgx.Tx, p Party, minRank int, invitation bool) (Party, error) {
	if p.ActorAccountID != "" {
		current, err := partyByAccountRoleQuery(ctx, tx, p.TabID, p.ActorAccountID, p.Role)
		if errors.Is(err, ErrNotFound) && invitation {
			var unclaimed bool
			if err = tx.QueryRow(ctx, `SELECT NOT account_bound_once AND account_id IS NULL AND vault_id IS NULL
			 FROM tab_parties WHERE tab_id=$1::uuid AND role=$2`, p.TabID, p.Role).Scan(&unclaimed); err != nil {
				return Party{}, err
			}
			if unclaimed {
				return p, nil
			}
			return Party{}, ErrNotFound
		}
		if err != nil {
			return Party{}, err
		}
		current.ActorInstallID = p.ActorInstallID
		p = current
	}
	if !p.allows(minRank) {
		return Party{}, ErrRoleInsufficient
	}
	return p, nil
}

// NotifyChanged refreshes authorized clients after an external transaction
// closes or otherwise changes shared records (for example account deletion).
// Call only after commit; the poke is a hint and carries no ledger data.
func (s *Service) NotifyChanged(ctx context.Context, tabIDs []string) {
	for _, tabID := range tabIDs {
		s.poke(ctx, tabID)
	}
}
