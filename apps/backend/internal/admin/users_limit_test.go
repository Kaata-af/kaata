package admin

import (
	"fmt"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

// The Users page derives its counts and filters from the returned records.
// Truncating either list makes growth stop at 1,000 and hides older records.
func TestGetUsersBeyondOneThousand(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	const accounts, anonymous = 1005, 1003
	if _, err := pool.Exec(ctx, `
		WITH seeded_accounts AS (
			INSERT INTO accounts (google_sub, email, created_at, last_login_at)
			SELECT 'users-limit-' || n, 'users-limit-' || n || '@example.test',
			       '2026-10-01T00:00:00Z'::timestamptz + n * INTERVAL '1 second',
			       '2026-10-01T00:00:00Z'::timestamptz + n * INTERVAL '1 second'
			FROM generate_series(1, $1::int) AS n
			RETURNING id, created_at
		)
		INSERT INTO installs (install_id, account_id, installed_at, first_seen_at, last_seen_at)
		SELECT gen_random_uuid(), id, created_at, created_at, created_at
		FROM seeded_accounts
	`, accounts); err != nil {
		t.Fatalf("seed signed-in accounts: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO installs (install_id, self_name, installed_at, first_seen_at, last_seen_at)
		SELECT gen_random_uuid(), 'users-anonymous-' || n,
		       '2026-10-01T00:00:00Z'::timestamptz + n * INTERVAL '1 second',
		       '2026-10-01T00:00:00Z'::timestamptz + n * INTERVAL '1 second',
		       '2026-10-01T00:00:00Z'::timestamptz + n * INTERVAL '1 second'
		FROM generate_series(1, $1::int) AS n
	`, anonymous); err != nil {
		t.Fatalf("seed anonymous installs: %v", err)
	}
	operator := seedActivityAccount(t, pool)
	seedActivityInstall(t, pool, &operator, "2026-10-02T00:00:00Z")
	svc := NewService(pool, []string{operator}, nil)

	check := func(got UsersResult, wantAccounts, wantAnonymous int) {
		t.Helper()
		if got.SignedInCount != wantAccounts || len(got.Users) != wantAccounts {
			t.Errorf("signed-in count/rows = %d/%d, want %d/%d", got.SignedInCount, len(got.Users), wantAccounts, wantAccounts)
		}
		if got.AnonymousCount != wantAnonymous || len(got.AnonymousInstalls) != wantAnonymous {
			t.Errorf("anonymous count/rows = %d/%d, want %d/%d", got.AnonymousCount, len(got.AnonymousInstalls), wantAnonymous, wantAnonymous)
		}
		if got.TotalInstalls != wantAccounts+wantAnonymous {
			t.Errorf("total installs = %d, want %d", got.TotalInstalls, wantAccounts+wantAnonymous)
		}
		accountEmails := make(map[string]bool, len(got.Users))
		for _, user := range got.Users {
			if user.AccountID == operator {
				t.Error("operator account was not excluded")
			}
			if user.InstallCount != 1 {
				t.Errorf("account %s install count = %d, want 1", user.AccountID, user.InstallCount)
			}
			accountEmails[user.Email] = true
		}
		for n := 1; n <= accounts; n++ {
			if email := fmt.Sprintf("users-limit-%d@example.test", n); !accountEmails[email] {
				t.Errorf("account missing from complete list: %s", email)
			}
		}
		installNames := make(map[string]bool, len(got.AnonymousInstalls))
		for _, install := range got.AnonymousInstalls {
			installNames[install.SelfName] = true
		}
		for n := 1; n <= anonymous; n++ {
			if name := fmt.Sprintf("users-anonymous-%d", n); !installNames[name] {
				t.Errorf("anonymous install missing from complete list: %s", name)
			}
		}
	}
	before, err := svc.GetUsers(ctx)
	if err != nil {
		t.Fatalf("GetUsers before new sign-in: %v", err)
	}
	check(before, accounts, anonymous)

	// A later refresh must grow the report and include the new account even
	// after both sections have already passed the former limit.
	newAccount := seedActivityAccount(t, pool)
	seedActivityInstall(t, pool, &newAccount, "2026-10-03T00:00:00Z")
	after, err := svc.GetUsers(ctx)
	if err != nil {
		t.Fatalf("GetUsers after new sign-in: %v", err)
	}
	check(after, accounts+1, anonymous)
	for _, user := range after.Users {
		if user.AccountID == newAccount {
			return
		}
	}
	t.Error("new signed-in account missing after refresh")
}
