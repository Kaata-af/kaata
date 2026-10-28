package tabs

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/credit"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func createOneWay(t *testing.T, f *tabFixture, opening string) CreateResult {
	t.Helper()
	in := CreateInput{RecordingMode: "notify_one_way", Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA}
	if opening != "" {
		in.Opening = &OpeningInput{Direction: "a_to_b", Amount: opening, OccurredAtMS: 100}
	}
	created, err := f.svc.Create(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func TestOneWayRecordingHeaderCompatibility(t *testing.T) {
	for _, mode := range []string{"review", "notify", "notify_one_way", "future-mode"} {
		for _, version := range []string{"", "1", "2", "3"} {
			for _, oneWay := range []string{"", "1", "2"} {
				want := mode == "review" || ((version == "1" || version == "2") && (mode == "notify" || (mode == "notify_one_way" && oneWay == "1")))
				if got := recordingHeadersSupportMode(mode, version, oneWay); got != want {
					t.Fatalf("mode=%q version=%q one-way=%q: got %v want %v", mode, version, oneWay, got, want)
				}
			}
		}
	}
	status, code, _ := mapServiceError(ErrOneWayReadOnly)
	if status != http.StatusForbidden || code != "one_way_read_only" {
		t.Fatalf("wrong recipient denial: %d %s", status, code)
	}
}

func TestOneWayCreatorRecordsBothDirectionsAndRecipientCannotChangeMoney(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	created := createOneWay(t, f, "100")
	invite := f.party(t, created.InviteToken, created.Tab.ID)
	if created.Entries[0].Status != "pending" || !created.Tab.UnjoinedInvitation {
		t.Fatal("opening absorbed private records before the recipient joined")
	}
	joined, err := f.svc.Join(ctx, invite, JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB})
	if err != nil || joined.Entries[0].Status != "recorded" || joined.Tab.RecordedBalance["a"] != "100" || joined.Tab.RecordedBalance["b"] != "-100" {
		t.Fatal("join did not record the original opening", err)
	}
	assertNoReview(t, joined.Entries[0])
	a, err := f.svc.PartyByAccount(ctx, created.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.svc.PartyByAccount(ctx, created.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	added := f.append(t, a, "a_to_b", "20", 101)
	paid := f.append(t, a, "b_to_a", "5", 102)
	if added.Entry.Status != "recorded" || paid.Entry.Status != "recorded" || paid.Tab.RecordedBalance["a"] != "115" || paid.Tab.PendingBalance["a"] != "0" || paid.Tab.ConfirmedBalance["a"] != "0" {
		t.Fatal("creator cannot record both directions without agreement")
	}
	before, err := f.svc.Get(ctx, b, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, direction := range []string{"a_to_b", "b_to_a"} {
		if _, err := f.svc.Append(ctx, b, AppendInput{ID: uuid.NewString(), Direction: direction, Amount: "1", OccurredAtMS: 103}); !errors.Is(err, ErrOneWayReadOnly) {
			t.Fatalf("recipient appended %s: %v", direction, err)
		}
	}
	if _, err := f.svc.Void(ctx, b, added.Entry.ID); !errors.Is(err, ErrOneWayReadOnly) {
		t.Fatalf("recipient cancelled tally: %v", err)
	}
	if _, err := f.svc.Settle(ctx, b, SettleInput{ID: uuid.NewString(), ExpectedRev: before.Tab.Rev}); !errors.Is(err, ErrOneWayReadOnly) {
		t.Fatalf("recipient settled tally: %v", err)
	}
	if _, err := f.svc.Accept(ctx, b, added.Entry.ID); !errors.Is(err, ErrReviewNotRequired) {
		t.Fatalf("recipient accepted recorded tally: %v", err)
	}
	if _, err := f.svc.Dispute(ctx, b, added.Entry.ID, "No"); !errors.Is(err, ErrReviewNotRequired) {
		t.Fatalf("recipient rejected recorded tally: %v", err)
	}
	after, err := f.svc.Get(ctx, b, 0)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("denied recipient actions changed money or audit history", err)
	}
	if _, err := f.svc.Void(ctx, a, joined.Entries[0].ID); !errors.Is(err, ErrRecordedOpeningFinal) {
		t.Fatalf("joined opening lost finality: %v", err)
	}
	if _, err := f.svc.Void(ctx, a, added.Entry.ID); err != nil {
		t.Fatal("creator cannot withdraw its own ordinary tally", err)
	}
	if _, err := f.svc.SetLabel(ctx, b, "My contact label"); err != nil {
		t.Fatal("recipient cannot manage its own label", err)
	}
	closed, err := f.svc.Close(ctx, b)
	if err != nil || closed.Tab.ClosedAtMS == nil || closed.Tab.RecordedBalance["a"] != "95" {
		t.Fatal("recipient cannot leave while preserving recorded balances", err)
	}
}

func TestOneWayCreatorCanSettleButRecipientCannotEvenAtZero(t *testing.T) {
	f := newTabFixture(t)
	created := createOneWay(t, f, "")
	if _, err := f.svc.Join(t.Context(), f.party(t, created.InviteToken, created.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB}); err != nil {
		t.Fatal(err)
	}
	a, err := f.svc.PartyByAccount(t.Context(), created.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.svc.PartyByAccount(t.Context(), created.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	first := f.append(t, a, "a_to_b", "1.01", 100).Entry
	last := f.append(t, a, "b_to_a", "1.01", 101)
	if _, err := f.svc.Settle(t.Context(), b, SettleInput{ID: uuid.NewString(), ExpectedRev: last.Tab.Rev}); !errors.Is(err, ErrOneWayReadOnly) {
		t.Fatal(err)
	}
	marker, err := f.svc.Settle(t.Context(), a, SettleInput{ID: uuid.NewString(), ExpectedRev: last.Tab.Rev})
	if err != nil || marker.Settlement.CreatedBy != "a" {
		t.Fatal("creator settlement failed", err)
	}
	if _, err := f.svc.Void(t.Context(), a, first.ID); !errors.Is(err, ErrSettledRecord) {
		t.Fatal("cleared creator tally changed", err)
	}
}

func TestOneWayPreservesCreditLimitsAndRecipientMembersStayReadOnly(t *testing.T) {
	f := newTabFixture(t)
	ctx := t.Context()
	relationship := uuid.NewString()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	created, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify_one_way", Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relationship})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Join(ctx, f.party(t, created.InviteToken, created.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	clerk := seedAccount(t, f.pool, "one-way-clerk@example.com", "Clerk")
	seedMember(t, f.pool, f.vaultA, clerk, "clerk")
	creatorClerk, err := f.svc.PartyByAccount(ctx, created.Tab.ID, clerk)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',1)`, f.vaultA, relationship); err != nil {
		t.Fatal(err)
	}
	f.append(t, creatorClerk, "a_to_b", "100", 100)
	if _, err := f.svc.Append(ctx, creatorClerk, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "0.01", OccurredAtMS: 101}); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("creator bypassed credit limit: %v", err)
	}
	member := seedAccount(t, f.pool, "one-way-recipient-editor@example.com", "Recipient editor")
	seedMember(t, f.pool, f.vaultB, member, "editor")
	recipientMember, err := f.svc.PartyByAccount(ctx, created.Tab.ID, member)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Append(ctx, recipientMember, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "1", OccurredAtMS: 102}); !errors.Is(err, ErrOneWayReadOnly) {
		t.Fatalf("recipient delegated writer escaped restriction: %v", err)
	}
}

