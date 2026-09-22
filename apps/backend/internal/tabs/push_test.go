package tabs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPushOutboxDeliveryAndRevocation(t *testing.T) {
	f := newHTTPFixture(t)
	mode := "ok"
	sends := 0
	receipts := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/send" {
			sends++
			if body["title"] != "Kaata" || body["data"].(map[string]any)["tab_id"] == nil {
				t.Error("missing navigation data")
			}
			// Neither balances nor invitation credentials go to Expo.
			if len(body["data"].(map[string]any)) != 2 {
				t.Error("unexpected private data in payload")
			}
			if mode == "retry" {
				w.WriteHeader(503)
				return
			}
			_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"ticket-1"}}`))
		} else {
			receipts++
			if mode == "unregistered" {
				_, _ = w.Write([]byte(`{"data":{"ticket-1":{"status":"error","details":{"error":"DeviceNotRegistered"}}}}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":{"ticket-1":{"status":"ok"}}}`))
		}
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	created := f.createOverHTTP(t, "")
	path := "/v1/tabs/" + created.Tab.ID
	for _, token := range []string{created.MyToken, created.InviteToken} {
		r := f.do(t, "POST", path+"/notifications", "Tab "+token, map[string]any{
			"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_test_123456]", "locale": "fa",
		})
		if r.status != 200 {
			t.Fatalf("subscribe: %d %s", r.status, r.body)
		}
	}
	ctx := context.Background()
	pa := f.party(t, created.MyToken, created.Tab.ID)
	f.append(t, pa, "a_to_b", "10", time.Now().UnixMilli())
	var jobs int
	_ = f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tab_push_outbox`).Scan(&jobs)
	if jobs != 1 {
		t.Fatalf("want only peer delivery, got %d", jobs)
	}
	mode = "retry"
	if _, err := f.svc.deliverPush(ctx); err != nil {
		t.Fatal(err)
	}
	if more, err := f.svc.deliverPush(ctx); err != nil || more {
		t.Fatalf("backoff not respected: %v %v", more, err)
	}
	_, _ = f.pool.Exec(ctx, `UPDATE tab_push_outbox SET next_at=NOW()`)
	mode = "ok"
	if _, err := f.svc.deliverPush(ctx); err != nil {
		t.Fatal(err)
	}
	var ticket *string
	_ = f.pool.QueryRow(ctx, `SELECT receipt_id FROM tab_push_outbox`).Scan(&ticket)
	if ticket == nil || *ticket != "ticket-1" {
		t.Fatal("ticket must survive worker restart")
	}
	_, _ = f.pool.Exec(ctx, `UPDATE tab_push_outbox SET next_at=NOW()`)
	if _, err := f.svc.deliverPush(ctx); err != nil {
		t.Fatal(err)
	}
	_ = f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tab_push_outbox`).Scan(&jobs)
	if jobs != 0 || sends != 2 || receipts != 1 {
		t.Fatalf("delivery/receipt: jobs=%d sends=%d receipts=%d", jobs, sends, receipts)
	}

	f.append(t, pa, "a_to_b", "20", time.Now().UnixMilli())
	_, _ = f.svc.deliverPush(ctx)
	_, _ = f.pool.Exec(ctx, `UPDATE tab_push_outbox SET next_at=NOW()`)
	mode = "unregistered"
	_, _ = f.svc.deliverPush(ctx)
	var subs int
	_ = f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tab_push_subscriptions WHERE role='b'`).Scan(&subs)
	if subs != 0 {
		t.Fatal("unregistered device must be removed")
	}

	// Register again, queue, then rotate the credential BEFORE delivery.
	f.do(t, "POST", path+"/notifications", "Tab "+created.InviteToken, map[string]any{
		"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_test_123456]",
	})
	f.append(t, pa, "a_to_b", "30", time.Now().UnixMilli())
	_, err := f.svc.RegenerateLink(ctx, pa)
	if err != nil {
		t.Fatal(err)
	}
	before := sends
	for {
		more, err := f.svc.deliverPush(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !more {
			break
		}
	}
	if sends != before {
		t.Fatal("rotated capability still received a push")
	}
}

func TestPushDoesNotDeliverToRevokedVaultMember(t *testing.T) {
	f := newHTTPFixture(t)
	sent := false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent = true
		w.WriteHeader(500)
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	ctx := context.Background()
	created := f.create(t, "A", "", "")
	pb := f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	member := seedAccount(t, f.pool, "notify-member@example.com", "Member")
	seedMember(t, f.pool, f.vaultB, member, "viewer")
	r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, member), map[string]any{
		"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_test_123456]",
	})
	if r.status != 200 {
		t.Fatalf("subscribe: %d %s", r.status, r.body)
	}
	f.append(t, f.party(t, created.MyToken, created.Tab.ID), "a_to_b", "1", time.Now().UnixMilli())
	// NULL bound account + revoked membership must be FALSE, not a nullable
	// SQL boolean that prevents the worker from scanning every future job.
	if _, err := f.pool.Exec(ctx, `UPDATE tab_parties SET account_id=NULL WHERE tab_id=$1::uuid AND role='b'`, created.Tab.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET revoked_at=NOW() WHERE account_id=$1::uuid`, member); err != nil {
		t.Fatal(err)
	}
	if more, err := f.svc.deliverPush(ctx); err != nil || !more {
		t.Fatalf("discard: %v %v", more, err)
	}
	if sent {
		t.Fatal("revoked member received a notification")
	}
}
