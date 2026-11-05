package tabs

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func TestWebLedgerSharedGroupsKeepPrivateHistoryAndExactBalances(t *testing.T) {
	f := newTabFixture(t)
	input := groupInput(t, f, "notify")
	created, err := f.svc.CreateGroup(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	user, device := uuid.NewString(), uuid.NewString()
	payload, _ := json.Marshal(map[string]any{"user_id": user, "name": "Shared customer"})
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,account_id,target_id,relationship_id,event_type,payload,server_seq)
		VALUES($1::uuid,$2::uuid,200,0,$3::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'person_added',$7::jsonb,3)`, uuid.NewString(), f.vaultA, device, f.acctA, user, input.RelationshipID, payload); err != nil {
		t.Fatal(err)
	}
	service := syncapi.NewService(f.pool)
	check := func(afn, usd string, writable bool) {
		t.Helper()
		got, err := service.WebLedger(t.Context(), f.acctA, uuid.NewString(), f.vaultA)
		if err != nil {
			t.Fatal(err)
		}
		if got.IncompletePeople != 0 || len(got.People) != 1 || len(got.Entries) != 0 || len(got.SharedPrivateEntries) < 2 || got.People[0].Shared == nil {
			t.Fatalf("incomplete ledger %+v", got)
		}
		shared := got.People[0].Shared
		if len(shared.Tabs) != 2 || len(shared.Balances) != 2 || shared.PrivateWritable != writable {
			t.Fatalf("shared metadata %+v", shared)
		}
		for _, balance := range shared.Balances {
			want := afn
			if balance.Currency == "USD" {
				want = usd
			}
			if balance.Recorded != want || balance.Pending != "0.00" {
				t.Fatalf("balance %+v want %s", balance, want)
			}
		}
		for _, entry := range got.SharedPrivateEntries {
			if !entry.ReadOnly && entry.RecordedAtMS <= *created.Tabs[0].Tab.Parties["a"].LinkedAtMS {
				t.Fatal("absorbed private history became editable")
			}
		}
	}
	check("100.00", "-12.34", false)
	join := joinGroupInput(f, input)
	if _, err := f.svc.JoinGroup(t.Context(), created.Group.ID, join); err != nil {
		t.Fatal(err)
	}
	check("100.00", "-12.34", false)
	var usd string
	for _, leg := range created.Tabs {
		if leg.Tab.Currency == "USD" {
			usd = leg.Tab.ID
		}
	}
	party, err := f.svc.PartyByAccount(t.Context(), usd, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	read, err := f.svc.Get(t.Context(), party, 0)
	if err != nil || read.Tab.Access == nil || !read.Tab.Access.Append || read.Tab.Access.Review {
		t.Fatalf("caller GET access %+v error=%v", read.Tab.Access, err)
	}
	group, err := f.svc.GetGroup(t.Context(), created.Group.ID, f.acctA, "a")
	if err != nil || group.Tabs[0].Tab.Access == nil || !group.Tabs[0].Tab.Access.Append {
		t.Fatalf("group GET access missing error=%v", err)
	}
	if _, err := f.svc.Append(t.Context(), party, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "0.01", OccurredAtMS: 300}); err != nil {
		t.Fatal(err)
	}
	check("100.00", "-12.33", false)
	if _, err := f.svc.CloseGroup(t.Context(), created.Group.ID, f.acctA, "a", false); err != nil {
		t.Fatal(err)
	}
	check("100.00", "-12.33", true)
	late := seedGroupPrivateAt(t, f, f.vaultA, f.acctA, input.RelationshipID, "AFN", "debt", "7", 4)
	if _, err := f.pool.Exec(t.Context(), `UPDATE events SET payload=jsonb_set(payload,'{recorded_at_ms}',to_jsonb($2::bigint)) WHERE event_id=$1::uuid`, late, created.Tabs[0].Tab.Parties["a"].LinkedAtMS); err != nil {
		t.Fatal(err)
	}
	// Move the private record strictly after the link, even though its business
	// date is old. The recorded cutover controls whether it is carried twice.
	if _, err := f.pool.Exec(t.Context(), `UPDATE events SET payload=jsonb_set(payload,'{recorded_at_ms}',to_jsonb((payload->>'recorded_at_ms')::bigint+1)) WHERE event_id=$1::uuid`, late); err != nil {
		t.Fatal(err)
	}
	check("107.00", "-12.33", true)
	view, err := service.WebLedger(t.Context(), f.acctA, uuid.NewString(), f.vaultA)
	if err != nil {
		t.Fatal(err)
	}
	mutable := 0
	for _, entry := range view.SharedPrivateEntries {
		if !entry.ReadOnly {
			mutable++
		}
	}
	if mutable != 1 {
		t.Fatalf("post-close private rows editable=%d, want 1", mutable)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='clerk' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, f.acctA); err != nil {
		t.Fatal(err)
	}
	view, err = service.WebLedger(t.Context(), f.acctA, uuid.NewString(), f.vaultA)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range view.SharedPrivateEntries {
		if !entry.ReadOnly {
			t.Fatal("clerk may create, but cannot amend existing private history")
		}
	}
	if _, err := service.WebLedger(t.Context(), f.acctB, uuid.NewString(), f.vaultA); !errors.Is(err, syncapi.ErrNotMember) {
		t.Fatalf("counterparty could read private book: %v", err)
	}
}

func TestTabAccessFlagsPreserveMemberAndRecordingPermissions(t *testing.T) {
	for _, test := range []struct {
		role, mode, side string
		append, review   bool
	}{
		{"viewer", "review", "a", false, false},
		{"clerk", "review", "a", true, false},
		{"editor", "review", "a", true, true},
		{"owner", "notify", "b", true, false},
		{"owner", "notify_one_way", "b", false, false},
		{"owner", "notify_one_way", "a", true, false},
	} {
		joined := time.Now()
		p := Party{Role: test.side, MemberRole: test.role, JoinedAt: &joined}
		tab := Tab{RecordingMode: test.mode}
		access := callerTabAccess(p, tab)
		if access.Append != test.append || access.Review != test.review {
			t.Fatalf("%+v access=%+v", test, access)
		}
		closed := int64(1)
		tab.ClosedAtMS = &closed
		wantVoid := roleRank[test.role] >= rankEditor && tallyWriterAllowed(test.mode, test.side)
		if got := callerTabAccess(p, tab); got.Append || got.Review != test.review || got.Void != wantVoid || got.Settle || got.Manage {
			t.Fatalf("closed access=%+v", got)
		}
	}
}

func TestWebLedgerRetainsEarlierAcknowledgedBalanceWhileOpeningIsPending(t *testing.T) {
	f := newCheckpointCreditFixture(t)
	user, device := uuid.NewString(), uuid.NewString()
	payload, _ := json.Marshal(map[string]any{"user_id": user, "name": "Carried history"})
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,account_id,target_id,relationship_id,event_type,payload,server_seq)
		VALUES($1::uuid,$2::uuid,200,0,$3::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'person_added',$7::jsonb,1)`, uuid.NewString(), f.vaultA, device, f.acctA, user, f.relA, payload); err != nil {
		t.Fatal(err)
	}
	service := syncapi.NewService(f.pool)
	check := func(pending string) {
		t.Helper()
		got, err := service.WebLedger(t.Context(), f.acctA, uuid.NewString(), f.vaultA)
		if err != nil || len(got.People) != 1 || got.People[0].Shared == nil {
			t.Fatalf("ledger=%+v error=%v", got, err)
		}
		shared := got.People[0].Shared
		if len(shared.Tabs) != 2 || len(shared.Balances) != 1 || shared.Balances[0].Recorded != "300.00" || shared.Balances[0].Confirmed != "300.00" || shared.Balances[0].Pending != pending {
			t.Fatalf("carried history %+v", shared)
		}
	}
	check("-200.00")
	if _, err := f.svc.Dispute(t.Context(), f.b, f.current.Entries[0].ID, "Opening is wrong"); err != nil {
		t.Fatal(err)
	}
	check("0.00")
}
