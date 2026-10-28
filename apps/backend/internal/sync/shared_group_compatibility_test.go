package sync

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/credit"
)

func seedSyncGroup(t *testing.T, f *m1Fixture, relationshipID, side string) string {
	t.Helper()
	id := uuid.NewString()
	aAccount, aVault, aRel := any(f.accountID), any(f.vaultID), any(relationshipID)
	var bAccount, bVault, bRel any
	if side == "b" {
		aAccount, aVault, aRel = nil, nil, nil
		bAccount, bVault, bRel = f.accountID, f.vaultID, relationshipID
	}
	_, err := f.pool.Exec(context.Background(), `INSERT INTO tab_groups
	 (id,recording_mode,invite_token_hash,request_hash,a_account_id,a_vault_id,a_relationship_id,b_account_id,b_vault_id,b_relationship_id)
	 VALUES($1::uuid,'notify_one_way',$2,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid)`,
		id, "sync-group-"+id, aAccount, aVault, aRel, bAccount, bVault, bRel)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSharedGroupPrivateWritesCannotBypassSharing(t *testing.T) {
	for _, side := range []string{"a", "b"} {
		t.Run(side, func(t *testing.T) {
			f := newM1Fixture(t)
			rel := seedCreditContact(t, f)
			other := seedCreditContact(t, f)
			original := creditEntry(f, rel, "debt", "10")
			if got := f.push(t, original); len(got.Accepted) != 1 {
				t.Fatal(got)
			}
			seedSyncGroup(t, f, rel, side)
			if got := f.push(t, original); len(got.Duplicates) != 1 || len(got.Rejected) != 0 {
				t.Fatalf("existing history must remain a duplicate: %+v", got)
			}
			created := creditEntry(f, rel, "debt", "1")
			foreignCurrency := creditEntry(f, rel, "debt", "1")
			foreignCurrency.Payload = json.RawMessage(strings.TrimSuffix(string(foreignCurrency.Payload), "}") + `,"currency":"USD"}`)
			forgedEnvelope := creditEntry(f, rel, "debt", "1")
			forgedEnvelope.RelationshipID = &other
			forgedPayload := creditEntry(f, other, "debt", "1")
			forgedPayload.TargetID = original.TargetID
			var reused entryCreatedPayload
			if err := json.Unmarshal(forgedPayload.Payload, &reused); err != nil {
				t.Fatal(err)
			}
			reused.EntryID = *original.TargetID
			forgedPayload.Payload, _ = json.Marshal(reused)
			amend := f.event(nil)
			amend.EventType, amend.TargetID = EventEntryAmended, original.TargetID
			amend.Payload = json.RawMessage(`{"changes":{"amount_afn":11}}`)
			deleted := f.event(nil)
			deleted.EventType, deleted.TargetID = EventEntryDeleted, original.TargetID
			settled := f.event(nil)
			settled.EventType, settled.TargetID = EventEntrySettled, &rel
			settled.Payload = json.RawMessage(`{"settled_at_ms":1}`)
			for _, event := range []PushEvent{created, foreignCurrency, forgedEnvelope, forgedPayload, amend, deleted, settled} {
				got := f.push(t, event)
				if len(got.Accepted) != 0 || len(got.Rejected) != 1 || got.Rejected[0].Reason != RejectReasonSharedTallyRequired {
					t.Fatalf("%s must use the shared endpoint: %+v", event.EventType, got)
				}
			}
			unrelated := creditEntry(f, other, "debt", "2")
			if got := f.push(t, unrelated, created); len(got.Accepted) != 1 || len(got.Rejected) != 1 {
				t.Fatalf("a grouped contact must not block the rest of the book: %+v", got)
			}
		})
	}
}

func TestSharedGroupCompatibilityAndClosedContact(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	groupID := seedSyncGroup(t, f, rel, "a")
	h := NewHandler(f.svc)
	check := func(account, header string) (bool, int, string) {
		r := httptest.NewRequest("POST", "/v1/sync/push", nil)
		r.Header.Set("X-Kaata-Currencies", "1")
		r.Header.Set("X-Kaata-Tab-Group", header)
		w := httptest.NewRecorder()
		ok := h.allowCurrencyClient(w, r, f.vaultID, account)
		return ok, w.Code, w.Body.String()
	}
	if ok, code, body := check(f.accountID, ""); ok || code != 426 || !strings.Contains(body, "shared_account_upgrade_required") {
		t.Fatalf("unaware member: %v %d %s", ok, code, body)
	}
	if ok, code, body := check(f.accountID, "1"); !ok || code != 200 {
		t.Fatalf("aware member: %v %d %s", ok, code, body)
	}
	if ok, code, body := check(uuid.NewString(), ""); !ok || code != 200 || body != "" {
		t.Fatalf("group membership must not leak to outsiders: %v %d %s", ok, code, body)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE tab_groups SET closed_at=NOW(),closed_by='a' WHERE id=$1::uuid`, groupID); err != nil {
		t.Fatal(err)
	}
	if ok, code, _ := check(f.accountID, ""); ok || code != 426 {
		t.Fatal("closed shared history still requires a client able to restore every leg")
	}
	if got := f.push(t, creditEntry(f, rel, "debt", "1")); len(got.Accepted) != 1 {
		t.Fatalf("new private history after sharing stops: %+v", got)
	}
}

func TestSharedGroupCurrencyHistoryCannotDisappearAtZero(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	entry := creditEntry(f, rel, "debt", "1")
	if got := f.push(t, entry); len(got.Accepted) != 1 {
		t.Fatal(got)
	}
	has := func(code string) bool {
		t.Helper()
		tx, err := f.pool.Begin(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		got, err := HasCurrencyHistory(context.Background(), tx, f.vaultID, rel, code)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if !has("AFN") || has("USD") {
		t.Fatal("legacy untagged history must use its original denomination")
	}
	amend := f.event(nil)
	amend.EventType, amend.TargetID = EventEntryAmended, entry.TargetID
	amend.HLC.PhysicalMS = entry.HLC.PhysicalMS + 10
	amend.Payload = json.RawMessage(`{"changes":{"amount_afn":1,"currency":"USD"}}`)
	deleted := f.event(nil)
	deleted.EventType, deleted.TargetID = EventEntryDeleted, entry.TargetID
	deleted.HLC.PhysicalMS = amend.HLC.PhysicalMS + 10
	if got := f.push(t, amend, deleted); len(got.Accepted) != 2 {
		t.Fatal(got)
	}
	if !has("AFN") || !has("USD") {
		t.Fatal("deleted or corrected history must not become an empty new currency")
	}
	settled := f.event(nil)
	settled.EventType, settled.RelationshipID, settled.TargetID = EventEntrySettled, &rel, &rel
	settled.Payload = json.RawMessage(`{"currency":"EUR","settled_at_ms":1}`)
	if got := f.push(t, settled); len(got.Accepted) != 1 || !has("EUR") || has("AUD") {
		t.Fatal("settlement history must remain visible to currency admission", got)
	}
}

func TestSharedGroupCutoverSerializesWithPrivatePush(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := credit.Lock(context.Background(), tx, f.vaultID); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	if _, err := tx.Exec(context.Background(), `INSERT INTO tab_groups(id,recording_mode,invite_token_hash,request_hash,a_account_id,a_vault_id,a_relationship_id)
	 VALUES($1::uuid,'notify',$2,$2,$3::uuid,$4::uuid,$5::uuid)`, id, "cutover-"+id, f.accountID, f.vaultID, rel); err != nil {
		t.Fatal(err)
	}
	type result struct {
		response *PushResponse
		err      error
	}
	completed := make(chan result, 1)
	go func() {
		r, err := f.svc.PushEvents(context.Background(), PushInput{AccountID: f.accountID, VaultID: f.vaultID, DeviceID: f.deviceID, Events: []PushEvent{creditEntry(f, rel, "debt", "1")}})
		completed <- result{r, err}
	}()
	select {
	case <-completed:
		t.Fatal("a private push crossed an uncommitted shared-account cutover")
	case <-time.After(30 * time.Millisecond):
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-completed:
		if got.err != nil || got.response == nil || len(got.response.Rejected) != 1 || got.response.Rejected[0].Reason != RejectReasonSharedTallyRequired {
			t.Fatalf("cutover result: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shared-account cutover left a private push blocked")
	}
}

func TestSharedGroupSourceCurrenciesAndRecordingWatermark(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	other := seedCreditContact(t, f)
	entry := creditEntry(f, rel, "debt", "1")
	var payload map[string]any
	if err := json.Unmarshal(entry.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	payload["currency"], payload["occurred_at_ms"], payload["recorded_at_ms"] = "USD", 100, 2000
	entry.Payload, _ = json.Marshal(payload)
	foreign := creditEntry(f, other, "debt", "1")
	foreign.Payload = json.RawMessage(strings.TrimSuffix(string(foreign.Payload), "}") + `,"currency":"AUD"}`)
	settings := f.event(nil)
	settings.EventType = EventVaultSettingSet
	settings.Payload = json.RawMessage(`{"key":"enabled_currencies","value":"[\"AFN\",\"EUR\"]"}`)
	if got := f.push(t, entry, foreign, settings); len(got.Accepted) != 3 {
		t.Fatal(got)
	}
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	codes, err := GroupSourceCurrencies(t.Context(), tx, f.vaultID, rel)
	if err != nil || strings.Join(codes, ",") != "AFN,EUR,USD" {
		t.Fatalf("configured and this contact's recorded currencies: %v %v", codes, err)
	}
	latest, err := GroupSourceLatestRecordedAt(t.Context(), tx, f.vaultID, rel, "USD")
	if err != nil || latest != 2000 {
		t.Fatalf("recording time must win over the edited business date: %d %v", latest, err)
	}
	latest, err = GroupSourceLatestRecordedAt(t.Context(), tx, f.vaultID, rel, "AUD")
	if err != nil || latest != 0 {
		t.Fatalf("another customer's recording must not change this cutover: %d %v", latest, err)
	}
}
