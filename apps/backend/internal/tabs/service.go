// Package tabs is the mutual tab (Kaata 2.0): one running account shared by
// two independent parties — a shopkeeper and a counterparty who may be
// another Kaata user or a person with only a browser. Both sides see the same
// figures; either can add a tally, the other can accept or dispute it, the
// author can void it. Nothing is edited or silently deleted.
//
// The SERVER is the source of truth (docs/mutual-tab-design.md D1): two
// parties plus a server need no CRDT, so this is a plain append-only model
// with a per-tab `seq` (creation order) and `rev` (the client cursor, bumped
// on EVERY change). The tab is deliberately NOT mirrored into the vault event
// log (D2) — mobile keeps its own cache and pulls `?after_rev=`.
//
// Access is a capability token per party, hashed at rest exactly like a
// vault invite (vaults.hashInviteToken), OR a session JWT whose account is
// bound to the party / is a member of the party's kaata (D10). Every
// "not yours / unknown" case collapses to one ErrNotFound (§3.1).
//
// Money: amount_minor BIGINT in the database, a decimal string in major units
// on the wire ("12.34", "100"), integer arithmetic only. Never float64 (D16).
package tabs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/tabstate"
)

// Typed errors. handler.go maps each to (status, error_code, message); the
// codes are the client's branch keys (§3.4) and stay stable even if the
// prose changes.
var (
	// ErrNotFound is the UNIFORM not-found: unknown token, unknown tab id,
	// token/JWT that is not a party, token for a different tab than the URL.
	// One sentinel on purpose — a caller must not be able to tell "no such
	// tab" from "a tab that is not yours" by status, code, message or side
	// effect (the vaults.ErrInviteNotFound discipline).
	ErrNotFound                     = errors.New("tab not found")
	ErrTabClosed                    = errors.New("tab is closed")
	ErrSharedHistoryPending         = errors.New("review or cancel pending tallies in the previous shared account before linking again")
	ErrInvalidRecordingMode         = errors.New("recording mode must be review, notify or notify_one_way")
	ErrOneWayReadOnly               = errors.New("only the creator can record tallies in this shared account")
	ErrReviewNotRequired            = errors.New("this tally was recorded without a review requirement")
	ErrJoinRequired                 = errors.New("join this account before recording tallies")
	ErrRecordedOpeningFinal         = errors.New("a joined opening is a fixed carry-over; add a correction tally instead")
	ErrSettledRecord                = errors.New("a recorded tally in a cleared chapter cannot be cancelled")
	ErrRecordedHistoryFinal         = errors.New("this recorded tally was carried into a later account; add a correction tally instead")
	ErrOpeningSourceChanged         = errors.New("the opening balance source changed; ask the sender for a refreshed link")
	ErrSharedHistoryChanged         = errors.New("shared account history changed; refresh the previous account before linking again")
	ErrSharedHistoryOpeningRequired = errors.New("an opening tally is required to carry the previously recorded shared balance")
	ErrNotAuthor                    = errors.New("only the author can void an entry")
	ErrOwnEntry                     = errors.New("cannot accept or dispute your own entry")
	ErrAuthRequired                 = errors.New("authentication required")
	ErrStaleReview                  = errors.New("tally has changed; review its latest state")
	ErrReviewFinal                  = errors.New("tally already reviewed; send a new tally instead")
	ErrAlreadyVoided                = errors.New("entry is already voided")
	ErrIDTaken                      = errors.New("entry id belongs to another tab or author")
	ErrInvalidAmount                = errors.New("amount must be a decimal string with up to two decimals, above 0 and at most 9999999999.99")
	ErrInvalidDirection             = errors.New("direction must be a_to_b or b_to_a")
	ErrLabelRequired                = errors.New("label is required")
	ErrInvalidLabel                 = errors.New("label must be at most 80 characters")
	ErrInvalidNote                  = errors.New("note must be at most 500 characters")
	ErrReasonRequired               = errors.New("reason is required")
	ErrInvalidReason                = errors.New("reason must be at most 300 characters")
	ErrInvalidCurrency              = errors.New("currency is required")
	ErrInvalidOccurredAt            = errors.New("occurred_at_ms must be a positive epoch-ms integer")
	ErrSameKaata                    = errors.New("both parties cannot be the same kaata")
	ErrSameAccount                  = errors.New("one account cannot see both sides of a shared account")
	ErrRoleInsufficient             = errors.New("your role in this kaata does not allow that")
	ErrNotPartyA                    = errors.New("only the party that created the tab can do that")
	ErrNotVaultMember               = errors.New("caller is not an active member of vault_id")
	ErrEntryNotFound                = errors.New("entry not found")
	ErrAlreadyLinked                = errors.New("contact already has a shared account")
	ErrCurrencyMismatch             = errors.New("kaata and shared account currencies must match")
)

const (
	// tokenBytes matches vaults.inviteTokenBytes: 32 random bytes → a 43-char
	// RawURLEncoding token with 256 bits of entropy, which is why a plain
	// SHA-256 (not bcrypt) at rest is enough — see hashPartyToken.
	tokenBytes = 32
	// maxTokenLen bounds the sha256 work on a garbage token BEFORE hashing,
	// same guard as vaults.InviteInfo / AcceptInvite.
	maxTokenLen = 512

	maxLabelRunes  = 80
	maxNoteRunes   = 500
	maxReasonRunes = 300
	// maxCurrencyRunes is generous for "AFN" / "؋" / "PKR" and rejects a
	// paragraph pasted into the field.
	maxCurrencyRunes = 16

	// duplicateWindowMS is D17's ±24 h: two parties recording the same cash
	// handover rarely disagree about the day by more than one.
	duplicateWindowMS = 24 * 60 * 60 * 1000

	// maxAmountMinor mirrors mobile's MAX_ENTRY_AMOUNT (9999999999.99).
	maxAmountMinor = 999_999_999_999
)

// amountRe is the ONLY accepted wire shape for an amount (§3.1): digits, an
// optional dot and one or two decimals. No sign, no grouping, no exponent —
// anything else is a client bug, not a value to guess at.
var amountRe = regexp.MustCompile(`^\d{1,10}(\.\d{1,2})?$`)

// Poker is the live-poke hook, satisfied structurally by *sync.Service
// (NotifyTab). Declared here so tabs never imports sync — the
// vaults.MembershipInvalidator pattern. Callers invoke it only AFTER the
// transaction committed, so a poked phone's immediate pull observes the
// change; pokes carry no data and may be dropped (the tab poll is the
// backstop).
type Poker interface {
	NotifyTab(tabID string, accountIDs []string)
}

// Service owns every tab read and write. One *pgxpool.Pool, no caches: a
// tab is small and every request is one short transaction.
type Service struct {
	pool          *pgxpool.Pool
	poker         Poker
	push          *pushClient
	creditBalance credit.BalanceReader
}

// NewService constructs the service over the shared pool.
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// SetPoker wires the post-commit live poke. Wired once in main.go; nil-safe
// (tests and a backend without the sync service simply never poke).
func (s *Service) SetPoker(p Poker) {
	s.poker = p
}

func (s *Service) SetCreditBalanceReader(read credit.BalanceReader) { s.creditBalance = read }

// querier is the subset of pgx shared by *pgxpool.Pool and pgx.Tx, so the
// read helpers below serve both the request path and the inside of a
// mutation's transaction.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// --------------------------------------------------------------------------
// Wire shapes (§3.4). Every timestamp is epoch ms; every amount a decimal
// string in major units.
// --------------------------------------------------------------------------

// Entry is one tally as the client sees it.
type Entry struct {
	AuthorAccountID        *string `json:"author_account_id"`
	AuthorName             string  `json:"author_name"`
	AuthorMemberRole       *string `json:"author_member_role"`
	ReviewerAccountID      *string `json:"reviewer_account_id"`
	ReviewerName           string  `json:"reviewer_name"`
	ReviewerParty          *string `json:"reviewer_party"`
	ReviewerMemberRole     *string `json:"reviewer_member_role"`
	ReviewSemanticsVersion *string `json:"review_semantics_version"`
	ID                     string  `json:"id"`
	Seq                    int64   `json:"seq"`
	Rev                    int64   `json:"rev"`
	CreatedBy              string  `json:"created_by"`
	Direction              string  `json:"direction"`
	Amount                 string  `json:"amount"`
	Kind                   string  `json:"kind"`
	Note                   *string `json:"note"`
	OccurredAtMS           int64   `json:"occurred_at_ms"`
	CreatedAtMS            int64   `json:"created_at_ms"`
	Status                 string  `json:"status"`
	StatusAtMS             *int64  `json:"status_at_ms"`
	DisputeReason          *string `json:"dispute_reason"`
	VoidsEntryID           *string `json:"voids_entry_id"`
	VoidedByEntryID        *string `json:"voided_by_entry_id"`

	// amountMinor is the stored integer the wire string was rendered from;
	// kept so a void can copy the original's amount without re-parsing.
	amountMinor int64
}

// PartyMeta is one side of the tab as shown to either side.
type PartyMeta struct {
	AccountName string `json:"account_name"`
	Label       string `json:"label"`
	JoinedAtMS  *int64 `json:"joined_at_ms"`
	// Decimal string preserves BIGINT ordering on JavaScript clients.
	HistoryOrder *string `json:"history_order"`
	// Bound is true when a session account is attached — the phone can
	// recover this tab through GET /v1/tabs/mine after a reinstall.
	Bound bool `json:"bound"`
	// Phone is the bound account's own E.164 number (accounts.phone_e164,
	// PUT /v1/account/phone), "" when the party is unbound or never set one.
	// It rides on every Tab payload so the OTHER party can match the
	// invitation to a contact at join time (D18) — the same exposure as the
	// label, and the invitation already arrives over WhatsApp from that
	// number. Display/matching only; never an identity proof or an ACL key.
	Phone string `json:"phone"`
}

// Tab is the meta block: identity, both parties, signed totals from EACH view
// and how many of the other party's tallies await the caller's review.
// A zero recorded balance alone does not mean the account was settled.
type Tab struct {
	RecordingMode string `json:"recording_mode"`
	// UnjoinedInvitation is authoritative evidence that B never participated.
	// Only a creator-side client may use it to retain its original private book.
	UnjoinedInvitation bool                 `json:"unjoined_invitation"`
	ID                 string               `json:"id"`
	Currency           string               `json:"currency"`
	Rev                int64                `json:"rev"`
	CreatedAtMS        int64                `json:"created_at_ms"`
	ClosedAtMS         *int64               `json:"closed_at_ms"`
	ClosedBy           *string              `json:"closed_by"`
	ClosedReason       *string              `json:"closed_reason"`
	You                string               `json:"you"`
	Parties            map[string]PartyMeta `json:"parties"`
	Balance            map[string]string    `json:"balance"`
	// Balance remains the recorded total for older clients. New clients show
	// the accepted amount separately from proposals that await a final review.
	ConfirmedBalance map[string]string `json:"confirmed_balance"`
	// RecordedBalance counts accepted and notification-only records without
	// claiming the latter were accepted. ConfirmedBalance stays review-only.
	RecordedBalance map[string]string `json:"recorded_balance"`
	PendingBalance  map[string]string `json:"pending_balance"`
	PendingForYou   int               `json:"pending_for_you"`
}

// TabResponse carries entries and chapter markers with rev > after_rev.
// Full says the client may replace its cache (after_rev was 0/absent).
type TabResponse struct {
	Tab         Tab          `json:"tab"`
	Entries     []Entry      `json:"entries"`
	Settlements []Settlement `json:"settlements"`
	Full        bool         `json:"full"`
}

// DuplicateHint (D17) points at the other party's tally that looks like the
// same transfer recorded from their side.
type DuplicateHint struct {
	EntryID string `json:"entry_id"`
	By      string `json:"by"`
	AtMS    int64  `json:"at_ms"`
}

// EntryResponse follows append / accept / dispute.
type EntryResponse struct {
	Entry         Entry          `json:"entry"`
	Tab           Tab            `json:"tab"`
	DuplicateHint *DuplicateHint `json:"duplicate_hint"`
}

// VoidResponse carries both halves of a void: the struck original and the
// new kind='void' row.
type VoidResponse struct {
	Voided Entry `json:"voided"`
	Void   Entry `json:"void"`
}

