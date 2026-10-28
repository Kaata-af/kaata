package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/httpx"
)

var currencyCodePattern = regexp.MustCompile(`^[A-Z]{3}$`)

const maxJavaScriptSafeInteger int64 = 9007199254740991

// Baselines are optional metadata, so historical values that cannot survive
// the client's numeric representation must be omitted, never rounded/repaired.
func baselineMoneyRepresentable(amount json.Number) bool {
	minor, err := credit.Minor(amount.String())
	if err != nil || minor < 0 || minor > maxJavaScriptSafeInteger {
		return false
	}
	value, err := strconv.ParseFloat(amount.String(), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return false
	}
	roundTripMinor, err := credit.Minor(strconv.FormatFloat(value, 'f', -1, 64))
	return err == nil && roundTripMinor == minor
}

// Opt-in recovery metadata for devices restored before snapshots carried an
// exact amount clock. Independent fields and pending outbox writes are absent.
type EntryCurrencyBaseline struct {
	ID               string      `json:"id"`
	AmountAFN        json.Number `json:"amount_afn"`
	Currency         string      `json:"currency"`
	OriginalCurrency string      `json:"original_currency,omitempty"`
	AmountHLC        HLC         `json:"amount_hlc"`
	AmountEventID    string      `json:"amount_event_id,omitempty"`
}

