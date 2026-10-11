package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"

	"github.com/matee/kaata-backend/internal/mail"
	"github.com/matee/kaata-backend/internal/testutil"
)

// The final review's rules for Kaata email accounts (docs/kaata-accounts.md
// §4-§6, §10), against the real schema.

// seedSession binds an install to an account with one live credential, the
// way a sign-in before this release left it (session epoch 0).
func seedSession(t *testing.T, pool *pgxpool.Pool, install, provider, sub, accountID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO installs (install_id, account_id) VALUES ($1, $2::uuid)
		ON CONFLICT (install_id) DO UPDATE SET account_id = EXCLUDED.account_id
	`, install, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_credentials (install_id, provider, provider_sub, account_id) VALUES ($1, $2, $3, $4::uuid)
	`, install, provider, sub, accountID); err != nil {
		t.Fatal(err)
	}
}

func wrongCodeFor(real string) string {
	if real == "000000" {
		return "000001"
	}
	return "000000"
}

// setPassword gives a seeded Google/Apple account its first password.
func setPassword(t *testing.T, svc *Service, pool *pgxpool.Pool, accountID, install, to string) {
	t.Helper()
	ctx := context.Background()
	if err := svc.PasswordSetupStart(ctx, accountID, "", "en"); err != nil {
		t.Fatalf("setup start: %v", err)
	}
	if _, err := svc.PasswordSetupVerify(ctx, accountID, install, lastCode(t, pool, to), goodPassword, "en"); err != nil {
		t.Fatalf("setup verify: %v", err)
	}
}

func TestEmailKeySQLMatchesGo(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	checked := 0
	for _, addr := range []string{
		"Ahmad.Shop+kaata@Gmail.com", "ahmad@googlemail.com", "A.B.C+x@googlemail.com",
		"bob+orders@outlook.com", "BOB@Outlook.com", "owner@shop.af", "x+y+z@mail.example.org",
		"first.last@company.co.uk", "+tag@shop.af",
	} {
		_, goKey, err := parseAccountEmail(addr)
		if err != nil {
			continue
		}
		var sqlKey string
		if err := pool.QueryRow(ctx, `SELECT kaata_email_key($1)`, addr).Scan(&sqlKey); err != nil {
			t.Fatal(err)
		}
		if sqlKey != goKey {
			t.Errorf("%q: SQL key %q, Go key %q", addr, sqlKey, goKey)
		}
		checked++
	}
	if checked < 8 {
		t.Fatalf("only %d addresses parsed", checked)
	}
	var none *string
	if err := pool.QueryRow(ctx, `SELECT kaata_email_key('no-at-sign')`).Scan(&none); err != nil || none != nil {
		t.Fatalf("an address without @ has no key: %v %v", none, err)
	}
}

func TestEmailCodeExpires(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	if err := svc.EmailSignUpStart(ctx, "late@shop.af", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	code := lastCode(t, pool, "late@shop.af")
	if _, err := pool.Exec(ctx, `UPDATE email_codes SET expires_at = NOW() - INTERVAL '1 second'`); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), "late@shop.af", code, goodPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("an expired code: %v", err)
	}
}

func TestOnlyTheNewestThreeCodesAreChecked(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	email := "four@shop.af"
	var codes []string
	for i := 0; i < 4; i++ {
		if i > 0 {
			ageMailThrottle(t, pool)
		}
		if err := svc.EmailSignUpStart(ctx, email, "en", anyClient()); err != nil {
			t.Fatal(err)
		}
		codes = append(codes, lastCode(t, pool, email))
	}
	for _, c := range codes[1:] {
		if c == codes[0] {
			t.Skip("two random codes collided; the run proves nothing")
		}
	}
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), email, codes[0], goodPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("the fourth-newest code must be dead: %v", err)
	}
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), email, codes[1], goodPassword, SwitchOptions{}); err != nil {
		t.Fatalf("the third-newest code still works: %v", err)
	}
}

func TestConcurrentVerifiesOfOneCodeOneWins(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	email := "race@shop.af"
	if err := svc.EmailSignUpStart(ctx, email, "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	code := lastCode(t, pool, email)
	errs := make([]error, 4)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = svc.EmailSignUpVerify(ctx, uuid.NewString(), email, code, goodPassword, SwitchOptions{})
		}(i)
	}
	wg.Wait()
	wins := 0
	for _, err := range errs {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, ErrInvalidCode), errors.Is(err, ErrAccountExists):
		default:
			t.Fatalf("unexpected answer: %v", err)
		}
	}
	if wins != 1 || dbCount(t, pool, `SELECT COUNT(*) FROM accounts`) != 1 {
		t.Fatalf("%d verifies won, %d accounts; want exactly one", wins, dbCount(t, pool, `SELECT COUNT(*) FROM accounts`))
	}
}

