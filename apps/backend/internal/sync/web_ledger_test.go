package sync

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func TestWebLedgerCanonicalMoney(t *testing.T) {
	for raw, want := range map[string]string{
		"1e3": "1000", "1.2300": "1.23", "1e-2": "0.01", "0.01000": "0.01",
		"0.000e8": "0", "-0": "0", "-12.3400": "-12.34", "12300e-4": "1.23",
		"900719925474099312345678901234567890": "900719925474099312345678901234567890",
		"90071992547409931234567890.1200":      "90071992547409931234567890.12",
	} {
		t.Run(raw, func(t *testing.T) {
			got, err := canonicalWebMoney(json.Number(raw))
			if err != nil || got != want {
				t.Fatalf("got %q, %v; want %q", got, err, want)
			}
		})
	}
	for _, raw := range []string{"1.001", "1e-3", "1.23001", "1e9999999999999999", "NaN", "Infinity", "01", "1/2", ""} {
		if _, err := canonicalWebMoney(json.Number(raw)); !errors.Is(err, errLedgerAmountUnsupported) {
			t.Fatalf("unsafe amount %q accepted: %v", raw, err)
		}
	}
}

func TestWebLedgerProjectionMoneySharedHistoryAndSettlement(t *testing.T) {
	p := NewProjection()
	for _, id := range []string{"private", "shared", "archived"} {
		p.Users[id] = &UserProjection{ID: id, DisplayName: id}
		p.Relationships[id] = &RelationshipProjection{ID: id, UserBID: id}
	}
	archivedAt := int64(100)
	p.Relationships["archived"].ArchivedAt = &archivedAt
	p.Entries["old"] = &EntryProjection{ID: "old", RelationshipID: "private", Type: "debt", AmountAFN: json.Number("90071992547409.91"), CreatedAt: 100}
	p.Entries["usd"] = &EntryProjection{ID: "usd", RelationshipID: "private", Type: "debt", Currency: "USD", AmountAFN: json.Number("12.34"), CreatedAt: 100}
	p.Entries["new"] = &EntryProjection{ID: "new", RelationshipID: "private", Type: "payment", AmountAFN: json.Number("0.01"), CreatedAt: 201}
	p.Entries["shared"] = &EntryProjection{ID: "shared", RelationshipID: "shared", Type: "debt", AmountAFN: json.Number("999"), CreatedAt: 100}
	p.VaultSettings["enabled_currencies"] = `["AFN","EUR"]`
	relationship := "private"
	events := []LedgerEvent{{EventType: EventEntrySettled, RelationshipID: &relationship,
		HLC: HLC{PMS: 300, L: 3, DID: "device"}, Payload: json.RawMessage(`{"settled_at_ms":200}`)}}
	view := &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "USD", People: []WebLedgerPerson{}, Entries: []WebLedgerEntry{}}
	if err := populateWebLedger(view, &p, events, map[string]bool{"shared": true}); err != nil {
		t.Fatal(err)
	}
	if view.IncompletePeople != 1 || len(view.People) != 3 || len(view.Entries) != 3 {
		t.Fatalf("unexpected visible rows: %+v", view)
	}
	if strings.Join(view.EnabledCurrencies, ",") != "USD,AFN,EUR" {
		t.Fatalf("default not retained: %v", view.EnabledCurrencies)
	}
	if view.HLCLast != events[0].HLC {
		t.Fatalf("wrong frontier: %+v", view.HLCLast)
	}
	for _, row := range view.Entries {
		switch row.ID {
		case "old":
			if row.AmountAFN != "90071992547409.91" || row.Currency != "AFN" || !row.ReadOnly || row.SettledAt == nil || *row.SettledAt != 200 {
				t.Fatalf("historical amount or settled chapter changed: %+v", row)
			}
		case "usd", "new":
			if row.ReadOnly || row.SettledAt != nil {
				t.Fatalf("unrelated currency/new chapter frozen: %+v", row)
			}
		default:
			t.Fatalf("shared history must not masquerade as a private balance: %+v", row)
		}
	}
	for _, person := range view.People {
		if person.RelationshipID == "private" && (person.SettledThrough["AFN"] != 200 || person.SettledThrough["USD"] != 0) {
			t.Fatalf("settled currency frontier missing: %+v", person.SettledThrough)
		}
		if person.RelationshipID == "shared" && (!person.ReadOnly || person.ReadOnlyReason == nil || *person.ReadOnlyReason != "shared_tab") {
			t.Fatalf("shared person not explained: %+v", person)
		}
		if person.RelationshipID == "archived" && !person.ReadOnly {
			t.Fatalf("archived person editable: %+v", person)
		}
	}
}

