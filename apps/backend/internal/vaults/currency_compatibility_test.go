package vaults

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func TestOldCurrencyPatchRequiresUpgradeWithoutRelabelling(t *testing.T) {
	f := newCreditPermissionsFixture(t)
	router := chi.NewRouter()
	router.Use(auth.RequireSession(creditPermissionTestSecret))
	router.Patch("/v1/vaults/{vault_id}", NewHandler(f.svc).Update)
	token, err := auth.SignSession(creditPermissionTestSecret, f.owner, uuid.NewString(), "google", "currency-test")
	if err != nil {
		t.Fatal(err)
	}
	request := func(body string, aware bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPatch, "/v1/vaults/"+f.vault, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		if aware {
			req.Header.Set("X-Kaata-Currencies", "1")
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out
	}
	old := request(`{"name":"Should stay unchanged","currency":"USD"}`, false)
	if old.Code != http.StatusUpgradeRequired {
		t.Fatalf("old currency PATCH: %d %s", old.Code, old.Body.String())
	}
	var name, base, legacy string
	if err = f.pool.QueryRow(t.Context(), `SELECT name,currency,legacy_currency FROM vaults WHERE vault_id=$1::uuid`, f.vault).Scan(&name, &base, &legacy); err != nil {
		t.Fatal(err)
	}
	if name != "Shop" || base != "AFN" || legacy != "AFN" {
		t.Fatalf("rejected patch changed book: %s %s %s", name, base, legacy)
	}
	rename := request(`{"name":"Renamed"}`, false)
	if rename.Code != http.StatusOK {
		t.Fatalf("ordinary legacy rename broke: %d %s", rename.Code, rename.Body.String())
	}
	aware := request(`{"currency":"USD"}`, true)
	if aware.Code != http.StatusOK {
		t.Fatalf("aware legacy API compatibility: %d %s", aware.Code, aware.Body.String())
	}
	if err = f.pool.QueryRow(t.Context(), `SELECT currency,legacy_currency FROM vaults WHERE vault_id=$1::uuid`, f.vault).Scan(&base, &legacy); err != nil {
		t.Fatal(err)
	}
	if base != "USD" || legacy != "AFN" {
		t.Fatalf("aware patch retagged original amounts: %s %s", base, legacy)
	}
}
