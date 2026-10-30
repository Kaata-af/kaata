package credit

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type LimitNotificationPolicy struct {
	RelationshipID string `json:"relationship_id"`
	Enabled        bool   `json:"enabled"`
	UpdatedAtMS    int64  `json:"updated_at_ms"`
}

func ListLimitNotifications(ctx context.Context, q AlertReader, vaultID string) ([]LimitNotificationPolicy, error) {
	rows, err := q.Query(ctx, `SELECT relationship_id::text,enabled,updated_at_ms FROM customer_credit_limit_notifications WHERE vault_id=$1::uuid ORDER BY relationship_id`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LimitNotificationPolicy{}
	for rows.Next() {
		var p LimitNotificationPolicy
		if err := rows.Scan(&p.RelationshipID, &p.Enabled, &p.UpdatedAtMS); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func EffectiveLimitNotification(ctx context.Context, q AlertReader, vaultID, relationshipID string) (*LimitNotificationPolicy, error) {
	var p LimitNotificationPolicy
	err := q.QueryRow(ctx, `SELECT relationship_id::text,enabled,updated_at_ms FROM customer_credit_limit_notifications WHERE vault_id=$1::uuid AND relationship_id IN ($2::uuid,$3::uuid) ORDER BY CASE WHEN relationship_id=$2::uuid THEN 0 ELSE 1 END LIMIT 1`, vaultID, relationshipID, DefaultRelationshipID).Scan(&p.RelationshipID, &p.Enabled, &p.UpdatedAtMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// Ordinary notifications derive their thresholds from the authoritative caps;
// they never copy a cap into a second independently editable rule. A zero cap
// alerts at the first positive minor unit, while a settled zero stays clear.
func LimitAlertPolicy(p *Policy, enabled *LimitNotificationPolicy, relationshipID string) *AlertPolicy {
	if p == nil || enabled == nil || !enabled.Enabled {
		return nil
	}
	result := &AlertPolicy{RelationshipID: relationshipID, Groups: []AlertGroup{}, UpdatedAtMS: max(p.UpdatedAtMS, enabled.UpdatedAtMS)}
	for _, side := range []struct {
		direction string
		cap       *int64
	}{{"collect", p.MaxCollectMinor}, {"pay", p.MaxPayMinor}} {
		if side.cap != nil {
			result.Groups = append(result.Groups, AlertGroup{Direction: side.direction, Conditions: []AlertCondition{{Currency: p.Currency, ThresholdMinor: max(1, *side.cap)}}})
		}
	}
	if len(result.Groups) == 0 {
		return nil
	}
	return result
}
