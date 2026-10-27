package tabs

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/credit"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func TestCurrenciesShareOneContactWithoutMixingHistoryOrSettlement(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	relA, relB := uuid.NewString(), uuid.NewString()
	create := func(code, amount string) CreateResult {
		t.Helper()
		r, err := f.svc.Create(ctx, CreateInput{Currency: code, Label: code, AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relA,
			Opening: &OpeningInput{Direction: "a_to_b", Amount: amount, OccurredAtMS: 100}})
		if err != nil {
			t.Fatalf("create %s: %v", code, err)
		}
		if _, err = f.svc.Join(ctx, f.party(t, r.InviteToken, r.Tab.ID), JoinInput{Label: "Customer", AccountID: &f.acctB, VaultID: &f.vaultB, RelationshipID: &relB}); err != nil {
			t.Fatalf("join %s: %v", code, err)
		}
		if _, err = f.svc.Accept(ctx, f.party(t, r.InviteToken, r.Tab.ID), r.Entries[0].ID); err != nil {
			t.Fatal(err)
		}
		return r
	}
	afn := create("AFN", "10")
	usd := create("USD", "20")
	if _, err := f.svc.Create(ctx, CreateInput{Currency: "USD", Label: "Duplicate", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relA}); !errors.Is(err, ErrAlreadyLinked) {
		t.Fatalf("duplicate currency binding: %v", err)
	}
	balance := func(code string) int64 {
		t.Helper()
		tx, err := f.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		n, err := syncapi.CreditBalance(ctx, tx, f.vaultA, relA, code)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	if balance("AFN") != 1000 || balance("USD") != 2000 {
		t.Fatal("currency balances were mixed")
	}
	clerk := seedAccount(t, f.pool, "currency-clerk@example.test", "Clerk")
	seedMember(t, f.pool, f.vaultA, clerk, "clerk")
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,currency,max_collect_minor,mode,updated_at_ms)
	 VALUES($1::uuid,$2::uuid,'AFN',10000,'clerk_block',1),($1::uuid,$2::uuid,'USD',2000,'clerk_block',1)`, f.vaultA, relA); err != nil {
		t.Fatal(err)
	}
	usdClerk, err := f.svc.PartyByAccount(ctx, usd.Tab.ID, clerk)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Append(ctx, usdClerk, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "0.01", OccurredAtMS: 150}); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("USD cap used another denomination: %v", err)
	}
	afnClerk, err := f.svc.PartyByAccount(ctx, afn.Tab.ID, clerk)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Append(ctx, afnClerk, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "30", OccurredAtMS: 150}); err != nil {
		t.Fatalf("AFN tally incorrectly used USD cap: %v", err)
	}
	repayment := f.append(t, f.party(t, usd.InviteToken, usd.Tab.ID), "b_to_a", "20", 200)
	accepted, err := f.svc.Accept(ctx, f.party(t, usd.MyToken, usd.Tab.ID), repayment.Entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	actor, err := f.svc.PartyByAccount(ctx, usd.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Settle(ctx, actor, SettleInput{ID: uuid.NewString(), ExpectedRev: accepted.Tab.Rev}); err != nil {
		t.Fatalf("zero USD settlement blocked by AFN debt: %v", err)
	}
	if balance("AFN") != 4000 || balance("USD") != 0 {
		t.Fatal("settlement crossed currency")
	}
	closed, err := f.svc.Close(ctx, f.party(t, usd.MyToken, usd.Tab.ID))
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := f.svc.Create(ctx, CreateInput{Currency: "USD", Label: "Next USD period", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &relA, ExpectedPreviousTabID: &usd.Tab.ID, ExpectedPreviousRev: &closed.Tab.Rev})
	if err != nil {
		t.Fatalf("USD receipt must not require AFN history: %v", err)
	}
	if fresh.Tab.Currency != "USD" || balance("AFN") != 4000 {
		t.Fatal("USD relink changed AFN")
	}
	if _, err = f.pool.Exec(ctx, `UPDATE vaults SET currency='EUR',default_entry_currency='GBP',legacy_currency='XXX' WHERE vault_id=$1::uuid`, f.vaultA); err != nil {
		t.Fatal(err)
	}
	var legacy, def string
	if err = f.pool.QueryRow(ctx, `SELECT legacy_currency,default_entry_currency FROM vaults WHERE vault_id=$1::uuid`, f.vaultA).Scan(&legacy, &def); err != nil {
		t.Fatal(err)
	}
	if legacy != "AFN" || def != "GBP" {
		t.Fatalf("default relabelled legacy: %s %s", legacy, def)
	}
	if _, err = f.svc.PartyByAccount(ctx, afn.Tab.ID, f.acctA); err != nil {
		t.Fatal(err)
	}
}

func TestMineRequiresCurrencyCapabilityForParallelDenominations(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	makeTab := func(code string) {
		t.Helper()
		if _, err := f.svc.Create(ctx, CreateInput{Currency: code, Label: code, AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel}); err != nil {
			t.Fatal(err)
		}
	}
	makeTab("AFN")
	jwt := "Bearer " + f.jwtFor(t, f.acctA)
	if old := f.do(t, http.MethodGet, "/v1/tabs/mine", jwt, nil); old.status != http.StatusOK {
		t.Fatalf("legacy-only discovery broke: %d", old.status)
	}
	makeTab("USD")
	if old := f.do(t, http.MethodGet, "/v1/tabs/mine", jwt, nil); old.status != http.StatusUpgradeRequired {
		t.Fatalf("old client would collapse currencies: %d", old.status)
	}
	req, err := http.NewRequest(http.MethodGet, f.server.URL+"/v1/tabs/mine", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", jwt)
	req.Header.Set("X-Kaata-Currencies", "1")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("currency-aware discovery rejected: %d", response.StatusCode)
	}
}
