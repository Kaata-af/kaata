package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
		// A valid number takes its libphonenumber E.164 form: the trunk-zero
		// twin is the same key as the plain number, in any country.
		{"+930700000001", "+93700000001", true},
		{"+93 0700 000 001", "+93700000001", true},
		{"+61 412 345 678", "+61412345678", true},
		{"+61 0412 345 678", "+61412345678", true},
		{"+930201234567", "+930201234567", true}, // invalid (Kabul takes [2-9] after 20): digits kept, not guessed at
		{"+98 0 9601", "+9809601", true},         // valid, but E.164 "+989601" is 6 digits: digits kept
	}
	for _, tc := range cases {
		got, ok := normalizeOutreachPhone(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("normalizeOutreachPhone(%q) = %q,%v want %q,%v", tc.in, got, ok, tc.want, tc.ok)
		}
		// A key goes back out to the page and comes back in a POST body, so
		// it must normalize to itself.
		if ok {
			if again, ok2 := normalizeOutreachPhone(got); again != got || !ok2 {
				t.Errorf("normalizeOutreachPhone(%q) = %q,%v; not idempotent", got, again, ok2)
			}
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

// Review fix (2026-09-30): a number typed with the trunk zero after the
// country code and the same number without it are ONE contact, one key and
// one outreach row, whichever form the source row or the POST body carries.
func TestGetOutreachMergesTrunkZeroTwins(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	h := NewHandler(svc)
	install := seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", "+930700000001", "Twin Shop", "")
	owner := seedOutreachAccount(t, pool, "Book Owner", "")
	vault := seedOutreachVault(t, pool, owner, "Twin Book", "AFN")
	ev := newOutreachEvents(t, pool, vault)
	ev.person(uuid.NewString(), uuid.NewString(), "Twin Customer", "+93700000001")
	rec := postOutreach(h.OutreachOutcome, `{"phone":"+93 0700 000 001","outcome":"opened"}`)
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"state":{"phone":"+93700000001"`) {
		t.Fatalf("opened on the twin must key the canonical row: %d %s", rec.Code, rec.Body.String())
	}
	res, err := svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Counts.Total != 1 || res.Counts.Both != 1 || len(res.Contacts) != 1 {
		t.Fatalf("the twins must merge into one contact: %+v", res.Counts)
	}
	c := res.Contacts[0]
	if c.Phone != "+93700000001" || c.Kind != "both" || c.Shopkeeper == nil || c.Customer == nil ||
		strings.Join(c.Shopkeeper.InstallIDs, ",") != install || len(c.Customer.Listings) != 1 ||
		c.Customer.Listings[0].VaultID != vault || c.Name != "Twin Shop" {
		t.Fatalf("merged contact wrong: %+v", c)
	}
	if c.Outreach.OpenCount != 1 || c.Outreach.PendingSince == "" || !c.Number.Valid || c.Number.National != "070 000 0001" {
		t.Fatalf("merged contact must carry the one outreach row: %+v %+v", c.Outreach, c.Number)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM outreach_contacts`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("one outreach row expected: %d %v", rows, err)
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

	st, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Contacted: true, TemplateKey: "template.shopkeeper.fa"})
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

	// A second bulk "Mark sent" on a row that is already sent is skipped
	// whole: no count, no touch, no version bump. A real second message is the
	// version-checked outcome `sent`, which runs the same write.
	clock = clock.Add(time.Hour)
	st, skipped, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Contacted: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(skipped, ",") != phone || st[0].ContactCount != 1 || st[0].Version != 1 ||
		st[0].ContactedAt != "2026-09-10T08:00:00Z" || len(st[0].Touches) != 1 {
		t.Fatalf("repeat bulk send must be skipped: %+v skipped=%v", st[0], skipped)
	}
	v1 := int64(1)
	again, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: phone, Outcome: "sent", ExpectedVersion: &v1})
	if err != nil {
		t.Fatal(err)
	}
	if again.ContactCount != 2 || again.ContactedAt != "2026-09-10T09:00:00Z" || again.FirstContactedAt != "2026-09-10T08:00:00Z" ||
		again.Status != "sent" {
		t.Fatalf("second contact state wrong: %+v", again)
	}

	clock = clock.Add(time.Hour)
	st, _, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Replied: true})
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Status != "replied" || st[0].RepliedAt != "2026-09-10T10:00:00Z" || st[0].ContactCount != 2 {
		t.Fatalf("replied state wrong: %+v", st[0])
	}

	declined := "declined"
	st, _, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Status: &declined})
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Status != "declined" {
		t.Fatalf("explicit status not applied: %+v", st[0])
	}
	// A contacted mark on a declined row is skipped whole. A status never
	// rides with contacted or replied (the handler refuses that body:
	// TestOutreachMarkRefusesStatusCombos), so a send and then a relabel are
	// two marks.
	st, skipped, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Contacted: true})
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Status != "declined" || st[0].ContactCount != 2 || strings.Join(skipped, ",") != phone {
		t.Fatalf("contacted on a declined row must be skipped: %+v skipped=%v", st[0], skipped)
	}
	interested := "interested"
	if _, skipped, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{"+93700000207"}, Contacted: true}); err != nil || len(skipped) != 0 {
		t.Fatalf("first send: %v skipped=%v", err, skipped)
	}
	fresh, skipped, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{"+93700000207"}, Status: &interested})
	if err != nil {
		t.Fatal(err)
	}
	if fresh[0].Status != "interested" || fresh[0].ContactCount != 1 || len(skipped) != 0 {
		t.Fatalf("send, then status: %+v skipped=%v", fresh[0], skipped)
	}

	first, second := "first note", "second note "+strings.Repeat("x", 300)
	if st, _, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Note: &first}); err != nil {
		t.Fatal(err)
	}
	if st[0].Note != "first note" {
		t.Fatalf("note not set: %+v", st[0])
	}
	if st, _, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Note: &second}); err != nil {
		t.Fatal(err)
	}
	if st[0].Note != second {
		t.Fatalf("note not replaced: %q", st[0].Note)
	}
	kinds := make([]string, 0, len(st[0].Touches))
	for _, tc := range st[0].Touches {
		kinds = append(kinds, tc.Kind)
	}
	if got, want := strings.Join(kinds, ","), "note,note,status,replied,sent,sent"; got != want {
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
	st, skipped, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: unsorted, Contacted: true})
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
	// The declined row is reported, not counted: still its two messages.
	if st[3].ContactCount != 2 || st[3].Status != "declined" || st[0].ContactCount != 1 || st[0].Status != "sent" ||
		strings.Join(skipped, ",") != "+93700000201" {
		t.Fatalf("bulk mark states wrong: %+v skipped=%v", st, skipped)
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
	if st, _, err = svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{"+93700000203"}, Status: &dnc}); err != nil || st[0].Status != "do_not_contact" {
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
	if _, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{fresh, stale}, Contacted: true}); err != nil {
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

	if _, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{fresh}, Replied: true}); err != nil {
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

// ---------- batch 2 (2026-09-30), case 1: number plausibility ----------

func TestDescribeOutreachNumber(t *testing.T) {
	cases := []struct {
		in                    string
		valid, possible       bool
		typ, region, national string
	}{
		{"+93700000001", true, true, "mobile", "AF", "070 000 0001"},
		{"+9370000", false, false, "unknown", "AF", "70000"}, // too short for any AF pattern; the region is still known
		{"+000123456", false, false, "unknown", "", ""},      // no such country code: parse error
		{"+61412345678", true, true, "mobile", "AU", "0412 345 678"},
		{"+93202345678", true, true, "fixed_line", "AF", "020 234 5678"}, // Kabul landline
		// Possible (the right length) is not valid: Kabul numbers take [2-9]
		// after the 20 area code and "1" is not in the plan.
		{"+93201234567", false, true, "unknown", "AF", "020 123 4567"},
		// A "00" trunk prefix survives normalization and has no country code.
		{"+0061412345678", false, false, "unknown", "", ""},
		// Non-geographic (+800 freephone): libphonenumber's region "001" is no
		// country, so it is reported as "".
		{"+80012345678", true, true, "toll_free", "", "1234 5678"},
	}
	for _, tc := range cases {
		got := describeOutreachNumber(tc.in)
		want := OutreachNumber{Valid: tc.valid, Possible: tc.possible, Type: tc.typ, Region: tc.region, National: tc.national}
		if got != want {
			t.Errorf("describeOutreachNumber(%q) = %+v want %+v", tc.in, got, want)
		}
	}
}

func TestGetOutreachEmitsNumberAndBatch2Fields(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	valid := seedOutreachInstall(t, pool, nil, "2026-09-03T10:00:00Z", "+93700000001", "Valid", "")
	seedOutreachInstall(t, pool, nil, "2026-09-02T10:00:00Z", "+9370000", "Short", "")
	seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", "+000123456", "Nowhere", "")
	res, err := NewService(pool, nil, nil).GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	c := findOutreach(t, res, "+93700000001")
	if n := c.Number; !n.Valid || !n.Possible || n.Type != "mobile" || n.Region != "AF" || n.National != "070 000 0001" {
		t.Fatalf("valid AF mobile described wrong: %+v", n)
	}
	if n := findOutreach(t, res, "+9370000").Number; n.Valid || n.Possible || n.Type != "unknown" || n.Region != "AF" {
		t.Fatalf("short AF number described wrong: %+v", n)
	}
	if n := findOutreach(t, res, "+000123456").Number; n.Valid || n.Possible || n.Type != "unknown" || n.Region != "" || n.National != "" {
		t.Fatalf("unparsable number described wrong: %+v", n)
	}
	if res.Counts.Invalid != 2 || res.Counts.Total != 3 || res.Counts.Pending != 0 || res.Counts.Unreachable != 0 || res.Counts.OpenedToday != 0 {
		t.Fatalf("counts wrong: %+v", res.Counts)
	}
	if len(c.Shopkeeper.InstallIDs) != 1 || c.Shopkeeper.InstallIDs[0] != valid {
		t.Fatalf("install_ids wrong: %+v", c.Shopkeeper.InstallIDs)
	}
	if res.Exclusions == nil || len(res.Exclusions) != 0 {
		t.Fatalf("exclusions must be [] not null: %#v", res.Exclusions)
	}
	if c.Outreach.Version != 0 || c.Outreach.PendingSince != "" || c.Outreach.OpenedAt != "" || c.Outreach.SkippedAt != "" || c.Outreach.OpenCount != 0 ||
		!c.Outreach.NeverMessaged {
		t.Fatalf("absent row must read as version 0, never messaged, with empty batch-2 fields: %+v", c.Outreach)
	}
	// The wire tags the web reads, pinned on the serialized result.
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"number":{"valid":true,"possible":true,"type":"mobile","region":"AF","national":"070 000 0001"}`,
		`"install_ids":["` + valid + `"]`,
		`"opened_at":"","pending_since":"","skipped_at":"","open_count":0,"version":0,"touches":[]`,
		`"contact_count":0,"never_messaged":true`,
		`"exclusions":[]`,
		`"pending":0,"unreachable":0,"invalid":2,"opened_today":0`,
	} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("GET JSON lacks %s:\n%s", want, raw)
		}
	}
}

// ---------- batch 2, case 2: the outcome flow ----------

func TestOutreachOutcomeFlow(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	phone := "+93700000501"
	ver := func(v int64) *int64 { return &v }
	outcome := func(kind string, expected *int64, key, reason string) OutreachState {
		t.Helper()
		st, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{
			Phone: phone, Outcome: kind, TemplateKey: key, Reason: reason, ExpectedVersion: expected,
		})
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		return st
	}
	refused := func(kind string, expected *int64, want error) {
		t.Helper()
		_, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: phone, Outcome: kind, ExpectedVersion: expected})
		if !errors.Is(err, want) {
			t.Fatalf("%s: err = %v want %v", kind, err, want)
		}
	}
	stored := func() OutreachState {
		t.Helper()
		states, err := readOutreachStates(ctx, pool, []string{phone})
		if err != nil {
			t.Fatal(err)
		}
		if states[phone] == nil {
			t.Fatal("row missing")
		}
		return states[phone].state
	}

	// Opening records opened, never sent.
	st := outcome("opened", nil, "template.customer.fa", "")
	if st.Status != "new" || st.ContactCount != 0 || st.OpenCount != 1 || st.Version != 1 ||
		st.OpenedAt != "2026-09-10T08:00:00Z" || st.PendingSince != "2026-09-10T08:00:00Z" || st.ContactedAt != "" {
		t.Fatalf("first open wrong: %+v", st)
	}
	if len(st.Touches) != 1 || st.Touches[0].Kind != "opened" || st.Touches[0].Detail != "template.customer.fa" {
		t.Fatalf("opened touch wrong: %+v", st.Touches)
	}
	// Reopening keeps pending_since (when it was FIRST opened) and counts.
	clock = clock.Add(10 * time.Minute)
	st = outcome("opened", nil, "template.customer.fa", "")
	if st.OpenCount != 2 || st.Version != 2 || st.PendingSince != "2026-09-10T08:00:00Z" || st.OpenedAt != "2026-09-10T08:10:00Z" {
		t.Fatalf("reopen wrong: %+v", st)
	}
	// Sent with the current version: the mark path, so counters match bulk marks.
	clock = clock.Add(10 * time.Minute)
	st = outcome("sent", ver(2), "template.customer.fa", "")
	if st.Status != "sent" || st.ContactCount != 1 || st.Version != 3 || st.PendingSince != "" ||
		st.ContactedAt != "2026-09-10T08:20:00Z" || st.FirstContactedAt != "2026-09-10T08:20:00Z" || st.Touches[0].Kind != "sent" {
		t.Fatalf("sent wrong: %+v", st)
	}
	// The double-count guard: the same click again, with the version it had.
	refused("sent", ver(2), ErrOutreachStale)
	if got := stored(); got.ContactCount != 1 || got.Version != 3 || len(got.Touches) != 3 {
		t.Fatalf("stale sent must write nothing: %+v", got)
	}
	// Not on WhatsApp clears the pending window.
	clock = clock.Add(10 * time.Minute)
	st = outcome("opened", ver(3), "", "")
	if st.Version != 4 || st.OpenCount != 3 || st.PendingSince != "2026-09-10T08:30:00Z" {
		t.Fatalf("third open wrong: %+v", st)
	}
	st = outcome("no_whatsapp", ver(4), "", "")
	if st.Status != "no_whatsapp" || st.PendingSince != "" || st.Version != 5 ||
		st.Touches[0].Kind != "status" || st.Touches[0].Detail != "no_whatsapp" {
		t.Fatalf("no_whatsapp wrong: %+v", st)
	}
	// Retry reopens an unreachable contact.
	st = outcome("retry", ver(5), "", "wrong number typed")
	if st.Status != "new" || st.Version != 6 || st.Touches[0].Kind != "retry" || st.Touches[0].Detail != "wrong number typed" {
		t.Fatalf("retry wrong: %+v", st)
	}
	// Skip for now: parked, pending cleared, status untouched.
	clock = clock.Add(10 * time.Minute)
	outcome("opened", ver(6), "", "")
	clock = clock.Add(10 * time.Minute)
	st = outcome("skip", ver(7), "", "busy")
	if st.Status != "new" || st.SkippedAt != "2026-09-10T08:50:00Z" || st.PendingSince != "" || st.Version != 8 ||
		st.Touches[0].Kind != "skipped" || st.Touches[0].Detail != "busy" {
		t.Fatalf("skip wrong: %+v", st)
	}
	// A send clears the skip too.
	clock = clock.Add(10 * time.Minute)
	st = outcome("sent", ver(8), "template.customer.en", "")
	if st.Status != "sent" || st.SkippedAt != "" || st.ContactCount != 2 || st.Version != 9 ||
		st.ContactedAt != "2026-09-10T09:00:00Z" || st.FirstContactedAt != "2026-09-10T08:20:00Z" {
		t.Fatalf("second sent wrong: %+v", st)
	}
	// Retry is only for unreachable contacts.
	refused("retry", ver(9), ErrOutreachNotRetryable)
	if got := stored(); got.Status != "sent" || got.Version != 9 {
		t.Fatalf("refused retry must write nothing: %+v", got)
	}
	st = outcome("invalid", ver(9), "", "")
	if st.Status != "invalid" || st.Version != 10 || st.Touches[0].Detail != "invalid" {
		t.Fatalf("invalid wrong: %+v", st)
	}
	st = outcome("retry", nil, "", "") // no expected_version: unchecked
	if st.Status != "new" || st.Version != 11 {
		t.Fatalf("unchecked retry wrong: %+v", st)
	}
	kinds := make([]string, 0, len(st.Touches))
	for _, tc := range st.Touches {
		kinds = append(kinds, tc.Kind)
	}
	if got, want := strings.Join(kinds, ","), "retry,status,sent,skipped,opened,retry,status,opened,sent,opened,opened"; got != want {
		t.Fatalf("touches newest-first = %s want %s", got, want)
	}
	// A stale check on a phone with no row leaves no row behind.
	_, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: "+93700000502", Outcome: "opened", ExpectedVersion: ver(5)})
	if !errors.Is(err, ErrOutreachStale) {
		t.Fatalf("stale on a new phone: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM outreach_contacts WHERE phone_e164 = $1`, "+93700000502").Scan(&n); err != nil || n != 0 {
		t.Fatalf("refused outcome must not create the row: n=%d err=%v", n, err)
	}

	// Handler level: exact 400s and 409s, then a real 200 with the {state} shape.
	h := NewHandler(svc)
	for body, want := range map[string]string{
		`{"phone":"abc","outcome":"opened"}`:             "invalid phone",
		`{"outcome":"opened"}`:                           "invalid phone",
		`{"phone":"+93700000501","outcome":"bogus"}`:     "invalid outcome",
		`{"phone":"+93700000501"}`:                       "invalid outcome",
		`{"phone":"+93700000501","outcome":"contacted"}`: "invalid outcome",
	} {
		if rec := postOutreach(h.OutreachOutcome, body); rec.Code != 400 || outreachError(t, rec) != want {
			t.Fatalf("%s: %d %s want 400 %s", body, rec.Code, rec.Body.String(), want)
		}
	}
	if rec := postOutreach(h.OutreachOutcome, `{"phone":`); rec.Code != 400 {
		t.Fatalf("malformed json: %d %s", rec.Code, rec.Body.String())
	}
	if rec := postOutreach(h.OutreachOutcome, `{"phone":"+93700000501","outcome":"sent","expected_version":1}`); rec.Code != 409 || outreachError(t, rec) != "stale outcome" {
		t.Fatalf("stale: %d %s", rec.Code, rec.Body.String())
	}
	// Every verdict except "opened" must carry expected_version, so a repeated
	// "sent" can never count twice whatever the client does. Refused with 400
	// and nothing written: the version-11 "opened" below still lands.
	for _, body := range []string{
		`{"phone":"+93700000501","outcome":"sent"}`,
		`{"phone":"+93700000501","outcome":"sent","template_key":"template.customer.fa"}`,
		`{"phone":"+93700000501","outcome":"no_whatsapp"}`,
		`{"phone":"+93700000501","outcome":"invalid"}`,
		`{"phone":"+93700000501","outcome":"skip"}`,
		`{"phone":"+93700000501","outcome":"retry"}`,
		`{"phone":"+93700000501","outcome":"sent","expected_version":null}`,
	} {
		if rec := postOutreach(h.OutreachOutcome, body); rec.Code != 400 || outreachError(t, rec) != "expected_version required" {
			t.Fatalf("%s: %d %s want 400 expected_version required", body, rec.Code, rec.Body.String())
		}
	}
	if rec := postOutreach(h.OutreachOutcome, `{"phone":"+93700000501","outcome":"retry","expected_version":11}`); rec.Code != 409 || outreachError(t, rec) != "not retryable" {
		t.Fatalf("not retryable: %d %s", rec.Code, rec.Body.String())
	}
	rec := postOutreach(h.OutreachOutcome, `{"phone":"+93 700 000 501","outcome":"opened","template_key":"template.customer.en","expected_version":11}`)
	if rec.Code != 200 {
		t.Fatalf("opened: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		State OutreachState `json:"state"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.State.Phone != phone || out.State.Version != 12 || out.State.OpenCount != 5 || out.State.Status != "new" ||
		out.State.PendingSince != "2026-09-10T09:00:00Z" || out.State.ContactCount != 2 {
		t.Fatalf("handler opened response wrong: %+v", out.State)
	}
	if !strings.HasPrefix(rec.Body.String(), `{"state":{"phone":"+93700000501"`) {
		t.Fatalf("response shape must be {state}: %s", rec.Body.String())
	}
}

// ---------- batch 2, case 3: pending / unreachable / invalid / opened_today ----------

func TestGetOutreachBatch2Counts(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	// Kabul is UTC+04:30: 19:30Z on the 9th is already the 10th there.
	clock := activityTime(t, "2026-09-09T19:00:00Z") // 23:30 Kabul, still the 9th
	svc.now = func() time.Time { return clock }
	pendingOld, pendingNew, noWA, invalidStatus, badNumber := "+93700000601", "+93700000602", "+93700000603", "+93700000604", "+9370000"
	for _, ph := range []string{pendingOld, pendingNew, noWA, invalidStatus, badNumber} {
		seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", ph, "", "")
	}
	outcome := func(phone, kind string) {
		t.Helper()
		if _, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: phone, Outcome: kind}); err != nil {
			t.Fatalf("%s %s: %v", phone, kind, err)
		}
	}
	outcome(pendingOld, "opened")                   // yesterday's open, still awaiting an outcome
	clock = activityTime(t, "2026-09-09T20:00:00Z") // 00:30 Kabul on the 10th
	outcome(pendingNew, "opened")
	outcome(noWA, "opened")
	outcome(noWA, "no_whatsapp")
	outcome(invalidStatus, "invalid")
	outcome("+93700000699", "opened")               // no source row: never listed, but the touch is on the day
	clock = activityTime(t, "2026-09-10T08:00:00Z") // 12:30 Kabul
	outcome(pendingNew, "opened")
	res, err := svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Counts.Total != 5 || res.Counts.Pending != 2 || res.Counts.Unreachable != 2 || res.Counts.Invalid != 1 ||
		res.Counts.OpenedToday != 4 || res.Counts.ToContact != 3 || res.Counts.Sent != 0 {
		t.Fatalf("counts wrong: %+v", res.Counts)
	}
	if c := findOutreach(t, res, pendingOld); c.Outreach.PendingSince != "2026-09-09T19:00:00Z" || c.Outreach.OpenCount != 1 {
		t.Fatalf("old pending wrong: %+v", c.Outreach)
	}
	if c := findOutreach(t, res, noWA); c.Outreach.Status != "no_whatsapp" || c.Outreach.PendingSince != "" || c.Outreach.OpenCount != 1 {
		t.Fatalf("no_whatsapp wrong: %+v", c.Outreach)
	}
	if c := findOutreach(t, res, badNumber); c.Number.Valid || c.Outreach.Status != "new" {
		t.Fatalf("invalid number wrong: %+v", c)
	}
	// The next Kabul day: nothing opened today, the pending ones still pending.
	clock = activityTime(t, "2026-09-10T20:00:00Z") // 00:30 Kabul on the 11th
	if res, err = svc.GetOutreach(ctx); err != nil || res.Counts.OpenedToday != 0 || res.Counts.Pending != 2 {
		t.Fatalf("next-day counts wrong: %+v %v", res.Counts, err)
	}
}