func (s *Service) entryCurrencyBaselines(ctx context.Context, vaultID string) ([]EntryCurrencyBaseline, error) {
	projection, err := LoadVaultProjection(ctx, s.pool, vaultID)
	if err != nil {
		return nil, err
	}
	rows := make([]EntryCurrencyBaseline, 0, len(projection.Entries))
	for _, entry := range projection.Entries {
		if entry.IsDeleted || entry.DeletedAt != nil || entry.AmountHLC == nil {
			continue
		}
		if !credit.ValidCurrency(entry.Currency) || (entry.OriginalCurrency != "" && !credit.ValidCurrency(entry.OriginalCurrency)) || !baselineMoneyRepresentable(entry.AmountAFN) {
			continue
		}
		clock := entry.AmountHLC
		if entry.ID == "" || clock.PMS <= 0 || clock.PMS > maxJavaScriptSafeInteger || clock.L < 0 || clock.L > maxJavaScriptSafeInteger || clock.DID == "" {
			continue
		}
		rows = append(rows, EntryCurrencyBaseline{
			ID: entry.ID, AmountAFN: entry.AmountAFN, Currency: entry.Currency,
			OriginalCurrency: entry.OriginalCurrency, AmountHLC: *entry.AmountHLC,
			AmountEventID: entry.amountEventID,
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	return rows, nil
}

func validateEnabledCurrencies(value string) error {
	var codes []string
	if err := json.Unmarshal([]byte(value), &codes); err != nil || len(codes) == 0 || len(codes) > 64 {
		return errors.New("invalid enabled currencies")
	}
	seen := make(map[string]bool, len(codes))
	for _, code := range codes {
		if !currencyCodePattern.MatchString(code) || seen[code] {
			return errors.New("invalid enabled currencies")
		}
		seen[code] = true
	}
	return nil
}

func validateCurrencyPayload(event PushEvent) error {
	if event.EventType == EventPersonDefaultCurrencySet {
		return validatePersonDefaultCurrencyPushEvent(event)
	}
	if event.EventType == EventVaultSettingSet {
		var setting vaultSettingSetPayload
		if err := json.Unmarshal(event.Payload, &setting); err != nil {
			return err
		}
		if setting.Key == "enabled_currencies" {
			return validateEnabledCurrencies(setting.Value)
		}
		return nil
	}
	if event.EventType != EventEntryCreated && event.EventType != EventEntryAmended && event.EventType != EventEntrySettled {
		return nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return err
	}
	if event.EventType == EventEntryAmended {
		if _, present := payload["changes"]; !present {
			return nil
		}
		var changes map[string]json.RawMessage
		if err := json.Unmarshal(payload["changes"], &changes); err != nil {
			return err
		}
		if _, present := changes["currency"]; !present {
			return nil // Preserve the validation contract of legacy amendments.
		}
		var typed entryAmendedChanges
		if err := json.Unmarshal(payload["changes"], &typed); err != nil {
			return err
		}
		currency, err := amendedCurrency(typed)
		if err != nil || currency == "" {
			return err
		}
		// json.Number also accepts a quoted JSON string; mobile requires an
		// actual number for this new amount+currency register.
		amount := bytes.TrimSpace(changes["amount_afn"])
		if len(amount) == 0 || amount[0] == '"' {
			return errors.New("currency edits require a numeric amount")
		}
		return nil
	}
	if value, present := payload["currency"]; present {
		var code string
		if json.Unmarshal(value, &code) != nil || !currencyCodePattern.MatchString(code) {
			return fmt.Errorf("invalid entry currency")
		}
	}
	return nil
}

func (h *Handler) CurrencyCapabilities(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]bool{"multi_currency": true, "person_default_currency": true, "entry_currency_edit": true, "notification_only_tallies": true, "one_way_tallies": true, "notification_preferences": true, "multi_currency_tabs": true})
}

func isEntryCurrencyEdit(eventType string, raw json.RawMessage) bool {
	if eventType != EventEntryAmended {
		return false
	}
	var payload struct {
		Changes map[string]json.RawMessage `json:"changes"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return false
	}
	_, present := payload.Changes["currency"]
	return present
}

func requireEntryCurrencyEditClient(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("X-Kaata-Entry-Currency-Edit") == "1" {
		return true
	}
	httpx.Error(w, http.StatusUpgradeRequired, "Update Kaata to sync this book's corrected tally currencies. Your records remain on this phone.")
	return false
}

// Check the fetched payload as well as the initial database guard. A first
// correction can commit between that guard and the subsequent data read.
func allowEntryCurrencyEvents(w http.ResponseWriter, r *http.Request, events []PulledEvent) bool {
	if r.Header.Get("X-Kaata-Entry-Currency-Edit") == "1" {
		return true
	}
	for _, event := range events {
		if isEntryCurrencyEdit(event.EventType, event.Payload) {
			return requireEntryCurrencyEditClient(w, r)
		}
	}
	return true
}

func allowEntryCurrencySnapshot(w http.ResponseWriter, r *http.Request, snapshot *SnapshotResponse) bool {
	if r.Header.Get("X-Kaata-Entry-Currency-Edit") == "1" {
		return true
	}
	for _, entry := range snapshot.Entries {
		if entry.OriginalCurrency != "" {
			return requireEntryCurrencyEditClient(w, r)
		}
	}
	return allowEntryCurrencyEvents(w, r, snapshot.Events)
}

// A unit change is one signed amount+currency value, never a bare relabel.
func amendedCurrency(changes entryAmendedChanges) (string, error) {
	if len(changes.Currency) == 0 {
		return "", nil
	}
	var code string
	if json.Unmarshal(changes.Currency, &code) != nil || !currencyCodePattern.MatchString(code) || changes.AmountAFN == nil {
		return "", errors.New("currency edits require a valid currency and amount together")
	}
	minor, err := credit.Minor(changes.AmountAFN.String())
	if err != nil || minor <= 0 || minor > 999999999999 {
		return "", errors.New("invalid currency edit amount")
	}
	return code, nil
}

// Old clients add every amount into one balance. Once a book contains another
// currency, they must upgrade before downloading or replacing its projection.
// Membership remains the ordinary service's responsibility; this query reveals
// no book state to a caller who is not an active member.
func (h *Handler) allowCurrencyClient(w http.ResponseWriter, r *http.Request, vaultID, accountID string) bool {
	if h.svc == nil || h.svc.pool == nil {
		return true
	}
	var legacy string
	var mixed bool
	var corrected bool
	err := h.svc.pool.QueryRow(r.Context(), `
		SELECT v.legacy_currency,v.currency <> v.legacy_currency OR EXISTS(SELECT 1 FROM events e WHERE e.vault_id=v.vault_id
		  AND e.event_type IN ('entry_created','entry_settled') AND COALESCE(e.payload->>'currency',v.legacy_currency) <> v.legacy_currency)
		 OR EXISTS(SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
		  WHERE p.vault_id=v.vault_id AND t.currency <> v.legacy_currency)
		 OR EXISTS(SELECT 1 FROM customer_credit_limits p
		  WHERE p.vault_id=v.vault_id AND p.currency <> v.legacy_currency),
		 EXISTS(SELECT 1 FROM events e WHERE e.vault_id=v.vault_id AND e.event_type='entry_amended'
		   AND e.payload->'changes' ? 'currency')
		FROM vaults v WHERE v.vault_id=$1::uuid AND EXISTS(
		  SELECT 1 FROM vault_members m JOIN accounts a ON a.id=m.account_id
		  WHERE m.vault_id=v.vault_id AND m.account_id=$2::uuid
		  AND m.revoked_at IS NULL AND m.accepted_at IS NOT NULL AND a.pending_delete_at IS NULL)
	`, vaultID, accountID).Scan(&legacy, &mixed, &corrected)
	if errors.Is(err, pgx.ErrNoRows) {
		// Leave missing/inactive membership to the normal service authority.
		// Never reveal this vault's currency or migration state to outsiders.
		return true
	}
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Could not verify this book's currency support")
		return false
	}
	if local := r.Header.Get("X-Kaata-Legacy-Currency"); local != "" && local != legacy {
		httpx.ErrorCode(w, http.StatusConflict, "legacy_currency_mismatch",
			"This phone and the server disagree about this book's original currency. Keep this phone's records and contact Kaata support before syncing again.")
		return false
	}
	if corrected && r.Header.Get("X-Kaata-Entry-Currency-Edit") != "1" {
		return requireEntryCurrencyEditClient(w, r)
	}
	if !h.allowSharedGroupClient(w, r, vaultID) {
		return false
	}
	if r.Header.Get("X-Kaata-Currencies") == "1" {
		return true
	}
	if mixed {
		httpx.Error(w, http.StatusUpgradeRequired, "Update Kaata to open this book's separate currency balances")
		return false
	}
	return true
}
