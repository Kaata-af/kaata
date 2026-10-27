package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/httpx"
)

func TestCurrencyBaselineMismatchBlocksReadsAndWritesBeforeMutation(t *testing.T) {
	f := newM1Fixture(t)
	h := NewHandler(f.svc)
	rel := seedCreditContact(t, f)
	entry := creditEntry(f, rel, "debt", "20")
	body, err := json.Marshal(pushRequest{VaultID: f.vaultID, DeviceID: f.deviceID, Events: []PushEvent{entry}})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, local, account string, aware bool) *httptest.ResponseRecorder {
		t.Helper()
		token, err := auth.SignSession(testJWTSecret, account, f.deviceID, "google", "currency-test")
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		if aware {
			req.Header.Set("X-Kaata-Currencies", "1")
		}
		if local != "" {
			req.Header.Set("X-Kaata-Legacy-Currency", local)
		}
		handler := http.HandlerFunc(h.Pull)
		if method == http.MethodPost {
			handler = h.Push
		} else if strings.Contains(path, "snapshot") {
			handler = h.Snapshot
		}
		out := httptest.NewRecorder()
		auth.RequireSession(testJWTSecret)(handler).ServeHTTP(out, req)
		return out
	}
	count := func() int {
		t.Helper()
		var n int
		if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM events WHERE vault_id=$1::uuid`, f.vaultID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := count()
	for _, path := range []string{"/v1/sync/pull?vault_id=" + f.vaultID, "/v1/sync/snapshot?vault_id=" + f.vaultID} {
		out := request(http.MethodGet, path, "USD", f.accountID, true)
		if out.Code != http.StatusConflict || !strings.Contains(out.Body.String(), "legacy_currency_mismatch") {
			t.Fatalf("mismatch read: %d %s", out.Code, out.Body.String())
		}
	}
	badWrite := request(http.MethodPost, "/v1/sync/push", "USD", f.accountID, true)
	if badWrite.Code != http.StatusConflict || count() != before {
		t.Fatalf("mismatch write changed records: %d %s", badWrite.Code, badWrite.Body.String())
	}
	goodWrite := request(http.MethodPost, "/v1/sync/push", "AFN", f.accountID, true)
	if goodWrite.Code != http.StatusOK || count() != before+1 {
		t.Fatalf("matching write: %d %s", goodWrite.Code, goodWrite.Body.String())
	}
	goodRead := request(http.MethodGet, "/v1/sync/pull?vault_id="+f.vaultID, "AFN", f.accountID, true)
	if goodRead.Code != http.StatusOK {
		t.Fatalf("matching read: %d %s", goodRead.Code, goodRead.Body.String())
	}
	foreign := creditEntry(f, rel, "debt", "5")
	var payload map[string]any
	if err := json.Unmarshal(foreign.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	payload["currency"] = "USD"
	foreign.Payload, _ = json.Marshal(payload)
	f.push(t, foreign)
	old := request(http.MethodGet, "/v1/sync/pull?vault_id="+f.vaultID, "", f.accountID, false)
	if old.Code != http.StatusUpgradeRequired {
		t.Fatalf("old reader combined currencies: %d %s", old.Code, old.Body.String())
	}
	outsider := request(http.MethodGet, "/v1/sync/pull?vault_id="+f.vaultID, "USD", uuid.NewString(), true)
	if outsider.Code != http.StatusForbidden || strings.Contains(outsider.Body.String(), "legacy_currency") {
		t.Fatalf("currency guard disclosed outsider state: %d %s", outsider.Code, outsider.Body.String())
	}
}

func TestCurrencyUpgradeGuardIncludesSettlementsAndPolicies(t *testing.T) {
	for _, source := range []string{"settlement", "customer policy", "default policy"} {
		t.Run(source, func(t *testing.T) {
			f := newM1Fixture(t)
			h := NewHandler(f.svc)
			rel := seedCreditContact(t, f)
			if source == "settlement" {
				e := f.event(nil)
				e.EventType = EventEntrySettled
				e.TargetID = &rel
				e.RelationshipID = &rel
				e.Payload = json.RawMessage(`{"settled_at_ms":1000,"currency":"USD"}`)
				f.push(t, e)
			} else {
				if source == "default policy" {
					rel = credit.DefaultRelationshipID
				}
				if _, err := f.pool.Exec(context.Background(), `INSERT INTO customer_credit_limits(vault_id,relationship_id,currency,mode,updated_at_ms) VALUES($1::uuid,$2::uuid,'USD','warn',1)`, f.vaultID, rel); err != nil {
					t.Fatal(err)
				}
			}
			out := httptest.NewRecorder()
			if h.allowCurrencyClient(out, httptest.NewRequest(http.MethodGet, "/v1/sync/pull", nil), f.vaultID, f.accountID) || out.Code != http.StatusUpgradeRequired {
				t.Fatalf("old client ignored foreign %s: %d", source, out.Code)
			}
			token, err := auth.SignSession(testJWTSecret, f.accountID, f.deviceID, "google", "currency-policy-test")
			if err != nil {
				t.Fatal(err)
			}
			for _, method := range []string{http.MethodGet, http.MethodPut} {
				req := httptest.NewRequest(method, "/v1/sync/credit-limits?vault_id="+f.vaultID, nil)
				req.Header.Set("Authorization", "Bearer "+token)
				res := httptest.NewRecorder()
				auth.RequireSession(testJWTSecret)(http.HandlerFunc(h.CreditLimits)).ServeHTTP(res, req)
				if res.Code != http.StatusUpgradeRequired {
					t.Fatalf("old credit %s %s: %d %s", method, source, res.Code, res.Body.String())
				}
			}
		})
	}
}

func TestCurrencyHeadersAllowedByCORS(t *testing.T) {
	out := httptest.NewRecorder()
	httpx.CORS(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("preflight reached handler") })).ServeHTTP(out, httptest.NewRequest(http.MethodOptions, "/v1/sync/pull", nil))
	for _, header := range []string{"X-Kaata-Currencies", "X-Kaata-Legacy-Currency"} {
		if !strings.Contains(out.Header().Get("Access-Control-Allow-Headers"), header) {
			t.Fatalf("CORS rejected %s", header)
		}
	}
}

func TestOldCurrencySettingRequiresUpgradeBeforeAnyBatchMutation(t *testing.T) {
	f := newM1Fixture(t)
	h := NewHandler(f.svc)
	rel := seedCreditContact(t, f)
	entry := creditEntry(f, rel, "debt", "20")
	setting := f.event(nil)
	setting.EventType = EventVaultSettingSet
	setting.TargetID = &f.vaultID
	setting.Payload = json.RawMessage(`{"key":"currency","value":"USD"}`)
	body, err := json.Marshal(pushRequest{VaultID: f.vaultID, DeviceID: f.deviceID, Events: []PushEvent{entry, setting}})
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.SignSession(testJWTSecret, f.accountID, f.deviceID, "google", "currency-test")
	if err != nil {
		t.Fatal(err)
	}
	request := func(aware bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/v1/sync/push", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		if aware {
			req.Header.Set("X-Kaata-Currencies", "1")
			req.Header.Set("X-Kaata-Legacy-Currency", "AFN")
		}
		out := httptest.NewRecorder()
		auth.RequireSession(testJWTSecret)(http.HandlerFunc(h.Push)).ServeHTTP(out, req)
		return out
	}
	var before int
	if err = f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vaultID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	old := request(false)
	if old.Code != http.StatusUpgradeRequired {
		t.Fatalf("old relabel accepted: %d %s", old.Code, old.Body.String())
	}
	var after int
	var base, legacy string
	if err = f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vaultID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if err = f.pool.QueryRow(t.Context(), `SELECT currency,legacy_currency FROM vaults WHERE vault_id=$1::uuid`, f.vaultID).Scan(&base, &legacy); err != nil {
		t.Fatal(err)
	}
	if after != before || base != "AFN" || legacy != "AFN" {
		t.Fatalf("rejected batch mutated state: %d %d %s %s", before, after, base, legacy)
	}
	modern := request(true)
	if modern.Code != http.StatusOK {
		t.Fatalf("aware historical setting rejected: %d %s", modern.Code, modern.Body.String())
	}
	if err = f.pool.QueryRow(t.Context(), `SELECT currency,legacy_currency FROM vaults WHERE vault_id=$1::uuid`, f.vaultID).Scan(&base, &legacy); err != nil {
		t.Fatal(err)
	}
	if base != "USD" || legacy != "AFN" {
		t.Fatalf("historical replay retagged legacy: %s %s", base, legacy)
	}
	read := httptest.NewRecorder()
	if h.allowCurrencyClient(read, httptest.NewRequest(http.MethodGet, "/v1/sync/pull", nil), f.vaultID, f.accountID) || read.Code != http.StatusUpgradeRequired {
		t.Fatalf("old labels would contradict frozen legacy: %d", read.Code)
	}
	aware := httptest.NewRequest(http.MethodGet, "/v1/sync/pull", nil)
	aware.Header.Set("X-Kaata-Currencies", "1")
	aware.Header.Set("X-Kaata-Legacy-Currency", "AFN")
	if !h.allowCurrencyClient(httptest.NewRecorder(), aware, f.vaultID, f.accountID) {
		t.Fatal("aware matching reader rejected after historical setting")
	}
}

func TestCurrencyUpgradeGuardOnlyAfterForeignRecords(t *testing.T) {
	f := newM1Fixture(t)
	h := NewHandler(f.svc)
	request := httptest.NewRequest("GET", "/v1/sync/pull", nil)
	if !h.allowCurrencyClient(httptest.NewRecorder(), request, f.vaultID, f.accountID) {
		t.Fatal("legacy-only books remain compatible")
	}
	rel := seedCreditContact(t, f)
	entry := creditEntry(f, rel, "debt", "20")
	var payload map[string]any
	if err := json.Unmarshal(entry.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	payload["currency"] = "USD"
	entry.Payload, _ = json.Marshal(payload)
	if result := f.push(t, entry); len(result.Accepted) != 1 {
		t.Fatalf("foreign record: %+v", result)
	}
	old := httptest.NewRecorder()
	if h.allowCurrencyClient(old, request, f.vaultID, f.accountID) || old.Code != 426 {
		t.Fatalf("old client must upgrade before reading mixed money: %d", old.Code)
	}
	request.Header.Set("X-Kaata-Currencies", "1")
	if !h.allowCurrencyClient(httptest.NewRecorder(), request, f.vaultID, f.accountID) {
		t.Fatal("currency-aware client should read its book")
	}
}

func TestCurrencyPayloadImmutableAndISO(t *testing.T) {
	for _, item := range []struct {
		kind, body string
		valid      bool
	}{
		{EventEntryCreated, `{"amount_afn":5}`, true},
		{EventEntryCreated, `{"currency":"AFN"}`, true},
		{EventEntryCreated, `{"currency":"USD"}`, true},
		{EventEntryCreated, `{"currency":null}`, false},
		{EventEntryCreated, `{"currency":"usd"}`, false},
		{EventEntryCreated, `{"currency":"A' OR 1=1"}`, false},
		{EventEntryAmended, `{"changes":{"note":"new note"}}`, true},
		{EventEntryAmended, `{"changes":{"currency":"USD"}}`, false},
		{EventEntryAmended, `{"changes":{"currency":null}}`, false},
		{EventEntrySettled, `{"currency":"USD"}`, true},
		{EventVaultSettingSet, `{"key":"enabled_currencies","value":"[\"AFN\",\"USD\"]"}`, true},
		{EventVaultSettingSet, `{"key":"enabled_currencies","value":"[]"}`, false},
		{EventVaultSettingSet, `{"key":"enabled_currencies","value":"[\"AFN\",\"AFN\"]"}`, false},
		{EventVaultSettingSet, `{"key":"enabled_currencies","value":"[\"usd\"]"}`, false},
		{EventVaultSettingSet, `{"key":"enabled_currencies","value":"null"}`, false},
		{EventVaultSettingSet, `{"key":"enabled_currencies","value":["AFN"]}`, false},
	} {
		err := validateCurrencyPayload(PushEvent{EventType: item.kind, Payload: json.RawMessage(item.body)})
		if (err == nil) != item.valid {
			t.Fatalf("%s %s: %v", item.kind, item.body, err)
		}
	}
}

func TestCurrencyCapabilities(t *testing.T) {
	w := httptest.NewRecorder()
	NewHandler(nil).CurrencyCapabilities(w, httptest.NewRequest("GET", "/v1/sync/capabilities", nil))
	var capabilities map[string]bool
	if err := json.Unmarshal(w.Body.Bytes(), &capabilities); err != nil || !capabilities["multi_currency"] || !capabilities["person_default_currency"] {
		t.Fatalf("capabilities: %s, %v", w.Body.String(), err)
	}
}