func TestEmailSignInRehashesAWeakerHash(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	res := signUp(t, svc, pool, "rehash@shop.af", uuid.NewString())
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	key := argon2.IDKey([]byte(canonicalizePassword(goodPassword)), salt, 1, 4096, 1, 32)
	weak := fmt.Sprintf("$argon2id$v=%d$m=4096,t=1,p=1$%s$%s", argon2.Version,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
	if _, err := pool.Exec(ctx, `UPDATE account_passwords SET password_hash = $2 WHERE account_id = $1::uuid`,
		res.AccountID, weak); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "rehash@shop.af", goodPassword, SwitchOptions{}); err != nil {
		t.Fatalf("sign-in with the weaker hash: %v", err)
	}
	var stored string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM account_passwords WHERE account_id = $1::uuid`,
		res.AccountID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("the hash was not upgraded: %q", stored)
	}
}

// Refused attempts are not recorded, so the advertised wait is exact.
func TestAttemptThrottleAdmitsAtRetryAfter(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	signUp(t, svc, pool, "wait@shop.af", uuid.NewString())

	for i := 0; i < loginMaxAttempts; i++ {
		if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "wait@shop.af", otherPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	var att *AttemptsError
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "wait@shop.af", goodPassword, SwitchOptions{}); !errors.As(err, &att) {
		t.Fatalf("the 11th attempt must wait, even with the right password: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_throttle_events WHERE scope = 'login'`); n != loginMaxAttempts {
		t.Fatalf("%d attempts recorded, want only the %d admitted ones", n, loginMaxAttempts)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_throttle_events SET created_at = created_at - make_interval(secs => $1)
		WHERE scope = 'login'`, att.RetryAfter.Seconds()+1); err != nil {
		t.Fatal(err)
	}
	res, err := svc.EmailSignIn(ctx, uuid.NewString(), "wait@shop.af", goodPassword, SwitchOptions{})
	if err != nil {
		t.Fatalf("at the advertised time the next attempt is admitted: %v", err)
	}

	// The same rule guards password changes.
	sess := sessionOf(t, res)
	for i := 0; i < loginMaxAttempts; i++ {
		if _, err := svc.ChangePassword(ctx, sess, otherPassword, "Nw7k-Qp2z-Lm4x", "en"); !errors.Is(err, ErrWrongPassword) {
			t.Fatalf("change attempt %d: %v", i, err)
		}
	}
	if _, err := svc.ChangePassword(ctx, sess, goodPassword, "Nw7k-Qp2z-Lm4x", "en"); !errors.As(err, &att) {
		t.Fatalf("the 11th change must wait: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_throttle_events SET created_at = created_at - make_interval(secs => $1)
		WHERE scope = 'pw_change'`, att.RetryAfter.Seconds()+1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ChangePassword(ctx, sess, goodPassword, "Nw7k-Qp2z-Lm4x", "en"); err != nil {
		t.Fatalf("the change after the wait: %v", err)
	}
}

// Once the global budget is spent every start answers the same, whatever
// owns the address, and the refused requests record nothing.
func TestStartsAnswerAlikeWhenTheBudgetIsSpent(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool, "test-client-id", emailTestSecret)
	svc.SetMailOutbox(mail.NewOutbox(pool, &captureSender{}, 1, 0))
	signUp(t, svc, pool, "haspw@shop.af", uuid.NewString()) // spends the budget
	seedGoogleAccount(t, pool, "gonly@gmail.com", "g-parity")
	// Past the per-address minute limit (it answers alike for every address).
	ageMailThrottle(t, pool)
	queued := dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox`)
	for _, addr := range []string{"haspw@shop.af", "gonly@gmail.com", "nobody@shop.af"} {
		for i := 0; i < 2; i++ {
			if err := svc.EmailResetStart(ctx, addr, "en", anyClient()); !errors.Is(err, mail.ErrUnavailable) {
				t.Fatalf("reset %s #%d: %v", addr, i, err)
			}
			if err := svc.EmailSignUpStart(ctx, addr, "en", anyClient()); !errors.Is(err, mail.ErrUnavailable) {
				t.Fatalf("sign-up %s #%d: %v", addr, i, err)
			}
		}
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox`); n != queued {
		t.Fatalf("refused starts queued mail (%d → %d)", queued, n)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_throttle_events WHERE scope = 'mail'`); n != 1 {
		t.Fatalf("%d address rows, want only the admitted sign-up's", n)
	}
}

func TestPerClientStartBudget(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	client := ClientKey("203.0.113.7")
	perHour := mailClientLimits[0].max
	for i := 0; i < perHour; i++ {
		if err := svc.EmailSignUpStart(ctx, fmt.Sprintf("p%d@shop.af", i), "en", client); err != nil {
			t.Fatalf("start %d: %v", i, err)
		}
	}
	var limited *RateLimitedError
	if err := svc.EmailSignUpStart(ctx, "past@shop.af", "en", client); !errors.As(err, &limited) || limited.RetryAfter <= 0 {
		t.Fatalf("one start past the client's hour: %v", err)
	}
	if err := svc.EmailResetStart(ctx, "past@shop.af", "en", client); !errors.As(err, &limited) {
		t.Fatalf("reset shares the client budget: %v", err)
	}
	if err := svc.EmailSignUpStart(ctx, "past@shop.af", "en", ClientKey("203.0.113.8")); err != nil {
		t.Fatalf("another client: %v", err)
	}
	if ClientKey("2001:db8:1:2::1") != ClientKey("2001:db8:1:2:ffff::9") ||
		ClientKey("2001:db8:1:2::1") == ClientKey("2001:db8:1:3::1") ||
		ClientKey("::ffff:203.0.113.7") != ClientKey("203.0.113.7") {
		t.Fatal("an IPv6 /64 is one client, an IPv4 address is one client")
	}
}

func TestSignUpLeavesBudgetForRecovery(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool, "test-client-id", emailTestSecret)
	svc.SetMailOutbox(mail.NewOutbox(pool, &captureSender{}, 5, 0)) // sign-up may use 4
	for i := 0; i < 4; i++ {
		if err := svc.EmailSignUpStart(ctx, fmt.Sprintf("s%d@shop.af", i), "en", anyClient()); err != nil {
			t.Fatalf("sign-up %d: %v", i, err)
		}
	}
	if err := svc.EmailSignUpStart(ctx, "s4@shop.af", "en", anyClient()); !errors.Is(err, mail.ErrUnavailable) {
		t.Fatalf("sign-up past its share: %v", err)
	}
	if err := svc.EmailResetStart(ctx, "someone@shop.af", "en", anyClient()); err != nil {
		t.Fatalf("recovery keeps its reserve: %v", err)
	}
	if err := svc.EmailResetStart(ctx, "someone.else@shop.af", "en", anyClient()); !errors.Is(err, mail.ErrUnavailable) {
		t.Fatalf("past the whole budget: %v", err)
	}
}

func TestSetupUsesTheAccountsOwnEmail(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	acct := seedGoogleAccount(t, pool, "Owner.Name@gmail.com", "g-own")
	if err := svc.PasswordSetupStart(ctx, acct, "thief@evil.af", "en"); !errors.Is(err, ErrEmailFixed) {
		t.Fatalf("a stolen session names its own address: %v", err)
	}
	if err := svc.PasswordSetupStart(ctx, acct, "ownername@gmail.com", "en"); err != nil {
		t.Fatalf("the same mailbox typed differently: %v", err)
	}
	if ms := mailsTo(t, pool, "Owner.Name@gmail.com"); len(ms) != 1 || !sixDigits.MatchString(ms[0].text) {
		t.Fatalf("the code goes to the account's own email: %+v", ms)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox WHERE to_addr = 'thief@evil.af'`); n != 0 {
		t.Fatal("nothing may reach the other address")
	}
	if me, err := svc.AccountMe(ctx, acct); err != nil || me.SetupEmail != "Owner.Name@gmail.com" {
		t.Fatalf("me.setup_email %q %v", me.SetupEmail, err)
	}
	relay := seedGoogleAccount(t, pool, "q7x2@privaterelay.appleid.com", "g-relay-me")
	if me, err := svc.AccountMe(ctx, relay); err != nil || me.SetupEmail != "" {
		t.Fatalf("a relay account names its address: %q %v", me.SetupEmail, err)
	}
}

