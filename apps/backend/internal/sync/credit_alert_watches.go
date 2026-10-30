package sync

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/credit"
)

type creditWatchID struct{ relationshipID, key string }
type creditWatch struct {
	policy   *credit.AlertPolicy
	balances map[string]int64
}

// The existing combined-rule watch and each ordinary currency have separate
// episodes. Reaching AFN must not be hidden by USD already being at its cap.
func creditWatchPolicy(ctx context.Context, tx pgx.Tx, vaultID, relID, key string) (*credit.AlertPolicy, error) {
	if key == "" {
		return credit.EffectiveAlerts(ctx, tx, vaultID, relID)
	}
	if !strings.HasPrefix(key, "limit:") || !credit.ValidCurrency(strings.TrimPrefix(key, "limit:")) {
		return nil, nil
	}
	enabled, err := credit.EffectiveLimitNotification(ctx, tx, vaultID, relID)
	if err != nil || enabled == nil || !enabled.Enabled {
		return nil, err
	}
	p, err := credit.Effective(ctx, tx, vaultID, relID, strings.TrimPrefix(key, "limit:"))
	if err != nil {
		return nil, err
	}
	return credit.LimitAlertPolicy(p, enabled, relID), nil
}

func creditWatchBalances(ctx context.Context, tx pgx.Tx, vaultID, relID string, p *credit.AlertPolicy, projection *Projection, direction string) (map[string]int64, error) {
	balances := map[string]int64{}
	if p == nil {
		return balances, nil
	}
	for _, g := range p.Groups {
		if direction != "" && g.Direction != direction {
			continue
		}
		for _, c := range g.Conditions {
			if _, ok := balances[c.Currency]; ok {
				continue
			}
			n, err := creditBalanceWithProjection(ctx, tx, vaultID, relID, projection, c.Currency)
			if err != nil {
				return nil, err
			}
			balances[c.Currency] = n
		}
	}
	return balances, nil
}