// MineItem is one tab in GET /v1/tabs/mine, with the caller's role and the
// party-side bindings the phone needs to rebuild its local link row.
type MineItem struct {
	Tab            Tab     `json:"tab"`
	Role           string  `json:"role"`
	VaultID        *string `json:"vault_id"`
	RelationshipID *string `json:"relationship_id"`
	LinkedAtMS     *int64  `json:"linked_at_ms"`
	HistoryOrder   *string `json:"history_order"`
}

// MineResponse lists every open or closed tab the account is a party of.
type MineResponse struct {
	Tabs []MineItem `json:"tabs"`
}

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

// OpeningInput is the optional D7 opening balance: one visible, disputable
// kind='opening' entry authored by the creator at link time.
type OpeningInput struct {
	Direction    string
	Amount       string
	Note         *string
	OccurredAtMS int64
}

// CreateInput — POST /v1/tabs. AccountID / InstallID come from the session
// claims when present (nil for a web creator).
type CreateInput struct {
	RecordingMode            string
	ExpectedHistoryRevisions map[string]int64
	ExpectedPreviousTabID    *string
	ExpectedPreviousRev      *int64
	LinkedAtMS               *int64
	Currency                 string
	Label                    string
	VaultID                  *string
	RelationshipID           *string
	AccountID                *string
	InstallID                *string
	Opening                  *OpeningInput
}

// CreateResult returns both plaintext tokens exactly once; the handler turns
// InviteToken into the kaata.af/t/<token> URL (D11: the invite link IS party
// B's link).
type CreateResult struct {
	Tab         Tab
	Entries     []Entry
	MyToken     string
	InviteToken string
}

// JoinInput — POST /v1/tabs/{id}/join. A join by a party that already joined
// is idempotent (label updated); a JWT on the request binds the account.
type JoinInput struct {
	ExpectedHistoryRevisions map[string]int64
	ExpectedPreviousTabID    *string
	ExpectedPreviousRev      *int64
	LinkedAtMS               *int64
	Label                    string
	VaultID                  *string
	RelationshipID           *string
	AccountID                *string
	InstallID                *string
}

// BindInput — POST /v1/tabs/{id}/bind: attach the session account (and,
// optionally, the kaata + contact) to the resolved party.
type BindInput struct {
	ExpectedHistoryRevisions map[string]int64
	ExpectedPreviousTabID    *string
	ExpectedPreviousRev      *int64
	LinkedAtMS               *int64
	AccountID                string
	InstallID                *string
	VaultID                  *string
	RelationshipID           *string
}

// AppendInput — POST /v1/tabs/{id}/entries. ID is client-minted for
// idempotency.
type AppendInput struct {
	ID           string
	Direction    string
	Amount       string
	Note         *string
	OccurredAtMS int64
}

// AppendResult adds Created so the handler can answer 201 for a fresh row
// and 200 for an idempotent replay of the same id.
type AppendResult struct {
	Entry         Entry
	Tab           Tab
	DuplicateHint *DuplicateHint
	Created       bool
}

// --------------------------------------------------------------------------
// Money. Integer hundredths end to end; the wire string is parsed with the
// regex above and rendered without trailing zeros ("100", "0.25", "-10",
// "9999999999.99").
// --------------------------------------------------------------------------

// parseAmountMinor turns a wire amount into integer hundredths, rejecting
// anything outside `^\d{1,10}(\.\d{1,2})?$`, zero, or above the mobile cap.
func parseAmountMinor(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if !amountRe.MatchString(s) {
		return 0, ErrInvalidAmount
	}
	whole, frac, _ := strings.Cut(s, ".")
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, ErrInvalidAmount
	}
	var f int64
	if frac != "" {
		if len(frac) == 1 {
			frac += "0"
		}
		f, err = strconv.ParseInt(frac, 10, 64)
		if err != nil {
			return 0, ErrInvalidAmount
		}
	}
	minor := w*100 + f
	if minor <= 0 || minor > maxAmountMinor {
		return 0, ErrInvalidAmount
	}
	return minor, nil
}

// formatMinor renders integer hundredths as the wire decimal string: signed,
// no thousands grouping, no trailing zeros. Display grouping and Persian
// digits are the renderer's job (view.go, the inline script).
func formatMinor(minor int64) string {
	neg := minor < 0
	if neg {
		minor = -minor
	}
	whole, frac := minor/100, minor%100
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	b.WriteString(strconv.FormatInt(whole, 10))
	switch {
	case frac == 0:
	case frac%10 == 0:
		b.WriteByte('.')
		b.WriteByte(byte('0' + frac/10))
	default:
		fmt.Fprintf(&b, ".%02d", frac)
	}
	return b.String()
}

// --------------------------------------------------------------------------
// Tokens — copied from vaults.newInviteToken / hashInviteToken (unexported
// there). The plaintext crosses the wire in the Create response, in the
// kaata.af/t/<token> URL and in every `Authorization: Tab <token>` header;
// the database only ever holds the hex SHA-256.
// --------------------------------------------------------------------------

func newPartyToken() (string, error) {
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("mint tab token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// hashPartyToken is lowercase hex SHA-256 — same shape as
// vault_members.invite_token_hash. Plain SHA-256 is deliberate: the input is
// 256 random bits, so dictionary / fast-preimage attacks are out of scope.
func hashPartyToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// --------------------------------------------------------------------------
// Validation shared by the mutations.
// --------------------------------------------------------------------------

func validLabel(label string) (string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", ErrLabelRequired
	}
	if utf8.RuneCountInString(label) > maxLabelRunes {
		return "", ErrInvalidLabel
	}
	return label, nil
}

// validNote trims and collapses an empty note to NULL so the wire never
// carries "" and null for the same meaning.
func validNote(note *string) (*string, error) {
	if note == nil {
		return nil, nil
	}
	n := strings.TrimSpace(*note)
	if n == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(n) > maxNoteRunes {
		return nil, ErrInvalidNote
	}
	return &n, nil
}

func validDirection(d string) error {
	if d != "a_to_b" && d != "b_to_a" {
		return ErrInvalidDirection
	}
	return nil
}

// opposite is the void row's direction: the reversing movement of value.
func opposite(direction string) string {
	if direction == "a_to_b" {
		return "b_to_a"
	}
	return "a_to_b"
}

// otherRole is the counterparty of a role.
func otherRole(role string) string {
	if role == "a" {
		return "b"
	}
	return "a"
}

func nowMS() int64 { return time.Now().UnixMilli() }

func msPtr(t *time.Time) *int64 {
	if t == nil {
		return nil
	}
	ms := t.UnixMilli()
	return &ms
}

// --------------------------------------------------------------------------
// Row helpers
// --------------------------------------------------------------------------

func notificationOnlyMode(mode string) bool {
	return mode == "notify" || mode == "notify_one_way"
}

func tallyWriterAllowed(mode, role string) bool {
	return mode != "notify_one_way" || role == "a"
}

// tabRow is the locked tabs row a mutation starts from.
type tabRow struct {
	RecordingMode string
	ID            string
	Currency      string
	Rev           int64
	ClosedAt      *time.Time
}

// lockTab takes the per-tab row lock that serializes every mutation — the
// sync.PushEvents pattern. seq and rev are assigned under it, so two
// concurrent appends can never mint the same seq or skip a rev. ErrNotFound
// when the tab does not exist.
func lockTab(ctx context.Context, tx pgx.Tx, tabID string) (tabRow, error) {
	var t tabRow
	err := tx.QueryRow(ctx, `
		SELECT id::text, currency, rev, closed_at, recording_mode FROM tabs
		 WHERE id = $1::uuid FOR UPDATE
	`, tabID).Scan(&t.ID, &t.Currency, &t.Rev, &t.ClosedAt, &t.RecordingMode)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return tabRow{}, ErrNotFound
	case err != nil:
		return tabRow{}, fmt.Errorf("lock tab: %w", err)
	}
	return t, nil
}

// lockOpenTab is lockTab plus the closed-tab gate every write shares.
func lockOpenTab(ctx context.Context, tx pgx.Tx, tabID string) (tabRow, error) {
	t, err := lockTab(ctx, tx, tabID)
	if err != nil {
		return tabRow{}, err
	}
	if t.ClosedAt != nil {
		return tabRow{}, ErrTabClosed
	}
	return t, nil
}

// bumpRev advances the tab's change counter and returns the new value, which
// the mutation then stamps on every row it touched.
func bumpRev(ctx context.Context, tx pgx.Tx, tabID, actor string, event ...pushEvent) (int64, error) {
	var rev int64
	if err := tx.QueryRow(ctx, `
		UPDATE tabs SET rev = rev + 1 WHERE id = $1::uuid RETURNING rev
	`, tabID).Scan(&rev); err != nil {
		return 0, fmt.Errorf("bump rev: %w", err)
	}
	if err := queuePush(ctx, tx, tabID, actor, rev, event...); err != nil {
		return 0, err
	}
	return rev, nil
}

// markEntryNoticesRead is "handled means read" on the server: the account
// that accepts, rejects or cancels a tally has, by that act, dealt with every
// notice it received about that tally, so those rows are read in the SAME
// transaction as the decision. A second phone on the account and the OS
// action buttons therefore need no client work, and deliverPush drops a push
// still queued for it. Only the ACTING account's rows for its own party side
// are touched (a kaata member's review reads the member's rows, never the
// bound owner's); the counterparty's history is untouched, and a legacy
// token-only party with no account marks nothing.
func markEntryNoticesRead(ctx context.Context, tx pgx.Tx, p Party, entryID string) error {
	acct := p.actorAccount()
	if acct == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tab_notification_reads (notification_id, account_id)
		SELECT n.id, $3::uuid FROM tab_notifications n
		 WHERE n.tab_id = $1::uuid AND n.entry_id = $2::uuid AND n.recipient_role = $4
		ON CONFLICT DO NOTHING
	`, p.TabID, entryID, *acct, p.Role); err != nil {
		return fmt.Errorf("mark notices read: %w", err)
	}
	return nil
}

// nextSeq is COALESCE(MAX(seq),0)+1 under the row lock.
func nextSeq(ctx context.Context, tx pgx.Tx, tabID string) (int64, error) {
	var cur int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(seq), 0) FROM tab_entries WHERE tab_id = $1::uuid
	`, tabID).Scan(&cur); err != nil {
		return 0, fmt.Errorf("read current seq: %w", err)
	}
	return cur + 1, nil
}

// entryCols is the SELECT / RETURNING list every entry read shares; scanEntry
// consumes it in the same order.
const entryCols = `id::text, seq, rev, created_by, direction, amount_minor, kind, note,
	occurred_at_ms, created_at, status, status_at_ms, dispute_reason,
	voids_entry_id::text, voided_by_entry_id::text,
	COALESCE(author_evidence_account_id, author_account_id)::text, author_name, author_member_role,
	reviewer_account_id::text, reviewer_name, reviewer_party, reviewer_member_role, review_semantics_version`

func scanEntry(row pgx.Row) (Entry, error) {
	var e Entry
	var createdAt time.Time
	if err := row.Scan(&e.ID, &e.Seq, &e.Rev, &e.CreatedBy, &e.Direction, &e.amountMinor, &e.Kind, &e.Note,
		&e.OccurredAtMS, &createdAt, &e.Status, &e.StatusAtMS, &e.DisputeReason,
		&e.VoidsEntryID, &e.VoidedByEntryID, &e.AuthorAccountID, &e.AuthorName, &e.AuthorMemberRole,
		&e.ReviewerAccountID, &e.ReviewerName, &e.ReviewerParty, &e.ReviewerMemberRole, &e.ReviewSemanticsVersion); err != nil {
		return Entry{}, err
	}
	e.Amount = formatMinor(e.amountMinor)
	e.CreatedAtMS = createdAt.UnixMilli()
	return e, nil
}

