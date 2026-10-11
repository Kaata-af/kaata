package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

func graceClaims(t *testing.T, token string) *SessionClaims {
	t.Helper()
	c, err := ParseSession(emailTestSecret, token)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func graceRevoked(t *testing.T, s *Service, c *SessionClaims, want bool) {
	t.Helper()
	got, err := s.CheckCredentialRevoked(t.Context(), c.InstallID, c.Provider, c.AccountID, c.Epoch)
	if err != nil || got != want {
		t.Fatalf("revoked=%v want=%v err=%v", got, want, err)
	}
}

func gracePending(t *testing.T, pool *pgxpool.Pool, account string) *time.Time {
	t.Helper()
	var pending *time.Time
	if err := pool.QueryRow(t.Context(), `SELECT pending_delete_at FROM accounts WHERE id=$1::uuid`, account).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	return pending
}

func graceExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

// A real FK/evidence fixture. It deliberately includes private ledger history
// and a shared accepted tally so pending deletion cannot masquerade as a purge.
func seedGraceRecords(t *testing.T, pool *pgxpool.Pool, owner string) (vault, tab string) {
	t.Helper()
	vault = seedVault(t, pool, owner)
	other := seedAccount(t, pool, uuid.NewString()+"@example.test")
	seedDevice(t, pool, vault, owner)
	graceExec(t, pool, `UPDATE accounts SET display_name='Chosen Name',phone_e164='+93700123456' WHERE id=$1::uuid`, owner)
	device := uuid.NewString()
	graceExec(t, pool, `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,
	 account_id,target_id,event_type,payload,server_seq) VALUES($1::uuid,$2::uuid,10,0,$3::uuid,$3::uuid,
	 $4::uuid,$5::uuid,'person_added','{"name":"Private Customer"}',1)`, uuid.NewString(), vault, device, owner, uuid.NewString())
	graceExec(t, pool, `INSERT INTO vault_snapshots(vault_id,up_to_server_seq,snapshot,schema_version,byte_size)
	 VALUES($1::uuid,1,'{"fixture":"private ledger"}',1,28)`, vault)
	tab = uuid.NewString()
	graceExec(t, pool, `INSERT INTO tabs(id,currency,rev) VALUES($1::uuid,'AFN',2)`, tab)
	graceExec(t, pool, `INSERT INTO tab_parties(tab_id,role,label,token_hash,account_id,vault_id,joined_at,account_bound_once)
	 VALUES($1::uuid,'a','Owner',$2,$3::uuid,$4::uuid,NOW(),TRUE),
	 ($1::uuid,'b','Other side',$5,$6::uuid,NULL,NOW(),TRUE)`, tab, uuid.NewString(), owner, vault, uuid.NewString(), other)
	graceExec(t, pool, `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,note,
	 occurred_at_ms,status,author_account_id,author_evidence_account_id,author_name)
	 VALUES($1::uuid,$2::uuid,1,2,'a','a_to_b',12345,'Shared groceries',10,'accepted',$3::uuid,$3::uuid,'Chosen Name')`, uuid.NewString(), tab, owner)
	return vault, tab
}

func TestAccountDeletionGraceRetainsDataAndRevokesSessions(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	s := newEmailService(t, pool)
	first := signUp(t, s, pool, "grace.owner@shop.af", uuid.NewString())
	second, err := s.EmailSignIn(t.Context(), uuid.NewString(), "grace.owner@shop.af", goodPassword, SwitchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	vault, tab := seedGraceRecords(t, pool, first.AccountID)
	firstClaims, secondClaims := sessionOf(t, first), sessionOf(t, second)
	state, err := s.RequestAccountDeletion(t.Context(), firstClaims)
	if err != nil || state.Status != "deletion_scheduled" || state.PurgeAt == nil {
		t.Fatalf("request=%+v err=%v", state, err)
	}
	pending := gracePending(t, pool, first.AccountID)
	if pending == nil || !state.PurgeAt.Equal(pending.Add(AccountDeletionGrace)) {
		t.Fatal("deadline must be exactly 30 days from the original request")
	}
	retry, err := s.RequestAccountDeletion(t.Context(), firstClaims)
	if err != nil || !retry.PurgeAt.Equal(*state.PurgeAt) {
		t.Fatalf("retry changed deadline: %+v %v", retry, err)
	}
	graceRevoked(t, s, firstClaims, true)
	graceRevoked(t, s, secondClaims, true)
	for _, query := range []string{
		`SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid`,
		`SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid`,
		`SELECT COUNT(*) FROM vault_devices WHERE vault_id=$1::uuid`,
		`SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`,
		`SELECT COUNT(*) FROM vault_snapshots WHERE vault_id=$1::uuid`,
	} {
		if n := dbCount(t, pool, query, vault); n != 1 {
			t.Fatalf("pending deletion changed private history %q: %d", query, n)
		}
	}
	var name, phone string
	if err := pool.QueryRow(t.Context(), `SELECT display_name,phone_e164 FROM accounts WHERE id=$1::uuid`, first.AccountID).Scan(&name, &phone); err != nil || name != "Chosen Name" || phone != "+93700123456" {
		t.Fatalf("profile erased: %q %q %v", name, phone, err)
	}
	var closed *time.Time
	var rev int64
	if err := pool.QueryRow(t.Context(), `SELECT closed_at,rev FROM tabs WHERE id=$1::uuid`, tab).Scan(&closed, &rev); err != nil || closed != nil || rev != 2 {
		t.Fatalf("pending deletion changed shared tab: closed=%v rev=%d err=%v", closed, rev, err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM tab_entries WHERE tab_id=$1::uuid AND amount_minor=12345
	 AND note='Shared groceries' AND status='accepted' AND author_name='Chosen Name' AND author_account_id=$2::uuid`, tab, first.AccountID); n != 1 {
		t.Fatal("pending deletion changed shared financial/author evidence")
	}
	if err := s.RunAccountPurgeTick(t.Context()); err != nil {
		t.Fatal(err)
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM accounts WHERE id=$1::uuid`, first.AccountID) != 1 {
		t.Fatal("worker purged before the deadline")
	}
	if _, err := s.EmailSignIn(t.Context(), firstClaims.InstallID, "grace.owner@shop.af", otherPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password=%v", err)
	}
	if gracePending(t, pool, first.AccountID) == nil {
		t.Fatal("wrong password cancelled deletion")
	}
}

// Provider token verification is outside this fixture: providerSignIn receives
// its normal verified identity/profile input and exercises the real shared tail.
func TestAccountDeletionGraceEverySignInTailRestoresSameAccount(t *testing.T) {
	for _, provider := range []string{ProviderEmail, ProviderGoogle, ProviderApple} {
		t.Run(provider, func(t *testing.T) {
			pool := testutil.ConnectTestDB(t)
			s := newEmailService(t, pool)
			email := "restore." + provider + "@shop.af"
			original := signUp(t, s, pool, email, uuid.NewString())
			old := sessionOf(t, original)
			vault := seedVault(t, pool, original.AccountID)
			otherPhone, err := s.EmailSignIn(t.Context(), uuid.NewString(), email, goodPassword, SwitchOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if provider != ProviderEmail {
				graceExec(t, pool, `INSERT INTO account_identities(account_id,provider,provider_sub) VALUES($1::uuid,$2,$3)`, original.AccountID, provider, "grace-"+provider)
			}
			if _, err := s.RequestAccountDeletion(t.Context(), old); err != nil {
				t.Fatal(err)
			}
			var restored GoogleSignInResult
			if provider == ProviderEmail {
				restored, err = s.EmailSignIn(t.Context(), old.InstallID, email, goodPassword, SwitchOptions{})
			} else {
				restored, _, err = s.providerSignIn(t.Context(), AccountProfile{Email: email, EmailNormalized: normalizeEmail(email), EmailVerified: true}, signInTail{
					provider: provider, providerSub: "grace-" + provider, installID: old.InstallID, credEmail: email,
				})
			}
			if err != nil || !restored.DeletionCancelled || restored.AccountID != original.AccountID || restored.DefaultVaultID == nil || *restored.DefaultVaultID != vault {
				t.Fatalf("restored=%+v err=%v", restored, err)
			}
			if gracePending(t, pool, original.AccountID) != nil {
				t.Fatal("successful sign-in left deletion scheduled")
			}
			graceRevoked(t, s, old, true)
			graceRevoked(t, s, sessionOf(t, otherPhone), true)
			graceRevoked(t, s, sessionOf(t, restored), false)
			if dbCount(t, pool, `SELECT COUNT(*) FROM installs WHERE deletion_account_id=$1::uuid OR (account_id=$1::uuid AND account_deleted_at IS NOT NULL)`, original.AccountID) != 0 {
				t.Fatal("recovery left install retirement markers")
			}
			state, err := s.DeletionState(t.Context(), old.InstallID, old.AccountID)
			if err != nil || state.Status != "" {
				t.Fatalf("old deletion receipt survived restoration: %+v %v", state, err)
			}
			fresh, err := s.EmailSignIn(t.Context(), uuid.NewString(), email, goodPassword, SwitchOptions{})
			if err != nil || fresh.DeletionCancelled {
				t.Fatalf("ordinary sign-in falsely reports cancellation: %+v %v", fresh, err)
			}
		})
	}
}

func TestAccountDeletionGraceResetProofRestoresAndConsumesOldCode(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	s := newEmailService(t, pool)
	email := "grace.reset@shop.af"
	original := signUp(t, s, pool, email, uuid.NewString())
	old := sessionOf(t, original)
	vault := seedVault(t, pool, original.AccountID)
	ageMailThrottle(t, pool)
	if err := s.EmailResetStart(t.Context(), email, "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	oldCode := lastCode(t, pool, email)
	if _, err := s.RequestAccountDeletion(t.Context(), old); err != nil {
		t.Fatal(err)
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM email_codes WHERE account_id=$1::uuid`, original.AccountID) != 0 {
		t.Fatal("pre-deletion code survived")
	}
	if _, err := s.EmailResetVerify(t.Context(), old.InstallID, email, oldCode, otherPassword, "en", SwitchOptions{}); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("old reset proof=%v", err)
	}
	if gracePending(t, pool, original.AccountID) == nil {
		t.Fatal("obsolete code restored account")
	}
	ageMailThrottle(t, pool)
	if err := s.EmailResetStart(t.Context(), email, "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	restored, err := s.EmailResetVerify(t.Context(), old.InstallID, email, lastCode(t, pool, email), otherPassword, "en", SwitchOptions{})
	if err != nil || restored.AccountID != original.AccountID || !restored.DeletionCancelled || restored.DefaultVaultID == nil || *restored.DefaultVaultID != vault {
		t.Fatalf("reset recovery=%+v err=%v", restored, err)
	}
	graceRevoked(t, s, old, true)
	graceRevoked(t, s, sessionOf(t, restored), false)
}

func TestAccountDeletionGraceExpiredCannotReactivateAndPurgesEvidenceSafely(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	s := newEmailService(t, pool)
	original := signUp(t, s, pool, "grace.expired@shop.af", uuid.NewString())
	old := sessionOf(t, original)
	vault, tab := seedGraceRecords(t, pool, original.AccountID)
	if _, err := s.RequestAccountDeletion(t.Context(), old); err != nil {
		t.Fatal(err)
	}
	graceExec(t, pool, `UPDATE accounts SET pending_delete_at=NOW()-INTERVAL '30 days 1 second' WHERE id=$1::uuid`, original.AccountID)
	if _, err := s.EmailSignIn(t.Context(), old.InstallID, "grace.expired@shop.af", goodPassword, SwitchOptions{}); !errors.Is(err, ErrAccountDeletionExpired) {
		t.Fatalf("expired sign-in=%v", err)
	}
	if gracePending(t, pool, original.AccountID) == nil {
		t.Fatal("expired account reactivated")
	}
	if err := s.RunAccountPurgeTick(t.Context()); err != nil {
		t.Fatal(err)
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM accounts WHERE id=$1::uuid`, original.AccountID) != 0 || dbCount(t, pool, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid`, vault) != 0 || dbCount(t, pool, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, vault) != 0 {
		t.Fatal("expired purge left owned private records")
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM tab_entries WHERE tab_id=$1::uuid AND amount_minor=12345 AND status='accepted'
	 AND author_account_id IS NULL AND author_evidence_account_id=$2::uuid AND author_name='Chosen Name'`, tab, original.AccountID) != 1 {
		t.Fatal("purge lost shared financial/author evidence")
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM tabs WHERE id=$1::uuid AND closed_reason='account_deleted' AND closed_at IS NOT NULL`, tab) != 1 {
		t.Fatal("purge did not close abandoned shared tab")
	}
	state, err := s.DeletionState(t.Context(), old.InstallID, old.AccountID)
	if err != nil || state.Status != "deleted" || state.PurgeAt != nil {
		t.Fatalf("purged receipt=%+v err=%v", state, err)
	}
}

func TestAccountDeletionGracePurgeSkipsLockedAndRechecksRecovery(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account, install, token := seedDeletionSession(t, pool)
	s := NewService(pool, "test-client", emailTestSecret)
	claims := graceClaims(t, token)
	if _, err := s.RequestAccountDeletion(t.Context(), claims); err != nil {
		t.Fatal(err)
	}
	graceExec(t, pool, `UPDATE accounts SET pending_delete_at=NOW()-INTERVAL '31 days' WHERE id=$1::uuid`, account)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(t.Context(), `SELECT id FROM accounts WHERE id=$1::uuid FOR UPDATE`, account); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := s.RunAccountPurgeTick(ctx); err != nil {
		t.Fatalf("locked candidate must skip immediately: %v", err)
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM accounts WHERE id=$1::uuid`, account) != 1 {
		t.Fatal("locked account purged")
	}
	if _, err := tx.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NULL,delete_requested_from_install=NULL WHERE id=$1::uuid`, account); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	// A candidate ID observed before the recovery must be rechecked at delete.
	if err := s.hardDeleteAccount(t.Context(), account, true); err != nil {
		t.Fatal(err)
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM accounts WHERE id=$1::uuid`, account) != 1 {
		t.Fatal("stale queued candidate deleted recovered account")
	}
	_ = install
}

func TestAccountDeletionGraceSignInAndPurgeUseSameAccountLock(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account, install, token := seedDeletionSession(t, pool)
	s := NewService(pool, "test-client", emailTestSecret)
	if _, err := s.RequestAccountDeletion(t.Context(), graceClaims(t, token)); err != nil {
		t.Fatal(err)
	}
	// Begin the proved sign-in before the deadline, hold its account lock, and
	// let the worker observe the expired committed row while recovery is pending.
	graceExec(t, pool, `UPDATE accounts SET pending_delete_at=NOW()-INTERVAL '30 days'+INTERVAL '2 seconds' WHERE id=$1::uuid`, account)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(t.Context(), `SELECT id FROM accounts WHERE id=$1::uuid FOR UPDATE`, account); err != nil {
		t.Fatal(err)
	}
	cancelled, err := cancelPendingAccountDeletion(t.Context(), tx, account)
	if err != nil || !cancelled {
		t.Fatalf("before-deadline proof cannot cancel: %v %v", cancelled, err)
	}
	if _, err := tx.Exec(t.Context(), `SELECT pg_sleep(2.1)`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := s.RunAccountPurgeTick(ctx); err != nil {
		t.Fatalf("worker must not block or erase sign-in's locked account: %v", err)
	}
	result, _, err := s.completeSignIn(t.Context(), tx, signInTail{provider: ProviderGoogle, providerSub: "receipt-test", installID: install, accountID: account})
	if err != nil || result.AccountID != account {
		t.Fatalf("sign-in after excluded purge=%+v %v", result, err)
	}
	if err := s.RunAccountPurgeTick(t.Context()); err != nil {
		t.Fatal(err)
	}
	if gracePending(t, pool, account) != nil {
		t.Fatal("recovery did not commit")
	}
	graceRevoked(t, s, graceClaims(t, result.SessionJWT), false)
	graceRevoked(t, s, graceClaims(t, token), true)
}

func TestAccountDeletionGraceReceiptsAndLegacyClientResponse(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account, install, token := seedDeletionSession(t, pool)
	s := NewService(pool, "test-client", emailTestSecret)
	a := NewSessionAuthenticator(s, emailTestSecret)
	h := NewHandler(s)
	h.SetAuthenticator(a)
	calls := 0
	endpoint := a.DeletionMiddleware()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; h.DeleteAccount(w, r) }))
	request := func(graceHeader string) (int, AccountDeletionState) {
		t.Helper()
		r := httptest.NewRequest(http.MethodDelete, "/v1/account", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		if graceHeader != "" {
			r.Header.Set("X-Kaata-Deletion-Grace", graceHeader)
		}
		w := httptest.NewRecorder()
		endpoint.ServeHTTP(w, r)
		var result AccountDeletionState
		if w.Code == http.StatusOK {
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
		}
		return w.Code, result
	}
	if state, err := s.DeletionState(t.Context(), install, account); err != nil || state.Status != "" {
		t.Fatalf("active account has deletion receipt: %+v %v", state, err)
	}
	code, first := request("30")
	if code != http.StatusOK || first.Status != "deletion_scheduled" || first.PurgeAt == nil {
		t.Fatalf("new client=%d %+v", code, first)
	}
	code, retry := request("30")
	if code != http.StatusOK || retry.Status != first.Status || !retry.PurgeAt.Equal(*first.PurgeAt) || calls != 1 {
		t.Fatalf("lost-response retry=%d %+v handler calls=%d", code, retry, calls)
	}
	for _, header := range []string{"", "29", "garbage"} {
		code, legacy := request(header)
		if code != http.StatusOK || legacy.Status != "deleted" || calls != 1 {
			t.Fatalf("legacy header %q=%d %+v calls=%d", header, code, legacy, calls)
		}
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM accounts WHERE id=$1::uuid AND pending_delete_at IS NOT NULL`, account) != 1 {
		t.Fatal("legacy response accidentally caused immediate purge")
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	result, _, err := s.completeSignIn(t.Context(), tx, signInTail{provider: ProviderGoogle, providerSub: "receipt-test", installID: install, accountID: account})
	if err != nil || !result.DeletionCancelled {
		t.Fatalf("recovery=%+v %v", result, err)
	}
	if completed, err := s.AccountDeletionCompleted(t.Context(), install, account); err != nil || completed {
		t.Fatalf("restored receipt=%v %v", completed, err)
	}
	if code, _ := request("30"); code != http.StatusUnauthorized || calls != 1 {
		t.Fatalf("old deletion retry after restoration=%d calls=%d", code, calls)
	}
	graceExec(t, pool, `UPDATE installs SET account_deleted_at=NOW(),deletion_account_id=$2::uuid WHERE install_id=$1::uuid`, install, account)
	if state, err := s.DeletionState(t.Context(), install, account); err != nil || state.Status != "" {
		t.Fatalf("stale marker on active account became receipt: %+v %v", state, err)
	}
}

func TestAccountDeletionGraceStaleAuthenticatedEpochCannotSchedule(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	s := newEmailService(t, pool)
	original := signUp(t, s, pool, "grace.stale@shop.af", uuid.NewString())
	// These are the claims captured by middleware before a newer sign-in commits.
	stale := sessionOf(t, original)
	fresh, err := s.EmailSignIn(t.Context(), stale.InstallID, "grace.stale@shop.af", goodPassword, SwitchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(t.Context(), stale); !errors.Is(err, ErrDeletionSessionEnded) {
		t.Fatalf("stale authenticated delete=%v", err)
	}
	if gracePending(t, pool, original.AccountID) != nil {
		t.Fatal("stale epoch scheduled deletion")
	}
	graceRevoked(t, s, sessionOf(t, fresh), false)
}

func TestAccountDeletionGraceLegacyUnboundCredentialIsRevoked(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account, install, token := seedDeletionSession(t, pool)
	s := NewService(pool, "test-client", emailTestSecret)
	claims := graceClaims(t, token)
	// Current migrations require account_id; relax it in this isolated fixture
	// to exercise the defensive read path for older/unbackfilled credentials.
	graceExec(t, pool, `ALTER TABLE auth_credentials ALTER COLUMN account_id DROP NOT NULL`)
	graceExec(t, pool, `UPDATE auth_credentials SET account_id=NULL WHERE install_id=$1::uuid`, install)
	other := seedAccount(t, pool, "switched.legacy@shop.af")
	otherInstall := uuid.NewString()
	seedSession(t, pool, otherInstall, ProviderGoogle, "switched-legacy", other)
	graceExec(t, pool, `UPDATE auth_credentials SET account_id=NULL WHERE install_id=$1::uuid`, otherInstall)
	// A historical credential from A must not make the phone currently owned
	// by B eligible for retirement, or revoke B's unbound current credential.
	graceExec(t, pool, `INSERT INTO auth_credentials(install_id,provider,provider_sub,account_id,revoked_at)
	 VALUES ($1::uuid,'apple','older-account-a',$2::uuid,NOW())`, otherInstall, account)
	otherToken, err := SignSession(emailTestSecret, other, otherInstall, ProviderGoogle, "switched-legacy")
	if err != nil {
		t.Fatal(err)
	}
	otherClaims := graceClaims(t, otherToken)
	graceRevoked(t, s, claims, false)
	graceRevoked(t, s, otherClaims, false)
	staleOtherToken, err := SignSession(emailTestSecret, account, otherInstall, ProviderGoogle, "switched-legacy")
	if err != nil {
		t.Fatal(err)
	}
	staleOtherClaims := graceClaims(t, staleOtherToken)
	graceRevoked(t, s, staleOtherClaims, true)
	if _, err := s.RequestAccountDeletion(t.Context(), staleOtherClaims); !errors.Is(err, ErrDeletionSessionEnded) {
		t.Fatalf("A claims using B's NULL credential scheduled deletion: %v", err)
	}
	if gracePending(t, pool, account) != nil {
		t.Fatal("switched phone's stale claims scheduled A deletion")
	}
	if _, err := s.RequestAccountDeletion(t.Context(), claims); err != nil {
		t.Fatal(err)
	}
	graceRevoked(t, s, claims, true)
	graceRevoked(t, s, otherClaims, false)
	if dbCount(t, pool, `SELECT COUNT(*) FROM installs WHERE install_id=$1::uuid AND account_id=$2::uuid AND account_deleted_at IS NULL`, otherInstall, other) != 1 {
		t.Fatal("deleting A retired the install now owned by B")
	}
	if state, err := s.DeletionState(t.Context(), install, account); err != nil || state.Status != "deletion_scheduled" {
		t.Fatalf("legacy deletion receipt=%+v err=%v", state, err)
	}
}

func TestAccountDeletionGraceDifferentAccountConfirmationDoesNotCancel(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	s := newEmailService(t, pool)
	original := signUp(t, s, pool, "grace.confirmation@shop.af", uuid.NewString())
	claims := sessionOf(t, original)
	if _, err := s.RequestAccountDeletion(t.Context(), claims); err != nil {
		t.Fatal(err)
	}
	_, err := s.EmailSignIn(t.Context(), claims.InstallID, "grace.confirmation@shop.af", goodPassword, SwitchOptions{CurrentAccountID: uuid.NewString()})
	var different *DifferentAccountError
	if !errors.As(err, &different) {
		t.Fatalf("unconfirmed account switch=%v", err)
	}
	if gracePending(t, pool, original.AccountID) == nil {
		t.Fatal("unconfirmed switch committed deletion cancellation")
	}
	if dbCount(t, pool, `SELECT COUNT(*) FROM installs WHERE install_id=$1::uuid AND deletion_account_id=$2::uuid AND account_deleted_at IS NOT NULL`, claims.InstallID, claims.AccountID) != 1 {
		t.Fatal("unconfirmed switch cleared retirement marker")
	}
	graceRevoked(t, s, claims, true)
}

func TestAccountDeletionGraceHollowIdentityKeepsOriginalRecoveryAccount(t *testing.T) {
	for _, provider := range []string{ProviderGoogle, ProviderApple} {
		for _, expired := range []bool{false, true} {
			name := provider + "/within deadline"
			if expired {
				name = provider + "/expired"
			}
			t.Run(name, func(t *testing.T) {
				pool := testutil.ConnectTestDB(t)
				s := newEmailService(t, pool)
				email := "grace.hollow@shop.af"
				source := seedAccount(t, pool, email)
				target := seedAccount(t, pool, email)
				sub, originalInstall := uuid.NewString(), uuid.NewString()
				otherProvider := ProviderGoogle
				if provider == ProviderGoogle {
					otherProvider = ProviderApple
					graceExec(t, pool, `UPDATE accounts SET google_sub=$2 WHERE id=$1::uuid`, source, sub)
				}
				graceExec(t, pool, `INSERT INTO account_identities(account_id,provider,provider_sub)
				 VALUES($1::uuid,$2,$3),($4::uuid,$5,$6)`, source, provider, sub, target, otherProvider, uuid.NewString())
				graceExec(t, pool, `UPDATE accounts SET name='Target preserved' WHERE id=$1::uuid`, target)
				graceExec(t, pool, `UPDATE accounts SET phone_e164='+93700123456' WHERE id=$1::uuid`, source)
				targetVault := seedVault(t, pool, target)
				seedSession(t, pool, originalInstall, provider, sub, source)
				oldToken, err := SignSession(emailTestSecret, source, originalInstall, provider, sub)
				if err != nil {
					t.Fatal(err)
				}
				old := graceClaims(t, oldToken)
				if _, err := s.RequestAccountDeletion(t.Context(), old); err != nil {
					t.Fatal(err)
				}
				if expired {
					graceExec(t, pool, `UPDATE accounts SET pending_delete_at=NOW()-INTERVAL '721 hours' WHERE id=$1::uuid`, source)
				}
				pending := gracePending(t, pool, source)
				freshInstall := uuid.NewString()
				result, _, err := s.providerSignIn(t.Context(), AccountProfile{
					Email: email, EmailNormalized: normalizeEmail(email), EmailVerified: true, Name: "Recovered original",
				}, signInTail{provider: provider, providerSub: sub, accountID: source, installID: freshInstall,
					credEmail: email, sw: SwitchOptions{CurrentAccountID: source}})
				if expired {
					if !errors.Is(err, ErrAccountDeletionExpired) {
						t.Fatalf("expired hollow identity adopted target: result=%+v err=%v", result, err)
					}
					if got := gracePending(t, pool, source); got == nil || !got.Equal(*pending) {
						t.Fatal("expired hollow request was cancelled or changed")
					}
					if dbCount(t, pool, `SELECT COUNT(*) FROM installs WHERE install_id=$1::uuid`, freshInstall) != 0 {
						t.Fatal("expired hollow sign-in created an installation")
					}
				} else {
					if err != nil || result.AccountID != source || !result.DeletionCancelled || result.DefaultVaultID != nil {
						t.Fatalf("hollow recovery switched accounts: result=%+v err=%v", result, err)
					}
					if gracePending(t, pool, source) != nil {
						t.Fatal("original hollow account remains pending after proved recovery")
					}
					graceRevoked(t, s, sessionOf(t, result), false)
					if dbCount(t, pool, `SELECT COUNT(*) FROM installs WHERE install_id=$1::uuid
					 AND account_deleted_at IS NULL AND deletion_account_id IS NULL`, originalInstall) != 1 {
						t.Fatal("original hollow installation remained retired")
					}
				}
				graceRevoked(t, s, old, true)
				if dbCount(t, pool, `SELECT COUNT(*) FROM account_identities WHERE provider=$1 AND provider_sub=$2 AND account_id=$3::uuid`, provider, sub, source) != 1 {
					t.Fatal("pending hollow identity was moved into another account")
				}
				if dbCount(t, pool, `SELECT COUNT(*) FROM accounts WHERE id=$1::uuid AND name='Target preserved' AND phone_e164 IS NULL`, target) != 1 ||
					dbCount(t, pool, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND owner_account_id=$2::uuid`, targetVault, target) != 1 {
					t.Fatal("hollow recovery touched same-email target's profile or vault")
				}
			})
		}
	}
}

func TestAccountDeletionGraceUnknownCredentialOwnerFailsClosed(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account, install, token := seedDeletionSession(t, pool)
	s := NewService(pool, "test-client", emailTestSecret)
	graceExec(t, pool, `ALTER TABLE auth_credentials ALTER COLUMN account_id DROP NOT NULL`)
	graceExec(t, pool, `UPDATE auth_credentials SET account_id=NULL WHERE install_id=$1::uuid`, install)
	graceExec(t, pool, `UPDATE installs SET account_id=NULL WHERE install_id=$1::uuid`, install)
	// A signed A claim must not make an unattributed credential belong to A.
	claims := graceClaims(t, token)
	graceRevoked(t, s, claims, true)
	if _, err := s.RequestAccountDeletion(t.Context(), claims); !errors.Is(err, ErrDeletionSessionEnded) {
		t.Fatalf("unknown credential owner scheduled deletion: %v", err)
	}
	if gracePending(t, pool, account) != nil || dbCount(t, pool, `SELECT COUNT(*) FROM installs
	 WHERE install_id=$1::uuid AND account_deleted_at IS NOT NULL`, install) != 0 {
		t.Fatal("unattributed claims changed an account or retired an install")
	}
}
