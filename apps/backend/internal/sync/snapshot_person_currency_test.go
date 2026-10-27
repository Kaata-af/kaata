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

// Pure query/scanner contract tests; never connect to a database.
type personCurrencySnapshotQuery struct {
	t     *testing.T
	rows  pgx.Rows
	err   error
	vault string
}

func (q personCurrencySnapshotQuery) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	q.t.Helper()
	for _, predicate := range []string{"vault_id = $1::uuid", "redacted_at IS NULL", "event_type = 'person_default_currency_set'", "ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC, event_id ASC"} {
		if !strings.Contains(sql, predicate) {
			q.t.Fatalf("contact currency recovery query missing %q", predicate)
		}
	}
	if strings.Contains(sql, "server_seq >") || len(args) != 1 || args[0] != q.vault {
		q.t.Fatal("contact defaults must recover independently of the cursor within exactly one Kaata")
	}
	if !strings.Contains(sql, "THEN signed_actor_account_id ELSE account_id") {
		q.t.Fatal("signed author identity must remain byte-compatible")
	}
	return q.rows, q.err
}

func TestSnapshotPersonCurrencySignedHistory(t *testing.T) {
	actor, signature, pubkey := "signed-editor", "original-signature", "original-pubkey"
	person, seq := "relationship", int64(8)
	rows := &enabledCurrencySnapshotRows{values: [][]any{}}
	for i, payload := range []string{`{"currency":"USD"}`, `{"currency":null}`} {
		rows.values = append(rows.values, []any{
			[]string{"pre-cursor-usd", "pre-cursor-reset"}[i], int64(100 + i), int64(0), "device", "device", &actor,
			&person, &person, "person_default_currency_set", 1, []byte(payload), &seq, &signature, &pubkey,
			int64(9 + i), time.UnixMilli(1234),
		})
	}
	events, err := pullPersonCurrencyEvents(context.Background(), personCurrencySnapshotQuery{t: t, rows: rows, vault: "book"}, "book")
	if err != nil {
		t.Fatal(err)
	}
	if !rows.closed || len(events) != 2 {
		t.Fatal("complete history, including explicit resets, must be read and closed")
	}
	for i, event := range events {
		if *event.AccountID != actor || *event.EventSigB64 != signature || *event.SignerDevicePubkey != pubkey || *event.AuthorSeq != seq || *event.TargetID != person || *event.RelationshipID != person || event.ServerSeq != int64(9+i) {
			t.Fatal("snapshot rewrote signed preference or authority")
		}
	}
	wire, err := json.Marshal(SnapshotResponse{SnapshotServerSeq: 500, PersonCurrencyEvents: events})
	if err != nil {
		t.Fatal(err)
	}
	var restored SnapshotResponse
	if err := json.Unmarshal(wire, &restored); err != nil {
		t.Fatal(err)
	}
	if len(restored.PersonCurrencyEvents) != 2 || string(restored.PersonCurrencyEvents[1].Payload) != `{"currency":null}` {
		t.Fatal("pre-cursor null reset was lost from the additive wire field")
	}
	legacy, _ := json.Marshal(SnapshotResponse{})
	if strings.Contains(string(legacy), "person_currency_events") {
		t.Fatal("empty preference history must preserve the old response shape")
	}
}

func TestSnapshotPersonCurrencyReadFailure(t *testing.T) {
	want := errors.New("contact preference history unavailable")
	_, err := pullPersonCurrencyEvents(context.Background(), personCurrencySnapshotQuery{t: t, err: want, vault: "book"}, "book")
	if !errors.Is(err, want) {
		t.Fatal("missing history must not masquerade as successful recovery")
	}
	rows := &enabledCurrencySnapshotRows{values: [][]any{{}}, scanErr: want}
	_, err = pullPersonCurrencyEvents(context.Background(), personCurrencySnapshotQuery{t: t, rows: rows, vault: "book"}, "book")
	if !errors.Is(err, want) || !rows.closed {
		t.Fatal("invalid history must fail without leaking rows")
	}
}

func TestSnapshotPersonCurrencyFrontier(t *testing.T) {
	// Changing a preference must not reorder a contact's financial activity,
	// but the full field clock still belongs in the recovery frontier.
	reset := HLC{PMS: 200, L: 3, DID: "editor"}
	p := Projection{Relationships: map[string]*RelationshipProjection{
		"r": {ID: "r", UpdatedAt: 1, CurrencyFieldHLC: &reset},
	}}
	if got := snapshotMaxHLC(&p, nil); CompareHLC(got, reset) != 0 {
		t.Fatalf("contact reset clock missing from snapshot frontier: %+v", got)
	}
}
