package tabs

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// tabFixture is two shopkeepers with a kaata each (accounts + vaults +
// owner memberships) — the world a mutual tab is born into. Every test that
// needs a tab creates its own through the service so the rows under test
// are the rows production writes.
type tabFixture struct {
	pool   *pgxpool.Pool
	svc    *Service
	acctA  string
	vaultA string
	acctB  string
	vaultB string
}

func newTabFixture(t *testing.T) *tabFixture {
	t.Helper()
	pool := testutil.ConnectTestDB(t)
	f := &tabFixture{pool: pool, svc: NewService(pool)}
	f.acctA = seedAccount(t, pool, "a@example.com", "Matee")
	f.vaultA = seedVault(t, pool, f.acctA, "Saafi Store")
	f.acctB = seedAccount(t, pool, "b@example.com", "Ahmad")
	f.vaultB = seedVault(t, pool, f.acctB, "Ahmad Dairy")
	return f
}

func seedAccount(t *testing.T, pool *pgxpool.Pool, email, name string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, $2, TRUE, $3)
		RETURNING id::text
	`, "sub-"+uuid.NewString(), email, name).Scan(&id); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	return id
}

// seedVault creates a vault owned by accountID with an accepted owner
// membership, the same shape sync's m1Fixture seeds.
func seedVault(t *testing.T, pool *pgxpool.Pool, accountID, name string) string {
	t.Helper()
	vaultID := uuid.NewString()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, $3, 'AFN', 0)
	`, vaultID, accountID, name); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	seedMember(t, pool, vaultID, accountID, "owner")
	return vaultID
}

