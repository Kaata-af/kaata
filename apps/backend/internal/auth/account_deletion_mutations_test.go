package auth

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/testutil"
)

// A request admitted before cache invalidation must not edit recovery identity
// or credentials after scheduling. These are real transactional service calls.
func TestAccountDeletionGraceRejectsLateProfileAndPasswordEdits(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	s := newEmailService(t, pool)
	signed := signUp(t, s, pool, "pending.edits@shop.af", uuid.NewString())
	claims := sessionOf(t, signed)
	graceExec(t, pool, `INSERT INTO account_identities(account_id,provider,provider_sub)
	 VALUES($1::uuid,'google',$2)`, signed.AccountID, uuid.NewString())
	if _, err := s.SetUsername(t.Context(), signed.AccountID, "before_grace"); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateAccountPhone(t.Context(), signed.AccountID, "+93700123456"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(t.Context(), claims); err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		name string
		run  func() error
	}{
		{"set phone", func() error { return s.UpdateAccountPhone(t.Context(), signed.AccountID, "+93700987654") }},
		{"clear phone", func() error { return s.UpdateAccountPhone(t.Context(), signed.AccountID, "") }},
		{"set username", func() error { _, err := s.SetUsername(t.Context(), signed.AccountID, "after_grace"); return err }},
		{"remove username", func() error { _, err := s.SetUsername(t.Context(), signed.AccountID, ""); return err }},
		{"set name", func() error { _, err := s.SetAccountName(t.Context(), signed.AccountID, "Later Name"); return err }},
		{"set display name", func() error {
			_, err := s.SetAccountDisplayName(t.Context(), signed.AccountID, "Later Name")
			return err
		}},
		{"change password", func() error {
			_, err := s.ChangePassword(t.Context(), claims, goodPassword, "AnotherSafePassword7!", "en")
			return err
		}},
		{"remove password", func() error { return s.RemovePassword(t.Context(), signed.AccountID, ProviderGoogle, "en") }},
		{"setup password", func() error {
			return s.PasswordSetupStart(t.Context(), signed.AccountID, "pending.edits@shop.af", "en")
		}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			err := check.run()
			// Name setters retain their pre-existing provider-name refusal, also safe.
			if !errors.Is(err, ErrSessionRevoked) && !(check.name == "set name" && errors.Is(err, ErrProviderName)) {
				t.Fatalf("late edit accepted or unexpected refusal: %v", err)
			}
		})
	}
	var username, phone string
	if err := pool.QueryRow(t.Context(), `SELECT username,phone_e164 FROM accounts WHERE id=$1::uuid`, signed.AccountID).Scan(&username, &phone); err != nil || username != "before_grace" || phone != "+93700123456" {
		t.Fatalf("saved identity changed: username=%q phone=%q err=%v", username, phone, err)
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM account_passwords WHERE account_id=$1::uuid`, signed.AccountID) != 1 {
		t.Fatal("recovery password was removed")
	}
	if gracePending(t, pool, signed.AccountID) == nil {
		t.Fatal("late mutation cancelled deletion")
	}
}

func TestAccountDeletionGraceReceiptDeadlineAcrossDatabaseDST(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	s := newEmailService(t, pool)
	signed := signUp(t, s, pool, "grace.dst@shop.af", uuid.NewString())
	claims := sessionOf(t, signed)
	if _, err := s.RequestAccountDeletion(t.Context(), claims); err != nil {
		t.Fatal(err)
	}
	requested := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	graceExec(t, pool, `UPDATE accounts SET pending_delete_at=$2 WHERE id=$1::uuid`, signed.AccountID, requested)
	// Use a separate connection pool with a DST timezone; retain the original
	// fixture's advisory lock rather than resetting this schema again.
	config := pool.Config().Copy()
	config.ConnConfig.RuntimeParams["timezone"] = "America/New_York"
	zonedPool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer zonedPool.Close()
	zoned := &Service{pool: zonedPool}
	state, err := zoned.DeletionState(t.Context(), claims.InstallID, claims.AccountID)
	if err != nil || state.PurgeAt == nil || !state.PurgeAt.Equal(requested.Add(AccountDeletionGrace)) {
		t.Fatalf("receipt shifted at DST: %+v err=%v", state, err)
	}
}
