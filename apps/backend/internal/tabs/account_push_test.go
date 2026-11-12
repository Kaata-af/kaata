package tabs

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func registerAccountPush(t *testing.T, f *httpFixture, jwt, token string, policy NotificationPreferences) {
	t.Helper()
	got := f.do(t, "POST", "/v1/notifications/registration", "Bearer "+jwt, map[string]any{"install_id": uuid.NewString(), "token": token, "locale": "en", "preferences": policy})
	if got.status != 200 {
		t.Fatalf("register account push: %d %s", got.status, got.body)
	}
}
func seedConnectionNotice(t *testing.T, f *httpFixture, kind, source, recipient string) string {
	t.Helper()
	var id string
	err := f.pool.QueryRow(t.Context(), `INSERT INTO account_connection_notifications(event_kind,source_id,recipient_account_id,actor_account_id,actor_label,vault_label)
 VALUES($1,$2::uuid,$3::uuid,$4::uuid,'Private actor','Private shop') RETURNING id::text`, kind, source, recipient, f.acctA).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func accountPushCount(t *testing.T, f *httpFixture, table string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(t.Context(), "SELECT COUNT(*) FROM "+table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func TestAccountPushDurableIdentityRetryReceiptAndConcurrency(t *testing.T) {
	f := newHTTPFixture(t)
	jwt := f.jwtFor(t, f.acctB)
	claims, err := auth.ParseSession(testJWTSecret, jwt)
	if err != nil {
		t.Fatal(err)
	}
	policy := legacyNotificationPreferences()
	policy.Previews = "private"
	registerAccountPush(t, f, jwt, "ExpoPushToken[account_push_test]", policy)
	var installed string
	if err = f.pool.QueryRow(t.Context(), `SELECT install_id::text FROM account_push_subscriptions`).Scan(&installed); err != nil || installed != claims.InstallID {
		t.Fatalf("installation binding %s %v", installed, err)
	}
	source := uuid.NewString()
	notice := seedConnectionNotice(t, f, "friend_accepted", source, f.acctB)
	if _, err = f.pool.Exec(t.Context(), `INSERT INTO account_connection_notifications(event_kind,source_id,recipient_account_id,actor_account_id,actor_label)
 VALUES('friend_accepted',$1::uuid,$2::uuid,$3::uuid,'Again') ON CONFLICT DO NOTHING`, source, f.acctB, f.acctA); err != nil {
		t.Fatal(err)
	}
	if accountPushCount(t, f, "account_push_outbox") != 1 {
		t.Fatal("duplicate transition queued multiple pushes")
	}
	var mu sync.Mutex
	calls, receipts := 0, 0
	fail := true
	var ids []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if r.URL.Path == "/getReceipts" {
			receipts++
			_, _ = w.Write([]byte(`{"data":{"receipt-one":{"status":"ok"}}}`))
			return
		}
		calls++
		data := payload["data"].(map[string]any)
		if data["notification_id"] != notice || data["source_id"] != source || data["recipient_account_id"] != f.acctB || data["target"] != "connection" {
			t.Errorf("wrong routing: %+v", data)
		}
		body := payload["body"].(string)
		if strings.Contains(body, "Private") {
			t.Error("private preview leaked labels")
		}
		stable := payload["collapseId"].(string)
		ids = append(ids, stable)
		if len(stable) > 64 || payload["tag"] != stable {
			t.Error("missing safe retry collapse identifiers")
		}
		if fail {
			fail = false
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"receipt-one"}}`))
	}))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	if more, err := f.svc.deliverAccountPush(t.Context()); err != nil || !more {
		t.Fatal(more, err)
	}
	if _, err = f.pool.Exec(t.Context(), `UPDATE account_push_outbox SET next_at=NOW()`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := f.svc.deliverAccountPush(t.Context()); errs <- err }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 || len(ids) != 2 || ids[0] != ids[1] {
		t.Fatalf("retry/concurrent duplicate: calls=%d ids=%v", calls, ids)
	}
	if _, err = f.pool.Exec(t.Context(), `UPDATE account_push_outbox SET next_at=NOW()`); err != nil {
		t.Fatal(err)
	}
	if more, err := f.svc.deliverAccountPush(t.Context()); err != nil || !more {
		t.Fatal(more, err)
	}
	if receipts != 1 || accountPushCount(t, f, "account_push_outbox") != 0 || accountPushCount(t, f, "account_connection_notifications") != 1 {
		t.Fatal("receipt changed durable history or retained job")
	}
	old := f.do(t, "GET", "/v1/tabs/inbox", "Bearer "+jwt, nil)
	if strings.Contains(string(old.body), notice+`","tab_id`) {
		t.Fatal("legacy client saw opted-in connection notice")
	}
	page, err := f.svc.listInbox(t.Context(), f.acctB, "en", 0, connectionEventKinds)
	if err != nil || len(page.Items) != 1 || page.Items[0].SourceID != source || page.Items[0].RecipientAccountID != f.acctB {
		t.Fatal(page, err)
	}
}

func TestAccountPushPolicyAndRevocationDoNotReplay(t *testing.T) {
	for _, scenario := range []string{"muted_at_event", "muted_at_delivery", "quiet_at_event", "read", "revoked", "expired_request", "unregister", "device_missing"} {
		t.Run(scenario, func(t *testing.T) {
			f := newHTTPFixture(t)
			jwt := f.jwtFor(t, f.acctB)
			policy := legacyNotificationPreferences()
			if scenario == "muted_at_event" {
				policy.Connections = false
			}
			if scenario == "quiet_at_event" {
				now := time.Now().UTC()
				m := now.Hour()*60 + now.Minute()
				policy.QuietHours = NotificationQuietHours{Enabled: true, StartMinute: (m + 1439) % 1440, EndMinute: (m + 1) % 1440}
			}
			registerAccountPush(t, f, jwt, "ExpoPushToken[account_policy_test]", policy)
			kind, source := "friend_accepted", uuid.NewString()
			if scenario == "expired_request" {
				kind = "friend_requested"
			}
			notice := seedConnectionNotice(t, f, kind, source, f.acctB)
			if scenario == "muted_at_delivery" {
				policy.Connections = false
				registerAccountPush(t, f, jwt, "ExpoPushToken[account_policy_test]", policy)
			}
			if scenario == "muted_at_event" || scenario == "quiet_at_event" {
				registerAccountPush(t, f, jwt, "ExpoPushToken[account_policy_test]", legacyNotificationPreferences())
			}
			if scenario == "read" {
				if _, err := f.pool.Exec(t.Context(), `UPDATE account_connection_notifications SET read_at=NOW() WHERE id=$1::bigint`, notice); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "revoked" {
				if _, err := f.pool.Exec(t.Context(), `UPDATE auth_credentials SET revoked_at=NOW() WHERE account_id=$1::uuid`, f.acctB); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "unregister" {
				registerAccountPush(t, f, jwt, "", policy)
			}
			calls := 0
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				_, _ = w.Write([]byte(`{"data":{"status":"error","details":{"error":"DeviceNotRegistered"}}}`))
			}))
			defer provider.Close()
			f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
			if _, err := f.svc.deliverAccountPush(t.Context()); err != nil {
				t.Fatal(err)
			}
			want := 0
			if scenario == "device_missing" {
				want = 1
			}
			if calls != want || accountPushCount(t, f, "account_push_outbox") != 0 {
				t.Fatalf("stale delivery: calls%d want%d", calls, want)
			}
			if scenario == "device_missing" && accountPushCount(t, f, "account_push_subscriptions") != 0 {
				t.Fatal("unregistered device retained")
			}
			page, err := f.svc.listInbox(t.Context(), f.acctB, "en", 0, connectionEventKinds)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "expired_request" && (page.Unread != 0 || !page.Items[0].Read) {
				t.Fatalf("ended request leaves unread badge: %+v", page)
			}
		})
	}
}

func TestAccountPushAccountSwitchAndTokenRotation(t *testing.T) {
	f := newHTTPFixture(t)
	jwt := f.jwtFor(t, f.acctB)
	claims, err := auth.ParseSession(testJWTSecret, jwt)
	if err != nil {
		t.Fatal(err)
	}
	policy := legacyNotificationPreferences()
	registerAccountPush(t, f, jwt, "ExpoPushToken[original_account]", policy)
	seedConnectionNotice(t, f, "friend_accepted", uuid.NewString(), f.acctB)
	registerAccountPush(t, f, jwt, "ExpoPushToken[rotated_account]", policy)
	var token string
	_ = f.pool.QueryRow(t.Context(), `SELECT token FROM account_push_subscriptions`).Scan(&token)
	if token != "ExpoPushToken[rotated_account]" || accountPushCount(t, f, "account_push_outbox") != 1 {
		t.Fatal("same-account token rotation lost pending notification")
	}
	third := seedAccount(t, f.pool, "switch@example.test", "Switch")
	if _, err = f.pool.Exec(t.Context(), `UPDATE auth_credentials SET account_id=$2::uuid,provider_sub='switch' WHERE install_id=$1::uuid`, claims.InstallID, third); err != nil {
		t.Fatal(err)
	}
	switched, err := auth.SignSession(testJWTSecret, third, claims.InstallID, "google", "switch")
	if err != nil {
		t.Fatal(err)
	}
	registerAccountPush(t, f, switched, "ExpoPushToken[rotated_account]", policy)
	if accountPushCount(t, f, "account_push_outbox") != 0 {
		t.Fatal("account switch retained previous account jobs")
	}
	var account string
	_ = f.pool.QueryRow(t.Context(), `SELECT account_id::text FROM account_push_subscriptions`).Scan(&account)
	if account != third {
		t.Fatal("switch did not replace identity")
	}
	got := f.do(t, "POST", "/v1/notifications/registration", "Bearer "+jwt, map[string]any{"install_id": claims.InstallID, "token": ""})
	if got.status == 200 || accountPushCount(t, f, "account_push_subscriptions") != 1 {
		t.Fatal("old session unregistered new account")
	}
}

func TestConnectionNoticeCopyHasAllLanguages(t *testing.T) {
	for _, kind := range connectionEventKinds {
		for _, locale := range []string{"en", "fa", "ps"} {
			body := connectionNoticeBody(kind, locale, "Actor", "Book", "viewer")
			if body == "" || strings.Contains(body, "%!") || body == pushBodyFor("updated", locale, false) {
				t.Errorf("missing copy %s/%s: %q", kind, locale, body)
			}
		}
	}
	for _, kind := range []string{"settled", "unlinked"} {
		if got := tabLifecycleBody(kind, "en", ""); got == "" {
			t.Fatal(fmt.Sprint(kind))
		}
	}
}
