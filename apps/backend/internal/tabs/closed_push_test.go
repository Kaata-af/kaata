package tabs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestClosedSharedHistoryRetainsInboxWithoutRemoteAlerts(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	providerCalls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"unexpected"}}`))
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	c := f.createOverHTTP(t, "")
	pa, pb := f.party(t, c.MyToken, c.Tab.ID), f.party(t, c.InviteToken, c.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	for _, account := range []string{f.acctA, f.acctB} {
		got := f.do(t, "POST", "/v1/tabs/"+c.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, account), map[string]any{
			"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_closed_" + account + "]", "locale": "en",
		})
		if got.status != 200 {
			t.Fatalf("subscribe: %d %s", got.status, got.body)
		}
	}
	accepted := f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli()).Entry
	rejected := f.append(t, pb, "b_to_a", "100", time.Now().UnixMilli()).Entry
	cancelled := f.append(t, pa, "a_to_b", "20", time.Now().UnixMilli()).Entry
	if _, err := f.svc.Close(ctx, pb); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Accept(ctx, pb, accepted.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Dispute(ctx, pa, rejected.ID, "Not received"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Void(ctx, pa, cancelled.ID); err != nil {
		t.Fatal(err)
	}
	var jobs int
	if err := f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_push_outbox").Scan(&jobs); err != nil || jobs == 0 {
		t.Fatalf("test did not queue remote jobs: %d %v", jobs, err)
	}
	for {
		more, err := f.svc.deliverPush(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !more {
			break
		}
	}
	if providerCalls != 0 {
		t.Fatalf("closed account sent %d remote alerts", providerCalls)
	}
	for _, account := range []string{f.acctA, f.acctB} {
		page, err := f.svc.listInbox(ctx, account, "en", 0)
		if err != nil || len(page.Items) == 0 {
			t.Fatalf("silencing remote alerts removed durable inbox for %s: %+v %v", account, page, err)
		}
	}
	var finalKinds int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(DISTINCT event_kind) FROM tab_notifications
	 WHERE tab_id=$1::uuid AND event_kind IN ('entry_accepted','entry_rejected','entry_voided')`, c.Tab.ID).Scan(&finalKinds); err != nil || finalKinds != 3 {
		t.Fatalf("post-close decisions missing from durable history: %d %v", finalKinds, err)
	}
}
