package sync

import (
	"context"
	"math/big"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/tabstate"
)

type WebSharedTab struct {
	ID                 string  `json:"id"`
	GroupID            *string `json:"group_id"`
	Role               string  `json:"role"`
	Currency           string  `json:"currency"`
	HistoryOrder       *string `json:"history_order"`
	LinkedAtMS         *int64  `json:"linked_at_ms"`
	ClosedAtMS         *int64  `json:"closed_at_ms"`
	RecordingMode      string  `json:"recording_mode"`
	Rev                int64   `json:"rev"`
	UnjoinedInvitation bool    `json:"unjoined_invitation"`
}

type WebSharedPerson struct {
	Tabs            []WebSharedTab             `json:"tabs"`
	Balances        []tabstate.CurrencySummary `json:"balances"`
	PendingForYou   int                        `json:"pending_for_you"`
	PrivateWritable bool                       `json:"private_writable"`
}

func populateWebSharedLedger(ctx context.Context, tx pgx.Tx, view *WebLedger, projection *Projection) error {
	rows, err := tx.Query(ctx, `SELECT p.relationship_id::text,t.id::text,t.group_id::text,p.role,t.currency,
		p.history_order,p.history_order::text,p.linked_at_ms,t.closed_at,t.recording_mode,t.rev,
		`+tabstate.UnjoinedInvitationSQL+`,
		(SELECT MAX(s.through_seq) FROM tab_settlements s WHERE s.tab_id=t.id)
		FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
		WHERE p.vault_id=$1::uuid AND p.relationship_id IS NOT NULL
		ORDER BY p.relationship_id,t.currency,p.history_order NULLS FIRST,t.id`, view.VaultID)
	if err != nil {
		return err
	}
	periods := map[string][]tabstate.SummaryPeriod{}
	bindings := map[string][]WebSharedTab{}
	tabRelationship := map[string]string{}
	tabIndex := map[string]int{}
	for rows.Next() {
		var relationship string
		var binding WebSharedTab
		var period tabstate.SummaryPeriod
		var closed *time.Time
		if err := rows.Scan(&relationship, &binding.ID, &binding.GroupID, &binding.Role, &binding.Currency, &period.Order,
			&binding.HistoryOrder, &binding.LinkedAtMS, &closed, &binding.RecordingMode, &binding.Rev, &binding.UnjoinedInvitation, &period.SettledThrough); err != nil {
			rows.Close()
			return err
		}
		if closed != nil {
			at := closed.UnixMilli()
			binding.ClosedAtMS = &at
		}
		period.ID, period.Role, period.Currency = binding.ID, binding.Role, binding.Currency
		period.LinkedAt, period.ClosedAt, period.Unjoined = binding.LinkedAtMS, binding.ClosedAtMS, binding.UnjoinedInvitation
		tabIndex[binding.ID] = len(periods[relationship])
		tabRelationship[binding.ID] = relationship
		periods[relationship] = append(periods[relationship], period)
		bindings[relationship] = append(bindings[relationship], binding)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(periods) == 0 {
		return nil
	}
	rows, err = tx.Query(ctx, `SELECT e.tab_id::text,e.amount_minor::text,e.direction,e.kind,e.status,e.created_by,e.seq,e.occurred_at_ms,e.voided_by_entry_id IS NOT NULL
		FROM tab_entries e WHERE e.tab_id IN (SELECT p.tab_id FROM tab_parties p WHERE p.vault_id=$1::uuid AND p.relationship_id IS NOT NULL)
		ORDER BY e.tab_id,e.seq`, view.VaultID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, minor, direction string
		var entry tabstate.SummaryEntry
		if err := rows.Scan(&id, &minor, &direction, &entry.Kind, &entry.Status, &entry.CreatedBy, &entry.Seq, &entry.OccurredAt, &entry.Voided); err != nil {
			rows.Close()
			return err
		}
		relationship := tabRelationship[id]
		index := tabIndex[id]
		period := &periods[relationship][index]
		entry.Minor = new(big.Int)
		if _, ok := entry.Minor.SetString(minor, 10); !ok {
			rows.Close()
			return errLedgerAmountUnsupported
		}
		if (period.Role == "a" && direction == "b_to_a") || (period.Role == "b" && direction == "a_to_b") {
			entry.Minor.Neg(entry.Minor)
		}
		period.Entries = append(period.Entries, entry)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	private := map[string][]tabstate.SummaryPrivate{}
	people := map[string]*WebLedgerPerson{}
	for i := range view.People {
		people[view.People[i].RelationshipID] = &view.People[i]
	}
	for _, entry := range projection.Entries {
		if _, linked := periods[entry.RelationshipID]; !linked {
			continue
		}
		amount, err := canonicalWebMoney(entry.AmountAFN)
		if err != nil {
			return err
		}
		minor, ok := new(big.Rat).SetString(amount)
		if !ok {
			return errLedgerAmountUnsupported
		}
		minor.Mul(minor, big.NewRat(100, 1))
		value := new(big.Int).Set(minor.Num())
		if entry.Type == "payment" {
			value.Neg(value)
		}
		currency := entry.Currency
		if currency == "" {
			currency = view.LegacyCurrency
		}
		recorded := entry.RecordedAtMS
		if recorded == 0 {
			recorded = entry.CreatedAt
		}
		if !entry.IsDeleted && entry.DeletedAt == nil {
			settled := entry.SettledAt != nil || entry.IsSettled
			if person := people[entry.RelationshipID]; person != nil {
				settled = settled || person.SettledThrough[currency] >= recorded
			}
			private[entry.RelationshipID] = append(private[entry.RelationshipID], tabstate.SummaryPrivate{Currency: currency, Minor: value, RecordedAt: recorded, OccurredAt: entry.CreatedAt, Settled: settled, Disputed: entry.DisputedAt != nil})
		}
		view.SharedPrivateEntries = append(view.SharedPrivateEntries, WebLedgerEntry{ID: entry.ID, RelationshipID: entry.RelationshipID, Type: entry.Type,
			AmountAFN: amount, Currency: currency, Note: entry.Note, CreatedAt: entry.CreatedAt, RecordedAtMS: recorded, UpdatedAt: entry.UpdatedAt,
			CurrentEventID: entry.CurrentEventID, IsDeleted: entry.IsDeleted || entry.DeletedAt != nil, ReadOnly: true, SettledAt: entry.SettledAt, DisputedAt: entry.DisputedAt})
	}
	for i := range view.People {
		person := &view.People[i]
		history, linked := periods[person.RelationshipID]
		if !linked {
			continue
		}
		summary, err := tabstate.Summarize(history, private[person.RelationshipID])
		if err != nil {
			view.CreditBalancesComplete = false
			continue
		} // Keep the explicit incomplete/shared placeholder.
		person.Shared = &WebSharedPerson{Tabs: bindings[person.RelationshipID], Balances: summary.Balances, PendingForYou: summary.PendingForYou}
		person.Shared.PrivateWritable = view.ArchivedAtMS == nil && person.ArchivedAt == nil && roleRank[view.Role] >= 2
		for _, binding := range person.Shared.Tabs {
			if binding.ClosedAtMS == nil {
				person.Shared.PrivateWritable = false
			}
		}
		for _, period := range history {
			if period.Unjoined {
				for _, entry := range period.Entries {
					if entry.Kind == "opening" && entry.Status == "pending" && !entry.Voided {
						person.Shared.PrivateWritable = false
					}
				}
			}
		}
		if person.Shared.PrivateWritable && roleRank[view.Role] >= 3 {
			for i := range view.SharedPrivateEntries {
				entry := &view.SharedPrivateEntries[i]
				if entry.RelationshipID != person.RelationshipID || entry.IsDeleted || entry.SettledAt != nil || entry.DisputedAt != nil {
					continue
				}
				if source := projection.Entries[entry.ID]; source != nil && source.IsSettled {
					continue
				}
				if boundary, ok := person.SettledThrough[entry.Currency]; ok && boundary >= entry.RecordedAtMS {
					continue
				}
				var latest *tabstate.SummaryPeriod
				for i := range history {
					period := &history[i]
					if period.Currency == entry.Currency && !period.Unjoined && (latest == nil || (period.Order != nil && (latest.Order == nil || *period.Order > *latest.Order))) {
						latest = period
					}
				}
				if latest == nil || (latest.LinkedAt != nil && entry.RecordedAtMS > *latest.LinkedAt) {
					entry.ReadOnly = false
				}
			}
		}
		person.LastEntryAt = summary.LastEntryAt
		person.IsSettled = &summary.IsSettled
		if person.ArchivedAt == nil {
			view.IncompletePeople--
		}
	}
	sort.Slice(view.SharedPrivateEntries, func(i, j int) bool {
		if view.SharedPrivateEntries[i].CreatedAt != view.SharedPrivateEntries[j].CreatedAt {
			return view.SharedPrivateEntries[i].CreatedAt > view.SharedPrivateEntries[j].CreatedAt
		}
		return view.SharedPrivateEntries[i].ID < view.SharedPrivateEntries[j].ID
	})
	return nil
}
