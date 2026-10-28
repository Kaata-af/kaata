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
	for _, header := range []string{"X-Kaata-Currencies", "X-Kaata-Legacy-Currency", "X-Kaata-Entry-Currency-Edit"} {
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

func TestCurrencyPayloadPairsAmountAndISOUnit(t *testing.T) {
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
		{EventEntryAmended, `{"changes":{"amount_afn":"12.34"}}`, true},
		{EventEntryAmended, `{"changes":{"currency":"USD"}}`, false},
		{EventEntryAmended, `{"changes":{"currency":"USD","amount_afn":12.34}}`, true},
		{EventEntryAmended, `{"changes":{"currency":"USD","amount_afn":"12.34"}}`, false},
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
	if err := json.Unmarshal(w.Body.Bytes(), &capabilities); err != nil || !capabilities["multi_currency"] || !capabilities["person_default_currency"] || !capabilities["entry_currency_edit"] || !capabilities["notification_only_tallies"] || !capabilities["one_way_tallies"] || !capabilities["notification_preferences"] {
		t.Fatalf("capabilities: %s, %v", w.Body.String(), err)
	}
}

func TestEntryCurrencyUpgradeGuardIsBookScopedAndPreventsMutation(t *testing.T) {
	f := newM1Fixture(t)
	h := NewHandler(f.svc)
	rel := seedCreditContact(t, f)
	entry := creditEntry(f, rel, "debt", "100")
	requireAccepted(t, f.push(t, entry), 1)
	edit := creditMutation(f, entry, EventEntryAmended, `{"changes":{"currency":"USD","amount_afn":12.34}}`, entry.HLC.PhysicalMS+1)
	other := uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vaults(vault_id,owner_account_id,name,currency) VALUES($1::uuid,$2::uuid,'Unaffected','AFN')`, other, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,invited_at,accepted_at,invited_by) VALUES($1::uuid,$2::uuid,'owner',NOW(),NOW(),$2::uuid)`, other, f.accountID); err != nil {
		t.Fatal(err)
	}
	token, err := auth.SignSession(testJWTSecret, f.accountID, f.deviceID, "google", "entry-currency-edit")
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path string, events []PushEvent, editAware bool) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(pushRequest{VaultID: f.vaultID, DeviceID: f.deviceID, Events: events})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Kaata-Currencies", "1")
		req.Header.Set("X-Kaata-Legacy-Currency", "AFN")
		if editAware {
			req.Header.Set("X-Kaata-Entry-Currency-Edit", "1")
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
		if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vaultID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := count()
	// An old relay cannot introduce the first unsupported correction, nor
	// partially push otherwise valid events preceding it in the same batch.
	queued := creditEntry(f, rel, "debt", "1")
	if out := request(http.MethodPost, "/v1/sync/push", []PushEvent{queued, edit}, false); out.Code != http.StatusUpgradeRequired || count() != before {
		t.Fatalf("first unsupported correction mutated book: %d %s", out.Code, out.Body.String())
	}
	if out := request(http.MethodGet, "/v1/sync/pull?vault_id="+f.vaultID, nil, false); out.Code != http.StatusOK {
		t.Fatalf("uncorrected book changed compatibility: %d %s", out.Code, out.Body.String())
	}
	if out := request(http.MethodPost, "/v1/sync/push", []PushEvent{edit}, true); out.Code != http.StatusOK || count() != before+1 {
		t.Fatalf("supported correction failed: %d %s", out.Code, out.Body.String())
	}
	for _, path := range []string{"/v1/sync/pull?vault_id=" + f.vaultID, "/v1/sync/snapshot?vault_id=" + f.vaultID} {
		if out := request(http.MethodGet, path, nil, false); out.Code != http.StatusUpgradeRequired {
			t.Fatalf("old corrected reader %s: %d %s", path, out.Code, out.Body.String())
		}
	}
	if out := request(http.MethodPost, "/v1/sync/push", []PushEvent{queued}, false); out.Code != http.StatusUpgradeRequired || count() != before+1 {
		t.Fatalf("old corrected writer mutated book: %d %s", out.Code, out.Body.String())
	}
	if out := request(http.MethodGet, "/v1/sync/pull?vault_id="+other, nil, false); out.Code != http.StatusOK {
		t.Fatalf("another book was gated: %d %s", out.Code, out.Body.String())
	}
	if out := request(http.MethodGet, "/v1/sync/pull?vault_id="+f.vaultID, nil, true); out.Code != http.StatusOK {
		t.Fatalf("supported reader gated: %d %s", out.Code, out.Body.String())
	}
	if out := request(http.MethodPost, "/v1/sync/push", []PushEvent{queued}, true); out.Code != http.StatusOK || count() != before+2 {
		t.Fatalf("supported writer gated: %d %s", out.Code, out.Body.String())
	}
}

