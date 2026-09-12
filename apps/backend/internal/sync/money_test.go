package sync

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// Projection is a passive carrier of major-unit money. In particular, do not
// reinterpret old integers as cents or pass them through float64/int64*100.
func TestProjectionMoneyRoundTrip(t *testing.T) {
	for _, amount := range []string{"100", "0.01", "0.10", "12.34", "12.50", "9223372036854775807"} {
		t.Run(amount, func(t *testing.T) {
			event := moneyCreatedEvent("entry", amount, 1)
			before := string(event.Payload)
			projection, err := ApplyEvents([]LedgerEvent{event})
			if err != nil {
				t.Fatal(err)
			}
			entry := projection.Entries["entry"]
			if entry == nil || entry.AmountAFN.String() != amount {
				t.Fatalf("amount lost or changed: %+v, want %s", entry, amount)
			}
			if string(event.Payload) != before {
				t.Fatal("projection rewrote the original event payload")
			}
			raw, err := ProjectionToJSON(projection)
			if err != nil {
				t.Fatal(err)
			}
			var stored Projection
			if err := json.Unmarshal(raw, &stored); err != nil {
				t.Fatal(err)
			}
			if stored.Entries["entry"].AmountAFN.String() != amount {
				t.Fatalf("stored projection changed %s to %s", amount, stored.Entries["entry"].AmountAFN)
			}
			// The shape sent by LatestSnapshot must still contain an unquoted
			// JSON number, including old integer literals above float64 precision.
			snapshot, err := json.Marshal(projectEntries(stored.Entries))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(snapshot), `"amount_afn":`+amount+`,`) {
				t.Fatalf("snapshot changed amount representation: %s", snapshot)
			}
		})
	}
}

func TestProjectionDecimalMoneyLWW(t *testing.T) {
	create := moneyCreatedEvent("entry", "100", 1)
	amend := func(id, changes string, at int64) LedgerEvent {
		return LedgerEvent{EventID: id, EventType: EventEntryAmended, VaultID: "vault", TargetID: "entry",
			HLC: HLC{PMS: at, DID: "device"}, PayloadSchema: 1, Payload: json.RawMessage(`{"changes":` + changes + `}`)}
	}
	// Wire order differs from HLC order; a later note-only or null amendment
	// must preserve the decimal amount winner.
	events := []LedgerEvent{
		amend("note", `{"note":"new note"}`, 4),
		amend("decimal", `{"amount_afn":12.34}`, 3),
		create,
		amend("older", `{"amount_afn":99}`, 2),
		amend("null", `{"amount_afn":null}`, 5),
	}
	p, err := ApplyEvents(events)
	if err != nil {
		t.Fatal(err)
	}
	e := p.Entries["entry"]
	if e == nil || e.AmountAFN != "12.34" || e.Note == nil || *e.Note != "new note" {
		t.Fatalf("amount/note LWW diverged: %+v", e)
	}
	// Legacy integer amendments retain major-unit meaning; nothing multiplies
	// a historical 50 by 100 or reads it as 0.50.
	if err := ApplyEventsOnto(&p, []LedgerEvent{amend("integer", `{"amount_afn":50}`, 6)}); err != nil {
		t.Fatal(err)
	}
	if e.AmountAFN != "50" {
		t.Fatalf("integer amendment changed units: %s", e.AmountAFN)
	}
	deleted := LedgerEvent{EventID: "deleted", EventType: EventEntryDeleted, TargetID: "entry", HLC: HLC{PMS: 7}}
	if err := ApplyEventsOnto(&p, []LedgerEvent{deleted, amend("after-delete", `{"amount_afn":0.01}`, 8)}); err != nil {
		t.Fatal(err)
	}
	if e.AmountAFN != "50" || !e.IsDeleted {
		t.Fatalf("decimal amendment revived a tombstone: %+v", e)
	}
}

// Exercise PostgreSQL JSONB and the real snapshot response, rather than only
// the in-memory structs. The shared test harness uses a disposable database.
func TestSnapshotMoneySurvivesPostgres(t *testing.T) {
	f := newM1Fixture(t)
	ctx := t.Context()
	amounts := []string{"100", "12.34", "0.01", "9223372036854775807"}
	want := map[string]string{}
	for _, amount := range amounts {
		entryID := uuid.NewString()
		created := moneyCreatedEvent(entryID, amount, 1)
		ev := f.event(nil)
		ev.TargetID = &entryID
		ev.Payload = created.Payload
		requireAccepted(t, f.push(t, ev), 1)
		want[entryID] = amount
	}
	// Build from the raw event log, exactly as the snapshot cron does.
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw, upTo, err := buildSnapshotInTx(ctx, tx, f.vaultID, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO vault_snapshots (vault_id, up_to_server_seq, snapshot, schema_version, byte_size)
		VALUES ($1::uuid, $2, $3::jsonb, $4, $5)
	`, f.vaultID, upTo, string(raw), SnapshotSchemaVersion, len(raw)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.svc.LatestSnapshot(ctx, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Entries) != len(want) {
		t.Fatalf("snapshot dropped money entries: %d, want %d", len(snapshot.Entries), len(want))
	}
	for _, entry := range snapshot.Entries {
		if entry.AmountAFN.String() != want[entry.ID] {
			t.Errorf("snapshot amount = %s, want %s", entry.AmountAFN, want[entry.ID])
		}
	}
}

func moneyCreatedEvent(id, amount string, at int64) LedgerEvent {
	return LedgerEvent{EventID: "create-" + id, EventType: EventEntryCreated, VaultID: "vault", TargetID: id,
		HLC: HLC{PMS: at, DID: "device"}, PayloadSchema: 1,
		Payload: json.RawMessage(fmt.Sprintf(`{"entry_id":%q,"relationship_id":"relationship","type":"debt","amount_afn":%s,"note":null,"occurred_at_ms":1}`, id, amount))}
}
