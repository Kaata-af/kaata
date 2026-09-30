package admin

// Operator outreach (2026-09-29): the admin "Outreach" section. Matee messages
// (a) shopkeepers who installed Kaata and (b) the people those shopkeepers
// recorded, from numbers the backend already holds — installs.self_phone,
// accounts.phone_e164 and the person_* events of synced kaatas — and ticks
// sent / replied / status / note by hand. Numbers are keyed by their
// normalized form (normalizeOutreachPhone), never by FK: one number surfaces
// from several tables, installs are never deleted while accounts can be, and
// a contacted number must keep its history after every source row is gone.
// Customer numbers come from folding each vault's event log directly
// (sync.LoadVaultProjection) because vault_snapshots lag the log by up to
// 1000 events / 24 h.
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
//
// Batch 2 (2026-09-30): opening a WhatsApp chat records `opened` and starts a
// pending window (pending_since); only a recorded verdict ends it — an
// outcome (sent, not on WhatsApp, invalid number, skip for the Kabul day), a
// send or reply ticked in bulk, or any status but New — so an interrupted
// session cannot message a number twice and the queue resumes from the
// server, not the browser. Every row carries a version that each
// write bumps and each outcome may pin (expected_version → 409), because two
// dashboard tabs can hold the same contact. Test data is excluded BY SOURCE
// (outreach_exclusions: a vault, an account or an install the operator
// verified) and only that source's contribution is dropped, so a test book
// cannot hide a number a real book also holds. Number plausibility is
// libphonenumber (outreach_number.go); it never implies WhatsApp presence.
//
// Final round (2026-09-30): a number is offered for a first message only
// while never_messaged holds — no send ever recorded, and every chat ever
// opened for it resolved as "nothing sent" — read from the whole touch log
// (readOutreachStates). Bulk "Mark sent" records first sends only; a
// follow-up is the version-checked outcome `sent`. A status never rides with
// a send or a reply in one mark, and a declined or do-not-contact row keeps
// its stop until a one-phone status mark carries lift_stop.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nyaruka/phonenumbers"

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
	outreachReasonRunes     = 200
	outreachFollowUpAfter   = 48 * time.Hour
)

var outreachStatuses = map[string]bool{
	"new": true, "sent": true, "replied": true, "interested": true,
	"installed": true, "declined": true, "do_not_contact": true,
	"no_whatsapp": true, "invalid": true,
}

// outreachSendable are the statuses a send promotes to 'sent': a fresh
// contact, or one the operator had written off and then reached after all.
var outreachSendable = map[string]bool{"new": true, "no_whatsapp": true, "invalid": true}

// outreachRetryable are the only statuses `retry` may reopen; anything else
// is 409 not retryable, so a stale queue cannot reset a real conversation.
var outreachRetryable = map[string]bool{"no_whatsapp": true, "invalid": true}

// outreachStopped are the statuses that stop contact (2026-09-30). The
// outcome endpoint refuses opened / sent / no_whatsapp / invalid on them with
// 409 contact stopped: opening or sending would message someone who said no,
// and an unreachable verdict would replace the stop with a status that Retry
// resets to New. skip stays allowed, since it sends nothing and closes a
// pending window. Only a one-phone status mark carrying lift_stop lifts a
// stop; a bulk relabel skips stopped rows (MarkOutreach).
var outreachStopped = map[string]bool{"do_not_contact": true, "declined": true}

var outreachOutcomes = map[string]bool{
	"opened": true, "sent": true, "no_whatsapp": true, "invalid": true, "skip": true, "retry": true,
}

var outreachExclusionKinds = map[string]bool{"vault": true, "account": true, "install": true}

var (
	// ErrOutreachStale — expected_version is behind the row: another tab, or
	// a retried click after a lost response, already recorded an outcome for
	// this contact. Nothing was written.
	ErrOutreachStale = errors.New("stale outcome")
	// ErrOutreachNotRetryable — retry on a contact that is not no_whatsapp /
	// invalid. Nothing was written.
	ErrOutreachNotRetryable = errors.New("not retryable")
	// ErrOutreachStopped — opened / sent / no_whatsapp / invalid on a
	// declined or do-not-contact contact. Nothing was written.
	ErrOutreachStopped = errors.New("contact stopped")
)

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
	InstallIDs      []string        `json:"install_ids"` // never null; most recently seen first
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
	NeverMessaged    bool            `json:"never_messaged"` // first-contact test over the whole log; true without a row (readOutreachStates)
	Note             string          `json:"note"`
	UpdatedAt        string          `json:"updated_at"`
	OpenedAt         string          `json:"opened_at"`     // last chat open
	PendingSince     string          `json:"pending_since"` // opened with no outcome since; "" otherwise
	SkippedAt        string          `json:"skipped_at"`    // "skip for now"; the page hides it for that Kabul day
	OpenCount        int             `json:"open_count"`
	Version          int64           `json:"version"` // bumped on every write; 0 without a row
	Touches          []OutreachTouch `json:"touches"` // never null; newest first; max 20
}

