package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

var errLedgerAccountUnavailable = errors.New("ledger account unavailable")
var errLedgerAmountUnsupported = errors.New("ledger amount cannot be represented exactly")

var webMoneyPattern = regexp.MustCompile(`^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$`)

// canonicalWebMoney expands valid JSON number notation without passing through
// float64 or narrowing legacy integers to int64. Redundant zeroes do not change
// precision; a non-zero fraction of a hundredth is refused rather than rounded.
func canonicalWebMoney(amount json.Number) (string, error) {
	parts := webMoneyPattern.FindStringSubmatch(amount.String())
	if parts == nil {
		return "", errLedgerAmountUnsupported
	}
	coefficient := parts[2] + parts[3]
	digits := strings.TrimLeft(coefficient, "0")
	if digits == "" {
		return "0", nil
	}
	exponent := 0
	if parts[4] != "" {
		var err error
		exponent, err = strconv.Atoi(parts[4])
		// Bound expansion to PostgreSQL NUMERIC's maximum integer digits. This
		// also avoids arithmetic overflow or an allocation from a hostile exponent.
		if err != nil || exponent < -131072 || exponent > 131072 {
			return "", errLedgerAmountUnsupported
		}
	}
	point := len(parts[2]) + exponent - (len(coefficient) - len(digits))
	digits = strings.TrimRight(digits, "0")
	if point > 131072 || len(digits)-point > 2 {
		return "", errLedgerAmountUnsupported
	}
	var plain string
	switch {
	case point <= 0:
		plain = "0." + strings.Repeat("0", -point) + digits
	case point >= len(digits):
		plain = digits + strings.Repeat("0", point-len(digits))
	default:
		plain = digits[:point] + "." + digits[point:]
	}
	return parts[1] + plain, nil
}

// WebLedger is a current, read-only view of the same event log used by mobile.
// Browser writes still use signed events through Push, including its role and
// credit admission checks. There is no second browser ledger or write authority.
type WebLedger struct {
	VaultID              string            `json:"vault_id"`
	Name                 string            `json:"name"`
	Role                 string            `json:"role"`
	Currency             string            `json:"currency"`
	LegacyCurrency       string            `json:"legacy_currency"`
	DefaultEntryCurrency string            `json:"default_entry_currency"`
	EnabledCurrencies    []string          `json:"enabled_currencies"`
	ArchivedAtMS         *int64            `json:"archived_at_ms"`
	ServerSeq            int64             `json:"server_seq"`
	HLCLast              HLC               `json:"hlc_last"`
	DeviceRegistered     bool              `json:"device_registered"`
	DevicePubkey         *string           `json:"device_pubkey"`
	People               []WebLedgerPerson `json:"people"`
	Entries              []WebLedgerEntry  `json:"entries"`
	IncompletePeople     int               `json:"incomplete_people"`
}

type WebLedgerPerson struct {
	RelationshipID       string           `json:"relationship_id"`
	UserID               string           `json:"user_id"`
	Name                 string           `json:"name"`
	CreatedAt            int64            `json:"created_at"`
	LastEntryAt          *int64           `json:"last_entry_at"`
	IsSettled            *bool            `json:"is_settled"`
	PhoneE164            *string          `json:"phone_e164"`
	DefaultEntryCurrency *string          `json:"default_entry_currency"`
	Note                 *string          `json:"note,omitempty"`
	ArchivedAt           *int64           `json:"archived_at"`
	ReadOnly             bool             `json:"read_only"`
	ReadOnlyReason       *string          `json:"read_only_reason"`
	SettledThrough       map[string]int64 `json:"settled_through"`
}

