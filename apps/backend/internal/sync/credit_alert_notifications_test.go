package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
)

func seedCreditPushInstall(t *testing.T, f *m1Fixture, installID string) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO installs(install_id,account_id) VALUES($1::uuid,$2::uuid) ON CONFLICT(install_id) DO UPDATE SET account_id=EXCLUDED.account_id`, installID, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO auth_credentials(install_id,provider,provider_sub,account_id) VALUES($1::uuid,'google',$2,$3::uuid)`, installID, "credit-test-"+installID, f.accountID); err != nil {
		t.Fatal(err)
	}
}

func creditPushHTTP(t *testing.T, f *m1Fixture, method, path, installID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	token, err := auth.SignSession(testJWTSecret, f.accountID, installID, "google", "credit-push-test")
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Kaata-Currencies", "1")
	router := chi.NewRouter()
	h := NewHandler(f.svc)
	router.Post("/v1/sync/credit-alerts/notifications", h.CreditAlertNotifications)
	router.Get("/v1/sync/credit-alerts/events/{event_key}", h.CreditAlertEvent)
	rec := httptest.NewRecorder()
	auth.RequireSession(testJWTSecret)(router).ServeHTTP(rec, req)
	return rec
}

func registerCreditPush(t *testing.T, f *m1Fixture, prefs creditNotificationPreferences, customers []creditCustomerPreferences) *httptest.ResponseRecorder {
	t.Helper()
	return creditPushHTTP(t, f, "POST", "/v1/sync/credit-alerts/notifications?vault_id="+f.vaultID, f.deviceID, map[string]any{"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_credit_token]", "locale": "en", "preferences": prefs, "customer_preferences": customers})
}

func fakeCreditProvider(t *testing.T, f *m1Fixture) <-chan map[string]any {
	t.Helper()
	payloads := make(chan map[string]any, 30)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/send" {
			payloads <- body
			_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"synthetic-credit-ticket"}}`))
			return
		}
		if r.URL.Path == "/getReceipts" {
			_, _ = w.Write([]byte(`{"data":{"synthetic-credit-ticket":{"status":"ok"}}}`))
			return
		}
		t.Error("unexpected fake provider request", r.URL.Path)
	}))
	t.Cleanup(provider.Close)
	f.svc.creditPush = &creditPushClient{client: provider.Client(), baseURL: provider.URL}
	return payloads
}

func pushCreditCurrency(t *testing.T, f *m1Fixture, rel, kind, amount, code string) {
	t.Helper()
	event := creditEntry(f, rel, kind, amount)
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	payload["currency"], _ = json.Marshal(code)
	event.Payload, _ = json.Marshal(payload)
	if got := f.push(t, event); len(got.Accepted) != 1 {
		t.Fatalf("currency entry rejected: %+v", got)
	}
}

func saveCreditAlertBody(t *testing.T, f *m1Fixture, body string) {
	t.Helper()
	if r := creditAlertsRequest(t, f, "PUT", "", body, true); r.Code != 200 {
		t.Fatalf("alert policy save %d %s", r.Code, r.Body.String())
	}
}

func scanCredit(t *testing.T, f *m1Fixture) {
	t.Helper()
	if err := f.svc.scanCreditAlerts(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func creditJobs(t *testing.T, f *m1Fixture, want int) {
	t.Helper()
	var count int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM credit_push_outbox`).Scan(&count); err != nil || count != want {
		t.Fatalf("jobs=%d want%d err=%v", count, want, err)
	}
}