type OutreachContact struct {
	Phone       string              `json:"phone"`
	Kind        string              `json:"kind"` // shopkeeper | customer | both
	Number      OutreachNumber      `json:"number"`
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
	Pending      int `json:"pending"`      // pending_since set
	Unreachable  int `json:"unreachable"`  // status no_whatsapp + invalid
	Invalid      int `json:"invalid"`      // number.valid == false
	OpenedToday  int `json:"opened_today"` // touches kind=opened on the Kabul reporting day
}

// OutreachExclusion is one operator-verified test source. Label is resolved
// at read time so the page can name what it is undoing.
type OutreachExclusion struct {
	Kind      string `json:"kind"` // vault | account | install
	ID        string `json:"id"`
	Label     string `json:"label"` // vault: "<name> · <owner>"; account: name or email; install: self_name / shop_name / id prefix
	Reason    string `json:"reason"`
	CreatedAt string `json:"created_at"`
}

type OutreachResult struct {
	Contacts    []OutreachContact   `json:"contacts"` // never null
	Settings    map[string]string   `json:"settings"` // never null ({})
	Counts      OutreachCounts      `json:"counts"`
	Exclusions  []OutreachExclusion `json:"exclusions"` // never null; newest first
	GeneratedAt string              `json:"generated_at"`
}

// OutreachMarkInput is a validated POST /v1/admin/outreach/mark body: phones
// already normalized and deduplicated, status already checked, note already
// clamped. Nil pointers mean "absent from the body". Status never comes with
// Contacted or Replied, and LiftStop only with exactly one phone: the handler
// refuses both bodies.
type OutreachMarkInput struct {
	Phones      []string
	Status      *string
	Note        *string
	Contacted   bool
	Replied     bool
	TemplateKey string
	LiftStop    bool // lets Status replace declined / do_not_contact (MarkOutreach)
}

// OutreachOutcomeInput is a validated POST /v1/admin/outreach/outcome body:
// one normalized phone, one outcome, detail text already clamped. A nil
// ExpectedVersion skips the version check (the page omits it for `opened`).
type OutreachOutcomeInput struct {
	Phone           string
	Outcome         string // opened | sent | no_whatsapp | invalid | skip | retry
	TemplateKey     string
	Reason          string
	ExpectedVersion *int64
}

// OutreachSetting is the POST /v1/admin/outreach/setting response; Value and
// UpdatedAt are "" after a delete.
type OutreachSetting struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	UpdatedAt string `json:"updated_at"`
}

// ---------- phone normalization ----------

