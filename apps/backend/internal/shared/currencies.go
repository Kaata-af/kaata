package shared

import (
	"errors"
	"math"
	"strings"

	"github.com/matee/kaata-backend/internal/locale"
)

type shareEntry struct {
	ID       string  `json:"id,omitempty"`
	Type     string  `json:"type"`
	Amount   float64 `json:"amount"`
	Note     *string `json:"note"`
	Date     int64   `json:"date"`
	Currency string  `json:"currency"`
}

type shareHistorySettlement struct {
	AfterEntryID *string `json:"after_entry_id"`
	Date         int64   `json:"date"`
}

type shareHistory struct {
	Kind        string                   `json:"kind"`
	Entries     []shareEntry             `json:"entries"`
	Settlements []shareHistorySettlement `json:"settlements"`
}

type shareCurrencyLedger struct {
	Currency          string         `json:"currency"`
	CurrencyCode      string         `json:"currency_code"`
	Balance           *float64       `json:"balance"`
	Entries           []shareEntry   `json:"entries"`
	SettledChapters   int            `json:"settled_chapters"`
	SettledBoundaryMs *int64         `json:"settled_boundary_ms"`
	SettledBoundaries []int64        `json:"settled_boundaries"`
	History           []shareHistory `json:"history,omitempty"`
}

func validCurrency(code string) bool {
	if len(code) != 3 {
		return false
	}
	for _, r := range code {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

func validMoney(value float64) bool {
	minor := value * 100
	return !math.IsNaN(minor) && !math.IsInf(minor, 0) && math.Abs(minor) <= 9007199254740991 && math.Abs(minor-math.Round(minor)) < 0.000001
}

func validateSharePayload(p sharePayload) error {
	if strings.TrimSpace(p.Person) == "" {
		return errors.New("person is required")
	}
	if p.V != 2 && p.V != 3 {
		if p.V > 2 || len(p.Currencies) != 0 {
			return errors.New("unsupported bill version")
		}
		if len(p.Entries) > 500 {
			return errors.New("too many entries")
		}
		return nil
	}
	if len(p.Currencies) == 0 || len(p.Currencies) > maxSharedCurrencies || len(p.Entries) != 0 {
		return errors.New("invalid currency statements")
	}
	seen := make(map[string]bool)
	entryIDs := make(map[string]bool)
	count := 0
	markers := 0
	validateEntry := func(entry shareEntry, code string) error {
		if entry.Currency != code || (entry.Type != "debt" && entry.Type != "payment") || entry.Amount < 0 || !validMoney(entry.Amount) || entry.Date < 0 || entry.Date > 8640000000000000 {
			return errors.New("invalid currency entry")
		}
		if p.V == 3 {
			if strings.TrimSpace(entry.ID) == "" || entryIDs[entry.ID] {
				return errors.New("duplicate or missing bill entry id")
			}
			entryIDs[entry.ID] = true
		}
		count++
		if count > maxSharedEntries {
			return errors.New("too many entries")
		}
		return nil
	}
	for _, statement := range p.Currencies {
		if !validCurrency(statement.CurrencyCode) || seen[statement.CurrencyCode] || strings.TrimSpace(statement.Currency) == "" || statement.Balance == nil || !validMoney(*statement.Balance) || statement.Entries == nil {
			return errors.New("invalid currency statement")
		}
		seen[statement.CurrencyCode] = true
		if statement.SettledChapters < 0 || statement.SettledChapters > maxSharedEntries || len(statement.SettledBoundaries) > maxSharedEntries {
			return errors.New("invalid settlement history")
		}
		if statement.SettledBoundaryMs != nil && (*statement.SettledBoundaryMs < 0 || *statement.SettledBoundaryMs > 8640000000000000) {
			return errors.New("invalid settlement boundary")
		}
		for _, boundary := range statement.SettledBoundaries {
			if boundary < 0 || boundary > 8640000000000000 {
				return errors.New("invalid settlement boundary")
			}
		}
		if p.V == 3 {
			markers += len(statement.SettledBoundaries)
			if len(statement.SettledBoundaries) == 0 && statement.SettledBoundaryMs != nil {
				markers++
			}
			if markers > maxSharedEntries {
				return errors.New("too many settlement markers")
			}
		}
		for _, entry := range statement.Entries {
			if err := validateEntry(entry, statement.CurrencyCode); err != nil {
				return err
			}
		}
		if (p.V != 3 && statement.History != nil) || len(statement.History) > maxSharedEntries {
			return errors.New("unsupported bill history")
		}
		for _, history := range statement.History {
			if (history.Kind != "pre_link" && history.Kind != "closed_shared") || len(history.Entries) == 0 {
				return errors.New("invalid bill history")
			}
			positions := make(map[string]int)
			runningMinor := 0.0
			for i, entry := range history.Entries {
				if err := validateEntry(entry, statement.CurrencyCode); err != nil {
					return err
				}
				positions[entry.ID] = i
				minor := math.Round(entry.Amount * 100)
				if entry.Type == "payment" {
					minor = -minor
				}
				runningMinor += minor
				if math.Abs(runningMinor) > 9007199254740991 {
					return errors.New("unsafe historical balance")
				}
			}
			previous := -1
			for _, marker := range history.Settlements {
				markers++
				if markers > maxSharedEntries || marker.Date < 0 || marker.Date > 8640000000000000 {
					return errors.New("invalid history settlement")
				}
				position := -1
				if marker.AfterEntryID != nil {
					var exists bool
					position, exists = positions[*marker.AfterEntryID]
					if !exists {
						return errors.New("invalid history settlement anchor")
					}
				}
				if position < previous {
					return errors.New("unordered history settlements")
				}
				previous = position
			}
		}
	}
	return nil
}

func billCurrencyLabel(code, label string) string {
	if strings.Contains(label, code) {
		return label
	}
	return code + " " + label
}

type currencyPreview struct{ Currency, AbsBalance, Direction, Verb string }

func currencyPreviews(p sharePayload, lang string) []currencyPreview {
	result := make([]currencyPreview, 0, len(p.Currencies))
	for _, statement := range p.Currencies {
		direction, verb := "settled", "is settled"
		balance := 0.0
		if statement.Balance != nil {
			balance = *statement.Balance
		}
		if balance > 0 {
			direction, verb = "owe", "owes"
		} else if balance < 0 {
			direction, verb = "credit", "is owed"
		}
		if lang == "ps" {
			verb = map[string]string{"owe": "پوروړی دی", "credit": "طلبکار دی", "settled": "حساب یې تصفیه شوی"}[direction]
		} else if locale.RTL(lang) {
			verb = map[string]string{"owe": "قرضدار است", "credit": "طلبکار است", "settled": "تصفیه شده"}[direction]
		}
		amount := absFmt(balance)
		if locale.RTL(lang) {
			amount = localizeNum(amount)
		}
		result = append(result, currencyPreview{billCurrencyLabel(statement.CurrencyCode, statement.Currency), amount, direction, verb})
	}
	return result
}
