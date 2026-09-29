package admin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// ---------- case 1: phone normalization (pure) ----------

func TestNormalizeOutreachPhone(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"+93700000001", "+93700000001", true},
		{"+93 70 000 0001", "+93700000001", true},
		{"93-700-000-001", "+93700000001", true},
		{"(0061) 412 345 678", "+0061412345678", true}, // "00" trunk prefix stays as digits
		{"0700000001", "+0700000001", true},            // national "0" stays too
		{"1234567", "+1234567", true},                  // 7 digits: shortest accepted
		{"123456789012345", "+123456789012345", true},  // 15 digits: longest accepted
		{"123456", "", false},                          // too short
		{"1234567890123456", "", false},                // too long
		{"", "", false},
		{"   ", "", false},
		{"phone", "", false},
		{"۰۷۰۰۰۰۰۰۰۱", "", false},   // Persian digits are NOT converted
		{"٠٧٠٠٠٠٠٠٠١", "", false},   // Arabic-Indic digits are NOT converted
		{"+93 ۷۰۰ 0000", "", false}, // mixed: only the 6 ASCII digits survive → too short
	}
	for _, tc := range cases {
		got, ok := normalizeOutreachPhone(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("normalizeOutreachPhone(%q) = %q,%v want %q,%v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestOutreachAmountHundredths(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"100", 10000, true},
		{"100.5", 10050, true},
		{"12.34", 1234, true},
		{"-3", -300, true},
		{"-12.34", -1234, true},
		{"0.10", 10, true},
		{"0.005", 1, true},     // half away from zero, like SQLite ROUND
		{"-0.005", -1, true},   // symmetric
		{"12.344", 1234, true}, // below half truncates
		{"12.345", 1235, true}, // half rounds up
		{"9999999999.99", 999999999999, true},
		{"1e2", 10000, true},
		{"", 0, false},
		{"abc", 0, false},
	}
	for _, tc := range cases {
		got, ok := amountHundredths(json.Number(tc.in))
		if got != tc.want || ok != tc.ok {
			t.Errorf("amountHundredths(%q) = %d,%v want %d,%v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
	for v, want := range map[int64]string{0: "0.00", 30000: "300.00", -30000: "-300.00", 5: "0.05", -123456: "-1234.56"} {
		if got := formatHundredths(v); got != want {
			t.Errorf("formatHundredths(%d) = %q want %q", v, got, want)
		}
	}
}

// ---------- seeders ----------

func seedOutreachAccount(t *testing.T, pool *pgxpool.Pool, name, phone string) string {
	t.Helper()
	var ph *string
	if phone != "" {
		ph = &phone
	}
	var id string
	if err := pool.QueryRow(t.Context(), `
		INSERT INTO accounts (google_sub, email, email_verified, name, phone_e164)
		VALUES ($1, $2, TRUE, $3, $4) RETURNING id::text
	`, "outreach-"+uuid.NewString(), uuid.NewString()+"@example.test", name, ph).Scan(&id); err != nil {
		t.Fatalf("seed outreach account: %v", err)
	}
	return id
}

func seedOutreachMember(t *testing.T, pool *pgxpool.Pool, vault, account, role string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), $2::uuid)
	`, vault, account, role); err != nil {
		t.Fatalf("seed outreach member: %v", err)
	}
}

func seedOutreachVault(t *testing.T, pool *pgxpool.Pool, owner, name, currency string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, $3, $4, 0)
	`, id, owner, name, currency); err != nil {
		t.Fatalf("seed outreach vault: %v", err)
	}
	seedOutreachMember(t, pool, id, owner, "owner")
	return id
}

func seedOutreachInstall(t *testing.T, pool *pgxpool.Pool, account *string, at, phone, name, shop string) string {
	t.Helper()
	id := seedActivityInstall(t, pool, account, at)
	if _, err := pool.Exec(t.Context(), `
		UPDATE installs SET self_phone = $2, self_name = $3, shop_name = $4 WHERE install_id = $1::uuid
	`, id, phone, name, shop); err != nil {
		t.Fatalf("seed outreach install profile: %v", err)
	}
	return id
}

// outreachEvents inserts raw event rows with every NOT NULL column, one
// device, monotonic HLC + server_seq — the shape the push path writes.
type outreachEvents struct {
	t      *testing.T
	pool   *pgxpool.Pool
	vault  string
	device string
	seq    int64
	pms    int64
}

func newOutreachEvents(t *testing.T, pool *pgxpool.Pool, vault string) *outreachEvents {
	return &outreachEvents{t: t, pool: pool, vault: vault, device: uuid.NewString(), pms: 1_757_000_000_000}
}

func (e *outreachEvents) add(eventType, target, rel, payload string) {
	e.t.Helper()
	e.seq++
	e.pms += 60_000
	var targetID, relID *string
	if target != "" {
		targetID = &target
	}
	if rel != "" {
		relID = &rel
	}
	if _, err := e.pool.Exec(e.t.Context(), `
		INSERT INTO events (event_id, vault_id, hlc_physical_ms, hlc_logical, hlc_device_id, device_id,
		                    target_id, relationship_id, event_type, payload, server_seq)
		VALUES ($1::uuid, $2::uuid, $3, 0, $4::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::jsonb, $9)
	`, uuid.NewString(), e.vault, e.pms, e.device, targetID, relID, eventType, payload, e.seq); err != nil {
		e.t.Fatalf("seed %s event: %v", eventType, err)
	}
}

func (e *outreachEvents) person(user, rel, name, phone string) {
	e.t.Helper()
	e.add("person_added", user, rel, fmt.Sprintf(
		`{"user_id":%q,"name":%q,"phone_e164":%q,"relationship_context":"peer"}`, user, name, phone))
}

func (e *outreachEvents) entry(rel, kind, amount string) {
	e.t.Helper()
	e.add("entry_created", "", rel, fmt.Sprintf(
		`{"entry_id":%q,"relationship_id":%q,"type":%q,"amount_afn":%s,"note":null,"occurred_at_ms":%d}`,
		uuid.NewString(), rel, kind, amount, e.pms+60_000))
}

// outreachLedger is the contract's case-3 vault: A (customer, renumbered) and
// B (supplier, renamed then archived), owned by an account with its own phone.
type outreachLedger struct {
	owner, vault             string
	userA, userB, relA, relB string
}

func seedOutreachLedger(t *testing.T, pool *pgxpool.Pool) outreachLedger {
	t.Helper()
	l := outreachLedger{
		userA: uuid.NewString(), userB: uuid.NewString(),
		relA: uuid.NewString(), relB: uuid.NewString(),
	}
	l.owner = seedOutreachAccount(t, pool, "Owner One", "+93 79 000 0001")
	l.vault = seedOutreachVault(t, pool, l.owner, "Corner Shop", "AFN")
	ev := newOutreachEvents(t, pool, l.vault)
	ev.person(l.userA, l.relA, "Ahmad", "+93700000101")
	ev.person(l.userB, l.relB, "Bashir", "+93700000102")
	ev.entry(l.relA, "debt", "500")
	ev.entry(l.relA, "payment", "200")
	ev.entry(l.relB, "debt", "100")
	ev.entry(l.relB, "payment", "400")
	ev.add("person_renamed", l.userB, "", `{"name":"Bashir Wholesale"}`)
	ev.add("person_phone_changed", l.userA, "", `{"phone_e164":"+93700000103"}`)
	// person_archived keyed by relationship only. The Go applier nulls the
	// person's phone when the envelope target is the user id and no active
	// relationship remains — which is what the app emits (plus a companion
	// phone-null). Without the user target the projection keeps the phone, so
	// this fixture exercises the archived-everywhere / supplier / wholesaler
	// paths; TestGetOutreachTargetedArchiveDropsNumber pins the app's shape.
	ev.add("person_archived", "", l.relB, `{}`)
	return l
}

func findOutreach(t *testing.T, res OutreachResult, phone string) OutreachContact {
	t.Helper()
	for _, c := range res.Contacts {
		if c.Phone == phone {
			return c
		}
	}
	t.Fatalf("contact %s missing from %d contacts", phone, len(res.Contacts))
	return OutreachContact{}
}

func hasOutreach(res OutreachResult, phone string) bool {
	for _, c := range res.Contacts {
		if c.Phone == phone {
			return true
		}
	}
	return false
}

func postOutreach(fn http.HandlerFunc, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/outreach/x", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	fn(rec, req)
	return rec
}

func outreachError(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return body.Error
}

// ---------- case 2: shopkeeper numbers merge across installs ----------

func TestGetOutreachMergesInstallsByNormalizedPhone(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	older := seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", "+93 700 000 001", "Old Name", "")
	newer := seedOutreachInstall(t, pool, nil, "2026-09-03T10:00:00Z", "93-700-000-001", "", "Latest Shop")
	if _, err := pool.Exec(ctx, `
		UPDATE installs SET platform = 'android', app_version = '1.0.0', has_onboarded = FALSE,
		  check_in_count = 2, usage_entries_created = 5 WHERE install_id = $1::uuid
	`, older); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE installs SET platform = 'ios', app_version = '2.0.0', app_locale = 'fa', has_onboarded = TRUE,
		  check_in_count = 3, usage_entries_created = 7, last_seen_at = '2026-09-05T10:00:00Z',
		  last_activity_at = '2026-09-04T10:00:00Z' WHERE install_id = $1::uuid
	`, newer); err != nil {
		t.Fatal(err)
	}
	res, err := NewService(pool, nil, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Counts.Total != 1 || res.Counts.Shopkeepers != 1 || len(res.Contacts) != 1 {
		t.Fatalf("expected exactly one shopkeeper contact, got %+v", res.Counts)
	}
	c := findOutreach(t, res, "+93700000001")
	sk := c.Shopkeeper
	if c.Kind != "shopkeeper" || sk == nil || c.Customer != nil {
		t.Fatalf("kind/blocks wrong: %+v", c)
	}
	if sk.InstallCount != 2 || !sk.HasOnboarded || sk.SignedIn || sk.AccountID != "" {
		t.Fatalf("install aggregate wrong: %+v", sk)
	}
	if sk.Platform != "ios" || sk.AppVersion != "2.0.0" || sk.Locale != "fa" || c.Locale != "fa" {
		t.Fatalf("latest install did not win: %+v", sk)
	}
	if sk.LastSeen != "2026-09-05T10:00:00Z" || sk.FirstSeen != "2026-09-01T10:00:00Z" ||
		sk.InstalledAt != "2026-09-01T10:00:00Z" || sk.LastActivityAt != "2026-09-04T10:00:00Z" {
		t.Fatalf("timeline wrong: %+v", sk)
	}
	if sk.CheckInCount != 5 || sk.UsageEntries != 12 {
		t.Fatalf("sums wrong: %+v", sk)
	}
	// Name / shop are the latest non-empty value across the group.
	if c.Name != "Old Name" || c.ShopName != "Latest Shop" {
		t.Fatalf("name/shop wrong: %q / %q", c.Name, c.ShopName)
	}
	if sk.Kaatas == nil || len(sk.Kaatas) != 0 || sk.ReceivableTotal != "0.00" || sk.PayableTotal != "0.00" {
		t.Fatalf("ledger block for an anonymous install should be empty, got %+v", sk)
	}
	if c.Outreach.Status != "new" || c.Outreach.Touches == nil || len(c.Outreach.Touches) != 0 {
		t.Fatalf("absent outreach row should read as new with empty touches: %+v", c.Outreach)
	}
	if res.Settings == nil || res.Counts.ToContact != 1 {
		t.Fatalf("settings must be {} and the row counts as to-contact: %+v", res)
	}
}

// ---------- case 3: customer numbers folded from the event log ----------

func TestGetOutreachFoldsCustomersFromEvents(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	l := seedOutreachLedger(t, pool)
	res, err := NewService(pool, nil, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if hasOutreach(res, "+93700000101") {
		t.Fatal("A's old number must not survive person_phone_changed")
	}
	// The owner's own phone (accounts.phone_e164) is a shopkeeper contact.
	owner := findOutreach(t, res, "+93790000001")
	if owner.Kind != "shopkeeper" || owner.Shopkeeper == nil || !owner.Shopkeeper.SignedIn ||
		owner.Shopkeeper.AccountID != l.owner || owner.Name != "Owner One" {
		t.Fatalf("owner contact wrong: %+v", owner)
	}

	a := findOutreach(t, res, "+93700000103")
	if a.Kind != "customer" || a.Shopkeeper != nil || a.Customer == nil || a.Name != "Ahmad" {
		t.Fatalf("A contact wrong: %+v", a)
	}
	if len(a.Customer.Listings) != 1 {
		t.Fatalf("A should have one listing: %+v", a.Customer)
	}
	al := a.Customer.Listings[0]
	if al.VaultID != l.vault || al.VaultName != "Corner Shop" || al.Currency != "AFN" ||
		al.OwnerName != "Owner One" || al.OwnerPhone != "+93790000001" {
		t.Fatalf("A listing vault/owner wrong: %+v", al)
	}
	if al.PersonName != "Ahmad" || al.Tallies != 2 || al.Balance != "300.00" || al.Role != "customer" ||
		al.Archived || al.Context != "peer" || al.FirstAddedAt == "" || al.LastTallyAt == "" {
		t.Fatalf("A listing wrong: %+v", al)
	}
	if a.Customer.MentionCount != 1 || a.Customer.TalliesTotal != 2 || a.Customer.ArchivedEverywhere ||
		!a.Customer.IsCustomerAnywhere || a.Customer.IsSupplierAnywhere || a.Customer.IsWholesaler ||
		a.Customer.LastTallyAt != al.LastTallyAt || a.Customer.FirstAddedAt != al.FirstAddedAt {
		t.Fatalf("A customer block wrong: %+v", a.Customer)
	}

	b := findOutreach(t, res, "+93700000102")
	if b.Kind != "customer" || b.Name != "Bashir Wholesale" || len(b.Customer.Listings) != 1 {
		t.Fatalf("B contact wrong: %+v", b)
	}
	bl := b.Customer.Listings[0]
	if bl.PersonName != "Bashir Wholesale" || bl.Tallies != 2 || bl.Balance != "-300.00" ||
		bl.Role != "supplier" || !bl.Archived {
		t.Fatalf("B listing wrong: %+v", bl)
	}
	if !b.Customer.ArchivedEverywhere || !b.Customer.IsSupplierAnywhere || b.Customer.IsCustomerAnywhere ||
		!b.Customer.IsWholesaler {
		t.Fatalf("B customer block wrong: %+v", b.Customer)
	}
	if res.Counts.Customers != 2 || res.Counts.Shopkeepers != 1 || res.Counts.Wholesalers != 1 ||
		res.Counts.Total != 3 {
		t.Fatalf("counts wrong: %+v", res.Counts)
	}
	// Server order: shopkeepers, then both, then customers (last tally desc).
	if res.Contacts[0].Kind != "shopkeeper" || res.Contacts[1].Kind != "customer" ||
		res.Contacts[1].Phone != "+93700000102" || res.Contacts[2].Phone != "+93700000103" {
		t.Fatalf("order wrong: %s %s %s", res.Contacts[0].Phone, res.Contacts[1].Phone, res.Contacts[2].Phone)
	}
}

// The app archives with target_id = the user id and appends a companion
// person_phone_changed null: the projection then has no phone, and an
// archived person without a phone is not a contact (contract §1.3).
func TestGetOutreachTargetedArchiveDropsNumber(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	owner := seedOutreachAccount(t, pool, "Owner Two", "")
	vault := seedOutreachVault(t, pool, owner, "Second Shop", "AFN")
	ev := newOutreachEvents(t, pool, vault)
	userC, relC := uuid.NewString(), uuid.NewString()
	userD, relD := uuid.NewString(), uuid.NewString()
	ev.person(userC, relC, "Cyrus", "+93700000104")
	ev.person(userD, relD, "Dawood", "+93700000105")
	ev.entry(relC, "debt", "50")
	ev.add("person_archived", userC, relC, `{}`)
	ev.add("person_phone_changed", userC, "", `{"phone_e164":null}`)
	// Deleted entries are excluded from tallies and balance; settled ones are not.
	entryD := uuid.NewString()
	ev.add("entry_created", "", relD, fmt.Sprintf(
		`{"entry_id":%q,"relationship_id":%q,"type":"debt","amount_afn":12.345,"note":null,"occurred_at_ms":%d,"backfill_settled_at":%d}`,
		entryD, relD, ev.pms, ev.pms))
	deleted := uuid.NewString()
	ev.add("entry_created", "", relD, fmt.Sprintf(
		`{"entry_id":%q,"relationship_id":%q,"type":"debt","amount_afn":1000,"note":null,"occurred_at_ms":%d}`,
		deleted, relD, ev.pms))
	ev.add("entry_deleted", deleted, relD, `{}`)
	res, err := NewService(pool, nil, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if hasOutreach(res, "+93700000104") {
		t.Fatal("archived person whose phone the projection nulled must not be a contact")
	}
	d := findOutreach(t, res, "+93700000105")
	dl := d.Customer.Listings[0]
	if dl.Tallies != 1 || dl.Balance != "12.35" || dl.Role != "customer" || dl.OwnerPhone != "" {
		t.Fatalf("D listing wrong (deleted excluded, settled kept, half rounds up): %+v", dl)
	}
	if res.Counts.Total != 1 {
		t.Fatalf("only D expected, got %+v", res.Counts)
	}
}

// ---------- cross-vault merge: one number recorded by two shops ----------

func TestGetOutreachMergesCustomerAcrossVaults(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	ownerOne := seedOutreachAccount(t, pool, "Owner One", "+93790000011")
	ownerTwo := seedOutreachAccount(t, pool, "Owner Two", "+93790000012")
	vaultOne := seedOutreachVault(t, pool, ownerOne, "First Shop", "AFN")
	vaultTwo := seedOutreachVault(t, pool, ownerTwo, "Second Shop", "AFN")
	relOne, relTwo := uuid.NewString(), uuid.NewString()
	evOne := newOutreachEvents(t, pool, vaultOne)
	evOne.person(uuid.NewString(), relOne, "Karim", "+93700000401")
	evOne.entry(relOne, "debt", "800")
	evOne.entry(relOne, "payment", "300")
	evTwo := newOutreachEvents(t, pool, vaultTwo)
	evTwo.pms = evOne.pms + 3_600_000                                        // the second shop's tallies are an hour later
	evTwo.person(uuid.NewString(), relTwo, "Karim Sahib", "+93 700 000 401") // same number, other format
	evTwo.entry(relTwo, "debt", "150")

	res, err := NewService(pool, nil, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	c := findOutreach(t, res, "+93700000401")
	if c.Kind != "customer" || c.Shopkeeper != nil || c.Customer == nil {
		t.Fatalf("merged contact wrong: %+v", c)
	}
	cu := c.Customer
	if len(cu.Listings) != 2 {
		t.Fatalf("both shops must list the number: %+v", cu)
	}
	first, second := cu.Listings[0], cu.Listings[1]
	if first.VaultID != vaultTwo || second.VaultID != vaultOne || first.LastTallyAt <= second.LastTallyAt {
		t.Fatalf("listings must be last-tally desc: %+v", cu.Listings)
	}
	if c.Name != "Karim Sahib" || first.PersonName != "Karim Sahib" || second.PersonName != "Karim" {
		t.Fatalf("name must come from the first listing: %q %+v", c.Name, cu.Listings)
	}
	if first.VaultName != "Second Shop" || first.OwnerName != "Owner Two" || first.OwnerPhone != "+93790000012" ||
		second.VaultName != "First Shop" || second.OwnerName != "Owner One" || second.OwnerPhone != "+93790000011" {
		t.Fatalf("listing owners wrong: %+v", cu.Listings)
	}
	if first.Balance != "150.00" || first.Role != "customer" || first.Tallies != 1 ||
		second.Balance != "500.00" || second.Role != "customer" || second.Tallies != 2 {
		t.Fatalf("per-shop balances wrong: %+v", cu.Listings)
	}
	if cu.MentionCount != 2 || !cu.IsWholesaler || cu.IsSupplierAnywhere || !cu.IsCustomerAnywhere ||
		cu.ArchivedEverywhere || cu.TalliesTotal != 3 {
		t.Fatalf("customer block wrong (wholesaler by mention count alone): %+v", cu)
	}
	if cu.LastTallyAt != first.LastTallyAt || cu.FirstAddedAt != second.FirstAddedAt {
		t.Fatalf("customer timeline wrong: %+v", cu)
	}
	if res.Counts.Wholesalers != 1 || res.Counts.Customers != 1 || res.Counts.Shopkeepers != 2 || res.Counts.Total != 3 {
		t.Fatalf("counts wrong: %+v", res.Counts)
	}
}

// ---------- linked listings: a relationship bound to a mutual tab ----------

func TestGetOutreachFlagsLinkedListings(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	l := seedOutreachLedger(t, pool)
	var tabID string
	if err := pool.QueryRow(ctx, `INSERT INTO tabs (currency) VALUES ('AFN') RETURNING id::text`).Scan(&tabID); err != nil {
		t.Fatalf("seed tab: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tab_parties (tab_id, role, label, token_hash, vault_id, relationship_id, joined_at, last_seen_at)
		VALUES ($1::uuid, 'a', 'Ahmad', $2, $3::uuid, $4::uuid, NOW(), NOW())
	`, tabID, uuid.NewString(), l.vault, l.relA); err != nil {
		t.Fatalf("seed party a: %v", err)
	}
	// The invitee's party is unbound: NULL vault/relationship rows flag nothing.
	if _, err := pool.Exec(ctx, `
		INSERT INTO tab_parties (tab_id, role, label, token_hash) VALUES ($1::uuid, 'b', '', $2)
	`, tabID, uuid.NewString()); err != nil {
		t.Fatalf("seed party b: %v", err)
	}
	res, err := NewService(pool, nil, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	a := findOutreach(t, res, "+93700000103").Customer.Listings[0]
	if !a.Linked {
		t.Fatalf("A's relationship is bound to a tab party: %+v", a)
	}
	// The link does not change the fold: the balance is still the local rows only.
	if a.Balance != "300.00" || a.Tallies != 2 {
		t.Fatalf("linked listing must keep the local fold: %+v", a)
	}
	if b := findOutreach(t, res, "+93700000102").Customer.Listings[0]; b.Linked {
		t.Fatalf("B is not bound to any tab: %+v", b)
	}
}

// ---------- case 4: a number that is both a shopkeeper and a customer ----------

func TestGetOutreachKindBothWithLedgerAggregates(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	l := seedOutreachLedger(t, pool)
	seedOutreachInstall(t, pool, &l.owner, "2026-09-02T10:00:00Z", "+93700000102", "Owner One", "Corner Shop")
	res, err := NewService(pool, nil, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	c := findOutreach(t, res, "+93700000102")
	if c.Kind != "both" || c.Shopkeeper == nil || c.Customer == nil || c.Name != "Owner One" ||
		c.ShopName != "Corner Shop" {
		t.Fatalf("both contact wrong: %+v", c)
	}
	sk := c.Shopkeeper
	if !sk.SignedIn || sk.AccountID != l.owner || sk.InstallCount != 1 || len(sk.Kaatas) != 1 {
		t.Fatalf("shopkeeper block wrong: %+v", sk)
	}
	k := sk.Kaatas[0]
	if k.VaultID != l.vault || k.Name != "Corner Shop" || k.Currency != "AFN" || k.Role != "owner" ||
		k.Archived || k.MemberCount != 1 {
		t.Fatalf("kaata identity wrong: %+v", k)
	}
	if k.People != 1 || k.Tallies != 4 || k.Receivable != "300.00" || k.Payable != "300.00" || k.LastTallyAt == "" {
		t.Fatalf("kaata aggregates wrong: %+v", k)
	}
	if sk.People != 1 || sk.Tallies != 4 || sk.ReceivableTotal != "300.00" || sk.PayableTotal != "300.00" ||
		sk.Currency != "AFN" || sk.LastTallyAt != k.LastTallyAt {
		t.Fatalf("shopkeeper totals wrong: %+v", sk)
	}
	if c.Customer.Listings[0].Role != "supplier" || !c.Customer.IsWholesaler {
		t.Fatalf("customer half lost: %+v", c.Customer)
	}
	if res.Counts.Both != 1 || res.Counts.Shopkeepers != 1 || res.Counts.Customers != 1 || res.Counts.Total != 3 {
		t.Fatalf("counts wrong: %+v", res.Counts)
	}
	// Order: shopkeeper, both, customer.
	if res.Contacts[0].Kind != "shopkeeper" || res.Contacts[1].Kind != "both" || res.Contacts[2].Kind != "customer" {
		t.Fatalf("order wrong: %s %s %s", res.Contacts[0].Kind, res.Contacts[1].Kind, res.Contacts[2].Kind)
	}
}

// ---------- case 5: operator exclusion ----------

func TestGetOutreachExcludesOperator(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	op := seedOutreachAccount(t, pool, "Operator", "+93700000900")
	opVault := seedOutreachVault(t, pool, op, "Operator Shop", "AFN")
	ev := newOutreachEvents(t, pool, opVault)
	ev.person(uuid.NewString(), uuid.NewString(), "Op Customer", "+93700000901")
	seedOutreachInstall(t, pool, &op, "2026-09-02T10:00:00Z", "+93700000902", "Operator", "")
	// A real shopkeeper who happens to be a member of the operator's vault.
	shop := seedOutreachAccount(t, pool, "Real Shop", "+93700000903")
	seedOutreachMember(t, pool, opVault, shop, "editor")

	res, err := NewService(pool, []string{op}, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, ph := range []string{"+93700000900", "+93700000901", "+93700000902"} {
		if hasOutreach(res, ph) {
			t.Fatalf("operator-derived number %s leaked", ph)
		}
	}
	real := findOutreach(t, res, "+93700000903")
	if len(real.Shopkeeper.Kaatas) != 0 || res.Counts.Total != 1 {
		t.Fatalf("operator vault must not appear under a member: %+v / %+v", real.Shopkeeper, res.Counts)
	}
	// Sanity: without the allowlist the same rows are visible.
	all, err := NewService(pool, nil, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !hasOutreach(all, "+93700000900") || !hasOutreach(all, "+93700000901") || !hasOutreach(all, "+93700000902") ||
		len(findOutreach(t, all, "+93700000903").Shopkeeper.Kaatas) != 1 {
		t.Fatalf("unfiltered report missing operator rows: %+v", all.Counts)
	}
}

// ---------- case 6: mark ----------

func TestOutreachMark(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	phone := "+93700000201"

	st, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Contacted: true, TemplateKey: "template.shopkeeper.fa"})
	if err != nil {
		t.Fatal(err)
	}
	if len(st) != 1 || st[0].Phone != phone || st[0].Status != "sent" || st[0].ContactCount != 1 ||
		st[0].ContactedAt != "2026-09-10T08:00:00Z" || st[0].FirstContactedAt != "2026-09-10T08:00:00Z" ||
		st[0].RepliedAt != "" || st[0].UpdatedAt != "2026-09-10T08:00:00Z" {
		t.Fatalf("first contact state wrong: %+v", st)
	}
	if len(st[0].Touches) != 1 || st[0].Touches[0].Kind != "sent" || st[0].Touches[0].Detail != "template.shopkeeper.fa" ||
		st[0].Touches[0].At != "2026-09-10T08:00:00Z" {
		t.Fatalf("sent touch wrong: %+v", st[0].Touches)
	}

	clock = clock.Add(time.Hour)
	st, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Contacted: true})
	if err != nil {
		t.Fatal(err)
	}
	if st[0].ContactCount != 2 || st[0].ContactedAt != "2026-09-10T09:00:00Z" || st[0].FirstContactedAt != "2026-09-10T08:00:00Z" ||
		st[0].Status != "sent" {
		t.Fatalf("second contact state wrong: %+v", st[0])
	}

	clock = clock.Add(time.Hour)
	st, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Replied: true})
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Status != "replied" || st[0].RepliedAt != "2026-09-10T10:00:00Z" || st[0].ContactCount != 2 {
		t.Fatalf("replied state wrong: %+v", st[0])
	}

	declined := "declined"
	st, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Status: &declined})
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Status != "declined" {
		t.Fatalf("explicit status not applied: %+v", st[0])
	}
	// contacted again with an explicit status keeps that status.
	st, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Contacted: true, Status: &declined})
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Status != "declined" || st[0].ContactCount != 3 {
		t.Fatalf("contacted+status wrong: %+v", st[0])
	}

	first, second := "first note", "second note "+strings.Repeat("x", 300)
	if st, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Note: &first}); err != nil {
		t.Fatal(err)
	}
	if st[0].Note != "first note" {
		t.Fatalf("note not set: %+v", st[0])
	}
	if st, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Note: &second}); err != nil {
		t.Fatal(err)
	}
	if st[0].Note != second {
		t.Fatalf("note not replaced: %q", st[0].Note)
	}
	kinds := make([]string, 0, len(st[0].Touches))
	for _, tc := range st[0].Touches {
		kinds = append(kinds, tc.Kind)
	}
	if got, want := strings.Join(kinds, ","), "note,note,status,sent,status,replied,sent,sent"; got != want {
		t.Fatalf("touches newest-first = %s want %s", got, want)
	}
	if st[0].Touches[0].Detail != clampRunes(second, 200) || len([]rune(st[0].Touches[0].Detail)) != 200 {
		t.Fatalf("note touch detail must be the first 200 runes: %q", st[0].Touches[0].Detail)
	}
	if st[0].Touches[2].Detail != "declined" {
		t.Fatalf("status touch detail wrong: %+v", st[0].Touches[2])
	}

	// Handler level: exact 400s, a real 200, body limit and dedupe.
	h := NewHandler(svc)
	if rec := postOutreach(h.OutreachMark, `{"phones":["+93700000201"],"status":"bogus"}`); rec.Code != 400 || outreachError(t, rec) != "invalid status" {
		t.Fatalf("invalid status: %d %s", rec.Code, rec.Body.String())
	}
	if rec := postOutreach(h.OutreachMark, `{"phones":["+93700000201","abc"]}`); rec.Code != 400 || outreachError(t, rec) != "invalid phone" {
		t.Fatalf("invalid phone: %d %s", rec.Code, rec.Body.String())
	}
	if rec := postOutreach(h.OutreachMark, `{"phones":[]}`); rec.Code != 400 || outreachError(t, rec) != "invalid phone" {
		t.Fatalf("empty phones: %d %s", rec.Code, rec.Body.String())
	}
	if rec := postOutreach(h.OutreachMark, `{"status":"sent"}`); rec.Code != 400 || outreachError(t, rec) != "invalid phone" {
		t.Fatalf("missing phones: %d %s", rec.Code, rec.Body.String())
	}
	if rec := postOutreach(h.OutreachMark, `{"phones":`); rec.Code != 400 {
		t.Fatalf("malformed json: %d %s", rec.Code, rec.Body.String())
	}
	if rec := postOutreach(h.OutreachMark, `{"phones":["+93700000201"],"note":"`+strings.Repeat("x", 70000)+`"}`); rec.Code != 400 {
		t.Fatalf("64 KiB body limit not enforced: %d", rec.Code)
	}
	rec := postOutreach(h.OutreachMark, `{"phones":["+93 700 000 202","+93700000202"],"contacted":true,"template_key":"template.customer.en"}`)
	if rec.Code != 200 {
		t.Fatalf("mark: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Updated []OutreachState `json:"updated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Updated) != 1 || out.Updated[0].Phone != "+93700000202" || out.Updated[0].Status != "sent" ||
		out.Updated[0].ContactCount != 1 || out.Updated[0].Touches[0].Detail != "template.customer.en" {
		t.Fatalf("handler mark response wrong (duplicates must collapse to one tick): %+v", out.Updated)
	}
	// "replied" with no status leaves an explicit terminal status alone.
	rec = postOutreach(h.OutreachMark, `{"phones":["+93700000201"],"replied":true}`)
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != 200 {
		t.Fatalf("replied: %d %s", rec.Code, rec.Body.String())
	}
	if out.Updated[0].Status != "declined" || out.Updated[0].RepliedAt != "2026-09-10T10:00:00Z" {
		t.Fatalf("replied must not override declined: %+v", out.Updated[0])
	}

	// Row locks are taken in sorted order, but the response follows the
	// request: an unsorted bulk mark comes back in the order it was sent.
	unsorted := []string{"+93700000205", "+93700000203", "+93700000204", "+93700000201"}
	st, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: unsorted, Contacted: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(st) != len(unsorted) {
		t.Fatalf("bulk mark returned %d states for %d phones", len(st), len(unsorted))
	}
	for i, ph := range unsorted {
		if st[i].Phone != ph {
			t.Fatalf("response order differs from request at %d: got %s want %s (%+v)", i, st[i].Phone, ph, st)
		}
	}
	if st[3].ContactCount != 4 || st[3].Status != "declined" || st[0].ContactCount != 1 || st[0].Status != "sent" {
		t.Fatalf("bulk mark states wrong: %+v", st)
	}
	rec = postOutreach(h.OutreachMark, `{"phones":["+93700000205","+93700000203"],"replied":true}`)
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != 200 {
		t.Fatalf("bulk replied: %d %s", rec.Code, rec.Body.String())
	}
	if len(out.Updated) != 2 || out.Updated[0].Phone != "+93700000205" || out.Updated[1].Phone != "+93700000203" {
		t.Fatalf("handler response must keep the request order: %+v", out.Updated)
	}

	// declined and do_not_contact both land in Counts.Declined; only numbers
	// with a source row are listed and counted at all.
	dnc := "do_not_contact"
	if st, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{"+93700000203"}, Status: &dnc}); err != nil || st[0].Status != "do_not_contact" {
		t.Fatalf("do_not_contact not applied: %+v %v", st, err)
	}
	seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", "+93700000201", "Declined", "")
	seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", "+93700000203", "Do Not Contact", "")
	res, err := svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if c := findOutreach(t, res, "+93700000203"); c.Outreach.Status != "do_not_contact" {
		t.Fatalf("GET must carry do_not_contact: %+v", c.Outreach)
	}
	if res.Counts.Declined != 2 || res.Counts.Total != 2 || res.Counts.ToContact != 0 || res.Counts.Sent != 0 {
		t.Fatalf("declined + do_not_contact must both count as declined: %+v", res.Counts)
	}
}

