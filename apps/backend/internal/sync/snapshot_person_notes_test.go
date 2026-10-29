package sync

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type personNoteSnapshotQuery struct {
	t     *testing.T
	rows  pgx.Rows
	err   error
	vault string
}

func (q personNoteSnapshotQuery) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	q.t.Helper()
	for _, predicate := range []string{"vault_id = $1::uuid", "redacted_at IS NULL", "event_type = 'person_note_set'", "ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC, event_id ASC", "THEN signed_actor_account_id ELSE account_id"} {
		if !strings.Contains(sql, predicate) {
			q.t.Fatalf("staff note recovery missing scope/order/authority: %q", predicate)
		}
	}
	if strings.Contains(sql, "server_seq >") || len(args) != 1 || args[0] != q.vault {
		q.t.Fatal("staff notes must recover before the cursor and within exactly one Kaata")
	}
	return q.rows, q.err
}

func TestSnapshotPersonNoteSignedRecovery(t *testing.T) {
	actor, signature, pubkey := "signed-editor", "original-signature", "original-pubkey"
	relationship, seq := "relationship", int64(8)
	rows := &enabledCurrencySnapshotRows{}
	for i, payload := range []string{`{"note":"Call before giving credit"}`, `{"note":null}`} {
		rows.values = append(rows.values, []any{
			[]string{"pre-cursor-note", "pre-cursor-clear"}[i], int64(100 + i), int64(0), "device", "device", &actor,
			&relationship, &relationship, EventPersonNoteSet, 1, []byte(payload), &seq, &signature, &pubkey,
			int64(9 + i), time.UnixMilli(1234),
		})
	}
	events, err := pullPersonNoteEvents(context.Background(), personNoteSnapshotQuery{t: t, rows: rows, vault: "book"}, "book")
	if err != nil {
		t.Fatal(err)
	}
	if !rows.closed || len(events) != 2 {
		t.Fatal("complete note/clear history must be read and closed")
	}
	for i, event := range events {
		if *event.AccountID != actor || *event.EventSigB64 != signature || *event.SignerDevicePubkey != pubkey || *event.AuthorSeq != seq || *event.TargetID != relationship || *event.RelationshipID != relationship || event.ServerSeq != int64(9+i) {
			t.Fatal("snapshot rewrote signed note or its authority")
		}
	}
	wire, err := json.Marshal(SnapshotResponse{SnapshotServerSeq: 500, PersonNoteEvents: events})
	if err != nil {
		t.Fatal(err)
	}
	var restored SnapshotResponse
	if err := json.Unmarshal(wire, &restored); err != nil {
		t.Fatal(err)
	}
	if len(restored.PersonNoteEvents) != 2 || string(restored.PersonNoteEvents[1].Payload) != `{"note":null}` {
		t.Fatal("pre-cursor clear lost from additive signed recovery field")
	}
	legacy, _ := json.Marshal(SnapshotResponse{})
	if strings.Contains(string(legacy), "person_note_events") {
		t.Fatal("empty note history must preserve old response shape")
	}
}

func TestSnapshotPersonNoteReadFailures(t *testing.T) {
	want := errors.New("note history unavailable")
	_, err := pullPersonNoteEvents(context.Background(), personNoteSnapshotQuery{t: t, err: want, vault: "book"}, "book")
	if !errors.Is(err, want) {
		t.Fatal("missing history masqueraded as successful recovery")
	}
	rows := &enabledCurrencySnapshotRows{values: [][]any{{}}, scanErr: want}
	_, err = pullPersonNoteEvents(context.Background(), personNoteSnapshotQuery{t: t, rows: rows, vault: "book"}, "book")
	if !errors.Is(err, want) || !rows.closed {
		t.Fatal("invalid note history did not fail or leaked rows")
	}
}
