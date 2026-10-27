package admin

import (
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"reflect"
	"testing"

	ksync "github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestOutreachCurrenciesKeepOnePersonAndSeparateMoney(t *testing.T) {
	phone := "+93700000111"
	p := &ksync.Projection{
		Users:         map[string]*ksync.UserProjection{"person": {ID: "person", DisplayName: "Customer", PhoneE164: &phone}},
		Relationships: map[string]*ksync.RelationshipProjection{"rel": {ID: "rel", UserBID: "person"}},
		Entries: map[string]*ksync.EntryProjection{
			"afn":     {RelationshipID: "rel", Type: "debt", AmountAFN: json.Number("100"), Currency: "AFN"},
			"usd":     {RelationshipID: "rel", Type: "payment", AmountAFN: json.Number("100"), Currency: "USD"},
			"legacy":  {RelationshipID: "rel", Type: "payment", AmountAFN: json.Number("25")},
			"deleted": {RelationshipID: "rel", Type: "debt", AmountAFN: json.Number("999"), Currency: "USD", IsDeleted: true},
		},
	}
	f := foldOutreachVault(p, "AFN")
	if f.people != 1 || f.tallies != 3 || len(f.listings) != 1 {
		t.Fatalf("currencies duplicated a person/listing or counted a deleted tally: %+v", f)
	}
	want := []OutreachCurrencyTotals{{Currency: "AFN", Receivable: "75.00", Payable: "0.00"}, {Currency: "USD", Receivable: "0.00", Payable: "100.00"}}
	if got := outreachCurrencyTotals(f.totals); !reflect.DeepEqual(got, want) {
		t.Fatalf("money mixed: %+v", got)
	}
	l := f.listings[0].listing
	if l.Balance != "" || l.Currency != "" || l.Role != "mixed" || len(l.Balances) != 2 {
		t.Fatalf("mixed listing has a false scalar: %+v", l)
	}
	f.listings[0].listing.VaultID = "vault"
	c := buildOutreachCustomer(&outreachCustGroup{listings: f.listings, owners: []string{"owner"}}).cu
	if c.MentionCount != 1 || c.TalliesTotal != 3 || !c.IsSupplierAnywhere || !c.IsCustomerAnywhere {
		t.Fatalf("customer counts/directions changed: %+v", c)
	}
	g := &outreachShopGroup{account: &outreachAccount{id: "owner"}}
	s := buildOutreachShopkeeper(g, map[string]*outreachVault{"vault": {id: "vault", currency: "AFN", fold: &f}}, map[string][]outreachMember{"owner": {{vaultID: "vault", role: "owner"}}}).sk
	if s.People != 1 || s.Tallies != 3 || len(s.Kaatas) != 1 || s.ReceivableTotal != "" || s.PayableTotal != "" || !reflect.DeepEqual(s.CurrencyTotals, want) || !reflect.DeepEqual(s.Kaatas[0].CurrencyTotals, want) {
		t.Fatalf("shopkeeper mixed money or duplicated book counts: %+v", s)
	}
}

func TestOutreachLegacyAmountsKeepTheirBookCurrency(t *testing.T) {
	p := &ksync.Projection{Relationships: map[string]*ksync.RelationshipProjection{"r": {}}, Entries: map[string]*ksync.EntryProjection{"e": {RelationshipID: "r", Type: "debt", AmountAFN: json.Number("12.345")}}}
	f := foldOutreachVault(p, "USD")
	if got := outreachCurrencyTotals(f.totals); !reflect.DeepEqual(got, []OutreachCurrencyTotals{{Currency: "USD", Receivable: "12.35", Payable: "0.00"}}) {
		t.Fatalf("legacy denomination/rounding changed: %+v", got)
	}
}

func TestGetOutreachSeparateCurrenciesFromEventLog(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	owner := seedOutreachAccount(t, pool, "Currency owner", "+93790000121")
	vault := seedOutreachVault(t, pool, owner, "Mixed book", "AFN")
	events := newOutreachEvents(t, pool, vault)
	rel := uuid.NewString()
	events.person(uuid.NewString(), rel, "Currency customer", "+93700000121")
	events.entry(rel, "debt", "100")
	events.add("entry_created", "", rel, fmt.Sprintf(
		`{"entry_id":%q,"relationship_id":%q,"type":"payment","amount_afn":100,"currency":"USD","note":null,"occurred_at_ms":%d}`,
		uuid.NewString(), rel, events.pms))
	result, err := NewService(pool, nil, nil).GetOutreach(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	customer := findOutreach(t, result, "+93700000121").Customer
	if len(customer.Listings) != 1 || customer.MentionCount != 1 || customer.TalliesTotal != 2 || !customer.IsCustomerAnywhere || !customer.IsSupplierAnywhere {
		t.Fatalf("one multicurrency contact must keep one listing and both directions: %+v", customer)
	}
	listing := customer.Listings[0]
	if listing.Balance != "" || listing.Currency != "" || !reflect.DeepEqual(listing.Balances, []OutreachCurrencyBalance{{Currency: "AFN", Balance: "100.00"}, {Currency: "USD", Balance: "-100.00"}}) {
		t.Fatalf("event-log projection mixed currencies: %+v", listing)
	}
	shopkeeper := findOutreach(t, result, "+93790000121").Shopkeeper
	if shopkeeper.People != 1 || shopkeeper.Tallies != 2 || len(shopkeeper.Kaatas) != 1 || len(shopkeeper.CurrencyTotals) != 2 || shopkeeper.ReceivableTotal != "" || shopkeeper.PayableTotal != "" {
		t.Fatalf("outreach endpoint duplicated counts or exposed a mixed scalar: %+v", shopkeeper)
	}
}