// loadEntries returns the tab's entries with rev > afterRev, in rev order
// (seq breaks the tie a void creates, where two rows share one rev).
func loadEntries(ctx context.Context, q querier, tabID string, afterRev int64) ([]Entry, error) {
	rows, err := q.Query(ctx, `
		SELECT `+entryCols+` FROM tab_entries
		 WHERE tab_id = $1::uuid AND rev > $2
		 ORDER BY rev ASC, seq ASC
	`, tabID, afterRev)
	if err != nil {
		return nil, fmt.Errorf("load entries: %w", err)
	}
	defer rows.Close()
	out := make([]Entry, 0)
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, fmt.Errorf("scan entry: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// loadEntryForUpdate locks one entry of the tab. ErrEntryNotFound covers both
// an unknown id and an id that belongs to a different tab.
func loadEntryForUpdate(ctx context.Context, tx pgx.Tx, tabID, entryID string) (Entry, error) {
	e, err := scanEntry(tx.QueryRow(ctx, `
		SELECT `+entryCols+` FROM tab_entries
		 WHERE tab_id = $1::uuid AND id = $2::uuid FOR UPDATE
	`, tabID, entryID))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return Entry{}, ErrEntryNotFound
	case err != nil:
		return Entry{}, fmt.Errorf("load entry: %w", err)
	}
	return e, nil
}

// loadTab builds the Tab meta from `you`'s point of view: balance from BOTH
// views (b is the negation of a), pending_for_you = the other party's
// pending, non-voided tallies. Balance excludes void rows and voided
// originals and rejected (wire: disputed) tallies. Pending proposals remain
// in legacy Balance but are separated from ConfirmedBalance for new clients.
func loadTab(ctx context.Context, q querier, tabID, you string) (Tab, error) {
	var (
		t                                         Tab
		createdAt                                 time.Time
		closedAt                                  *time.Time
		aLabel, bLabel                            string
		aName, bName                              string
		aPhone, bPhone                            string
		aJoined, bJoined                          *time.Time
		aHistoryOrder, bHistoryOrder              *string
		aBound, bBound                            bool
		balanceA, confirmedA, recordedA, pendingA int64
		pending                                   int
		closedBy                                  *string
	)
	err := q.QueryRow(ctx, `
		SELECT `+tabstate.UnjoinedInvitationSQL+`, t.recording_mode, t.currency, t.rev, t.created_at, t.closed_at, t.closed_by, t.closed_reason,
		       pa.label, pa.joined_at, pa.history_order::text, pa.account_id IS NOT NULL, COALESCE(aa.display_name, aa.name, ''), COALESCE(aa.phone_e164, ''),
		       pb.label, pb.joined_at, pb.history_order::text, pb.account_id IS NOT NULL, COALESCE(ab.display_name, ab.name, ''), COALESCE(ab.phone_e164, ''),
		       COALESCE((SELECT SUM(CASE WHEN e.direction = 'a_to_b' THEN e.amount_minor ELSE -e.amount_minor END)
		                   FROM tab_entries e
		                  WHERE e.tab_id = t.id AND e.kind <> 'void' AND e.voided_by_entry_id IS NULL AND e.status <> 'disputed'), 0)::BIGINT,
		       COALESCE((SELECT SUM(CASE WHEN e.direction = 'a_to_b' THEN e.amount_minor ELSE -e.amount_minor END)
		                   FROM tab_entries e
		                  WHERE e.tab_id = t.id AND e.kind <> 'void' AND e.voided_by_entry_id IS NULL AND e.status = 'accepted'), 0)::BIGINT,
		       COALESCE((SELECT SUM(CASE WHEN e.direction = 'a_to_b' THEN e.amount_minor ELSE -e.amount_minor END)
		                   FROM tab_entries e
		                  WHERE e.tab_id = t.id AND e.kind <> 'void' AND e.voided_by_entry_id IS NULL AND e.status IN ('accepted','recorded')), 0)::BIGINT,
		       COALESCE((SELECT SUM(CASE WHEN e.direction = 'a_to_b' THEN e.amount_minor ELSE -e.amount_minor END)
		                   FROM tab_entries e
		                  WHERE e.tab_id = t.id AND e.kind <> 'void' AND e.voided_by_entry_id IS NULL AND e.status = 'pending'), 0)::BIGINT,
		       (SELECT COUNT(*) FROM tab_entries e
		         WHERE e.tab_id = t.id AND e.created_by <> $2 AND e.status = 'pending'
		           AND e.kind <> 'void' AND e.voided_by_entry_id IS NULL)::INT
		  FROM tabs t
		  JOIN tab_parties pa ON pa.tab_id = t.id AND pa.role = 'a'
		  JOIN tab_parties pb ON pb.tab_id = t.id AND pb.role = 'b'
		  LEFT JOIN accounts aa ON aa.id=pa.account_id
		  LEFT JOIN accounts ab ON ab.id=pb.account_id
		 WHERE t.id = $1::uuid
	`, tabID, you).Scan(&t.UnjoinedInvitation, &t.RecordingMode, &t.Currency, &t.Rev, &createdAt, &closedAt, &closedBy, &t.ClosedReason,
		&aLabel, &aJoined, &aHistoryOrder, &aBound, &aName, &aPhone, &bLabel, &bJoined, &bHistoryOrder, &bBound, &bName, &bPhone, &balanceA, &confirmedA, &recordedA, &pendingA, &pending)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return Tab{}, ErrNotFound
	case err != nil:
		return Tab{}, fmt.Errorf("load tab: %w", err)
	}
	t.ID = tabID
	t.CreatedAtMS = createdAt.UnixMilli()
	t.ClosedAtMS = msPtr(closedAt)
	t.ClosedBy = closedBy
	t.You = you
	t.Parties = map[string]PartyMeta{
		"a": {Label: aLabel, AccountName: aName, JoinedAtMS: msPtr(aJoined), HistoryOrder: aHistoryOrder, Bound: aBound, Phone: aPhone},
		"b": {Label: bLabel, AccountName: bName, JoinedAtMS: msPtr(bJoined), HistoryOrder: bHistoryOrder, Bound: bBound, Phone: bPhone},
	}
	t.Balance = map[string]string{
		"a": formatMinor(balanceA),
		"b": formatMinor(-balanceA),
	}
	t.ConfirmedBalance = map[string]string{"a": formatMinor(confirmedA), "b": formatMinor(-confirmedA)}
	t.RecordedBalance = map[string]string{"a": formatMinor(recordedA), "b": formatMinor(-recordedA)}
	t.PendingBalance = map[string]string{"a": formatMinor(pendingA), "b": formatMinor(-pendingA)}
	t.PendingForYou = pending
	return t, nil
}

// fullResponse is the TabResponse the write routes return: every entry,
// full=true, so the client may replace its cache outright.
func fullResponse(ctx context.Context, q querier, tabID, you string) (TabResponse, error) {
	tab, err := loadTab(ctx, q, tabID, you)
	if err != nil {
		return TabResponse{}, err
	}
	entries, err := loadEntries(ctx, q, tabID, 0)
	if err != nil {
		return TabResponse{}, err
	}
	settlements, err := loadSettlements(ctx, q, tabID, 0)
	if err != nil {
		return TabResponse{}, err
	}
	return TabResponse{Tab: tab, Entries: entries, Settlements: settlements, Full: true}, nil
}

