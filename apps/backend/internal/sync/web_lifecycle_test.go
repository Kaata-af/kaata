package sync

import (
	"encoding/json"
	"testing"
	"time"
)

func TestObservedPrivateSettlementRejectsConcurrentTallyAndKeepsBackdatedNewChapter(t *testing.T) {
	f := newM1Fixture(t)
	relationship := seedCreditContact(t, f)
	base := time.Now().Add(-time.Minute).UnixMilli()
	entry := func(kind string, recorded, business int64) PushEvent {
		t.Helper()
		ev := creditEntry(f, relationship, kind, "12.34")
		var payload map[string]any
		if err := json.Unmarshal(ev.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		payload["recorded_at_ms"], payload["occurred_at_ms"] = recorded, business
		ev.Payload, _ = json.Marshal(payload)
		return ev
	}
	read := func() *WebLedger {
		t.Helper()
		ledger, err := f.svc.WebLedger(t.Context(), f.accountID, f.deviceID, f.vaultID)
		if err != nil {
			t.Fatal(err)
		}
		return ledger
	}
	settle := func(expected, boundary int64) PushEvent {
		ev := f.event(nil)
		ev.EventType, ev.RelationshipID, ev.TargetID = EventEntrySettled, &relationship, &relationship
		ev.Payload, _ = json.Marshal(map[string]any{"expected_server_seq": expected, "settled_at_ms": boundary, "currency": "AFN"})
		return ev
	}
	assertRejected := func(result *PushResponse, reason string) {
		t.Helper()
		if len(result.Rejected) != 1 || result.Rejected[0].Reason != reason {
			t.Fatalf("wanted %s, got %+v", reason, result)
		}
	}
	f.push(t, entry("debt", base+1, base-10), entry("payment", base+2, base-20))
	observed := read()
	stale := settle(observed.ServerSeq, base+2)
	concurrent := entry("debt", base+3, base-30)
	stale.HLC = concurrent.HLC
	stale.HLC.Logical++ // Push applies each batch in signed HLC order.
	assertRejected(f.push(t, concurrent, stale), rejectSettlementChanged)
	assertRejected(f.push(t, settle(read().ServerSeq, base+3)), rejectSettlementNotZero)
	f.push(t, entry("payment", base+4, base-40))
	assertRejected(f.push(t, settle(read().ServerSeq, base+5)), rejectSettlementChanged)
	valid := settle(read().ServerSeq, base+4)
	if got := f.push(t, valid); len(got.Accepted) != 1 || len(got.Rejected) != 0 {
		t.Fatalf("settlement refused: %+v", got)
	}
	newEntry := entry("debt", base+5, base-50)
	f.push(t, newEntry)
	if got := f.push(t, valid); len(got.Duplicates) != 1 || len(got.Rejected) != 0 {
		t.Fatalf("lost-response retry changed: %+v", got)
	}
	ledger := read()
	if len(ledger.People) != 1 || ledger.People[0].SettledThrough["AFN"] != base+4 {
		t.Fatalf("lost settlement chapter: %+v", ledger.People)
	}
	for _, row := range ledger.Entries {
		if row.ID == *newEntry.TargetID {
			if row.ReadOnly || row.SettledAt != nil {
				t.Fatalf("backdated new entry became settled: %+v", row)
			}
		} else if !row.ReadOnly || row.SettledAt == nil {
			t.Fatalf("settled row mutable: %+v", row)
		}
	}
}

func TestObservedPersonArchiveAndRestoreKeepsEntries(t *testing.T) {
	f := newM1Fixture(t)
	relationship := seedCreditContact(t, f)
	f.push(t, creditEntry(f, relationship, "debt", "35.50"))
	read := func() *WebLedger {
		t.Helper()
		ledger, err := f.svc.WebLedger(t.Context(), f.accountID, f.deviceID, f.vaultID)
		if err != nil {
			t.Fatal(err)
		}
		return ledger
	}
	lifecycle := func(kind string) PushEvent {
		ledger := read()
		ev := f.event(nil)
		ev.EventType, ev.RelationshipID, ev.TargetID = kind, &relationship, &ledger.People[0].UserID
		ev.Payload, _ = json.Marshal(map[string]any{"expected_server_seq": ledger.ServerSeq})
		return ev
	}
	archived := lifecycle(EventPersonArchived)
	group := seedSyncGroup(t, f, relationship, "a")
	if got := f.push(t, archived); len(got.Rejected) != 1 || got.Rejected[0].Reason != rejectPersonShared {
		t.Fatalf("a concurrently linked person was hidden: %+v", got)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE tab_groups SET closed_at=NOW(),closed_by='a' WHERE id=$1::uuid`, group); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET archived_at=NOW() WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if got := f.push(t, archived); len(got.Rejected) != 1 || got.Rejected[0].Reason != rejectPersonChanged {
		t.Fatalf("a closed book was writable: %+v", got)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET archived_at=NULL WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if got := f.push(t, archived); len(got.Accepted) != 1 || len(got.Rejected) != 0 {
		t.Fatalf("archive refused: %+v", got)
	}
	if ledger := read(); ledger.People[0].ArchivedAt == nil || len(ledger.Entries) != 1 || !ledger.Entries[0].ReadOnly {
		t.Fatalf("archived history lost: %+v", ledger)
	}
	if got := f.push(t, lifecycle(EventPersonUnarchived)); len(got.Accepted) != 1 || len(got.Rejected) != 0 {
		t.Fatalf("restore refused: %+v", got)
	}
	if ledger := read(); ledger.People[0].ArchivedAt != nil || len(ledger.Entries) != 1 || ledger.Entries[0].ReadOnly || ledger.Entries[0].AmountAFN != "35.5" {
		t.Fatalf("restored history changed: %+v", ledger)
	}
}
