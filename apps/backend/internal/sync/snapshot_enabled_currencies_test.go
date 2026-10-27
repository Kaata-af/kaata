package sync

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// These tests never open a database. The fake enforces the recovery query's
// privacy/cursor boundary while the production scanner preserves signed bytes.
type enabledCurrencySnapshotQuery struct {
	t     *testing.T
	rows  pgx.Rows
	err   error
	vault string
}

func (q enabledCurrencySnapshotQuery) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	q.t.Helper()
	for _, predicate := range []string{"vault_id = $1::uuid", "redacted_at IS NULL", "event_type = 'vault_setting_set'", "payload->>'key' = 'enabled_currencies'", "ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC, event_id ASC"} {
		if !strings.Contains(sql, predicate) {
			q.t.Fatalf("recovery query missing %q", predicate)
		}
	}
	if strings.Contains(sql, "server_seq >") || len(args) != 1 || args[0] != q.vault {
		q.t.Fatal("enabled choices must recover before the snapshot cursor within exactly one vault")
	}
	if !strings.Contains(sql, "THEN signed_actor_account_id ELSE account_id") {
		q.t.Fatal("signed author identity must remain byte-compatible")
	}
	return q.rows, q.err
}

type enabledCurrencySnapshotRows struct {
	pgx.Rows
	values  [][]any
	index   int
	closed  bool
	scanErr error
}

func (r *enabledCurrencySnapshotRows) Close()     { r.closed = true }
func (r *enabledCurrencySnapshotRows) Err() error { return nil }
func (r *enabledCurrencySnapshotRows) Next() bool {
	if r.index >= len(r.values) {
		return false
	}
	r.index++
	return true
}
func (r *enabledCurrencySnapshotRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	for i, value := range r.values[r.index-1] {
		target := reflect.ValueOf(dest[i]).Elem()
		if value == nil {
			target.SetZero()
		} else {
			target.Set(reflect.ValueOf(value))
		}
	}
	return nil
}

func TestSnapshotEnabledCurrenciesSignedHistory(t *testing.T) {
	actor, signature, pubkey := "signed-owner", "original-signature", "original-pubkey"
	seq := int64(8)
	payload := []byte(`{"key":"enabled_currencies","value":"[\"AFN\",\"EUR\"]"}`)
	rows := &enabledCurrencySnapshotRows{values: [][]any{{
		"setting-before-snapshot", int64(100), int64(0), "device", "device", &actor,
		nil, nil, "vault_setting_set", 1, payload, &seq, &signature, &pubkey,
		int64(9), time.UnixMilli(1234),
	}}}
	events, err := pullEnabledCurrencyEvents(context.Background(), enabledCurrencySnapshotQuery{t: t, rows: rows, vault: "book"}, "book")
	if err != nil {
		t.Fatal(err)
	}
	if !rows.closed || len(events) != 1 {
		t.Fatal("complete setting history was not read and closed")
	}
	event := events[0]
	if string(event.Payload) != string(payload) || *event.AccountID != actor || *event.EventSigB64 != signature || *event.SignerDevicePubkey != pubkey || *event.AuthorSeq != seq || event.ServerSeq != 9 {
		t.Fatal("snapshot rewrote signed setting payload or authority")
	}
	wire, err := json.Marshal(SnapshotResponse{SnapshotServerSeq: 500, EnabledCurrencyEvents: events})
	if err != nil {
		t.Fatal(err)
	}
	var restored SnapshotResponse
	if err := json.Unmarshal(wire, &restored); err != nil {
		t.Fatal(err)
	}
	if len(restored.EnabledCurrencyEvents) != 1 || string(restored.EnabledCurrencyEvents[0].Payload) != string(payload) {
		t.Fatal("pre-cursor explicit list was lost from the additive wire field")
	}
	legacy, _ := json.Marshal(SnapshotResponse{})
	if strings.Contains(string(legacy), "enabled_currency_events") {
		t.Fatal("empty history must preserve the old response shape")
	}
}

func TestSnapshotEnabledCurrenciesReadFailure(t *testing.T) {
	want := errors.New("setting history unavailable")
	_, err := pullEnabledCurrencyEvents(context.Background(), enabledCurrencySnapshotQuery{t: t, err: want, vault: "book"}, "book")
	if !errors.Is(err, want) {
		t.Fatal("missing history must not masquerade as successful recovery")
	}
	rows := &enabledCurrencySnapshotRows{values: [][]any{{}}, scanErr: want}
	_, err = pullEnabledCurrencyEvents(context.Background(), enabledCurrencySnapshotQuery{t: t, rows: rows, vault: "book"}, "book")
	if !errors.Is(err, want) || !rows.closed {
		t.Fatal("invalid history must fail without leaking rows")
	}
}