func TestWebLedgerRejectsInexactAmountsInsteadOfRounding(t *testing.T) {
	p := NewProjection()
	p.Users["person"] = &UserProjection{ID: "person"}
	p.Relationships["rel"] = &RelationshipProjection{ID: "rel", UserBID: "person"}
	p.Entries["entry"] = &EntryProjection{ID: "entry", RelationshipID: "rel", AmountAFN: json.Number("1.001")}
	view := &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "AFN"}
	if err := populateWebLedger(view, &p, nil, nil); !errors.Is(err, errLedgerAmountUnsupported) {
		t.Fatalf("inexact projection was not refused: %v", err)
	}
}

func TestWebLedgerActivityUsesCurrentBusinessDate(t *testing.T) {
	rel := "relationship"
	events := []LedgerEvent{{EventID: "person", EventType: EventPersonAdded, VaultID: "vault", TargetID: "user", RelationshipID: &rel,
		HLC: HLC{PMS: 10}, Payload: json.RawMessage(`{"user_id":"user","name":"Customer"}`)}}
	appendEvent := func(id, kind, target, payload string) {
		events = append(events, LedgerEvent{EventID: id, EventType: kind, VaultID: "vault", TargetID: target, RelationshipID: &rel,
			HLC: HLC{PMS: int64(len(events)+1) * 1000}, Payload: json.RawMessage(payload)})
	}
	appendEvent("first", EventEntryCreated, "entry-a", `{"entry_id":"entry-a","relationship_id":"relationship","type":"debt","amount_afn":10,"occurred_at_ms":100}`)
	appendEvent("second", EventEntryCreated, "entry-b", `{"entry_id":"entry-b","relationship_id":"relationship","type":"payment","amount_afn":5,"occurred_at_ms":200}`)
	assertActivity := func(want *int64) {
		t.Helper()
		projection, err := ApplyEvents(events)
		if err != nil {
			t.Fatal(err)
		}
		view := &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "AFN"}
		if err := populateWebLedger(view, &projection, events, nil); err != nil {
			t.Fatal(err)
		}
		if len(view.People) != 1 || view.People[0].CreatedAt != 10 {
			t.Fatalf("person creation changed: %+v", view.People)
		}
		got := view.People[0].LastEntryAt
		if (want == nil) != (got == nil) || (want != nil && *got != *want) {
			t.Fatalf("activity got %v, want %v", got, want)
		}
		if view.People[0].IsSettled == nil || *view.People[0].IsSettled {
			t.Fatal("open/empty contact was marked explicitly settled")
		}
	}
	latest := int64(200)
	assertActivity(&latest)
	appendEvent("note-edit", EventEntryAmended, "entry-a", `{"changes":{"note":"Edited much later","amount_afn":20}}`)
	assertActivity(&latest)
	appendEvent("date-edit", EventEntryAmended, "entry-b", `{"changes":{"occurred_at_ms":50}}`)
	latest = 100
	assertActivity(&latest)
	appendEvent("delete-first", EventEntryDeleted, "entry-a", `{}`)
	latest = 50
	assertActivity(&latest)
	appendEvent("delete-second", EventEntryDeleted, "entry-b", `{}`)
	assertActivity(nil)
}

func TestWebLedgerActivityRequiresEveryActiveCurrencyExplicitlySettled(t *testing.T) {
	p := NewProjection()
	p.Users["user"] = &UserProjection{ID: "user", CreatedAt: 10, UpdatedAt: 9999}
	p.Relationships["rel"] = &RelationshipProjection{ID: "rel", UserBID: "user", CreatedAt: 20}
	p.Entries["afn-debt"] = &EntryProjection{ID: "afn-debt", RelationshipID: "rel", Type: "debt", AmountAFN: json.Number("90071992547409931234567890.12"), Currency: "AFN", CreatedAt: 100}
	p.Entries["afn-paid"] = &EntryProjection{ID: "afn-paid", RelationshipID: "rel", Type: "payment", AmountAFN: json.Number("90071992547409931234567890.12"), Currency: "AFN", CreatedAt: 200}
	rel := "rel"
	settlements := []LedgerEvent{}
	settle := func(currency string, at int64) {
		raw, _ := json.Marshal(map[string]any{"currency": currency, "settled_at_ms": at})
		settlements = append(settlements, LedgerEvent{EventType: EventEntrySettled, RelationshipID: &rel, Payload: raw})
	}
	assertSettled := func(want bool, latest int64) {
		t.Helper()
		view := &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "AFN"}
		if err := populateWebLedger(view, &p, settlements, nil); err != nil {
			t.Fatal(err)
		}
		person := view.People[0]
		if person.CreatedAt != 10 || person.LastEntryAt == nil || *person.LastEntryAt != latest || person.IsSettled == nil || *person.IsSettled != want {
			t.Fatalf("want creation=10 activity=%d settled=%v; got %+v", latest, want, person)
		}
	}
	assertSettled(false, 200) // A zero balance alone is neutral, not ruled off.
	settle("AFN", 300)
	assertSettled(true, 200)
	p.Entries["usd-debt"] = &EntryProjection{ID: "usd-debt", RelationshipID: "rel", Type: "debt", AmountAFN: json.Number("10"), Currency: "USD", CreatedAt: 400}
	assertSettled(false, 400)
	p.Entries["usd-paid"] = &EntryProjection{ID: "usd-paid", RelationshipID: "rel", Type: "payment", AmountAFN: json.Number("10"), Currency: "USD", CreatedAt: 500}
	assertSettled(false, 500) // A separate zero currency still needs its own marker.
	settle("USD", 500)
	assertSettled(true, 500)
	p.Entries["usd-new"] = &EntryProjection{ID: "usd-new", RelationshipID: "rel", Type: "debt", AmountAFN: json.Number("5"), Currency: "USD", CreatedAt: 600}
	assertSettled(false, 600)
	p.Entries["usd-new"].IsDeleted = true
	assertSettled(true, 500) // Deleting the latest tally restores the closed frontier.
	for _, entry := range p.Entries {
		entry.IsDeleted = true
	}
	view := &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "AFN"}
	if err := populateWebLedger(view, &p, settlements, nil); err != nil {
		t.Fatal(err)
	}
	if view.People[0].LastEntryAt != nil || view.People[0].IsSettled == nil || *view.People[0].IsSettled {
		t.Fatal("empty history must use creation and stay neutral")
	}
}