// A NUL in a note, template key or setting value is dropped before it reaches
// a TEXT column (Postgres rejects it with 22021), so the POST still answers 200.
func TestOutreachMarkStripsNUL(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	h := NewHandler(svc)
	rec := postOutreach(h.OutreachMark, `{"phones":["+93700000206"],"contacted":true,"template_key":"template.\u0000customer.en","note":"a\u0000b"}`)
	if rec.Code != 200 {
		t.Fatalf("note with NUL: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Updated []OutreachState `json:"updated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Updated) != 1 {
		t.Fatalf("decode mark response: %v %s", err, rec.Body.String())
	}
	if out.Updated[0].Note != "ab" {
		t.Fatalf("note must lose the NUL: %q", out.Updated[0].Note)
	}
	if len(out.Updated[0].Touches) != 2 || out.Updated[0].Touches[0].Detail != "ab" ||
		out.Updated[0].Touches[1].Detail != "template.customer.en" {
		t.Fatalf("touch details must lose the NUL too: %+v", out.Updated[0].Touches)
	}
	var note string
	if err := pool.QueryRow(ctx, `SELECT note FROM outreach_contacts WHERE phone_e164 = $1`, "+93700000206").Scan(&note); err != nil {
		t.Fatal(err)
	}
	if note != "ab" || strings.ContainsRune(note, 0) {
		t.Fatalf("stored note = %q want %q", note, "ab")
	}

	rec = postOutreach(h.OutreachSetting, `{"key":"template.customer.en","value":"x\u0000y"}`)
	if rec.Code != 200 {
		t.Fatalf("setting with NUL: %d %s", rec.Code, rec.Body.String())
	}
	var body OutreachSetting
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Value != "xy" {
		t.Fatalf("setting response wrong: %+v %v", body, err)
	}
	var stored string
	if err := pool.QueryRow(ctx, `SELECT value FROM outreach_settings WHERE key = $1`, "template.customer.en").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "xy" || strings.ContainsRune(stored, 0) {
		t.Fatalf("stored setting = %q want %q", stored, "xy")
	}
}

// ---------- case 7: converted + follow-up due ----------

func TestGetOutreachConvertedAndFollowUpDue(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	t0 := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return t0 }
	fresh, stale := "+93700000301", "+93700000302"
	seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", stale, "Stale", "")
	if _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{fresh, stale}, Contacted: true}); err != nil {
		t.Fatal(err)
	}
	res, err := svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if hasOutreach(res, fresh) {
		t.Fatal("a contacted number with no source row is not listed")
	}
	if res.Counts.SentToday != 2 || res.Counts.RepliedToday != 0 {
		t.Fatalf("sent_today should count both ticks on the Kabul day: %+v", res.Counts)
	}
	if c := findOutreach(t, res, stale); c.Converted || c.FollowUpDue || c.Outreach.Status != "sent" {
		t.Fatalf("install before contact is not a conversion: %+v", c)
	}

	seedOutreachInstall(t, pool, nil, "2026-09-11T09:00:00Z", fresh, "Fresh", "")
	res, err = svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	c := findOutreach(t, res, fresh)
	if !c.Converted || c.FollowUpDue || c.Outreach.ContactedAt != "2026-09-10T08:00:00Z" {
		t.Fatalf("install after contact must read converted, not yet due: %+v", c)
	}
	if res.Counts.Converted != 1 || res.Counts.FollowUpsDue != 0 || res.Counts.Sent != 2 {
		t.Fatalf("counts wrong: %+v", res.Counts)
	}

	svc.now = func() time.Time { return t0.Add(72 * time.Hour) }
	res, err = svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if c := findOutreach(t, res, fresh); !c.FollowUpDue || !c.Converted {
		t.Fatalf("48 h without a reply is a follow-up: %+v", c)
	}
	if res.Counts.FollowUpsDue != 2 || res.Counts.SentToday != 0 {
		t.Fatalf("counts three days later wrong: %+v", res.Counts)
	}

	if _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{fresh}, Replied: true}); err != nil {
		t.Fatal(err)
	}
	res, err = svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if c := findOutreach(t, res, fresh); c.FollowUpDue || c.Outreach.Status != "replied" || !c.Converted {
		t.Fatalf("a reply ends the follow-up: %+v", c)
	}
	if res.Counts.FollowUpsDue != 1 || res.Counts.Replied != 1 || res.Counts.RepliedToday != 1 {
		t.Fatalf("counts after reply wrong: %+v", res.Counts)
	}
}

