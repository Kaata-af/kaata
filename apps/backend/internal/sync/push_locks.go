package sync

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Account deletion locks account before vault. Push must acquire every account
// FK it may write in that order too, including relayed authors and membership
// fold references. Original NULL actors stay NULL and acquire no actor lock.
func lockPushAccounts(ctx context.Context, tx pgx.Tx, in PushInput) (map[uuid.UUID]bool, error) {
	caller, err := uuid.Parse(in.AccountID)
	if err != nil {
		return nil, ErrNotMember
	}
	ids := map[uuid.UUID]bool{caller: true}
	add := func(raw string) {
		if id, err := uuid.Parse(raw); err == nil {
			ids[id] = true
		}
	}
	for _, ev := range in.Events {
		if ev.ActorAccountID != nil {
			add(*ev.ActorAccountID)
		}
		if IsMembershipEventType(ev.EventType) {
			var p struct {
				AccountID string `json:"account_id"`
				Witness   *struct {
					InviterAccountID string `json:"inviter_account_id"`
				} `json:"witness"`
			}
			if json.Unmarshal(ev.Payload, &p) == nil {
				add(p.AccountID)
				if p.Witness != nil {
					add(p.Witness.InviterAccountID)
				}
			}
		}
	}
	keys := make([]string, 0, len(ids))
	for id := range ids {
		keys = append(keys, id.String())
	}
	rows, err := tx.Query(ctx, `SELECT id::text FROM accounts
		WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE`, keys)
	if err != nil {
		return nil, fmt.Errorf("lock push accounts: %w", err)
	}
	defer rows.Close()
	locked := make(map[uuid.UUID]bool, len(ids))
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan locked push account: %w", err)
		}
		locked[uuid.MustParse(id)] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("lock push accounts: %w", err)
	}
	if !locked[caller] {
		return nil, ErrNotMember
	}
	return locked, nil
}