func seedMember(t *testing.T, pool *pgxpool.Pool, vaultID, accountID, role string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), $2::uuid)
	`, vaultID, accountID, role); err != nil {
		t.Fatalf("seed membership: %v", err)
	}
}

func str(s string) *string { return &s }

// create opens a tab as an anonymous party A with an optional opening
// balance (amount "" = none) and returns the result.
func (f *tabFixture) create(t *testing.T, label, openingDir, openingAmount string) CreateResult {
	t.Helper()
	in := CreateInput{Currency: "AFN", Label: label}
	if openingAmount != "" {
		in.Opening = &OpeningInput{Direction: openingDir, Amount: openingAmount, Note: str("Balance before linking"), OccurredAtMS: 1_756_000_000_000}
	}
	res, err := f.svc.Create(context.Background(), in)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return res
}

func (f *tabFixture) party(t *testing.T, token, tabID string) Party {
	t.Helper()
	p, err := f.svc.PartyByToken(context.Background(), token, tabID)
	if err != nil {
		t.Fatalf("PartyByToken: %v", err)
	}
	return p
}

func (f *tabFixture) append(t *testing.T, p Party, direction, amount string, occurredAt int64) AppendResult {
	t.Helper()
	res, err := f.svc.Append(context.Background(), p, AppendInput{
		ID: uuid.NewString(), Direction: direction, Amount: amount, OccurredAtMS: occurredAt,
	})
	if err != nil {
		t.Fatalf("Append(%s %s): %v", direction, amount, err)
	}
	return res
}

// ==========================================================================
// Money
// ==========================================================================

func TestMoneyParseAndFormat(t *testing.T) {
	parse := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"100", 10000, true},
		{"0.25", 25, true},
		{"12.5", 1250, true},
		{"12.50", 1250, true},
		{" 7 ", 700, true},
		{"9999999999.99", 999_999_999_999, true},
		{"0", 0, false},
		{"0.00", 0, false},
		{"-5", 0, false},
		{"1e3", 0, false},
		{"12.345", 0, false},
		{"10000000000", 0, false}, // 11 digits
		{"1,000", 0, false},
		{"", 0, false},
	}
	for _, tc := range parse {
		got, err := parseAmountMinor(tc.in)
		if tc.ok && (err != nil || got != tc.want) {
			t.Errorf("parseAmountMinor(%q) = %d, %v; want %d", tc.in, got, err, tc.want)
		}
		if !tc.ok && !errors.Is(err, ErrInvalidAmount) {
			t.Errorf("parseAmountMinor(%q) = %d, %v; want ErrInvalidAmount", tc.in, got, err)
		}
	}
	format := []struct {
		in   int64
		want string
	}{
		{10000, "100"}, {25, "0.25"}, {-1000, "-10"}, {999_999_999_999, "9999999999.99"},
		{1250, "12.5"}, {1205, "12.05"}, {0, "0"}, {-5, "-0.05"},
	}
	for _, tc := range format {
		if got := formatMinor(tc.in); got != tc.want {
			t.Errorf("formatMinor(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ==========================================================================
// The whole life of a tab
// ==========================================================================

func TestCreateJoinAppendReviewVoidClose(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()

	res := f.create(t, "Saafi Store", "a_to_b", "3400")
	tabID := res.Tab.ID
	if res.Tab.Rev != 1 || len(res.Entries) != 1 {
		t.Fatalf("create with opening: rev=%d entries=%d, want 1/1", res.Tab.Rev, len(res.Entries))
	}
	opening := res.Entries[0]
	if opening.Kind != "opening" || opening.Seq != 1 || opening.Rev != 1 || opening.Status != "pending" || opening.CreatedBy != "a" {
		t.Fatalf("opening entry = %+v", opening)
	}
	if res.Tab.Balance["a"] != "3400" || res.Tab.Balance["b"] != "-3400" {
		t.Fatalf("balance after opening = %v", res.Tab.Balance)
	}
	if res.Tab.Parties["a"].JoinedAtMS == nil || res.Tab.Parties["b"].JoinedAtMS != nil || res.Tab.Parties["a"].Bound {
		t.Fatalf("parties after create = %+v", res.Tab.Parties)
	}
	if res.MyToken == "" || res.InviteToken == "" || res.MyToken == res.InviteToken {
		t.Fatal("tokens must be two distinct non-empty strings")
	}

	pa := f.party(t, res.MyToken, tabID)
	pb := f.party(t, res.InviteToken, tabID)
	if pa.Role != "a" || pb.Role != "b" || pa.MemberRole != "" || pb.MemberRole != "" {
		t.Fatalf("token parties = %+v / %+v", pa, pb)
	}

	// B joins with a name; the tab's rev advances and B is now joined.
	joined, err := f.svc.Join(ctx, pb, JoinInput{Label: "Ahmad"})
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if joined.Tab.Rev != 2 || joined.Tab.Parties["b"].Label != "Ahmad" || joined.Tab.Parties["b"].JoinedAtMS == nil || !joined.Full {
		t.Fatalf("after join: %+v full=%v", joined.Tab, joined.Full)
	}
	// Idempotent re-join updates the label only.
	if again, err := f.svc.Join(ctx, pb, JoinInput{Label: "Ahmad Dairy"}); err != nil || again.Tab.Parties["b"].Label != "Ahmad Dairy" {
		t.Fatalf("re-join: %+v %v", again.Tab.Parties["b"], err)
	}

	// B pays 400 back: b_to_a. Counts immediately (pending), seq 2.
	paid := f.append(t, pb, "b_to_a", "400", 1_756_100_000_000)
	if paid.Entry.Seq != 2 || paid.Entry.Status != "pending" || paid.Entry.CreatedBy != "b" || !paid.Created {
		t.Fatalf("B's append = %+v", paid.Entry)
	}
	if paid.Tab.Balance["b"] != "-3000" || paid.Tab.PendingForYou != 1 { // from B's view: A's opening is pending for B
		t.Fatalf("B's view after paying: balance=%v pending=%d", paid.Tab.Balance, paid.Tab.PendingForYou)
	}
	aView, err := f.svc.Get(ctx, pa, 0)
	if err != nil {
		t.Fatalf("Get A: %v", err)
	}
	if aView.Tab.Balance["a"] != "3000" || aView.Tab.PendingForYou != 1 || len(aView.Entries) != 2 || !aView.Full {
		t.Fatalf("A's view: %+v entries=%d", aView.Tab, len(aView.Entries))
	}
	// Incremental pull: only rows past the cursor come back, oldest first.
	inc, err := f.svc.Get(ctx, pa, 2)
	if err != nil {
		t.Fatalf("Get A after_rev=2: %v", err)
	}
	if inc.Full || len(inc.Entries) != 1 || inc.Entries[0].ID != paid.Entry.ID {
		t.Fatalf("incremental pull = full:%v n=%d", inc.Full, len(inc.Entries))
	}

	// A accepts B's payment; B disputes A's opening.
	acc, err := f.svc.Accept(ctx, pa, paid.Entry.ID)
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if acc.Entry.Status != "accepted" || acc.Entry.StatusAtMS == nil || acc.Tab.PendingForYou != 0 {
		t.Fatalf("after accept: %+v pending=%d", acc.Entry, acc.Tab.PendingForYou)
	}
	dis, err := f.svc.Dispute(ctx, pb, opening.ID, "  It was 3000, not 3400 ")
	if err != nil {
		t.Fatalf("Dispute: %v", err)
	}
	if dis.Entry.Status != "disputed" || dis.Entry.DisputeReason == nil || *dis.Entry.DisputeReason != "It was 3000, not 3400" {
		t.Fatalf("after dispute: %+v", dis.Entry)
	}
	// Disputed entries still count (§2) until voided.
	if dis.Tab.Balance["b"] != "-3000" {
		t.Fatalf("disputed balance = %v", dis.Tab.Balance)
	}

	// A resolves the dispute by voiding the opening: a reversing row, the
	// original struck, and both drop out of the balance.
	v, err := f.svc.Void(ctx, pa, opening.ID)
	if err != nil {
		t.Fatalf("Void: %v", err)
	}
	if v.Void.Kind != "void" || v.Void.Direction != "b_to_a" || v.Void.Amount != "3400" || v.Void.Status != "accepted" ||
		v.Void.VoidsEntryID == nil || *v.Void.VoidsEntryID != opening.ID || v.Void.Seq != 3 {
		t.Fatalf("void row = %+v", v.Void)
	}
	if v.Voided.VoidedByEntryID == nil || *v.Voided.VoidedByEntryID != v.Void.ID || v.Voided.Rev != v.Void.Rev {
		t.Fatalf("voided original = %+v", v.Voided)
	}
	after, err := f.svc.Get(ctx, pa, 0)
	if err != nil {
		t.Fatalf("Get after void: %v", err)
	}
	if after.Tab.Balance["a"] != "-400" || after.Tab.Balance["b"] != "400" {
		t.Fatalf("balance after void = %v", after.Tab.Balance)
	}
	if len(after.Entries) != 3 {
		t.Fatalf("entries after void = %d, want 3 (audit trail keeps everything)", len(after.Entries))
	}

	// Close by B; every write is refused, reads still work, a repeat close
	// is a no-op.
	closed, err := f.svc.Close(ctx, pb)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if closed.Tab.ClosedAtMS == nil || closed.Tab.ClosedBy == nil || *closed.Tab.ClosedBy != "b" {
		t.Fatalf("after close: %+v", closed.Tab)
	}
	if _, err := f.svc.Append(ctx, pa, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "1", OccurredAtMS: 1}); !errors.Is(err, ErrTabClosed) {
		t.Fatalf("append on closed tab = %v, want ErrTabClosed", err)
	}
	if _, err := f.svc.SetLabel(ctx, pa, "X"); !errors.Is(err, ErrTabClosed) {
		t.Fatalf("label on closed tab = %v, want ErrTabClosed", err)
	}
	again, err := f.svc.Close(ctx, pa)
	if err != nil || again.Tab.Rev != closed.Tab.Rev {
		t.Fatalf("second close: rev %d vs %d, err %v (must be idempotent)", again.Tab.Rev, closed.Tab.Rev, err)
	}
	if _, err := f.svc.Get(ctx, pb, 0); err != nil {
		t.Fatalf("read on closed tab: %v", err)
	}
}

// ==========================================================================
// Review rules
// ==========================================================================

func TestAcceptDisputeVoidRules(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	res := f.create(t, "Shop", "", "")
	pa := f.party(t, res.MyToken, res.Tab.ID)
	pb := f.party(t, res.InviteToken, res.Tab.ID)

	mine := f.append(t, pa, "a_to_b", "500", 1_756_000_000_000)

	if _, err := f.svc.Accept(ctx, pa, mine.Entry.ID); !errors.Is(err, ErrOwnEntry) {
		t.Fatalf("accept own entry = %v, want ErrOwnEntry", err)
	}
	if _, err := f.svc.Dispute(ctx, pa, mine.Entry.ID, "x"); !errors.Is(err, ErrOwnEntry) {
		t.Fatalf("dispute own entry = %v, want ErrOwnEntry", err)
	}
	if _, err := f.svc.Dispute(ctx, pb, mine.Entry.ID, "   "); !errors.Is(err, ErrReasonRequired) {
		t.Fatalf("dispute without reason = %v, want ErrReasonRequired", err)
	}
	if _, err := f.svc.Void(ctx, pb, mine.Entry.ID); !errors.Is(err, ErrNotAuthor) {
		t.Fatalf("void by the other party = %v, want ErrNotAuthor", err)
	}
	if _, err := f.svc.Accept(ctx, pb, uuid.NewString()); !errors.Is(err, ErrEntryNotFound) {
		t.Fatalf("accept unknown entry = %v, want ErrEntryNotFound", err)
	}
	if _, err := f.svc.Accept(ctx, pb, "not-a-uuid"); !errors.Is(err, ErrEntryNotFound) {
		t.Fatalf("accept malformed id = %v, want ErrEntryNotFound", err)
	}

	// Dispute, then accept: the dispute clears (reason back to NULL).
	if _, err := f.svc.Dispute(ctx, pb, mine.Entry.ID, "wrong amount"); err != nil {
		t.Fatalf("dispute: %v", err)
	}
	acc, err := f.svc.Accept(ctx, pb, mine.Entry.ID)
	if err != nil {
		t.Fatalf("accept after dispute: %v", err)
	}
	if acc.Entry.Status != "accepted" || acc.Entry.DisputeReason != nil {
		t.Fatalf("accept must clear the dispute: %+v", acc.Entry)
	}

	// Void once, then every further review or void of it is already_voided —
	// including acting on the void row itself.
	v, err := f.svc.Void(ctx, pa, mine.Entry.ID)
	if err != nil {
		t.Fatalf("void: %v", err)
	}
	for _, id := range []string{mine.Entry.ID, v.Void.ID} {
		if _, err := f.svc.Void(ctx, pa, id); !errors.Is(err, ErrAlreadyVoided) {
			t.Fatalf("re-void %s = %v, want ErrAlreadyVoided", id, err)
		}
		if _, err := f.svc.Accept(ctx, pb, id); !errors.Is(err, ErrAlreadyVoided) {
			t.Fatalf("accept voided %s = %v, want ErrAlreadyVoided", id, err)
		}
		if _, err := f.svc.Dispute(ctx, pb, id, "late"); !errors.Is(err, ErrAlreadyVoided) {
			t.Fatalf("dispute voided %s = %v, want ErrAlreadyVoided", id, err)
		}
	}
}

// ==========================================================================
// Uniform 404
// ==========================================================================

func TestUniformNotFound(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	one := f.create(t, "One", "", "")
	two := f.create(t, "Two", "", "")

	cases := map[string]func() error{
		"unknown token": func() error { _, err := f.svc.PartyByToken(ctx, "nope", ""); return err },
		"empty token":   func() error { _, err := f.svc.PartyByToken(ctx, "   ", ""); return err },
		"oversized token": func() error {
			_, err := f.svc.PartyByToken(ctx, string(make([]byte, maxTokenLen+1)), "")
			return err
		},
		"token for another tab": func() error { _, err := f.svc.PartyByToken(ctx, one.MyToken, two.Tab.ID); return err },
		"account not a party":   func() error { _, err := f.svc.PartyByAccount(ctx, one.Tab.ID, f.acctA); return err },
		"account, unknown tab":  func() error { _, err := f.svc.PartyByAccount(ctx, uuid.NewString(), f.acctA); return err },
		"account, malformed id": func() error { _, err := f.svc.PartyByAccount(ctx, "zzz", f.acctA); return err },
	}
	for name, fn := range cases {
		if err := fn(); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: err = %v, want ErrNotFound", name, err)
		}
	}
	// And nothing distinguishes them at the HTTP layer either.
	for name, fn := range cases {
		st, code, msg := mapServiceError(fn())
		if st != 404 || code != "tab_not_found" || msg != "tab not found" {
			t.Errorf("%s maps to (%d %s %q), want the uniform triple", name, st, code, msg)
		}
	}
}

// ==========================================================================
// Idempotent append
// ==========================================================================

func TestAppendIdempotency(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	res := f.create(t, "Shop", "", "")
	other := f.create(t, "Other", "", "")
	pa := f.party(t, res.MyToken, res.Tab.ID)
	pb := f.party(t, res.InviteToken, res.Tab.ID)
	po := f.party(t, other.MyToken, other.Tab.ID)

	in := AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "250", Note: str("cement"), OccurredAtMS: 1_756_000_000_000}
	first, err := f.svc.Append(ctx, pa, in)
	if err != nil || !first.Created {
		t.Fatalf("first append: %+v %v", first, err)
	}
	// Same id, same tab, same author → the existing row, not a new one, and
	// no rev bump.
	replay, err := f.svc.Append(ctx, pa, in)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if replay.Created || replay.Entry.ID != first.Entry.ID || replay.Entry.Seq != first.Entry.Seq || replay.Tab.Rev != first.Tab.Rev {
		t.Fatalf("replay = created:%v seq:%d rev:%d; want the original (seq %d, rev %d)",
			replay.Created, replay.Entry.Seq, replay.Tab.Rev, first.Entry.Seq, first.Tab.Rev)
	}
	// Same id from the OTHER party, or in ANOTHER tab → 409.
	if _, err := f.svc.Append(ctx, pb, in); !errors.Is(err, ErrIDTaken) {
		t.Fatalf("other party reusing id = %v, want ErrIDTaken", err)
	}
	if _, err := f.svc.Append(ctx, po, in); !errors.Is(err, ErrIDTaken) {
		t.Fatalf("other tab reusing id = %v, want ErrIDTaken", err)
	}
	// And the tab has exactly one row.
	got, err := f.svc.Get(ctx, pa, 0)
	if err != nil || len(got.Entries) != 1 {
		t.Fatalf("entries = %d, %v; want 1", len(got.Entries), err)
	}
}

// ==========================================================================
// seq + rev monotonic under concurrency
// ==========================================================================

func TestSeqRevMonotonicUnderConcurrentAppends(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	res := f.create(t, "Shop", "", "")
	pa := f.party(t, res.MyToken, res.Tab.ID)
	pb := f.party(t, res.InviteToken, res.Tab.ID)

	const perWriter = 20
	var wg sync.WaitGroup
	var mu sync.Mutex
	var seqs, revs []int64
	for _, p := range []Party{pa, pb} {
		wg.Add(1)
		go func(p Party) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				r, err := f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "1", OccurredAtMS: 1})
				if err != nil {
					t.Errorf("concurrent append: %v", err)
					return
				}
				mu.Lock()
				seqs = append(seqs, r.Entry.Seq)
				revs = append(revs, r.Entry.Rev)
				mu.Unlock()
			}
		}(p)
	}
	wg.Wait()

	check := func(name string, xs []int64) {
		sort.Slice(xs, func(i, j int) bool { return xs[i] < xs[j] })
		if len(xs) != 2*perWriter {
			t.Fatalf("%s: %d values, want %d", name, len(xs), 2*perWriter)
		}
		for i, x := range xs {
			if x != int64(i+1) {
				t.Fatalf("%s: got %v — must be exactly 1..%d with no gap or duplicate", name, xs, 2*perWriter)
			}
		}
	}
	check("seq", seqs)
	check("rev", revs)
	final, err := f.svc.Get(ctx, pa, 0)
	if err != nil || final.Tab.Rev != 2*perWriter {
		t.Fatalf("tabs.rev = %d, %v; want %d", final.Tab.Rev, err, 2*perWriter)
	}
}

// ==========================================================================
// Balance vectors shared with mobile (apps/_shared/tab-vectors.json)
// ==========================================================================

type tabVectorEntry struct {
	Direction string `json:"direction"`
	Amount    string `json:"amount"`
	Kind      string `json:"kind"`
	Voided    bool   `json:"voided"`
	Status    string `json:"status"`
}

type tabVectorCase struct {
	Name     string           `json:"name"`
	Role     string           `json:"role"`
	Entries  []tabVectorEntry `json:"entries"`
	Expected string           `json:"expected"`
}

// vectorsPath locates apps/_shared/tab-vectors.json from this package dir,
// the way sync/project_test.go finds the projection corpus.
func vectorsPath(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	// wd = .../apps/backend/internal/tabs → three levels up is apps/.
	return filepath.Join(wd, "..", "..", "..", "_shared", "tab-vectors.json")
}

// TestTabBalanceVectors runs the shared vectors through the REAL balance —
// the SQL inside loadTab — by seeding tab_entries rows directly (the void
// pairing a real Void would create is reproduced by hand) and reading the
// tab from the vector's role. The mobile suite (npm run selftest:tabs)
// asserts the same file; add a case to one and both pick it up.
func TestTabBalanceVectors(t *testing.T) {
	raw, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var file struct {
		Cases []tabVectorCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("no vector cases")
	}

	f := newTabFixture(t)
	ctx := context.Background()
	for _, tc := range file.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			res := f.create(t, "V", "", "")
			ids := make([]string, len(tc.Entries))
			for i, e := range tc.Entries {
				minor, err := parseAmountMinor(e.Amount)
				if err != nil {
					t.Fatalf("vector amount %q: %v", e.Amount, err)
				}
				ids[i] = uuid.NewString()
				if _, err := f.pool.Exec(ctx, `
					INSERT INTO tab_entries (id, tab_id, seq, rev, created_by, direction, amount_minor, kind, occurred_at_ms, status)
					VALUES ($1::uuid, $2::uuid, $3, $3, 'a', $4, $5, $6, 1, $7)
				`, ids[i], res.Tab.ID, i+1, e.Direction, minor, e.Kind, e.Status); err != nil {
					t.Fatalf("seed entry %d: %v", i, err)
				}
			}
			// Pair each voided original with an unused void row of the same
			// amount and opposite direction, as Service.Void would; a lone
			// voided flag points at itself (any non-NULL pointer excludes it).
			used := map[int]bool{}
			for i, e := range tc.Entries {
				if !e.Voided {
					continue
				}
				by := ids[i]
				for j, v := range tc.Entries {
					if !used[j] && v.Kind == "void" && v.Amount == e.Amount && v.Direction == opposite(e.Direction) {
						used[j] = true
						by = ids[j]
						if _, err := f.pool.Exec(ctx, `UPDATE tab_entries SET voids_entry_id = $1::uuid WHERE id = $2::uuid`, ids[i], ids[j]); err != nil {
							t.Fatalf("link void: %v", err)
						}
						break
					}
				}
				if _, err := f.pool.Exec(ctx, `UPDATE tab_entries SET voided_by_entry_id = $1::uuid WHERE id = $2::uuid`, by, ids[i]); err != nil {
					t.Fatalf("mark voided: %v", err)
				}
			}
			got, err := f.svc.Get(ctx, Party{TabID: res.Tab.ID, Role: tc.Role}, 0)
			if err != nil {
				t.Fatalf("Get: %v", err)
			}
			if got.Tab.Balance[tc.Role] != tc.Expected {
				t.Fatalf("balance[%s] = %q, want %q", tc.Role, got.Tab.Balance[tc.Role], tc.Expected)
			}
			// The other side is always the exact negation.
			otherBal, _ := parseSignedMinor(got.Tab.Balance[otherRole(tc.Role)])
			mine, _ := parseSignedMinor(got.Tab.Balance[tc.Role])
			if otherBal != -mine {
				t.Fatalf("balances not mirrored: %v", got.Tab.Balance)
			}
		})
	}
}

// ==========================================================================
// duplicate_hint (D17)
// ==========================================================================

func TestDuplicateHint(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	res := f.create(t, "Shop", "", "")
	pa := f.party(t, res.MyToken, res.Tab.ID)
	pb := f.party(t, res.InviteToken, res.Tab.ID)
	day := int64(24 * 60 * 60 * 1000)
	t0 := int64(1_756_000_000_000)

	// B pays A 500 cash. A records "I received 500" (b_to_a); B records
	// "I gave 500" (b_to_a) — the SAME absolute direction. That pair is the
	// double-log, and B must be warned about A's row.
	aRecv := f.append(t, pa, "b_to_a", "500", t0)
	if aRecv.DuplicateHint != nil {
		t.Fatalf("first row must not hint: %+v", aRecv.DuplicateHint)
	}
	bGave := f.append(t, pb, "b_to_a", "500", t0+6*60*60*1000)
	if bGave.DuplicateHint == nil || bGave.DuplicateHint.EntryID != aRecv.Entry.ID || bGave.DuplicateHint.By != "a" || bGave.DuplicateHint.AtMS != t0 {
		t.Fatalf("B's mirror entry hint = %+v, want A's row", bGave.DuplicateHint)
	}

	// Opposite absolute direction (A gave goods 700, B paid 700 back) is the
	// ordinary buy-then-pay pair: no hint.
	f.append(t, pa, "a_to_b", "700", t0)
	if r := f.append(t, pb, "b_to_a", "700", t0); r.DuplicateHint != nil {
		t.Fatalf("buy-then-pay must not hint: %+v", r.DuplicateHint)
	}

	// Same side twice is not a duplicate of the OTHER party.
	if r := f.append(t, pa, "a_to_b", "700", t0+1000); r.DuplicateHint != nil {
		t.Fatalf("own repeat must not hint: %+v", r.DuplicateHint)
	}

	// Outside ±24 h: no hint.
	f.append(t, pa, "a_to_b", "90", t0)
	if r := f.append(t, pb, "a_to_b", "90", t0+day+1); r.DuplicateHint != nil {
		t.Fatalf("outside the window must not hint: %+v", r.DuplicateHint)
	}
	// Exactly 24 h: still inside.
	if r := f.append(t, pb, "a_to_b", "90", t0+day); r.DuplicateHint == nil {
		t.Fatal("exactly 24 h must hint")
	}

	// A voided candidate is invisible.
	aOld := f.append(t, pa, "a_to_b", "60", t0)
	if _, err := f.svc.Void(ctx, pa, aOld.Entry.ID); err != nil {
		t.Fatalf("void: %v", err)
	}
	if r := f.append(t, pb, "a_to_b", "60", t0); r.DuplicateHint != nil {
		t.Fatalf("voided candidate must not hint: %+v", r.DuplicateHint)
	}
}

// ==========================================================================
// JWT parties: direct binding, membership role gate, same_kaata, mine
// ==========================================================================

func TestMembershipRoleGateAndBindings(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	clerk := seedAccount(t, f.pool, "clerk@example.com", "Clerk")
	seedMember(t, f.pool, f.vaultA, clerk, "clerk")
	viewer := seedAccount(t, f.pool, "viewer@example.com", "Viewer")
	seedMember(t, f.pool, f.vaultA, viewer, "viewer")
	editor := seedAccount(t, f.pool, "editor@example.com", "Editor")
	seedMember(t, f.pool, f.vaultA, editor, "editor")
	stranger := seedAccount(t, f.pool, "stranger@example.com", "Stranger")

	// Binding to a vault the caller is not a member of is refused — whether
	// anonymous or signed in as somebody else.
	if _, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "X", VaultID: &f.vaultA}); !errors.Is(err, ErrNotVaultMember) {
		t.Fatalf("anonymous create with vault_id = %v, want ErrNotVaultMember", err)
	}
	if _, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "X", VaultID: &f.vaultA, AccountID: &stranger}); !errors.Is(err, ErrNotVaultMember) {
		t.Fatalf("stranger create with vault_id = %v, want ErrNotVaultMember", err)
	}

	rel := uuid.NewString()
	res, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Saafi Store", VaultID: &f.vaultA, RelationshipID: &rel, AccountID: &f.acctA})
	if err != nil {
		t.Fatalf("create bound: %v", err)
	}
	if !res.Tab.Parties["a"].Bound {
		t.Fatal("party a must be bound when created with a session")
	}
	tabID := res.Tab.ID

	// The owner resolves directly (full rights) …
	pOwner, err := f.svc.PartyByAccount(ctx, tabID, f.acctA)
	if err != nil || pOwner.Role != "a" || pOwner.MemberRole != "" {
		t.Fatalf("owner party = %+v %v", pOwner, err)
	}
	// … members through the kaata, carrying their role.
	pClerk, err := f.svc.PartyByAccount(ctx, tabID, clerk)
	if err != nil || pClerk.Role != "a" || pClerk.MemberRole != "clerk" {
		t.Fatalf("clerk party = %+v %v", pClerk, err)
	}
	pViewer, _ := f.svc.PartyByAccount(ctx, tabID, viewer)
	pEditor, _ := f.svc.PartyByAccount(ctx, tabID, editor)
	if _, err := f.svc.PartyByAccount(ctx, tabID, stranger); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger = %v, want ErrNotFound", err)
	}

	// Clerk: append yes, review/void/close/label/regenerate no.
	clerkRow, err := f.svc.Append(ctx, pClerk, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "10", OccurredAtMS: 1})
	if err != nil {
		t.Fatalf("clerk append: %v", err)
	}
	pb := f.party(t, res.InviteToken, tabID)
	bRow := f.append(t, pb, "b_to_a", "5", 1)
	for name, fn := range map[string]func() error{
		"accept":     func() error { _, err := f.svc.Accept(ctx, pClerk, bRow.Entry.ID); return err },
		"dispute":    func() error { _, err := f.svc.Dispute(ctx, pClerk, bRow.Entry.ID, "no"); return err },
		"void":       func() error { _, err := f.svc.Void(ctx, pClerk, clerkRow.Entry.ID); return err },
		"close":      func() error { _, err := f.svc.Close(ctx, pClerk); return err },
		"label":      func() error { _, err := f.svc.SetLabel(ctx, pClerk, "Z"); return err },
		"regenerate": func() error { _, err := f.svc.RegenerateLink(ctx, pClerk); return err },
	} {
		if err := fn(); !errors.Is(err, ErrRoleInsufficient) {
			t.Errorf("clerk %s = %v, want ErrRoleInsufficient", name, err)
		}
	}
	// Viewer: read only.
	if _, err := f.svc.Get(ctx, pViewer, 0); err != nil {
		t.Fatalf("viewer read: %v", err)
	}
	if _, err := f.svc.Append(ctx, pViewer, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "1", OccurredAtMS: 1}); !errors.Is(err, ErrRoleInsufficient) {
		t.Fatalf("viewer append = %v, want ErrRoleInsufficient", err)
	}
	// Editor: may review.
	if _, err := f.svc.Accept(ctx, pEditor, bRow.Entry.ID); err != nil {
		t.Fatalf("editor accept: %v", err)
	}
	// Party B via token is unrestricted regardless of anything on A's side.
	if _, err := f.svc.Accept(ctx, pb, clerkRow.Entry.ID); err != nil {
		t.Fatalf("token party accept: %v", err)
	}

	// same_kaata: B may not join as A's own kaata; a kaata B is not in is
	// refused; B's own kaata binds and makes the tab recoverable via Mine.
	if _, err := f.svc.Join(ctx, pb, JoinInput{Label: "Ahmad", VaultID: &f.vaultA, AccountID: &f.acctA}); !errors.Is(err, ErrSameKaata) {
		t.Fatalf("join with A's vault = %v, want ErrSameKaata", err)
	}
	if _, err := f.svc.Join(ctx, pb, JoinInput{Label: "Ahmad", VaultID: &f.vaultB}); !errors.Is(err, ErrNotVaultMember) {
		t.Fatalf("anonymous join with a vault = %v, want ErrNotVaultMember", err)
	}
	relB := uuid.NewString()
	j, err := f.svc.Join(ctx, pb, JoinInput{Label: "Ahmad", VaultID: &f.vaultB, RelationshipID: &relB, AccountID: &f.acctB})
	if err != nil {
		t.Fatalf("join bound: %v", err)
	}
	if !j.Tab.Parties["b"].Bound {
		t.Fatalf("B must be bound after a signed-in join: %+v", j.Tab.Parties["b"])
	}
	mine, err := f.svc.Mine(ctx, f.acctB)
	if err != nil || len(mine.Tabs) != 1 || mine.Tabs[0].Role != "b" || mine.Tabs[0].VaultID == nil || *mine.Tabs[0].VaultID != f.vaultB ||
		mine.Tabs[0].RelationshipID == nil || *mine.Tabs[0].RelationshipID != relB || mine.Tabs[0].Tab.You != "b" {
		t.Fatalf("Mine(B) = %+v, %v", mine, err)
	}
	// The clerk of A's kaata sees it too (through membership), from A's side.
	mineClerk, err := f.svc.Mine(ctx, clerk)
	if err != nil || len(mineClerk.Tabs) != 1 || mineClerk.Tabs[0].Role != "a" {
		t.Fatalf("Mine(clerk) = %+v, %v", mineClerk, err)
	}
	if m, _ := f.svc.Mine(ctx, stranger); len(m.Tabs) != 0 {
		t.Fatalf("Mine(stranger) = %+v, want none", m)
	}

	// Bind: A's owner session re-binds with a relationship; a party bound by
	// membership only (the editor) is allowed to bind THEIR account.
	if _, err := f.svc.Bind(ctx, pEditor, BindInput{AccountID: editor}); err != nil {
		t.Fatalf("editor bind: %v", err)
	}
	pEditorNow, err := f.svc.PartyByAccount(ctx, tabID, editor)
	if err != nil || pEditorNow.MemberRole != "" {
		t.Fatalf("after bind the editor must resolve directly: %+v %v", pEditorNow, err)
	}
}

// ==========================================================================
// Regenerate link
// ==========================================================================

func TestRegenerateLink(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	res := f.create(t, "Shop", "", "")
	pa := f.party(t, res.MyToken, res.Tab.ID)
	pb := f.party(t, res.InviteToken, res.Tab.ID)

	if _, err := f.svc.RegenerateLink(ctx, pb); !errors.Is(err, ErrNotPartyA) {
		t.Fatalf("B regenerating = %v, want ErrNotPartyA", err)
	}
	fresh, err := f.svc.RegenerateLink(ctx, pa)
	if err != nil || fresh == "" || fresh == res.InviteToken {
		t.Fatalf("regenerate = %q, %v", fresh, err)
	}
	if _, err := f.svc.PartyByToken(ctx, res.InviteToken, res.Tab.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old invite token still resolves: %v", err)
	}
	if p, err := f.svc.PartyByToken(ctx, fresh, res.Tab.ID); err != nil || p.Role != "b" {
		t.Fatalf("new invite token = %+v, %v", p, err)
	}
	// A's own token is untouched.
	if _, err := f.svc.PartyByToken(ctx, res.MyToken, res.Tab.ID); err != nil {
		t.Fatalf("A's token must survive a regenerate: %v", err)
	}
}

// ==========================================================================
// Poke recipients + wire shape
// ==========================================================================

type recordingPoker struct {
	mu    sync.Mutex
	calls []struct {
		tabID string
		ids   []string
	}
}

func (r *recordingPoker) NotifyTab(tabID string, ids []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := append([]string(nil), ids...)
	sort.Strings(cp)
	r.calls = append(r.calls, struct {
		tabID string
		ids   []string
	}{tabID, cp})
}

func TestPokeRecipientsAfterCommit(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	clerk := seedAccount(t, f.pool, "clerk@example.com", "Clerk")
	seedMember(t, f.pool, f.vaultA, clerk, "clerk")
	poker := &recordingPoker{}
	f.svc.SetPoker(poker)

	res, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Shop", VaultID: &f.vaultA, AccountID: &f.acctA})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	pb := f.party(t, res.InviteToken, res.Tab.ID)
	if _, err := f.svc.Join(ctx, pb, JoinInput{Label: "Ahmad", AccountID: &f.acctB}); err != nil {
		t.Fatalf("join: %v", err)
	}
	f.append(t, pb, "b_to_a", "5", 1)

	want := []string{f.acctA, f.acctB, clerk}
	sort.Strings(want)
	poker.mu.Lock()
	defer poker.mu.Unlock()
	if len(poker.calls) != 3 { // create, join, append
		t.Fatalf("pokes = %d, want 3", len(poker.calls))
	}
	last := poker.calls[len(poker.calls)-1]
	if last.tabID != res.Tab.ID {
		t.Fatalf("poke tab = %s, want %s", last.tabID, res.Tab.ID)
	}
	if len(last.ids) != len(want) {
		t.Fatalf("recipients = %v, want %v (both parties + A's kaata members)", last.ids, want)
	}
	for i := range want {
		if last.ids[i] != want[i] {
			t.Fatalf("recipients = %v, want %v", last.ids, want)
		}
	}
}

// TestWireShape pins the JSON the mobile client parses (§3.4): field names,
// null vs absent, amounts as strings, timestamps in ms. Logged verbatim so
// `go test -v` prints a reference payload.
func TestWireShape(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	res, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Matee (Saafi Store)", AccountID: &f.acctA,
		Opening: &OpeningInput{Direction: "a_to_b", Amount: "3400", Note: str("Balance before linking"), OccurredAtMS: 1_756_000_000_000}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	pb := f.party(t, res.InviteToken, res.Tab.ID)
	if _, err := f.svc.Join(ctx, pb, JoinInput{Label: "Ahmad"}); err != nil {
		t.Fatalf("join: %v", err)
	}
	f.append(t, pb, "b_to_a", "1250.5", 1_756_100_000_000)
	pa := f.party(t, res.MyToken, res.Tab.ID)
	resp, err := f.svc.Get(ctx, pa, 0)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	raw, err := json.MarshalIndent(resp, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	t.Logf("TabResponse JSON:\n%s", raw)

	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("re-decode: %v", err)
	}
	tab := m["tab"].(map[string]any)
	for _, k := range []string{"id", "currency", "rev", "created_at_ms", "closed_at_ms", "closed_by", "you", "parties", "balance", "pending_for_you"} {
		if _, ok := tab[k]; !ok {
			t.Errorf("tab.%s missing", k)
		}
	}
	if tab["closed_at_ms"] != nil || tab["closed_by"] != nil || tab["you"] != "a" {
		t.Errorf("tab nulls/you wrong: %v", tab)
	}
	if bal := tab["balance"].(map[string]any); bal["a"] != "2149.5" || bal["b"] != "-2149.5" {
		t.Errorf("balance = %v", bal)
	}
	if tab["pending_for_you"].(float64) != 1 {
		t.Errorf("pending_for_you = %v", tab["pending_for_you"])
	}
	entries := m["entries"].([]any)
	if len(entries) != 2 || m["full"] != true {
		t.Fatalf("entries=%d full=%v", len(entries), m["full"])
	}
	e := entries[0].(map[string]any)
	for _, k := range []string{"id", "seq", "rev", "created_by", "direction", "amount", "kind", "note", "occurred_at_ms", "created_at_ms", "status", "status_at_ms", "dispute_reason", "voids_entry_id", "voided_by_entry_id"} {
		if _, ok := e[k]; !ok {
			t.Errorf("entry.%s missing", k)
		}
	}
	if _, isString := e["amount"].(string); !isString {
		t.Errorf("amount must be a string, got %T", e["amount"])
	}
	if e["status_at_ms"] != nil || e["dispute_reason"] != nil || e["voids_entry_id"] != nil || e["voided_by_entry_id"] != nil {
		t.Errorf("fresh entry must carry explicit nulls: %v", e)
	}
	if _, leaked := e["amountMinor"]; leaked {
		t.Error("internal amountMinor leaked onto the wire")
	}
	if entries[1].(map[string]any)["amount"] != "1250.5" {
		t.Errorf("amount rendering = %v", entries[1].(map[string]any)["amount"])
	}
	// Timestamps are epoch ms, not seconds.
	if ms := e["created_at_ms"].(float64); ms < 1e12 || ms > float64(time.Now().UnixMilli()+1000) {
		t.Errorf("created_at_ms = %v is not epoch ms", ms)
	}
}