// isActiveMember reports whether accountID holds an accepted, unrevoked
// membership in vaultID. Binding a tab party to a kaata is gated on it:
// without the check any caller could attach a tab to a vault uuid it merely
// knows, and that vault's members would find a stranger's tab in their
// GET /v1/tabs/mine with party rights over it.
func isActiveMember(ctx context.Context, q querier, vaultID, accountID string) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid
			   AND accepted_at IS NOT NULL AND revoked_at IS NULL
		)
	`, vaultID, accountID).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("membership check: %w", err)
	}
	return ok, nil
}

// checkVaultBinding enforces isActiveMember for a requested vault_id. A nil
// vault_id is always fine (web parties have no kaata).
func checkVaultBinding(ctx context.Context, q querier, vaultID, accountID *string) error {
	if vaultID == nil {
		return nil
	}
	if accountID == nil {
		return ErrNotVaultMember
	}
	ok, err := isActiveMember(ctx, q, *vaultID, *accountID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotVaultMember
	}
	var role string
	if err := q.QueryRow(ctx, `SELECT role FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid`, *vaultID, *accountID).Scan(&role); err != nil {
		return err
	}
	if roleRank[role] < rankEditor {
		return ErrRoleInsufficient
	}
	return nil
}

// checkSameKaata is the §3.4 409: a tab's two parties may never be the same
// kaata (D3 — a tab is a property of a contact in ONE kaata; the other side
// is somebody else's book).
func checkSameKaata(ctx context.Context, tx pgx.Tx, tabID, role string, vaultID *string) error {
	if vaultID == nil {
		return nil
	}
	var other *string
	err := tx.QueryRow(ctx, `
		SELECT vault_id::text FROM tab_parties WHERE tab_id = $1::uuid AND role = $2
	`, tabID, otherRole(role)).Scan(&other)
	if err != nil {
		return fmt.Errorf("read other party vault: %w", err)
	}
	if other != nil && *other == *vaultID {
		return ErrSameKaata
	}
	return nil
}

// checkSameAccount refuses a binding through which one account would see BOTH
// sides: the joiner (or an accepted member of the joining kaata) is also the
// other side's account or an accepted member of its kaata, e.g. linking two of
// your own kaatas. A phone holds one side of a tab and GET /v1/tabs/mine
// returns one side per tab, so such an account restores only one side and the
// other contact stays on its stale pre-link book (Matee, 2026-10-12: block it).
// Membership granted after the link is not re-checked here.
func checkSameAccount(ctx context.Context, tx pgx.Tx, tabID, role string, accountID, vaultID *string) error {
	var overlap bool
	if err := tx.QueryRow(ctx, `
		WITH other AS (
		  SELECT account_id, vault_id FROM tab_parties WHERE tab_id = $1::uuid AND role = $2
		), other_side AS (
		  SELECT account_id FROM other WHERE account_id IS NOT NULL
		  UNION
		  SELECT vm.account_id FROM vault_members vm JOIN other o ON vm.vault_id = o.vault_id
		   WHERE vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		), this_side AS (
		  SELECT $3::uuid AS account_id WHERE $3::uuid IS NOT NULL
		  UNION
		  SELECT vm.account_id FROM vault_members vm
		   WHERE vm.vault_id = $4::uuid AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		)
		SELECT EXISTS (SELECT 1 FROM other_side o JOIN this_side t ON t.account_id = o.account_id)
	`, tabID, otherRole(role), accountID, vaultID).Scan(&overlap); err != nil {
		return fmt.Errorf("check both-sides account: %w", err)
	}
	if overlap {
		return ErrSameAccount
	}
	return nil
}

func setLinkBoundary(ctx context.Context, tx pgx.Tx, tabID, role string, at *int64) error {
	if at != nil && *at <= 0 {
		return ErrInvalidOccurredAt
	}
	_, err := tx.Exec(ctx, `UPDATE tab_parties
	 SET linked_at_ms = COALESCE(linked_at_ms, $3::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
	     history_order = CASE WHEN vault_id IS NOT NULL THEN
	       COALESCE(history_order, nextval('tab_party_history_order_seq')) ELSE history_order END
	 WHERE tab_id=$1::uuid AND role=$2 AND relationship_id IS NOT NULL`, tabID, role, at)
	return err
}

// Serialize linking the same contact across phones. The mobile partial
// unique index protects one device only; it cannot arbitrate cloud writers.
func checkContactBinding(ctx context.Context, tx pgx.Tx, tabID, role, currency string, vaultID, relID, previousTabID *string, previousRev *int64, hasOpening bool, expectedHistory map[string]int64) error {
	alreadyScoped := false
	// Partial binding requests must not bypass the established-history guard.
	if tabID != "" {
		var moved bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_parties WHERE tab_id=$1::uuid AND role=$2
		 AND (($3::uuid IS NOT NULL AND vault_id IS NOT NULL AND vault_id<>$3::uuid)
		   OR ($4::uuid IS NOT NULL AND relationship_id IS NOT NULL AND relationship_id<>$4::uuid)))`,
			tabID, role, vaultID, relID).Scan(&moved); err != nil {
			return err
		}
		if moved {
			return ErrAlreadyLinked
		}
		// Bind/Join may omit an unchanged half of the scope. Check the actual
		// destination so a partial request cannot skip unresolved older history.
		var storedVault, storedRel *string
		if err := tx.QueryRow(ctx, `SELECT vault_id::text, relationship_id::text FROM tab_parties
		 WHERE tab_id=$1::uuid AND role=$2`, tabID, role).Scan(&storedVault, &storedRel); err != nil {
			return err
		}
		if vaultID == nil {
			vaultID = storedVault
		}
		if relID == nil {
			relID = storedRel
		}
		alreadyScoped = storedVault != nil && storedRel != nil && vaultID != nil && relID != nil &&
			*storedVault == *vaultID && *storedRel == *relID
	}
	if vaultID == nil {
		return nil
	}
	if relID == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, *vaultID+":"+*relID); err != nil {
		return err
	}
	var conflict bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
	 WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.closed_at IS NULL
	 AND t.currency=$5 AND (p.tab_id::text<>$3 OR p.role<>$4))`, *vaultID, *relID, tabID, role, currency).Scan(&conflict); err != nil {
		return err
	}
	if conflict {
		return ErrAlreadyLinked
	}
	// Recovery of an existing binding never creates a new checkpoint, so it
	// remains compatible with old clients and does not need a history receipt.
	if alreadyScoped {
		return nil
	}
	// A new opening carries the previous period's total. Once that happens,
	// later resolution of an older proposal would invalidate the carry-over.
	// Closing never strands a review, so finish that finite history first.
	var unresolved bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
	 WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.closed_at IS NOT NULL
	 AND p.tab_id::text<>$3 AND t.currency=$4 AND EXISTS (SELECT 1 FROM tab_entries e WHERE e.tab_id=t.id
	   AND e.kind<>'void' AND e.voided_by_entry_id IS NULL AND e.status='pending'))`,
		*vaultID, *relID, tabID, currency).Scan(&unresolved); err != nil {
		return err
	}
	if unresolved {
		return ErrSharedHistoryPending
	}
	// Lock and validate the complete source snapshot: legacy older proposals
	// can change an effective carry-over without changing the latest tab rev.
	var latestID string
	var latestRev int64
	rows, err := tx.Query(ctx, `SELECT t.id::text, t.rev FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
	 WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.closed_at IS NOT NULL
	 AND p.tab_id::text<>$3 AND t.currency=$4 ORDER BY p.history_order ASC NULLS FIRST, t.created_at ASC, t.id ASC
	 FOR UPDATE OF t`, *vaultID, *relID, tabID, currency)
	if err != nil {
		return err
	}
	actualHistory := map[string]int64{}
	for rows.Next() {
		if err := rows.Scan(&latestID, &latestRev); err != nil {
			rows.Close()
			return err
		}
		actualHistory[latestID] = latestRev
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(actualHistory) == 0 {
		if previousTabID != nil || previousRev != nil || len(expectedHistory) != 0 {
			return ErrSharedHistoryChanged
		}
		return nil
	}
	if previousTabID == nil || previousRev == nil || *previousTabID != latestID || *previousRev != latestRev {
		return ErrSharedHistoryChanged
	}
	if len(actualHistory) > 1 || expectedHistory != nil {
		if len(expectedHistory) != len(actualHistory) {
			return ErrSharedHistoryChanged
		}
		for id, rev := range actualHistory {
			if expected, ok := expectedHistory[id]; !ok || expected != rev {
				return ErrSharedHistoryChanged
			}
		}
	}
	if tabID != "" {
		// The candidate tab is locked by Join/Bind. A rejected/cancelled
		// opening cannot stand in for a reviewable carry-over proposal.
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_entries WHERE tab_id=$1::uuid
		 AND kind='opening' AND voided_by_entry_id IS NULL AND status IN ('pending','accepted','recorded'))`, tabID).Scan(&hasOpening); err != nil {
			return err
		}
	}
	if !hasOpening {
		// Private post-close offsets have no counterparty review. A new zero
		// period must not silently absorb a nonzero accepted shared balance.
		// An accepted opening is a checkpoint; pending/rejected openings do
		// not replace earlier acknowledgements. Sign every period from this
		// book's own party role, which may differ across periods.
		nonzero, _, err := sharedAcceptedHistory(ctx, tx, *vaultID, *relID, tabID, currency)
		if err != nil {
			return err
		}
		if nonzero {
			return ErrSharedHistoryOpeningRequired
		}
	}
	return nil
}

// Count the effective recorded book, retaining the historical helper name.
// Accepted or notification-only recorded openings checkpoint older periods;
// proposals/rejections/cancellations do not. Recorded is never peer acceptance.
// Pending reports cover every period, including absorbed legacy proposals.
func sharedAcceptedHistory(ctx context.Context, q querier, vaultID, relationshipID, exceptTabID, currency string) (nonzero, pending bool, err error) {
	err = q.QueryRow(ctx, `WITH periods AS (
 SELECT p.tab_id,p.role,p.history_order FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
 WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND p.tab_id::text<>$3 AND t.currency=$4
 ), checkpoint AS (
 SELECT MAX(p.history_order) AS history_order FROM periods p JOIN tab_entries e ON e.tab_id=p.tab_id
 WHERE e.kind='opening' AND e.status IN ('accepted','recorded') AND e.voided_by_entry_id IS NULL
 ) SELECT COALESCE(SUM(CASE WHEN (p.role='a' AND e.direction='a_to_b') OR (p.role='b' AND e.direction='b_to_a') THEN e.amount_minor ELSE -e.amount_minor END),0)<>0,
 EXISTS(SELECT 1 FROM periods pp JOIN tab_entries pe ON pe.tab_id=pp.tab_id WHERE pe.kind<>'void' AND pe.voided_by_entry_id IS NULL AND pe.status='pending')
 FROM periods p JOIN tab_entries e ON e.tab_id=p.tab_id CROSS JOIN checkpoint c
 WHERE p.history_order>=COALESCE(c.history_order,0) AND e.kind<>'void' AND e.status IN ('accepted','recorded') AND e.voided_by_entry_id IS NULL`, vaultID, relationshipID, exceptTabID, currency).Scan(&nonzero, &pending)
	return
}

func tabCurrency(ctx context.Context, q querier, tabID string) (string, error) {
	var code string
	err := q.QueryRow(ctx, `SELECT currency FROM tabs WHERE id=$1::uuid`, tabID).Scan(&code)
	return code, err
}

// An authoritative opening freezes its recorded source in either party's book.
// Lock source IDs in a canonical order BEFORE taking row locks: taking a newer
// row after Void has locked an older row would deadlock with Join's history
// validation. A recorded Void always takes its own source-ID lock.
func recordingSourceTabs(ctx context.Context, tx pgx.Tx, tabID string, destinationVault, destinationRelationship *string) ([]string, error) {
	currency, err := tabCurrency(ctx, tx, tabID)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT history.tab_id::text
	 FROM tab_parties history JOIN tabs book ON book.id=history.tab_id
	 WHERE book.currency=$2 AND (EXISTS(SELECT 1 FROM tab_parties current
	   WHERE current.tab_id=$1::uuid AND current.vault_id=history.vault_id
	     AND current.relationship_id=history.relationship_id)
	   OR (history.vault_id=$3::uuid AND history.relationship_id=$4::uuid))
	 UNION SELECT $1::text ORDER BY 1`, tabID, currency, destinationVault, destinationRelationship)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func lockRecordingSource(ctx context.Context, tx pgx.Tx, tabID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "recorded-source:"+tabID)
	return err
}

func lockRecordingSources(ctx context.Context, tx pgx.Tx, tabID string, destinationVault, destinationRelationship *string) (map[string]bool, error) {
	ids, err := recordingSourceTabs(ctx, tx, tabID, destinationVault, destinationRelationship)
	if err != nil {
		return nil, err
	}
	locked := make(map[string]bool, len(ids))
	for _, id := range ids {
		if err := lockRecordingSource(ctx, tx, id); err != nil {
			return nil, err
		}
		locked[id] = true
	}
	return locked, nil
}

func validateRecordingSources(ctx context.Context, tx pgx.Tx, tabID string, destinationVault, destinationRelationship *string, locked map[string]bool) error {
	ids, err := recordingSourceTabs(ctx, tx, tabID, destinationVault, destinationRelationship)
	if err != nil {
		return err
	}
	// A binding can change while the locks are acquired. Retry from a fresh
	// receipt instead of acquiring a missing source lock while holding rows.
	for _, id := range ids {
		if !locked[id] {
			return ErrSharedHistoryChanged
		}
	}
	return nil
}

func recordedEntryCarriedForward(ctx context.Context, tx pgx.Tx, tabID string) (bool, error) {
	var carried bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_parties source
	 JOIN tabs original ON original.id=source.tab_id
	 JOIN tab_parties later ON later.vault_id=source.vault_id AND later.relationship_id=source.relationship_id
	   AND later.history_order>source.history_order
	 JOIN tabs destination ON destination.id=later.tab_id AND destination.currency=original.currency
	 JOIN tab_entries opening ON opening.tab_id=destination.id
	 WHERE source.tab_id=$1::uuid AND opening.kind='opening'
	   AND opening.status IN ('accepted','recorded') AND opening.voided_by_entry_id IS NULL)`, tabID).Scan(&carried)
	return carried, err
}

// Store provenance, not a calculated/replacement amount. Private offsets may be
// part of the visible opening, so the server must reject a stale proposal rather
// than silently changing it. checkContactBinding has locked this source history.
func saveNotifyOpeningSource(ctx context.Context, tx pgx.Tx, tabID string) error {
	_, err := tx.Exec(ctx, `UPDATE tabs candidate SET notify_opening_source_revisions=(
	 SELECT COALESCE(jsonb_object_agg(source.id::text,source.rev),'{}'::jsonb)
	 FROM tab_parties creator
	 JOIN tab_parties history ON history.vault_id=creator.vault_id AND history.relationship_id=creator.relationship_id
	 JOIN tabs source ON source.id=history.tab_id AND source.currency=candidate.currency
	 WHERE creator.tab_id=candidate.id AND creator.role='a'
	   AND source.id<>candidate.id AND source.closed_at IS NOT NULL)
	 WHERE candidate.id=$1::uuid AND candidate.recording_mode IN ('notify','notify_one_way')
	 AND candidate.notify_opening_source_revisions IS NOT NULL
	 AND EXISTS(SELECT 1 FROM tab_entries opening WHERE opening.tab_id=candidate.id
	   AND opening.kind='opening' AND opening.status='pending' AND opening.voided_by_entry_id IS NULL)`, tabID)
	return err
}

func validateNotifyOpeningSource(ctx context.Context, tx pgx.Tx, tabID string) error {
	var valid bool
	err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM tab_entries opening
	 WHERE opening.tab_id=candidate.id AND opening.kind='opening' AND opening.status='pending'
	   AND opening.voided_by_entry_id IS NULL)
	 OR COALESCE(candidate.notify_opening_source_revisions=(
	 SELECT COALESCE(jsonb_object_agg(source.id::text,source.rev),'{}'::jsonb)
	 FROM tab_parties creator
	 JOIN tab_parties history ON history.vault_id=creator.vault_id AND history.relationship_id=creator.relationship_id
	 JOIN tabs source ON source.id=history.tab_id AND source.currency=candidate.currency
	 WHERE creator.tab_id=candidate.id AND creator.role='a'
	   AND source.id<>candidate.id AND source.closed_at IS NOT NULL),false)
	 FROM tabs candidate WHERE candidate.id=$1::uuid`, tabID).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrOpeningSourceChanged
	}
	return nil
}

// insertEntry writes one tab_entries row under the held lock and returns it
// as the wire Entry. voidsEntryID is set on kind='void' rows only.
func insertEntry(ctx context.Context, tx pgx.Tx, tabID string, id string, seq, rev int64,
	createdBy, direction string, amountMinor int64, kind string, note *string,
	occurredAtMS int64, status string, statusAtMS *int64, voidsEntryID *string, authorAccountID *string, authorMemberRole *string) (Entry, error) {
	e, err := scanEntry(tx.QueryRow(ctx, `
		INSERT INTO tab_entries (
			id, tab_id, seq, rev, created_by, direction, amount_minor, kind, note,
			occurred_at_ms, status, status_at_ms, voids_entry_id, author_account_id, author_name,
			author_evidence_account_id, author_member_role
		) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, $14::uuid, COALESCE((SELECT COALESCE(display_name, name) FROM accounts WHERE id=$14::uuid), ''), $14::uuid, $15)
		ON CONFLICT (id) DO NOTHING
		RETURNING `+entryCols,
		id, tabID, seq, rev, createdBy, direction, amountMinor, kind, note,
		occurredAtMS, status, statusAtMS, voidsEntryID, authorAccountID, authorMemberRole))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// ON CONFLICT DO NOTHING returned no row: the id landed in ANOTHER
		// tab between our existence check and this insert (same-tab races
		// are impossible under the row lock). The deferred rollback undoes
		// the rev bump.
		return Entry{}, ErrIDTaken
	case err != nil:
		return Entry{}, fmt.Errorf("insert entry: %w", err)
	}
	return e, nil
}

