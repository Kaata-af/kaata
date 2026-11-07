package sync

import (
	"context"
	"encoding/json"
	"math/big"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/credit"
)

const (
	rejectPersonChanged     = "person_changed"
	rejectPersonShared      = "person_shared_active"
	rejectSettlementChanged = "settlement_changed"
	rejectSettlementNotZero = "settlement_not_zero"
	rejectSettlementEmpty   = "settlement_empty"
)

type observedLedgerMutation struct {
	ExpectedServerSeq *int64 `json:"expected_server_seq"`
	SettledAtMS       int64  `json:"settled_at_ms"`
	Currency          string `json:"currency"`
}

// Browser lifecycle actions carry the visible ledger frontier in their signed
// payload. Check that frontier under Push's existing vault/admission locks.
// Native offline events retain their existing wire and replay semantics.
func admitObservedLedgerMutation(ctx context.Context, tx pgx.Tx, vaultID string, event PushEvent, role string, archived, activeGroup bool) (string, error) {
	if event.EventType != EventPersonArchived && event.EventType != EventPersonUnarchived && event.EventType != EventEntrySettled {
		return "", nil
	}
	var payload observedLedgerMutation
	if json.Unmarshal(event.Payload, &payload) != nil || payload.ExpectedServerSeq == nil {
		return "", nil
	}
	// An acknowledged marker may be replayed after a new tally arrives. It
	// remains the same event, with its original recording-time boundary.
	if duplicate, err := creditDuplicateMatches(ctx, tx, vaultID, event); err != nil || duplicate {
		return "", err
	}
	changed := rejectPersonChanged
	if event.EventType == EventEntrySettled {
		changed = rejectSettlementChanged
	}
	if !roleSatisfies(role, "editor") {
		return "insufficient_role", nil
	}
	if archived {
		return changed, nil
	}
	events, frontier, err := loadVaultEvents(ctx, tx, vaultID)
	if err != nil {
		return "", err
	}
	if *payload.ExpectedServerSeq != frontier {
		return changed, nil
	}
	projection, err := ApplyEvents(events)
	if err != nil {
		return "", err
	}
	relationshipID := derefStr(event.RelationshipID)
	person := projection.Relationships[relationshipID]
	if person == nil || relationshipID == "" || person.VaultID != vaultID {
		return changed, nil
	}
	if event.EventType != EventEntrySettled {
		if person.UserBID != derefStr(event.TargetID) || (person.ArchivedAt != nil) != (event.EventType == EventPersonUnarchived) {
			return changed, nil
		}
		if event.EventType == EventPersonArchived {
			if activeGroup {
				return rejectPersonShared, nil
			}
			var active bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (
				SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
				WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND (t.closed_at IS NULL OR EXISTS (
				  SELECT 1 FROM tab_entries e WHERE e.tab_id=t.id AND e.kind<>'void'
				  AND e.status='pending' AND e.voided_by_entry_id IS NULL)))`, vaultID, relationshipID).Scan(&active); err != nil {
				return "", err
			}
			if active {
				return rejectPersonShared, nil
			}
		}
		return "", nil
	}
	if person.ArchivedAt != nil || relationshipID != derefStr(event.TargetID) || !credit.ValidCurrency(payload.Currency) {
		return changed, nil
	}
	var linked bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM tab_parties
		WHERE vault_id=$1::uuid AND relationship_id=$2::uuid)`, vaultID, relationshipID).Scan(&linked); err != nil {
		return "", err
	}
	if linked {
		return RejectReasonSharedTallyRequired, nil
	}
	legacyCurrency, err := credit.ResolveCurrency(ctx, tx, vaultID)
	if err != nil {
		return "", err
	}
	return verifyObservedSettlement(&projection, events, relationshipID, legacyCurrency, payload), nil
}

func verifyObservedSettlement(projection *Projection, events []LedgerEvent, relationshipID, legacyCurrency string, payload observedLedgerMutation) string {
	var previous int64
	for _, event := range events {
		if event.EventType != EventEntrySettled || derefStr(event.RelationshipID) != relationshipID {
			continue
		}
		var marker observedLedgerMutation
		if json.Unmarshal(event.Payload, &marker) != nil {
			continue
		}
		if marker.Currency == "" {
			marker.Currency = legacyCurrency
		}
		if marker.Currency == payload.Currency {
			previous = max(previous, marker.SettledAtMS)
		}
	}
	var newest int64
	balance := new(big.Int)
	for _, entry := range projection.Entries {
		currency := entry.Currency
		if currency == "" {
			currency = legacyCurrency
		}
		if entry.RelationshipID != relationshipID || currency != payload.Currency || entry.IsDeleted || entry.DeletedAt != nil {
			continue
		}
		if entry.DisputedAt != nil {
			return rejectSettlementChanged
		}
		amount, err := canonicalWebMoney(entry.AmountAFN)
		if err != nil {
			return rejectSettlementChanged
		}
		minor, ok := new(big.Rat).SetString(amount)
		if !ok {
			return rejectSettlementChanged
		}
		minor.Mul(minor, big.NewRat(100, 1))
		switch entry.Type {
		case "debt":
			balance.Add(balance, minor.Num())
		case "payment":
			balance.Sub(balance, minor.Num())
		default:
			return rejectSettlementChanged
		}
		recorded := entry.RecordedAtMS
		if recorded == 0 {
			recorded = entry.CreatedAt
		}
		if !entry.IsSettled && entry.SettledAt == nil && recorded > previous {
			newest = max(newest, recorded)
		}
	}
	if balance.Sign() != 0 {
		return rejectSettlementNotZero
	}
	if newest == 0 {
		return rejectSettlementEmpty
	}
	if payload.SettledAtMS != newest {
		return rejectSettlementChanged
	}
	return ""
}