// normalizeOutreachPhone keeps ASCII digits only and requires 7..15 of them.
// Persian / Arabic-Indic digits are NOT converted — they are not ASCII, so
// they drop out and the value fails. The digits are then read as an
// international number by libphonenumber (2026-09-30): when that is a VALID
// number the key is its E.164 form, so a trunk zero typed after the country
// code ("+93 0700 000 001") lands on the same key, contact and outreach row as
// "+93 700 000 001", and every wa.me link is canonical. Anything else keeps
// "+"+digits as before: a "00" trunk prefix stays as digits ("0093700000001"
// is a different key from "+93700000001") and an invalid number is not
// guessed at. A valid number whose E.164 form would be under 7 digits
// ("+98 0 9601" → "+989601") keeps its digits too, because this function
// would refuse that form on the way back in. Outreach rows written under a
// non-canonical key before this are not re-keyed; production held
// essentially no outreach history then.
// Keys therefore depend on the libphonenumber metadata pinned in go.mod
// (github.com/nyaruka/phonenumbers): an upgrade that changes a numbering plan
// can make a number valid or invalid, or change its E.164 form, and so re-key
// it — the contact then shows under the new key while its outreach row and
// touches stay under the old one. After an upgrade, check
// `SELECT phone_e164 FROM outreach_contacts` for keys that no longer
// normalize to themselves.
// Every source value and every phone in a POST body goes through this, and
// its output normalizes to itself. Pure.
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
	if n, err := phonenumbers.Parse("+"+digits, ""); err == nil && phonenumbers.IsValidNumber(n) {
		if e164 := phonenumbers.Format(n, phonenumbers.E164); len(e164) > 7 {
			return e164, true
		}
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
// phone; phones == nil means every row. GET, the mark response and the
// outcome response all read states here, so each carries never_messaged.
//
// never_messaged (2026-09-30) is the queue's first-contact test: the number
// was never recorded as sent (contact_count 0), and the latest "chat" touch
// — opened, skipped, retry, or a status touch no_whatsapp / invalid, by
// created_at then id — is not an unresolved `opened`. So a pending row is
// false and turns true again after skip, retry, not on WhatsApp or invalid;
// any counted send makes it false for good; a status or note alone (say
// Interested, then New again) never resolves an open. It is computed over
// the WHOLE touch log, not the 20-touch window below: a chat opened long ago
// and followed by many notes is still unresolved. A contact with no row is
// never messaged (GetOutreach's default).
func readOutreachStates(ctx context.Context, q outreachQuerier, phones []string) (map[string]*outreachRow, error) {
	all := phones == nil
	if phones == nil {
		phones = []string{}
	}
	out := map[string]*outreachRow{}
	rows, err := q.Query(ctx, `
		SELECT c.phone_e164, c.status, c.contacted_at, c.first_contacted_at, c.replied_at,
		       c.contact_count, c.note, c.updated_at,
		       c.opened_at, c.pending_since, c.skipped_at, c.open_count, c.version,
		       c.contact_count = 0 AND chat.kind IS DISTINCT FROM 'opened' AS never_messaged
		FROM outreach_contacts c
		LEFT JOIN LATERAL (
			SELECT t.kind
			FROM outreach_touches t
			WHERE t.phone_e164 = c.phone_e164
			  AND (t.kind IN ('opened', 'skipped', 'retry')
			       OR (t.kind = 'status' AND t.detail IN ('no_whatsapp', 'invalid')))
			ORDER BY t.created_at DESC, t.id DESC
			LIMIT 1
		) chat ON TRUE
		WHERE $2::boolean OR c.phone_e164 = ANY($1::text[])
	`, phones, all)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r outreachRow
		var first, replied, opened, pending, skipped *time.Time
		var updated time.Time
		if err := rows.Scan(&r.state.Phone, &r.state.Status, &r.contactedAt, &first, &replied,
			&r.state.ContactCount, &r.state.Note, &updated,
			&opened, &pending, &skipped, &r.state.OpenCount, &r.state.Version,
			&r.state.NeverMessaged); err != nil {
			rows.Close()
			return nil, err
		}
		r.state.ContactedAt = outreachTime(r.contactedAt)
		r.state.FirstContactedAt = outreachTime(first)
		r.state.RepliedAt = outreachTime(replied)
		r.state.UpdatedAt = updated.UTC().Format(time.RFC3339)
		r.state.OpenedAt = outreachTime(opened)
		r.state.PendingSince = outreachTime(pending)
		r.state.SkippedAt = outreachTime(skipped)
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

// ---------- exclusions ----------

// outreachExclusionSet is outreach_exclusions loaded once per request: the id
// sets the builders consult plus the labelled list the page shows.
type outreachExclusionSet struct {
	vaults, accounts, installs map[string]bool
	list                       []OutreachExclusion
}

type outreachSourceKey struct{ kind, id string }

// outreachIDPrefix labels a source whose row is gone or blank: the first UUID
// group is enough to tell exclusions apart on the page.
func outreachIDPrefix(id string) string { return clampRunes(id, 8) }

// readOutreachExclusions loads every exclusion, newest first, and resolves the
// labels straight from vaults / accounts / installs — not through the
// operator-filtered maps GetOutreach builds, because an excluded source may be
// exactly the kind of row those filters drop, and the page still has to name
// it so the operator can undo it.
func readOutreachExclusions(ctx context.Context, q outreachQuerier) (*outreachExclusionSet, error) {
	set := &outreachExclusionSet{
		vaults: map[string]bool{}, accounts: map[string]bool{}, installs: map[string]bool{},
		list: []OutreachExclusion{},
	}
	rows, err := q.Query(ctx, `
		SELECT kind, id, reason, created_at
		FROM outreach_exclusions
		ORDER BY created_at DESC, kind, id
	`)
	if err != nil {
		return nil, err
	}
	ids := map[string][]string{}
	for rows.Next() {
		var x OutreachExclusion
		var at time.Time
		if err := rows.Scan(&x.Kind, &x.ID, &x.Reason, &at); err != nil {
			rows.Close()
			return nil, err
		}
		x.CreatedAt = at.UTC().Format(time.RFC3339)
		x.Label = outreachIDPrefix(x.ID)
		switch x.Kind {
		case "vault":
			set.vaults[x.ID] = true
		case "account":
			set.accounts[x.ID] = true
		case "install":
			set.installs[x.ID] = true
		}
		ids[x.Kind] = append(ids[x.Kind], x.ID)
		set.list = append(set.list, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Each label query returns id + three text columns; ids are compared as
	// text so a hand-inserted non-UUID row cannot fail the whole report.
	labels := map[outreachSourceKey]string{}
	resolve := func(kind, sql string, label func(a, b, c string) string) error {
		if len(ids[kind]) == 0 {
			return nil
		}
		lrows, err := q.Query(ctx, sql, ids[kind])
		if err != nil {
			return err
		}
		defer lrows.Close()
		for lrows.Next() {
			var id, a, b, c string
			if err := lrows.Scan(&id, &a, &b, &c); err != nil {
				return err
			}
			if l := label(a, b, c); l != "" {
				labels[outreachSourceKey{kind, id}] = l
			}
		}
		return lrows.Err()
	}
	if err := resolve("vault", `
		SELECT v.vault_id::text, v.name, COALESCE(a.name, ''), COALESCE(a.email, '')
		FROM vaults v LEFT JOIN accounts a ON a.id = v.owner_account_id
		WHERE v.vault_id::text = ANY($1::text[])
	`, func(name, owner, email string) string {
		if owner == "" {
			owner = email
		}
		if owner == "" {
			return name
		}
		return name + " · " + owner
	}); err != nil {
		return nil, err
	}
	if err := resolve("account", `
		SELECT id::text, COALESCE(name, ''), email, ''
		FROM accounts
		WHERE id::text = ANY($1::text[])
	`, func(name, email, _ string) string {
		if name != "" {
			return name
		}
		return email
	}); err != nil {
		return nil, err
	}
	if err := resolve("install", `
		SELECT install_id::text, COALESCE(self_name, ''), COALESCE(shop_name, ''), ''
		FROM installs
		WHERE install_id::text = ANY($1::text[])
	`, func(selfName, shopName, _ string) string {
		if selfName != "" {
			return selfName
		}
		return shopName
	}); err != nil {
		return nil, err
	}
	for i := range set.list {
		if l := labels[outreachSourceKey{set.list[i].Kind, set.list[i].ID}]; l != "" {
			set.list[i].Label = l
		}
	}
	return set, nil
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
	b := outreachShopBuilt{sk: OutreachShopkeeper{Kaatas: []OutreachKaata{}, InstallIDs: []string{}}}
	sk := &b.sk
	if g.account != nil {
		sk.AccountID = g.account.id
		sk.Email = g.account.email
		sk.SignedIn = true
	}
	sk.InstallCount = len(g.installs)
	var firstSeen, lastActivity *time.Time
	for i, in := range g.installs {
		sk.InstallIDs = append(sk.InstallIDs, in.installID)
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
				continue // operator-owned, purged or excluded
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
// are excluded; purged vaults are skipped, archived ones kept. Operator-
// verified test sources (outreach_exclusions) are dropped per source on top:
// a vault loses its listings and its place in its members' kaatas and totals,
// an account or install its shopkeeper half.
func (s *Service) GetOutreach(ctx context.Context) (OutreachResult, error) {
	now := s.now()
	out := OutreachResult{Contacts: []OutreachContact{}, Settings: map[string]string{}, Exclusions: []OutreachExclusion{}}
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
	excl, err := readOutreachExclusions(ctx, tx)
	if err != nil {
		return out, err
	}
	out.Exclusions = excl.list
	// An excluded install — or one resolved to an excluded account —
	// contributes no shopkeeper block and feeds neither the owner-phone nor
	// the locale fallback below; an excluded account's own phone is no
	// shopkeeper source either (the accounts loop). The account row itself
	// stays loaded, so a listing in a book that account owns still shows the
	// owner's name and the account's own phone (never an excluded install's):
	// excluding an account does not exclude its books. A number known only
	// through test data is never emitted, while a real book's listing of the
	// same number survives.
	kept := installs[:0]
	for _, in := range installs {
		if excl.installs[in.installID] || (in.accountID != "" && excl.accounts[in.accountID]) {
			continue
		}
		kept = append(kept, in)
	}
	installs = kept
	vaults, vaultOrder, membersByAccount, err := s.outreachVaults(ctx, tx)
	if err != nil {
		return out, err
	}
	// An excluded book contributes nothing either (2026-09-30): no listings,
	// and no kaata, people, tallies, totals, currency or last tally under any
	// member's shopkeeper block, so a test book cannot inflate a real
	// shopkeeper's receivable. Dropped before the fold, it is never folded;
	// buildOutreachShopkeeper skips a membership whose vault is gone.
	keptVaults := vaultOrder[:0]
	for _, vid := range vaultOrder {
		if excl.vaults[vid] {
			delete(vaults, vid)
			continue
		}
		keptVaults = append(keptVaults, vid)
	}
	vaultOrder = keptVaults
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
		if a.phone == "" || excl.accounts[id] {
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
		item := sortable{c: OutreachContact{Phone: ph, Number: describeOutreachNumber(ph)}}
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
			c.Outreach = OutreachState{Phone: ph, Status: "new", NeverMessaged: true, Touches: []OutreachTouch{}}
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
		case "no_whatsapp", "invalid":
			out.Counts.Unreachable++
		}
		if c.FollowUpDue {
			out.Counts.FollowUpsDue++
		}
		if c.Converted {
			out.Counts.Converted++
		}
		if c.Outreach.PendingSince != "" {
			out.Counts.Pending++
		}
		if !c.Number.Valid {
			out.Counts.Invalid++
		}
	}

	// Today = the Kabul reporting day, like every other admin count.
	var sentToday, repliedToday, openedToday int64
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE kind = 'sent'), COUNT(*) FILTER (WHERE kind = 'replied'),
		       COUNT(*) FILTER (WHERE kind = 'opened')
		FROM outreach_touches
		WHERE (created_at AT TIME ZONE 'Asia/Kabul')::date = ($1::timestamptz AT TIME ZONE 'Asia/Kabul')::date
	`, now).Scan(&sentToday, &repliedToday, &openedToday); err != nil {
		return out, err
	}
	out.Counts.SentToday = int(sentToday)
	out.Counts.RepliedToday = int(repliedToday)
	out.Counts.OpenedToday = int(openedToday)

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

// ---------- row writes shared by mark and outcome ----------

// lockOutreachRow inserts-or-locks one outreach_contacts row in one statement
// — the no-op DO UPDATE takes the row lock — and returns its current status,
// version and send count. A row created here and then refused (stale version,
// not retryable) is rolled back with the transaction, so a refusal writes
// nothing.
func lockOutreachRow(ctx context.Context, tx pgx.Tx, ph string, now time.Time) (status string, version int64, contactCount int, err error) {
	err = tx.QueryRow(ctx, `
		INSERT INTO outreach_contacts (phone_e164, updated_at) VALUES ($1, $2::timestamptz)
		ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
		RETURNING status, version, contact_count
	`, ph, now).Scan(&status, &version, &contactCount)
	return status, version, contactCount, err
}

func insertOutreachTouch(ctx context.Context, tx pgx.Tx, ph, kind, detail string, now time.Time) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO outreach_touches (phone_e164, kind, detail, created_at)
		VALUES ($1, $2, $3, $4::timestamptz)
	`, ph, kind, detail, now)
	return err
}

// writeOutreachMark applies one mark to a locked row — the contacted / replied
// / status / note fields, the version bump and the touches. The bulk mark and
// the outcome `sent` both go through here, so contact_count, contacted_at and
// the sent touch cannot drift between the two buttons. A send also clears
// pending_since and skipped_at: the message went out, so the contact is no
// longer awaiting an outcome or parked for the day. A reply or an explicit
// status other than "new" clears both too (2026-09-30): a decided row is
// neither awaiting an outcome nor parked. An explicit "new" keeps both, so
// resetting a row to New cannot silently put a chat that was opened without
// an outcome back in the queue, where it could be opened and sent again.
func writeOutreachMark(ctx context.Context, tx pgx.Tx, ph string, now time.Time, in OutreachMarkInput, current string) error {
	endsWait := in.Contacted || in.Replied || (in.Status != nil && *in.Status != "new")
	status := current
	if in.Contacted && outreachSendable[status] {
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
		  pending_since      = CASE WHEN $7::boolean THEN NULL ELSE pending_since END,
		  skipped_at         = CASE WHEN $7::boolean THEN NULL ELSE skipped_at END,
		  replied_at         = CASE WHEN $3::boolean THEN $6::timestamptz ELSE replied_at END,
		  status             = $4,
		  note               = COALESCE($5::text, note),
		  version            = version + 1,
		  updated_at         = $6::timestamptz
		WHERE phone_e164 = $1
	`, ph, in.Contacted, in.Replied, status, in.Note, now, endsWait); err != nil {
		return err
	}
	if in.Contacted {
		if err := insertOutreachTouch(ctx, tx, ph, "sent", in.TemplateKey, now); err != nil {
			return err
		}
	}
	if in.Replied {
		if err := insertOutreachTouch(ctx, tx, ph, "replied", "", now); err != nil {
			return err
		}
	}
	if in.Status != nil {
		if err := insertOutreachTouch(ctx, tx, ph, "status", *in.Status, now); err != nil {
			return err
		}
	}
	if in.Note != nil {
		if err := insertOutreachTouch(ctx, tx, ph, "note", clampRunes(*in.Note, outreachNoteTouchRunes), now); err != nil {
			return err
		}
	}
	return nil
}

// ---------- POST /v1/admin/outreach/mark ----------

// MarkOutreach applies one tick to every phone inside ONE transaction and
// returns the re-read states, in input order. Timestamps come from s.now()
// rather than SQL NOW() so tests can pin the clock the follow-up rule reads.
//
// A contacted mark records a FIRST message only (2026-09-30): it counts a row
// only while the status is sendable (new, no_whatsapp or invalid) AND no send
// was ever recorded (contact_count 0). Any other row — already sent, replied,
// stopped, or messaged before and since relabelled — is left exactly as it
// was, with no count, touch, version bump or other field, and its phone is
// returned in skipped (input order, never nil). A repeated or overlapping
// bulk "Mark sent" therefore cannot count a message twice or write to a
// stopped contact; a follow-up message is recorded only through the
// version-checked outcome `sent`. updated still carries every requested
// phone's current state, skipped ones included.
//
// A stop is lifted one row at a time (2026-09-30): a status that is not
// itself a stop, on a declined or do-not-contact row, skips that row the same
// way unless LiftStop is set — which the handler accepts for one phone only,
// the row's own status menu — so a bulk relabel cannot put a number that said
// no back in front of the operator. Setting or re-setting a stop always
// applies, and a reply or a note never lifts one.
func (s *Service) MarkOutreach(ctx context.Context, in OutreachMarkInput) (updated []OutreachState, skipped []string, err error) {
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Row locks are taken in one canonical order so two overlapping bulk marks
	// cannot wait on each other's rows (40P01); the response keeps in.Phones'
	// order below. The checks read the row under its lock, so of two
	// overlapping marks only the first counts.
	locked := append([]string(nil), in.Phones...)
	sort.Strings(locked)
	left := map[string]bool{}
	for _, ph := range locked {
		current, _, sends, err := lockOutreachRow(ctx, tx, ph, now)
		if err != nil {
			return nil, nil, err
		}
		liftsStop := in.Status != nil && outreachStopped[current] && !outreachStopped[*in.Status]
		if (in.Contacted && (!outreachSendable[current] || sends > 0)) || (liftsStop && !in.LiftStop) {
			left[ph] = true
			continue
		}
		if err := writeOutreachMark(ctx, tx, ph, now, in, current); err != nil {
			return nil, nil, err
		}
	}
	states, err := readOutreachStates(ctx, tx, in.Phones)
	if err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	updated = make([]OutreachState, 0, len(in.Phones))
	skipped = []string{}
	for _, ph := range in.Phones {
		if row := states[ph]; row != nil {
			updated = append(updated, row.state)
		}
		if left[ph] {
			skipped = append(skipped, ph)
		}
	}
	return updated, skipped, nil
}

// ---------- POST /v1/admin/outreach/outcome ----------

// RecordOutreachOutcome applies one outcome to one contact under its row lock.
// The lock and the version check come first, so a second "sent" from another
// tab — or a retried click after a lost response — is refused before it can
// count a message twice; the outcome then reads the row exactly as the first
// caller left it. A declined or do-not-contact row then refuses opened, sent,
// no_whatsapp and invalid (outreachStopped); skip still applies and retry
// keeps its own rule. The state is re-read in the same transaction.
func (s *Service) RecordOutreachOutcome(ctx context.Context, in OutreachOutcomeInput) (OutreachState, error) {
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OutreachState{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, version, _, err := lockOutreachRow(ctx, tx, in.Phone, now)
	if err != nil {
		return OutreachState{}, err
	}
	if in.ExpectedVersion != nil && *in.ExpectedVersion != version {
		return OutreachState{}, ErrOutreachStale
	}
	if outreachStopped[current] {
		switch in.Outcome {
		case "opened", "sent", "no_whatsapp", "invalid":
			return OutreachState{}, ErrOutreachStopped
		}
	}
	switch in.Outcome {
	case "opened":
		// Reopening a pending chat is legitimate and keeps pending_since: the
		// queue shows when the operator FIRST opened it, not the last time.
		_, err = tx.Exec(ctx, `
			UPDATE outreach_contacts SET
			  opened_at     = $2::timestamptz,
			  pending_since = COALESCE(pending_since, $2::timestamptz),
			  open_count    = open_count + 1,
			  version       = version + 1,
			  updated_at    = $2::timestamptz
			WHERE phone_e164 = $1
		`, in.Phone, now)
		if err == nil {
			err = insertOutreachTouch(ctx, tx, in.Phone, "opened", in.TemplateKey, now)
		}
	case "sent":
		err = writeOutreachMark(ctx, tx, in.Phone, now, OutreachMarkInput{Contacted: true, TemplateKey: in.TemplateKey}, current)
	case "no_whatsapp", "invalid":
		_, err = tx.Exec(ctx, `
			UPDATE outreach_contacts SET
			  status        = $2,
			  pending_since = NULL,
			  skipped_at    = NULL,
			  version       = version + 1,
			  updated_at    = $3::timestamptz
			WHERE phone_e164 = $1
		`, in.Phone, in.Outcome, now)
		if err == nil {
			err = insertOutreachTouch(ctx, tx, in.Phone, "status", in.Outcome, now)
		}
	case "skip":
		_, err = tx.Exec(ctx, `
			UPDATE outreach_contacts SET
			  skipped_at    = $2::timestamptz,
			  pending_since = NULL,
			  version       = version + 1,
			  updated_at    = $2::timestamptz
			WHERE phone_e164 = $1
		`, in.Phone, now)
		if err == nil {
			err = insertOutreachTouch(ctx, tx, in.Phone, "skipped", in.Reason, now)
		}
	case "retry":
		if !outreachRetryable[current] {
			return OutreachState{}, ErrOutreachNotRetryable
		}
		_, err = tx.Exec(ctx, `
			UPDATE outreach_contacts SET
			  status     = 'new',
			  skipped_at = NULL,
			  version    = version + 1,
			  updated_at = $2::timestamptz
			WHERE phone_e164 = $1
		`, in.Phone, now)
		if err == nil {
			err = insertOutreachTouch(ctx, tx, in.Phone, "retry", in.Reason, now)
		}
	default:
		return OutreachState{}, fmt.Errorf("outreach outcome %q", in.Outcome)
	}
	if err != nil {
		return OutreachState{}, err
	}
	states, err := readOutreachStates(ctx, tx, []string{in.Phone})
	if err != nil {
		return OutreachState{}, err
	}
	row := states[in.Phone]
	if row == nil {
		return OutreachState{}, errors.New("outreach outcome: row missing after write")
	}
	if err := tx.Commit(ctx); err != nil {
		return OutreachState{}, err
	}
	return row.state, nil
}

// ---------- POST /v1/admin/outreach/exclude ----------

// SetOutreachExclusion records or lifts one operator-verified test source and
// returns the full labelled list from the same transaction, so the response
// cannot show a list the write is missing from. Re-excluding replaces the
// reason and keeps the original created_at.
func (s *Service) SetOutreachExclusion(ctx context.Context, kind, id string, excluded bool, reason string) ([]OutreachExclusion, error) {
	now := s.now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if excluded {
		_, err = tx.Exec(ctx, `
			INSERT INTO outreach_exclusions (kind, id, reason, created_at) VALUES ($1, $2, $3, $4::timestamptz)
			ON CONFLICT (kind, id) DO UPDATE SET reason = EXCLUDED.reason
		`, kind, id, reason, now)
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM outreach_exclusions WHERE kind = $1 AND id = $2`, kind, id)
	}
	if err != nil {
		return nil, err
	}
	set, err := readOutreachExclusions(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return set.list, nil
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
	LiftStop    *bool    `json:"lift_stop"`
}

// OutreachMark — POST /v1/admin/outreach/mark. Phones travel only in the JSON
// body (the request logger prints paths), 1..500 per call, each normalized.
// Pointer fields tell an absent key from an empty one. Two bodies are 400
// invalid body with nothing written (2026-09-30): a status together with
// contacted:true or replied:true, and lift_stop:true naming more than one
// phone after dedupe. The response is {"updated": [state…], "skipped":
// [phone…]}: skipped lists the phones the mark left untouched — a contacted
// mark on a row that is not a first send, or a status that would lift a stop
// without lift_stop (MarkOutreach).
func (h *Handler) OutreachMark(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, outreachBodyLimit)
	var body outreachMarkBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	// A status says what a row IS; contacted and replied record what
	// happened. Together they are ambiguous — does the status or the send's
	// promotion win, and does a skipped send drop the status too? — so the
	// body is refused whole and a status is always its own mark.
	if body.Status != nil && ((body.Contacted != nil && *body.Contacted) || (body.Replied != nil && *body.Replied)) {
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
	in.LiftStop = body.LiftStop != nil && *body.LiftStop
	// A stop is lifted one row at a time, from that row's own status menu.
	if in.LiftStop && len(in.Phones) != 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.TemplateKey != nil {
		in.TemplateKey = outreachText(*body.TemplateKey, outreachDetailRunes)
	}
	updated, skipped, err := h.svc.MarkOutreach(r.Context(), in)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "outreach update failed")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Updated []OutreachState `json:"updated"`
		Skipped []string        `json:"skipped"`
	}{Updated: updated, Skipped: skipped})
}

