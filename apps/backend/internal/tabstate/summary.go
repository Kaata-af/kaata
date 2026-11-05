package tabstate

import (
	"errors"
	"math/big"
	"sort"
)

var ErrHistoryUnavailable = errors.New("shared account history is incomplete")

type SummaryEntry struct {
	Minor                   *big.Int
	Kind, Status, CreatedBy string
	Seq, OccurredAt         int64
	Voided                  bool
}

type SummaryPeriod struct {
	ID, Currency, Role        string
	Order, LinkedAt, ClosedAt *int64
	Unjoined                  bool
	Entries                   []SummaryEntry
	SettledThrough            *int64
}

type SummaryPrivate struct {
	Currency               string
	Minor                  *big.Int
	RecordedAt, OccurredAt int64
	Settled                bool
	Disputed               bool
}

type CurrencySummary struct {
	Currency  string `json:"currency"`
	Recorded  string `json:"recorded"`
	Confirmed string `json:"confirmed"`
	Pending   string `json:"pending"`
	Private   string `json:"private"`
}

type Summary struct {
	Balances      []CurrencySummary
	LastEntryAt   *int64
	IsSettled     bool
	PendingForYou int
}

func Major(minor *big.Int) string {
	n := new(big.Int).Abs(minor)
	whole, cents := new(big.Int), new(big.Int)
	whole.QuoRem(n, big.NewInt(100), cents)
	value := whole.String() + "."
	if cents.Int64() < 10 {
		value += "0"
	}
	value += cents.String()
	if minor.Sign() < 0 {
		value = "-" + value
	}
	return value
}