// ---------- batch 2, case 4: exclusions by source ----------

func TestOutreachExclusions(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	h := NewHandler(svc)

	ownerA := seedOutreachAccount(t, pool, "Owner A", "+93790000021")
	ownerB := seedOutreachAccount(t, pool, "Owner B", "+93790000022")
	ownerC := seedOutreachAccount(t, pool, "Owner C", "")
	vaultA := seedOutreachVault(t, pool, ownerA, "Test Book", "AFN")
	vaultB := seedOutreachVault(t, pool, ownerB, "Real Book", "AFN")
	vaultC := seedOutreachVault(t, pool, ownerC, "Other Book", "AFN")
	shared, onlyA, both := "+93700000701", "+93700000702", "+93790000022"
	// In the test book the shared number is a supplier (the shop owes it 40)
	// and onlyA owes 250; in the real book the shared number owes 60. Owner A
	// also owns a real book of their own, where one customer owes 100.
	relSharedA, relOnlyA, relSharedB, relRealA := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	evA := newOutreachEvents(t, pool, vaultA)
	evA.person(uuid.NewString(), relSharedA, "Shared", shared)
	evA.person(uuid.NewString(), relOnlyA, "Only A", onlyA)
	evA.entry(relSharedA, "payment", "40")
	evA.entry(relOnlyA, "debt", "250")
	evB := newOutreachEvents(t, pool, vaultB)
	evB.person(uuid.NewString(), relSharedB, "Shared Too", shared)
	evB.entry(relSharedB, "debt", "60")
	vaultReal := seedOutreachVault(t, pool, ownerA, "A Real Book", "AFN")
	evReal := newOutreachEvents(t, pool, vaultReal)
	evReal.person(uuid.NewString(), relRealA, "Real Customer", "+93700000703")
	evReal.entry(relRealA, "debt", "100")
	evC := newOutreachEvents(t, pool, vaultC)
	evC.person(uuid.NewString(), uuid.NewString(), "Owner B As Customer", both)
	// Owner B's phone (an install resolved to the account) and a two-install
	// anonymous shopkeeper.
	seedOutreachInstall(t, pool, &ownerB, "2026-09-02T10:00:00Z", "+93700000705", "Owner B Phone", "")
	twoOld := seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", "+93700000704", "Two Phones", "")
	twoNew := seedOutreachInstall(t, pool, nil, "2026-09-03T10:00:00Z", "+93700000704", "", "")

	get := func() OutreachResult {
		t.Helper()
		res, err := svc.GetOutreach(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	res := get()
	if c := findOutreach(t, res, shared); len(c.Customer.Listings) != 2 || c.Customer.MentionCount != 2 || !c.Customer.IsWholesaler ||
		!c.Customer.IsSupplierAnywhere || !c.Customer.IsCustomerAnywhere {
		t.Fatalf("baseline shared wrong: %+v", c.Customer)
	}
	if res.Counts.Wholesalers != 1 {
		t.Fatalf("baseline wholesalers wrong: %+v", res.Counts)
	}
	if sk := findOutreach(t, res, "+93790000021").Shopkeeper; len(sk.Kaatas) != 2 || sk.Kaatas[0].VaultID != vaultReal ||
		sk.Kaatas[1].VaultID != vaultA || sk.People != 3 || sk.Tallies != 3 || sk.ReceivableTotal != "350.00" ||
		sk.PayableTotal != "40.00" {
		t.Fatalf("baseline owner A totals wrong: %+v", sk)
	}
	findOutreach(t, res, onlyA)
	if c := findOutreach(t, res, both); c.Kind != "both" {
		t.Fatalf("baseline both wrong: %+v", c)
	}
	if c := findOutreach(t, res, "+93700000704"); c.Shopkeeper.InstallCount != 2 ||
		strings.Join(c.Shopkeeper.InstallIDs, ",") != twoNew+","+twoOld {
		t.Fatalf("baseline two-install shopkeeper wrong: %+v", c.Shopkeeper)
	}
	if c := findOutreach(t, res, "+93700000705"); c.Kind != "shopkeeper" || c.Shopkeeper.AccountID != ownerB {
		t.Fatalf("baseline owner B install wrong: %+v", c)
	}
	if len(res.Exclusions) != 0 {
		t.Fatalf("no exclusions yet: %+v", res.Exclusions)
	}

	// 1. The test book: only its listings go; the shared number keeps its real one.
	list, err := svc.SetOutreachExclusion(ctx, "vault", vaultA, true, "test data")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0] != (OutreachExclusion{Kind: "vault", ID: vaultA, Label: "Test Book · Owner A", Reason: "test data", CreatedAt: "2026-09-10T08:00:00Z"}) {
		t.Fatalf("vault exclusion wrong: %+v", list)
	}
	res = get()
	if c := findOutreach(t, res, shared); c.Kind != "customer" || len(c.Customer.Listings) != 1 || c.Customer.Listings[0].VaultID != vaultB ||
		c.Customer.MentionCount != 1 || c.Customer.IsWholesaler || c.Name != "Shared Too" {
		t.Fatalf("shared after vault exclusion wrong: %+v", c)
	}
	// Its supplier role was only in the test book: the flags and the
	// wholesaler count are recomputed from the listings that remain.
	if c := findOutreach(t, res, shared); c.Customer.IsSupplierAnywhere || !c.Customer.IsCustomerAnywhere || res.Counts.Wholesalers != 0 {
		t.Fatalf("supplier flag must go with the excluded book: %+v %+v", c.Customer, res.Counts)
	}
	if hasOutreach(res, onlyA) {
		t.Fatal("a number listed only in the excluded book must disappear")
	}
	// The owner's shopkeeper block drops the test book too: kaatas, people,
	// tallies, receivable and payable are the real book's alone.
	if sk := findOutreach(t, res, "+93790000021").Shopkeeper; len(sk.Kaatas) != 1 || sk.Kaatas[0].VaultID != vaultReal ||
		sk.People != 1 || sk.Tallies != 1 || sk.ReceivableTotal != "100.00" || sk.PayableTotal != "0.00" ||
		sk.Currency != "AFN" || sk.LastTallyAt != sk.Kaatas[0].LastTallyAt {
		t.Fatalf("excluded book must leave its owner's totals: %+v", sk)
	}
	if len(res.Exclusions) != 1 || res.Exclusions[0] != list[0] {
		t.Fatalf("GET must carry the labelled exclusion: %+v", res.Exclusions)
	}

	// 2. Owner B's account: the `both` number keeps its customer side, the
	// install resolved to B goes, and B's own book is NOT excluded by that.
	clock = clock.Add(time.Hour)
	if list, err = svc.SetOutreachExclusion(ctx, "account", ownerB, true, "my own account"); err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Kind != "account" || list[0].ID != ownerB || list[0].Label != "Owner B" ||
		list[0].Reason != "my own account" || list[0].CreatedAt != "2026-09-10T09:00:00Z" || list[1].Kind != "vault" {
		t.Fatalf("account exclusion wrong (newest first): %+v", list)
	}
	res = get()
	if c := findOutreach(t, res, both); c.Kind != "customer" || c.Shopkeeper != nil || c.Customer == nil ||
		len(c.Customer.Listings) != 1 || c.Customer.Listings[0].VaultID != vaultC || c.Name != "Owner B As Customer" {
		t.Fatalf("both after account exclusion wrong: %+v", c)
	}
	if hasOutreach(res, "+93700000705") {
		t.Fatal("an install resolved to an excluded account must go with it")
	}
	if c := findOutreach(t, res, shared); len(c.Customer.Listings) != 1 || c.Customer.Listings[0].VaultID != vaultB ||
		c.Customer.Listings[0].OwnerName != "Owner B" || c.Customer.Listings[0].OwnerPhone != "+93790000022" {
		t.Fatalf("excluding an account must not exclude its book or hide its owner: %+v", c.Customer)
	}

	// 3. One install of a two-install shopkeeper, then the other. The list is
	// newest first (created_at, then kind, then id), so each gets its own tick.
	clock = clock.Add(time.Minute)
	if list, err = svc.SetOutreachExclusion(ctx, "install", twoOld, true, ""); err != nil {
		t.Fatal(err)
	}
	if list[0].Kind != "install" || list[0].ID != twoOld || list[0].Label != "Two Phones" || list[0].Reason != "" {
		t.Fatalf("install exclusion wrong: %+v", list[0])
	}
	res = get()
	if c := findOutreach(t, res, "+93700000704"); c.Shopkeeper.InstallCount != 1 ||
		strings.Join(c.Shopkeeper.InstallIDs, ",") != twoNew {
		t.Fatalf("two-install shopkeeper after one exclusion wrong: %+v", c.Shopkeeper)
	}
	clock = clock.Add(time.Minute)
	if list, err = svc.SetOutreachExclusion(ctx, "install", twoNew, true, ""); err != nil {
		t.Fatal(err)
	}
	if list[0].Label != twoNew[:8] {
		t.Fatalf("an install with no name is labelled by its id prefix: %+v", list[0])
	}
	if res = get(); hasOutreach(res, "+93700000704") {
		t.Fatal("a number whose every source is excluded must disappear")
	}

	// 4. Lifting: excluded:false through the handler; an uppercase UUID is accepted.
	rec := postOutreach(h.OutreachExclude, `{"kind":"vault","id":"`+strings.ToUpper(vaultA)+`","excluded":false}`)
	if rec.Code != 200 {
		t.Fatalf("lift: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Exclusions []OutreachExclusion `json:"exclusions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Exclusions) != 3 {
		t.Fatalf("lift must answer the remaining list: %+v", out.Exclusions)
	}
	for _, x := range out.Exclusions {
		if x.Kind == "vault" {
			t.Fatalf("vault exclusion not lifted: %+v", out.Exclusions)
		}
	}
	res = get()
	findOutreach(t, res, onlyA)
	if c := findOutreach(t, res, shared); len(c.Customer.Listings) != 2 || !c.Customer.IsSupplierAnywhere {
		t.Fatalf("shared after lift wrong: %+v", c.Customer)
	}
	if sk := findOutreach(t, res, "+93790000021").Shopkeeper; len(sk.Kaatas) != 2 || sk.ReceivableTotal != "350.00" {
		t.Fatalf("owner A after lift wrong: %+v", sk)
	}

	// 5. Re-excluding replaces the reason and keeps created_at; the response
	// carries the wire tags the page reads.
	clock = clock.Add(time.Hour)
	rec = postOutreach(h.OutreachExclude, `{"kind":"account","id":"`+ownerB+`","excluded":true,"reason":"changed reason"}`)
	if rec.Code != 200 {
		t.Fatalf("re-exclude: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `{"kind":"account","id":"`+ownerB+`","label":"Owner B","reason":"changed reason","created_at":"2026-09-10T09:00:00Z"}`) {
		t.Fatalf("re-exclude response wrong: %s", rec.Body.String())
	}
	if !strings.HasPrefix(rec.Body.String(), `{"exclusions":[`) {
		t.Fatalf("response shape must be {exclusions}: %s", rec.Body.String())
	}

	// 6. Validation.
	for body, want := range map[string]string{
		`{"kind":"book","id":"` + vaultA + `"}`:                   "invalid kind",
		`{"id":"` + vaultA + `"}`:                                 "invalid kind",
		`{"kind":"vault","id":"not-a-uuid"}`:                      "invalid id",
		`{"kind":"vault","id":""}`:                                "invalid id",
		`{"kind":"vault"}`:                                        "invalid id",
		`{"kind":"vault","id":"` + strings.Repeat("a", 65) + `"}`: "invalid id",
	} {
		if rec := postOutreach(h.OutreachExclude, body); rec.Code != 400 || outreachError(t, rec) != want {
			t.Fatalf("%s: %d %s want 400 %s", body, rec.Code, rec.Body.String(), want)
		}
	}
	if rec := postOutreach(h.OutreachExclude, `{"kind":`); rec.Code != 400 {
		t.Fatalf("malformed json: %d", rec.Code)
	}
	// excluded is required: absent or null is refused, never read as "exclude".
	for _, body := range []string{
		`{"kind":"vault","id":"` + vaultA + `"}`,
		`{"kind":"vault","id":"` + vaultA + `","excluded":null}`,
		`{"kind":"vault","id":"` + vaultA + `","reason":"test data"}`,
	} {
		if rec := postOutreach(h.OutreachExclude, body); rec.Code != 400 || outreachError(t, rec) != "invalid body" {
			t.Fatalf("%s: %d %s want 400 invalid body", body, rec.Code, rec.Body.String())
		}
	}
	if res = get(); len(res.Exclusions) != 3 {
		t.Fatalf("a refused exclusion must write nothing: %+v", res.Exclusions)
	}
	for _, x := range res.Exclusions {
		if x.Kind == "vault" {
			t.Fatalf("a refused exclusion must write nothing: %+v", res.Exclusions)
		}
	}
}

// ---------- batch 2, case 5: bulk mark bumps version and clears pending ----------

func TestOutreachMarkBumpsVersionAndClearsPending(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	h := NewHandler(svc)
	phone, other := "+93700000801", "+93700000802"
	seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", phone, "", "")
	mark := func(in OutreachMarkInput) OutreachState {
		t.Helper()
		st, _, err := svc.MarkOutreach(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		return st[0]
	}
	outcome := func(kind string, expected int64) OutreachState {
		t.Helper()
		st, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: phone, Outcome: kind, ExpectedVersion: &expected})
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		return st
	}
	// Skipped, then opened, then ticked from the bulk bar: the row is still
	// New, so the send counts, ends both the pending window and the skip, and
	// bumps the version. (A bulk send on a row that is already sent is skipped
	// whole; TestOutreachMarkContactedIsIdempotent pins that.)
	st := outcome("skip", 0)
	if st.Version != 1 || st.SkippedAt == "" || st.Status != "new" {
		t.Fatalf("skip wrong: %+v", st)
	}
	if st = outcome("opened", 1); st.Version != 2 || st.PendingSince == "" || st.SkippedAt == "" {
		t.Fatalf("opened after skip wrong: %+v", st)
	}
	st = mark(OutreachMarkInput{Phones: []string{phone}, Contacted: true})
	if st.Version != 3 || st.Status != "sent" || st.ContactCount != 1 || st.PendingSince != "" || st.SkippedAt != "" {
		t.Fatalf("bulk send must clear pending and the skip and bump version: %+v", st)
	}
	note := "n"
	if st = mark(OutreachMarkInput{Phones: []string{phone}, Note: &note}); st.Version != 4 {
		t.Fatalf("note must bump version: %+v", st)
	}
	if st = mark(OutreachMarkInput{Phones: []string{phone}, Replied: true}); st.Version != 5 || st.Status != "replied" {
		t.Fatalf("replied must bump version: %+v", st)
	}
	// The two batch-2 statuses are accepted by the bulk mark and count as unreachable.
	rec := postOutreach(h.OutreachMark, `{"phones":["+93700000801"],"status":"no_whatsapp"}`)
	if rec.Code != 200 {
		t.Fatalf("no_whatsapp via mark: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Updated []OutreachState `json:"updated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Updated[0].Status != "no_whatsapp" || out.Updated[0].Version != 6 {
		t.Fatalf("no_whatsapp via mark wrong: %+v %v", out.Updated, err)
	}
	invalid := "invalid"
	if st = mark(OutreachMarkInput{Phones: []string{phone}, Status: &invalid}); st.Status != "invalid" || st.Version != 7 {
		t.Fatalf("invalid via mark wrong: %+v", st)
	}
	res, err := svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.Counts.Unreachable != 1 || res.Counts.ToContact != 0 || res.Counts.Declined != 0 {
		t.Fatalf("invalid status must count as unreachable only: %+v", res.Counts)
	}
	// Bulk "Mark sent" records FIRST messages only (2026-09-30): this row is
	// Invalid but was messaged once already, so the bulk send skips it whole.
	// The follow-up goes through the version-checked outcome, which promotes
	// an unreachable contact to sent, because both run writeOutreachMark.
	bulk, skipped, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone}, Contacted: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(skipped, ",") != phone || bulk[0].Status != "invalid" || bulk[0].Version != 7 || bulk[0].ContactCount != 1 {
		t.Fatalf("a bulk send to an already-messaged Invalid row must be skipped: %+v skipped=%v", bulk[0], skipped)
	}
	if st = outcome("sent", 7); st.Status != "sent" || st.Version != 8 || st.ContactCount != 2 {
		t.Fatalf("a follow-up from invalid must promote to sent: %+v", st)
	}
	// Every phone in a bulk mark bumps its own version.
	states, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{phone, other}, Replied: true})
	if err != nil {
		t.Fatal(err)
	}
	if states[0].Version != 9 || states[1].Version != 1 || states[1].Status != "replied" {
		t.Fatalf("bulk versions wrong: %+v", states)
	}
}

// ---------- review fixes (2026-09-30): one path counts a message ----------

// Twelve "sent" verdicts decided against the same version at once — a double
// click, two tabs, a retried request — count exactly one message: the row
// lock orders them and every later one reads the bumped version.
func TestOutreachOutcomeSentConcurrentCountsOnce(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	h := NewHandler(svc)
	phone := "+93700001101"
	if st, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: phone, Outcome: "opened"}); err != nil || st.Version != 1 {
		t.Fatalf("opened: %+v %v", st, err)
	}
	const n = 12
	recs := make([]*httptest.ResponseRecorder, n)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			recs[i] = postOutreach(h.OutreachOutcome, `{"phone":"+93700001101","outcome":"sent","expected_version":1}`)
		}()
	}
	close(start)
	wg.Wait()
	landed := 0
	for i, rec := range recs {
		switch {
		case rec.Code == 200:
			landed++
		case rec.Code == 409 && outreachError(t, rec) == "stale outcome":
		default:
			t.Fatalf("request %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if landed != 1 {
		t.Fatalf("exactly one sent may land, got %d", landed)
	}
	states, err := readOutreachStates(ctx, pool, []string{phone})
	if err != nil {
		t.Fatal(err)
	}
	if st := states[phone].state; st.ContactCount != 1 || st.Version != 2 || st.Status != "sent" || st.PendingSince != "" {
		t.Fatalf("one message expected: %+v", st)
	}
	var sentTouches int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM outreach_touches WHERE phone_e164 = $1 AND kind = 'sent'`, phone).Scan(&sentTouches); err != nil || sentTouches != 1 {
		t.Fatalf("one sent touch expected: %d %v", sentTouches, err)
	}
}

// A decided row ends the wait: an explicit status other than New, or a
// reply, clears pending_since and skipped_at. An explicit New keeps both, so
// a chat opened without an outcome cannot drop back into the queue.
func TestOutreachMarkStatusEndsWait(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	stopped, reset, replied, parked := "+93700001201", "+93700001202", "+93700001203", "+93700001204"
	for _, ph := range []string{stopped, reset, replied, parked} {
		seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", ph, "", "")
	}
	for _, ph := range []string{stopped, reset, replied} {
		if _, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: ph, Outcome: "opened"}); err != nil {
			t.Fatal(err)
		}
	}
	v0 := int64(0)
	if _, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: parked, Outcome: "skip", ExpectedVersion: &v0}); err != nil {
		t.Fatal(err)
	}
	res, err := svc.GetOutreach(ctx)
	if err != nil || res.Counts.Pending != 3 {
		t.Fatalf("three pending expected: %+v %v", res.Counts, err)
	}
	mark := func(in OutreachMarkInput) OutreachState {
		t.Helper()
		st, skipped, err := svc.MarkOutreach(ctx, in)
		if err != nil || len(skipped) != 0 {
			t.Fatalf("mark: %v skipped=%v", err, skipped)
		}
		return st[0]
	}
	dnc, fresh, interested := "do_not_contact", "new", "interested"
	clock = clock.Add(time.Hour)
	if st := mark(OutreachMarkInput{Phones: []string{stopped}, Status: &dnc}); st.Status != "do_not_contact" || st.PendingSince != "" {
		t.Fatalf("do_not_contact must end the wait: %+v", st)
	}
	if st := mark(OutreachMarkInput{Phones: []string{reset}, Status: &fresh}); st.Status != "new" || st.PendingSince != "2026-09-10T08:00:00Z" {
		t.Fatalf("an explicit New must keep the wait: %+v", st)
	}
	if st := mark(OutreachMarkInput{Phones: []string{replied}, Replied: true}); st.Status != "replied" || st.PendingSince != "" {
		t.Fatalf("a reply must end the wait: %+v", st)
	}
	// skipped_at follows the same rule.
	if st := mark(OutreachMarkInput{Phones: []string{parked}, Status: &fresh}); st.SkippedAt != "2026-09-10T08:00:00Z" {
		t.Fatalf("an explicit New must keep the skip: %+v", st)
	}
	if st := mark(OutreachMarkInput{Phones: []string{parked}, Status: &interested}); st.SkippedAt != "" {
		t.Fatalf("an explicit status must end the skip: %+v", st)
	}
	if res, err = svc.GetOutreach(ctx); err != nil || res.Counts.Pending != 1 || findOutreach(t, res, reset).Outreach.PendingSince == "" {
		t.Fatalf("only the reset row may still be pending: %+v %v", res.Counts, err)
	}
}

// Declined and do-not-contact rows refuse every outcome that would message
// the number or replace the stop (409 contact stopped, nothing written),
// while skip still closes a pending window.
func TestOutreachOutcomeRefusesStoppedContacts(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	h := NewHandler(svc)
	stored := func(ph string) OutreachState {
		t.Helper()
		states, err := readOutreachStates(ctx, pool, []string{ph})
		if err != nil || states[ph] == nil {
			t.Fatalf("read %s: %v", ph, err)
		}
		return states[ph].state
	}
	for i, status := range []string{"do_not_contact", "declined"} {
		ph := fmt.Sprintf("+9370000130%d", i+1)
		st := status
		if _, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{ph}, Status: &st}); err != nil {
			t.Fatal(err)
		}
		before := stored(ph)
		for _, oc := range []string{"opened", "sent", "no_whatsapp", "invalid"} {
			body := fmt.Sprintf(`{"phone":%q,"outcome":%q,"expected_version":%d}`, ph, oc, before.Version)
			if rec := postOutreach(h.OutreachOutcome, body); rec.Code != 409 || outreachError(t, rec) != "contact stopped" {
				t.Fatalf("%s on %s: %d %s want 409 contact stopped", oc, status, rec.Code, rec.Body.String())
			}
		}
		// An unchecked open is refused the same way, a stale version is still
		// reported as stale first, and retry keeps its own rule.
		for body, want := range map[string]string{
			fmt.Sprintf(`{"phone":%q,"outcome":"opened"}`, ph):                                       "contact stopped",
			fmt.Sprintf(`{"phone":%q,"outcome":"sent","expected_version":%d}`, ph, before.Version+5): "stale outcome",
			fmt.Sprintf(`{"phone":%q,"outcome":"retry","expected_version":%d}`, ph, before.Version):  "not retryable",
		} {
			if rec := postOutreach(h.OutreachOutcome, body); rec.Code != 409 || outreachError(t, rec) != want {
				t.Fatalf("%s: %d %s want 409 %s", body, rec.Code, rec.Body.String(), want)
			}
		}
		if after := stored(ph); after.Version != before.Version || after.Status != status || after.OpenCount != 0 ||
			after.ContactCount != 0 || after.PendingSince != "" || len(after.Touches) != len(before.Touches) {
			t.Fatalf("a refused outcome on %s must write nothing: %+v -> %+v", status, before, after)
		}
	}
	// A stopped row left pending (only the mark path before this fix could
	// leave one, since an explicit status now ends the wait) exits through
	// skip, which sends nothing and keeps the stop.
	ph := "+93700001303"
	if _, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: ph, Outcome: "opened"}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE outreach_contacts SET status = 'do_not_contact', version = version + 1 WHERE phone_e164 = $1`, ph); err != nil {
		t.Fatal(err)
	}
	rec := postOutreach(h.OutreachOutcome, `{"phone":"+93700001303","outcome":"skip","reason":"nothing sent","expected_version":2}`)
	if rec.Code != 200 {
		t.Fatalf("skip on a stopped pending row: %d %s", rec.Code, rec.Body.String())
	}
	if st := stored(ph); st.PendingSince != "" || st.SkippedAt != "2026-09-10T08:00:00Z" || st.Status != "do_not_contact" ||
		st.Version != 3 || st.ContactCount != 0 || st.Touches[0].Kind != "skipped" || st.Touches[0].Detail != "nothing sent" {
		t.Fatalf("skip must clear the wait and keep the stop: %+v", st)
	}
}

