package sync

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// Settle-up (2026-07-27): entry_settled chapter markers must ride the
// snapshot cursor-independently (settlement_events, like membership_events)
// — the settlements projection is mobile-only, so a snapshot restore would
// otherwise keep the entries but lose the ruled-off chapter structure.
func TestSnapshotCarriesSettlementEvents(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()

	genesis := f.membershipEvent("vault_member_added", f.anchorDeviceID, f.ownerAcct, f.ownerAcct,
		map[string]any{"account_id": f.ownerAcct, "role": "owner"})
	f.signEvent(t, &genesis, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, genesis), 1)

	// The chapter marker, authored by the owner (editor-tier event on the
	// legacy ACL path — roleAtHLC resolves owner from the genesis audit row).
	relID := uuid.NewString()
	settled := f.membershipEvent("entry_settled", f.anchorDeviceID, f.ownerAcct, relID,
		map[string]any{"settled_at_ms": f.pms})
	settled.RelationshipID = &relID
	f.signEvent(t, &settled, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, settled), 1)

	// Empty snapshot planted ABOVE every server_seq: the tail is empty, so
	// only the cursor-independent ride-along can carry the marker.
	var maxSeq int64
	if err := f.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) FROM events WHERE vault_id = $1::uuid
	`, f.vaultID).Scan(&maxSeq); err != nil {
		t.Fatalf("read max server_seq: %v", err)
	}
	emptyProjection, err := ProjectionToJSON(NewProjection())
	if err != nil {
		t.Fatalf("serialize empty projection: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_snapshots (vault_id, up_to_server_seq, snapshot, schema_version, byte_size)
		VALUES ($1::uuid, $2, $3::jsonb, $4, $5)
	`, f.vaultID, maxSeq, string(emptyProjection), SnapshotSchemaVersion, len(emptyProjection)); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}

	snap, err := f.svc.LatestSnapshot(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("LatestSnapshot: %v", err)
	}
	if len(snap.Events) != 0 {
		t.Fatalf("tail = %d events, want 0 (cursor above all)", len(snap.Events))
	}
	found := false
	for _, ev := range snap.SettlementEvents {
		if ev.EventID == settled.EventID {
			found = true
			if ev.EventType != "entry_settled" {
				t.Errorf("settlement event type = %q, want entry_settled", ev.EventType)
			}
			if ev.RelationshipID == nil || *ev.RelationshipID != relID {
				t.Errorf("settlement relationship_id = %v, want %s", ev.RelationshipID, relID)
			}
		}
	}
	if !found {
		t.Fatalf("settlement_events missing the marker; got %d events", len(snap.SettlementEvents))
	}
}