func buildCreditWatches(ctx context.Context, tx pgx.Tx, vaultID string) (map[creditWatchID]creditWatch, error) {
	policies, err := credit.ListAlerts(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}
	notifications, err := credit.ListLimitNotifications(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}
	active := false
	byRel := map[string]*credit.AlertPolicy{}
	for i := range policies {
		byRel[policies[i].RelationshipID] = &policies[i]
		active = active || len(policies[i].Groups) > 0
	}
	flags := map[string]*credit.LimitNotificationPolicy{}
	for i := range notifications {
		flags[notifications[i].RelationshipID] = &notifications[i]
		active = active || notifications[i].Enabled
	}
	out := map[creditWatchID]creditWatch{}
	if !active {
		return out, nil
	}
	limits := map[string]map[string]*credit.Policy{}
	if len(notifications) > 0 {
		rows, err := tx.Query(ctx, `SELECT relationship_id::text,currency,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms FROM customer_credit_limits WHERE vault_id=$1::uuid`, vaultID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			p := new(credit.Policy)
			if err := rows.Scan(&p.RelationshipID, &p.Currency, &p.MaxCollectMinor, &p.MaxPayMinor, &p.Mode, &p.RestrictEditors, &p.UpdatedAtMS); err != nil {
				rows.Close()
				return nil, err
			}
			if limits[p.RelationshipID] == nil {
				limits[p.RelationshipID] = map[string]*credit.Policy{}
			}
			limits[p.RelationshipID][p.Currency] = p
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	projection, err := LoadVaultProjection(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}
	for id, rel := range projection.Relationships {
		if rel.VaultID != vaultID || rel.ArchivedAt != nil {
			continue
		}
		p := byRel[id]
		if p == nil {
			p = byRel[credit.DefaultRelationshipID]
		}
		if p != nil && len(p.Groups) > 0 {
			balances, err := creditWatchBalances(ctx, tx, vaultID, id, p, projection, "")
			if err != nil {
				return nil, err
			}
			out[creditWatchID{id, ""}] = creditWatch{p, balances}
		}
		flag := flags[id]
		if flag == nil {
			flag = flags[credit.DefaultRelationshipID]
		}
		if flag == nil || !flag.Enabled {
			continue
		}
		effective := map[string]*credit.Policy{}
		for code, p := range limits[credit.DefaultRelationshipID] {
			effective[code] = p
		}
		for code, p := range limits[id] {
			effective[code] = p
		}
		for code, cap := range effective {
			p := credit.LimitAlertPolicy(cap, flag, id)
			if p == nil {
				continue
			}
			balances, err := creditWatchBalances(ctx, tx, vaultID, id, p, projection, "")
			if err != nil {
				return nil, err
			}
			out[creditWatchID{id, "limit:" + code}] = creditWatch{p, balances}
		}
	}
	return out, nil
}

func (s *Service) scanCreditAlertWatches(ctx context.Context, tx pgx.Tx, vaultID, quietSubscriptionID string) error {
	watches, err := buildCreditWatches(ctx, tx, vaultID)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT s.id::text,s.preferences,s.customer_preferences,s.limit_alerts FROM credit_push_subscriptions s JOIN accounts a ON a.id=s.account_id JOIN vaults v ON v.vault_id=s.vault_id JOIN vault_members m ON m.id=s.vault_member_id AND m.vault_id=s.vault_id AND m.account_id=s.account_id WHERE s.vault_id=$1::uuid AND s.renewed_at>NOW()-INTERVAL '30 days' AND a.pending_delete_at IS NULL AND a.disabled_at IS NULL AND v.archived_at IS NULL AND m.role IN ('owner','manager') AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL AND EXISTS(SELECT 1 FROM auth_credentials ac JOIN installs i ON i.install_id=ac.install_id WHERE ac.install_id=s.install_id AND ac.account_id=s.account_id AND i.account_id=s.account_id AND ac.revoked_at IS NULL AND ac.session_epoch=s.session_epoch) ORDER BY s.id FOR UPDATE OF s`, vaultID)
	if err != nil {
		return err
	}
	type subscription struct {
		id               string
		prefs, customers []byte
		limits           bool
	}
	subs := []subscription{}
	for rows.Next() {
		var sub subscription
		if err := rows.Scan(&sub.id, &sub.prefs, &sub.customers, &sub.limits); err != nil {
			rows.Close()
			return err
		}
		subs = append(subs, sub)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, sub := range subs {
		quiet := sub.id == quietSubscriptionID
		active := []string{}
		for id, w := range watches {
			if id.key != "" && !sub.limits {
				continue
			}
			active = append(active, id.relationshipID+":"+id.key)
			prefs, prefErr := creditPreferencesFor(sub.prefs, sub.customers, id.relationshipID)
			for _, direction := range []string{"collect", "pay"} {
				fingerprint := creditAlertFingerprint(w.policy, direction)
				matched := w.policy.Matches(direction, w.balances)
				var oldFingerprint string
				var oldMatched bool
				var generation int64
				err := tx.QueryRow(ctx, `SELECT fingerprint,matched,generation FROM credit_alert_states WHERE subscription_id=$1::uuid AND relationship_id=$2::uuid AND direction=$3 AND watch_key=$4 FOR UPDATE`, sub.id, id.relationshipID, direction, id.key).Scan(&oldFingerprint, &oldMatched, &generation)
				first := errors.Is(err, pgx.ErrNoRows)
				if err != nil && !first {
					return err
				}
				crossed := !quiet && !first && oldFingerprint == fingerprint && !oldMatched && matched
				if crossed {
					generation++
				}
				if _, err := tx.Exec(ctx, `INSERT INTO credit_alert_states(subscription_id,relationship_id,direction,watch_key,fingerprint,matched,generation) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7) ON CONFLICT(subscription_id,relationship_id,direction,watch_key) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,matched=EXCLUDED.matched,generation=EXCLUDED.generation`, sub.id, id.relationshipID, direction, id.key, fingerprint, matched, generation); err != nil {
					return err
				}
				if quiet || !matched || first || oldFingerprint != fingerprint {
					if _, err := tx.Exec(ctx, `DELETE FROM credit_push_outbox WHERE subscription_id=$1::uuid AND relationship_id=$2::uuid AND direction=$3 AND watch_key=$4`, sub.id, id.relationshipID, direction, id.key); err != nil {
						return err
					}
				}
				if crossed && prefErr == nil && prefs.permits(time.Now()) {
					var eventKey string
					err := tx.QueryRow(ctx, `INSERT INTO credit_push_outbox(subscription_id,relationship_id,direction,watch_key,fingerprint,generation) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_key::text`, sub.id, id.relationshipID, direction, id.key, fingerprint, generation).Scan(&eventKey)
					if err != nil && !errors.Is(err, pgx.ErrNoRows) {
						return err
					}
					if err == nil {
						if _, err := tx.Exec(ctx, `INSERT INTO credit_alert_events(event_key,subscription_id,relationship_id,direction,watch_key,fingerprint,generation) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)`, eventKey, sub.id, id.relationshipID, direction, id.key, fingerprint, generation); err != nil {
							return err
						}
					}
				}
			}
		}
		for _, table := range []string{"credit_alert_states", "credit_push_outbox"} {
			if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE subscription_id=$1::uuid AND NOT(relationship_id::text||':'||watch_key=ANY($2::text[]))`, sub.id, active); err != nil {
				return err
			}
		}
	}
	_, err = tx.Exec(ctx, `UPDATE credit_push_subscriptions SET scanned_at=NOW() WHERE vault_id=$1::uuid`, vaultID)
	return err
}