func TestWebLedgerSharedActivityRemainsUnknown(t *testing.T) {
	p := NewProjection()
	p.Users["user"] = &UserProjection{ID: "user", CreatedAt: 42}
	p.Relationships["rel"] = &RelationshipProjection{ID: "rel", UserBID: "user"}
	p.Entries["local"] = &EntryProjection{ID: "local", RelationshipID: "rel", Type: "debt", AmountAFN: json.Number("10"), CreatedAt: 999}
	view := &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "AFN"}
	if err := populateWebLedger(view, &p, nil, map[string]bool{"rel": true}); err != nil {
		t.Fatal(err)
	}
	if view.People[0].CreatedAt != 42 || view.People[0].LastEntryAt != nil || view.People[0].IsSettled != nil {
		t.Fatalf("partial shared history was presented as complete activity: %+v", view.People[0])
	}
}

func webLedgerRequest(t *testing.T, h *Handler, accountID, installID, vaultID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/sync/ledger?vault_id="+vaultID, nil)
	if accountID != "" {
		token, err := auth.SignSession(testJWTSecret, accountID, installID, "google", "test")
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	auth.RequireSession(testJWTSecret)(http.HandlerFunc(h.Ledger)).ServeHTTP(rec, req)
	return rec
}

func TestWebLedgerRequiresAuthenticationAndValidVault(t *testing.T) {
	h := NewHandler(nil)
	if rec := webLedgerRequest(t, h, "", "", uuid.NewString()); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous read: %d", rec.Code)
	}
	if rec := webLedgerRequest(t, h, uuid.NewString(), uuid.NewString(), "invalid"); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid vault: %d", rec.Code)
	}
}

func TestWebLedgerMoneyHTTPNormalizesExactlyOrReturnsActionableError(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	want := map[string]string{}
	for raw, canonical := range map[string]string{
		"1e3": "1000", "1.2300": "1.23", "1e-2": "0.01",
		"900719925474099312345678901234567890": "900719925474099312345678901234567890",
	} {
		event := creditEntry(f, rel, "debt", raw)
		if result := f.push(t, event); len(result.Accepted) != 1 {
			t.Fatalf("legacy amount %s refused at setup: %+v", raw, result)
		}
		want[*event.TargetID] = canonical
	}
	h := NewHandler(f.svc)
	rec := webLedgerRequest(t, h, f.accountID, f.deviceID, f.vaultID)
	if rec.Code != http.StatusOK {
		t.Fatalf("exact legacy amounts failed: %d %s", rec.Code, rec.Body.String())
	}
	var body WebLedger
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Entries) != len(want) {
		t.Fatalf("entries: got %d, want %d", len(body.Entries), len(want))
	}
	for _, entry := range body.Entries {
		if entry.AmountAFN != want[entry.ID] {
			t.Fatalf("amount changed: got %q want %q", entry.AmountAFN, want[entry.ID])
		}
	}
	if result := f.push(t, creditEntry(f, rel, "debt", "1.001")); len(result.Accepted) != 1 {
		t.Fatalf("inexact legacy setup: %+v", result)
	}
	rec = webLedgerRequest(t, h, f.accountID, f.deviceID, f.vaultID)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "ledger_amount_unsupported") {
		t.Fatalf("inexact amount should fail clearly: %d %s", rec.Code, rec.Body.String())
	}
}

