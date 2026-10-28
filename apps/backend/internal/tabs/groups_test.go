package tabs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/credit"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func groupInput(t *testing.T, f *tabFixture, mode string) GroupCreateInput {
	t.Helper()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	f.svc.SetGroupCurrencyHistoryReader(syncapi.HasCurrencyHistory)
	f.svc.SetGroupSourceLatestRecordedAtReader(syncapi.GroupSourceLatestRecordedAt)
	f.svc.SetGroupSourceCurrenciesReader(syncapi.GroupSourceCurrencies)
	token, err := newPartyToken()
	if err != nil {
		t.Fatal(err)
	}
	in := GroupCreateInput{RequestID: uuid.NewString(), InviteToken: token, RecordingMode: mode, Label: "A group", VaultID: f.vaultA, RelationshipID: uuid.NewString(), AccountID: f.acctA, Currencies: []GroupCurrencyInput{{Currency: "AFN", Opening: &OpeningInput{Direction: "a_to_b", Amount: "100", OccurredAtMS: 100}}, {Currency: "USD", Opening: &OpeningInput{Direction: "b_to_a", Amount: "12.34", OccurredAtMS: 100}}}}
	seedGroupPrivateAt(t, f, f.vaultA, f.acctA, in.RelationshipID, "AFN", "debt", "100", 1)
	seedGroupPrivateAt(t, f, f.vaultA, f.acctA, in.RelationshipID, "USD", "payment", "12.34", 2)
	return in
}
func joinGroupInput(f *tabFixture, in GroupCreateInput) GroupJoinInput {
	return GroupJoinInput{Token: in.InviteToken, Label: "B group", VaultID: f.vaultB, RelationshipID: uuid.NewString(), AccountID: f.acctB, Currencies: []GroupCurrencyInput{{Currency: "AFN"}, {Currency: "USD"}}}
}
func countGroups(t *testing.T, f *tabFixture, wantGroups, wantTabs int) {
	t.Helper()
	for table, want := range map[string]int{"tab_groups": wantGroups, "tabs": wantTabs} {
		var n int
		if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM `+table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != want {
			t.Fatalf("%s count %d want %d", table, n, want)
		}
	}
}

func TestSharedGroupModesKeepIndependentFinancialLegs(t *testing.T) {
	for _, mode := range []string{"review", "notify", "notify_one_way"} {
		t.Run(mode, func(t *testing.T) {
			f := newTabFixture(t)
			in := groupInput(t, f, mode)
			created, err := f.svc.CreateGroup(t.Context(), in)
			if err != nil {
				t.Fatal(err)
			}
			if len(created.Tabs) != 2 || created.Group.You != "a" {
				t.Fatalf("bad group %+v", created.Group)
			}
			for _, v := range created.Tabs {
				if v.Tab.GroupID == nil || *v.Tab.GroupID != created.Group.ID || v.Tab.RecordingMode != mode || len(v.Entries) != 1 || v.Entries[0].Status != "pending" {
					t.Fatalf("bad initial leg %+v", v)
				}
			}
			preview, err := f.svc.PreviewGroup(t.Context(), in.InviteToken, f.acctB)
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(preview)
			if len(preview.Tabs) != 0 || bytes.Contains(encoded, []byte(`"amount"`)) || bytes.Contains(encoded, []byte(`"balance"`)) {
				t.Fatalf("unjoined invitation leaked money: %s", encoded)
			}
			if preview.Group.Parties["a"].VaultID != nil || preview.Group.Parties["a"].Phone != "" {
				t.Fatal("preview leaked identity bindings")
			}
			if _, err = f.svc.GetGroup(t.Context(), in.RequestID, f.acctB, ""); !errors.Is(err, ErrNotFound) {
				t.Fatalf("unjoined read: %v", err)
			}
			join := joinGroupInput(f, in)
			joined, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
			if err != nil {
				t.Fatal(err)
			}
			if joined.Group.You != "b" || joined.Group.Parties["b"].JoinedAtMS == nil {
				t.Fatal("one join did not join group")
			}
			for _, v := range joined.Tabs {
				want := "pending"
				if mode != "review" {
					want = "recorded"
				}
				if v.Entries[0].Status != want {
					t.Fatalf("opening %s want%s", v.Entries[0].Status, want)
				}
				if v.Tab.Currency == "AFN" && v.Tab.Balance["a"] != "100" {
					t.Fatal("AFN mixed")
				}
				if v.Tab.Currency == "USD" && v.Tab.Balance["a"] != "-12.34" {
					t.Fatal("USD mixed")
				}
			}
			again, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
			if err != nil {
				t.Fatal(err)
			}
			if again.Group.Rev != joined.Group.Rev {
				t.Fatal("join retry was not idempotent")
			}
			for _, v := range joined.Tabs {
				p, err := f.svc.PartyByAccount(t.Context(), v.Tab.ID, f.acctB)
				if err != nil {
					t.Fatal(err)
				}
				_, err = f.svc.Append(t.Context(), p, AppendInput{ID: uuid.NewString(), Direction: "b_to_a", Amount: "1", OccurredAtMS: 200})
				if mode == "notify_one_way" {
					if !errors.Is(err, ErrOneWayReadOnly) {
						t.Fatalf("recipient wrote one-way: %v", err)
					}
				} else if err != nil {
					t.Fatal(err)
				}
			}
			mine, err := f.svc.Mine(t.Context(), f.acctB)
			if err != nil || len(mine.Groups) != 1 || len(mine.Tabs) != 2 {
				t.Fatalf("group recovery: %+v %v", mine, err)
			}
		})
	}
}
func TestSharedGroupCreateRetryAndAtomicFailure(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	bad := in
	bad.Currencies = append([]GroupCurrencyInput(nil), in.Currencies...)
	bad.Currencies[1].Opening = &OpeningInput{Direction: "a_to_b", Amount: "0", OccurredAtMS: 100}
	if _, err := f.svc.CreateGroup(t.Context(), bad); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("bad second leg: %v", err)
	}
	countGroups(t, f, 0, 0)
	first, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	countGroups(t, f, 1, 2)
	if first.Tabs[0].Tab.ID != again.Tabs[0].Tab.ID || first.Tabs[0].Entries[0].ID != again.Tabs[0].Entries[0].ID {
		t.Fatal("retry copied openings")
	}
	in.Label = "changed"
	if _, err = f.svc.CreateGroup(t.Context(), in); !errors.Is(err, ErrGroupChanged) {
		t.Fatalf("changed replay: %v", err)
	}
	countGroups(t, f, 1, 2)
}
func TestSharedGroupJoinFailureRollsBackEveryCurrency(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	rel := uuid.NewString()
	legacy, err := f.svc.Create(t.Context(), CreateInput{Currency: "USD", Label: "older", AccountID: &f.acctB, VaultID: &f.vaultB, RelationshipID: &rel})
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.svc.PartyByAccount(t.Context(), legacy.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Close(t.Context(), p); err != nil {
		t.Fatal(err)
	}
	join := joinGroupInput(f, in)
	join.RelationshipID = rel
	if _, err = f.svc.JoinGroup(t.Context(), created.Group.ID, join); !errors.Is(err, ErrSharedHistoryChanged) {
		t.Fatalf("missing second receipt: %v", err)
	}
	current, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "")
	if err != nil {
		t.Fatal(err)
	}
	if current.Group.Parties["b"].JoinedAtMS != nil {
		t.Fatal("failed join claimed group")
	}
	for _, v := range current.Tabs {
		if v.Tab.Parties["b"].JoinedAtMS != nil || v.Entries[0].Status != "pending" {
			t.Fatal("partial leg commit")
		}
	}
}
func TestSharedGroupConcurrentClaimsChooseOneRecipient(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	c := seedAccount(t, f.pool, "c-group@example.test", "C")
	vc := seedVault(t, f.pool, c, "C book")
	first := joinGroupInput(f, in)
	second := first
	second.AccountID = c
	second.VaultID = vc
	second.RelationshipID = uuid.NewString()
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, v := range []GroupJoinInput{first, second} {
		wg.Add(1)
		go func(v GroupJoinInput) {
			defer wg.Done()
			_, err := f.svc.JoinGroup(context.Background(), created.Group.ID, v)
			results <- err
		}(v)
	}
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else if !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
	}
	if successes != 1 {
		t.Fatalf("claims succeeded %d", successes)
	}
	current, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range current.Tabs {
		if v.Tab.Parties["b"].JoinedAtMS == nil {
			t.Fatal("half joined")
		}
	}
}
func TestSharedGroupCloseWithdrawsOnlyUnusedOpenings(t *testing.T) {
	for _, joined := range []bool{false, true} {
		t.Run(map[bool]string{false: "unused", true: "joined"}[joined], func(t *testing.T) {
			f := newTabFixture(t)
			in := groupInput(t, f, "notify")
			created, err := f.svc.CreateGroup(t.Context(), in)
			if err != nil {
				t.Fatal(err)
			}
			if joined {
				if _, err = f.svc.JoinGroup(t.Context(), created.Group.ID, joinGroupInput(f, in)); err != nil {
					t.Fatal(err)
				}
			}
			closed, err := f.svc.CloseGroup(t.Context(), created.Group.ID, f.acctA, "a", true)
			if err != nil {
				t.Fatal(err)
			}
			if closed.Group.ClosedAtMS == nil {
				t.Fatal("group stays open")
			}
			for _, v := range closed.Tabs {
				if v.Tab.ClosedAtMS == nil {
					t.Fatal("partial close")
				}
				if joined && v.Entries[0].VoidedByEntryID != nil {
					t.Fatal("joined record withdrawn")
				}
				if !joined && v.Entries[0].VoidedByEntryID == nil {
					t.Fatal("unused opening retained")
				}
			}
			preview, err := f.svc.PreviewGroup(t.Context(), in.InviteToken, f.acctB)
			if joined {
				if err != nil || preview.Group.ClosedAtMS == nil {
					t.Fatalf("authorized recipient lost closed records: %v", err)
				}
			} else if !errors.Is(err, ErrTabClosed) && !errors.Is(err, ErrNotFound) {
				t.Fatalf("closed unused invite %v", err)
			}
		})
	}
}
func TestSharedGroupFreshCurrencyNeedsNoSourceHistory(t *testing.T) {
	for _, mode := range []string{"review", "notify", "notify_one_way"} {
		t.Run(mode, func(t *testing.T) {
			f := newTabFixture(t)
			f.svc.SetGroupCurrencyHistoryReader(func(context.Context, pgx.Tx, string, string, string) (bool, error) { return false, nil })
			in := groupInput(t, f, mode)
			created, err := f.svc.CreateGroup(t.Context(), in)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.svc.JoinGroup(t.Context(), created.Group.ID, joinGroupInput(f, in)); err != nil {
				t.Fatal(err)
			}
			if mode == "notify_one_way" {
				if _, err = f.svc.EnsureGroupCurrency(t.Context(), created.Group.ID, f.acctB, "b", GroupCurrencyInput{Currency: "EUR"}); !errors.Is(err, ErrOneWayReadOnly) {
					t.Fatalf("oneway activation: %v", err)
				}
			}
			out, err := f.svc.EnsureGroupCurrency(t.Context(), created.Group.ID, f.acctA, "a", GroupCurrencyInput{Currency: "EUR"})
			if err != nil {
				t.Fatal(err)
			}
			if len(out.Tabs) != 3 {
				t.Fatal("new currency missing")
			}
			for _, v := range out.Tabs {
				if v.Tab.Currency == "EUR" && (len(v.Entries) != 0 || v.Tab.Parties["b"].JoinedAtMS == nil) {
					t.Fatal("new zero currency fabricated money or awaits join")
				}
			}
			out, err = f.svc.EnsureGroupCurrency(t.Context(), created.Group.ID, f.acctA, "a", GroupCurrencyInput{Currency: "EUR"})
			if err != nil || len(out.Tabs) != 3 {
				t.Fatalf("activation not idempotent %v", err)
			}
			f.svc.SetGroupCurrencyHistoryReader(func(context.Context, pgx.Tx, string, string, string) (bool, error) { return true, nil })
			if _, err = f.svc.EnsureGroupCurrency(t.Context(), created.Group.ID, f.acctA, "a", GroupCurrencyInput{Currency: "GBP"}); !errors.Is(err, ErrGroupCurrencyHistory) {
				t.Fatalf("history absorbed: %v", err)
			}
			countGroups(t, f, 1, 3)
		})
	}
}
func groupHTTP(t *testing.T, f *httpFixture, method, path, account string, body any, capability bool) httpResult {
	t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, err := http.NewRequest(method, f.server.URL+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if account != "" {
		req.Header.Set("Authorization", "Bearer "+f.jwtFor(t, account))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kaata-Currencies", "1")
	req.Header.Set("X-Kaata-Tab-Recording", "1")
	req.Header.Set("X-Kaata-Tab-One-Way", "1")
	if capability {
		req.Header.Set("X-Kaata-Tab-Group", "1")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return httpResult{status: res.StatusCode, header: res.Header, body: data}
}
func TestSharedGroupHTTPPrivacyAndCompatibility(t *testing.T) {
	f := newHTTPFixture(t)
	in := groupInput(t, f.tabFixture, "notify")
	created := groupHTTP(t, f, "POST", "/v1/tab-groups", f.acctA, in, true)
	if created.status != 201 {
		t.Fatalf("create %d %s", created.status, created.body)
	}
	var group GroupResponse
	if err := json.Unmarshal(created.body, &group); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(group.InviteURL, "/t/g_") {
		t.Fatal("group invite discriminator missing")
	}
	for _, capability := range []bool{false, true} {
		unknown := groupHTTP(t, f, "GET", "/v1/tab-groups/"+group.Group.ID, f.acctB, nil, capability)
		if unknown.status != 404 {
			t.Fatalf("unauthorized group leaked: %d", unknown.status)
		}
		mine := groupHTTP(t, f, "GET", "/v1/tabs/mine", f.acctA, nil, capability)
		want := 200
		if !capability {
			want = 426
		}
		if mine.status != want {
			t.Fatalf("mine %d %s", mine.status, mine.body)
		}
		leg := groupHTTP(t, f, "GET", "/v1/tabs/"+group.Tabs[0].Tab.ID, f.acctA, nil, capability)
		if leg.status != want {
			t.Fatalf("leg %d %s", leg.status, leg.body)
		}
	}
	preview := groupHTTP(t, f, "POST", "/v1/tab-groups/by-token", f.acctB, map[string]string{"token": "g_" + in.InviteToken}, true)
	if preview.status != 200 || bytes.Contains(preview.body, []byte(`"amount"`)) || bytes.Contains(preview.body, []byte(`"balance"`)) {
		t.Fatalf("preview %d %s", preview.status, preview.body)
	}
	anonymous := groupHTTP(t, f, "POST", "/v1/tab-groups/by-token", "", map[string]string{"token": in.InviteToken}, true)
	if anonymous.status != 401 {
		t.Fatalf("anonymous preview %d", anonymous.status)
	}
	partial := groupHTTP(t, f, "POST", "/v1/tabs/"+group.Tabs[0].Tab.ID+"/close", f.acctA, map[string]bool{}, true)
	if partial.status != 409 {
		t.Fatalf("partial close %d %s", partial.status, partial.body)
	}
	old := groupHTTP(t, f, "POST", "/v1/tabs/by-token", f.acctB, map[string]string{"token": "g_" + in.InviteToken}, false)
	if old.status != 426 {
		t.Fatalf("legacy group token %d %s", old.status, old.body)
	}
	res, err := http.Get(f.server.URL + "/t/g_" + in.InviteToken)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || bytes.Contains(body, []byte("12.34")) || bytes.Contains(body, []byte("100 AFN")) || bytes.Contains(body, []byte("A group")) {
		t.Fatalf("public invitation discloses record: %d", res.StatusCode)
	}
	regen, token, err := f.svc.RegenerateGroup(t.Context(), group.Group.ID, f.acctA, "a")
	if err != nil || regen.Group.ID != group.Group.ID {
		t.Fatal(err)
	}
	if _, err = f.svc.PreviewGroup(t.Context(), in.InviteToken, f.acctB); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rotated invite active: %v", err)
	}
	if _, err = f.svc.PreviewGroup(t.Context(), token, f.acctB); err != nil {
		t.Fatal(err)
	}
}

func TestSharedGroupCreditFailureRollsBackEarlierJoinLeg(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "review")
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	editor := seedAccount(t, f.pool, "group-editor@example.test", "Editor")
	seedMember(t, f.pool, f.vaultB, editor, "editor")
	join := joinGroupInput(f, in)
	join.AccountID = editor
	for _, code := range []string{"AFN", "USD"} {
		if _, err := f.pool.Exec(t.Context(), `INSERT INTO customer_credit_limits(vault_id,relationship_id,currency,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms)VALUES($1::uuid,$2::uuid,$3,500,20000,'clerk_block',true,1)`, f.vaultB, join.RelationshipID, code); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("second currency credit admission: %v", err)
	}
	var bound int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM tab_parties p JOIN tabs t ON t.id=p.tab_id WHERE t.group_id=$1::uuid AND p.role='b' AND p.vault_id IS NOT NULL`, created.Group.ID).Scan(&bound); err != nil || bound != 0 {
		t.Fatalf("partial recipient credit cutover: %d %v", bound, err)
	}
	countGroups(t, f, 1, 2)
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='viewer' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultB, editor); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join); !errors.Is(err, ErrRoleInsufficient) {
		t.Fatalf("viewer linked group: %v", err)
	}
	countGroups(t, f, 1, 2)
}
func TestSharedGroupJoinRevalidatesAllOpeningSources(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	rel := in.RelationshipID
	old, err := f.svc.Create(t.Context(), CreateInput{Currency: "AFN", RecordingMode: "notify", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel})
	if err != nil {
		t.Fatal(err)
	}
	invited, err := f.svc.PartyByToken(t.Context(), old.InviteToken, old.Tab.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Join(t.Context(), invited, JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	pa, err := f.svc.PartyByAccount(t.Context(), old.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := f.svc.Append(t.Context(), pa, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "40", OccurredAtMS: 100})
	if err != nil {
		t.Fatal(err)
	}
	closed, err := f.svc.Close(t.Context(), pa)
	if err != nil {
		t.Fatal(err)
	}
	in.Currencies[0].ExpectedPreviousTabID = &old.Tab.ID
	in.Currencies[0].ExpectedPreviousRev = &closed.Tab.Rev
	in.Currencies[0].ExpectedHistoryRevisions = map[string]int64{old.Tab.ID: closed.Tab.Rev}
	in.Currencies[0].Opening.Amount = "40"
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Void(t.Context(), pa, entry.Entry.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.JoinGroup(t.Context(), created.Group.ID, joinGroupInput(f, in)); !errors.Is(err, ErrOpeningSourceChanged) {
		t.Fatalf("stale source joined: %v", err)
	}
	out, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range out.Tabs {
		if v.Tab.Parties["b"].JoinedAtMS != nil || v.Entries[0].Status != "pending" {
			t.Fatal("source refusal partially joined")
		}
	}
}

func seedGroupPrivateEntry(t *testing.T, f *tabFixture, rel, code, kind, amount string, seq int64) string {
	return seedGroupPrivateAt(t, f, f.vaultB, f.acctB, rel, code, kind, amount, seq)
}
func seedGroupPrivateAt(t *testing.T, f *tabFixture, vault, account, rel, code, kind, amount string, seq int64) string {
	t.Helper()
	entry, device, event := uuid.NewString(), uuid.NewString(), uuid.NewString()
	payload, _ := json.Marshal(map[string]any{"entry_id": entry, "relationship_id": rel, "currency": code, "type": kind, "amount_afn": json.Number(amount), "occurred_at_ms": 100, "recorded_at_ms": 100, "note": "original private source"})
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,account_id,target_id,relationship_id,event_type,payload,server_seq)VALUES($1::uuid,$2::uuid,100,0,$3::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'entry_created',$7::jsonb,$8)`, event, vault, device, account, entry, rel, payload, seq); err != nil {
		t.Fatal(err)
	}
	return event
}
func TestSharedGroupJoinPreservesRecipientPrivateSources(t *testing.T) {
	for _, tc := range []struct {
		mode, usd string
		ok        bool
	}{{"notify", "12.34", true}, {"notify_one_way", "12.34", true}, {"notify", "50", false}, {"review", "12.34", false}} {
		t.Run(tc.mode+tc.usd, func(t *testing.T) {
			f := newTabFixture(t)
			in := groupInput(t, f, tc.mode)
			created, err := f.svc.CreateGroup(t.Context(), in)
			if err != nil {
				t.Fatal(err)
			}
			join := joinGroupInput(f, in)
			afnID := seedGroupPrivateEntry(t, f, join.RelationshipID, "AFN", "payment", "100", 1)
			usdID := seedGroupPrivateEntry(t, f, join.RelationshipID, "USD", "debt", tc.usd, 2)
			before := map[string]string{}
			for _, id := range []string{afnID, usdID} {
				var payload string
				if err = f.pool.QueryRow(t.Context(), `SELECT payload::text FROM events WHERE event_id=$1::uuid`, id).Scan(&payload); err != nil {
					t.Fatal(err)
				}
				before[id] = payload
			}
			joined, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
			if tc.ok {
				if err != nil {
					t.Fatal(err)
				}
				for _, v := range joined.Tabs {
					if v.Tab.Parties["b"].JoinedAtMS == nil {
						t.Fatal("matching source did not join")
					}
				}
			} else {
				if !errors.Is(err, ErrGroupCurrencyHistory) {
					t.Fatalf("incompatible source joined: %v", err)
				}
				out, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "")
				if err != nil {
					t.Fatal(err)
				}
				for _, v := range out.Tabs {
					if v.Tab.Parties["b"].JoinedAtMS != nil || v.Entries[0].Status != "pending" {
						t.Fatal("recipient source check partially joined")
					}
				}
			}
			for id, payload := range before {
				var after string
				if err = f.pool.QueryRow(t.Context(), `SELECT payload::text FROM events WHERE event_id=$1::uuid`, id).Scan(&after); err != nil || after != payload {
					t.Fatalf("original source changed: %v", err)
				}
			}
		})
	}
}
func TestSharedGroupResponsesPreserveExactPerLegCutovers(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	a1, a2 := int64(1000), int64(1100)
	in.Currencies[0].LinkedAtMS = &a1
	in.Currencies[1].LinkedAtMS = &a2
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	check := func(out GroupResponse, role string, first, second int64) {
		t.Helper()
		for i, want := range []int64{first, second} {
			if got := out.Tabs[i].Tab.Parties[role].LinkedAtMS; got == nil || *got != want {
				t.Fatalf("%s/%s cutover=%v want%d", role, out.Tabs[i].Tab.Currency, got, want)
			}
		}
	}
	check(created, "a", a1, a2)
	again, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	check(again, "a", a1, a2)
	join := joinGroupInput(f, in)
	b1, b2 := int64(2000), int64(2100)
	join.Currencies[0].LinkedAtMS = &b1
	join.Currencies[1].LinkedAtMS = &b2
	joined, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
	if err != nil {
		t.Fatal(err)
	}
	check(joined, "a", a1, a2)
	check(joined, "b", b1, b2)
	changed := int64(9999)
	join.Currencies[0].LinkedAtMS = &changed
	retried, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
	if err != nil {
		t.Fatal(err)
	}
	check(retried, "b", b1, b2)
}

func TestSharedGroupCreateRejectsChangedPrivateSourceOrMissingCurrency(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	seedGroupPrivateAt(t, f, f.vaultA, f.acctA, in.RelationshipID, "AFN", "debt", "50", 3)
	if _, err := f.svc.CreateGroup(t.Context(), in); !errors.Is(err, ErrGroupChanged) {
		t.Fatalf("stale private opening created: %v", err)
	}
	countGroups(t, f, 0, 0)
	in.Currencies[0].Opening.Amount = "150"
	seedGroupPrivateAt(t, f, f.vaultA, f.acctA, in.RelationshipID, "EUR", "debt", "1", 4)
	if _, err := f.svc.CreateGroup(t.Context(), in); !errors.Is(err, ErrGroupChanged) {
		t.Fatalf("new private currency omitted: %v", err)
	}
	countGroups(t, f, 0, 0)
	var n int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, f.vaultA).Scan(&n); err != nil || n != 4 {
		t.Fatalf("source journal changed %d %v", n, err)
	}
}
func TestSharedGroupCreateRejectsCutoverBeforeSourceRecordingTime(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	cutover := int64(99)
	in.Currencies[0].LinkedAtMS = &cutover
	if _, err := f.svc.CreateGroup(t.Context(), in); !errors.Is(err, ErrGroupChanged) {
		t.Fatalf("source after cutover accepted: %v", err)
	}
	countGroups(t, f, 0, 0)
	cutover = 100
	if _, err := f.svc.CreateGroup(t.Context(), in); err != nil {
		t.Fatalf("equal recording boundary rejected: %v", err)
	}
}

func TestSharedGroupFutureCutoversClampToServerTimeAndReplay(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	future := time.Now().Add(time.Hour).UnixMilli()
	for i := range in.Currencies {
		in.Currencies[i].LinkedAtMS = &future
	}
	before := time.Now().Add(-time.Minute).UnixMilli()
	created, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	check := func(out GroupResponse, role string) {
		t.Helper()
		for _, leg := range out.Tabs {
			bound := leg.Tab.Parties[role].LinkedAtMS
			if bound == nil || *bound < before || *bound > time.Now().UnixMilli() {
				t.Fatalf("future %s/%s boundary retained: %v", role, leg.Tab.Currency, bound)
			}
		}
	}
	check(created, "a")
	again, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	for i := range created.Tabs {
		if *created.Tabs[i].Tab.Parties["a"].LinkedAtMS != *again.Tabs[i].Tab.Parties["a"].LinkedAtMS {
			t.Fatal("create replay changed clamped boundary")
		}
	}
	join := joinGroupInput(f, in)
	for i := range join.Currencies {
		join.Currencies[i].LinkedAtMS = &future
	}
	joined, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join)
	if err != nil {
		t.Fatal(err)
	}
	check(joined, "b")
	ensured, err := f.svc.EnsureGroupCurrency(t.Context(), created.Group.ID, f.acctB, "b", GroupCurrencyInput{Currency: "EUR", LinkedAtMS: &future})
	if err != nil {
		t.Fatal(err)
	}
	check(ensured, "a")
	check(ensured, "b")
}

func TestSharedGroupLegacyInvitationCannotSplitGroupedContact(t *testing.T) {
	f := newTabFixture(t)
	in := groupInput(t, f, "notify")
	group, err := f.svc.CreateGroup(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	otherRel := uuid.NewString()
	legacy, err := f.svc.Create(t.Context(), CreateInput{Currency: "EUR", RecordingMode: "notify", Label: "Other creator", AccountID: &f.acctB, VaultID: &f.vaultB, RelationshipID: &otherRel})
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.svc.PartyByToken(t.Context(), legacy.InviteToken, legacy.Tab.ID)
	if err != nil {
		t.Fatal(err)
	}
	p.ActorAccountID = f.acctA
	join := JoinInput{Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &in.RelationshipID}
	if _, err = f.svc.Join(t.Context(), p, join); !errors.Is(err, ErrGroupOperation) {
		t.Fatalf("legacy Join split grouped contact: %v", err)
	}
	if _, err = f.svc.Bind(t.Context(), p, BindInput{AccountID: f.acctA, VaultID: &f.vaultA, RelationshipID: &in.RelationshipID}); !errors.Is(err, ErrGroupOperation) {
		t.Fatalf("legacy Bind split grouped contact: %v", err)
	}
	var bound bool
	if err = f.pool.QueryRow(t.Context(), `SELECT vault_id IS NOT NULL FROM tab_parties WHERE tab_id=$1::uuid AND role='b'`, legacy.Tab.ID).Scan(&bound); err != nil || bound {
		t.Fatalf("refused legacy binding mutated recipient: %v %v", bound, err)
	}
	if _, err = f.svc.CloseGroup(t.Context(), group.Group.ID, f.acctA, "a", true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Join(t.Context(), p, join); err != nil {
		t.Fatalf("closed group blocked unrelated future legacy link: %v", err)
	}
}
