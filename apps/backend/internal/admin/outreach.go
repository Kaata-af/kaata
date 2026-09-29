package admin

// Operator outreach (2026-09-29): the admin "Outreach" section. Matee messages
// (a) shopkeepers who installed Kaata and (b) the people those shopkeepers
// recorded, from numbers the backend already holds — installs.self_phone,
// accounts.phone_e164 and the person_* events of synced kaatas — and ticks
// sent / replied / status / note by hand. Numbers are keyed by their normalized
// digit string, never by FK: one number surfaces from several tables, installs
// are never deleted while accounts can be, and a contacted number must keep its
// history after every source row is gone. Customer numbers come from folding
// each vault's event log directly (sync.LoadVaultProjection) because
// vault_snapshots lag the log by up to 1000 events / 24 h.
//
// Balance rule, mirrored from apps/mobile/lib/money-sql.ts signedEntryMinorSumSql
// (the app's PERSON_BALANCE_SQL): deleted entries are excluded, settled entries
// are NOT excluded, 'debt' adds and 'payment' subtracts each amount after it is
// rounded to integer hundredths (half away from zero, like SQLite's ROUND(x*100)),
// and the sum is formatted "1234.50". Positive = the person owes the shop.
//
// Linked listings: a relationship bound to a mutual tab (tab_parties.vault_id +
// relationship_id) is flagged Linked, and its balance, tallies and last_tally_at
// are still ONLY this vault's local fold — the pre-link rows plus any local
// tallies written after the link — never the shared account's tab_entries. The
// app shows such a contact through the tab arm of PERSON_BALANCE_SQL (D8), so a
// linked listing's number is the local side of that account, not the account.

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/httpx"
	ksync "github.com/matee/kaata-backend/internal/sync"
)

const (
	outreachBodyLimit       = 64 << 10
	outreachMaxPhones       = 500
	outreachMaxContacts     = 10000
	outreachTouchesPerPhone = 20
	outreachNoteRunes       = 2000
	outreachNoteTouchRunes  = 200
	outreachDetailRunes     = 100
	outreachSettingRunes    = 8000
	outreachFollowUpAfter   = 48 * time.Hour
)

var outreachStatuses = map[string]bool{
	"new": true, "sent": true, "replied": true, "interested": true,
	"installed": true, "declined": true, "do_not_contact": true,
}

var outreachSettingKeyRe = regexp.MustCompile(`^[a-z_]{1,32}(\.[a-z_]{1,16}){0,2}$`)

// ---------- wire types (docs: outreach contract §1.3–1.5) ----------

type OutreachKaata struct {
	VaultID     string `json:"vault_id"`
	Name        string `json:"name"`
	Currency    string `json:"currency"`
	Role        string `json:"role"`
	Archived    bool   `json:"archived"`
	MemberCount int    `json:"member_count"`
	People      int    `json:"people"`
	Tallies     int    `json:"tallies"`
	Receivable  string `json:"receivable"`    // "1234.50"
	Payable     string `json:"payable"`       // "1234.50"
	LastTallyAt string `json:"last_tally_at"` // RFC3339 UTC or ""
}

type OutreachShopkeeper struct {
	AccountID       string          `json:"account_id"`
	Email           string          `json:"email"`
	SignedIn        bool            `json:"signed_in"`
	InstallCount    int             `json:"install_count"`
	Platform        string          `json:"platform"`
	AppVersion      string          `json:"app_version"`
	Locale          string          `json:"locale"`
	Source          string          `json:"source"`
	Attribution     string          `json:"attribution"`
	InstalledAt     string          `json:"installed_at"`
	FirstSeen       string          `json:"first_seen"`
	LastSeen        string          `json:"last_seen"`
	LastActivityAt  string          `json:"last_activity_at"`
	HasOnboarded    bool            `json:"has_onboarded"`
	CheckInCount    int             `json:"check_in_count"`
	UsageEntries    int64           `json:"usage_entries"`
	UsageCustomers  int64           `json:"usage_customers"`
	UsageShares     int64           `json:"usage_shares"`
	Kaatas          []OutreachKaata `json:"kaatas"` // never null
	People          int             `json:"people"`
	Tallies         int             `json:"tallies"`
	ReceivableTotal string          `json:"receivable_total"`
	PayableTotal    string          `json:"payable_total"`
	Currency        string          `json:"currency"`
	LastTallyAt     string          `json:"last_tally_at"`
}

type OutreachListing struct {
	VaultID      string `json:"vault_id"`
	VaultName    string `json:"vault_name"`
	Currency     string `json:"currency"`
	OwnerName    string `json:"owner_name"`
	OwnerPhone   string `json:"owner_phone"`
	PersonName   string `json:"person_name"`
	Context      string `json:"context"`
	Archived     bool   `json:"archived"`
	FirstAddedAt string `json:"first_added_at"`
	LastTallyAt  string `json:"last_tally_at"`
	Tallies      int    `json:"tallies"`
	Balance      string `json:"balance"` // signed "300.00"; positive = person owes the shop
	Role         string `json:"role"`    // customer | supplier | settled
	Linked       bool   `json:"linked"`  // bound to a mutual tab; balance is the local fold only
}

type OutreachCustomer struct {
	Listings           []OutreachListing `json:"listings"` // never null
	MentionCount       int               `json:"mention_count"`
	FirstAddedAt       string            `json:"first_added_at"`
	LastTallyAt        string            `json:"last_tally_at"`
	TalliesTotal       int               `json:"tallies_total"`
	ArchivedEverywhere bool              `json:"archived_everywhere"`
	IsSupplierAnywhere bool              `json:"is_supplier_anywhere"`
	IsCustomerAnywhere bool              `json:"is_customer_anywhere"`
	IsWholesaler       bool              `json:"is_wholesaler"`
}

