package auth

import (
	"testing"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/db"
	"github.com/matee/kaata-backend/internal/testutil"
)

func assertDiscovery(t *testing.T, svc *Service, accountID string, want bool) {
	t.Helper()
	me, err := svc.AccountMe(t.Context(), accountID)
	if err != nil || me.DiscoveryEnabled != want {
		t.Fatalf("discovery want=%v got=%v err=%v", want, me.DiscoveryEnabled, err)
	}
}

func TestDiscoveryDefaultMigrationRunsOnceAndExcludesInactiveAccounts(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, "", emailTestSecret)
	// Reconstruct the state immediately before 082, then run the production
	// migration runner. Never edit the already-applied 081 migration.
	if _, err := pool.Exec(t.Context(), `
		DELETE FROM schema_migrations WHERE name='082_people_discovery_default_on.sql';
		ALTER TABLE accounts ALTER COLUMN discovery_enabled SET DEFAULT FALSE;
	`); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 4)
	for i := range ids {
		ids[i] = seedGoogleAccount(t, pool, uuid.NewString()+"@example.test", uuid.NewString())
	}
	for _, statement := range []struct{ sql, id string }{
		{`UPDATE accounts SET discovery_enabled=TRUE WHERE id=$1::uuid`, ids[1]},
		{`UPDATE accounts SET disabled_at=NOW() WHERE id=$1::uuid`, ids[2]},
		{`UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, ids[3]},
	} {
		if _, err := pool.Exec(t.Context(), statement.sql, statement.id); err != nil {
			t.Fatal(err)
		}
	}
	install := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO installs(install_id,self_name,self_phone,has_onboarded) VALUES($1::uuid,'Anonymous Ninja','+93700000123',TRUE)`, install); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	for i, want := range []bool{true, true, false, false} {
		assertDiscovery(t, svc, ids[i], want)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM accounts`); n != len(ids) {
		t.Fatalf("migration created an account: %d", n)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM installs WHERE install_id=$1::uuid AND account_id IS NULL AND self_name='Anonymous Ninja'`, install); n != 1 {
		t.Fatal("migration promoted or changed the anonymous install")
	}
	if err := svc.SetDiscovery(t.Context(), ids[0], false); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	assertDiscovery(t, svc, ids[0], false)
	fresh := seedGoogleAccount(t, pool, "new-default@example.test", uuid.NewString())
	assertDiscovery(t, svc, fresh, true)
}

func TestDiscoveryProviderDefaultsAndOptOutSurvivesSignInAndRecovery(t *testing.T) {
	for _, provider := range []string{ProviderGoogle, ProviderApple} {
		t.Run(provider, func(t *testing.T) {
			pool := testutil.ConnectTestDB(t)
			svc := NewService(pool, "", emailTestSecret)
			email, sub := provider+"@example.test", uuid.NewString()
			profile := AccountProfile{Email: email, EmailNormalized: email, EmailVerified: true, Name: "Searchable Person"}
			// This is the real shared provider pipeline after token verification,
			// including account creation, install linkage and session issuance.
			signIn := func(install string) GoogleSignInResult {
				t.Helper()
				res, _, err := svc.providerSignIn(t.Context(), profile, signInTail{provider: provider, providerSub: sub, installID: install, credEmail: email})
				if err != nil {
					t.Fatal(err)
				}
				return res
			}
			first := signIn(uuid.NewString())
			assertDiscovery(t, svc, first.AccountID, true)
			if err := svc.SetDiscovery(t.Context(), first.AccountID, false); err != nil {
				t.Fatal(err)
			}
			again := signIn(uuid.NewString())
			if again.AccountID != first.AccountID {
				t.Fatal("sign-in created a different account")
			}
			assertDiscovery(t, svc, again.AccountID, false)
			claims := sessionOf(t, again)
			if _, err := svc.RequestAccountDeletion(t.Context(), claims); err != nil {
				t.Fatal(err)
			}
			restored := signIn(claims.InstallID)
			if restored.AccountID != first.AccountID || !restored.DeletionCancelled {
				t.Fatal("provider sign-in did not restore the existing account")
			}
			assertDiscovery(t, svc, restored.AccountID, false)
		})
	}
}

func TestDiscoveryEmailDefaultAndOptOutSurvivesSignupReplayAndRecovery(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := newEmailService(t, pool)
	email, install := "discovery@example.test", uuid.NewString()
	if err := svc.EmailSignUpStart(t.Context(), email, "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	code := lastCode(t, pool, email)
	first, err := svc.EmailSignUpVerify(t.Context(), install, email, code, goodPassword, SwitchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertDiscovery(t, svc, first.AccountID, true)
	if err := svc.SetDiscovery(t.Context(), first.AccountID, false); err != nil {
		t.Fatal(err)
	}
	replay, err := svc.EmailSignUpVerify(t.Context(), install, email, code, goodPassword, SwitchOptions{})
	if err != nil || replay.AccountID != first.AccountID {
		t.Fatalf("signup replay: %v", err)
	}
	assertDiscovery(t, svc, replay.AccountID, false)
	again, err := svc.EmailSignIn(t.Context(), uuid.NewString(), email, goodPassword, SwitchOptions{})
	if err != nil || again.AccountID != first.AccountID {
		t.Fatalf("email sign-in: %v", err)
	}
	assertDiscovery(t, svc, again.AccountID, false)
	if _, err := svc.RequestAccountDeletion(t.Context(), sessionOf(t, again)); err != nil {
		t.Fatal(err)
	}
	ageMailThrottle(t, pool)
	if err := svc.EmailResetStart(t.Context(), email, "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	restored, err := svc.EmailResetVerify(t.Context(), sessionOf(t, again).InstallID, email, lastCode(t, pool, email), otherPassword, "en", SwitchOptions{})
	if err != nil || restored.AccountID != first.AccountID || !restored.DeletionCancelled {
		t.Fatalf("email recovery: %v", err)
	}
	assertDiscovery(t, svc, restored.AccountID, false)
}