type WebLedgerEntry struct {
	ID             string `json:"id"`
	RelationshipID string `json:"relationship_id"`
	Type           string `json:"type"`
	// Strings preserve historical decimal amounts without JavaScript rounding.
	AmountAFN      string  `json:"amount_afn"`
	Currency       string  `json:"currency"`
	Note           *string `json:"note"`
	CreatedAt      int64   `json:"created_at"`
	RecordedAtMS   int64   `json:"recorded_at_ms,omitempty"`
	UpdatedAt      int64   `json:"updated_at"`
	CurrentEventID string  `json:"current_event_id"`
	IsDeleted      bool    `json:"is_deleted"`
	ReadOnly       bool    `json:"read_only"`
	SettledAt      *int64  `json:"settled_at"`
}

// Ledger — GET /v1/sync/ledger?vault_id=<uuid> (PROTECTED).
func (h *Handler) Ledger(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	vaultID := r.URL.Query().Get("vault_id")
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}
	view, err := h.svc.WebLedger(r.Context(), claims.AccountID, claims.InstallID, vaultID)
	if err != nil {
		switch {
		case errors.Is(err, errLedgerAccountUnavailable):
			httpx.Error(w, http.StatusUnauthorized, "account is unavailable")
		case errors.Is(err, errLedgerAmountUnsupported):
			httpx.ErrorCode(w, http.StatusUnprocessableEntity, "ledger_amount_unsupported",
				"This kaata contains an amount the web app cannot display exactly. Open it in the mobile app.")
		case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound), errors.Is(err, ErrVaultArchived):
			writeMembershipDenied(w, err)
		default:
			log.Printf("web ledger read failed: %v", err)
			httpx.Error(w, http.StatusInternalServerError, "could not load kaata")
		}
		return
	}
	httpx.JSON(w, http.StatusOK, view)
}

// WebLedger reads authorization, metadata, event history and tab bindings in one
// database snapshot. A cached snapshot cannot serve this endpoint: its arrays
// may be 24 hours old and would need the mobile tail applier to become current.
func (s *Service) WebLedger(ctx context.Context, accountID, installID, vaultID string) (*WebLedger, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM accounts WHERE id=$1::uuid AND pending_delete_at IS NULL AND disabled_at IS NULL)`, accountID).Scan(&active); err != nil {
		return nil, err
	}
	if !active {
		return nil, errLedgerAccountUnavailable
	}
	view := &WebLedger{VaultID: vaultID, People: []WebLedgerPerson{}, Entries: []WebLedgerEntry{}}
	var archivedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT name, currency, legacy_currency, default_entry_currency, archived_at
		FROM vaults WHERE vault_id=$1::uuid`, vaultID).
		Scan(&view.Name, &view.Currency, &view.LegacyCurrency, &view.DefaultEntryCurrency, &archivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrVaultNotFound
	}
	if err != nil {
		return nil, err
	}
	err = tx.QueryRow(ctx, `SELECT role FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid
		AND accepted_at IS NOT NULL AND revoked_at IS NULL`, vaultID, accountID).Scan(&view.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotMember
	}
	if err != nil {
		return nil, err
	}
	if archivedAt != nil {
		if view.Role != "owner" {
			return nil, ErrVaultArchived
		}
		ms := archivedAt.UnixMilli()
		view.ArchivedAtMS = &ms
	}
	if err := tx.QueryRow(ctx, `SELECT (SELECT encode(device_pubkey,'base64') FROM vault_devices WHERE vault_id=$1::uuid
		AND device_id=$2::uuid AND account_id=$3::uuid AND removed_at_ms IS NULL)`, vaultID, installID, accountID).Scan(&view.DevicePubkey); err != nil {
		return nil, err
	}
	view.DeviceRegistered = view.DevicePubkey != nil
	events, high, err := loadVaultEvents(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}
	projection, err := ApplyEvents(events)
	if err != nil {
		return nil, fmt.Errorf("project web ledger: %w", err)
	}
	view.ServerSeq = high
	linked := map[string]bool{}
	rows, err := tx.Query(ctx, `SELECT DISTINCT relationship_id::text FROM tab_parties
		WHERE vault_id=$1::uuid AND relationship_id IS NOT NULL`, vaultID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var relationshipID string
		if err := rows.Scan(&relationshipID); err != nil {
			rows.Close()
			return nil, err
		}
		linked[relationshipID] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := populateWebLedger(view, &projection, events, linked); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return view, nil
}