func TestOneWayMigrationPreservesExistingLinksAndDefault(t *testing.T) {
	f := newTabFixture(t)
	old := f.create(t, "Legacy", "", "")
	notify := createNotify(t, f, "")
	if _, err := f.pool.Exec(t.Context(), `ALTER TABLE tabs DROP CONSTRAINT tabs_recording_mode_check; ALTER TABLE tabs ADD CONSTRAINT tabs_recording_mode_check CHECK(recording_mode IN ('review','notify'));`); err != nil {
		t.Fatal(err)
	}
	ddl, err := os.ReadFile(filepath.Join("..", "db", "migrations", "071_one_way_tallies.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), string(ddl)); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{old.Tab.ID: "review", notify.Tab.ID: "notify"} {
		var mode string
		if err := f.pool.QueryRow(t.Context(), `SELECT recording_mode FROM tabs WHERE id=$1::uuid`, id).Scan(&mode); err != nil || mode != want {
			t.Fatal("migration converted existing recording mode", err)
		}
	}
	if fresh := f.create(t, "Legacy default", "", ""); fresh.Tab.RecordingMode != "review" {
		t.Fatal("legacy default changed")
	}
	createOneWay(t, f, "")
}

func TestOneWayHTTPRequiresAwarenessAndEnforcesRecipientWrites(t *testing.T) {
	f := newHTTPFixture(t)
	authA, authB := "Bearer "+f.jwtFor(t, f.acctA), "Bearer "+f.jwtFor(t, f.acctB)
	body := map[string]any{"recording_mode": "notify_one_way", "currency": "AFN", "label": "A", "vault_id": f.vaultA}
	if result := recordingHTTP(t, f, "POST", "/v1/tabs", authA, body); result.status != 426 {
		t.Fatal("old notification client created one-way link", result.status)
	}
	response := recordingHTTP(t, f, "POST", "/v1/tabs", authA, body, true)
	if response.status != 201 {
		t.Fatalf("one-way create failed: %d %s", response.status, response.body)
	}
	var created CreateResponse
	if err := json.Unmarshal(response.body, &created); err != nil {
		t.Fatal(err)
	}
	base := "/v1/tabs/" + created.Tab.ID
	before, err := f.svc.Get(t.Context(), f.party(t, created.MyToken, created.Tab.ID), 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct {
		method, path, auth string
		body               any
	}{
		{"GET", base, authA, nil}, {"GET", "/v1/tabs/mine", authA, nil},
		{"POST", "/v1/tabs/by-token", authB, map[string]any{"token": created.InviteToken}},
		{"POST", base + "/join", authB, map[string]any{"token": created.InviteToken, "label": "B", "vault_id": f.vaultB}},
		{"POST", base + "/bind", authA, map[string]any{}}, {"POST", base + "/entries", authA, map[string]any{}},
		{"POST", base + "/label", authA, map[string]any{}}, {"POST", base + "/settlements", authA, map[string]any{}},
		{"POST", base + "/close", authA, map[string]any{}}, {"POST", base + "/notifications", authA, map[string]any{}},
	} {
		if result := recordingHTTP(t, f, route.method, route.path, route.auth, route.body); result.status != 426 || result.json(t)["error_code"] != "recording_upgrade_required" {
			t.Fatalf("unaware request escaped %s: %d %s", route.path, result.status, result.body)
		}
	}
	after, err := f.svc.Get(t.Context(), f.party(t, created.MyToken, created.Tab.ID), 0)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("unaware calls changed state", err)
	}
	outsider := seedAccount(t, f.pool, "one-way-outsider@example.com", "Outsider")
	if result := recordingHTTP(t, f, "GET", base, "Bearer "+f.jwtFor(t, outsider), nil); result.status != 404 {
		t.Fatal("one-way mode leaked to outsider", result.status)
	}
	join := recordingHTTP(t, f, "POST", base+"/join", authB, map[string]any{"token": created.InviteToken, "label": "B", "vault_id": f.vaultB}, true)
	if join.status != 200 {
		t.Fatalf("one-way join failed: %d %s", join.status, join.body)
	}
	add := recordingHTTP(t, f, "POST", base+"/entries", authA, map[string]any{"id": uuid.NewString(), "direction": "a_to_b", "amount": "1", "occurred_at_ms": 100}, true)
	if add.status != 201 {
		t.Fatalf("creator add failed: %d %s", add.status, add.body)
	}
	var entry EntryResponse
	if err := json.Unmarshal(add.body, &entry); err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct {
		path string
		body any
	}{
		{base + "/entries", map[string]any{"id": uuid.NewString(), "direction": "b_to_a", "amount": "1", "occurred_at_ms": 101}},
		{base + "/entries/" + entry.Entry.ID + "/void", map[string]any{}},
		{base + "/settlements", map[string]any{"id": uuid.NewString(), "expected_rev": entry.Tab.Rev}},
	} {
		if result := recordingHTTP(t, f, "POST", route.path, authB, route.body, true); result.status != 403 || result.json(t)["error_code"] != "one_way_read_only" {
			t.Fatalf("recipient write escaped %s: %d %s", route.path, result.status, result.body)
		}
	}
	if result := recordingHTTP(t, f, "GET", base, authB, nil, true); result.status != 200 {
		t.Fatal("recipient cannot read", result.status)
	}
	if result := recordingHTTP(t, f, "POST", base+"/close", authB, map[string]any{}, true); result.status != 200 {
		t.Fatalf("recipient cannot leave: %d %s", result.status, result.body)
	}
}

func TestOneWayRecipientReceivesRecordedTalliesWithoutApprovalActions(t *testing.T) {
	f := newHTTPFixture(t)
	_, payloads := preferenceProvider(t, f)
	created := createOneWay(t, f.tabFixture, "")
	if _, err := f.svc.Join(t.Context(), f.party(t, created.InviteToken, created.Tab.ID), JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	result := recordingHTTP(t, f, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, f.acctB), map[string]any{
		"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_one_way_delivery_123456]", "preferences": legacyNotificationPreferences(),
	}, true)
	if result.status != http.StatusOK {
		t.Fatalf("read-only recipient cannot subscribe: %d %s", result.status, result.body)
	}
	entry := f.append(t, f.party(t, created.MyToken, created.Tab.ID), "a_to_b", "12.50", time.Now().UnixMilli())
	if more, err := f.svc.deliverPush(t.Context()); err != nil || !more {
		t.Fatal("one-way alert was suppressed", err)
	}
	select {
	case payload := <-payloads:
		if _, actions := payload["categoryId"]; actions || strings.Contains(payload["body"].(string), "Accept or reject") {
			t.Fatal("one-way alert offered peer review", payload)
		}
		if payload["data"].(map[string]any)["entry_id"] != entry.Entry.ID {
			t.Fatal("one-way alert lost navigation target")
		}
	case <-time.After(time.Second):
		t.Fatal("recipient did not receive recorded-tally notification")
	}
}
