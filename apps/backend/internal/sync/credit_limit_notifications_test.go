package sync

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
)

func limitNotificationRequest(t *testing.T, f *m1Fixture, method, rel, body string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/v1/sync/credit-limit-notifications?vault_id="+f.vaultID+"&relationship_id="+rel, strings.NewReader(body))
	req.Header.Set("X-Kaata-Currencies", "1")
	if authenticated {
		token, err := auth.SignSession(testJWTSecret, f.accountID, uuid.NewString(), "google", "limit-notifications-test")
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditLimitNotifications)).ServeHTTP(rec, req)
	return rec
}
func saveLimitNotification(t *testing.T, f *m1Fixture, rel string, enabled bool) *httptest.ResponseRecorder {
	t.Helper()
	r := limitNotificationRequest(t, f, "PUT", "", fmt.Sprintf(`{"relationship_id":%q,"enabled":%t}`, rel, enabled), true)
	if r.Code != 200 {
		t.Fatalf("limit notification save %d %s", r.Code, r.Body.String())
	}
	return r
}
func registerOrdinaryLimitPush(t *testing.T, f *m1Fixture) *httptest.ResponseRecorder {
	t.Helper()
	r := creditPushHTTP(t, f, "POST", "/v1/sync/credit-alerts/notifications?vault_id="+f.vaultID, f.deviceID, map[string]any{"token": "ExpoPushToken[synthetic_credit_token]", "locale": "en", "preferences": defaultCreditNotificationPreferences(), "customer_preferences": []creditCustomerPreferences{}, "limit_alerts": true})
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"limit_notifications_enabled":true`) || r.Header().Get("X-Kaata-Credit-Limit-Notifications") != "1" {
		t.Fatalf("ordinary registration %d %s", r.Code, r.Body.String())
	}
	return r
}
func seedOrdinaryCap(t *testing.T, f *m1Fixture, rel, currency string, collect, pay any) {
	t.Helper()
	_, err := f.pool.Exec(t.Context(), `INSERT INTO customer_credit_limits(vault_id,relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms) VALUES($1::uuid,$2::uuid,$3,$4,$5,'warn',1) ON CONFLICT(vault_id,relationship_id,currency) DO UPDATE SET max_collect_minor=EXCLUDED.max_collect_minor,max_pay_minor=EXCLUDED.max_pay_minor`, f.vaultID, rel, currency, collect, pay)
	if err != nil {
		t.Fatal(err)
	}
}

func TestCreditLimitNotificationAuthorityInheritanceAndSnapshot(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	if r := limitNotificationRequest(t, f, "GET", "", "", true); r.Code != 200 || strings.TrimSpace(r.Body.String()) != "[]" || r.Header().Get("X-Kaata-Credit-Limit-Notifications") != "1" {
		t.Fatalf("empty capability response %d %s", r.Code, r.Body.String())
	}
	if r := limitNotificationRequest(t, f, "GET", "", "", false); r.Code != 401 {
		t.Fatalf("anonymous %d", r.Code)
	}
	for _, role := range []string{"owner", "manager", "editor", "clerk", "viewer"} {
		if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role=$1 WHERE vault_id=$2::uuid`, role, f.vaultID); err != nil {
			t.Fatal(err)
		}
		r := limitNotificationRequest(t, f, "PUT", "", fmt.Sprintf(`{"relationship_id":%q,"enabled":true}`, rel), true)
		want := 403
		if role == "owner" || role == "manager" {
			want = 200
		}
		if r.Code != want {
			t.Fatalf("%s save %d %s", role, r.Code, r.Body.String())
		}
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='owner' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{}`, fmt.Sprintf(`{"relationship_id":%q,"enabled":null}`, rel), fmt.Sprintf(`{"relationship_id":%q,"enabled":true,"extra":1}`, rel), fmt.Sprintf(`{"relationship_id":%q,"enabled":true}{}`, rel)} {
		if r := limitNotificationRequest(t, f, "PUT", "", body, true); r.Code != 400 {
			t.Fatalf("invalid accepted %s %d", body, r.Code)
		}
	}
	saveLimitNotification(t, f, credit.DefaultRelationshipID, true)
	saved := saveLimitNotification(t, f, rel, false)
	effective, err := credit.EffectiveLimitNotification(t.Context(), f.pool, f.vaultID, rel)
	if err != nil || effective == nil || effective.Enabled {
		t.Fatalf("explicit off %+v %v", effective, err)
	}
	other := seedCreditContact(t, f)
	effective, err = credit.EffectiveLimitNotification(t.Context(), f.pool, f.vaultID, other)
	if err != nil || effective == nil || !effective.Enabled || effective.RelationshipID != credit.DefaultRelationshipID {
		t.Fatalf("default not inherited %+v %v", effective, err)
	}
	empty, err := ProjectionToJSON(NewProjection())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_snapshots(vault_id,up_to_server_seq,snapshot,schema_version,byte_size) VALUES($1::uuid,0,$2::jsonb,$3,$4)`, f.vaultID, empty, SnapshotSchemaVersion, len(empty)); err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.svc.LatestSnapshot(t.Context(), f.vaultID)
	if err != nil || len(snapshot.CreditLimitNotifications) != 2 {
		t.Fatalf("snapshot flags missing %+v %v", snapshot, err)
	}
	before, err := strconv.ParseInt(saved.Header().Get("X-Kaata-Credit-Updated-At"), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	deleted := limitNotificationRequest(t, f, "DELETE", rel, "", true)
	after, err := strconv.ParseInt(deleted.Header().Get("X-Kaata-Credit-Updated-At"), 10, 64)
	if deleted.Code != 204 || err != nil || after <= before {
		t.Fatalf("nonmonotonic delete %d %s %v", deleted.Code, deleted.Header().Get("X-Kaata-Credit-Updated-At"), err)
	}
	effective, err = credit.EffectiveLimitNotification(t.Context(), f.pool, f.vaultID, rel)
	if err != nil || effective == nil || !effective.Enabled {
		t.Fatalf("reset did not inherit %+v %v", effective, err)
	}
}