// A bulk "Mark sent" counts only sendable rows (new, no_whatsapp, invalid).
// Every other requested phone is reported in skipped, in input order, and
// left exactly as it was; repeating the call counts nothing at all.
func TestOutreachMarkContactedIsIdempotent(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	h := NewHandler(svc)
	// Input order new, sent, do-not-contact. The lock order (sorted) differs,
	// so skipped must follow the request, not the locks.
	fresh, sent, dnc := "+93700001401", "+93700001403", "+93700001402"
	if _, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{sent}, Contacted: true}); err != nil {
		t.Fatal(err)
	}
	stop := "do_not_contact"
	if _, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{dnc}, Status: &stop}); err != nil {
		t.Fatal(err)
	}
	before, err := readOutreachStates(ctx, pool, []string{sent, dnc})
	if err != nil {
		t.Fatal(err)
	}
	type markResponse struct {
		Updated []OutreachState `json:"updated"`
		Skipped []string        `json:"skipped"`
	}
	post := func() markResponse {
		t.Helper()
		rec := postOutreach(h.OutreachMark, `{"phones":["+93700001401","+93700001403","+93700001402"],"contacted":true,"template_key":"template.customer.fa"}`)
		if rec.Code != 200 {
			t.Fatalf("mark: %d %s", rec.Code, rec.Body.String())
		}
		var out markResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Updated) != 3 || out.Updated[0].Phone != fresh || out.Updated[1].Phone != sent || out.Updated[2].Phone != dnc {
			t.Fatalf("updated must list every requested phone in input order: %+v", out.Updated)
		}
		return out
	}
	same := func(a, b OutreachState) bool {
		return a.Status == b.Status && a.Version == b.Version && a.ContactCount == b.ContactCount &&
			a.ContactedAt == b.ContactedAt && a.UpdatedAt == b.UpdatedAt && len(a.Touches) == len(b.Touches)
	}
	clock = clock.Add(time.Hour)
	first := post()
	if strings.Join(first.Skipped, ",") != sent+","+dnc {
		t.Fatalf("skipped = %v want [%s %s]", first.Skipped, sent, dnc)
	}
	if u := first.Updated[0]; u.Status != "sent" || u.ContactCount != 1 || u.Version != 1 || u.ContactedAt != "2026-09-10T09:00:00Z" {
		t.Fatalf("the new row must be counted: %+v", u)
	}
	for i, ph := range []string{sent, dnc} {
		if u := first.Updated[i+1]; !same(u, before[ph].state) {
			t.Fatalf("skipped %s must be untouched: %+v -> %+v", ph, before[ph].state, u)
		}
	}
	clock = clock.Add(time.Hour)
	again := post()
	if strings.Join(again.Skipped, ",") != fresh+","+sent+","+dnc {
		t.Fatalf("a repeated bulk send must skip every row: %v", again.Skipped)
	}
	for i := range again.Updated {
		if !same(again.Updated[i], first.Updated[i]) {
			t.Fatalf("a repeated bulk send must write nothing: %+v -> %+v", first.Updated[i], again.Updated[i])
		}
	}
	// Two sent touches in all: the setup send and the new row.
	res, err := svc.GetOutreach(ctx)
	if err != nil || res.Counts.SentToday != 2 {
		t.Fatalf("sent_today must count each message once: %+v %v", res.Counts, err)
	}
	// Wire: skipped is [] when nothing was skipped, never null.
	if rec := postOutreach(h.OutreachMark, `{"phones":["+93700001404"],"contacted":true}`); rec.Code != 200 ||
		!strings.Contains(rec.Body.String(), `"skipped":[]`) {
		t.Fatalf("skipped must serialize as []: %d %s", rec.Code, rec.Body.String())
	}
}