func populateWebLedger(view *WebLedger, p *Projection, events []LedgerEvent, linked map[string]bool) error {
	view.EnabledCurrencies = []string{view.DefaultEntryCurrency}
	if raw := p.VaultSettings["enabled_currencies"]; validateEnabledCurrencies(raw) == nil {
		_ = json.Unmarshal([]byte(raw), &view.EnabledCurrencies)
	}
	// The book default is always a usable choice, including older clients that
	// changed their default without updating the separate choices setting.
	hasDefault := false
	for _, code := range view.EnabledCurrencies {
		hasDefault = hasDefault || code == view.DefaultEntryCurrency
	}
	if !hasDefault {
		view.EnabledCurrencies = append([]string{view.DefaultEntryCurrency}, view.EnabledCurrencies...)
	}
	type boundary struct {
		at       int64
		currency string
	}
	settlements := map[string][]boundary{}
	for _, event := range events {
		if CompareHLC(event.HLC, view.HLCLast) > 0 {
			view.HLCLast = event.HLC
		}
		if event.EventType != EventEntrySettled || event.RelationshipID == nil {
			continue
		}
		var payload struct {
			SettledAtMS int64  `json:"settled_at_ms"`
			Currency    string `json:"currency"`
		}
		if json.Unmarshal(event.Payload, &payload) != nil || payload.SettledAtMS <= 0 {
			continue
		}
		if payload.Currency == "" {
			payload.Currency = view.LegacyCurrency
		}
		settlements[*event.RelationshipID] = append(settlements[*event.RelationshipID], boundary{payload.SettledAtMS, payload.Currency})
	}
	for _, rel := range p.Relationships {
		user := p.Users[rel.UserBID]
		if user == nil {
			continue
		}
		person := WebLedgerPerson{RelationshipID: rel.ID, UserID: user.ID, Name: user.DisplayName, CreatedAt: user.CreatedAt,
			PhoneE164: user.PhoneE164, DefaultEntryCurrency: rel.DefaultEntryCurrency, ArchivedAt: rel.ArchivedAt,
			Note:           rel.Note,
			SettledThrough: map[string]int64{}}
		for _, closed := range settlements[rel.ID] {
			if closed.at > person.SettledThrough[closed.currency] {
				person.SettledThrough[closed.currency] = closed.at
			}
		}
		if linked[rel.ID] {
			reason := "shared_tab"
			person.ReadOnly, person.ReadOnlyReason = true, &reason
			if rel.ArchivedAt == nil {
				view.IncompletePeople++
			}
		} else if rel.ArchivedAt != nil || view.ArchivedAtMS != nil {
			reason := "archived"
			person.ReadOnly, person.ReadOnlyReason = true, &reason
		}
		view.People = append(view.People, person)
	}
	for _, entry := range p.Entries {
		rel := p.Relationships[entry.RelationshipID]
		// A shared tab's opening, pending and closed history changes its balance.
		// Showing just local entries would report a plausible but false total.
		if rel == nil || linked[entry.RelationshipID] {
			continue
		}
		currency := entry.Currency
		if currency == "" {
			currency = view.LegacyCurrency
		}
		amount, err := canonicalWebMoney(entry.AmountAFN)
		if err != nil {
			return fmt.Errorf("entry %s: %w", entry.ID, err)
		}
		recordedAt := entry.RecordedAtMS
		if recordedAt == 0 {
			recordedAt = entry.CreatedAt // Older snapshots predate editable business dates.
		}
		row := WebLedgerEntry{ID: entry.ID, RelationshipID: entry.RelationshipID, Type: entry.Type,
			AmountAFN: amount, Currency: currency, Note: entry.Note,
			CreatedAt: entry.CreatedAt, RecordedAtMS: recordedAt, UpdatedAt: entry.UpdatedAt, CurrentEventID: entry.CurrentEventID,
			IsDeleted: entry.IsDeleted || entry.DeletedAt != nil, SettledAt: entry.SettledAt,
			ReadOnly: entry.IsSettled || entry.SettledAt != nil || rel.ArchivedAt != nil || view.ArchivedAtMS != nil}
		for _, closed := range settlements[entry.RelationshipID] {
			if closed.currency == currency && recordedAt <= closed.at {
				row.ReadOnly = true
				if row.SettledAt == nil || closed.at < *row.SettledAt {
					at := closed.at
					row.SettledAt = &at
				}
			}
		}
		view.Entries = append(view.Entries, row)
	}
	if err := setWebPersonActivity(view); err != nil {
		return err
	}
	sort.Slice(view.People, func(i, j int) bool { return view.People[i].RelationshipID < view.People[j].RelationshipID })
	sort.Slice(view.Entries, func(i, j int) bool {
		if view.Entries[i].CreatedAt != view.Entries[j].CreatedAt {
			return view.Entries[i].CreatedAt > view.Entries[j].CreatedAt
		}
		return view.Entries[i].ID < view.Entries[j].ID
	})
	return nil
}