func TestWebLedgerReadsCurrentEventsAndMasksClosedTabs(t *testing.T) {
	f := newM1Fixture(t)
	personID, relationshipID := uuid.NewString(), uuid.NewString()
	person := f.event(nil)
	person.EventType, person.TargetID, person.RelationshipID = EventPersonAdded, &personID, &relationshipID
	person.Payload = json.RawMessage(`{"user_id":"` + personID + `","name":"First name","phone_e164":null,"relationship_context":"peer"}`)
	if res := f.push(t, person); len(res.Accepted) != 1 {
		t.Fatalf("person push: %+v", res)
	}
	// Prove the view is independent of the deliberately obsolete stored snapshot.
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_snapshots (vault_id, up_to_server_seq, snapshot, schema_version, byte_size)
		VALUES ($1::uuid,0,'{}',1,2)`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	entryID := uuid.NewString()
	entry := f.event(nil)
	entry.TargetID, entry.RelationshipID = &entryID, &relationshipID
	entry.HLC.Logical = 1
	entry.Payload = json.RawMessage(`{"entry_id":"` + entryID + `","relationship_id":"` + relationshipID + `","type":"debt","amount_afn":12.34,"currency":"USD","note":"Tea","occurred_at_ms":100}`)
	if res := f.push(t, entry); len(res.Accepted) != 1 {
		t.Fatalf("entry push: %+v", res)
	}
	h := NewHandler(f.svc)
	read := func() WebLedger {
		t.Helper()
		rec := webLedgerRequest(t, h, f.accountID, f.deviceID, f.vaultID)
		if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("read: %d %s", rec.Code, rec.Body.String())
		}
		var body WebLedger
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	view := read()
	if len(view.People) != 1 || len(view.Entries) != 1 || view.Entries[0].AmountAFN != "12.34" || view.ServerSeq < 2 || view.Role != "owner" {
		t.Fatalf("fresh projection missing: %+v", view)
	}
	if view.DeviceRegistered || view.DevicePubkey != nil {
		t.Fatal("unbound browser reported as registered")
	}
	pubkey := make([]byte, 32)
	pubkey[0] = 42
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms)
		VALUES ($1::uuid,$2::uuid,$3,$4::uuid,100)`, f.vaultID, f.deviceID, pubkey, f.accountID); err != nil {
		t.Fatal(err)
	}
	view = read()
	if !view.DeviceRegistered || view.DevicePubkey == nil || *view.DevicePubkey != base64.StdEncoding.EncodeToString(pubkey) {
		t.Fatalf("bound key missing or changed: %+v", view.DevicePubkey)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_devices SET removed_at_ms=200 WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	view = read()
	if view.DeviceRegistered || view.DevicePubkey != nil {
		t.Fatal("removed browser reported as registered")
	}
	tabID := uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO tabs (id,currency,closed_at,closed_by) VALUES($1::uuid,'USD',NOW(),'a')`, tabID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO tab_parties (tab_id,role,token_hash,account_id,vault_id,relationship_id)
		VALUES ($1::uuid,'a',$2,$3::uuid,$4::uuid,$5::uuid)`, tabID, uuid.NewString(), f.accountID, f.vaultID, relationshipID); err != nil {
		t.Fatal(err)
	}
	view = read()
	if len(view.Entries) != 0 || view.IncompletePeople != 1 || !view.People[0].ReadOnly {
		t.Fatalf("closed shared history was treated as private: %+v", view)
	}
}

func TestWebLedgerChecksFreshMembershipArchivesAndDeletion(t *testing.T) {
	f := newM1Fixture(t)
	h := NewHandler(f.svc)
	read := func() *httptest.ResponseRecorder { return webLedgerRequest(t, h, f.accountID, f.deviceID, f.vaultID) }
	if rec := read(); rec.Code != http.StatusOK {
		t.Fatalf("initial owner read: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if rec := read(); rec.Code != http.StatusForbidden {
		t.Fatalf("revoked read: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NULL,role='viewer' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET archived_at=NOW() WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if rec := read(); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "vault_archived") {
		t.Fatalf("archived viewer: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='owner' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if rec := read(); rec.Code != http.StatusOK {
		t.Fatalf("archived owner: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.accountID); err != nil {
		t.Fatal(err)
	}
	if rec := read(); rec.Code != http.StatusUnauthorized {
		t.Fatalf("deleted account: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NULL,disabled_at=NOW() WHERE id=$1::uuid`, f.accountID); err != nil {
		t.Fatal(err)
	}
	if rec := read(); rec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled account: %d %s", rec.Code, rec.Body.String())
	}
}
