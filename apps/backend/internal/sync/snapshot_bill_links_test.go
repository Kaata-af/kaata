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

// Pure query/scanner contract tests. Never connect to or reset a database.
type billLinkSnapshotQuery struct {
	t     *testing.T
	rows  pgx.Rows
	err   error
	vault string
}

func (q billLinkSnapshotQuery) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	q.t.Helper()
	for _, predicate := range []string{"vault_id = $1::uuid", "redacted_at IS NULL", "event_type = 'vault_setting_set'", "payload->>'key' = 'share_bill_links'", "ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC, event_id ASC"} {
		if !strings.Contains(sql, predicate) {
			q.t.Fatalf("bill preference query missing %q", predicate)
		}
	}
	if strings.Contains(sql, "server_seq >") || len(args) != 1 || args[0] != q.vault {
		q.t.Fatal("the complete preference history must recover independently of the cursor within exactly one vault")
	}
	if !strings.Contains(sql, "THEN signed_actor_account_id ELSE account_id") {
		q.t.Fatal("signed author identity must remain byte-compatible")
	}
	return q.rows, q.err
}

func TestSnapshotBillLinksSignedHistory(t *testing.T) {
	actor, signature, pubkey := "signed-owner", "original-signature", "original-pubkey"
	seq := int64(8)
	payload := []byte(`{"key":"share_bill_links","value":"false"}`)
	rows := &enabledCurrencySnapshotRows{values: [][]any{{
		"pre-cursor-bill-off", int64(100), int64(0), "device", "device", &actor,
		nil, nil, "vault_setting_set", 1, payload, &seq, &signature, &pubkey,
		int64(9), time.UnixMilli(1234),
	}}}
	events, err := pullBillLinkEvents(context.Background(), billLinkSnapshotQuery{t: t, rows: rows, vault: "book"}, "book")
	if err != nil {
		t.Fatal(err)
	}
	if !rows.closed || len(events) != 1 {
		t.Fatal("complete bill preference history was not read and closed")
	}
	event := events[0]
	if string(event.Payload) != string(payload) || *event.AccountID != actor || *event.EventSigB64 != signature || *event.SignerDevicePubkey != pubkey || *event.AuthorSeq != seq || event.ServerSeq != 9 {
		t.Fatal("snapshot rewrote signed preference or authority")
	}
	wire, err := json.Marshal(SnapshotResponse{SnapshotServerSeq: 500, BillLinkEvents: events})
	if err != nil {
		t.Fatal(err)
	}
	var restored SnapshotResponse
	if err := json.Unmarshal(wire, &restored); err != nil {
		t.Fatal(err)
	}
	if len(restored.BillLinkEvents) != 1 || string(restored.BillLinkEvents[0].Payload) != string(payload) {
		t.Fatal("explicit OFF before the cursor was lost from the additive wire field")
	}
	legacy, _ := json.Marshal(SnapshotResponse{})
	if strings.Contains(string(legacy), "bill_link_events") {
		t.Fatal("empty preference history must preserve the old response shape")
	}
}

func TestSnapshotBillLinksReadFailure(t *testing.T) {
	want := errors.New("bill preference history unavailable")
	_, err := pullBillLinkEvents(context.Background(), billLinkSnapshotQuery{t: t, err: want, vault: "book"}, "book")
	if !errors.Is(err, want) {
		t.Fatal("missing history must not masquerade as successful recovery")
	}
	rows := &enabledCurrencySnapshotRows{values: [][]any{{}}, scanErr: want}
	_, err = pullBillLinkEvents(context.Background(), billLinkSnapshotQuery{t: t, rows: rows, vault: "book"}, "book")
	if !errors.Is(err, want) || !rows.closed {
		t.Fatal("invalid preference history must fail without leaking rows")
	}
}
