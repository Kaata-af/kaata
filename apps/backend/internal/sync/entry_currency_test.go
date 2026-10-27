package sync

import (
	"encoding/json"
	"testing"
)

func TestEntryCurrencyIsImmutableAndLegacyNeverUsesNewDefault(t *testing.T) {
	p := NewProjection()
	old := LedgerEvent{EventID: "old", EventType: EventEntryCreated, VaultID: "vault", TargetID: "old", LegacyCurrency: "USD", HLC: HLC{PMS: 1000, DID: "device"}, Payload: json.RawMessage(`{"entry_id":"old","relationship_id":"person","type":"debt","amount_afn":100,"note":null,"occurred_at_ms":100}`)}
	if err := applyEntryCreated(&p, &old); err != nil {
		t.Fatal(err)
	}
	p.VaultSettings["default_entry_currency"] = "EUR"
	if p.Entries["old"].Currency != "USD" {
		t.Fatal("legacy changed with default")
	}
	current := old
	current.EventID = "new"
	current.TargetID = "new"
	current.Payload = json.RawMessage(`{"entry_id":"new","relationship_id":"person","currency":"EUR","type":"debt","amount_afn":20,"note":null,"occurred_at_ms":200}`)
	if err := applyEntryCreated(&p, &current); err != nil {
		t.Fatal(err)
	}
	if p.Entries["new"].Currency != "EUR" {
		t.Fatal("explicit denomination lost")
	}
	change := LedgerEvent{TargetID: "old", HLC: HLC{PMS: 2000, DID: "device"}, Payload: json.RawMessage(`{"changes":{"currency":"EUR","note":"illegal relabel"}}`)}
	if err := applyEntryAmended(&p, &change); err == nil {
		t.Fatal("currency amendment accepted")
	}
	if p.Entries["old"].Currency != "USD" || p.Entries["old"].Note != nil {
		t.Fatal("failed relabel partially changed row")
	}
	rows := projectEntries(p.Entries)
	found := map[string]string{}
	for _, row := range rows {
		found[row.ID] = row.Currency
	}
	if found["old"] != "USD" || found["new"] != "EUR" {
		t.Fatalf("snapshot lost denominations: %+v", found)
	}
}

func TestEnabledCurrenciesProjectionPreservesHistoricalMoney(t *testing.T) {
	p := NewProjection()
	p.Entries["existing-usd"] = &EntryProjection{ID: "existing-usd", Currency: "USD"}
	setting := LedgerEvent{EventType: EventVaultSettingSet, Payload: json.RawMessage(`{"key":"enabled_currencies","value":"[\"AFN\",\"EUR\"]"}`)}
	if err := applyVaultSettingSet(&p, &setting); err != nil {
		t.Fatal(err)
	}
	if p.VaultSettings["enabled_currencies"] != `["AFN","EUR"]` || p.Entries["existing-usd"].Currency != "USD" {
		t.Fatal("chooser setting changed historical tally denomination")
	}
	setting.Payload = json.RawMessage(`{"key":"enabled_currencies","value":"[]"}`)
	if err := applyVaultSettingSet(&p, &setting); err == nil || p.VaultSettings["enabled_currencies"] != `["AFN","EUR"]` {
		t.Fatal("invalid setting partially replaced synced list")
	}
}