// Several accounts cannot each get a fresh budget against one address.
func TestSetupFailuresSpendTheAddressBudget(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	r1 := seedGoogleAccount(t, pool, "r1@privaterelay.appleid.com", "g-r1")
	r2 := seedGoogleAccount(t, pool, "r2@privaterelay.appleid.com", "g-r2")
	// A guess counts against the address while a code for it is live; a code
	// dies after codeMaxAttempts, so spending the budget takes two codes.
	for round := 0; round < codeFailBudget/codeMaxAttempts; round++ {
		if round > 0 {
			ageMailThrottle(t, pool)
		}
		if err := svc.PasswordSetupStart(ctx, r1, "victim@shop.af", "en"); err != nil {
			t.Fatal(err)
		}
		wrong := wrongCodeFor(lastCode(t, pool, "victim@shop.af"))
		for i := 0; i < codeMaxAttempts; i++ {
			if _, err := svc.PasswordSetupVerify(ctx, r1, uuid.NewString(), wrong, goodPassword, "en"); !errors.Is(err, ErrInvalidCode) {
				t.Fatalf("round %d, wrong code %d: %v", round, i, err)
			}
		}
	}
	ageMailThrottle(t, pool)
	if err := svc.PasswordSetupStart(ctx, r2, "victim@shop.af", "en"); err != nil {
		t.Fatal(err)
	}
	var att *AttemptsError
	if _, err := svc.PasswordSetupVerify(ctx, r2, uuid.NewString(), wrongCodeFor(lastCode(t, pool, "victim@shop.af")),
		goodPassword, "en"); !errors.As(err, &att) {
		t.Fatalf("the address's budget is spent for every account: %v", err)
	}
}

func TestRemovePassword(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	acct := seedGoogleAccount(t, pool, "remove.me@gmail.com", "g-rm")
	googlePhone := uuid.NewString()
	seedSession(t, pool, googlePhone, ProviderGoogle, "g-rm", acct)
	setPassword(t, svc, pool, acct, googlePhone, "remove.me@gmail.com")
	if _, err := svc.SetUsername(ctx, acct, "remove_me"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "remove_me", goodPassword, SwitchOptions{}); err != nil {
		t.Fatalf("password sign-in on another phone: %v", err)
	}

	if err := svc.RemovePassword(ctx, acct, ProviderEmail, "en"); !errors.Is(err, ErrProviderSessionRequired) {
		t.Fatalf("an email session cannot remove the password: %v", err)
	}
	if err := svc.RemovePassword(ctx, acct, ProviderGoogle, "en"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	for sql, want := range map[string]int{
		`SELECT COUNT(*) FROM account_passwords WHERE account_id = $1::uuid`:                          0,
		`SELECT COUNT(*) FROM account_identities WHERE account_id = $1::uuid AND provider = 'email'`:  0,
		`SELECT COUNT(*) FROM accounts WHERE id = $1::uuid AND username IS NOT NULL`:                  0,
		`SELECT COUNT(*) FROM auth_credentials WHERE account_id = $1::uuid AND provider = 'email'`:    0,
		`SELECT COUNT(*) FROM auth_credentials WHERE account_id = $1::uuid AND provider = 'google'`:   1,
		`SELECT COUNT(*) FROM email_codes WHERE account_id = $1::uuid AND consumed_at IS NULL`:        0,
		`SELECT COUNT(*) FROM account_identities WHERE account_id = $1::uuid AND provider = 'google'`: 1,
	} {
		if n := dbCount(t, pool, sql, acct); n != want {
			t.Errorf("%s = %d, want %d", sql, n, want)
		}
	}
	ms := mailsTo(t, pool, "remove.me@gmail.com")
	if last := ms[len(ms)-1]; !strings.Contains(last.subject, "removed") {
		t.Fatalf("the removal notice is missing: %+v", last)
	}
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "remove.me@gmail.com", goodPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("the removed password still signs in: %v", err)
	}
	if err := svc.RemovePassword(ctx, acct, ProviderGoogle, "en"); err != nil {
		t.Fatalf("removing again succeeds: %v", err)
	}
	if me, err := svc.AccountMe(ctx, acct); err != nil || me.HasPassword || me.SetupEmail != "remove.me@gmail.com" {
		t.Fatalf("me after removal %+v %v", me, err)
	}
	only := signUp(t, svc, pool, "only@shop.af", uuid.NewString())
	if err := svc.RemovePassword(ctx, only.AccountID, ProviderGoogle, "en"); !errors.Is(err, ErrProviderSessionRequired) {
		t.Fatalf("an email-only account keeps its only sign-in: %v", err)
	}
}

