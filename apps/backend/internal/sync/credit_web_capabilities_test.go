package sync

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
)

// Credit settings use the same compatibility gate as the ledger. A current
// browser must advertise both currency corrections and shared-account groups;
// accepting either feature in the ledger alone must not break its credit view.
func TestCreditWebCapabilitiesAllowCorrectedAndGroupedBooks(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	entry := creditEntry(f, rel, "debt", "20")
	amend := f.event(nil)
	amend.EventType, amend.TargetID = EventEntryAmended, entry.TargetID
	amend.HLC.PhysicalMS = entry.HLC.PhysicalMS + 10
	amend.Payload = json.RawMessage(`{"changes":{"amount_afn":20,"currency":"USD"}}`)
	if got := f.push(t, entry, amend); len(got.Accepted) != 2 {
		t.Fatalf("seed corrected currency: %+v", got)
	}

	token, err := auth.SignSession(testJWTSecret, f.accountID, f.deviceID, "google", "web-credit-capabilities")
	if err != nil {
		t.Fatal(err)
	}
	handler := auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditLimits))
	body := `{"relationship_id":"` + credit.DefaultRelationshipID + `","currency":"USD","max_collect_minor":10001,"max_pay_minor":null,"mode":"warn","restrict_editors":true}`
	request := func(method string, corrections, groups bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "/v1/sync/credit-limits?vault_id="+f.vaultID, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Kaata-Currencies", "1")
		if corrections {
			req.Header.Set("X-Kaata-Entry-Currency-Edit", "1")
		}
		if groups {
			req.Header.Set("X-Kaata-Tab-Group", "1")
		}
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		return out
	}
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		if out := request(method, false, false); out.Code != http.StatusUpgradeRequired ||
			!strings.Contains(out.Body.String(), "corrected tally currencies") {
			t.Fatalf("unaware currency %s: %d %s", method, out.Code, out.Body.String())
		}
	}
	seedSyncGroup(t, f, rel, "a")
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		if out := request(method, true, false); out.Code != http.StatusUpgradeRequired ||
			!strings.Contains(out.Body.String(), "shared_account_upgrade_required") {
			t.Fatalf("unaware group %s: %d %s", method, out.Code, out.Body.String())
		}
	}
	if out := request(http.MethodGet, true, true); out.Code != http.StatusOK || strings.TrimSpace(out.Body.String()) != "[]" {
		t.Fatalf("current browser empty policies: %d %s", out.Code, out.Body.String())
	}
	put := request(http.MethodPut, true, true)
	if put.Code != http.StatusOK {
		t.Fatalf("current browser save: %d %s", put.Code, put.Body.String())
	}
	var saved credit.Policy
	if err := json.Unmarshal(put.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.RelationshipID != credit.DefaultRelationshipID || saved.Currency != "USD" ||
		saved.MaxCollectMinor == nil || *saved.MaxCollectMinor != 10001 || saved.MaxPayMinor != nil ||
		saved.Mode != "warn" || !saved.RestrictEditors || saved.UpdatedAtMS <= 0 {
		t.Fatalf("saved policy changed: %+v", saved)
	}
	get := request(http.MethodGet, true, true)
	var policies []credit.Policy
	if get.Code != http.StatusOK || json.Unmarshal(get.Body.Bytes(), &policies) != nil || len(policies) != 1 ||
		policies[0].RelationshipID != saved.RelationshipID || policies[0].Currency != saved.Currency ||
		policies[0].MaxCollectMinor == nil || *policies[0].MaxCollectMinor != *saved.MaxCollectMinor ||
		policies[0].MaxPayMinor != nil || policies[0].Mode != saved.Mode ||
		policies[0].RestrictEditors != saved.RestrictEditors || policies[0].UpdatedAtMS != saved.UpdatedAtMS {
		t.Fatalf("current browser reload: %d %s", get.Code, get.Body.String())
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, f.accountID); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		if out := request(method, true, true); out.Code != http.StatusForbidden {
			t.Fatalf("capability headers bypassed revoked membership on %s: %d %s", method, out.Code, out.Body.String())
		}
	}
}
