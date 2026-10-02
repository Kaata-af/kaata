package auth_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/tabs"
	"github.com/matee/kaata-backend/internal/testutil"
)

type sharedDeletionFixture struct {
	pool         *pgxpool.Pool
	accounts     *auth.Service
	tallies      *tabs.Service
	a, b, va, vb string
	created      tabs.CreateResult
	pa, pb       tabs.Party
}

func (f *sharedDeletionFixture) account(t *testing.T, name string) string {
	t.Helper()
	var id string
	err := f.pool.QueryRow(t.Context(), `INSERT INTO accounts(email, email_normalized, email_verified, name)
		VALUES ($1, $1, TRUE, $2) RETURNING id::text`, uuid.NewString()+"@example.test", name).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *sharedDeletionFixture) vault(t *testing.T, owner string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vaults(vault_id,owner_account_id,name,currency)
		VALUES ($1::uuid,$2::uuid,'Shop','AFN')`, id, owner); err != nil {
		t.Fatal(err)
	}
	f.member(t, id, owner, "owner")
	return id
}

func (f *sharedDeletionFixture) member(t *testing.T, vault, account, role string) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,accepted_at)
		VALUES ($1::uuid,$2::uuid,$3,NOW())`, vault, account, role); err != nil {
		t.Fatal(err)
	}
}

