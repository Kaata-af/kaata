package sync

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func currencyAmendment(changes string, hlc HLC) LedgerEvent {
	return LedgerEvent{EventID: "amend-" + jsonNumber(hlc.PMS), EventType: EventEntryAmended, VaultID: "vault", TargetID: "entry", HLC: hlc, Payload: json.RawMessage(`{"changes":` + changes + `}`)}
}

// A queued old amount edit is still denominated in the creation currency,
// even when a currency correction arrived first or loses the amount register.
func TestEntryCurrencyEditAmountRegisterConverges(t *testing.T) {
	create := moneyCreatedEvent("entry", "100", 1000)
	create.LegacyCurrency = "AFN"
	correction := currencyAmendment(`{"amount_afn":12.34,"currency":"USD"}`, HLC{PMS: 2000, DID: "device"})
	queued := currencyAmendment(`{"amount_afn":150}`, HLC{PMS: 3000, DID: "device"})
	note := currencyAmendment(`{"note":"independent note"}`, HLC{PMS: 5000, DID: "device"})
	date := currencyAmendment(`{"occurred_at_ms":500}`, HLC{PMS: 4000, DID: "device"})
	orders := [][]LedgerEvent{
		{correction, queued, note, date},
		{queued, note, date, correction},
		{date, correction, note, queued},
		{note, queued, correction, date},
	}
	var want []byte
	for i, edits := range orders {
		p := NewProjection()
		if err := applyEntryCreated(&p, &create); err != nil {
			t.Fatal(err)
		}
		for _, edit := range edits {
			if err := applyEntryAmended(&p, &edit); err != nil {
				t.Fatal(err)
			}
		}
		entry := p.Entries["entry"]
		if entry.AmountAFN != "150" || entry.Currency != "AFN" || entry.OriginalCurrency != "AFN" || entry.AmountHLC == nil || CompareHLC(*entry.AmountHLC, queued.HLC) != 0 || entry.Note == nil || *entry.Note != "independent note" || entry.CreatedAt != 500 || entry.UpdatedAt != 5000 || entry.CurrentEventID != note.EventID {
			t.Fatalf("delivery order %d changed money or independent fields: %+v", i, entry)
		}
		raw, err := ProjectionToJSON(p)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			want = raw
		} else if string(raw) != string(want) {
			t.Fatalf("delivery order %d diverged\n%s\n%s", i, raw, want)
		}
		// Currency-aware amount edits after the correction retain their stated unit.
		next := currencyAmendment(`{"amount_afn":20,"currency":"USD"}`, HLC{PMS: 3500, DID: "device"})
		if err := applyEntryAmended(&p, &next); err != nil {
			t.Fatal(err)
		}
		if entry.AmountAFN != "20" || entry.Currency != "USD" || entry.OriginalCurrency != "AFN" || entry.CurrentEventID != note.EventID {
			t.Fatalf("explicit unit lost: %+v", entry)
		}
	}
}