// ---------- case 8: settings ----------

func TestOutreachSettings(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	svc.now = func() time.Time { return activityTime(t, "2026-09-10T08:00:00Z") }
	h := NewHandler(svc)

	got, err := svc.SetOutreachSetting(ctx, "template.shopkeeper.en", "Salaam {name}.\n{link}")
	if err != nil {
		t.Fatal(err)
	}
	if got.Key != "template.shopkeeper.en" || got.Value != "Salaam {name}.\n{link}" || got.UpdatedAt != "2026-09-10T08:00:00Z" {
		t.Fatalf("save wrong: %+v", got)
	}
	if got, err = svc.SetOutreachSetting(ctx, "template.shopkeeper.en", "changed"); err != nil || got.Value != "changed" {
		t.Fatalf("overwrite wrong: %+v %v", got, err)
	}
	rec := postOutreach(h.OutreachSetting, `{"key":"slug.customer","value":"wa-cust"}`)
	if rec.Code != 200 {
		t.Fatalf("setting: %d %s", rec.Code, rec.Body.String())
	}
	var body OutreachSetting
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Key != "slug.customer" || body.Value != "wa-cust" || body.UpdatedAt == "" {
		t.Fatalf("setting response wrong: %+v %v", body, err)
	}
	res, err := svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Settings["template.shopkeeper.en"] != "changed" || res.Settings["slug.customer"] != "wa-cust" || len(res.Settings) != 2 {
		t.Fatalf("settings not in GET: %+v", res.Settings)
	}

	if got, err = svc.SetOutreachSetting(ctx, "template.shopkeeper.en", "  \n "); err != nil ||
		got.Key != "template.shopkeeper.en" || got.Value != "" || got.UpdatedAt != "" {
		t.Fatalf("delete-by-empty wrong: %+v %v", got, err)
	}
	if res, err = svc.GetOutreach(ctx); err != nil || len(res.Settings) != 1 || res.Settings["slug.customer"] != "wa-cust" {
		t.Fatalf("deleted setting still present: %+v %v", res.Settings, err)
	}

	for _, bad := range []string{`{"key":"Bad Key","value":"x"}`, `{"key":"a.b.c.d","value":"x"}`, `{"key":"","value":"x"}`, `{"value":"x"}`, `{"key":"template.shopkeeper.e-n","value":"x"}`} {
		if rec := postOutreach(h.OutreachSetting, bad); rec.Code != 400 || outreachError(t, rec) != "invalid key" {
			t.Fatalf("invalid key %s: %d %s", bad, rec.Code, rec.Body.String())
		}
	}
	if rec := postOutreach(h.OutreachSetting, `{"key":"slug.customer"}`); rec.Code != 200 {
		t.Fatalf("missing value deletes: %d %s", rec.Code, rec.Body.String())
	}
	if res, err = svc.GetOutreach(ctx); err != nil || len(res.Settings) != 0 {
		t.Fatalf("settings should be empty: %+v %v", res.Settings, err)
	}
}