func newSharedDeletionFixture(t *testing.T, joined bool) *sharedDeletionFixture {
	t.Helper()
	pool := testutil.ConnectTestDB(t)
	f := &sharedDeletionFixture{pool: pool, accounts: auth.NewService(pool, "test", "test-secret"), tallies: tabs.NewService(pool)}
	f.accounts.SetSharedRecordNotifier(f.tallies)
	f.a, f.b = f.account(t, "Author A"), f.account(t, "Reviewer B")
	f.va, f.vb = f.vault(t, f.a), f.vault(t, f.b)
	var err error
	f.created, err = f.tallies.Create(t.Context(), tabs.CreateInput{Currency: "AFN", Label: "Shop A", AccountID: &f.a, VaultID: &f.va})
	if err != nil {
		t.Fatal(err)
	}
	f.pa, err = f.tallies.PartyByAccount(t.Context(), f.created.Tab.ID, f.a)
	if err != nil {
		t.Fatal(err)
	}
	if joined {
		invited, err := f.tallies.PartyByToken(t.Context(), f.created.InviteToken, f.created.Tab.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.tallies.Join(t.Context(), invited, tabs.JoinInput{Label: "Shop B", AccountID: &f.b, VaultID: &f.vb}); err != nil {
			t.Fatal(err)
		}
		f.pb, err = f.tallies.PartyByAccount(t.Context(), f.created.Tab.ID, f.b)
		if err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *sharedDeletionFixture) append(t *testing.T, amount string) tabs.Entry {
	t.Helper()
	result, err := f.tallies.Append(t.Context(), f.pa, tabs.AppendInput{
		ID: uuid.NewString(), Direction: "a_to_b", Amount: amount, OccurredAtMS: 1_750_000_000_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	return result.Entry
}

func TestSharedAccountDeletionPreservesDecisionsAndEvidence(t *testing.T) {
	f := newSharedDeletionFixture(t, true)
	accepted, pending, rejected, cancelled := f.append(t, "100"), f.append(t, "20"), f.append(t, "30"), f.append(t, "40")
	if _, err := f.tallies.Accept(t.Context(), f.pb, accepted.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.tallies.Dispute(t.Context(), f.pb, rejected.ID, "Not agreed"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.tallies.Void(t.Context(), f.pa, cancelled.ID); err != nil {
		t.Fatal(err)
	}
	before, err := f.tallies.Get(t.Context(), f.pa, 0)
	if err != nil {
		t.Fatal(err)
	}

	if err := f.accounts.DeleteAccount(t.Context(), f.b); err != nil {
		t.Fatal(err)
	}
	after, err := f.tallies.Get(t.Context(), f.pa, 0)
	if err != nil {
		t.Fatal(err)
	}
	if after.Tab.ClosedAtMS == nil || after.Tab.ClosedReason == nil || *after.Tab.ClosedReason != "account_deleted" {
		t.Fatalf("departed side did not close the shared record: %+v", after.Tab)
	}
	if after.Tab.Rev <= before.Tab.Rev || after.Tab.Balance["a"] != before.Tab.Balance["a"] || len(after.Entries) != len(before.Entries) {
		t.Fatalf("deletion changed history/balance or hid the change: before=%+v after=%+v", before, after)
	}
	byID := map[string]tabs.Entry{}
	for _, entry := range after.Entries {
		byID[entry.ID] = entry
	}
	if byID[accepted.ID].Status != "accepted" || byID[pending.ID].Status != "pending" || byID[rejected.ID].Status != "disputed" || byID[cancelled.ID].VoidedByEntryID == nil {
		t.Fatalf("deletion rewrote review states: %+v", byID)
	}
	e := byID[accepted.ID]
	if e.ReviewerAccountID == nil || *e.ReviewerAccountID != f.b || e.ReviewerName != "Reviewer B" || e.StatusAtMS == nil {
		t.Fatalf("review evidence was lost: %+v", e)
	}
	var accounts, vaults int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM accounts WHERE id=$1::uuid`, f.b).Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM vaults WHERE vault_id=$1::uuid`, f.vb).Scan(&vaults); err != nil {
		t.Fatal(err)
	}
	if accounts != 0 || vaults != 0 {
		t.Fatalf("login/private owned vault survived: %d/%d", accounts, vaults)
	}
	if _, err := f.tallies.Append(t.Context(), f.pa, tabs.AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "1", OccurredAtMS: 1}); !errors.Is(err, tabs.ErrTabClosed) {
		t.Fatalf("new entries admitted after closure: %v", err)
	}
	if _, err := f.tallies.PartyByToken(t.Context(), f.created.InviteToken, f.created.Tab.ID); !errors.Is(err, tabs.ErrNotFound) {
		t.Fatalf("old invitation survived: %v", err)
	}
	if _, err := f.tallies.PartyByAccount(t.Context(), f.created.Tab.ID, f.b); !errors.Is(err, tabs.ErrNotFound) {
		t.Fatalf("deleted account retained access: %v", err)
	}
	if err := f.accounts.DeleteAccount(t.Context(), f.b); err != nil {
		t.Fatal(err)
	}
}

func TestDeletingStaffRetainsSharedAuthorityAndReviewer(t *testing.T) {
	f := newSharedDeletionFixture(t, true)
	staff := f.account(t, "Staff Reviewer")
	f.member(t, f.vb, staff, "editor")
	p, err := f.tallies.PartyByAccount(t.Context(), f.created.Tab.ID, staff)
	if err != nil {
		t.Fatal(err)
	}
	entry := f.append(t, "50")
	if _, err := f.tallies.Accept(t.Context(), p, entry.ID); err != nil {
		t.Fatal(err)
	}
	pending := f.append(t, "2")
	if err := f.accounts.DeleteAccount(t.Context(), staff); err != nil {
		t.Fatal(err)
	}
	after, err := f.tallies.Get(t.Context(), f.pa, 0)
	if err != nil {
		t.Fatal(err)
	}
	if after.Tab.ClosedAtMS != nil {
		t.Fatal("deleting one staff member closed an otherwise represented shop")
	}
	if _, err := f.tallies.Accept(t.Context(), p, pending.ID); err == nil {
		t.Fatal("stale staff authority accepted a tally after deletion")
	}
	if _, err := f.tallies.Accept(t.Context(), f.pb, pending.ID); err != nil {
		t.Fatalf("remaining owner lost authority: %v", err)
	}
	for _, e := range after.Entries {
		if e.ID == entry.ID && (e.ReviewerName != "Staff Reviewer" || e.ReviewerMemberRole == nil || *e.ReviewerMemberRole != "editor") {
			t.Fatalf("lost representative evidence: %+v", e)
		}
	}
}

func TestDeletedInviterCannotAdmitANewCounterparty(t *testing.T) {
	f := newSharedDeletionFixture(t, false)
	entry := f.append(t, "75")
	if err := f.accounts.DeleteAccount(t.Context(), f.a); err != nil {
		t.Fatal(err)
	}
	if _, err := f.tallies.PartyByToken(t.Context(), f.created.InviteToken, f.created.Tab.ID); !errors.Is(err, tabs.ErrNotFound) {
		t.Fatalf("unclaimed invitation survived: %v", err)
	}
	var status, author string
	if err := f.pool.QueryRow(context.Background(), `SELECT status, author_name FROM tab_entries WHERE id=$1::uuid`, entry.ID).Scan(&status, &author); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || author != "Author A" {
		t.Fatalf("unacknowledged record rewritten: %s/%s", status, author)
	}
}

func TestDeletingVaultOwnerPreservesOtherDirectParticipant(t *testing.T) {
	f := newSharedDeletionFixture(t, true)
	owner := f.account(t, "Different vault owner")
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET owner_account_id=$1::uuid WHERE vault_id=$2::uuid`, owner, f.vb); err != nil {
		t.Fatal(err)
	}
	entry := f.append(t, "25")
	if err := f.accounts.DeleteAccount(t.Context(), owner); err != nil {
		t.Fatal(err)
	}
	party, err := f.tallies.PartyByAccount(t.Context(), f.created.Tab.ID, f.b)
	if err != nil {
		t.Fatalf("surviving directly bound participant lost access: %v", err)
	}
	if _, err := f.tallies.Accept(t.Context(), party, entry.ID); err != nil {
		t.Fatalf("deleted vault owner closed another account's tally: %v", err)
	}
}

func TestDeletionRetiresOwnAndLegacyInstallsButNotSwitchedAccount(t *testing.T) {
	f := newSharedDeletionFixture(t, false)
	bound, legacy, switched := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, install := range []string{bound, legacy, switched} {
		if _, err := f.pool.Exec(t.Context(), `INSERT INTO installs(install_id,self_name,self_phone,shop_name)
			VALUES($1,'Profile','+93700000000','Shop')`, install); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(t.Context(), `INSERT INTO auth_credentials(install_id,provider,provider_sub,account_id)
			VALUES($1,'google',$2,$3::uuid)`, install, f.a, f.a); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE installs SET account_id=$1::uuid WHERE install_id=$2::uuid`, f.a, bound); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE installs SET account_id=$1::uuid WHERE install_id=$2::uuid`, f.b, switched); err != nil {
		t.Fatal(err)
	}
	if err := f.accounts.DeleteAccount(t.Context(), f.a); err != nil {
		t.Fatal(err)
	}
	for _, install := range []string{bound, legacy} {
		var retired bool
		if err := f.pool.QueryRow(t.Context(), `SELECT account_deleted_at IS NOT NULL AND deletion_account_id=$2::uuid
			AND account_id IS NULL AND self_name IS NULL AND self_phone IS NULL AND shop_name IS NULL
			FROM installs WHERE install_id=$1::uuid`, install, f.a).Scan(&retired); err != nil || !retired {
			t.Fatalf("deleted installation not safely retired: %v/%v", retired, err)
		}
	}
	var survived bool
	if err := f.pool.QueryRow(t.Context(), `SELECT account_deleted_at IS NULL AND deletion_account_id IS NULL
		AND account_id=$2::uuid AND self_name='Profile' FROM installs WHERE install_id=$1::uuid`, switched, f.b).Scan(&survived); err != nil || !survived {
		t.Fatalf("another account's installation was retired: %v/%v", survived, err)
	}
}