func TestPasswordElsewhereNotice(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	acct := seedGoogleAccount(t, pool, "first@gmail.com", "g-else")
	setPassword(t, svc, pool, acct, uuid.NewString(), "first@gmail.com")
	// Google later reports another address for the account.
	if _, err := pool.Exec(ctx, `UPDATE accounts SET email = 'second@gmail.com', email_normalized = 'second@gmail.com'
		WHERE id = $1::uuid`, acct); err != nil {
		t.Fatal(err)
	}
	ageMailThrottle(t, pool)
	if err := svc.EmailResetStart(ctx, "second@gmail.com", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	ageMailThrottle(t, pool)
	if err := svc.EmailSignUpStart(ctx, "second@gmail.com", "fa", anyClient()); err != nil {
		t.Fatal(err)
	}
	ms := mailsTo(t, pool, "second@gmail.com")
	if len(ms) != 2 {
		t.Fatalf("want two notices, got %+v", ms)
	}
	for _, m := range ms {
		if !strings.Contains(m.text, "f***@gmail.com") || sixDigits.MatchString(m.text) || strings.Contains(m.text, "{address}") {
			t.Fatalf("the notice must name the masked sign-in address and carry no code: %q", m.text)
		}
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_codes WHERE email_key = 'second@gmail.com'`); n != 0 {
		t.Fatal("no code for an address that is not the sign-in address")
	}
}

func TestPlusTagAddressFindsAGoogleAccount(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	seedGoogleAccount(t, pool, "bob@outlook.com", "g-bob")
	if err := svc.EmailSignUpStart(ctx, "bob+kaata@outlook.com", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_codes`); n != 0 {
		t.Fatal("a +tag variant of a Google account's address must not get a sign-up code")
	}
	if ms := mailsTo(t, pool, "bob@outlook.com"); len(ms) != 1 || !strings.Contains(ms[0].subject, "Google or Apple") {
		t.Fatalf("the account's own address gets the notice: %+v", ms)
	}
}

func TestSessionEpochs(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	revoked := func(c *SessionClaims) bool {
		t.Helper()
		r, err := svc.CheckCredentialRevoked(ctx, c.InstallID, c.Provider, c.AccountID, c.Epoch)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	parse := func(tok string) *SessionClaims {
		t.Helper()
		c, err := ParseSession(emailTestSecret, tok)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	install := uuid.NewString()
	c1 := sessionOf(t, signUp(t, svc, pool, "epoch@shop.af", install))
	if revoked(c1) {
		t.Fatal("a new session authorizes")
	}
	// A reset on this phone ends every older JWT of it, copies included.
	ageMailThrottle(t, pool)
	if err := svc.EmailResetStart(ctx, "epoch@shop.af", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	res2, err := svc.EmailResetVerify(ctx, install, "epoch@shop.af", lastCode(t, pool, "epoch@shop.af"), otherPassword, "en", SwitchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c2 := sessionOf(t, res2)
	if c2.Epoch == c1.Epoch || !revoked(c1) || revoked(c2) {
		t.Fatalf("after a reset: old epoch %d revoked=%v, new epoch %d revoked=%v", c1.Epoch, revoked(c1), c2.Epoch, revoked(c2))
	}
	// So does a sign-in on the same phone.
	res3, err := svc.EmailSignIn(ctx, install, "epoch@shop.af", otherPassword, SwitchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c3 := sessionOf(t, res3)
	if !revoked(c2) || revoked(c3) {
		t.Fatal("a sign-in must end the install's older JWTs")
	}
	// A password change keeps this session: its JWT is the same session.
	tok, err := svc.ChangePassword(ctx, c3, otherPassword, "Nw7k-Qp2z-Lm4x", "en")
	if err != nil {
		t.Fatal(err)
	}
	if c4 := parse(tok); c4.Epoch != c3.Epoch || revoked(c3) || revoked(c4) {
		t.Fatal("a password change keeps the current session")
	}
	// A check-in refresh keeps the epoch.
	refreshed, err := svc.IssueRefreshJWT(c3)
	if err != nil {
		t.Fatal(err)
	}
	if cr := parse(refreshed); cr.Epoch != c3.Epoch || revoked(cr) {
		t.Fatal("a refreshed JWT is the same session")
	}
	// Legacy rows and tokens are epoch 0 and keep matching.
	legacy := seedGoogleAccount(t, pool, "legacy@gmail.com", "g-legacy")
	legacyInstall := uuid.NewString()
	seedSession(t, pool, legacyInstall, ProviderGoogle, "g-legacy", legacy)
	old, err := SignSession(emailTestSecret, legacy, legacyInstall, ProviderGoogle, "g-legacy")
	if err != nil {
		t.Fatal(err)
	}
	if lc := parse(old); lc.Epoch != 0 || revoked(lc) {
		t.Fatal("a legacy session keeps working until the next sign-in")
	}
}

func TestChangePasswordReplay(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	res := signUp(t, svc, pool, "retry.change@shop.af", uuid.NewString())
	sess := sessionOf(t, res)
	if _, err := svc.ChangePassword(ctx, sess, goodPassword, otherPassword, "en"); err != nil {
		t.Fatal(err)
	}
	readHash := func() string {
		var h string
		if err := pool.QueryRow(ctx, `SELECT password_hash FROM account_passwords WHERE account_id = $1::uuid`,
			res.AccountID).Scan(&h); err != nil {
			t.Fatal(err)
		}
		return h
	}
	hash := readHash()
	notices := dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox WHERE to_addr = 'retry.change@shop.af'`)
	// The reply was lost; the app sends the same request again.
	tok, err := svc.ChangePassword(ctx, sess, goodPassword, otherPassword, "en")
	if err != nil || tok == "" {
		t.Fatalf("the retried change: %q %v", tok, err)
	}
	if readHash() != hash || dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox WHERE to_addr = 'retry.change@shop.af'`) != notices {
		t.Fatal("the replay must change nothing")
	}
	if _, err := svc.ChangePassword(ctx, sess, goodPassword, "Kp4-Different-Zx", "en"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("another new password is still a wrong current one: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_passwords SET updated_at = NOW() - INTERVAL '16 minutes'`); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ChangePassword(ctx, sess, goodPassword, otherPassword, "en"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("after the window the repeat is a wrong current password: %v", err)
	}
}

func TestAccountRoutesNeverAnswer401ForACode(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	acct := seedGoogleAccount(t, pool, "http.me@gmail.com", "g-http")
	install := uuid.NewString()
	seedSession(t, pool, install, ProviderGoogle, "g-http", acct)
	if err := svc.PasswordSetupStart(ctx, acct, "", "en"); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(svc)
	call := func(method, target, body string, claims *SessionClaims, handle http.HandlerFunc) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), claimsContextKey, claims))
		rec := httptest.NewRecorder()
		handle(rec, req)
		return rec
	}
	google := &SessionClaims{AccountID: acct, InstallID: install, Provider: ProviderGoogle, ProviderSub: "g-http"}
	wrong := wrongCodeFor(lastCode(t, pool, "http.me@gmail.com"))
	rec := call(http.MethodPost, "/v1/account/password/setup/verify",
		`{"code":"`+wrong+`","new_password":"`+goodPassword+`","lang":"en"}`, google, h.PasswordSetupVerify)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_code"`) {
		t.Fatalf("a wrong setup code: %d %s", rec.Code, rec.Body.String())
	}
	email := &SessionClaims{AccountID: acct, InstallID: install, Provider: ProviderEmail, ProviderSub: acct}
	rec = call(http.MethodDelete, "/v1/account/password?lang=fa", "", email, h.RemovePassword)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"provider_session_required"`) {
		t.Fatalf("removal from an email session: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/v1/account/password/setup/start", `{"email":"thief@evil.af","lang":"en"}`, google,
		h.PasswordSetupStart)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"email_fixed"`) {
		t.Fatalf("setup to another address: %d %s", rec.Code, rec.Body.String())
	}
}