// Mobile's unified customer list uses the latest non-deleted business date,
// falling back to the user's creation date when there are no tallies. An amount
// or note edit does not become recent activity; date amendments and deletions
// change the current maximum. Explicitly settled customers sort after open
// ones, and a merely-zero balance is not an explicit settlement.
func setWebPersonActivity(view *WebLedger) error {
	type currencyActivity struct {
		latest         int64
		recordedLatest int64
		balance        *big.Int
	}
	activity := map[string]map[string]*currencyActivity{}
	for _, entry := range view.Entries {
		if entry.IsDeleted {
			continue
		}
		currencies := activity[entry.RelationshipID]
		if currencies == nil {
			currencies = map[string]*currencyActivity{}
			activity[entry.RelationshipID] = currencies
		}
		current := currencies[entry.Currency]
		if current == nil {
			current = &currencyActivity{latest: entry.CreatedAt, balance: new(big.Int)}
			currencies[entry.Currency] = current
		}
		if entry.CreatedAt > current.latest {
			current.latest = entry.CreatedAt
		}
		recordedAt := entry.RecordedAtMS
		if recordedAt == 0 {
			recordedAt = entry.CreatedAt
		}
		if recordedAt > current.recordedLatest {
			current.recordedLatest = recordedAt
		}
		// Every row has already passed canonicalWebMoney: at most two decimal
		// places, no exponent, and no narrowing of large historical amounts.
		whole, fraction, _ := strings.Cut(entry.AmountAFN, ".")
		minor, ok := new(big.Int).SetString(whole+fraction+strings.Repeat("0", 2-len(fraction)), 10)
		if !ok {
			return errLedgerAmountUnsupported
		}
		if entry.Type == "debt" {
			current.balance.Add(current.balance, minor)
		} else if entry.Type == "payment" {
			current.balance.Sub(current.balance, minor)
		}
	}
	for i := range view.People {
		person := &view.People[i]
		// The first web release deliberately does not project shared statements.
		// Local-only dates or zeroes must not masquerade as complete shared data.
		if person.ReadOnlyReason != nil && *person.ReadOnlyReason == "shared_tab" {
			continue
		}
		currencies := activity[person.RelationshipID]
		settled := len(currencies) > 0
		for currency, current := range currencies {
			if person.LastEntryAt == nil || current.latest > *person.LastEntryAt {
				latest := current.latest
				person.LastEntryAt = &latest
			}
			boundary, explicit := person.SettledThrough[currency]
			if current.balance.Sign() != 0 || !explicit || boundary < current.recordedLatest {
				settled = false
			}
		}
		person.IsSettled = &settled
	}
	return nil
}
