package credit

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// AlertPolicy is advisory configuration, separate from per-currency admission
// limits. Any group can trigger; every condition within that group must match.
// A missing customer policy inherits the default; an explicit empty list is off.
type AlertPolicy struct {
	RelationshipID string       `json:"relationship_id"`
	Groups         []AlertGroup `json:"groups"`
	UpdatedAtMS    int64        `json:"updated_at_ms"`
}

type AlertGroup struct {
	Direction  string           `json:"direction"`
	Conditions []AlertCondition `json:"conditions"`
}

type AlertCondition struct {
	Currency       string `json:"currency"`
	ThresholdMinor int64  `json:"threshold_minor"`
}

func (p AlertPolicy) Valid() bool {
	if p.Groups == nil || len(p.Groups) > 20 {
		return false
	}
	for _, g := range p.Groups {
		if (g.Direction != "collect" && g.Direction != "pay") || len(g.Conditions) == 0 || len(g.Conditions) > 20 {
			return false
		}
		seen := map[string]bool{}
		for _, c := range g.Conditions {
			if !ValidCurrency(c.Currency) || seen[c.Currency] || c.ThresholdMinor <= 0 || c.ThresholdMinor > 999999999999 {
				return false
			}
			seen[c.Currency] = true
		}
	}
	return true
}

// Matches compares each currency's signed exposure independently. It never
// converts or adds unlike currencies, and a threshold is inclusive.
func (p AlertPolicy) Matches(direction string, balances map[string]int64) bool {
	if direction != "collect" && direction != "pay" {
		return false
	}
	for _, g := range p.Groups {
		if g.Direction != direction || len(g.Conditions) == 0 {
			continue
		}
		matched := true
		for _, c := range g.Conditions {
			balance := balances[c.Currency]
			if (direction == "collect" && balance < c.ThresholdMinor) || (direction == "pay" && balance > -c.ThresholdMinor) {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

type AlertReader interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func ListAlerts(ctx context.Context, q AlertReader, vaultID string) ([]AlertPolicy, error) {
	rows, err := q.Query(ctx, `SELECT relationship_id::text,groups,updated_at_ms FROM customer_credit_alerts WHERE vault_id=$1::uuid ORDER BY relationship_id`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertPolicy{}
	for rows.Next() {
		var p AlertPolicy
		var groups []byte
		if err := rows.Scan(&p.RelationshipID, &groups, &p.UpdatedAtMS); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(groups, &p.Groups); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func ReadAlerts(ctx context.Context, q AlertReader, vaultID, relationshipID string) (*AlertPolicy, error) {
	var p AlertPolicy
	var groups []byte
	err := q.QueryRow(ctx, `SELECT relationship_id::text,groups,updated_at_ms FROM customer_credit_alerts WHERE vault_id=$1::uuid AND relationship_id=$2::uuid`, vaultID, relationshipID).Scan(&p.RelationshipID, &groups, &p.UpdatedAtMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(groups, &p.Groups); err != nil {
		return nil, err
	}
	return &p, nil
}

func EffectiveAlerts(ctx context.Context, q AlertReader, vaultID, relationshipID string) (*AlertPolicy, error) {
	p, err := ReadAlerts(ctx, q, vaultID, relationshipID)
	if err != nil || p != nil || relationshipID == DefaultRelationshipID {
		return p, err
	}
	return ReadAlerts(ctx, q, vaultID, DefaultRelationshipID)
}