// A reset refused as a different account writes nothing; a lost reply replays.
func TestResetDifferentAccountWritesNothingAndReplays(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	phone1, phone2, phone3 := uuid.NewString(), uuid.NewString(), uuid.NewString()
	a := signUp(t, svc, pool, "reset.a@shop.af", phone1)
	if _, err := svc.EmailSignIn(ctx, phone2, "reset.a@shop.af", goodPassword, SwitchOptions{}); err != nil {
		t.Fatal(err)
	}
	b := signUp(t, svc, pool, "reset.b@shop.af", uuid.NewString())
	ageMailThrottle(t, pool)
	if err := svc.EmailResetStart(ctx, "reset.a@shop.af", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	code := lastCode(t, pool, "reset.a@shop.af")
	var hash string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM account_passwords WHERE account_id = $1::uuid`,
		a.AccountID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	notices := dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox WHERE to_addr = 'reset.a@shop.af'`)

	var diff *DifferentAccountError
	if _, err := svc.EmailResetVerify(ctx, phone3, "reset.a@shop.af", code, otherPassword, "en",
		SwitchOptions{CurrentAccountID: b.AccountID}); !errors.As(err, &diff) {
		t.Fatalf("want different_account: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM account_passwords WHERE account_id = $1::uuid AND password_hash = $2`,
		a.AccountID, hash); n != 1 {
		t.Fatal("the refused reset changed the password")
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_credentials WHERE account_id = $1::uuid`, a.AccountID); n != 2 {
		t.Fatalf("the refused reset signed phones out (%d left)", n)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_codes WHERE purpose = 'reset' AND consumed_at IS NULL`); n != 1 {
		t.Fatal("the refused reset used the code")
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox WHERE to_addr = 'reset.a@shop.af'`); n != notices {
		t.Fatal("the refused reset sent the security notice")
	}

	res, err := svc.EmailResetVerify(ctx, phone3, "reset.a@shop.af", code, otherPassword, "en",
		SwitchOptions{CurrentAccountID: b.AccountID, AllowSwitch: true})
	if err != nil || res.AccountID != a.AccountID {
		t.Fatalf("after choosing to switch: %v", err)
	}
	again, err := svc.EmailResetVerify(ctx, phone3, "reset.a@shop.af", code, otherPassword, "en",
		SwitchOptions{CurrentAccountID: a.AccountID})
	if err != nil || again.AccountID != a.AccountID {
		t.Fatalf("the retry of a reset whose reply was lost: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox WHERE to_addr = 'reset.a@shop.af'`); n != notices+1 {
		t.Fatalf("one security notice, not %d", n-notices)
	}
}

func TestTailAnswersRetiredBeforeDifferentAccount(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	a := seedGoogleAccount(t, pool, "ret.a@gmail.com", "g-ret-a")
	b := seedGoogleAccount(t, pool, "ret.b@gmail.com", "g-ret-b")
	install := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id, account_deleted_at) VALUES ($1, NOW())`, install); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _, err = svc.completeSignIn(ctx, tx, signInTail{provider: ProviderGoogle, providerSub: "g-ret-b",
		installID: install, accountID: b, sw: SwitchOptions{CurrentAccountID: a}})
	if !errors.Is(err, ErrInstallRetired) {
		t.Fatalf("a retired install answers 410 before any keep/wipe prompt: %v", err)
	}
}

// The hollow-duplicate heal moves an identity off a husk; the husk is still
// the phone's own account, so nobody is asked to keep or wipe their data.
func TestHollowDuplicateHealIsNotADifferentAccount(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	googleID, _ := resolveInTx(t, pool, ProviderGoogle, "sub-heal-tail-g", googleProfile("healtail@gmail.com", "Healed"))
	seedVaultOwnedBy(t, pool, googleID)
	var husk string
	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (email, email_normalized, email_verified, name)
		VALUES ('healtail@gmail.com', $1, TRUE, 'Healed') RETURNING id::text
	`, normalizeEmail("healtail@gmail.com")).Scan(&husk); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_identities (account_id, provider, provider_sub)
		VALUES ($1::uuid, 'apple', 'sub-heal-tail-a')`, husk); err != nil {
		t.Fatal(err)
	}
	install := uuid.NewString()
	seedSession(t, pool, install, ProviderApple, "sub-heal-tail-a", husk)

	res, _, err := svc.providerSignIn(ctx, appleProfile("healtail@gmail.com", true, "Healed"), signInTail{
		provider: ProviderApple, providerSub: "sub-heal-tail-a", installID: install,
		sw: SwitchOptions{CurrentAccountID: husk},
	})
	if err != nil || res.AccountID != googleID {
		t.Fatalf("the healed sign-in: %v (account %s, want %s)", err, res.AccountID, googleID)
	}
	var bound string
	if err := pool.QueryRow(ctx, `SELECT account_id::text FROM installs WHERE install_id = $1`, install).Scan(&bound); err != nil || bound != googleID {
		t.Fatalf("install bound to %q: %v", bound, err)
	}
	other := seedGoogleAccount(t, pool, "someone.else@gmail.com", "g-else-tail")
	var diff *DifferentAccountError
	if _, _, err := svc.providerSignIn(ctx, appleProfile("healtail@gmail.com", true, "Healed"), signInTail{
		provider: ProviderApple, providerSub: "sub-heal-tail-a", installID: install,
		sw: SwitchOptions{CurrentAccountID: other},
	}); !errors.As(err, &diff) {
		t.Fatalf("a genuinely different account still asks: %v", err)
	}
}

func TestResolveDefaultVault(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	run := func(accountID string, p *PendingVaultRegistration) (*string, error) {
		t.Helper()
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		id, err := resolveDefaultVault(ctx, tx, accountID, p)
		if err == nil {
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
		}
		return id, err
	}
	acct := seedGoogleAccount(t, pool, "vaults@gmail.com", "g-vaults")
	if id, err := run(acct, nil); err != nil || id != nil {
		t.Fatalf("no vault, nothing pending: %v %v", id, err)
	}
	pending := uuid.NewString()
	id, err := run(acct, &PendingVaultRegistration{ID: pending, Name: "Shop",
		CreatedAtMS: time.Now().Add(-2 * 365 * 24 * time.Hour).UnixMilli()})
	if err != nil || id == nil || *id != pending {
		t.Fatalf("the pending kaata becomes the default: %v %v", id, err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM vaults WHERE vault_id = $1::uuid AND created_at > NOW() - INTERVAL '1 minute'`,
		pending); n != 1 {
		t.Fatal("an out-of-window created_at is clamped to now")
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM vault_members WHERE vault_id = $1::uuid AND role = 'owner'`, pending); n != 1 {
		t.Fatal("the owner membership is seeded")
	}
	for _, p := range []*PendingVaultRegistration{
		{ID: pending, Name: "Shop"},           // the same id again
		{ID: uuid.NewString(), Name: "Other"}, // another phone's local default
	} {
		if id, err := run(acct, p); err != nil || id == nil || *id != pending {
			t.Fatalf("the existing default wins: %v %v", id, err)
		}
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM vaults WHERE owner_account_id = $1::uuid`, acct); n != 1 {
		t.Fatalf("%d vaults, want one default", n)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM vault_members WHERE account_id = $1::uuid`, acct); n != 1 {
		t.Fatal("no second membership")
	}

	fresh := seedGoogleAccount(t, pool, "vault.fresh@gmail.com", "g-vf")
	theirs := seedVaultOwnedBy(t, pool, seedGoogleAccount(t, pool, "vault.other@gmail.com", "g-vo"))
	for _, c := range []struct {
		p    *PendingVaultRegistration
		want string
	}{
		{&PendingVaultRegistration{ID: theirs, Name: "X"}, "vault_id collides"},
		{&PendingVaultRegistration{ID: "not-a-uuid", Name: "X"}, "pending_vault_registration"},
		{&PendingVaultRegistration{ID: uuid.NewString(), Name: "  "}, "pending_vault_registration"},
	} {
		if _, err := run(fresh, c.p); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%+v: %v, want %q (handler.go maps it by this text)", c.p, err, c.want)
		}
	}
}

func TestUnknownIdentifierWaitsForAHashSlotLikeAKnownOne(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	signUp(t, svc, pool, "known@shop.af", uuid.NewString())
	for i := 0; i < cap(hashSlots); i++ {
		hashSlots <- struct{}{}
	}
	defer func() {
		for i := 0; i < cap(hashSlots); i++ {
			<-hashSlots
		}
	}()
	if dummyHash() == "" {
		t.Fatal("the dummy hash needs no slot")
	}
	for _, id := range []string{"known@shop.af", "unknown@shop.af"} {
		if _, err := svc.EmailSignIn(ctx, uuid.NewString(), id, goodPassword, SwitchOptions{}); !errors.Is(err, ErrHashBusy) {
			t.Fatalf("%s under load: %v, want busy for known and unknown alike", id, err)
		}
	}
}

// A Dari name keeps its zero-width non-joiner; invisible spoofing characters go.
func TestAccountNameKeepsDariSpelling(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	res := signUp(t, svc, pool, "dari.name@shop.af", uuid.NewString())
	want := "عبدالله\u200cزاده"
	got, err := svc.SetAccountName(ctx, res.AccountID, " "+want+"\u200b\u202e ")
	if err != nil || got != want {
		t.Fatalf("name %q %v, want %q", got, err, want)
	}
}

func TestSignInDropsALeadingAt(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	res := signUp(t, svc, pool, "handle@shop.af", uuid.NewString())
	if _, err := svc.SetUsername(ctx, res.AccountID, "ali_shop"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"@ali_shop", " @Ali_Shop "} {
		if _, err := svc.EmailSignIn(ctx, uuid.NewString(), id, goodPassword, SwitchOptions{}); err != nil {
			t.Fatalf("%q: %v", id, err)
		}
	}
}

// A refusal names the LONGEST wait, so retrying at retry_after_s is admitted.
func TestRefusalReportsTheLongestWait(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	_, key, err := parseAccountEmail("busy@shop.af")
	if err != nil {
		t.Fatal(err)
	}
	addr := svc.throttleKey(throttleMail, key)
	// Ten requests in the last day, the newest 20 s ago: the minute and the day
	// are both full, and the day is the real wait.
	for i := 0; i < 10; i++ {
		age := fmt.Sprintf("%d seconds", 7200+i*600)
		if i == 0 {
			age = "20 seconds"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO auth_throttle_events (scope, key, created_at)
			VALUES ($1, $2, NOW() - $3::interval)`, throttleMail, addr, age); err != nil {
			t.Fatal(err)
		}
	}
	var thr *ThrottledError
	if err := svc.EmailSignUpStart(ctx, "busy@shop.af", "en", anyClient()); !errors.As(err, &thr) {
		t.Fatalf("want too_many_requests: %v", err)
	}
	if thr.Limit != "day" || thr.RetryAfter < time.Hour {
		t.Fatalf("refusal %q after %s; want the day window and its long wait", thr.Limit, thr.RetryAfter)
	}
}