type OutreachTouch struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
	At     string `json:"at"`
}

type OutreachState struct {
	Phone            string          `json:"phone"`
	Status           string          `json:"status"`
	ContactedAt      string          `json:"contacted_at"`
	FirstContactedAt string          `json:"first_contacted_at"`
	RepliedAt        string          `json:"replied_at"`
	ContactCount     int             `json:"contact_count"`
	Note             string          `json:"note"`
	UpdatedAt        string          `json:"updated_at"`
	Touches          []OutreachTouch `json:"touches"` // never null; newest first; max 20
}

type OutreachContact struct {
	Phone       string              `json:"phone"`
	Kind        string              `json:"kind"` // shopkeeper | customer | both
	Name        string              `json:"name"`
	ShopName    string              `json:"shop_name"`
	Locale      string              `json:"locale"`     // shopkeeper locale, else the first listing owner's install locale, else ""
	Shopkeeper  *OutreachShopkeeper `json:"shopkeeper"` // null for pure customers
	Customer    *OutreachCustomer   `json:"customer"`   // null for pure shopkeepers
	Outreach    OutreachState       `json:"outreach"`
	Converted   bool                `json:"converted"`
	FollowUpDue bool                `json:"follow_up_due"`
}

type OutreachCounts struct {
	Total        int `json:"total"`
	Shopkeepers  int `json:"shopkeepers"` // kind == shopkeeper
	Customers    int `json:"customers"`   // kind == customer
	Both         int `json:"both"`
	Wholesalers  int `json:"wholesalers"`
	ToContact    int `json:"to_contact"` // status == new
	Sent         int `json:"sent"`       // status == sent
	Replied      int `json:"replied"`
	Interested   int `json:"interested"`
	Installed    int `json:"installed"`
	Declined     int `json:"declined"` // declined + do_not_contact
	FollowUpsDue int `json:"follow_ups_due"`
	Converted    int `json:"converted"`
	SentToday    int `json:"sent_today"` // touches kind=sent on the Kabul reporting day
	RepliedToday int `json:"replied_today"`
}

type OutreachResult struct {
	Contacts    []OutreachContact `json:"contacts"` // never null
	Settings    map[string]string `json:"settings"` // never null ({})
	Counts      OutreachCounts    `json:"counts"`
	GeneratedAt string            `json:"generated_at"`
}

// OutreachMarkInput is a validated POST /v1/admin/outreach/mark body: phones
// already normalized and deduplicated, status already checked, note already
// clamped. Nil pointers mean "absent from the body".
type OutreachMarkInput struct {
	Phones      []string
	Status      *string
	Note        *string
	Contacted   bool
	Replied     bool
	TemplateKey string
}

// OutreachSetting is the POST /v1/admin/outreach/setting response; Value and
// UpdatedAt are "" after a delete.
type OutreachSetting struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	UpdatedAt string `json:"updated_at"`
}

// ---------- phone normalization ----------

// normalizeOutreachPhone keeps ASCII digits only and returns "+"+digits when
// 7..15 remain. Persian / Arabic-Indic digits are NOT converted — they are not
// ASCII, so they drop out and the value fails — and a "00" trunk prefix stays
// as digits, so "0093700000001" is a different key from "+93700000001". Every
// source value and every phone in a POST body goes through this. Pure.
func normalizeOutreachPhone(s string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if c := s[i]; c >= '0' && c <= '9' {
			b.WriteByte(c)
		}
	}
	digits := b.String()
	if len(digits) < 7 || len(digits) > 15 {
		return "", false
	}
	return "+" + digits, true
}

// ---------- money ----------

var outreachHundred = big.NewRat(100, 1)

// amountHundredths parses a json.Number amount as a decimal string — never
// through float64 — into integer hundredths: "100" → 10000, "100.5" → 10050,
// "12.34" → 1234, "-3" → -300. More than two decimals round half away from
// zero ("0.005" → 1), which is what SQLite's ROUND(amount_afn * 100) does in
// the app's signedEntryMinorSumSql. Unparsable or out-of-range → false.
func amountHundredths(n json.Number) (int64, bool) {
	s := strings.TrimSpace(string(n))
	if s == "" || strings.Contains(s, "/") {
		return 0, false
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return 0, false
	}
	r.Mul(r, outreachHundred)
	num := new(big.Int).Abs(r.Num())
	den := r.Denom()
	q, m := new(big.Int).QuoRem(num, den, new(big.Int))
	if m.Mul(m, big.NewInt(2)).Cmp(den) >= 0 {
		q.Add(q, big.NewInt(1))
	}
	if !q.IsInt64() {
		return 0, false
	}
	v := q.Int64()
	if r.Sign() < 0 {
		v = -v
	}
	return v, true
}

// formatHundredths renders integer hundredths as a signed "1234.50" string.
func formatHundredths(v int64) string {
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	return fmt.Sprintf("%s%d.%02d", sign, v/100, v%100)
}

func balanceRole(v int64) string {
	switch {
	case v > 0:
		return "customer"
	case v < 0:
		return "supplier"
	}
	return "settled"
}

// ---------- small helpers ----------