func TestCreditPushExactCombinedCrossingOpaqueDeliveryAndRearm(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPushInstall(t, f, f.deviceID)
	payloads := fakeCreditProvider(t, f)
	body := `{"relationship_id":"` + rel + `","groups":[{"direction":"collect","conditions":[{"currency":"USD","threshold_minor":1000000}]},{"direction":"collect","conditions":[{"currency":"AFN","threshold_minor":20000000}]},{"direction":"collect","conditions":[{"currency":"USD","threshold_minor":500000},{"currency":"AFN","threshold_minor":10000000}]}]}`
	saveCreditAlertBody(t, f, body)
	if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != 200 || !strings.Contains(r.Body.String(), `"remote_delivery_enabled":true`) {
		t.Fatalf("registration %d %s", r.Code, r.Body.String())
	} else {
		var registration struct {
			LeaseMS int64 `json:"remote_delivery_lease_ms"`
		}
		if json.Unmarshal(r.Body.Bytes(), &registration) != nil || registration.LeaseMS <= int64((29*24*time.Hour)/time.Millisecond) || registration.LeaseMS > int64((30*24*time.Hour)/time.Millisecond) {
			t.Fatalf("invalid server lease duration: %s", r.Body.String())
		}
	}
	var storedInstall string
	if err := f.pool.QueryRow(t.Context(), `SELECT install_id::text FROM credit_push_subscriptions`).Scan(&storedInstall); err != nil || storedInstall != f.deviceID {
		t.Fatalf("client spoofed install %s %v", storedInstall, err)
	}
	// No initial worker scan: registration itself must baseline zero exposure.
	pushCreditCurrency(t, f, rel, "debt", "4999.99", "USD")
	pushCreditCurrency(t, f, rel, "debt", "100000", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "debt", "0.01", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	scanCredit(t, f)
	creditJobs(t, f, 1)
	more, err := f.svc.deliverCreditPush(t.Context())
	if err != nil || !more {
		t.Fatalf("deliver %v %v", more, err)
	}
	var sent map[string]any
	select {
	case sent = <-payloads:
	case <-time.After(time.Second):
		t.Fatal("fake provider received no alert")
	}
	data, ok := sent["data"].(map[string]any)
	if !ok || len(data) != 2 || data["kind"] != "credit_alert" {
		t.Fatalf("sensitive/invalid provider payload: %+v", sent)
	}
	eventKey, ok := data["event_key"].(string)
	if !ok {
		t.Fatal("missing opaque key")
	}
	if _, err := uuid.Parse(eventKey); err != nil {
		t.Fatal(err)
	}
	all, _ := json.Marshal(sent)
	if strings.Contains(string(all), f.accountID) || strings.Contains(string(all), f.vaultID) || strings.Contains(string(all), rel) || strings.Contains(string(all), "Customer") {
		t.Fatalf("private routing/name escaped to provider: %s", all)
	}
	if sent["body"] != creditAlertPushBody("en") {
		t.Fatal("provider text must always be generic")
	}
	r := creditPushHTTP(t, f, "GET", "/v1/sync/credit-alerts/events/"+eventKey, f.deviceID, nil)
	var resolved map[string]any
	if r.Code != 200 || json.Unmarshal(r.Body.Bytes(), &resolved) != nil || resolved["relationship_id"] != rel || resolved["owner_scope"] != "account:"+f.accountID || resolved["event_key"] != eventKey {
		t.Fatalf("private event lookup %d %s", r.Code, r.Body.String())
	}
	if resolved["person_id"] == rel || resolved["person_id"] == "" {
		t.Fatal("routing must use actual person user_b_id")
	}
	otherInstall := uuid.NewString()
	seedCreditPushInstall(t, f, otherInstall)
	if r := creditPushHTTP(t, f, "GET", "/v1/sync/credit-alerts/events/"+eventKey, otherInstall, nil); r.Code != 404 {
		t.Fatalf("wrong install resolved event: %d", r.Code)
	}
	// A second OR alternative becoming true while the direction stays matched
	// must not ring again. The same durable event is retained through receipt.
	pushCreditCurrency(t, f, rel, "debt", "100000", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	var events int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM credit_alert_events`).Scan(&events); err != nil || events != 1 {
		t.Fatalf("OR spam: %d %v", events, err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE credit_push_outbox SET next_at=NOW()`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.deliverCreditPush(t.Context()); err != nil {
		t.Fatal(err)
	}
	creditJobs(t, f, 0)
	// Both alternatives must fall false before this direction rearms.
	pushCreditCurrency(t, f, rel, "payment", "100000.01", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "debt", "0.01", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	// Saving a lower semantic threshold baselines the already-high balance.
	saveCreditAlertBody(t, f, `{"relationship_id":"`+rel+`","groups":[{"direction":"collect","conditions":[{"currency":"USD","threshold_minor":100000}]}]}`)
	creditJobs(t, f, 0)
	scanCredit(t, f)
	creditJobs(t, f, 0)
	if r := creditPushHTTP(t, f, "GET", "/v1/sync/credit-alerts/events/"+eventKey, f.deviceID, nil); r.Code != 404 {
		t.Fatalf("old rule event resolved: %d", r.Code)
	}
	pushCreditCurrency(t, f, rel, "payment", "5000", "USD")
	scanCredit(t, f)
	pushCreditCurrency(t, f, rel, "debt", "1000", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 1)
}

func TestCreditPushMutedQuietCustomerAndDirectionLatches(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPushInstall(t, f, f.deviceID)
	fakeCreditProvider(t, f)
	// Registration before rule save: save itself must baseline before the next tally.
	if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	saveCreditAlertBody(t, f, `{"relationship_id":"`+rel+`","groups":[{"direction":"collect","conditions":[{"currency":"USD","threshold_minor":100}]},{"direction":"pay","conditions":[{"currency":"AFN","threshold_minor":200}]}]}`)
	pushCreditCurrency(t, f, rel, "debt", "1", "USD")
	pushCreditCurrency(t, f, rel, "payment", "2", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 2)
	prefs := defaultCreditNotificationPreferences()
	prefs.CreditAlerts = false
	if r := registerCreditPush(t, f, prefs, []creditCustomerPreferences{}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "payment", "1", "USD")
	scanCredit(t, f)
	pushCreditCurrency(t, f, rel, "debt", "1", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 0)
	prefs.CreditAlerts = true
	if r := registerCreditPush(t, f, prefs, []creditCustomerPreferences{}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	scanCredit(t, f)
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "payment", "1", "USD")
	scanCredit(t, f)
	pushCreditCurrency(t, f, rel, "debt", "1", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	// Customer-specific mute is applied while global remains enabled.
	muted := prefs
	muted.Enabled = false
	raw, _ := json.Marshal(muted)
	if r := registerCreditPush(t, f, prefs, []creditCustomerPreferences{{RelationshipID: rel, Preferences: raw}}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "payment", "1", "USD")
	scanCredit(t, f)
	pushCreditCurrency(t, f, rel, "debt", "1", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 0)
	// Quiet-hour crossings are consumed and never replayed on a preference change.
	minute := time.Now().UTC().Hour()*60 + time.Now().UTC().Minute()
	prefs.QuietHours.Enabled = true
	prefs.QuietHours.StartMinute = minute
	prefs.QuietHours.EndMinute = (minute + 1) % 1440
	if r := registerCreditPush(t, f, prefs, []creditCustomerPreferences{}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	pushCreditCurrency(t, f, rel, "payment", "1", "USD")
	scanCredit(t, f)
	pushCreditCurrency(t, f, rel, "debt", "1", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 0)
	prefs.QuietHours.Enabled = false
	if r := registerCreditPush(t, f, prefs, []creditCustomerPreferences{}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	scanCredit(t, f)
	creditJobs(t, f, 0)
}

func TestCreditPushPendingSharedExposureAndFinalAuthorityRechecks(t *testing.T) {
	for _, change := range []string{"pending-shared", "demoted", "revoked", "archived", "pending-delete", "credential-epoch", "install-account", "new-seat", "policy-changed", "repaid-before-send"} {
		t.Run(change, func(t *testing.T) {
			f := newM1Fixture(t)
			rel := seedCreditContact(t, f)
			seedCreditPushInstall(t, f, f.deviceID)
			payloads := fakeCreditProvider(t, f)
			saveCreditAlertBody(t, f, `{"relationship_id":"`+credit.DefaultRelationshipID+`","groups":[{"direction":"collect","conditions":[{"currency":"AFN","threshold_minor":100}]}]}`)
			if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != 200 {
				t.Fatal(r.Body.String())
			}
			if change == "pending-shared" {
				tabID := uuid.NewString()
				if _, err := f.pool.Exec(t.Context(), `INSERT INTO tabs(id,currency) VALUES($1::uuid,'AFN')`, tabID); err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(t.Context(), `INSERT INTO tab_parties(tab_id,role,token_hash,account_id,vault_id,relationship_id,joined_at,linked_at_ms,history_order) VALUES($1::uuid,'a',$2,$3::uuid,$4::uuid,$5::uuid,NOW(),0,nextval('tab_party_history_order_seq'))`, tabID, uuid.NewString(), f.accountID, f.vaultID, rel); err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(t.Context(), `INSERT INTO tab_parties(tab_id,role,token_hash,joined_at) VALUES($1::uuid,'b',$2,NOW())`, tabID, uuid.NewString()); err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(t.Context(), `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,occurred_at_ms,status) VALUES($1::uuid,$2::uuid,1,1,'a','a_to_b',100,1,'pending')`, uuid.NewString(), tabID); err != nil {
					t.Fatal(err)
				}
			} else {
				pushCreditCurrency(t, f, rel, "debt", "1", "AFN")
			}
			scanCredit(t, f)
			creditJobs(t, f, 1)
			var err error
			switch change {
			case "demoted":
				_, err = f.pool.Exec(t.Context(), `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid`, f.vaultID)
			case "revoked":
				_, err = f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid`, f.vaultID)
			case "archived":
				_, err = f.pool.Exec(t.Context(), `UPDATE vaults SET archived_at=NOW() WHERE vault_id=$1::uuid`, f.vaultID)
			case "pending-delete":
				_, err = f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.accountID)
			case "credential-epoch":
				_, err = f.pool.Exec(t.Context(), `UPDATE auth_credentials SET session_epoch=9 WHERE install_id=$1::uuid`, f.deviceID)
			case "install-account":
				_, err = f.pool.Exec(t.Context(), `UPDATE installs SET account_id=NULL WHERE install_id=$1::uuid`, f.deviceID)
			case "new-seat":
				if _, err = f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
					t.Fatal(err)
				}
				_, err = f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,invited_at,accepted_at,invited_by) VALUES($1::uuid,$2::uuid,'manager',NOW(),NOW(),$2::uuid)`, f.vaultID, f.accountID)
			case "policy-changed":
				_, err = f.pool.Exec(t.Context(), `UPDATE customer_credit_alerts SET groups='[]'::jsonb WHERE vault_id=$1::uuid`, f.vaultID)
			case "repaid-before-send":
				pushCreditCurrency(t, f, rel, "payment", "1", "AFN")
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.deliverCreditPush(t.Context()); err != nil {
				t.Fatal(err)
			}
			if change == "pending-shared" {
				select {
				case <-payloads:
				case <-time.After(time.Second):
					t.Fatal("pending shared claim did not trigger")
				}
			} else {
				creditJobs(t, f, 0)
				select {
				case sent := <-payloads:
					t.Fatalf("stale authority/config sent push: %+v", sent)
				default:
				}
			}
		})
	}
}

func TestCreditNotificationPreferencesTypedAndBackwardCompatible(t *testing.T) {
	p := defaultCreditNotificationPreferences()
	raw, _ := json.Marshal(p)
	without := strings.Replace(string(raw), `"credit_alerts":true,`, "", 1)
	if parsed, err := decodeCreditNotificationPreferences([]byte(without)); err != nil || !parsed.CreditAlerts {
		t.Fatalf("old preferences lose alerts: %+v %v", parsed, err)
	}
	for _, invalid := range []string{"null", "{}", string(raw) + "{}", strings.Replace(string(raw), `"enabled":true`, `"enabled":null`, 1), strings.Replace(string(raw), `"credit_alerts":true`, `"credit_alerts":null`, 1), strings.Replace(string(raw), `"time_zone":"UTC"`, `"time_zone":"Local"`, 1)} {
		if _, err := decodeCreditNotificationPreferences([]byte(invalid)); err == nil {
			t.Fatalf("invalid prefs accepted: %s", invalid)
		}
	}
	p.Enabled = false
	global, _ := json.Marshal(p)
	p.Enabled = true
	override, _ := json.Marshal(p)
	customers, _ := json.Marshal([]creditCustomerPreferences{{RelationshipID: "r", Preferences: override}})
	if effective, err := creditPreferencesFor(global, customers, "r"); err != nil || effective.Enabled {
		t.Fatalf("customer override bypassed master mute: %+v %v", effective, err)
	}
}

func TestCreditPushNetworkDoesNotHoldLedgerLocksAndLateAckIsFenced(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPushInstall(t, f, f.deviceID)
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"blocked-fake-ticket"}}`))
	}))
	t.Cleanup(provider.Close)
	f.svc.creditPush = &creditPushClient{client: provider.Client(), baseURL: provider.URL}
	saveCreditAlertBody(t, f, `{"relationship_id":"`+rel+`","groups":[{"direction":"collect","conditions":[{"currency":"AFN","threshold_minor":100}]}]}`)
	if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	pushCreditCurrency(t, f, rel, "debt", "1", "AFN")
	scanCredit(t, f)
	done := make(chan error, 1)
	go func() { _, err := f.svc.deliverCreditPush(t.Context()); done <- err }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("fake provider request did not start")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	tx, err := f.pool.Begin(ctx)
	if err == nil {
		var account string
		err = tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE id=$1::uuid FOR UPDATE`, f.accountID).Scan(&account)
		if err == nil {
			err = credit.Lock(ctx, tx, f.vaultID)
		}
		_ = tx.Rollback(context.Background())
	}
	if err != nil {
		close(release)
		t.Fatalf("provider latency held account/credit lock: %v", err)
	}
	if more, err := f.svc.deliverCreditPush(t.Context()); err != nil || more {
		close(release)
		t.Fatalf("another worker claimed in-flight job: %v %v", more, err)
	}
	newClaim := uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `UPDATE credit_push_outbox SET claim_token=$1::uuid`, newClaim); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var claim string
	var receipt *string
	if err := f.pool.QueryRow(t.Context(), `SELECT claim_token::text,receipt_id FROM credit_push_outbox`).Scan(&claim, &receipt); err != nil || claim != newClaim || receipt != nil || calls.Load() != 1 {
		t.Fatalf("late worker overwrote newer claim: %s %v calls=%d err=%v", claim, receipt, calls.Load(), err)
	}
}

func TestCreditPushRegistrationRequiresCurrentOwnerAdminAndSession(t *testing.T) {
	f := newM1Fixture(t)
	seedCreditContact(t, f)
	seedCreditPushInstall(t, f, f.deviceID)
	fakeCreditProvider(t, f)
	for _, role := range []string{"owner", "manager", "editor", "clerk", "viewer"} {
		if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role=$2 WHERE vault_id=$1::uuid`, f.vaultID, role); err != nil {
			t.Fatal(err)
		}
		want := 403
		if role == "owner" || role == "manager" {
			want = 200
		}
		if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != want {
			t.Fatalf("%s register %d %s", role, r.Code, r.Body.String())
		}
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='owner' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE auth_credentials SET session_epoch=9 WHERE install_id=$1::uuid`, f.deviceID); err != nil {
		t.Fatal(err)
	}
	if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != 401 {
		t.Fatalf("stale session registered: %d %s", r.Code, r.Body.String())
	}
}

func TestCreditPushNoPoliciesAvoidsFinancialProjectionAndCleansLastRule(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPushInstall(t, f, f.deviceID)
	fakeCreditProvider(t, f)
	saveCreditAlertBody(t, f, `{"relationship_id":"`+credit.DefaultRelationshipID+`","groups":[{"direction":"collect","conditions":[{"currency":"AFN","threshold_minor":100}]}]}`)
	if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	pushCreditCurrency(t, f, rel, "debt", "1", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	saveCreditAlertBody(t, f, `{"relationship_id":"`+credit.DefaultRelationshipID+`","groups":[]}`)
	creditJobs(t, f, 0)
	// Temporarily hide financial history in this isolated fixture. The empty
	// rule observer must not need a financial projection at all.
	if _, err := f.pool.Exec(t.Context(), `ALTER TABLE events RENAME TO credit_test_hidden_events`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `ALTER TABLE IF EXISTS credit_test_hidden_events RENAME TO events`)
	})
	if _, err := LoadVaultProjection(t.Context(), f.pool, f.vaultID); err == nil {
		t.Fatal("fixture should have an unreadable projection")
	}
	if err := f.svc.scanCreditAlertVault(t.Context(), f.vaultID); err != nil {
		t.Fatalf("no-policy book replayed financial projection: %v", err)
	}
	if _, err := f.pool.Exec(t.Context(), `ALTER TABLE credit_test_hidden_events RENAME TO events`); err != nil {
		t.Fatal(err)
	}
	if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != 200 {
		t.Fatalf("empty policy registration replayed projection: %d %s", r.Code, r.Body.String())
	}
	if r := creditPushHTTP(t, f, "POST", "/v1/sync/credit-alerts/notifications?vault_id="+f.vaultID, f.deviceID, map[string]any{"token": ""}); r.Code != 200 || !strings.Contains(r.Body.String(), `"remote_delivery_enabled":false`) || !strings.Contains(r.Body.String(), `"remote_delivery_lease_ms":0`) {
		t.Fatalf("unregister lease %d %s", r.Code, r.Body.String())
	}
}