// Security notices are coalesced per recipient and counted in the global
// mail budget, so repeated password changes cannot spend the provider's quota.
func TestPasswordChangeNoticesAreCoalesced(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	res := signUp(t, svc, pool, "noisy@shop.af", uuid.NewString())
	sess := sessionOf(t, res)
	notices := func() int {
		return dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox WHERE to_addr = 'noisy@shop.af' AND subject LIKE '%changed%'`)
	}
	pw := []string{goodPassword, otherPassword}
	for i := 0; i < 5; i++ {
		if _, err := svc.ChangePassword(ctx, sess, pw[i%2], pw[(i+1)%2], "en"); err != nil {
			t.Fatalf("change %d: %v", i, err)
		}
	}
	if n := notices(); n != 1 {
		t.Fatalf("%d notices for 5 changes in a row, want 1", n)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_throttle_events SET created_at = created_at - INTERVAL '11 minutes'
		WHERE scope = $1`, throttleNotice); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ChangePassword(ctx, sess, pw[1], pw[0], "en"); err != nil {
		t.Fatal(err)
	}
	if n := notices(); n != 2 {
		t.Fatalf("after 10 minutes a change is told again: %d notices", n)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_throttle_events WHERE scope = $1`, throttleMailGlobal); n != 3 {
		t.Fatalf("the global mail budget counts the sign-up code and both notices: %d", n)
	}

	// With the global budget spent, notices are skipped and the change still works.
	capped := NewService(pool, "test-client-id", emailTestSecret)
	capped.SetMailOutbox(mail.NewOutbox(pool, &captureSender{}, 3, 0))
	if _, err := pool.Exec(ctx, `UPDATE auth_throttle_events SET created_at = created_at - INTERVAL '11 minutes'
		WHERE scope = $1`, throttleNotice); err != nil {
		t.Fatal(err)
	}
	if _, err := capped.ChangePassword(ctx, sess, pw[0], pw[1], "en"); err != nil {
		t.Fatalf("a change past the mail budget: %v", err)
	}
	if n := notices(); n != 2 {
		t.Fatalf("the notice past the budget must be skipped: %d", n)
	}
}

// Two accounts from before accounts were linked share one verified email: the
// account that adds a password with it is not locked out by the other, and the
// other then names an address.
func TestDuplicateEmailAccountsCanStillAddAPassword(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	older := seedGoogleAccount(t, pool, "dup@gmail.com", "g-dup-old")
	newer := seedGoogleAccount(t, pool, "dup@gmail.com", "g-dup-new")
	setPassword(t, svc, pool, newer, uuid.NewString(), "dup@gmail.com")
	if me, err := svc.AccountMe(ctx, older); err != nil || me.SetupEmail != "" {
		t.Fatalf("the other account must name an address now: %q %v", me.SetupEmail, err)
	}
	if err := svc.PasswordSetupStart(ctx, older, "", "en"); !errors.Is(err, ErrEmailRequired) {
		t.Fatalf("the taken own address: %v", err)
	}
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "dup@gmail.com", goodPassword, SwitchOptions{}); err != nil {
		t.Fatalf("the password signs in to the account that added it: %v", err)
	}
}

// A set-password start refused as email_in_use was still admitted: it spends
// the account's and the address's budgets like any start.
func TestRefusedSetupStartSpendsItsBudgets(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	signUp(t, svc, pool, "taken.addr@shop.af", uuid.NewString())
	relay := seedGoogleAccount(t, pool, "z1@privaterelay.appleid.com", "g-z1")
	before := dbCount(t, pool, `SELECT COUNT(*) FROM auth_throttle_events WHERE scope IN ('mail', 'mail_client')`)
	ageMailThrottle(t, pool)
	if err := svc.PasswordSetupStart(ctx, relay, "taken.addr@shop.af", "en"); !errors.Is(err, ErrEmailInUse) {
		t.Fatalf("want email_in_use: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_throttle_events WHERE scope IN ('mail', 'mail_client')`); n != before+2 {
		t.Fatalf("throttle rows %d → %d; the refused start must count for the account and the address", before, n)
	}
}