type outreachOutcomeBody struct {
	Phone           *string `json:"phone"`
	Outcome         *string `json:"outcome"`
	TemplateKey     *string `json:"template_key"`
	Reason          *string `json:"reason"`
	ExpectedVersion *int64  `json:"expected_version"`
}

// OutreachOutcome — POST /v1/admin/outreach/outcome. One contact, one outcome,
// version-checked: 409 "stale outcome" when expected_version is behind the
// row, 409 "not retryable" for a retry on a contact that is not no_whatsapp /
// invalid, 409 "contact stopped" for opened / sent / no_whatsapp / invalid on
// a declined or do-not-contact contact; none of them writes anything. The
// phone travels only in the body.
func (h *Handler) OutreachOutcome(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, outreachBodyLimit)
	var body outreachOutcomeBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	in := OutreachOutcomeInput{ExpectedVersion: body.ExpectedVersion}
	if body.Phone == nil {
		httpx.Error(w, http.StatusBadRequest, "invalid phone")
		return
	}
	ph, ok := normalizeOutreachPhone(*body.Phone)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid phone")
		return
	}
	in.Phone = ph
	if body.Outcome == nil || !outreachOutcomes[*body.Outcome] {
		httpx.Error(w, http.StatusBadRequest, "invalid outcome")
		return
	}
	in.Outcome = *body.Outcome
	// Every verdict must name the version it was decided against. Without it a
	// repeated "sent" — a double click, a retried request after a lost
	// response — would count one message twice, and that guarantee must not
	// depend on the client remembering to send it. Only "opened" is exempt: a
	// chat that opened is a fact whatever the row looked like meanwhile.
	if in.Outcome != "opened" && body.ExpectedVersion == nil {
		httpx.Error(w, http.StatusBadRequest, "expected_version required")
		return
	}
	if body.TemplateKey != nil {
		in.TemplateKey = outreachText(*body.TemplateKey, outreachDetailRunes)
	}
	if body.Reason != nil {
		in.Reason = outreachText(*body.Reason, outreachReasonRunes)
	}
	state, err := h.svc.RecordOutreachOutcome(r.Context(), in)
	switch {
	case errors.Is(err, ErrOutreachStale):
		httpx.Error(w, http.StatusConflict, "stale outcome")
		return
	case errors.Is(err, ErrOutreachNotRetryable):
		httpx.Error(w, http.StatusConflict, "not retryable")
		return
	case errors.Is(err, ErrOutreachStopped):
		httpx.Error(w, http.StatusConflict, "contact stopped")
		return
	case err != nil:
		httpx.Error(w, http.StatusInternalServerError, "outreach outcome failed")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		State OutreachState `json:"state"`
	}{State: state})
}

