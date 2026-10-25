package sync

import (
	"encoding/json"
	"testing"
)

func TestEntryDateOnlyAmendAndSnapshotMetadata(t *testing.T) {
	p := NewProjection()
	create := LedgerEvent{EventID: "created", EventType: EventEntryCreated, VaultID: "vault", TargetID: "entry",
		HLC:     HLC{PMS: 1000, L: 2, DID: "device"},
		Payload: json.RawMessage(`{"entry_id":"entry","relationship_id":"person","type":"debt","amount_afn":45,"note":null,"occurred_at_ms":100,"recorded_at_ms":500}`)}
	if err := applyEntryCreated(&p, &create); err != nil {
		t.Fatal(err)
	}
	entry := p.Entries["entry"]
	if entry.CreatedAt != 100 || entry.UpdatedAt != 1000 || entry.RecordedAtMS != 500 {
		t.Fatalf("business/recording dates: %+v", entry)
	}
	edit := LedgerEvent{EventID: "date-only", TargetID: "entry", HLC: HLC{PMS: 2000, L: 1, DID: "device"},
		Payload: json.RawMessage(`{"changes":{"occurred_at_ms":200}}`)}
	if err := applyEntryAmended(&p, &edit); err != nil {
		t.Fatal(err)
	}
	if entry.CreatedAt != 200 || entry.UpdatedAt != 2000 || entry.CurrentEventID != edit.EventID || entry.RecordedAtMS != 500 {
		t.Fatalf("date-only amendment: %+v", entry)
	}
	// Snapshot rows omit the earlier event log. The exact date register and
	// immutable authoring time must survive stored-projection serialization.
	raw, err := ProjectionToJSON(p)
	if err != nil {
		t.Fatal(err)
	}
	var restored Projection
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	seed := projectEntries(restored.Entries)[0]
	if seed.RecordedAtMS != 500 || seed.OccurredAtHLC == nil || CompareHLC(*seed.OccurredAtHLC, edit.HLC) != 0 {
		t.Fatalf("snapshot date metadata: %+v", seed)
	}
	if max := snapshotMaxHLC(&restored, nil); CompareHLC(max, edit.HLC) != 0 {
		t.Fatalf("snapshot clock = %+v, want %+v", max, edit.HLC)
	}
	// A future business date must not move the causal clock into the future.
	create.Payload = json.RawMessage(`{"entry_id":"future","relationship_id":"person","type":"debt","amount_afn":1,"note":null,"occurred_at_ms":8000000,"recorded_at_ms":500}`)
	if err := applyEntryCreated(&p, &create); err != nil {
		t.Fatal(err)
	}
	if max := snapshotMaxHLC(&p, nil); CompareHLC(max, edit.HLC) != 0 {
		t.Fatalf("future business date contaminated snapshot HLC: %+v", max)
	}
	create.HLC.PMS = 60_000
	create.Payload = json.RawMessage(`{"entry_id":"legacy-skew","relationship_id":"person","type":"debt","amount_afn":1,"note":null,"occurred_at_ms":500}`)
	if err := applyEntryCreated(&p, &create); err != nil {
		t.Fatal(err)
	}
	if recorded := p.Entries["legacy-skew"].RecordedAtMS; recorded != 500 {
		t.Fatalf("legacy wall-time cutoff followed advanced HLC: %d", recorded)
	}
	for _, payload := range []string{`{"changes":{"occurred_at_ms":0}}`, `{"changes":{"occurred_at_ms":-1}}`, `{"changes":{"occurred_at_ms":1.5}}`, `{"changes":{"occurred_at_ms":"200"}}`, `{"changes":{"occurred_at_ms":8640000000000001}}`} {
		edit.Payload = json.RawMessage(payload)
		if err := applyEntryAmended(&p, &edit); err == nil {
			t.Fatalf("invalid date accepted: %s", payload)
		}
	}
}
