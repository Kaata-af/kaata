package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/httpx"
)

var currencyCodePattern = regexp.MustCompile(`^[A-Z]{3}$`)

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
		var changes map[string]json.RawMessage
		if _, present := payload["changes"]; !present {
			return nil
		}
		if err := json.Unmarshal(payload["changes"], &changes); err != nil {
			return err
		}
		if _, changed := changes["currency"]; changed {
			return errors.New("entry currency is immutable")
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
	httpx.JSON(w, http.StatusOK, map[string]bool{"multi_currency": true, "person_default_currency": true})
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
	err := h.svc.pool.QueryRow(r.Context(), `
		SELECT v.legacy_currency,v.currency <> v.legacy_currency OR EXISTS(SELECT 1 FROM events e WHERE e.vault_id=v.vault_id
		  AND e.event_type IN ('entry_created','entry_settled') AND COALESCE(e.payload->>'currency',v.legacy_currency) <> v.legacy_currency)
		 OR EXISTS(SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
		  WHERE p.vault_id=v.vault_id AND t.currency <> v.legacy_currency)
		 OR EXISTS(SELECT 1 FROM customer_credit_limits p
		  WHERE p.vault_id=v.vault_id AND p.currency <> v.legacy_currency)
		FROM vaults v WHERE v.vault_id=$1::uuid AND EXISTS(
		  SELECT 1 FROM vault_members m JOIN accounts a ON a.id=m.account_id
		  WHERE m.vault_id=v.vault_id AND m.account_id=$2::uuid
		  AND m.revoked_at IS NULL AND m.accepted_at IS NOT NULL AND a.pending_delete_at IS NULL)
	`, vaultID, accountID).Scan(&legacy, &mixed)
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
	if r.Header.Get("X-Kaata-Currencies") == "1" {
		return true
	}
	if mixed {
		httpx.Error(w, http.StatusUpgradeRequired, "Update Kaata to open this book's separate currency balances")
		return false
	}
	return true
}