// Reset, change and removal drop the account's cached session verdicts, so a
// session they ended stops working at once, not after the cache's 60 s.
func TestAccountHandlersInvalidateCachedSessions(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	auth := NewSessionAuthenticator(svc, emailTestSecret)
	h := NewHandler(svc)
	h.SetAuthenticator(auth)
	stale := func(accountID string) {
		auth.cache.Add("other-phone|email|7|"+accountID, revokedEntry{checkedAt: time.Now()})
	}
	cached := func(accountID string) bool {
		for _, k := range auth.cache.Keys() {
			if strings.HasSuffix(k, "|"+accountID) && strings.HasPrefix(k, "other-phone|") {
				return true
			}
		}
		return false
	}
	serve := func(handle http.HandlerFunc, method, target, body string, claims *SessionClaims) int {
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		if claims != nil {
			req = req.WithContext(context.WithValue(req.Context(), claimsContextKey, claims))
		}
		rec := httptest.NewRecorder()
		handle(rec, req)
		return rec.Code
	}

	// Change password.
	res := signUp(t, svc, pool, "cache.change@shop.af", uuid.NewString())
	stale(res.AccountID)
	if code := serve(h.ChangePassword, http.MethodPut, "/v1/account/password",
		`{"current_password":"`+goodPassword+`","new_password":"`+otherPassword+`","lang":"en"}`, sessionOf(t, res)); code != http.StatusOK {
		t.Fatalf("change: %d", code)
	}
	if cached(res.AccountID) {
		t.Fatal("a password change must drop the account's cached sessions")
	}

	// Reset.
	stale(res.AccountID)
	ageMailThrottle(t, pool)
	if err := svc.EmailResetStart(ctx, "cache.change@shop.af", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"install_id":%q,"email":"cache.change@shop.af","code":%q,"new_password":%q,"lang":"en"}`,
		uuid.NewString(), lastCode(t, pool, "cache.change@shop.af"), goodPassword)
	if code := serve(h.EmailResetVerify, http.MethodPost, "/v1/auth/email/reset/verify", body, nil); code != http.StatusOK {
		t.Fatalf("reset: %d", code)
	}
	if cached(res.AccountID) {
		t.Fatal("a reset must drop the account's cached sessions")
	}

	// Remove password.
	acct := seedGoogleAccount(t, pool, "cache.remove@gmail.com", "g-cache")
	googlePhone := uuid.NewString()
	seedSession(t, pool, googlePhone, ProviderGoogle, "g-cache", acct)
	setPassword(t, svc, pool, acct, googlePhone, "cache.remove@gmail.com")
	stale(acct)
	if code := serve(h.RemovePassword, http.MethodDelete, "/v1/account/password",
		"", &SessionClaims{AccountID: acct, InstallID: googlePhone, Provider: ProviderGoogle, ProviderSub: "g-cache"}); code != http.StatusOK {
		t.Fatalf("remove: %d", code)
	}
	if cached(acct) {
		t.Fatal("removing the password must drop the account's cached sessions")
	}
}