func TestEntryCurrencyEditSnapshotKeepsExactMoneyClock(t *testing.T) {
	create := moneyCreatedEvent("entry", "100", 1000)
	create.LegacyCurrency = "AFN"
	note := currencyAmendment(`{"note":"later note"}`, HLC{PMS: 5000, L: 3, DID: "device"})
	p, err := ApplyEvents([]LedgerEvent{create, note})
	if err != nil {
		t.Fatal(err)
	}
	// Even a book with no prior currency correction needs its actual money
	// clock: a first correction can predate a newer, independent note.
	raw, err := ProjectionToJSON(p)
	if err != nil {
		t.Fatal(err)
	}
	var stored Projection
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	seed := projectEntries(stored.Entries)[0]
	if seed.AmountHLC == nil || CompareHLC(*seed.AmountHLC, create.HLC) != 0 || seed.OriginalCurrency != "" {
		t.Fatalf("pre-correction money clock: %+v", seed)
	}
	correction := currencyAmendment(`{"amount_afn":9.99,"currency":"USD"}`, HLC{PMS: 2000, L: 2, DID: "device-b"})
	if err := applyEntryAmended(&p, &correction); err != nil {
		t.Fatal(err)
	}
	raw, err = ProjectionToJSON(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	seed = projectEntries(stored.Entries)[0]
	if seed.Currency != "USD" || seed.OriginalCurrency != "AFN" || seed.AmountHLC == nil || CompareHLC(*seed.AmountHLC, correction.HLC) != 0 || seed.Note == nil || *seed.Note != "later note" {
		t.Fatalf("corrected snapshot lost register: %+v", seed)
	}
	// Include logical/device ordering even when the winning amount clock is
	// above a serialized entry's row timestamp.
	stored.Entries["entry"].UpdatedAt = 1500
	stored.Entries["entry"].OccurredAtHLC = nil
	if max := snapshotMaxHLC(&stored, nil); CompareHLC(max, correction.HLC) != 0 {
		t.Fatalf("money clock omitted from frontier: %+v", max)
	}
}

func TestEntryCurrencyEditConcurrentUnitsNeverSplitAmount(t *testing.T) {
	create := moneyCreatedEvent("entry", "100", 1000)
	create.LegacyCurrency = "AFN"
	usd := currencyAmendment(`{"amount_afn":12.34,"currency":"USD"}`, HLC{PMS: 2000, L: 1, DID: "device-a"})
	eur := currencyAmendment(`{"amount_afn":56.78,"currency":"EUR"}`, HLC{PMS: 2000, L: 1, DID: "device-b"})
	for _, edits := range [][]LedgerEvent{{usd, eur}, {eur, usd}} {
		p := NewProjection()
		if err := applyEntryCreated(&p, &create); err != nil {
			t.Fatal(err)
		}
		for _, edit := range edits {
			if err := applyEntryAmended(&p, &edit); err != nil {
				t.Fatal(err)
			}
		}
		entry := p.Entries["entry"]
		if entry.AmountAFN != "56.78" || entry.Currency != "EUR" || entry.OriginalCurrency != "AFN" || entry.AmountHLC == nil || CompareHLC(*entry.AmountHLC, eur.HLC) != 0 {
			t.Fatalf("concurrent monetary value split: %+v", entry)
		}
	}
}

func TestSnapshotCurrencyEditSurvivesPostgres(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	base := time.Now().UnixMilli() + 100
	create := creditEntry(f, rel, "debt", "100")
	create.HLC.PhysicalMS = base
	edit := creditMutation(f, create, EventEntryAmended, `{"changes":{"currency":"USD","amount_afn":12.34}}`, base+1)
	note := creditMutation(f, create, EventEntryAmended, `{"changes":{"note":"later independent note"}}`, base+2)
	requireAccepted(t, f.push(t, create, edit, note), 3)
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	raw, upTo, err := buildSnapshotInTx(t.Context(), tx, f.vaultID, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO vault_snapshots(vault_id,up_to_server_seq,snapshot,schema_version,byte_size) VALUES($1::uuid,$2,$3::jsonb,$4,$5)`, f.vaultID, upTo, string(raw), SnapshotSchemaVersion, len(raw)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.svc.LatestSnapshot(t.Context(), f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Entries) != 1 {
		t.Fatalf("snapshot entries: %+v", snapshot.Entries)
	}
	entry := snapshot.Entries[0]
	wantHLC := HLC{PMS: edit.HLC.PhysicalMS, L: edit.HLC.Logical, DID: edit.HLC.DeviceID}
	if entry.AmountAFN != "12.34" || entry.Currency != "USD" || entry.OriginalCurrency != "AFN" || entry.AmountHLC == nil || CompareHLC(*entry.AmountHLC, wantHLC) != 0 || entry.Note == nil || *entry.Note != "later independent note" {
		t.Fatalf("database snapshot changed monetary register: %+v", entry)
	}
	for _, event := range []PushEvent{create, edit, note} {
		var intact bool
		if err := f.pool.QueryRow(t.Context(), `SELECT payload=$2::jsonb FROM events WHERE event_id=$1::uuid`, event.EventID, string(event.Payload)).Scan(&intact); err != nil {
			t.Fatal(err)
		}
		if !intact {
			t.Fatalf("snapshot rewrote historical event %s", event.EventID)
		}
	}
}

func TestLegacySnapshotRecoversMoneyClockAtSavedCursor(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	base := time.Now().UnixMilli() + 100
	create := creditEntry(f, rel, "debt", "100")
	create.HLC.PhysicalMS = base
	note := creditMutation(f, create, EventEntryAmended, `{"changes":{"note":"newer note"}}`, base+20)
	requireAccepted(t, f.push(t, create, note), 2)
	storedPayload := saveCurrencyEditSnapshot(t, f, true)
	// The currency edit is newly delivered after the snapshot cursor, while
	// its amount clock precedes that snapshot's independent note clock.
	edit := creditMutation(f, create, EventEntryAmended, `{"changes":{"currency":"USD","amount_afn":12.34}}`, base+10)
	requireAccepted(t, f.push(t, edit), 1)
	snapshot, err := f.svc.LatestSnapshot(t.Context(), f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Entries) != 1 {
		t.Fatalf("snapshot entries: %+v", snapshot.Entries)
	}
	entry := snapshot.Entries[0]
	want := HLC{PMS: base, DID: f.deviceID}
	if entry.AmountAFN != "100" || entry.Currency != "AFN" || entry.OriginalCurrency != "" || entry.AmountHLC == nil || CompareHLC(*entry.AmountHLC, want) != 0 {
		t.Fatalf("old snapshot metadata used its note or future tail: %+v", entry)
	}
	if len(snapshot.Events) != 1 || snapshot.Events[0].EventID != edit.EventID {
		t.Fatalf("correction lost from tail: %+v", snapshot.Events)
	}
	var intact bool
	if err := f.pool.QueryRow(t.Context(), `SELECT snapshot=$2::jsonb FROM vault_snapshots WHERE vault_id=$1::uuid`, f.vaultID, string(storedPayload)).Scan(&intact); err != nil {
		t.Fatal(err)
	}
	if !intact {
		t.Fatal("read-time recovery rewrote the old stored snapshot")
	}
}

func saveCurrencyEditSnapshot(t *testing.T, f *m1Fixture, legacy bool) []byte {
	t.Helper()
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	raw, upTo, err := buildSnapshotInTx(t.Context(), tx, f.vaultID, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if legacy {
		var projection Projection
		if err := json.Unmarshal(raw, &projection); err != nil {
			t.Fatal(err)
		}
		for _, entry := range projection.Entries {
			entry.AmountHLC = nil
			entry.OriginalCurrency = ""
		}
		raw, err = ProjectionToJSON(projection)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO vault_snapshots(vault_id,up_to_server_seq,snapshot,schema_version,byte_size) VALUES($1::uuid,$2,$3::jsonb,$4,$5)`, f.vaultID, upTo, string(raw), SnapshotSchemaVersion, len(raw)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestEntryCurrencyEditRejectsRelabelAndInvalidMoneyAtomically(t *testing.T) {
	for _, changes := range []string{
		`{"currency":"USD"}`, `{"currency":"USD","amount_afn":null}`, `{"currency":null,"amount_afn":12}`,
		`{"currency":"usd","amount_afn":12}`, `{"currency":"USD","amount_afn":0}`, `{"currency":"USD","amount_afn":-1}`,
		`{"currency":"USD","amount_afn":0.001}`, `{"currency":"USD","amount_afn":10000000000}`, `{"currency":"USD","amount_afn":"12.34"}`,
	} {
		p := NewProjection()
		create := moneyCreatedEvent("entry", "100", 1000)
		create.LegacyCurrency = "AFN"
		if err := applyEntryCreated(&p, &create); err != nil {
			t.Fatal(err)
		}
		before := *p.Entries["entry"]
		amend := currencyAmendment(changes, HLC{PMS: 2000, DID: "device"})
		if err := applyEntryAmended(&p, &amend); err == nil {
			t.Fatalf("accepted %s", changes)
		}
		if !reflect.DeepEqual(before, *p.Entries["entry"]) {
			t.Fatalf("invalid amendment partially changed money: %s", changes)
		}
		if err := validateCurrencyPayload(PushEvent{EventType: EventEntryAmended, Payload: amend.Payload}); err == nil {
			t.Fatalf("push accepted %s", changes)
		}
	}
	for _, amount := range []string{"0.01", "12.34", "9999999999.99", "1e3"} {
		amend := currencyAmendment(`{"currency":"USD","amount_afn":`+amount+`}`, HLC{PMS: 2000, DID: "device"})
		if err := validateCurrencyPayload(PushEvent{EventType: EventEntryAmended, Payload: amend.Payload}); err != nil {
			t.Fatalf("valid exact amount %s: %v", amount, err)
		}
	}
}

func TestCreditCurrencyEditChecksBothUnits(t *testing.T) {
	for _, scenario := range []string{"target debt", "source payment", "queued legacy amount"} {
		t.Run(scenario, func(t *testing.T) {
			f := newM1Fixture(t)
			rel := seedCreditContact(t, f)
			base := time.Now().UnixMilli() + 100
			debt := creditEntry(f, rel, "debt", "120")
			payment := creditEntry(f, rel, "payment", "40")
			debt.HLC.PhysicalMS, payment.HLC.PhysicalMS = base, base+1
			requireAccepted(t, f.push(t, debt, payment), 2)
			var amendment PushEvent
			switch scenario {
			case "target debt":
				if _, err := f.pool.Exec(t.Context(), `INSERT INTO customer_credit_limits(vault_id,relationship_id,currency,max_collect_minor,mode,restrict_editors,updated_at_ms) VALUES($1::uuid,$2::uuid,'USD',10000,'clerk_block',true,1)`, f.vaultID, rel); err != nil {
					t.Fatal(err)
				}
				amendment = creditMutation(f, debt, EventEntryAmended, `{"changes":{"amount_afn":120,"currency":"USD"}}`, base+2)
			case "source payment":
				seedCreditPolicy(t, f, rel, "clerk_block", 10000)
				amendment = creditMutation(f, payment, EventEntryAmended, `{"changes":{"amount_afn":40,"currency":"USD"}}`, base+2)
			case "queued legacy amount":
				requireAccepted(t, f.push(t, creditMutation(f, debt, EventEntryAmended, `{"changes":{"amount_afn":20,"currency":"USD"}}`, base+2)), 1)
				seedCreditPolicy(t, f, rel, "clerk_block", 10000)
				amendment = creditMutation(f, debt, EventEntryAmended, `{"changes":{"amount_afn":150}}`, base+3)
			}
			if _, err := f.pool.Exec(t.Context(), `UPDATE customer_credit_limits SET restrict_editors=true WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
				t.Fatal(err)
			}
			if got := f.push(t, amendment); len(got.Rejected) != 1 || got.Rejected[0].Reason != "credit_limit_exceeded" {
				t.Fatalf("%s escaped unit policy: %+v", scenario, got)
			}
			// A different, fresh event with a permitted paired amount remains valid.
			allowed := creditMutation(f, debt, EventEntryAmended, `{"changes":{"amount_afn":60,"currency":"USD"}}`, base+4)
			requireAccepted(t, f.push(t, allowed), 1)
		})
	}
}

func TestCreditCurrencyEditRollingProjectionPreservesLegacyUnit(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	state := &creditProjection{}
	p, err := state.load(t.Context(), tx, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UnixMilli() + 100
	create := creditEntry(f, rel, "debt", "100")
	create.HLC.PhysicalMS = base
	state.accepted(f.vaultID, create)
	correction := creditMutation(f, create, EventEntryAmended, `{"changes":{"amount_afn":12,"currency":"USD"}}`, base+1)
	state.accepted(f.vaultID, correction)
	queued := creditMutation(f, create, EventEntryAmended, `{"changes":{"amount_afn":150}}`, base+2)
	candidate, err := state.proposed(t.Context(), tx, f.vaultID, queued)
	if err != nil {
		t.Fatal(err)
	}
	entry := candidate.Entries[*create.TargetID]
	if entry.Currency != "AFN" || entry.OriginalCurrency != "AFN" || entry.AmountAFN != "150" {
		t.Fatalf("cached legacy unit changed: %+v", entry)
	}
	if p.Entries[*create.TargetID].Currency != "USD" || p.Entries[*create.TargetID].AmountAFN != "12" {
		t.Fatal("candidate mutated committed projection")
	}
}