func outreachTime(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func outreachMS(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

func minTimePtr(cur *time.Time, t time.Time) *time.Time {
	if cur == nil || t.Before(*cur) {
		return &t
	}
	return cur
}

func maxTimePtr(cur *time.Time, t time.Time) *time.Time {
	if cur == nil || t.After(*cur) {
		return &t
	}
	return cur
}

// clampRunes caps s at max runes without splitting a UTF-8 sequence (which
// Postgres would reject). Notes and templates are operator-typed Dari.
func clampRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

// outreachText is the one path operator-typed text takes into a TEXT column:
// clamp to max runes, then drop U+0000, which encoding/json decodes from
// "\u0000" and Postgres refuses (22021) in any text value.
func outreachText(s string, max int) string {
	return strings.ReplaceAll(clampRunes(s, max), "\x00", "")
}

// ---------- source rows ----------

type outreachAccount struct {
	id, name, email, phone string
	createdAt              time.Time
}

type outreachInstall struct {
	installID, accountID                              string
	selfName, selfPhone, shopName                     string
	platform, appVersion, locale, source, attribution string
	installedAt, lastActivityAt                       *time.Time
	firstSeen, lastSeen                               time.Time
	hasOnboarded                                      bool
	checkInCount                                      int
	usageEntries, usageCustomers, usageShares         int64
}

type outreachVault struct {
	id, name, currency, ownerID string
	archived                    bool
	memberCount                 int
	fold                        *outreachFold
}

type outreachMember struct{ vaultID, accountID, role string }

// outreachFold is one vault's event log folded to what the report needs.
type outreachFold struct {
	people, tallies     int
	receivable, payable int64 // hundredths
	lastTallyMS         int64
	listings            []outreachFoldListing
}

type outreachFoldListing struct {
	phone        string
	relID        string
	listing      OutreachListing
	lastTallyMS  int64
	firstAddedMS int64
}

// foldOutreachVault walks a projection's relationships (UserBID = the person)
// and non-deleted entries. Receivable/payable sum EVERY relationship's balance,
// archived ones included (an archived debtor still owes); people counts only
// non-archived relationships. Listings need the projection's phone: the app
// nulls it on archive when no active relationship remains, and an archived
// person without a phone is not a contact.
func foldOutreachVault(p *ksync.Projection) outreachFold {
	type relStats struct {
		tallies int
		balance int64
		lastMS  int64
	}
	stats := map[string]*relStats{}
	f := outreachFold{listings: []outreachFoldListing{}}
	for _, e := range p.Entries {
		if e.IsDeleted {
			continue
		}
		st := stats[e.RelationshipID]
		if st == nil {
			st = &relStats{}
			stats[e.RelationshipID] = st
		}
		st.tallies++
		f.tallies++
		if v, ok := amountHundredths(e.AmountAFN); ok {
			switch e.Type {
			case "debt":
				st.balance += v
			case "payment":
				st.balance -= v
			}
		}
		if e.CreatedAt > st.lastMS {
			st.lastMS = e.CreatedAt
		}
		if e.CreatedAt > f.lastTallyMS {
			f.lastTallyMS = e.CreatedAt
		}
	}
	relIDs := make([]string, 0, len(p.Relationships))
	for id := range p.Relationships {
		relIDs = append(relIDs, id)
	}
	sort.Strings(relIDs)
	for _, id := range relIDs {
		rel := p.Relationships[id]
		st := stats[id]
		if st == nil {
			st = &relStats{}
		}
		if rel.ArchivedAt == nil {
			f.people++
		}
		if st.balance > 0 {
			f.receivable += st.balance
		} else if st.balance < 0 {
			f.payable -= st.balance
		}
		u := p.Users[rel.UserBID]
		if u == nil || u.PhoneE164 == nil {
			continue
		}
		phone, ok := normalizeOutreachPhone(*u.PhoneE164)
		if !ok {
			continue
		}
		f.listings = append(f.listings, outreachFoldListing{
			phone: phone,
			relID: id,
			listing: OutreachListing{
				PersonName:   u.DisplayName,
				Context:      rel.Context,
				Archived:     rel.ArchivedAt != nil,
				FirstAddedAt: outreachMS(u.CreatedAt),
				LastTallyAt:  outreachMS(st.lastMS),
				Tallies:      st.tallies,
				Balance:      formatHundredths(st.balance),
				Role:         balanceRole(st.balance),
			},
			lastTallyMS:  st.lastMS,
			firstAddedMS: u.CreatedAt,
		})
	}
	return f
}

// ---------- outreach state rows ----------

type outreachRow struct {
	state       OutreachState
	contactedAt *time.Time
}

type outreachQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// readOutreachStates loads outreach_contacts plus the newest 20 touches per
// phone; phones == nil means every row.
func readOutreachStates(ctx context.Context, q outreachQuerier, phones []string) (map[string]*outreachRow, error) {
	all := phones == nil
	if phones == nil {
		phones = []string{}
	}
	out := map[string]*outreachRow{}
	rows, err := q.Query(ctx, `
		SELECT phone_e164, status, contacted_at, first_contacted_at, replied_at,
		       contact_count, note, updated_at
		FROM outreach_contacts
		WHERE $2::boolean OR phone_e164 = ANY($1::text[])
	`, phones, all)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r outreachRow
		var first, replied *time.Time
		var updated time.Time
		if err := rows.Scan(&r.state.Phone, &r.state.Status, &r.contactedAt, &first, &replied,
			&r.state.ContactCount, &r.state.Note, &updated); err != nil {
			rows.Close()
			return nil, err
		}
		r.state.ContactedAt = outreachTime(r.contactedAt)
		r.state.FirstContactedAt = outreachTime(first)
		r.state.RepliedAt = outreachTime(replied)
		r.state.UpdatedAt = updated.UTC().Format(time.RFC3339)
		r.state.Touches = []OutreachTouch{}
		out[r.state.Phone] = &r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	trows, err := q.Query(ctx, `
		SELECT phone_e164, kind, detail, created_at FROM (
			SELECT phone_e164, kind, detail, created_at,
			       row_number() OVER (PARTITION BY phone_e164 ORDER BY created_at DESC, id DESC) AS rn,
			       id
			FROM outreach_touches
			WHERE $2::boolean OR phone_e164 = ANY($1::text[])
		) t
		WHERE rn <= $3
		ORDER BY phone_e164, created_at DESC, id DESC
	`, phones, all, outreachTouchesPerPhone)
	if err != nil {
		return nil, err
	}
	defer trows.Close()
	for trows.Next() {
		var phone string
		var touch OutreachTouch
		var at time.Time
		if err := trows.Scan(&phone, &touch.Kind, &touch.Detail, &at); err != nil {
			return nil, err
		}
		r := out[phone]
		if r == nil {
			continue
		}
		touch.At = at.UTC().Format(time.RFC3339)
		r.state.Touches = append(r.state.Touches, touch)
	}
	return out, trows.Err()
}

// ---------- GET /v1/admin/outreach ----------

func (s *Service) outreachAccounts(ctx context.Context, tx pgx.Tx) (map[string]*outreachAccount, []string, error) {
	byID := map[string]*outreachAccount{}
	order := []string{}
	rows, err := tx.Query(ctx, `
		SELECT a.id::text, COALESCE(a.name, ''), a.email, COALESCE(a.phone_e164, ''), a.created_at
		FROM accounts a
		WHERE a.id::text <> ALL($1::text[])
		ORDER BY a.created_at, a.id
	`, s.operatorAccountIDs)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a outreachAccount
		if err := rows.Scan(&a.id, &a.name, &a.email, &a.phone, &a.createdAt); err != nil {
			return nil, nil, err
		}
		byID[a.id] = &a
		order = append(order, a.id)
	}
	return byID, order, rows.Err()
}

// outreachInstalls returns every non-operator install, most recently seen
// first, through the same report_installs CTE the Users page resolves with.
func (s *Service) outreachInstalls(ctx context.Context, tx pgx.Tx) ([]outreachInstall, error) {
	rows, err := tx.Query(ctx, userReportInstalls+`
		SELECT install_id::text, COALESCE(resolved_account_id::text, ''),
		       COALESCE(self_name, ''), COALESCE(self_phone, ''), COALESCE(shop_name, ''),
		       COALESCE(platform, ''), COALESCE(app_version, ''),
		       COALESCE(NULLIF(app_locale, ''), COALESCE(device_locale, '')),
		       COALESCE(source, ''), COALESCE(attribution_method, ''),
		       installed_at, first_seen_at, last_seen_at, last_activity_at,
		       has_onboarded, check_in_count,
		       usage_entries_created, usage_customers_added, usage_shares_sent
		FROM report_installs
		WHERE resolved_account_id IS NULL OR resolved_account_id::text <> ALL($1::text[])
		ORDER BY last_seen_at DESC, install_id
	`, s.operatorAccountIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []outreachInstall{}
	for rows.Next() {
		var in outreachInstall
		if err := rows.Scan(&in.installID, &in.accountID,
			&in.selfName, &in.selfPhone, &in.shopName,
			&in.platform, &in.appVersion, &in.locale, &in.source, &in.attribution,
			&in.installedAt, &in.firstSeen, &in.lastSeen, &in.lastActivityAt,
			&in.hasOnboarded, &in.checkInCount,
			&in.usageEntries, &in.usageCustomers, &in.usageShares); err != nil {
			return nil, err
		}
		out = append(out, in)
	}
	return out, rows.Err()
}

// outreachVaults returns non-operator, non-purged vaults (archived kept) in
// name order plus active memberships grouped by account.
func (s *Service) outreachVaults(ctx context.Context, tx pgx.Tx) (map[string]*outreachVault, []string, map[string][]outreachMember, error) {
	vaults := map[string]*outreachVault{}
	order := []string{}
	rows, err := tx.Query(ctx, `
		SELECT v.vault_id::text, v.name, COALESCE(v.currency, ''), v.owner_account_id::text,
		       (v.archived_at IS NOT NULL)
		FROM vaults v
		WHERE v.purged_at IS NULL AND v.owner_account_id::text <> ALL($1::text[])
		ORDER BY v.name, v.vault_id
	`, s.operatorAccountIDs)
	if err != nil {
		return nil, nil, nil, err
	}
	for rows.Next() {
		var v outreachVault
		if err := rows.Scan(&v.id, &v.name, &v.currency, &v.ownerID, &v.archived); err != nil {
			rows.Close()
			return nil, nil, nil, err
		}
		vaults[v.id] = &v
		order = append(order, v.id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, nil, err
	}
	byAccount := map[string][]outreachMember{}
	mrows, err := tx.Query(ctx, `
		SELECT vm.vault_id::text, vm.account_id::text, vm.role
		FROM vault_members vm
		WHERE vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		  AND vm.account_id IS NOT NULL
		ORDER BY vm.id
	`)
	if err != nil {
		return nil, nil, nil, err
	}
	defer mrows.Close()
	for mrows.Next() {
		var m outreachMember
		if err := mrows.Scan(&m.vaultID, &m.accountID, &m.role); err != nil {
			return nil, nil, nil, err
		}
		v := vaults[m.vaultID]
		if v == nil {
			continue // operator-owned or purged
		}
		v.memberCount++
		byAccount[m.accountID] = append(byAccount[m.accountID], m)
	}
	return vaults, order, byAccount, mrows.Err()
}

type outreachVaultRel struct{ vaultID, relID string }

// outreachLinkedRelationships returns every (vault, relationship) pair bound
// to a mutual tab party, so a listing can be flagged Linked.
func outreachLinkedRelationships(ctx context.Context, tx pgx.Tx) (map[outreachVaultRel]bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT vault_id::text, relationship_id::text
		FROM tab_parties
		WHERE vault_id IS NOT NULL AND relationship_id IS NOT NULL
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[outreachVaultRel]bool{}
	for rows.Next() {
		var k outreachVaultRel
		if err := rows.Scan(&k.vaultID, &k.relID); err != nil {
			return nil, err
		}
		out[k] = true
	}
	return out, rows.Err()
}

type outreachShopGroup struct {
	phone    string
	installs []*outreachInstall // most recently seen first
	account  *outreachAccount
}

type outreachShopBuilt struct {
	sk                 OutreachShopkeeper
	name, shop, locale string
	lastSeen           *time.Time
	installedAt        *time.Time
}

func buildOutreachShopkeeper(g *outreachShopGroup, vaults map[string]*outreachVault, membersByAccount map[string][]outreachMember) outreachShopBuilt {
	b := outreachShopBuilt{sk: OutreachShopkeeper{Kaatas: []OutreachKaata{}}}
	sk := &b.sk
	if g.account != nil {
		sk.AccountID = g.account.id
		sk.Email = g.account.email
		sk.SignedIn = true
	}
	sk.InstallCount = len(g.installs)
	var firstSeen, lastActivity *time.Time
	for i, in := range g.installs {
		if i == 0 {
			sk.Platform = in.platform
			sk.AppVersion = in.appVersion
			sk.Locale = in.locale
			sk.Source = in.source
			sk.Attribution = in.attribution
		}
		if b.name == "" {
			b.name = in.selfName
		}
		if b.shop == "" {
			b.shop = in.shopName
		}
		sk.HasOnboarded = sk.HasOnboarded || in.hasOnboarded
		sk.CheckInCount += in.checkInCount
		sk.UsageEntries += in.usageEntries
		sk.UsageCustomers += in.usageCustomers
		sk.UsageShares += in.usageShares
		installed := in.firstSeen
		if in.installedAt != nil {
			installed = *in.installedAt
		}
		b.installedAt = minTimePtr(b.installedAt, installed)
		firstSeen = minTimePtr(firstSeen, in.firstSeen)
		b.lastSeen = maxTimePtr(b.lastSeen, in.lastSeen)
		if in.lastActivityAt != nil {
			lastActivity = maxTimePtr(lastActivity, *in.lastActivityAt)
		}
	}
	if len(g.installs) == 0 && g.account != nil {
		created := g.account.createdAt
		b.installedAt = &created
	}
	if b.name == "" && g.account != nil {
		b.name = g.account.name
	}
	b.locale = sk.Locale
	sk.InstalledAt = outreachTime(b.installedAt)
	sk.FirstSeen = outreachTime(firstSeen)
	sk.LastSeen = outreachTime(b.lastSeen)
	sk.LastActivityAt = outreachTime(lastActivity)

	var receivable, payable, lastTally int64
	if g.account != nil {
		for _, m := range membersByAccount[g.account.id] {
			v := vaults[m.vaultID]
			if v == nil || v.fold == nil {
				continue
			}
			sk.Kaatas = append(sk.Kaatas, OutreachKaata{
				VaultID:     v.id,
				Name:        v.name,
				Currency:    v.currency,
				Role:        m.role,
				Archived:    v.archived,
				MemberCount: v.memberCount,
				People:      v.fold.people,
				Tallies:     v.fold.tallies,
				Receivable:  formatHundredths(v.fold.receivable),
				Payable:     formatHundredths(v.fold.payable),
				LastTallyAt: outreachMS(v.fold.lastTallyMS),
			})
			sk.People += v.fold.people
			sk.Tallies += v.fold.tallies
			receivable += v.fold.receivable
			payable += v.fold.payable
			if v.fold.lastTallyMS > lastTally {
				lastTally = v.fold.lastTallyMS
			}
		}
		sort.SliceStable(sk.Kaatas, func(i, j int) bool {
			if sk.Kaatas[i].Name != sk.Kaatas[j].Name {
				return sk.Kaatas[i].Name < sk.Kaatas[j].Name
			}
			return sk.Kaatas[i].VaultID < sk.Kaatas[j].VaultID
		})
	}
	if len(sk.Kaatas) > 0 {
		sk.Currency = sk.Kaatas[0].Currency
	}
	sk.ReceivableTotal = formatHundredths(receivable)
	sk.PayableTotal = formatHundredths(payable)
	sk.LastTallyAt = outreachMS(lastTally)
	return b
}

type outreachCustGroup struct {
	phone    string
	listings []outreachFoldListing
	owners   []string // owner account per listing, same order
}

type outreachCustBuilt struct {
	cu          OutreachCustomer
	name        string
	firstOwner  string
	lastTallyMS int64
}

func buildOutreachCustomer(g *outreachCustGroup) outreachCustBuilt {
	idx := make([]int, len(g.listings))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool {
		la, lb := g.listings[idx[a]], g.listings[idx[b]]
		if (la.lastTallyMS > 0) != (lb.lastTallyMS > 0) {
			return la.lastTallyMS > 0
		}
		if la.lastTallyMS != lb.lastTallyMS {
			return la.lastTallyMS > lb.lastTallyMS
		}
		if la.listing.VaultName != lb.listing.VaultName {
			return la.listing.VaultName < lb.listing.VaultName
		}
		return la.listing.VaultID < lb.listing.VaultID
	})
	b := outreachCustBuilt{cu: OutreachCustomer{Listings: []OutreachListing{}}}
	cu := &b.cu
	var firstAdded int64
	archivedEverywhere := len(idx) > 0
	for n, i := range idx {
		l := g.listings[i]
		cu.Listings = append(cu.Listings, l.listing)
		cu.TalliesTotal += l.listing.Tallies
		if n == 0 {
			b.name = l.listing.PersonName
			b.firstOwner = g.owners[i]
		}
		if !l.listing.Archived {
			archivedEverywhere = false
		}
		switch l.listing.Role {
		case "supplier":
			cu.IsSupplierAnywhere = true
		case "customer":
			cu.IsCustomerAnywhere = true
		}
		if l.lastTallyMS > b.lastTallyMS {
			b.lastTallyMS = l.lastTallyMS
		}
		if l.firstAddedMS > 0 && (firstAdded == 0 || l.firstAddedMS < firstAdded) {
			firstAdded = l.firstAddedMS
		}
	}
	cu.MentionCount = len(cu.Listings)
	cu.FirstAddedAt = outreachMS(firstAdded)
	cu.LastTallyAt = outreachMS(b.lastTallyMS)
	cu.ArchivedEverywhere = archivedEverywhere
	cu.IsWholesaler = cu.MentionCount >= 2 || cu.IsSupplierAnywhere
	return b
}

// GetOutreach builds the whole section in one RepeatableRead snapshot, like
// GetUsers, so an install cannot flip between shopkeeper and customer halves
// mid-report. Operator accounts, installs resolved to them and vaults they own
// are excluded; purged vaults are skipped, archived ones kept.
func (s *Service) GetOutreach(ctx context.Context) (OutreachResult, error) {
	now := s.now()
	out := OutreachResult{Contacts: []OutreachContact{}, Settings: map[string]string{}}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	accounts, accountOrder, err := s.outreachAccounts(ctx, tx)
	if err != nil {
		return out, err
	}
	installs, err := s.outreachInstalls(ctx, tx)
	if err != nil {
		return out, err
	}
	vaults, vaultOrder, membersByAccount, err := s.outreachVaults(ctx, tx)
	if err != nil {
		return out, err
	}
	linked, err := outreachLinkedRelationships(ctx, tx)
	if err != nil {
		return out, err
	}
	for _, vid := range vaultOrder {
		p, err := ksync.LoadVaultProjection(ctx, tx, vid)
		if err != nil {
			return out, fmt.Errorf("fold vault %s: %w", vid, err)
		}
		f := foldOutreachVault(p)
		vaults[vid].fold = &f
	}

	// Latest install per account: the owner-phone fallback and the customer
	// locale fallback both read it.
	latestByAccount := map[string]*outreachInstall{}
	latestPhoneByAccount := map[string]string{}
	for i := range installs {
		in := &installs[i]
		if in.accountID == "" {
			continue
		}
		if _, ok := latestByAccount[in.accountID]; !ok {
			latestByAccount[in.accountID] = in
		}
		if _, ok := latestPhoneByAccount[in.accountID]; !ok && in.selfPhone != "" {
			if ph, ok := normalizeOutreachPhone(in.selfPhone); ok {
				latestPhoneByAccount[in.accountID] = ph
			}
		}
	}
	ownerPhone := func(accountID string) string {
		if a := accounts[accountID]; a != nil && a.phone != "" {
			if ph, ok := normalizeOutreachPhone(a.phone); ok {
				return ph
			}
			return a.phone
		}
		return latestPhoneByAccount[accountID]
	}

	// SHOPKEEPER numbers: installs.self_phone, then accounts.phone_e164.
	shops := map[string]*outreachShopGroup{}
	for i := range installs {
		in := &installs[i]
		if in.selfPhone == "" {
			continue
		}
		ph, ok := normalizeOutreachPhone(in.selfPhone)
		if !ok {
			continue
		}
		g := shops[ph]
		if g == nil {
			g = &outreachShopGroup{phone: ph}
			shops[ph] = g
		}
		g.installs = append(g.installs, in)
		if g.account == nil && in.accountID != "" {
			g.account = accounts[in.accountID]
		}
	}
	for _, id := range accountOrder {
		a := accounts[id]
		if a.phone == "" {
			continue
		}
		ph, ok := normalizeOutreachPhone(a.phone)
		if !ok {
			continue
		}
		g := shops[ph]
		if g == nil {
			g = &outreachShopGroup{phone: ph}
			shops[ph] = g
		}
		if g.account == nil {
			g.account = a
		}
	}

	// CUSTOMER numbers: every listing of every folded vault.
	customers := map[string]*outreachCustGroup{}
	for _, vid := range vaultOrder {
		v := vaults[vid]
		ownerName := ""
		if a := accounts[v.ownerID]; a != nil {
			ownerName = a.name
		}
		oPhone := ownerPhone(v.ownerID)
		for _, fl := range v.fold.listings {
			fl.listing.VaultID = v.id
			fl.listing.VaultName = v.name
			fl.listing.Currency = v.currency
			fl.listing.OwnerName = ownerName
			fl.listing.OwnerPhone = oPhone
			fl.listing.Linked = linked[outreachVaultRel{vaultID: v.id, relID: fl.relID}]
			g := customers[fl.phone]
			if g == nil {
				g = &outreachCustGroup{phone: fl.phone}
				customers[fl.phone] = g
			}
			g.listings = append(g.listings, fl)
			g.owners = append(g.owners, v.ownerID)
		}
	}

	states, err := readOutreachStates(ctx, tx, nil)
	if err != nil {
		return out, err
	}

	// MERGE by normalized phone.
	phones := make([]string, 0, len(shops)+len(customers))
	for ph := range shops {
		phones = append(phones, ph)
	}
	for ph := range customers {
		if _, dup := shops[ph]; !dup {
			phones = append(phones, ph)
		}
	}
	sort.Strings(phones)

	type sortable struct {
		c     OutreachContact
		rank  int
		at    time.Time
		hasAt bool
	}
	items := make([]sortable, 0, len(phones))
	for _, ph := range phones {
		sg, cg := shops[ph], customers[ph]
		item := sortable{c: OutreachContact{Phone: ph}}
		c := &item.c
		switch {
		case sg != nil && cg != nil:
			c.Kind, item.rank = "both", 1
		case sg != nil:
			c.Kind, item.rank = "shopkeeper", 0
		default:
			c.Kind, item.rank = "customer", 2
		}
		if row := states[ph]; row != nil {
			c.Outreach = row.state
		} else {
			c.Outreach = OutreachState{Phone: ph, Status: "new", Touches: []OutreachTouch{}}
		}
		var installedAt *time.Time
		if sg != nil {
			b := buildOutreachShopkeeper(sg, vaults, membersByAccount)
			sk := b.sk
			c.Shopkeeper = &sk
			c.Name, c.ShopName, c.Locale = b.name, b.shop, b.locale
			installedAt = b.installedAt
			if b.lastSeen != nil {
				item.at, item.hasAt = *b.lastSeen, true
			}
		}
		if cg != nil {
			b := buildOutreachCustomer(cg)
			cu := b.cu
			c.Customer = &cu
			if c.Name == "" {
				c.Name = b.name
			}
			if c.Locale == "" {
				if in := latestByAccount[b.firstOwner]; in != nil {
					c.Locale = in.locale
				}
			}
			if sg == nil && b.lastTallyMS > 0 {
				item.at, item.hasAt = time.UnixMilli(b.lastTallyMS).UTC(), true
			}
		}
		if row := states[ph]; row != nil && row.contactedAt != nil {
			c.Converted = installedAt != nil && installedAt.After(*row.contactedAt)
			c.FollowUpDue = c.Outreach.Status == "sent" && now.Sub(*row.contactedAt) >= outreachFollowUpAfter
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.rank != b.rank {
			return a.rank < b.rank
		}
		if a.hasAt != b.hasAt {
			return a.hasAt
		}
		if a.hasAt && !a.at.Equal(b.at) {
			return a.at.After(b.at)
		}
		if a.c.Name != b.c.Name {
			return a.c.Name < b.c.Name
		}
		return a.c.Phone < b.c.Phone
	})
	if len(items) > outreachMaxContacts {
		items = items[:outreachMaxContacts]
	}
	for _, it := range items {
		c := it.c
		out.Contacts = append(out.Contacts, c)
		out.Counts.Total++
		switch c.Kind {
		case "shopkeeper":
			out.Counts.Shopkeepers++
		case "customer":
			out.Counts.Customers++
		default:
			out.Counts.Both++
		}
		if c.Customer != nil && c.Customer.IsWholesaler {
			out.Counts.Wholesalers++
		}
		switch c.Outreach.Status {
		case "new":
			out.Counts.ToContact++
		case "sent":
			out.Counts.Sent++
		case "replied":
			out.Counts.Replied++
		case "interested":
			out.Counts.Interested++
		case "installed":
			out.Counts.Installed++
		case "declined", "do_not_contact":
			out.Counts.Declined++
		}
		if c.FollowUpDue {
			out.Counts.FollowUpsDue++
		}
		if c.Converted {
			out.Counts.Converted++
		}
	}

	// Today = the Kabul reporting day, like every other admin count.
	var sentToday, repliedToday int64
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE kind = 'sent'), COUNT(*) FILTER (WHERE kind = 'replied')
		FROM outreach_touches
		WHERE (created_at AT TIME ZONE 'Asia/Kabul')::date = ($1::timestamptz AT TIME ZONE 'Asia/Kabul')::date
	`, now).Scan(&sentToday, &repliedToday); err != nil {
		return out, err
	}
	out.Counts.SentToday = int(sentToday)
	out.Counts.RepliedToday = int(repliedToday)

	srows, err := tx.Query(ctx, `SELECT key, value FROM outreach_settings`)
	if err != nil {
		return out, err
	}
	for srows.Next() {
		var k, v string
		if err := srows.Scan(&k, &v); err != nil {
			srows.Close()
			return out, err
		}
		out.Settings[k] = v
	}
	srows.Close()
	if err := srows.Err(); err != nil {
		return out, err
	}
	out.GeneratedAt = now.UTC().Format(time.RFC3339)
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

// ---------- POST /v1/admin/outreach/mark ----------

// MarkOutreach applies one tick to every phone inside ONE transaction and
// returns the re-read states, in input order. Timestamps come from s.now()
// rather than SQL NOW() so tests can pin the clock the follow-up rule reads.
func (s *Service) MarkOutreach(ctx context.Context, in OutreachMarkInput) ([]OutreachState, error) {
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Row locks are taken in one canonical order so two overlapping bulk marks
	// cannot wait on each other's rows (40P01); the response keeps in.Phones'
	// order below.
	locked := append([]string(nil), in.Phones...)
	sort.Strings(locked)
	for _, ph := range locked {
		// Insert-or-lock in one statement; the no-op DO UPDATE takes the row
		// lock and RETURNING hands back the current status either way.
		var current string
		if err := tx.QueryRow(ctx, `
			INSERT INTO outreach_contacts (phone_e164, updated_at) VALUES ($1, $2::timestamptz)
			ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
			RETURNING status
		`, ph, now).Scan(&current); err != nil {
			return nil, err
		}
		status := current
		if in.Contacted && status == "new" {
			status = "sent"
		}
		if in.Replied && (status == "new" || status == "sent") {
			status = "replied"
		}
		if in.Status != nil {
			status = *in.Status
		}
		if _, err := tx.Exec(ctx, `
			UPDATE outreach_contacts SET
			  contacted_at       = CASE WHEN $2::boolean THEN $6::timestamptz ELSE contacted_at END,
			  first_contacted_at = CASE WHEN $2::boolean THEN COALESCE(first_contacted_at, $6::timestamptz)
			                            ELSE first_contacted_at END,
			  contact_count      = contact_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
			  replied_at         = CASE WHEN $3::boolean THEN $6::timestamptz ELSE replied_at END,
			  status             = $4,
			  note               = COALESCE($5::text, note),
			  updated_at         = $6::timestamptz
			WHERE phone_e164 = $1
		`, ph, in.Contacted, in.Replied, status, in.Note, now); err != nil {
			return nil, err
		}
		touch := func(kind, detail string) error {
			_, err := tx.Exec(ctx, `
				INSERT INTO outreach_touches (phone_e164, kind, detail, created_at)
				VALUES ($1, $2, $3, $4::timestamptz)
			`, ph, kind, detail, now)
			return err
		}
		if in.Contacted {
			if err := touch("sent", in.TemplateKey); err != nil {
				return nil, err
			}
		}
		if in.Replied {
			if err := touch("replied", ""); err != nil {
				return nil, err
			}
		}
		if in.Status != nil {
			if err := touch("status", *in.Status); err != nil {
				return nil, err
			}
		}
		if in.Note != nil {
			if err := touch("note", clampRunes(*in.Note, outreachNoteTouchRunes)); err != nil {
				return nil, err
			}
		}
	}
	states, err := readOutreachStates(ctx, tx, in.Phones)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	out := make([]OutreachState, 0, len(in.Phones))
	for _, ph := range in.Phones {
		if row := states[ph]; row != nil {
			out = append(out, row.state)
		}
	}
	return out, nil
}

// ---------- POST /v1/admin/outreach/setting ----------

// SetOutreachSetting upserts one key; an empty / whitespace value deletes it.
func (s *Service) SetOutreachSetting(ctx context.Context, key, value string) (OutreachSetting, error) {
	now := s.now()
	if strings.TrimSpace(value) == "" {
		if _, err := s.pool.Exec(ctx, `DELETE FROM outreach_settings WHERE key = $1`, key); err != nil {
			return OutreachSetting{}, err
		}
		return OutreachSetting{Key: key}, nil
	}
	var updated time.Time
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO outreach_settings (key, value, updated_at) VALUES ($1, $2, $3::timestamptz)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
		RETURNING updated_at
	`, key, value, now).Scan(&updated); err != nil {
		return OutreachSetting{}, err
	}
	return OutreachSetting{Key: key, Value: value, UpdatedAt: updated.UTC().Format(time.RFC3339)}, nil
}