type outreachExcludeBody struct {
	Kind     *string `json:"kind"`
	ID       *string `json:"id"`
	Excluded *bool   `json:"excluded"`
	Reason   *string `json:"reason"`
}

// OutreachExclude — POST /v1/admin/outreach/exclude. The only way a source
// becomes test data: a kind plus the UUID from the page's own buttons, never
// an inference. excluded is required (2026-09-30): true records, false lifts,
// and an absent or null flag is 400 invalid body with nothing written, so a
// truncated body cannot hide a source by default. The id is stored in
// canonical UUID form so every lookup compares equal text.
func (h *Handler) OutreachExclude(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, outreachBodyLimit)
	var body outreachExcludeBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Kind == nil || !outreachExclusionKinds[*body.Kind] {
		httpx.Error(w, http.StatusBadRequest, "invalid kind")
		return
	}
	if body.ID == nil || *body.ID == "" || len(*body.ID) > 64 {
		httpx.Error(w, http.StatusBadRequest, "invalid id")
		return
	}
	id, err := uuid.Parse(*body.ID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid id")
		return
	}
	if body.Excluded == nil {
		httpx.Error(w, http.StatusBadRequest, "invalid body")
		return
	}
	excluded := *body.Excluded
	reason := ""
	if body.Reason != nil {
		reason = outreachText(*body.Reason, outreachReasonRunes)
	}
	list, err := h.svc.SetOutreachExclusion(r.Context(), *body.Kind, id.String(), excluded, reason)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "outreach exclusion failed")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Exclusions []OutreachExclusion `json:"exclusions"`
	}{Exclusions: list})
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