// ---------- final round (2026-09-30): never messaged, first sends, stops ----------

// never_messaged is read from the whole touch log: a number is offered for a
// first message only if no send was ever recorded and every chat opened for
// it was resolved as "nothing sent" (skip, retry, not on WhatsApp, invalid).
// The outcome response, the mark response and GET all carry it.
func TestOutreachNeverMessaged(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	h := NewHandler(svc)
	relabeled, parked, retried, unreachable, sent, noRow, noted, wire := "+93700001501", "+93700001502",
		"+93700001503", "+93700001504", "+93700001505", "+93700001506", "+93700001507", "+93700001508"
	for _, ph := range []string{relabeled, parked, retried, unreachable, sent, noRow, noted, wire} {
		seedOutreachInstall(t, pool, nil, "2026-09-01T10:00:00Z", ph, "", "")
	}
	opened := func(ph string) OutreachState {
		t.Helper()
		st, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: ph, Outcome: "opened"})
		if err != nil {
			t.Fatalf("opened %s: %v", ph, err)
		}
		return st
	}
	verdict := func(ph, kind string, prev OutreachState) OutreachState {
		t.Helper()
		v := prev.Version
		st, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: ph, Outcome: kind, ExpectedVersion: &v})
		if err != nil {
			t.Fatalf("%s %s: %v", kind, ph, err)
		}
		return st
	}
	status := func(ph, s string) OutreachState {
		t.Helper()
		st, skipped, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{ph}, Status: &s})
		if err != nil || len(skipped) != 0 {
			t.Fatalf("status %s on %s: %v skipped=%v", s, ph, err, skipped)
		}
		return st[0]
	}
	// Each checked step is one minute after the last, so the touch order is
	// created_at first; the pair written in one instant below falls back to
	// the touch id.
	expect := func(what string, st OutreachState, never bool) {
		t.Helper()
		if st.NeverMessaged != never {
			t.Fatalf("%s: never_messaged = %v want %v (%+v)", what, st.NeverMessaged, never, st)
		}
		clock = clock.Add(time.Minute)
	}

	// Opened, relabelled Interested, then New again: a status alone never
	// resolves an open, so the number may have been messaged.
	expect("pending", opened(relabeled), false)
	expect("opened → interested", status(relabeled, "interested"), false)
	expect("opened → interested → new", status(relabeled, "new"), false)

	// Opened, then skipped: nothing was sent. The LATEST chat touch decides,
	// so opening it again reopens the question and a skip closes it again.
	st := opened(parked)
	expect("pending", st, false)
	st = verdict(parked, "skip", st)
	expect("opened → skip", st, true)
	expect("opened → skip → opened", opened(parked), false)
	st = verdict(parked, "skip", opened(parked)) // one instant: the touch id orders the pair
	expect("reopened and skipped in one instant", st, true)

	// Opened, not on WhatsApp, retried: resolved both times.
	st = verdict(retried, "no_whatsapp", opened(retried))
	expect("opened → no_whatsapp", st, true)
	expect("opened → no_whatsapp → retry", verdict(retried, "retry", st), true)

	// Opened, marked Invalid through the status menu, then New again.
	opened(unreachable)
	clock = clock.Add(time.Minute)
	expect("opened → status invalid", status(unreachable, "invalid"), true)
	expect("opened → status invalid → new", status(unreachable, "new"), true)

	// Opened and sent: false for good, whatever the log says afterwards.
	st = verdict(sent, "sent", opened(sent))
	expect("opened → sent", st, false)
	st = verdict(sent, "invalid", st)
	expect("sent → invalid", st, false)
	expect("sent → invalid → retry", verdict(sent, "retry", st), false)

	// Opened, then 25 note edits: the open has left the 20-touch window, and
	// never_messaged still sees it.
	opened(noted)
	clock = clock.Add(time.Minute)
	for i := range 25 {
		note := fmt.Sprintf("note %d", i)
		states, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{noted}, Note: &note})
		if err != nil {
			t.Fatal(err)
		}
		st = states[0]
	}
	for _, tc := range st.Touches {
		if tc.Kind != "note" {
			t.Fatalf("the window must hold notes only: %+v", st.Touches)
		}
	}
	if len(st.Touches) != 20 {
		t.Fatalf("window = %d touches want 20", len(st.Touches))
	}
	expect("opened → 25 notes", st, false)

	// Wire: both POST responses carry the tag.
	rec := postOutreach(h.OutreachOutcome, `{"phone":"+93700001508","outcome":"opened"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"never_messaged":false`) {
		t.Fatalf("outcome opened response: %d %s", rec.Code, rec.Body.String())
	}
	rec = postOutreach(h.OutreachOutcome, `{"phone":"+93700001508","outcome":"skip","expected_version":1}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"never_messaged":true`) {
		t.Fatalf("outcome skip response: %d %s", rec.Code, rec.Body.String())
	}
	rec = postOutreach(h.OutreachMark, `{"phones":["+93700001501"],"note":"wire"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"never_messaged":false`) {
		t.Fatalf("mark response: %d %s", rec.Code, rec.Body.String())
	}

	// GET agrees, and a number with no outreach row was never messaged.
	res, err := svc.GetOutreach(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for ph, never := range map[string]bool{
		relabeled: false, parked: true, retried: true, unreachable: true,
		sent: false, noRow: true, noted: false, wire: true,
	} {
		if c := findOutreach(t, res, ph); c.Outreach.NeverMessaged != never {
			t.Fatalf("GET %s: never_messaged = %v want %v (%+v)", ph, c.Outreach.NeverMessaged, never, c.Outreach)
		}
	}
	raw, err := json.Marshal(findOutreach(t, res, noRow).Outreach)
	if err != nil || !strings.Contains(string(raw), `"contact_count":0,"never_messaged":true`) {
		t.Fatalf("GET wire for a number with no row: %s %v", raw, err)
	}
}