// --------------------------------------------------------------------------
// Post-commit poke
// --------------------------------------------------------------------------

// recipients is §3.5's fan-out set in one query: both parties' account_id
// plus every active member account of both parties' vault_ids.
func (s *Service) recipients(ctx context.Context, tabID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT acct::text FROM (
			SELECT account_id AS acct FROM tab_parties
			 WHERE tab_id = $1::uuid AND account_id IS NOT NULL
			UNION
			SELECT vm.account_id FROM tab_parties p
			  JOIN vault_members vm ON vm.vault_id = p.vault_id
			 WHERE p.tab_id = $1::uuid AND vm.account_id IS NOT NULL
			   AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		) x
	`, tabID)
	if err != nil {
		return nil, fmt.Errorf("tab recipients: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("tab recipients scan: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// poke fans a tab_poke to every recipient. Called AFTER commit only;
// best-effort — a failed recipients query is logged, never surfaced, because
// the mutation itself already succeeded and the poll will catch up.
func (s *Service) poke(ctx context.Context, tabID string) {
	if s.poker == nil {
		return
	}
	ids, err := s.recipients(ctx, tabID)
	if err != nil {
		log.Printf("tabs: poke recipients for %s: %v", tabID, err)
		return
	}
	if len(ids) > 0 {
		s.poker.NotifyTab(tabID, ids)
	}
}

// --------------------------------------------------------------------------
// Mutations. Each one: validate → BeginTx(ReadCommitted) → lock the tabs row
// → bump rev → write → read back → Commit → poke.
// --------------------------------------------------------------------------

// Create mints a tab with the caller as party 'a' (joined at once, labelled,
// optionally bound to a kaata + contact) and an empty, unjoined party 'b'
// whose token becomes the invite link. The optional opening balance is one
// visible kind='opening' entry (D7) so the counterparty sees exactly what was
// carried over — never a silent history merge.
func (s *Service) Create(ctx context.Context, in CreateInput) (CreateResult, error) {
	mode := in.RecordingMode
	if mode == "" {
		mode = "review"
	}
	if mode != "review" && !notificationOnlyMode(mode) {
		return CreateResult{}, ErrInvalidRecordingMode
	}
	currency := strings.TrimSpace(in.Currency)
	if !credit.ValidCurrency(currency) {
		return CreateResult{}, ErrInvalidCurrency
	}
	label, err := validLabel(in.Label)
	if err != nil {
		return CreateResult{}, err
	}
	var openingMinor int64
	var openingNote *string
	if in.Opening != nil {
		if err := validDirection(in.Opening.Direction); err != nil {
			return CreateResult{}, err
		}
		if openingMinor, err = parseAmountMinor(in.Opening.Amount); err != nil {
			return CreateResult{}, err
		}
		if openingNote, err = validNote(in.Opening.Note); err != nil {
			return CreateResult{}, err
		}
		if in.Opening.OccurredAtMS <= 0 {
			return CreateResult{}, ErrInvalidOccurredAt
		}
	}
	if err := checkVaultBinding(ctx, s.pool, in.VaultID, in.AccountID); err != nil {
		return CreateResult{}, err
	}

	myToken, err := newPartyToken()
	if err != nil {
		return CreateResult{}, err
	}
	inviteToken, err := newPartyToken()
	if err != nil {
		return CreateResult{}, err
	}

	tx, err := s.beginMutation(ctx, in.AccountID)
	if err != nil {
		return CreateResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	linkCredit, err := s.beginLinkCredit(ctx, tx, in.VaultID, in.RelationshipID, in.AccountID, currency)
	if err != nil {
		return CreateResult{}, err
	}
	var tabID string
	if err := checkContactBinding(ctx, tx, "", "a", currency, in.VaultID, in.RelationshipID, in.ExpectedPreviousTabID, in.ExpectedPreviousRev, in.Opening != nil, in.ExpectedHistoryRevisions); err != nil {
		return CreateResult{}, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO tabs (currency,recording_mode,notify_opening_source_revisions)
		VALUES ($1,$2,CASE WHEN $2 IN ('notify','notify_one_way') AND $3 THEN '{}'::jsonb ELSE NULL END) RETURNING id::text
	`, currency, mode, in.Opening != nil).Scan(&tabID); err != nil {
		return CreateResult{}, fmt.Errorf("insert tab: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tab_parties (
			tab_id, role, label, token_hash, account_id, vault_id, relationship_id, install_id,
			joined_at, last_seen_at
		) VALUES ($1::uuid, 'a', $2, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, NOW(), NOW())
	`, tabID, label, hashPartyToken(myToken), in.AccountID, in.VaultID, in.RelationshipID, in.InstallID); err != nil {
		return CreateResult{}, fmt.Errorf("insert party a: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tab_parties (tab_id, role, label, token_hash) VALUES ($1::uuid, 'b', '', $2)
	`, tabID, hashPartyToken(inviteToken)); err != nil {
		return CreateResult{}, fmt.Errorf("insert party b: %w", err)
	}

	entries := make([]Entry, 0, 1)
	if in.Opening != nil {
		rev, err := bumpRev(ctx, tx, tabID, "a", pushEvent{Kind: "updated", ActorAccountID: in.AccountID})
		if err != nil {
			return CreateResult{}, err
		}
		e, err := insertEntry(ctx, tx, tabID, uuid.NewString(), 1, rev, "a", in.Opening.Direction,
			openingMinor, "opening", openingNote, in.Opening.OccurredAtMS, "pending", nil, nil, in.AccountID, (Party{AccountID: in.AccountID}).evidenceRole())
		if err != nil {
			return CreateResult{}, err
		}
		entries = append(entries, e)
	}

	if err := setLinkBoundary(ctx, tx, tabID, "a", in.LinkedAtMS); err != nil {
		return CreateResult{}, err
	}
	if notificationOnlyMode(mode) && in.Opening != nil {
		if err := saveNotifyOpeningSource(ctx, tx, tabID); err != nil {
			return CreateResult{}, err
		}
	}
	if err := s.finishLinkCredit(ctx, tx, linkCredit); err != nil {
		return CreateResult{}, err
	}
	tab, err := loadTab(ctx, tx, tabID, "a")
	if err != nil {
		return CreateResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, fmt.Errorf("commit tx: %w", err)
	}
	// Other members of the creator's kaata learn about the new tab on their
	// next /mine reconcile; the poke just makes that sooner.
	s.poke(ctx, tabID)

	return CreateResult{Tab: tab, Entries: entries, MyToken: myToken, InviteToken: inviteToken}, nil
}

// Mine lists every tab (open or closed) where a party has account_id = the
// caller, or vault_id in the caller's active memberships — the reinstall
// recovery path (D10). Newest first.
func (s *Service) Mine(ctx context.Context, accountID string) (MineResponse, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (t.id) t.id::text, p.role, p.vault_id::text, p.relationship_id::text, t.created_at, p.linked_at_ms, p.history_order::text
		  FROM tabs t
		  JOIN tab_parties p ON p.tab_id = t.id
		  LEFT JOIN vault_members vm
		         ON vm.vault_id = p.vault_id AND vm.account_id = $1::uuid
		        AND vm.accepted_at IS NOT NULL AND vm.revoked_at IS NULL
		 WHERE p.account_id = $1::uuid OR vm.id IS NOT NULL
		 ORDER BY t.id, COALESCE(p.account_id = $1::uuid, FALSE) DESC, p.role
	`, accountID)
	if err != nil {
		return MineResponse{}, fmt.Errorf("list mine: %w", err)
	}
	type hit struct {
		tabID, role  string
		vaultID      *string
		relationship *string
		createdAt    time.Time
		linkedAt     *int64
		historyOrder *string
	}
	var hits []hit
	for rows.Next() {
		var h hit
		if err := rows.Scan(&h.tabID, &h.role, &h.vaultID, &h.relationship, &h.createdAt, &h.linkedAt, &h.historyOrder); err != nil {
			rows.Close()
			return MineResponse{}, fmt.Errorf("scan mine: %w", err)
		}
		hits = append(hits, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return MineResponse{}, fmt.Errorf("list mine: %w", err)
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].createdAt.After(hits[j].createdAt) })

	out := MineResponse{Tabs: make([]MineItem, 0, len(hits))}
	for _, h := range hits {
		tab, err := loadTab(ctx, s.pool, h.tabID, h.role)
		if err != nil {
			return MineResponse{}, err
		}
		out.Tabs = append(out.Tabs, MineItem{Tab: tab, Role: h.role, VaultID: h.vaultID, RelationshipID: h.relationship, LinkedAtMS: h.linkedAt, HistoryOrder: h.historyOrder})
	}
	return out, nil
}

// Get is the pull: meta from the caller's view plus entries with rev >
// afterRev. Reads work on closed tabs.
func (s *Service) Get(ctx context.Context, p Party, afterRev int64) (TabResponse, error) {
	if afterRev < 0 {
		afterRev = 0
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return TabResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tab, err := loadTab(ctx, tx, p.TabID, p.Role)
	if err != nil {
		return TabResponse{}, err
	}
	entries, err := loadEntries(ctx, tx, p.TabID, afterRev)
	if err != nil {
		return TabResponse{}, err
	}
	settlements, err := loadSettlements(ctx, tx, p.TabID, afterRev)
	if err != nil {
		return TabResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TabResponse{}, err
	}
	return TabResponse{Tab: tab, Entries: entries, Settlements: settlements, Full: afterRev == 0}, nil
}

// Join sets the caller's label and joined_at (idempotent for a party that
// already joined — the label is updated) and, when a session is present,
// binds account_id / vault_id / relationship_id. The token holder is
// authoritative for the binding (D11 accepts the forwarding risk; A can
// regenerate the link). 409 same_kaata when vault_id equals the other
// party's vault_id.
func (s *Service) Join(ctx context.Context, p Party, in JoinInput) (TabResponse, error) {
	label, err := validLabel(in.Label)
	if err != nil {
		return TabResponse{}, err
	}
	if !p.allows(rankEditor) {
		return TabResponse{}, ErrRoleInsufficient
	}
	if err := checkVaultBinding(ctx, s.pool, in.VaultID, in.AccountID); err != nil {
		return TabResponse{}, err
	}

	tx, err := s.beginMutation(ctx, in.AccountID)
	if err != nil {
		return TabResponse{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	linkVault, linkRelationship := creditLinkDestination(p, in.VaultID, in.RelationshipID)
	code, err := tabCurrency(ctx, tx, p.TabID)
	if err != nil {
		return TabResponse{}, err
	}
	linkCredit, err := s.beginLinkCredit(ctx, tx, linkVault, linkRelationship, in.AccountID, code)
	if err != nil {
		return TabResponse{}, err
	}
	recordingSources, err := lockRecordingSources(ctx, tx, p.TabID, linkVault, linkRelationship)
	if err != nil {
		return TabResponse{}, err
	}
	selectedParty := p
	locked, err := lockOpenTab(ctx, tx, p.TabID)
	if err != nil {
		return TabResponse{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, true)
	if err != nil {
		return TabResponse{}, err
	}
	if !sameCreditVault(selectedParty, p) {
		return TabResponse{}, ErrNotFound
	}
	if err := validateRecordingSources(ctx, tx, p.TabID, linkVault, linkRelationship, recordingSources); err != nil {
		return TabResponse{}, err
	}
	if err := checkPartyClaim(ctx, tx, p, in.AccountID); err != nil {
		return TabResponse{}, err
	}
	if err := checkContactBinding(ctx, tx, p.TabID, p.Role, locked.Currency, in.VaultID, in.RelationshipID, in.ExpectedPreviousTabID, in.ExpectedPreviousRev, false, in.ExpectedHistoryRevisions); err != nil {
		return TabResponse{}, err
	}
	if err := checkSameKaata(ctx, tx, p.TabID, p.Role, in.VaultID); err != nil {
		return TabResponse{}, err
	}
	if err := checkSameAccount(ctx, tx, p.TabID, p.Role, in.AccountID, in.VaultID); err != nil {
		return TabResponse{}, err
	}
	if p.Role == "b" && notificationOnlyMode(locked.RecordingMode) {
		if err := validateNotifyOpeningSource(ctx, tx, p.TabID); err != nil {
			return TabResponse{}, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tab_parties
		   SET label = $3,
		       joined_at = COALESCE(joined_at, NOW()),
		       account_id = COALESCE($4::uuid, account_id),
		       vault_id = COALESCE($5::uuid, vault_id),
		       relationship_id = COALESCE($6::uuid, relationship_id),
		       install_id = COALESCE($7::uuid, install_id),
		       last_seen_at = NOW()
		 WHERE tab_id = $1::uuid AND role = $2
	`, p.TabID, p.Role, label, in.AccountID, in.VaultID, in.RelationshipID, in.InstallID); err != nil {
		return TabResponse{}, fmt.Errorf("join party: %w", err)
	}
	if err := setLinkBoundary(ctx, tx, p.TabID, p.Role, in.LinkedAtMS); err != nil {
		return TabResponse{}, err
	}
	if p.Role == "a" && notificationOnlyMode(locked.RecordingMode) && (p.VaultID == nil || p.RelationshipID == nil) {
		if err := saveNotifyOpeningSource(ctx, tx, p.TabID); err != nil {
			return TabResponse{}, err
		}
	}
	if err := s.finishLinkCredit(ctx, tx, linkCredit); err != nil {
		return TabResponse{}, err
	}
	joinRev, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent("updated", ""))
	if err != nil {
		return TabResponse{}, err
	}
	// The first actual B Join records the carried source in notify mode.
	// It is a Join audit transition, never an individual acceptance/review.
	if p.Role == "b" && notificationOnlyMode(locked.RecordingMode) {
		if _, err := tx.Exec(ctx, `UPDATE tab_entries SET status='recorded',status_at_ms=$2,rev=$3
		 WHERE tab_id=$1::uuid AND kind='opening' AND created_by='a'
		   AND status='pending' AND voided_by_entry_id IS NULL`, p.TabID, nowMS(), joinRev); err != nil {
			return TabResponse{}, fmt.Errorf("record joined opening: %w", err)
		}
	}
	resp, err := fullResponse(ctx, tx, p.TabID, p.Role)
	if err != nil {
		return TabResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TabResponse{}, fmt.Errorf("commit tx: %w", err)
	}
	s.poke(ctx, p.TabID)
	return resp, nil
}