// Summarize follows mobile's carried-period accounting. A saved opening
// checkpoints earlier saved history. A pending opening proposes a replacement
// and subtracts the money already carried instead of counting it twice.
func Summarize(periods []SummaryPeriod, private []SummaryPrivate) (Summary, error) {
	out := Summary{Balances: []CurrencySummary{}, IsSettled: true}
	byCurrency := map[string][]SummaryPeriod{}
	for _, p := range periods {
		byCurrency[p.Currency] = append(byCurrency[p.Currency], p)
	}
	for _, e := range private {
		if _, ok := byCurrency[e.Currency]; !ok {
			byCurrency[e.Currency] = nil
		}
		if out.LastEntryAt == nil || e.OccurredAt > *out.LastEntryAt {
			at := e.OccurredAt
			out.LastEntryAt = &at
		}
	}
	for code, history := range byCurrency {
		seen := map[int64]bool{}
		for _, p := range history {
			if (p.Order != nil && *p.Order <= 0) || (len(history) > 1 && (p.Order == nil || seen[*p.Order])) || (!p.Unjoined && p.LinkedAt == nil) {
				return Summary{}, ErrHistoryUnavailable
			}
			if p.Order != nil {
				seen[*p.Order] = true
			}
		}
		sort.Slice(history, func(i, j int) bool { return order(history[i]) < order(history[j]) })
		selectedIndex := len(history) - 1
		openPeriods := 0
		for i, period := range history {
			if period.ClosedAt == nil {
				selectedIndex = i
				openPeriods++
			}
		}
		if openPeriods > 1 {
			return Summary{}, ErrHistoryUnavailable
		}
		financialCheckpoint := 0
		var financialPeriod *SummaryPeriod
		for i := range history {
			if !history[i].Unjoined {
				financialPeriod = &history[i]
			}
			for _, e := range history[i].Entries {
				if e.Kind == "opening" && !e.Voided {
					if e.Status == "accepted" || e.Status == "recorded" {
						financialCheckpoint = i
					}
				}
			}
		}
		financial, confirmed, pending, local, currentFinancial := new(big.Int), new(big.Int), new(big.Int), new(big.Int), new(big.Int)
		pendingCount, localCount := 0, 0
		localSettled := true
		for _, e := range private {
			if e.Currency == code && !e.Disputed && (financialPeriod == nil || e.RecordedAt > *financialPeriod.LinkedAt) {
				local.Add(local, e.Minor)
				localCount++
				localSettled = localSettled && e.Settled
			}
		}
		// Saved balances are established before pending proposals are adjusted.
		for i, p := range history {
			for _, e := range p.Entries {
				if e.Voided || e.Kind == "void" {
					continue
				}
				signed := new(big.Int).Set(e.Minor)
				if e.Status == "accepted" || e.Status == "recorded" {
					if i >= financialCheckpoint {
						financial.Add(financial, signed)
					}
					if i == selectedIndex {
						currentFinancial.Add(currentFinancial, signed)
					}
				}
				if e.Status == "accepted" && i >= financialCheckpoint {
					confirmed.Add(confirmed, signed)
				}
			}
		}
		for i, p := range history {
			latest := i == selectedIndex
			privateBefore, privateBeforeCount := new(big.Int), 0
			if p.Unjoined && p.LinkedAt != nil {
				for _, entry := range private {
					if entry.Currency == code && !entry.Disputed && entry.RecordedAt <= *p.LinkedAt && (financialPeriod == nil || entry.RecordedAt > *financialPeriod.LinkedAt) {
						privateBefore.Add(privateBefore, entry.Minor)
						privateBeforeCount++
					}
				}
			}
			retainedInvitation := p.Unjoined && privateBeforeCount > 0
			if retainedInvitation {
				periodFinancial := new(big.Int)
				for _, entry := range p.Entries {
					if !entry.Voided && entry.Kind != "void" && (entry.Status == "accepted" || entry.Status == "recorded") {
						periodFinancial.Add(periodFinancial, entry.Minor)
					}
				}
				proposedCarry := new(big.Int).Add(new(big.Int).Sub(financial, periodFinancial), privateBefore)
				for _, entry := range p.Entries {
					if entry.Kind == "opening" && !entry.Voided && entry.Status != "disputed" && entry.Minor.Cmp(proposedCarry) != 0 {
						retainedInvitation = false
					}
				}
			}
			for _, e := range p.Entries {
				if latest && e.Kind != "void" && !(e.Kind == "opening" && retainedInvitation) && (out.LastEntryAt == nil || e.OccurredAt > *out.LastEntryAt) {
					at := e.OccurredAt
					out.LastEntryAt = &at
				}
				if e.Voided || e.Kind == "void" {
					continue
				}
				if e.Status == "pending" {
					if !(e.Kind == "opening" && retainedInvitation) {
						pendingCount++
						if e.CreatedBy != p.Role {
							out.PendingForYou++
						}
					}
					if (e.Kind != "opening" && i >= financialCheckpoint) || (e.Kind == "opening" && latest) {
						pending.Add(pending, e.Minor)
					}
				}
			}
			if latest {
				for _, e := range p.Entries {
					if e.Kind != "opening" || e.Voided || e.Status == "disputed" {
						continue
					}
					if e.Status == "pending" {
						pending.Sub(pending, new(big.Int).Sub(financial, currentFinancial))
					}
					pending.Sub(pending, privateBefore)
				}
			}
		}
		balance := new(big.Int).Add(financial, local)
		settled := balance.Sign() == 0 && pendingCount == 0 && localCount == 0 && financialPeriod != nil && financialPeriod.SettledThrough != nil
		if financialPeriod == nil {
			settled = balance.Sign() == 0 && pendingCount == 0 && localCount > 0 && localSettled
		}
		if settled && financialPeriod != nil {
			for _, e := range financialPeriod.Entries {
				if e.Seq > *financialPeriod.SettledThrough {
					settled = false
				}
			}
		}
		out.IsSettled = out.IsSettled && settled
		out.Balances = append(out.Balances, CurrencySummary{Currency: code, Recorded: Major(balance), Confirmed: Major(confirmed), Pending: Major(pending), Private: Major(local)})
	}
	sort.Slice(out.Balances, func(i, j int) bool { return out.Balances[i].Currency < out.Balances[j].Currency })
	return out, nil
}

func order(p SummaryPeriod) int64 {
	if p.Order == nil {
		return 0
	}
	return *p.Order
}