// Bulk "Mark sent" records FIRST messages only: a row counts while its status
// is sendable (new, no_whatsapp, invalid) AND no send was ever recorded. A
// row messaged before — whatever it was relabelled to since — is skipped
// whole, and its follow-up goes through the version-checked outcome `sent`.
func TestOutreachMarkContactedCountsFirstSendsOnly(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	clock := activityTime(t, "2026-09-10T08:00:00Z")
	svc.now = func() time.Time { return clock }
	h := NewHandler(svc)
	fresh, invalidFirst, noWAFirst, resetAfterSend, noWAAfterSend := "+93700001605", "+93700001604",
		"+93700001603", "+93700001602", "+93700001601"
	setupMark := func(in OutreachMarkInput) {
		t.Helper()
		if _, skipped, err := svc.MarkOutreach(ctx, in); err != nil || len(skipped) != 0 {
			t.Fatalf("setup mark %+v: %v skipped=%v", in, err, skipped)
		}
	}
	setupOutcome := func(ph, kind string) {
		t.Helper()
		if _, err := svc.RecordOutreachOutcome(ctx, OutreachOutcomeInput{Phone: ph, Outcome: kind}); err != nil {
			t.Fatalf("setup %s %s: %v", kind, ph, err)
		}
	}
	invalid, reset := "invalid", "new"
	// Never messaged: Invalid from the status menu, Not on WhatsApp from an outcome.
	setupMark(OutreachMarkInput{Phones: []string{invalidFirst}, Status: &invalid})
	setupOutcome(noWAFirst, "opened")
	setupOutcome(noWAFirst, "no_whatsapp")
	// Messaged once, then relabelled New / found not on WhatsApp.
	setupMark(OutreachMarkInput{Phones: []string{resetAfterSend, noWAAfterSend}, Contacted: true})
	setupMark(OutreachMarkInput{Phones: []string{resetAfterSend}, Status: &reset})
	setupOutcome(noWAAfterSend, "no_whatsapp")
	before, err := readOutreachStates(ctx, pool, []string{resetAfterSend, noWAAfterSend})
	if err != nil {
		t.Fatal(err)
	}
	if st := before[resetAfterSend].state; st.Status != "new" || st.ContactCount != 1 {
		t.Fatalf("setup: %+v", st)
	}

	// Input order differs from the sorted lock order, so skipped must follow
	// the request.
	clock = clock.Add(time.Hour)
	rec := postOutreach(h.OutreachMark, fmt.Sprintf(`{"phones":[%q,%q,%q,%q,%q],"contacted":true}`,
		fresh, resetAfterSend, invalidFirst, noWAAfterSend, noWAFirst))
	var out struct {
		Updated []OutreachState `json:"updated"`
		Skipped []string        `json:"skipped"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil || len(out.Updated) != 5 {
		t.Fatalf("mark: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Join(out.Skipped, ",") != resetAfterSend+","+noWAAfterSend {
		t.Fatalf("skipped = %v want [%s %s]", out.Skipped, resetAfterSend, noWAAfterSend)
	}
	for _, i := range []int{0, 2, 4} {
		if u := out.Updated[i]; u.Status != "sent" || u.ContactCount != 1 || u.ContactedAt != "2026-09-10T09:00:00Z" || u.NeverMessaged {
			t.Fatalf("a first send must be counted: %+v", u)
		}
	}
	for _, i := range []int{1, 3} {
		u, b := out.Updated[i], before[out.Updated[i].Phone].state
		if u.Status != b.Status || u.Version != b.Version || u.ContactCount != 1 || u.ContactedAt != b.ContactedAt ||
			u.UpdatedAt != b.UpdatedAt || len(u.Touches) != len(b.Touches) {
			t.Fatalf("an already-messaged row must be untouched: %+v -> %+v", b, u)
		}
	}
	// The follow-up for the relabelled row: the outcome, pinned to its version.
	rec = postOutreach(h.OutreachOutcome, fmt.Sprintf(`{"phone":%q,"outcome":"sent","expected_version":%d}`,
		resetAfterSend, before[resetAfterSend].state.Version))
	var follow struct {
		State OutreachState `json:"state"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &follow) != nil || follow.State.ContactCount != 2 || follow.State.Status != "sent" {
		t.Fatalf("follow-up via outcome: %d %s", rec.Code, rec.Body.String())
	}
}