// Bind attaches the session account to the resolved party — the signed-in
// phone that joined through the web page, or a creator who signed in later —
// and optionally the kaata + contact. The account is SET (not COALESCEd):
// the caller proved possession of the party and now owns its recovery path.
func (s *Service) Bind(ctx context.Context, p Party, in BindInput) (TabResponse, error) {
	if !p.allows(rankEditor) {
		return TabResponse{}, ErrRoleInsufficient
	}
	if err := checkVaultBinding(ctx, s.pool, in.VaultID, &in.AccountID); err != nil {
		return TabResponse{}, err
	}

	tx, err := s.beginMutation(ctx, &in.AccountID)
	if err != nil {
		return TabResponse{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	linkVault, linkRelationship := creditLinkDestination(p, in.VaultID, in.RelationshipID)
	code, err := tabCurrency(ctx, tx, p.TabID)
	if err != nil {
		return TabResponse{}, err
	}
	linkCredit, err := s.beginLinkCredit(ctx, tx, linkVault, linkRelationship, &in.AccountID, code)
	if err != nil {
		return TabResponse{}, err
	}
	selectedParty := p
	locked, err := lockOpenTab(ctx, tx, p.TabID)
	if err != nil {
		return TabResponse{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, true)
	if err != nil {
		return TabResponse{}, err
	}
	if !sameCreditVault(selectedParty, p) {
		return TabResponse{}, ErrNotFound
	}
	if err := checkPartyClaim(ctx, tx, p, &in.AccountID); err != nil {
		return TabResponse{}, err
	}
	if err := checkContactBinding(ctx, tx, p.TabID, p.Role, locked.Currency, in.VaultID, in.RelationshipID, in.ExpectedPreviousTabID, in.ExpectedPreviousRev, false, in.ExpectedHistoryRevisions); err != nil {
		return TabResponse{}, err
	}
	if err := checkSameKaata(ctx, tx, p.TabID, p.Role, in.VaultID); err != nil {
		return TabResponse{}, err
	}
	if err := checkSameAccount(ctx, tx, p.TabID, p.Role, &in.AccountID, in.VaultID); err != nil {
		return TabResponse{}, err
	}
	// Re-registering recovery after an app restart is not a ledger change.
	// Avoid revision bumps (and peer notifications) for the same binding.
	var unchanged bool
	if err := tx.QueryRow(ctx, `SELECT account_id IS NOT DISTINCT FROM $3::uuid
	 AND ($4::uuid IS NULL OR vault_id IS NOT DISTINCT FROM $4::uuid)
	 AND ($5::uuid IS NULL OR relationship_id IS NOT DISTINCT FROM $5::uuid)
	 FROM tab_parties WHERE tab_id=$1::uuid AND role=$2`, p.TabID, p.Role,
		in.AccountID, in.VaultID, in.RelationshipID).Scan(&unchanged); err != nil {
		return TabResponse{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tab_parties
		   SET account_id = $3::uuid,
		       vault_id = COALESCE($4::uuid, vault_id),
		       relationship_id = COALESCE($5::uuid, relationship_id),
		       install_id = COALESCE($6::uuid, install_id),
		       last_seen_at = NOW()
		 WHERE tab_id = $1::uuid AND role = $2
	`, p.TabID, p.Role, in.AccountID, in.VaultID, in.RelationshipID, in.InstallID); err != nil {
		return TabResponse{}, fmt.Errorf("bind party: %w", err)
	}
	if err := setLinkBoundary(ctx, tx, p.TabID, p.Role, in.LinkedAtMS); err != nil {
		return TabResponse{}, err
	}
	if p.Role == "a" && notificationOnlyMode(locked.RecordingMode) && (p.VaultID == nil || p.RelationshipID == nil) {
		if err := saveNotifyOpeningSource(ctx, tx, p.TabID); err != nil {
			return TabResponse{}, err
		}
	}
	if err := s.finishLinkCredit(ctx, tx, linkCredit); err != nil {
		return TabResponse{}, err
	}
	if !unchanged {
		if _, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent("updated", "")); err != nil {
			return TabResponse{}, err
		}
	}
	resp, err := fullResponse(ctx, tx, p.TabID, p.Role)
	if err != nil {
		return TabResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TabResponse{}, fmt.Errorf("commit tx: %w", err)
	}
	s.poke(ctx, p.TabID)
	return resp, nil
}

// SetLabel renames how the caller's side appears to the other party.
func (s *Service) SetLabel(ctx context.Context, p Party, label string) (TabResponse, error) {
	label, err := validLabel(label)
	if err != nil {
		return TabResponse{}, err
	}
	if !p.allows(rankEditor) {
		return TabResponse{}, ErrRoleInsufficient
	}

	tx, err := s.beginMutation(ctx, p.actorAccount())
	if err != nil {
		return TabResponse{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := lockOpenTab(ctx, tx, p.TabID); err != nil {
		return TabResponse{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, false)
	if err != nil {
		return TabResponse{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tab_parties SET label = $3 WHERE tab_id = $1::uuid AND role = $2
	`, p.TabID, p.Role, label); err != nil {
		return TabResponse{}, fmt.Errorf("set label: %w", err)
	}
	if _, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent("updated", "")); err != nil {
		return TabResponse{}, err
	}
	resp, err := fullResponse(ctx, tx, p.TabID, p.Role)
	if err != nil {
		return TabResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TabResponse{}, fmt.Errorf("commit tx: %w", err)
	}
	s.poke(ctx, p.TabID)
	return resp, nil
}

// Append adds a tally. Idempotent on the client-minted id: a replay by the
// same tab + author returns the existing row with Created=false; the same id
// in another tab or from the other party is ErrIDTaken. The tally counts the
// moment it lands for credit exposure. Review accounts create a proposal;
// notify accounts create a recorded claim without a peer-review requirement.
func (s *Service) Append(ctx context.Context, p Party, in AppendInput) (AppendResult, error) {
	if _, err := uuid.Parse(in.ID); err != nil {
		return AppendResult{}, ErrIDTaken
	}
	if err := validDirection(in.Direction); err != nil {
		return AppendResult{}, err
	}
	minor, err := parseAmountMinor(in.Amount)
	if err != nil {
		return AppendResult{}, err
	}
	note, err := validNote(in.Note)
	if err != nil {
		return AppendResult{}, err
	}
	if in.OccurredAtMS <= 0 {
		return AppendResult{}, ErrInvalidOccurredAt
	}
	if !p.allows(rankClerk) {
		return AppendResult{}, ErrRoleInsufficient
	}

	tx, err := s.beginMutation(ctx, p.actorAccount())
	if err != nil {
		return AppendResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockedVaultID := p.VaultID
	if p.VaultID != nil {
		if err := credit.Lock(ctx, tx, *p.VaultID); err != nil {
			return AppendResult{}, err
		}
	}

	locked, err := lockTab(ctx, tx, p.TabID)
	if err != nil {
		return AppendResult{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankClerk, false)
	if err != nil {
		return AppendResult{}, err
	}
	if !tallyWriterAllowed(locked.RecordingMode, p.Role) {
		return AppendResult{}, ErrOneWayReadOnly
	}
	// A party binding may have moved while we waited for the row lock. Do not
	// evaluate its new exposure while holding the old kaata admission lock.
	if (lockedVaultID == nil) != (p.VaultID == nil) || (lockedVaultID != nil && p.VaultID != nil && *lockedVaultID != *p.VaultID) {
		return AppendResult{}, ErrNotFound
	}

	// Idempotency: the id already exists → it is either OUR earlier append
	// (return it, 200) or somebody else's (409). Same-tab races are excluded
	// by the row lock; cross-tab ones are caught by insertEntry's ON CONFLICT.
	var existingTab, existingBy string
	err = tx.QueryRow(ctx, `
		SELECT tab_id::text, created_by FROM tab_entries WHERE id = $1::uuid
	`, in.ID).Scan(&existingTab, &existingBy)
	switch {
	case err == nil:
		if existingTab != p.TabID || existingBy != p.Role {
			return AppendResult{}, ErrIDTaken
		}
		e, err := loadEntryForUpdate(ctx, tx, p.TabID, in.ID)
		if err != nil {
			return AppendResult{}, err
		}
		tab, err := loadTab(ctx, tx, p.TabID, p.Role)
		if err != nil {
			return AppendResult{}, err
		}
		hint, err := duplicateHint(ctx, tx, p.TabID, e)
		if err != nil {
			return AppendResult{}, err
		}
		return AppendResult{Entry: e, Tab: tab, DuplicateHint: hint, Created: false}, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return AppendResult{}, fmt.Errorf("idempotency lookup: %w", err)
	}
	var refused bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customer_credit_tab_refusals WHERE tab_id=$1::uuid AND entry_id=$2::uuid)`, p.TabID, in.ID).Scan(&refused); err != nil {
		return AppendResult{}, err
	}
	if refused {
		return AppendResult{}, credit.ErrLimit
	}
	// A lost success response may be retried AFTER the peer closed the tab.
	// Acknowledging the existing row is a read; only a genuinely new append
	// is refused. Otherwise the phone would falsely label a saved tally unsent.
	if locked.ClosedAt != nil {
		return AppendResult{}, ErrTabClosed
	}
	if notificationOnlyMode(locked.RecordingMode) && p.Role == "b" {
		var joined bool
		if err := tx.QueryRow(ctx, `SELECT joined_at IS NOT NULL FROM tab_parties WHERE tab_id=$1::uuid AND role='b'`, p.TabID).Scan(&joined); err != nil {
			return AppendResult{}, err
		}
		if !joined {
			return AppendResult{}, ErrJoinRequired
		}
	}
	delta := partyCreditDelta(p, in.Direction, minor)
	if err := s.admitCreditDelta(ctx, tx, p, delta); err != nil {
		if errors.Is(err, credit.ErrLimit) {
			// The details let the kaata's owner see the attempt (audit #24).
			entryType := "debt"
			if delta < 0 {
				entryType = "payment"
			}
			if _, err := tx.Exec(ctx, `INSERT INTO customer_credit_tab_refusals(tab_id,entry_id,vault_id,relationship_id,entry_type,amount_minor,actor_account_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,NULLIF($7,'')::uuid) ON CONFLICT DO NOTHING`, p.TabID, in.ID, *p.VaultID, *p.RelationshipID, entryType, minor, p.ActorAccountID); err != nil {
				return AppendResult{}, err
			}
			if err := tx.Commit(ctx); err != nil {
				return AppendResult{}, fmt.Errorf("commit credit refusal: %w", err)
			}
			return AppendResult{}, credit.ErrLimit
		}
		return AppendResult{}, err
	}

	rev, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent("entry_created", in.ID))
	if err != nil {
		return AppendResult{}, err
	}
	seq, err := nextSeq(ctx, tx, p.TabID)
	if err != nil {
		return AppendResult{}, err
	}
	status := "pending"
	if notificationOnlyMode(locked.RecordingMode) {
		status = "recorded"
	}
	e, err := insertEntry(ctx, tx, p.TabID, in.ID, seq, rev, p.Role, in.Direction, minor, "entry", note,
		in.OccurredAtMS, status, nil, nil, p.actorAccount(), p.evidenceRole())
	if err != nil {
		return AppendResult{}, err
	}
	hint, err := duplicateHint(ctx, tx, p.TabID, e)
	if err != nil {
		return AppendResult{}, err
	}
	tab, err := loadTab(ctx, tx, p.TabID, p.Role)
	if err != nil {
		return AppendResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AppendResult{}, fmt.Errorf("commit tx: %w", err)
	}
	s.poke(ctx, p.TabID)
	return AppendResult{Entry: e, Tab: tab, DuplicateHint: hint, Created: true}, nil
}

// partyCreditDelta converts a shared tab direction into this kaata's balance.
func partyCreditDelta(p Party, direction string, minor int64) int64 {
	if (p.Role == "a" && direction == "b_to_a") || (p.Role == "b" && direction == "a_to_b") {
		return -minor
	}
	return minor
}

// New entries are appended to the latest open period, so their amount is the
// recorded exposure delta. Review/cancellation instead compare actual source
// balances: removing an opening can reveal a different historical checkpoint.
func (s *Service) admitCreditDelta(ctx context.Context, tx pgx.Tx, p Party, delta int64) error {
	if delta == 0 {
		return nil
	}
	admission, err := s.beginPartyCredit(ctx, tx, p)
	if err != nil || admission == nil {
		return err
	}
	before := admission.before
	if (delta > 0 && before > 9223372036854775807-delta) || (delta < 0 && before < (-9223372036854775807-1)-delta) || admission.policy.Exceeded(before, before+delta) {
		return credit.ErrLimit
	}
	return nil
}

// Call after the selected party's credit lock and authorization recheck.
// Delegated and bound account roles/overrides retain the existing policy.
func (s *Service) beginPartyCredit(ctx context.Context, tx pgx.Tx, p Party) (*linkCreditAdmission, error) {
	if p.VaultID == nil || p.RelationshipID == nil || (p.effectiveRole() != "clerk" && p.effectiveRole() != "editor") {
		return nil, nil
	}
	code, err := tabCurrency(ctx, tx, p.TabID)
	if err != nil {
		return nil, err
	}
	policy, err := credit.Effective(ctx, tx, *p.VaultID, *p.RelationshipID, code)
	if err != nil || policy == nil {
		return nil, err
	}
	override, err := credit.MemberOverride(ctx, tx, *p.VaultID, p.ActorAccountID)
	if err != nil {
		return nil, err
	}
	if !policy.Restricts(p.effectiveRole(), override) {
		return nil, nil
	}
	if s.creditBalance == nil {
		return nil, fmt.Errorf("credit admission unavailable")
	}
	before, err := s.creditBalance(ctx, tx, *p.VaultID, *p.RelationshipID, code)
	if err != nil {
		return nil, err
	}
	return &linkCreditAdmission{vaultID: *p.VaultID, relationshipID: *p.RelationshipID, policy: policy, before: before, currency: code}, nil
}

// lockPartyCredit precedes every balance-changing tab mutation. Rechecking
// the selected party afterwards prevents a binding race from using another
// kaata's policy while we still hold the original kaata's admission lock.
func lockPartyCredit(ctx context.Context, tx pgx.Tx, p Party) error {
	if p.VaultID != nil {
		return credit.Lock(ctx, tx, *p.VaultID)
	}
	return nil
}

func sameCreditVault(before, after Party) bool {
	return (before.VaultID == nil && after.VaultID == nil) ||
		(before.VaultID != nil && after.VaultID != nil && *before.VaultID == *after.VaultID)
}

func creditLinkDestination(p Party, vaultID, relationshipID *string) (*string, *string) {
	if vaultID == nil {
		vaultID = p.VaultID
	}
	if relationshipID == nil {
		relationshipID = p.RelationshipID
	}
	return vaultID, relationshipID
}

type linkCreditAdmission struct {
	vaultID, relationshipID string
	currency                string
	policy                  *credit.Policy
	before                  int64
}

// Linking may replace local history with a shared opening. Compare the full
// source balance before and after, so preserving an existing over-cap balance
// remains lawful while fabricating a larger opening cannot bypass the limit.
func (s *Service) beginLinkCredit(ctx context.Context, tx pgx.Tx, vaultID, relationshipID, accountID *string, currency string) (*linkCreditAdmission, error) {
	if vaultID == nil {
		return nil, nil
	}
	if err := credit.Lock(ctx, tx, *vaultID); err != nil {
		return nil, err
	}
	if err := checkVaultBinding(ctx, tx, vaultID, accountID); err != nil {
		return nil, err
	}
	if relationshipID == nil || accountID == nil {
		return nil, nil
	}
	var role string
	if err := tx.QueryRow(ctx, `SELECT role FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL`, *vaultID, *accountID).Scan(&role); err != nil {
		return nil, err
	}
	policy, err := credit.Effective(ctx, tx, *vaultID, *relationshipID, currency)
	if err != nil || policy == nil {
		return nil, err
	}
	override, err := credit.MemberOverride(ctx, tx, *vaultID, *accountID)
	if err != nil {
		return nil, err
	}
	if !policy.Restricts(role, override) {
		return nil, nil
	}
	if s.creditBalance == nil {
		return nil, fmt.Errorf("credit admission unavailable")
	}
	before, err := s.creditBalance(ctx, tx, *vaultID, *relationshipID, currency)
	if err != nil {
		return nil, err
	}
	return &linkCreditAdmission{vaultID: *vaultID, relationshipID: *relationshipID, policy: policy, before: before, currency: currency}, nil
}

func (s *Service) finishLinkCredit(ctx context.Context, tx pgx.Tx, admission *linkCreditAdmission) error {
	if admission == nil {
		return nil
	}
	after, err := s.creditBalance(ctx, tx, admission.vaultID, admission.relationshipID, admission.currency)
	if err != nil {
		return err
	}
	if admission.policy.Exceeded(admission.before, after) {
		return credit.ErrLimit
	}
	return nil
}

// duplicateHint implements D17's settlement double-log warning: another
// non-voided tally by the OTHER party for the same amount, dated within ±24 h.
//
// Direction: the design text says "opposite direction (i.e. the same
// transfer seen from the other side)". Those two clauses agree only in the
// RELATIVE vocabulary — one side says "I gave", the other "I received". In
// the ABSOLUTE a_to_b/b_to_a terms this table stores, the same handover
// carries the SAME direction from both sides (B pays A 500: A records
// "received" = b_to_a, B records "gave" = b_to_a), and that identical pair is
// exactly what doubles the balance. Opposite absolute directions (A gave
// goods, B paid cash) are the ordinary buy-then-pay pair and net correctly,
// so flagging them would fire on the most common flow. Hence: same absolute
// direction. Nearest by date wins, newest breaks the tie.
func duplicateHint(ctx context.Context, q querier, tabID string, e Entry) (*DuplicateHint, error) {
	var h DuplicateHint
	err := q.QueryRow(ctx, `
		SELECT id::text, created_by, occurred_at_ms FROM tab_entries
		 WHERE tab_id = $1::uuid AND id <> $2::uuid
		   AND created_by <> $3 AND direction = $4 AND amount_minor = $5
		   AND kind <> 'void' AND voided_by_entry_id IS NULL AND status <> 'disputed'
		   AND abs(occurred_at_ms - $6) <= $7
		 ORDER BY abs(occurred_at_ms - $6) ASC, seq DESC
		 LIMIT 1
	`, tabID, e.ID, e.CreatedBy, e.Direction, e.amountMinor, e.OccurredAtMS, int64(duplicateWindowMS)).
		Scan(&h.EntryID, &h.By, &h.AtMS)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("duplicate hint: %w", err)
	}
	return &h, nil
}

// setStatus is the shared body of Accept and Dispute: only the OTHER party
// may review a tally (ErrOwnEntry), never a voided one (ErrAlreadyVoided),
// and the tab's rev advances with the row's.
func (s *Service) setStatus(ctx context.Context, p Party, entryID, status string, reason *string, expectedRev ...int64) (EntryResponse, error) {
	if !p.allows(rankEditor) {
		return EntryResponse{}, ErrRoleInsufficient
	}
	if _, err := uuid.Parse(entryID); err != nil {
		return EntryResponse{}, ErrEntryNotFound
	}

	tx, err := s.beginMutation(ctx, p.actorAccount())
	if err != nil {
		return EntryResponse{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	selectedParty := p
	if err := lockPartyCredit(ctx, tx, p); err != nil {
		return EntryResponse{}, err
	}
	var recordingSources map[string]bool
	if status == "accepted" {
		var kind string
		if err := tx.QueryRow(ctx, `SELECT kind FROM tab_entries WHERE tab_id=$1::uuid AND id=$2::uuid`, p.TabID, entryID).Scan(&kind); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return EntryResponse{}, ErrEntryNotFound
			}
			return EntryResponse{}, err
		}
		if kind == "opening" {
			recordingSources, err = lockRecordingSources(ctx, tx, p.TabID, nil, nil)
			if err != nil {
				return EntryResponse{}, err
			}
		}
	}
	locked, err := lockTab(ctx, tx, p.TabID)
	if err != nil {
		return EntryResponse{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, false)
	if err != nil {
		return EntryResponse{}, err
	}
	if !sameCreditVault(selectedParty, p) {
		return EntryResponse{}, ErrNotFound
	}
	if recordingSources != nil {
		if err := validateRecordingSources(ctx, tx, p.TabID, nil, nil, recordingSources); err != nil {
			return EntryResponse{}, err
		}
	}
	e, err := loadEntryForUpdate(ctx, tx, p.TabID, entryID)
	if err != nil {
		return EntryResponse{}, err
	}
	if e.Kind == "void" || e.VoidedByEntryID != nil {
		return EntryResponse{}, ErrAlreadyVoided
	}
	if e.CreatedBy == p.Role {
		return EntryResponse{}, ErrOwnEntry
	}
	if notificationOnlyMode(locked.RecordingMode) || e.Status == "recorded" {
		return EntryResponse{}, ErrReviewNotRequired
	}
	// Lost acknowledgements and duplicate OS callbacks must not emit another alert.
	if e.Status == status && (reason == nil || (e.DisputeReason != nil && *e.DisputeReason == *reason)) {
		tab, err := loadTab(ctx, tx, p.TabID, p.Role)
		return EntryResponse{Entry: e, Tab: tab}, err
	}
	// The row is locked: concurrent phones/notification actions can only make
	// ONE decision. Identical retries above remain safe after a lost response;
	// neither a different verdict nor an edited rejection reason may replace it.
	// Enforce this even for older clients that omit expectedRev.
	if e.Status != "pending" {
		return EntryResponse{}, ErrReviewFinal
	}
	if len(expectedRev) > 0 && expectedRev[0] > 0 && e.Rev != expectedRev[0] {
		return EntryResponse{}, ErrStaleReview
	}
	admission, err := s.beginPartyCredit(ctx, tx, p)
	if err != nil {
		return EntryResponse{}, err
	}
	kind := "entry_accepted"
	if status == "disputed" {
		kind = "entry_rejected"
	}
	rev, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent(kind, entryID))
	if err != nil {
		return EntryResponse{}, err
	}
	now := nowMS()
	updated, err := scanEntry(tx.QueryRow(ctx, `
		UPDATE tab_entries
		   SET status = $3, status_at_ms = $4, dispute_reason = $5, rev = $6,
		       reviewer_account_id = $7::uuid,
		       reviewer_name = COALESCE((SELECT COALESCE(display_name, name) FROM accounts WHERE id=$7::uuid), ''),
		       reviewer_party = $8, reviewer_member_role = $9, review_semantics_version = $10
		 WHERE tab_id = $1::uuid AND id = $2::uuid
		 RETURNING `+entryCols,
		p.TabID, entryID, status, now, reason, rev, p.actorAccount(), p.Role, p.evidenceRole(), reviewSemanticsVersion))
	if err != nil {
		return EntryResponse{}, fmt.Errorf("update status: %w", err)
	}
	if err := markEntryNoticesRead(ctx, tx, p, entryID); err != nil {
		return EntryResponse{}, err
	}
	if err := s.finishLinkCredit(ctx, tx, admission); err != nil {
		return EntryResponse{}, err
	}
	tab, err := loadTab(ctx, tx, p.TabID, p.Role)
	if err != nil {
		return EntryResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return EntryResponse{}, fmt.Errorf("commit tx: %w", err)
	}
	s.poke(ctx, p.TabID)
	return EntryResponse{Entry: updated, Tab: tab}, nil
}

// Accept makes the other party's pending tally permanently accepted.
func (s *Service) Accept(ctx context.Context, p Party, entryID string, expectedRev ...int64) (EntryResponse, error) {
	return s.setStatus(ctx, p, entryID, "accepted", nil, expectedRev...)
}

// Dispute permanently rejects a pending tally, with an optional reason
// (≤ 300 chars). A correction must be sent as a new tally.
func (s *Service) Dispute(ctx context.Context, p Party, entryID, reason string, expectedRev ...int64) (EntryResponse, error) {
	reason = strings.TrimSpace(reason)
	if utf8.RuneCountInString(reason) > maxReasonRunes {
		return EntryResponse{}, ErrInvalidReason
	}
	return s.setStatus(ctx, p, entryID, "disputed", &reason, expectedRev...)
}

// Void appends the reversing row (D5): kind='void', the original's amount,
// the OPPOSITE direction, status 'accepted' (a void needs no review),
// voids_entry_id → original; the original gets voided_by_entry_id and the
// same rev. Only the author may cancel a PENDING tally. Accept/reject is final,
// even for older clients: review and cancellation take the same locks, so only
// one can win. A second void is ErrAlreadyVoided.
func (s *Service) Void(ctx context.Context, p Party, entryID string) (VoidResponse, error) {
	if !p.allows(rankEditor) {
		return VoidResponse{}, ErrRoleInsufficient
	}
	if _, err := uuid.Parse(entryID); err != nil {
		return VoidResponse{}, ErrEntryNotFound
	}

	tx, err := s.beginMutation(ctx, p.actorAccount())
	if err != nil {
		return VoidResponse{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	selectedParty := p
	if err := lockPartyCredit(ctx, tx, p); err != nil {
		return VoidResponse{}, err
	}
	var originalStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM tab_entries WHERE tab_id=$1::uuid AND id=$2::uuid`, p.TabID, entryID).Scan(&originalStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VoidResponse{}, ErrEntryNotFound
		}
		return VoidResponse{}, err
	}
	if originalStatus == "recorded" {
		if err := lockRecordingSource(ctx, tx, p.TabID); err != nil {
			return VoidResponse{}, err
		}
	}
	locked, err := lockTab(ctx, tx, p.TabID)
	if err != nil {
		return VoidResponse{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, false)
	if err != nil {
		return VoidResponse{}, err
	}
	if !tallyWriterAllowed(locked.RecordingMode, p.Role) {
		return VoidResponse{}, ErrOneWayReadOnly
	}
	if !sameCreditVault(selectedParty, p) {
		return VoidResponse{}, ErrNotFound
	}
	orig, err := loadEntryForUpdate(ctx, tx, p.TabID, entryID)
	if err != nil {
		return VoidResponse{}, err
	}
	if orig.Kind == "void" || orig.VoidedByEntryID != nil {
		return VoidResponse{}, ErrAlreadyVoided
	}
	if orig.CreatedBy != p.Role {
		return VoidResponse{}, ErrNotAuthor
	}
	if orig.Status != "pending" && orig.Status != "recorded" {
		return VoidResponse{}, ErrReviewFinal
	}
	if orig.Status == "recorded" {
		if orig.Kind == "opening" {
			return VoidResponse{}, ErrRecordedOpeningFinal
		}
		var settled bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_settlements WHERE tab_id=$1::uuid AND through_seq >= $2)`, p.TabID, orig.Seq).Scan(&settled); err != nil {
			return VoidResponse{}, err
		}
		if settled {
			return VoidResponse{}, ErrSettledRecord
		}
		carried, err := recordedEntryCarriedForward(ctx, tx, p.TabID)
		if err != nil {
			return VoidResponse{}, err
		}
		if carried {
			return VoidResponse{}, ErrRecordedHistoryFinal
		}
	}
	admission, err := s.beginPartyCredit(ctx, tx, p)
	if err != nil {
		return VoidResponse{}, err
	}
	response, err := withdrawPendingEntry(ctx, tx, p, orig)
	if err != nil {
		return VoidResponse{}, err
	}
	if err := s.finishLinkCredit(ctx, tx, admission); err != nil {
		return VoidResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VoidResponse{}, fmt.Errorf("commit tx: %w", err)
	}
	s.poke(ctx, p.TabID)
	return response, nil
}

// withdrawPendingEntry runs under the tab lock after the caller verifies that
// orig is its own withdrawable pending/recorded monetary entry. The accepted void is a creator
// withdrawal audit row, never a fabricated counterparty review.
func withdrawPendingEntry(ctx context.Context, tx pgx.Tx, p Party, orig Entry) (VoidResponse, error) {
	entryID := orig.ID
	rev, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent("entry_voided", entryID))
	if err != nil {
		return VoidResponse{}, err
	}
	seq, err := nextSeq(ctx, tx, p.TabID)
	if err != nil {
		return VoidResponse{}, err
	}
	now := nowMS()
	void, err := insertEntry(ctx, tx, p.TabID, uuid.NewString(), seq, rev, p.Role, opposite(orig.Direction),
		orig.amountMinor, "void", nil, now, "accepted", &now, &orig.ID, p.actorAccount(), p.evidenceRole())
	if err != nil {
		return VoidResponse{}, err
	}
	voided, err := scanEntry(tx.QueryRow(ctx, `
		UPDATE tab_entries SET voided_by_entry_id = $3::uuid, rev = $4
		 WHERE tab_id = $1::uuid AND id = $2::uuid
		 RETURNING `+entryCols,
		p.TabID, orig.ID, void.ID, rev))
	if err != nil {
		return VoidResponse{}, fmt.Errorf("mark voided: %w", err)
	}
	if err := markEntryNoticesRead(ctx, tx, p, orig.ID); err != nil {
		return VoidResponse{}, err
	}
	return VoidResponse{Voided: voided, Void: void}, nil
}

// Close stops new shared tallies and linking changes. Existing pending rows
// remain reviewable/withdrawable so either party can leave without trapping
// an unconfirmed claim in the other party's balance. Final decisions stay final.
// The optional flag withdraws only A's untouched invitation opening under the
// same lock as Join. It may also clean up an already-closed legacy invitation.
// Old callers omit the flag and retain the original idempotent close behavior.
func (s *Service) Close(ctx context.Context, p Party, withdrawUnjoinedOpening ...bool) (TabResponse, error) {
	if !p.allows(rankEditor) {
		return TabResponse{}, ErrRoleInsufficient
	}

	tx, err := s.beginMutation(ctx, p.actorAccount())
	if err != nil {
		return TabResponse{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	selectedParty := p
	if err := lockPartyCredit(ctx, tx, p); err != nil {
		return TabResponse{}, err
	}
	t, err := lockTab(ctx, tx, p.TabID)
	if err != nil {
		return TabResponse{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, false)
	if err != nil {
		return TabResponse{}, err
	}
	if !sameCreditVault(selectedParty, p) {
		return TabResponse{}, ErrNotFound
	}
	changed := false
	if p.Role == "a" && len(withdrawUnjoinedOpening) > 0 && withdrawUnjoinedOpening[0] {
		current, err := loadTab(ctx, tx, p.TabID, p.Role)
		if err != nil {
			return TabResponse{}, err
		}
		if current.UnjoinedInvitation {
			entries, err := loadEntries(ctx, tx, p.TabID, 0)
			if err != nil {
				return TabResponse{}, err
			}
			for _, entry := range entries {
				if entry.CreatedBy == "a" && entry.Kind == "opening" && entry.Status == "pending" && entry.VoidedByEntryID == nil {
					if _, err := withdrawPendingEntry(ctx, tx, p, entry); err != nil {
						return TabResponse{}, err
					}
					changed = true
				}
			}
		}
	}
	// Leaving does not create or erase money. Credit limits must never force
	// either party to keep sharing; existing proposals remain resolvable.
	if t.ClosedAt == nil {
		if _, err := tx.Exec(ctx, `
		UPDATE tabs SET closed_at = NOW(), closed_by = $2 WHERE id = $1::uuid
	`, p.TabID, p.Role); err != nil {
			return TabResponse{}, fmt.Errorf("close tab: %w", err)
		}
		if _, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent("updated", "")); err != nil {
			return TabResponse{}, err
		}
		changed = true
	}
	resp, err := fullResponse(ctx, tx, p.TabID, p.Role)
	if err != nil {
		return TabResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TabResponse{}, fmt.Errorf("commit tx: %w", err)
	}
	if changed {
		s.poke(ctx, p.TabID)
	}
	return resp, nil
}

// RegenerateLink rotates party B's token (party A only). B's existing
// sessions — anyone holding the old forwarded link — lose access at once;
// the new plaintext is returned exactly once for the handler to wrap in the
// invite URL.
func (s *Service) RegenerateLink(ctx context.Context, p Party) (string, error) {
	if p.Role != "a" {
		return "", ErrNotPartyA
	}
	if !p.allows(rankEditor) {
		return "", ErrRoleInsufficient
	}
	token, err := newPartyToken()
	if err != nil {
		return "", err
	}

	tx, err := s.beginMutation(ctx, p.actorAccount())
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := lockOpenTab(ctx, tx, p.TabID); err != nil {
		return "", err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, false)
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE tab_parties SET token_hash = $2 WHERE tab_id = $1::uuid AND role = 'b'
	`, p.TabID, hashPartyToken(token)); err != nil {
		return "", fmt.Errorf("rotate token: %w", err)
	}
	if _, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent("updated", "")); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit tx: %w", err)
	}
	s.poke(ctx, p.TabID)
	return token, nil
}

// The tab lock serializes first claims. An invite can recover an unbound
// legacy party, but can never transfer an already claimed account.
func checkPartyClaim(ctx context.Context, tx pgx.Tx, p Party, accountID *string) error {
	var bound *string
	var claimed bool
	if err := tx.QueryRow(ctx, "SELECT account_id::text, account_bound_once FROM tab_parties WHERE tab_id=$1::uuid AND role=$2", p.TabID, p.Role).Scan(&bound, &claimed); err != nil {
		return err
	}
	if (claimed && bound == nil) || (bound != nil && (accountID == nil || *bound != *accountID)) {
		return ErrNotFound
	}
	return nil
}
