package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
)

func seedCreditContact(t *testing.T, f *m1Fixture) string {
	t.Helper()
	rel, user := uuid.NewString(), uuid.NewString()
	ev := f.event(nil)
	ev.EventType = EventPersonAdded
	ev.TargetID = &user
	ev.RelationshipID = &rel
	ev.Payload = json.RawMessage(`{"user_id":"` + user + `","name":"Customer","phone_e164":null,"relationship_context":"peer"}`)
	if got := f.push(t, ev); len(got.Accepted) != 1 {
		t.Fatalf("person %+v", got)
	}
	return rel
}

func TestCreditPolicyHTTPAuthorityAndExactCaps(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	handler := auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditLimits))
	request := func(method, body string, authenticated bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/v1/sync/credit-limits?vault_id="+f.vaultID, strings.NewReader(body))
		if authenticated {
			tok, err := auth.SignSession(testJWTSecret, f.accountID, uuid.NewString(), "google", "sub-x")
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, req)
		return r
	}
	if r := request("GET", "", true); r.Code != 200 || strings.TrimSpace(r.Body.String()) != "[]" {
		t.Fatalf("authoritative empty %d %s", r.Code, r.Body.String())
	}
	if r := request("GET", "", false); r.Code != 401 {
		t.Fatalf("anonymous %d", r.Code)
	}
	body := `{"relationship_id":"` + rel + `","max_collect_minor":10001,"max_pay_minor":0,"mode":"clerk_block","updated_at_ms":0}`
	for _, role := range []string{"owner", "manager", "editor", "clerk", "viewer"} {
		if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role=$1 WHERE vault_id=$2::uuid AND account_id=$3::uuid`, role, f.vaultID, f.accountID); err != nil {
			t.Fatal(err)
		}
		want := 403
		if role == "owner" || role == "manager" {
			want = 200
		}
		if r := request("PUT", body, true); r.Code != want {
			t.Fatalf("%s PUT %d %s", role, r.Code, r.Body.String())
		}
		if r := request("GET", "", true); r.Code != 200 {
			t.Fatalf("%s GET %d", role, r.Code)
		}
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='manager' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if r := request("PUT", strings.Replace(body, "10001", "100.01", 1), true); r.Code != 400 {
		t.Fatalf("fractional minor %d", r.Code)
	}
	if r := request("PUT", strings.Replace(body, rel, uuid.NewString(), 1), true); r.Code != 409 {
		t.Fatalf("foreign customer %d", r.Code)
	}
	// The kaata default belongs to no customer and saves without one.
	if r := request("PUT", strings.Replace(body, rel, credit.DefaultRelationshipID, 1), true); r.Code != 200 {
		t.Fatalf("kaata default PUT %d %s", r.Code, r.Body.String())
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if r := request("GET", "", true); r.Code != 403 {
		t.Fatalf("revoked GET %d", r.Code)
	}
}

func TestCreditRefusalTerminalAcrossPeerPolicyAndRoleChanges(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "clerk_block", 0)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	ev := creditEntry(f, rel, "debt", "1")
	if got := f.push(t, ev); len(got.Rejected) != 1 {
		t.Fatal(got)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE customer_credit_limits SET mode='warn',max_collect_minor=NULL WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.PushEvents(context.Background(), PushInput{AccountID: f.accountID, VaultID: f.vaultID, DeviceID: uuid.NewString(), Events: []PushEvent{ev}})
	if err != nil || len(res.Rejected) != 1 || res.Rejected[0].Reason != "credit_limit_exceeded" {
		t.Fatalf("mesh copy %+v %v", res, err)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if got := f.push(t, ev); len(got.Rejected) != 1 {
		t.Fatalf("promotion retry %+v", got)
	}
	if got := f.push(t, creditEntry(f, rel, "debt", "1")); len(got.Accepted) != 1 {
		t.Fatalf("fresh attempt %+v", got)
	}
}

func TestCreditAbortedBatchDoesNotPersistTentativeDenial(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "clerk_block", 10000)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	a, b, bad := creditEntry(f, rel, "debt", "60"), creditEntry(f, rel, "debt", "60"), f.event(nil)
	bad.EventID = "invalid"
	if _, err := f.svc.PushEvents(context.Background(), PushInput{AccountID: f.accountID, VaultID: f.vaultID, DeviceID: f.deviceID, Events: []PushEvent{a, b, bad}}); err == nil {
		t.Fatal("expected batch abort")
	}
	if got := f.push(t, b); len(got.Accepted) != 1 {
		t.Fatalf("no response means still pending %+v", got)
	}
}

func TestCreditHardGuardsAndUnrestrictedCompatibility(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	legacy := creditEntry(f, rel, "debt", "1")
	legacy.Payload = append(legacy.Payload[:len(legacy.Payload)-1], []byte(`,"backfill_synthetic":true}`)...)
	if got := f.push(t, legacy); len(got.Accepted) != 1 {
		t.Fatalf("unrestricted backfill %+v", got)
	}
	seedCreditPolicy(t, f, rel, "clerk_block", 10000)
	for _, kind := range []string{"backfill", "envelope", "target"} {
		ev := creditEntry(f, rel, "debt", "1")
		switch kind {
		case "backfill":
			ev.Payload = append(ev.Payload[:len(ev.Payload)-1], []byte(`,"backfill_synthetic":true}`)...)
		case "envelope":
			r := uuid.NewString()
			ev.RelationshipID = &r
		case "target":
			id := uuid.NewString()
			ev.TargetID = &id
		}
		if got := f.push(t, ev); len(got.Rejected) != 1 {
			t.Fatalf("%s %+v", kind, got)
		}
	}
	otherVault := uuid.NewString()
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO vaults(vault_id,owner_account_id,name,currency)VALUES($1::uuid,$2::uuid,'Other','AFN');`, otherVault, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO vault_members(vault_id,account_id,role,invited_at,accepted_at,invited_by)VALUES($1::uuid,$2::uuid,'clerk',NOW(),NOW(),$2::uuid)`, otherVault, f.accountID); err != nil {
		t.Fatal(err)
	}
	reuse := legacy
	reuse.EventID = uuid.NewString()
	got, err := f.svc.PushEvents(context.Background(), PushInput{AccountID: f.accountID, VaultID: otherVault, DeviceID: f.deviceID, Events: []PushEvent{reuse}})
	if err != nil || len(got.Rejected) != 1 {
		t.Fatalf("global id reuse %+v %v", got, err)
	}
	if got := f.push(t, legacy); len(got.Duplicates) != 1 {
		t.Fatalf("accepted duplicate %+v", got)
	}
}
func creditEntry(f *m1Fixture, rel, kind, amount string) PushEvent {
	ev := f.event(nil)
	id := uuid.NewString()
	ev.TargetID = &id
	ev.RelationshipID = &rel
	ev.Payload = json.RawMessage(`{"entry_id":"` + id + `","relationship_id":"` + rel + `","type":"` + kind + `","amount_afn":` + amount + `,"note":null,"occurred_at_ms":` + jsonNumber(time.Now().UnixMilli()) + `}`)
	return ev
}
func jsonNumber(n int64) string { raw, _ := json.Marshal(n); return string(raw) }
func seedCreditPolicy(t *testing.T, f *m1Fixture, rel, mode string, cap int64) {
	t.Helper()
	_, err := f.pool.Exec(context.Background(), `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms)VALUES($1::uuid,$2::uuid,$3,$3,$4,1)`, f.vaultID, rel, cap, mode)
	if err != nil {
		t.Fatal(err)
	}
}

func TestCreditPushSerialAdmissionAndRepayment(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "clerk_block", 10000)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, f.accountID); err != nil {
		t.Fatal(err)
	}
	ev1, ev2 := creditEntry(f, rel, "debt", "60"), creditEntry(f, rel, "debt", "60")
	var wg sync.WaitGroup
	results := make(chan *PushResponse, 2)
	errs := make(chan error, 2)
	for _, ev := range []PushEvent{ev1, ev2} {
		wg.Add(1)
		go func(ev PushEvent) {
			defer wg.Done()
			res, err := f.svc.PushEvents(context.Background(), PushInput{AccountID: f.accountID, VaultID: f.vaultID, DeviceID: f.deviceID, Events: []PushEvent{ev}})
			if err != nil {
				errs <- err
			} else {
				results <- res
			}
		}(ev)
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	accepted, rejected := 0, 0
	for res := range results {
		accepted += len(res.Accepted)
		rejected += len(res.Rejected)
		if len(res.Rejected) > 0 && res.Rejected[0].Reason != "credit_limit_exceeded" {
			t.Fatal(res)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("accepted%d rejected%d", accepted, rejected)
	}
	if got := f.push(t, creditEntry(f, rel, "payment", "20.01")); len(got.Accepted) != 1 {
		t.Fatalf("repayment %+v", got)
	}
	if got := f.push(t, creditEntry(f, rel, "debt", "60.01")); len(got.Accepted) != 1 {
		t.Fatalf("exact cap %+v", got)
	}
	if got := f.push(t, creditEntry(f, rel, "debt", "0.01")); len(got.Rejected) != 1 {
		t.Fatalf("one cent %+v", got)
	}
	// Owner/editor writes remain explicit overrides; they may exceed a cap.
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, f.accountID); err != nil {
		t.Fatal(err)
	}
	if got := f.push(t, creditEntry(f, rel, "debt", "50")); len(got.Accepted) != 1 {
		t.Fatal(got)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, f.accountID); err != nil {
		t.Fatal(err)
	}
	if got := f.push(t, creditEntry(f, rel, "payment", "0.01")); len(got.Accepted) != 1 {
		t.Fatalf("over-limit repayment %+v", got)
	}
}

func TestCreditWarnModeAndDuplicate(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "warn", 1)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, f.accountID); err != nil {
		t.Fatal(err)
	}
	ev := creditEntry(f, rel, "debt", "100")
	if got := f.push(t, ev); len(got.Accepted) != 1 {
		t.Fatal(got)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE customer_credit_limits SET mode='clerk_block' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if got := f.push(t, ev); len(got.Duplicates) != 1 {
		t.Fatalf("lost-success retry %+v", got)
	}
}

func TestCreditDuplicateRequiresSameImmutableFinancialEvent(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "clerk_block", 0)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	refused := creditEntry(f, rel, "debt", "1")
	if got := f.push(t, refused); len(got.Rejected) != 1 {
		t.Fatal(got)
	}
	other := uuid.NewString()
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO vaults(vault_id,owner_account_id,name,currency) VALUES($1::uuid,$2::uuid,'Other','AFN')`, other, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO vault_members(vault_id,account_id,role,invited_at,accepted_at,invited_by) VALUES($1::uuid,$2::uuid,'clerk',NOW(),NOW(),$2::uuid)`, other, f.accountID); err != nil {
		t.Fatal(err)
	}
	variant := creditEntry(f, uuid.NewString(), "debt", "1")
	variant.EventID = refused.EventID
	got, err := f.svc.PushEvents(context.Background(), PushInput{AccountID: f.accountID, VaultID: other, DeviceID: f.deviceID, Events: []PushEvent{variant}})
	if err != nil || len(got.Accepted) != 1 {
		t.Fatalf("independent event %+v %v", got, err)
	}
	if got := f.push(t, refused); len(got.Rejected) != 1 || len(got.Duplicates) != 0 {
		t.Fatalf("refused cannot alias foreign duplicate %+v", got)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE customer_credit_limits SET mode='warn' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	accepted := creditEntry(f, rel, "debt", "1")
	if got := f.push(t, accepted); len(got.Accepted) != 1 {
		t.Fatal(got)
	}
	forged := creditEntry(f, rel, "debt", "1000")
	forged.EventID = accepted.EventID
	if got := f.push(t, forged); len(got.Rejected) != 1 || len(got.Duplicates) != 0 {
		t.Fatalf("same-vault alias %+v", got)
	}
	if got := f.push(t, accepted); len(got.Duplicates) != 1 {
		t.Fatalf("matching duplicate %+v", got)
	}
}

func TestCreditRollingBatchAndHistoricalMutationOrdering(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "clerk_block", 10000)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	base := time.Now().UnixMilli() + 100
	batch := make([]PushEvent, 100)
	for i := range batch {
		batch[i] = creditEntry(f, rel, "debt", "1")
		batch[i].HLC.PhysicalMS = base + int64(i)
	}
	start := time.Now()
	got := f.push(t, batch...)
	t.Logf("100 clerk writes: %s", time.Since(start))
	if len(got.Accepted) != 100 || len(got.Rejected) != 0 {
		t.Fatalf("rolling batch %+v", got)
	}
	repay, replace, cent := creditEntry(f, rel, "payment", "1"), creditEntry(f, rel, "debt", "1"), creditEntry(f, rel, "debt", "0.01")
	repay.HLC.PhysicalMS = base + 101
	replace.HLC.PhysicalMS = base + 102
	cent.HLC.PhysicalMS = base + 103
	if got := f.push(t, repay, replace, cent); len(got.Accepted) != 2 || len(got.Rejected) != 1 {
		t.Fatalf("rolling repayment %+v", got)
	}
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	state := &creditProjection{}
	p, err := state.load(context.Background(), tx, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	id := *batch[0].TargetID
	amend := f.event(nil)
	amend.EventType = EventEntryAmended
	amend.TargetID = &id
	amend.Payload = json.RawMessage(`{"changes":{"amount_afn":2}}`)
	amend.HLC.PhysicalMS = base + 104
	state.accepted(f.vaultID, amend)
	if p.Entries[id].AmountAFN.String() != "2" {
		t.Fatal("accepted non-create mutation not folded")
	}
	state.accepted(f.vaultID, amend)
	if state.p != nil {
		t.Fatal("equal HLC must trigger sorted reload")
	}
	if _, err := state.load(context.Background(), tx, f.vaultID); err != nil {
		t.Fatal(err)
	}
	amend.HLC.PhysicalMS = base - 1
	state.accepted(f.vaultID, amend)
	if state.p != nil {
		t.Fatal("backdated history must trigger sorted reload")
	}
	fresh, err := state.load(context.Background(), tx, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	if balance, err := creditBalanceWithProjection(context.Background(), tx, f.vaultID, rel, fresh); err != nil || balance != 10000 {
		t.Fatalf("fresh reload %d %v", balance, err)
	}
}

func TestCreditClerkCannotBackdateCreateUnderOrphanAmendment(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	id := uuid.NewString()
	amend := f.event(nil)
	amend.EventType = EventEntryAmended
	amend.TargetID = &id
	amend.RelationshipID = &rel
	amend.Payload = json.RawMessage(`{"changes":{"amount_afn":500}}`)
	if got := f.push(t, amend); len(got.Accepted) != 1 {
		t.Fatal(got)
	}
	seedCreditPolicy(t, f, rel, "clerk_block", 10000)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	create := creditEntry(f, rel, "debt", "1")
	create.TargetID = &id
	create.HLC.PhysicalMS = amend.HLC.PhysicalMS - 1
	var payload map[string]any
	if err := json.Unmarshal(create.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	payload["entry_id"] = id
	create.Payload, _ = json.Marshal(payload)
	if got := f.push(t, create); len(got.Rejected) != 1 || len(got.Accepted) != 0 {
		t.Fatalf("orphan target reuse %+v", got)
	}
}

func TestCreditHardPolicyRequiresCloudClerkEnrollment(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	// Represent an already chain-verified local admission in the server log.
	// Signature verification itself is covered by membership-chain suites.
	_, err := f.pool.Exec(context.Background(), `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,account_id,event_type,schema_version,payload,server_seq,local_target_id,event_sig_b64,signer_device_pubkey) VALUES($1::uuid,$2::uuid,1,0,$3::uuid,$3::uuid,$4::uuid,'vault_member_added',1,$5::jsonb,2,'local:BBBBBBBBBBBBBBBB','verified-fixture','verified-key')`, uuid.NewString(), f.vaultID, f.deviceID, f.accountID, `{"account_id":"local:BBBBBBBBBBBBBBBB","role":"clerk"}`)
	if err != nil {
		t.Fatal(err)
	}
	handler := auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditLimits))
	token, err := auth.SignSession(testJWTSecret, f.accountID, uuid.NewString(), "google", "sub-x")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"clerk_block", "warn"} {
		req := httptest.NewRequest("PUT", "/v1/sync/credit-limits?vault_id="+f.vaultID, strings.NewReader(`{"relationship_id":"`+rel+`","max_collect_minor":100,"max_pay_minor":null,"mode":"`+mode+`","updated_at_ms":0}`))
		req.Header.Set("Authorization", "Bearer "+token)
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, req)
		if mode == "clerk_block" {
			if r.Code != 409 || !strings.Contains(r.Body.String(), "clerk_cloud_enrollment_required") {
				t.Fatalf("hard %d %s", r.Code, r.Body.String())
			}
		} else if r.Code != 200 {
			t.Fatalf("warn %d %s", r.Code, r.Body.String())
		}
	}
}

// A clerk's tally for a customer without their own limit falls under the
// kaata default: re-adding a customer as a new contact no longer escapes a
// limit. A customer's own policy, even warn-only, still wins.
func TestCreditKaataDefaultCoversCustomersWithoutTheirOwn(t *testing.T) {
	f := newM1Fixture(t)
	plain := seedCreditContact(t, f)
	ownWarn := seedCreditContact(t, f)
	seedCreditPolicy(t, f, credit.DefaultRelationshipID, "clerk_block", 10000)
	seedCreditPolicy(t, f, ownWarn, "warn", 10000)
	if _, err := f.pool.Exec(context.Background(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	if got := f.push(t, creditEntry(f, plain, "debt", "150")); len(got.Rejected) != 1 {
		t.Fatalf("over the kaata default %+v", got)
	}
	if got := f.push(t, creditEntry(f, plain, "debt", "50")); len(got.Accepted) != 1 {
		t.Fatalf("within the kaata default %+v", got)
	}
	if got := f.push(t, creditEntry(f, ownWarn, "debt", "150")); len(got.Accepted) != 1 {
		t.Fatalf("a customer's own warn-only limit must win over the default %+v", got)
	}
}

// Audit #24: the owner never learned that a limit stopped a clerk. A genuine
// over-limit attempt is listed once, with its customer, direction, amount and
// clerk; protocol refusals are not; only owners and managers may read it.
func TestCreditRefusalsListedForOwnersOnly(t *testing.T) {
	f := newM1Fixture(t)
	ctx := context.Background()
	rel := seedCreditContact(t, f)
	seedCreditPolicy(t, f, rel, "clerk_block", 100)
	if _, err := f.pool.Exec(ctx, `UPDATE accounts SET display_name='Clerk Ahmad' WHERE id=$1::uuid`, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	over := creditEntry(f, rel, "debt", "5")
	for i := 0; i < 2; i++ { // a retry must not list the attempt twice
		if got := f.push(t, over); len(got.Rejected) != 1 || got.Rejected[0].Reason != "credit_limit_exceeded" {
			t.Fatalf("over-limit push %d: %+v", i, got)
		}
	}
	// A protocol refusal (envelope and payload disagree) is no attempt.
	malformed := creditEntry(f, rel, "debt", "0.5")
	other := uuid.NewString()
	malformed.RelationshipID = &other
	if got := f.push(t, malformed); len(got.Rejected) != 1 {
		t.Fatalf("malformed push %+v", got)
	}
	var relID, kind, actor string
	var amount int64
	if err := f.pool.QueryRow(ctx, `SELECT relationship_id::text, entry_type, amount_minor, actor_account_id::text FROM customer_credit_event_refusals WHERE event_id=$1::uuid`, over.EventID).Scan(&relID, &kind, &amount, &actor); err != nil {
		t.Fatal(err)
	}
	if relID != rel || kind != "debt" || amount != 500 || actor != f.accountID {
		t.Fatalf("details %s %s %d %s", relID, kind, amount, actor)
	}

	handler := auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditRefusals))
	get := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/v1/sync/credit-refusals?vault_id="+f.vaultID, nil)
		tok, err := auth.SignSession(testJWTSecret, f.accountID, uuid.NewString(), "google", "sub-x")
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, req)
		return r
	}
	if r := get(); r.Code != 403 || !strings.Contains(r.Body.String(), "insufficient_role") {
		t.Fatalf("clerk read %d %s", r.Code, r.Body.String())
	}
	for _, role := range []string{"manager", "owner"} {
		if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET role=$1 WHERE vault_id=$2::uuid`, role, f.vaultID); err != nil {
			t.Fatal(err)
		}
		r := get()
		var body struct {
			Refusals []CreditRefusal `json:"refusals"`
		}
		if r.Code != 200 || json.Unmarshal(r.Body.Bytes(), &body) != nil {
			t.Fatalf("%s read %d %s", role, r.Code, r.Body.String())
		}
		if len(body.Refusals) != 1 {
			t.Fatalf("%s sees %+v", role, body.Refusals)
		}
		got := body.Refusals[0]
		if got.RelationshipID != rel || got.Type != "debt" || got.AmountMinor != 500 || got.ActorAccountID != f.accountID || got.ActorName != "Clerk Ahmad" || got.RefusedAtMS <= 0 {
			t.Fatalf("%s listing %+v", role, got)
		}
	}
}