// A stop is lifted one row at a time: a status that is not itself a stop
// skips declined and do-not-contact rows unless the mark names one phone and
// carries lift_stop. Setting or re-setting a stop always applies, and a reply
// or a note never lifts one.
func TestOutreachMarkStatusKeepsStops(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	h := NewHandler(svc)
	type markResponse struct {
		Updated []OutreachState `json:"updated"`
		Skipped []string        `json:"skipped"`
	}
	post := func(body string) markResponse {
		t.Helper()
		rec := postOutreach(h.OutreachMark, body)
		var out markResponse
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil {
			t.Fatalf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
		return out
	}
	stop := func(ph, s string) OutreachState {
		t.Helper()
		out := post(fmt.Sprintf(`{"phones":[%q],"status":%q}`, ph, s))
		if len(out.Skipped) != 0 || out.Updated[0].Status != s {
			t.Fatalf("stop %s on %s: %+v", s, ph, out)
		}
		return out.Updated[0]
	}
	same := func(a, b OutreachState) bool {
		return a.Status == b.Status && a.Version == b.Version && a.UpdatedAt == b.UpdatedAt && len(a.Touches) == len(b.Touches)
	}
	for i, status := range []string{"new", "interested", "installed", "sent", "replied", "no_whatsapp", "invalid"} {
		// Input order do-not-contact, declined, fresh: the reverse of the lock order.
		dnc, declined, fresh := fmt.Sprintf("+937000017%d3", i), fmt.Sprintf("+937000017%d2", i), fmt.Sprintf("+937000017%d1", i)
		dncBefore, declinedBefore := stop(dnc, "do_not_contact"), stop(declined, "declined")
		out := post(fmt.Sprintf(`{"phones":[%q,%q,%q],"status":%q}`, dnc, declined, fresh, status))
		if strings.Join(out.Skipped, ",") != dnc+","+declined {
			t.Fatalf("bulk %s: skipped = %v want [%s %s]", status, out.Skipped, dnc, declined)
		}
		if !same(out.Updated[0], dncBefore) || !same(out.Updated[1], declinedBefore) {
			t.Fatalf("bulk %s must leave both stops untouched: %+v", status, out.Updated)
		}
		if u := out.Updated[2]; u.Phone != fresh || u.Status != status || u.Version != 1 {
			t.Fatalf("bulk %s must apply to the fresh row: %+v", status, u)
		}
		// One phone without lift_stop (absent or false) is skipped the same way.
		for _, body := range []string{
			fmt.Sprintf(`{"phones":[%q],"status":%q}`, dnc, status),
			fmt.Sprintf(`{"phones":[%q],"status":%q,"lift_stop":false}`, dnc, status),
		} {
			if out := post(body); strings.Join(out.Skipped, ",") != dnc || !same(out.Updated[0], dncBefore) {
				t.Fatalf("%s must be skipped: %+v", body, out)
			}
		}
		// The row's own status menu lifts it.
		for _, ph := range []string{dnc, declined} {
			out := post(fmt.Sprintf(`{"phones":[%q],"status":%q,"lift_stop":true}`, ph, status))
			if len(out.Skipped) != 0 || out.Updated[0].Status != status || out.Updated[0].Version != 2 {
				t.Fatalf("lift_stop %s on %s: %+v", status, ph, out)
			}
		}
	}

	// Setting or re-setting a stop always applies; a reply or a note never
	// lifts one, and lift_stop does not let a send through.
	ph := "+93700001791"
	stop(ph, "do_not_contact")
	if st := stop(ph, "declined"); st.Version != 2 {
		t.Fatalf("switching stops must apply: %+v", st)
	}
	if st := stop(ph, "declined"); st.Version != 3 || st.Touches[0].Kind != "status" || st.Touches[0].Detail != "declined" {
		t.Fatalf("re-setting a stop must apply: %+v", st)
	}
	if out := post(`{"phones":["+93700001791"],"replied":true}`); len(out.Skipped) != 0 ||
		out.Updated[0].Status != "declined" || out.Updated[0].RepliedAt == "" || out.Updated[0].Version != 4 {
		t.Fatalf("a reply is recorded and keeps the stop: %+v", out)
	}
	if out := post(`{"phones":["+93700001791"],"note":"asked us to stop"}`); len(out.Skipped) != 0 ||
		out.Updated[0].Status != "declined" || out.Updated[0].Note != "asked us to stop" || out.Updated[0].Version != 5 {
		t.Fatalf("a note is recorded and keeps the stop: %+v", out)
	}
	if out := post(`{"phones":["+93700001791"],"contacted":true,"lift_stop":true}`); strings.Join(out.Skipped, ",") != ph ||
		out.Updated[0].Version != 5 || out.Updated[0].ContactCount != 0 {
		t.Fatalf("lift_stop must not let a send through: %+v", out)
	}
	// lift_stop names one phone: two are refused whole (nothing written, no
	// row created), while duplicates of one phone collapse to it.
	rec := postOutreach(h.OutreachMark, `{"phones":["+93700001791","+93700001792"],"status":"new","lift_stop":true}`)
	if rec.Code != 400 || outreachError(t, rec) != "invalid body" {
		t.Fatalf("bulk lift_stop: %d %s want 400 invalid body", rec.Code, rec.Body.String())
	}
	states, err := readOutreachStates(ctx, pool, []string{ph, "+93700001792"})
	if err != nil || states["+93700001792"] != nil || states[ph].state.Status != "declined" || states[ph].state.Version != 5 {
		t.Fatalf("a refused bulk lift must write nothing: %+v %v", states, err)
	}
	if out := post(`{"phones":["+93 700 001 791","+93700001791"],"status":"new","lift_stop":true}`); len(out.Skipped) != 0 ||
		len(out.Updated) != 1 || out.Updated[0].Status != "new" || out.Updated[0].Version != 6 {
		t.Fatalf("one phone written twice is one phone: %+v", out)
	}
}

// A status says what a row IS; contacted and replied record what happened.
// Together they are ambiguous, so the handler refuses the body whole — 400
// invalid body, nothing written, not even the row — and a status is always
// its own mark. An explicit false or null flag is neither a send nor a reply.
func TestOutreachMarkRefusesStatusCombos(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	svc := NewService(pool, nil, nil)
	h := NewHandler(svc)
	declined, fresh := "+93700001801", "+93700001802"
	stop := "declined"
	if _, _, err := svc.MarkOutreach(ctx, OutreachMarkInput{Phones: []string{declined}, Status: &stop}); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"phones":["+93700001801"],"contacted":true,"status":"declined"}`,
		`{"phones":["+93700001801"],"replied":true,"status":"new","lift_stop":true}`,
		`{"phones":["+93700001802"],"contacted":true,"status":"interested"}`,
		`{"phones":["+93700001802"],"replied":true,"status":"interested"}`,
		`{"phones":["+93700001802"],"contacted":true,"replied":true,"status":"sent"}`,
		`{"phones":["+93700001802","+93700001801"],"status":"new","contacted":true,"template_key":"template.customer.fa"}`,
	} {
		if rec := postOutreach(h.OutreachMark, body); rec.Code != 400 || outreachError(t, rec) != "invalid body" {
			t.Fatalf("%s: %d %s want 400 invalid body", body, rec.Code, rec.Body.String())
		}
	}
	states, err := readOutreachStates(ctx, pool, []string{declined, fresh})
	if err != nil {
		t.Fatal(err)
	}
	if states[fresh] != nil {
		t.Fatalf("a refused combo must not create the row: %+v", states[fresh].state)
	}
	if st := states[declined].state; st.Status != "declined" || st.Version != 1 || st.ContactCount != 0 || st.RepliedAt != "" || len(st.Touches) != 1 {
		t.Fatalf("a refused combo must write nothing: %+v", st)
	}
	for _, tc := range []struct {
		body, status string
		count        int
	}{
		{`{"phones":["+93700001802"],"contacted":false,"status":"interested"}`, "interested", 0},
		{`{"phones":["+93700001802"],"replied":false,"status":"installed"}`, "installed", 0},
		{`{"phones":["+93700001802"],"contacted":null,"replied":null,"status":"new"}`, "new", 0},
		{`{"phones":["+93700001802"],"status":null,"contacted":true}`, "sent", 1},
	} {
		rec := postOutreach(h.OutreachMark, tc.body)
		var out struct {
			Updated []OutreachState `json:"updated"`
			Skipped []string        `json:"skipped"`
		}
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil || len(out.Skipped) != 0 ||
			out.Updated[0].Status != tc.status || out.Updated[0].ContactCount != tc.count {
			t.Fatalf("%s: %d %s want status %s count %d", tc.body, rec.Code, rec.Body.String(), tc.status, tc.count)
		}
	}
}