func TestCreditLimitNotificationIndependentCurrencyDirectionsAndOpaqueEvent(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPushInstall(t, f, f.deviceID)
	fakeCreditProvider(t, f)
	seedOrdinaryCap(t, f, rel, "USD", 10000, 20000)
	seedOrdinaryCap(t, f, rel, "AFN", 20000, 30000)
	saveLimitNotification(t, f, rel, true)
	registerOrdinaryLimitPush(t, f)
	pushCreditCurrency(t, f, rel, "debt", "100", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	pushCreditCurrency(t, f, rel, "debt", "200", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 2)
	scanCredit(t, f)
	creditJobs(t, f, 2)
	pushCreditCurrency(t, f, rel, "payment", "100", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	pushCreditCurrency(t, f, rel, "debt", "100", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 2)
	pushCreditCurrency(t, f, rel, "payment", "300", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 2)
	var key string
	if err := f.pool.QueryRow(t.Context(), `SELECT event_key::text FROM credit_push_outbox WHERE watch_key='limit:USD' AND direction='pay'`).Scan(&key); err != nil {
		t.Fatal(err)
	}
	r := creditPushHTTP(t, f, "GET", "/v1/sync/credit-alerts/events/"+key, f.deviceID, nil)
	var event map[string]any
	if r.Code != 200 || json.Unmarshal(r.Body.Bytes(), &event) != nil || event["limit_currency"] != "USD" || event["relationship_id"] != rel {
		t.Fatalf("scoped event %d %s", r.Code, r.Body.String())
	}
	saveLimitNotification(t, f, rel, false)
	creditJobs(t, f, 0)
	if r := creditPushHTTP(t, f, "GET", "/v1/sync/credit-alerts/events/"+key, f.deviceID, nil); r.Code != 404 {
		t.Fatalf("disabled event still usable %d", r.Code)
	}
}

func TestCreditLimitNotificationInitialBaselineZeroCapAndLegacySubscription(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPushInstall(t, f, f.deviceID)
	fakeCreditProvider(t, f)
	seedOrdinaryCap(t, f, rel, "AFN", 0, nil)
	pushCreditCurrency(t, f, rel, "debt", "10", "AFN")
	saveLimitNotification(t, f, rel, true)
	if r := registerCreditPush(t, f, defaultCreditNotificationPreferences(), []creditCustomerPreferences{}); r.Code != 200 || !strings.Contains(r.Body.String(), `"limit_notifications_enabled":false`) {
		t.Fatalf("legacy registration %d %s", r.Code, r.Body.String())
	}
	scanCredit(t, f)
	creditJobs(t, f, 0)
	registerOrdinaryLimitPush(t, f)
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "payment", "10", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "debt", "0.01", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	saveLimitNotification(t, f, rel, false)
	creditJobs(t, f, 0)
	saveLimitNotification(t, f, rel, true)
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "payment", "0.01", "AFN")
	scanCredit(t, f)
	pushCreditCurrency(t, f, rel, "debt", "0.01", "AFN")
	scanCredit(t, f)
	creditJobs(t, f, 1)
}

func TestCreditLimitNotificationCapEditsRebaselineAndCancelStaleDelivery(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPushInstall(t, f, f.deviceID)
	fakeCreditProvider(t, f)
	seedOrdinaryCap(t, f, rel, "USD", 10000, nil)
	saveLimitNotification(t, f, rel, true)
	registerOrdinaryLimitPush(t, f)
	pushCreditCurrency(t, f, rel, "debt", "100", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 1)
	var oldKey string
	if err := f.pool.QueryRow(t.Context(), `SELECT event_key::text FROM credit_push_outbox`).Scan(&oldKey); err != nil {
		t.Fatal(err)
	}
	saveCap := func(cap int64) {
		body := fmt.Sprintf(`{"relationship_id":%q,"currency":"USD","max_collect_minor":%d,"max_pay_minor":null,"mode":"warn","updated_at_ms":0}`, rel, cap)
		req := httptest.NewRequest("PUT", "/v1/sync/credit-limits?vault_id="+f.vaultID, strings.NewReader(body))
		req.Header.Set("X-Kaata-Currencies", "1")
		token, err := auth.SignSession(testJWTSecret, f.accountID, f.deviceID, "google", "credit-cap-test")
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditLimits)).ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("cap edit %d %s", rec.Code, rec.Body.String())
		}
	}
	saveCap(9000)
	creditJobs(t, f, 0)
	if r := creditPushHTTP(t, f, "GET", "/v1/sync/credit-alerts/events/"+oldKey, f.deviceID, nil); r.Code != 404 {
		t.Fatalf("old cap event remained valid %d", r.Code)
	}
	scanCredit(t, f)
	creditJobs(t, f, 0)
	saveCap(20000)
	creditJobs(t, f, 0)
	pushCreditCurrency(t, f, rel, "debt", "100", "USD")
	scanCredit(t, f)
	creditJobs(t, f, 1)
}
