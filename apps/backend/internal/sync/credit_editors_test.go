package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func setCreditOverride(t *testing.T, f *m1Fixture, override string) {
	t.Helper()
	_, err := f.pool.Exec(t.Context(), `INSERT INTO vault_member_credit_permissions(vault_id,account_id,vault_member_id,credit_limit_override,updated_at_ms)
	 SELECT vault_id,account_id,id,$3,1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND revoked_at IS NULL
	 ON CONFLICT(vault_id,account_id) DO UPDATE SET credit_limit_override=excluded.credit_limit_override,vault_member_id=excluded.vault_member_id`, f.vaultID, f.accountID, override)
	if err != nil {
		t.Fatal(err)
	}
}

func TestCreditEditorsAndIndividualOverrides(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "clerk_block", 100)
	for _, tc := range []struct {
		role, override string
		editors        bool
		allowed        bool
	}{
		{"editor", "inherit", false, true},
		{"editor", "inherit", true, false},
		{"editor", "enforce", false, false},
		{"editor", "bypass", true, true},
		{"clerk", "inherit", false, false},
		{"clerk", "bypass", true, true},
		{"manager", "enforce", true, true},
		{"owner", "enforce", true, true},
	} {
		if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role=$1 WHERE vault_id=$2::uuid`, tc.role, f.vaultID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(t.Context(), `UPDATE customer_credit_limits SET restrict_editors=$2 WHERE vault_id=$1::uuid`, f.vaultID, tc.editors); err != nil {
			t.Fatal(err)
		}
		setCreditOverride(t, f, tc.override)
		res := f.push(t, creditEntry(f, rel, "debt", "10"))
		if (len(res.Accepted) == 1) != tc.allowed || (!tc.allowed && (len(res.Rejected) != 1 || res.Rejected[0].Reason != "credit_limit_exceeded")) {
			t.Fatalf("%+v: %+v", tc, res)
		}
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE customer_credit_limits SET mode='warn',restrict_editors=true WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	setCreditOverride(t, f, "enforce")
	if res := f.push(t, creditEntry(f, rel, "debt", "10")); len(res.Accepted) != 1 {
		t.Fatalf("warning is always advisory: %+v", res)
	}
}

func creditMutation(f *m1Fixture, created PushEvent, eventType, payload string, physicalMS int64) PushEvent {
	ev := f.event(nil)
	ev.EventType, ev.TargetID, ev.RelationshipID = eventType, created.TargetID, created.RelationshipID
	ev.Payload = json.RawMessage(payload)
	ev.HLC.PhysicalMS = physicalMS
	return ev
}

func TestCreditRestrictedEditorMutationsUseProjectedDelta(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	base := time.Now().UnixMilli() + 100
	debt, payment := creditEntry(f, rel, "debt", "120"), creditEntry(f, rel, "payment", "40")
	debt.HLC.PhysicalMS, payment.HLC.PhysicalMS = base, base+1
	if got := f.push(t, debt, payment); len(got.Accepted) != 2 {
		t.Fatal(got)
	}
	seedCreditPolicy(t, f, rel, "clerk_block", 10000)
	if _, err := f.pool.Exec(t.Context(), `UPDATE customer_credit_limits SET restrict_editors=true WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	// Increasing the amount, reversing its direction, and removing the payment
	// all need the same cap check as creating a new loan.
	for i, ev := range []PushEvent{
		creditMutation(f, debt, EventEntryAmended, `{"changes":{"amount_afn":150}}`, base+2),
		creditMutation(f, payment, EventEntryAmended, `{"changes":{"type":"debt"}}`, base+3),
		creditMutation(f, payment, EventEntryDeleted, `{}`, base+4),
	} {
		if got := f.push(t, ev); len(got.Rejected) != 1 || got.Rejected[0].Reason != "credit_limit_exceeded" {
			t.Fatalf("mutation %d bypassed limit: %+v", i, got)
		}
		// Promotion/cap relaxation must not turn the same refused ID into money.
		setCreditOverride(t, f, "bypass")
		if got := f.push(t, ev); len(got.Rejected) != 1 {
			t.Fatalf("mutation %d terminal retry: %+v", i, got)
		}
		setCreditOverride(t, f, "inherit")
	}
	// An older amendment loses LWW and has zero actual delta, despite its amount.
	old := creditMutation(f, debt, EventEntryAmended, `{"changes":{"amount_afn":999}}`, base-1)
	if got := f.push(t, old); len(got.Accepted) != 1 {
		t.Fatalf("losing historical amendment: %+v", got)
	}
	// Exact-cap increase is allowed; ordinary reductions remain available.
	for _, ev := range []PushEvent{
		creditMutation(f, debt, EventEntryAmended, `{"changes":{"amount_afn":140}}`, base+5),
		creditMutation(f, debt, EventEntryAmended, `{"changes":{"amount_afn":130}}`, base+6),
		creditMutation(f, debt, EventEntryDeleted, `{}`, base+7),
	} {
		if got := f.push(t, ev); len(got.Accepted) != 1 {
			t.Fatalf("safe mutation: %+v", got)
		}
	}
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if balance, err := CreditBalance(context.Background(), tx, f.vaultID, rel); err != nil || balance != -4000 {
		t.Fatalf("final balance=%d error=%v", balance, err)
	}
}

func TestCreditPolicyEditorFlagPreservedForLegacySave(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	handler := auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditLimits))
	token, err := auth.SignSession(testJWTSecret, f.accountID, uuid.NewString(), "google", "sub-x")
	if err != nil {
		t.Fatal(err)
	}
	put := func(extra string) bool {
		req := httptest.NewRequest("PUT", "/v1/sync/credit-limits?vault_id="+f.vaultID,
			strings.NewReader(`{"relationship_id":"`+rel+`","max_collect_minor":100,"max_pay_minor":null,"mode":"clerk_block","updated_at_ms":0`+extra+`}`))
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		var saved struct {
			RestrictEditors bool `json:"restrict_editors"`
		}
		if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &saved) != nil {
			t.Fatalf("save %s: %d %s", extra, res.Code, res.Body.String())
		}
		return saved.RestrictEditors
	}
	if !put(`,"restrict_editors":true`) || !put("") || put(`,"restrict_editors":false`) {
		t.Fatal("explicit and legacy flag updates disagree")
	}
}
