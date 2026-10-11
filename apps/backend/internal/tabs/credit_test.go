package tabs

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/credit"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func TestCreditSharedPendingRejectedAndCancelled(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	boundary := time.Now().UnixMilli()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Store", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &boundary, Opening: &OpeningInput{Direction: "a_to_b", Amount: "50", OccurredAtMS: boundary - 1000}})
	if err != nil {
		t.Fatal(err)
	}
	clerk := seedAccount(t, f.pool, "clerk@example.com", "Clerk")
	seedMember(t, f.pool, f.vaultA, clerk, "clerk")
	p, err := f.svc.PartyByAccount(ctx, created.Tab.ID, clerk)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',1)`, f.vaultA, rel); err != nil {
		t.Fatal(err)
	}
	appendOne := func(amount string) (AppendResult, error) {
		return f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: amount, OccurredAtMS: boundary + 1})
	}
	if _, err := appendOne("50.01"); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("opening cap %v", err)
	}
	tally, err := appendOne("50")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := appendOne("0.01"); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("pending counts %v", err)
	}
	peer := f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Dispute(ctx, peer, tally.Entry.ID, "Duplicate"); err != nil {
		t.Fatal(err)
	}
	tally, err = appendOne("50")
	if err != nil {
		t.Fatalf("rejected excluded %v", err)
	}
	owner := f.party(t, created.MyToken, created.Tab.ID)
	if _, err := f.svc.Void(ctx, owner, tally.Entry.ID); err != nil {
		t.Fatal(err)
	}
	tally, err = appendOne("50")
	if err != nil {
		t.Fatalf("cancelled excluded %v", err)
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "0.01", OccurredAtMS: boundary + 1}); err != nil {
		t.Fatalf("repayment %v", err)
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: tally.Entry.ID, Direction: "a_to_b", Amount: "50", OccurredAtMS: boundary + 1}); err != nil {
		t.Fatalf("idempotent retry %v", err)
	}
}

func TestCreditCombinedLocalTabConcurrentAdmissionAndTerminalID(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	boundary := time.Now().UnixMilli()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Store", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &boundary, Opening: &OpeningInput{Direction: "a_to_b", Amount: "20", OccurredAtMS: boundary - 1}})
	if err != nil {
		t.Fatal(err)
	}
	a, b := seedAccount(t, f.pool, "clerk-a@example.com", "A"), seedAccount(t, f.pool, "clerk-b@example.com", "B")
	seedMember(t, f.pool, f.vaultA, a, "clerk")
	seedMember(t, f.pool, f.vaultA, b, "clerk")
	p, err := f.svc.PartyByAccount(ctx, created.Tab.ID, a)
	if err != nil {
		t.Fatal(err)
	}
	syncSvc := syncapi.NewService(f.pool)
	pushEntry := func(amount string, occurred int64) (*syncapi.PushResponse, error) {
		entryID, eventID, device := uuid.NewString(), uuid.NewString(), uuid.NewString()
		payload, _ := json.Marshal(map[string]any{"entry_id": entryID, "relationship_id": rel, "type": "debt", "amount_afn": json.Number(amount), "occurred_at_ms": occurred, "note": nil})
		return syncSvc.PushEvents(ctx, syncapi.PushInput{AccountID: b, VaultID: f.vaultA, DeviceID: device, Events: []syncapi.PushEvent{{EventID: eventID, EventType: "entry_created", SchemaVersion: 1, TargetID: &entryID, RelationshipID: &rel, ActorAccountID: &b, HLC: syncapi.PushHLC{PhysicalMS: boundary + 2, DeviceID: device}, Payload: payload}}})
	}
	// A row on the exact frozen boundary is already absorbed into opening20.
	if _, err := pushEntry("20", boundary); err != nil {
		t.Fatal(err)
	}
	if _, err := pushEntry("10", boundary+1); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,0,'clerk_block',1)`, f.vaultA, rel); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	accepted := make(chan bool, 2)
	failures := make(chan error, 2)
	id := uuid.NewString()
	go func() {
		defer wg.Done()
		_, err := f.svc.Append(ctx, p, AppendInput{ID: id, Direction: "a_to_b", Amount: "40", OccurredAtMS: boundary + 3})
		if err != nil && !errors.Is(err, credit.ErrLimit) {
			failures <- err
		}
		accepted <- err == nil
	}()
	go func() {
		defer wg.Done()
		r, err := pushEntry("40", boundary+3)
		if err != nil {
			failures <- err
			accepted <- false
			return
		}
		accepted <- len(r.Accepted) == 1
	}()
	wg.Wait()
	close(accepted)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	n := 0
	for ok := range accepted {
		if ok {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("combined concurrent accepted %d", n)
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	balance, err := syncapi.CreditBalance(ctx, tx, f.vaultA, rel)
	_ = tx.Rollback(ctx)
	if err != nil || balance != 7000 {
		t.Fatalf("combined exact balance %d %v", balance, err)
	}
	// Persisted refusal survives a more permissive policy and lost409 response.
	refusedID := uuid.NewString()
	_, err = f.svc.Append(ctx, p, AppendInput{ID: refusedID, Direction: "a_to_b", Amount: "31", OccurredAtMS: boundary + 4})
	if !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("deny %v", err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE customer_credit_limits SET mode='warn' WHERE vault_id=$1::uuid`, f.vaultA); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: refusedID, Direction: "a_to_b", Amount: "31", OccurredAtMS: boundary + 4}); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("terminal tab retry %v", err)
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "31", OccurredAtMS: boundary + 4}); err != nil {
		t.Fatalf("fresh tab attempt %v", err)
	}
}
