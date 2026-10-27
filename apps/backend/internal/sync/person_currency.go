package sync

import (
	"encoding/json"
	"errors"
)

func decodePersonDefaultCurrency(payload json.RawMessage) (*string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return nil, err
	}
	raw, present := fields["currency"]
	if !present {
		return nil, errors.New("contact currency missing")
	}
	var currency *string
	if err := json.Unmarshal(raw, &currency); err != nil {
		return nil, err
	}
	if currency != nil && !currencyCodePattern.MatchString(*currency) {
		return nil, errors.New("invalid contact default currency")
	}
	return currency, nil
}

func validatePersonDefaultCurrencyPayload(payload json.RawMessage) error {
	_, err := decodePersonDefaultCurrency(payload)
	return err
}

func validatePersonDefaultCurrencyPushEvent(event PushEvent) error {
	if event.TargetID == nil || *event.TargetID == "" || event.RelationshipID == nil || *event.TargetID != *event.RelationshipID {
		return errors.New("contact currency target mismatch")
	}
	return validatePersonDefaultCurrencyPayload(event.Payload)
}

func applyPersonDefaultCurrencySet(p *Projection, event *LedgerEvent) error {
	if event.VaultID == "" || event.RelationshipID == nil || *event.RelationshipID != event.TargetID {
		return errors.New("contact currency target mismatch")
	}
	currency, err := decodePersonDefaultCurrency(event.Payload)
	if err != nil {
		return err
	}
	rel := p.Relationships[event.TargetID]
	if rel == nil || rel.VaultID != event.VaultID {
		return errors.New("contact currency relationship missing in vault")
	}
	if rel.CurrencyFieldHLC != nil && CompareHLC(event.HLC, *rel.CurrencyFieldHLC) <= 0 {
		return nil
	}
	// Null retains a winning HLC so older offline choices cannot resurrect it.
	rel.DefaultEntryCurrency = currency
	hlc := event.HLC
	rel.CurrencyFieldHLC = &hlc
	return nil
}