// ---------- handlers ----------

// Outreach — GET /v1/admin/outreach. Mounted behind httpx.AdminKeyMiddleware.
func (h *Handler) Outreach(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.GetOutreach(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "outreach query failed")
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

type outreachMarkBody struct {
	Phones      []string `json:"phones"`
	Status      *string  `json:"status"`
	Note        *string  `json:"note"`
	Contacted   *bool    `json:"contacted"`
	Replied     *bool    `json:"replied"`
	TemplateKey *string  `json:"template_key"`
}

// OutreachMark — POST /v1/admin/outreach/mark. Phones travel only in the JSON
// body (the request logger prints paths), 1..500 per call, each normalized.
// Pointer fields tell an absent key from an empty one.
func (h *Handler) OutreachMark(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, outreachBodyLimit)
	var body outreachMarkBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(body.Phones) == 0 || len(body.Phones) > outreachMaxPhones {
		httpx.Error(w, http.StatusBadRequest, "invalid phone")
		return
	}
	in := OutreachMarkInput{Phones: make([]string, 0, len(body.Phones))}
	seen := map[string]bool{}
	for _, raw := range body.Phones {
		ph, ok := normalizeOutreachPhone(raw)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid phone")
			return
		}
		if !seen[ph] {
			seen[ph] = true
			in.Phones = append(in.Phones, ph)
		}
	}
	if body.Status != nil {
		if !outreachStatuses[*body.Status] {
			httpx.Error(w, http.StatusBadRequest, "invalid status")
			return
		}
		in.Status = body.Status
	}
	if body.Note != nil {
		note := outreachText(*body.Note, outreachNoteRunes)
		in.Note = &note
	}
	in.Contacted = body.Contacted != nil && *body.Contacted
	in.Replied = body.Replied != nil && *body.Replied
	if body.TemplateKey != nil {
		in.TemplateKey = outreachText(*body.TemplateKey, outreachDetailRunes)
	}
	updated, err := h.svc.MarkOutreach(r.Context(), in)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "outreach update failed")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Updated []OutreachState `json:"updated"`
	}{Updated: updated})
}

type outreachSettingBody struct {
	Key   *string `json:"key"`
	Value *string `json:"value"`
}

// OutreachSetting — POST /v1/admin/outreach/setting. Empty / whitespace value
// deletes the key.
func (h *Handler) OutreachSetting(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, outreachBodyLimit)
	var body outreachSettingBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Key == nil || !outreachSettingKeyRe.MatchString(*body.Key) {
		httpx.Error(w, http.StatusBadRequest, "invalid key")
		return
	}
	value := ""
	if body.Value != nil {
		value = outreachText(*body.Value, outreachSettingRunes)
	}
	res, err := h.svc.SetOutreachSetting(r.Context(), *body.Key, value)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "outreach setting failed")
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}