func TestEntryCurrencyResponseGuardRejectsCorrectionAfterPrecheck(t *testing.T) {
	f := newM1Fixture(t)
	h := NewHandler(f.svc)
	rel := seedCreditContact(t, f)
	create := creditEntry(f, rel, "debt", "100")
	requireAccepted(t, f.push(t, create), 1)
	saveCurrencyEditSnapshot(t, f, true)
	old := httptest.NewRequest(http.MethodGet, "/v1/sync/pull", nil)
	old.Header.Set("X-Kaata-Currencies", "1")
	old.Header.Set("X-Kaata-Legacy-Currency", "AFN")
	if !h.allowCurrencyClient(httptest.NewRecorder(), old, f.vaultID, f.accountID) {
		t.Fatal("initial compatibility check failed")
	}
	// Model the exact race: the initial check completed before the first
	// correction committed; data reads happen after that commit.
	edit := creditMutation(f, create, EventEntryAmended, `{"changes":{"currency":"USD","amount_afn":12.34}}`, create.HLC.PhysicalMS+1)
	requireAccepted(t, f.push(t, edit), 1)
	pull, err := f.svc.PullEvents(t.Context(), PullInput{AccountID: f.accountID, VaultID: f.vaultID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	out := httptest.NewRecorder()
	if allowEntryCurrencyEvents(out, old, pull.Events) || out.Code != http.StatusUpgradeRequired {
		t.Fatalf("in-flight pull disclosed correction: %d", out.Code)
	}
	snapshot, err := f.svc.LatestSnapshot(t.Context(), f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	out = httptest.NewRecorder()
	if allowEntryCurrencySnapshot(out, old, snapshot) || out.Code != http.StatusUpgradeRequired {
		t.Fatalf("snapshot tail disclosed correction: %d", out.Code)
	}
	// A newer snapshot can instead contain the correction in its seed rows.
	saveCurrencyEditSnapshot(t, f, false)
	snapshot, err = f.svc.LatestSnapshot(t.Context(), f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Events) != 0 || len(snapshot.Entries) != 1 || snapshot.Entries[0].OriginalCurrency != "AFN" {
		t.Fatal("test requires a corrected seed without a tail")
	}
	out = httptest.NewRecorder()
	if allowEntryCurrencySnapshot(out, old, snapshot) || out.Code != http.StatusUpgradeRequired {
		t.Fatalf("snapshot seed disclosed correction: %d", out.Code)
	}
	modern := old.Clone(old.Context())
	modern.Header.Set("X-Kaata-Entry-Currency-Edit", "1")
	if !allowEntryCurrencyEvents(httptest.NewRecorder(), modern, pull.Events) || !allowEntryCurrencySnapshot(httptest.NewRecorder(), modern, snapshot) {
		t.Fatal("supported in-flight reader rejected")
	}
}

func TestEntryCurrencyBaselinesAreOptInAuthorizedAndBookScoped(t *testing.T) {
	f := newM1Fixture(t)
	h := NewHandler(f.svc)
	rel := seedCreditContact(t, f)
	create := creditEntry(f, rel, "debt", "100")
	base := create.HLC.PhysicalMS
	note := creditMutation(f, create, EventEntryAmended, `{"changes":{"note":"independent later note"}}`, base+20)
	requireAccepted(t, f.push(t, create, note), 2)
	correction := creditMutation(f, create, EventEntryAmended, `{"changes":{"currency":"USD","amount_afn":12.34}}`, base+10)
	requireAccepted(t, f.push(t, correction), 1)
	deleted := creditEntry(f, rel, "debt", "200")
	deleted.HLC.PhysicalMS = base + 1
	remove := creditMutation(f, deleted, EventEntryDeleted, `{}`, base+11)
	requireAccepted(t, f.push(t, deleted, remove), 2)
	// Legacy currency-absent amendments deliberately retain their historical
	// validation. An unrelated unrepresentable row must not poison recovery
	// for a valid corrected tally, nor have its original data rewritten.
	legacy := make([]PushEvent, 0)
	for i, amount := range []string{"12.345", "-1", "90071992547409.92", "90071992547409.91", `"12.345"`} {
		created := creditEntry(f, rel, "debt", "10")
		created.HLC.PhysicalMS = base + int64(30+i*2)
		amend := creditMutation(f, created, EventEntryAmended, `{"changes":{"amount_afn":`+amount+`}}`, created.HLC.PhysicalMS+1)
		requireAccepted(t, f.push(t, created, amend), 2)
		legacy = append(legacy, created, amend)
	}
	beforeProjection, err := LoadVaultProjection(t.Context(), f.pool, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	beforeJSON, err := ProjectionToJSON(*beforeProjection)
	if err != nil {
		t.Fatal(err)
	}
	other := uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vaults(vault_id,owner_account_id,name,currency) VALUES($1::uuid,$2::uuid,'Other book','AFN')`, other, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,invited_at,accepted_at,invited_by) VALUES($1::uuid,$2::uuid,'owner',NOW(),NOW(),$2::uuid)`, other, f.accountID); err != nil {
		t.Fatal(err)
	}
	request := func(vault, account string, recovery, aware bool) *httptest.ResponseRecorder {
		t.Helper()
		token, err := auth.SignSession(testJWTSecret, account, f.deviceID, "google", "currency-baselines")
		if err != nil {
			t.Fatal(err)
		}
		path := "/v1/sync/pull?vault_id=" + vault + "&limit=100"
		if recovery {
			path += "&entry_currency_baselines=1"
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Kaata-Currencies", "1")
		req.Header.Set("X-Kaata-Legacy-Currency", "AFN")
		if aware {
			req.Header.Set("X-Kaata-Entry-Currency-Edit", "1")
		}
		out := httptest.NewRecorder()
		auth.RequireSession(testJWTSecret)(http.HandlerFunc(h.Pull)).ServeHTTP(out, req)
		return out
	}
	read := func(out *httptest.ResponseRecorder) []EntryCurrencyBaseline {
		t.Helper()
		if out.Code != http.StatusOK {
			t.Fatalf("pull %d: %s", out.Code, out.Body.String())
		}
		var body struct {
			Baselines *[]EntryCurrencyBaseline `json:"entry_currency_baselines"`
		}
		if err := json.Unmarshal(out.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Baselines == nil {
			t.Fatal("requested recovery result absent")
		}
		return *body.Baselines
	}
	rows := read(request(f.vaultID, f.accountID, true, true))
	wantHLC := HLC{PMS: correction.HLC.PhysicalMS, L: correction.HLC.Logical, DID: correction.HLC.DeviceID}
	if len(rows) != 1 || rows[0].ID != *create.TargetID || rows[0].AmountAFN != "12.34" || rows[0].Currency != "USD" || rows[0].OriginalCurrency != "AFN" || CompareHLC(rows[0].AmountHLC, wantHLC) != 0 || rows[0].AmountEventID != correction.EventID {
		t.Fatalf("wrong accepted monetary baseline: %+v", rows)
	}
	afterProjection, err := LoadVaultProjection(t.Context(), f.pool, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	afterJSON, err := ProjectionToJSON(*afterProjection)
	if err != nil {
		t.Fatal(err)
	}
	if string(beforeJSON) != string(afterJSON) {
		t.Fatal("baseline export changed legacy projection")
	}
	for _, event := range legacy {
		var intact bool
		if err := f.pool.QueryRow(t.Context(), `SELECT payload=$2::jsonb FROM events WHERE event_id=$1::uuid`, event.EventID, string(event.Payload)).Scan(&intact); err != nil {
			t.Fatal(err)
		}
		if !intact {
			t.Fatalf("baseline export rewrote legacy event %s", event.EventID)
		}
	}
	// A normal pull may reuse the same cached PullResult. Recovery metadata
	// must never leak into that shared object or its ordinary response shape.
	normal := request(f.vaultID, f.accountID, false, true)
	if normal.Code != http.StatusOK || strings.Contains(normal.Body.String(), `"entry_currency_baselines"`) {
		t.Fatalf("ordinary pull changed shape: %d %s", normal.Code, normal.Body.String())
	}
	if rows := read(request(other, f.accountID, true, true)); len(rows) != 0 {
		t.Fatalf("another book disclosed rows: %+v", rows)
	}
	if old := request(other, f.accountID, true, false); old.Code != http.StatusUpgradeRequired || strings.Contains(old.Body.String(), `"entry_currency_baselines"`) {
		t.Fatalf("unsupported recovery request: %d %s", old.Code, old.Body.String())
	}
	outsider := request(f.vaultID, uuid.NewString(), true, true)
	if outsider.Code != http.StatusForbidden || strings.Contains(outsider.Body.String(), *create.TargetID) || strings.Contains(outsider.Body.String(), `"entry_currency_baselines"`) {
		t.Fatalf("outsider received recovery data: %d %s", outsider.Code, outsider.Body.String())
	}
	otherEntry := creditEntry(f, uuid.NewString(), "debt", "333")
	result, err := f.svc.PushEvents(t.Context(), PushInput{AccountID: f.accountID, VaultID: other, DeviceID: f.deviceID, Events: []PushEvent{otherEntry}})
	if err != nil {
		t.Fatal(err)
	}
	requireAccepted(t, result, 1)
	otherRows := read(request(other, f.accountID, true, true))
	if len(otherRows) != 1 || otherRows[0].ID != *otherEntry.TargetID || otherRows[0].Currency != "AFN" || otherRows[0].AmountEventID != otherEntry.EventID {
		t.Fatalf("other book baseline scope changed: %+v", otherRows)
	}
}

func TestEntryCurrencyBaselineMoneyRepresentability(t *testing.T) {
	for _, amount := range []string{"0", "0.01", "0.29", "12.34", "100", "9999999999.99", "1e3", "90071992547409.90"} {
		if !baselineMoneyRepresentable(json.Number(amount)) {
			t.Fatalf("representable amount omitted: %s", amount)
		}
	}
	for _, amount := range []string{"12.345", "-1", "90071992547409.92", "90071992547409.91", "9223372036854775807", "1e400", "NaN", ""} {
		if baselineMoneyRepresentable(json.Number(amount)) {
			t.Fatalf("unrepresentable amount exported: %s", amount)
		}
	}
}
