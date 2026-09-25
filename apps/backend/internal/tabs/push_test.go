package tabs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
			if !strings.Contains(body["body"].(string), "Saafi Store") || !strings.Contains(body["body"].(string), "AFN") {
				t.Error("push lost actor/amount context")
			}
			if len(body["data"].(map[string]any)) > 5 {
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
	if _, err := f.svc.Bind(context.Background(), f.party(t, created.InviteToken, created.Tab.ID), BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	for _, account := range []string{f.acctA, f.acctB} {
		r := f.do(t, "POST", path+"/notifications", "Bearer "+f.jwtFor(t, account), map[string]any{
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

	// A pre-upgrade capability registration is no longer authorized.
	_, err := f.pool.Exec(ctx, `INSERT INTO tab_push_subscriptions(tab_id,role,install_id,token,capability_hash)
	 VALUES($1::uuid,'b',$2::uuid,'ExpoPushToken[synthetic_test_123456]',$3)`,
		created.Tab.ID, uuid.NewString(), hashPartyToken(created.InviteToken))
	if err != nil {
		t.Fatal(err)
	}
	f.append(t, pa, "a_to_b", "30", time.Now().UnixMilli())
	_, err = f.svc.RegenerateLink(ctx, pa)
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

func TestPushReviewActionsRequireCurrentEntryAndRole(t *testing.T) {
	for _, tc := range []struct {
		name, memberRole                 string
		reviewed, downgrade, wantActions bool
	}{
		{"bound owner", "", false, false, true},
		{"editor", "editor", false, false, true},
		{"viewer", "viewer", false, false, false},
		{"clerk", "clerk", false, false, false},
		{"role changed before delivery", "editor", false, true, false},
		{"reviewed before delivery", "", true, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHTTPFixture(t)
			ctx := context.Background()
			payloads := make(chan map[string]any, 1)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				payloads <- body
				_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"ticket"}}`))
			}))
			defer provider.Close()
			f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
			c := f.createOverHTTP(t, "")
			pa, pb := f.party(t, c.MyToken, c.Tab.ID), f.party(t, c.InviteToken, c.Tab.ID)
			if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
				t.Fatal(err)
			}
			recipient := f.acctB
			if tc.memberRole != "" {
				recipient = seedAccount(t, f.pool, "reviewer@example.com", "Reviewer")
				seedMember(t, f.pool, f.vaultB, recipient, tc.memberRole)
			}
			reg := f.do(t, "POST", "/v1/tabs/"+c.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, recipient), map[string]any{
				"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_test_123456]", "locale": "fa",
			})
			if reg.status != 200 {
				t.Fatalf("registration: %s", reg.body)
			}
			added := f.append(t, pa, "a_to_b", "100", time.Now().UnixMilli())
			if tc.reviewed {
				if _, err := f.svc.Accept(ctx, pb, added.Entry.ID); err != nil {
					t.Fatal(err)
				}
			}
			if tc.downgrade {
				if _, err := f.pool.Exec(ctx, "UPDATE vault_members SET role='viewer' WHERE account_id=$1::uuid", recipient); err != nil {
					t.Fatal(err)
				}
			}
			if more, err := f.svc.deliverPush(ctx); err != nil || !more {
				t.Fatalf("delivery: %v %v", more, err)
			}
			select {
			case payload := <-payloads:
				_, actions := payload["categoryId"]
				if actions != tc.wantActions {
					t.Fatalf("action availability: %v, want %v", actions, tc.wantActions)
				}
				if actions && payload["categoryId"] != "tab-review-fa" {
					t.Fatal("wrong localized action category")
				}
				data := payload["data"].(map[string]any)
				if data["entry_id"] != added.Entry.ID || data["kind"] != "entry_created" || data["role"] != "b" || data["rev"] != float64(added.Entry.Rev) || len(data) != 5 {
					t.Fatalf("wrong action target: %v", data)
				}
			case <-time.After(time.Second):
				t.Fatal("no delivery")
			}
		})
	}
}

func TestPushReviewOutcomeText(t *testing.T) {
	for _, locale := range []string{"en", "fa"} {
		seen := map[string]bool{}
		for _, kind := range []string{"updated", "entry_created", "entry_accepted", "entry_rejected", "entry_voided"} {
			body := pushBody(kind, locale)
			if body == "" || seen[body] {
				t.Fatalf("outcome %s/%s is not distinct", locale, kind)
			}
			seen[body] = true
		}
	}
}

func TestPushStopsAfterInstallationSignsOut(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("signed-out phone reached push provider")
		w.WriteHeader(500)
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	c := f.createOverHTTP(t, "")
	if _, err := f.svc.Bind(ctx, f.party(t, c.InviteToken, c.Tab.ID), BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	spoofedInstall := uuid.NewString()
	r := f.do(t, "POST", "/v1/tabs/"+c.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, f.acctB), map[string]any{
		"install_id": spoofedInstall, "token": "ExpoPushToken[synthetic_test_123456]",
	})
	if r.status != 200 {
		t.Fatal(string(r.body))
	}
	var stored string
	if err := f.pool.QueryRow(ctx, "SELECT install_id::text FROM tab_push_subscriptions").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == spoofedInstall {
		t.Fatal("trusted request installation instead of session")
	}
	f.append(t, f.party(t, c.MyToken, c.Tab.ID), "a_to_b", "1", time.Now().UnixMilli())
	// SignOut deletes this installation's credential. Delivery checks it even
	// if the job was queued while the phone was still signed in.
	if _, err := f.pool.Exec(ctx, "DELETE FROM auth_credentials WHERE install_id=$1::uuid", stored); err != nil {
		t.Fatal(err)
	}
	if more, err := f.svc.deliverPush(ctx); err != nil || !more {
		t.Fatalf("discard: %v %v", more, err)
	}
}
