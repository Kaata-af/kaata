package auth

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/mail"
	"github.com/matee/kaata-backend/internal/testutil"
)

// Kaata email + password accounts against the real schema
// (docs/kaata-accounts.md). Mail is not delivered here: tests read the outbox
// rows the service queued, which hold the code until a worker sends it.

const (
	emailTestSecret = "0123456789abcdef0123456789abcdef"
	goodPassword    = "Tq8v-Lr2x-W9pm"
	otherPassword   = "Zb4n-Hk7w-Pq3y"
)

type captureSender struct {
	mu   sync.Mutex
	sent []mail.Message
}

func (c *captureSender) Send(_ context.Context, m mail.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, m)
	return nil
}

func newEmailService(t *testing.T, pool *pgxpool.Pool) *Service {
	t.Helper()
	svc := NewService(pool, "test-client-id", emailTestSecret)
	svc.SetMailOutbox(mail.NewOutbox(pool, &captureSender{}, 0, 0))
	return svc
}

// anyClient is a fresh client key, so a test about something else never meets
// the per-client start budget.
func anyClient() string { return "test:" + uuid.NewString() }

// sessionOf reads the session claims of a sign-in result.
func sessionOf(t *testing.T, res GoogleSignInResult) *SessionClaims {
	t.Helper()
	claims, err := ParseSession(emailTestSecret, res.SessionJWT)
	if err != nil {
		t.Fatalf("parse session: %v", err)
	}
	return claims
}

type queuedMail struct{ subject, text string }

func mailsTo(t *testing.T, pool *pgxpool.Pool, to string) []queuedMail {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT subject, COALESCE(text_body, '') FROM email_outbox WHERE to_addr = $1 ORDER BY id`, to)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []queuedMail
	for rows.Next() {
		var m queuedMail
		if err := rows.Scan(&m.subject, &m.text); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

var sixDigits = regexp.MustCompile(`\d{6}`)

// lastCode returns the code of the newest mail to the address.
func lastCode(t *testing.T, pool *pgxpool.Pool, to string) string {
	t.Helper()
	ms := mailsTo(t, pool, to)
	if len(ms) == 0 {
		t.Fatalf("no mail queued for the address")
	}
	code := sixDigits.FindString(ms[len(ms)-1].text)
	if code == "" {
		t.Fatalf("the newest mail carries no code: %q", ms[len(ms)-1].subject)
	}
	return code
}

func dbCount(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

// Let the next mail to every address through the 1-per-minute limit.
func ageMailThrottle(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE auth_throttle_events SET created_at = created_at - INTERVAL '2 minutes' WHERE scope = 'mail'`); err != nil {
		t.Fatal(err)
	}
}

// signUp runs the whole sign-up and returns the result.
func signUp(t *testing.T, svc *Service, pool *pgxpool.Pool, email, install string) GoogleSignInResult {
	t.Helper()
	ctx := context.Background()
	if err := svc.EmailSignUpStart(ctx, email, "en", anyClient()); err != nil {
		t.Fatalf("sign-up start: %v", err)
	}
	res, err := svc.EmailSignUpVerify(ctx, install, email, lastCode(t, pool, email), goodPassword, SwitchOptions{})
	if err != nil {
		t.Fatalf("sign-up verify: %v", err)
	}
	return res
}

// seedGoogleAccount: an account Google sign-in created, with a verified email.
func seedGoogleAccount(t *testing.T, pool *pgxpool.Pool, email, sub string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (google_sub, email, email_normalized, email_verified, name)
		VALUES ($1, $2, $3, TRUE, 'Google Person') RETURNING id::text
	`, sub, email, normalizeEmail(email)).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_identities (account_id, provider, provider_sub) VALUES ($1::uuid, 'google', $2)
	`, id, sub); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPasswordCanonicalizationAndPolicy(t *testing.T) {
	if got := canonicalizePassword("Kabul۱۲٣يك‌"); got != "Kabul123یک" {
		t.Fatalf("canonical form %q", got)
	}
	ctxPC := passwordContext{email: "ahmad.shop@gmail.com", username: "ahmadstore", phone: "+93799482613"}
	cases := map[string]string{
		"short1!":                  PasswordTooShort,
		strings.Repeat("ab9-", 33): PasswordTooLong,
		" " + goodPassword:         PasswordWhitespace,
		"84629173":                 PasswordPattern, // all digits, under 12
		"Xq123456789":              PasswordPattern, // a run of 6+
		"password123":              PasswordCommon,
		"Afghanistan!":             PasswordCommon,
		"ahmad.shop-Kq9":           PasswordPersonal, // the email's local part
		"Zz-ahmadstore-9":          PasswordPersonal, // the username
		"Kq-799482613":             PasswordPersonal, // the phone's national digits
	}
	for pw, reason := range cases {
		var weak *WeakPasswordError
		if _, err := checkPasswordPolicy(pw, ctxPC); !errors.As(err, &weak) || weak.Reason != reason {
			t.Errorf("%q: got %v, want %s", pw, err, reason)
		}
	}
	if _, err := checkPasswordPolicy(goodPassword, ctxPC); err != nil {
		t.Fatalf("a good password was refused: %v", err)
	}
	if _, err := checkPasswordPolicy("۹۴۷۱۸۳۶۲۵۸۴۱۷", passwordContext{}); err != nil {
		t.Fatalf("a long Persian-digit password should pass: %v", err)
	}
}

func TestPasswordHashing(t *testing.T) {
	ctx := context.Background()
	phc, err := hashPassword(ctx, goodPassword)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(phc, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("hash format %q", phc)
	}
	if ok, rehash, err := verifyPassword(ctx, goodPassword, phc); err != nil || !ok || rehash {
		t.Fatalf("verify: ok=%v rehash=%v err=%v", ok, rehash, err)
	}
	if ok, _, _ := verifyPassword(ctx, otherPassword, phc); ok {
		t.Fatal("a wrong password verified")
	}
	weak := strings.Replace(phc, "m=19456,t=2", "m=4096,t=1", 1)
	if _, rehash, _ := verifyPassword(ctx, goodPassword, weak); !rehash {
		t.Fatal("weaker parameters must ask for a rehash")
	}
	if err := dummyVerify(ctx, goodPassword); err != nil {
		t.Fatalf("dummy verify: %v", err)
	}
	if dummyHash() == "" {
		t.Fatal("the timing dummy hash was not built")
	}
}

func TestAccountEmailRules(t *testing.T) {
	good := map[string]string{
		"Ahmad.Shop+kaata@Gmail.com": "ahmadshop@gmail.com",
		"ahmad@googlemail.com":       "ahmad@gmail.com",
		"bob+orders@outlook.com":     "bob@outlook.com",
		"  owner@shop.af ":           "owner@shop.af",
	}
	for in, key := range good {
		if _, k, err := parseAccountEmail(in); err != nil || k != key {
			t.Errorf("%q: key %q err %v, want %q", in, k, err, key)
		}
	}
	bad := map[string]string{
		"Ahmad <ahmad@gmail.com>":         EmailBadFormat,
		`"a b"@gmail.com`:                 EmailBadFormat,
		"ahmad@[10.0.0.1]":                EmailBadFormat,
		"احمد@gmail.com":                  EmailBadFormat,
		"ahmad@localhost":                 EmailBadFormat,
		"x7k2@privaterelay.appleid.com":   EmailRelay,
		"someone@mailinator.com":          EmailDisposable,
		strings.Repeat("a", 65) + "@x.af": EmailBadFormat,
	}
	for in, reason := range bad {
		var ie *InvalidEmailError
		if _, _, err := parseAccountEmail(in); !errors.As(err, &ie) || ie.Reason != reason {
			t.Errorf("%q: got %v, want %s", in, err, reason)
		}
	}
	for in, want := range map[string]string{"۱۲۳ ۴۵۶": "123456", "12-34-56": "123456"} {
		if got, err := normalizeCode(in); err != nil || got != want {
			t.Errorf("code %q: %q %v", in, got, err)
		}
	}
	for _, in := range []string{"12345", "1234567", "12a456", ""} {
		if _, err := normalizeCode(in); !errors.Is(err, ErrInvalidCodeFormat) {
			t.Errorf("code %q must be refused", in)
		}
	}
}

func TestEmailSignUpCreatesAnAccountAndSignsIn(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	install := uuid.NewString()
	email := "New.Shop+app@Gmail.com"

	res := signUp(t, svc, pool, email, install)
	if res.User.Sub != "" || !res.User.HasPassword || res.User.Email != email {
		t.Fatalf("user block %+v", res.User)
	}
	claims, err := ParseSession(emailTestSecret, res.SessionJWT)
	if err != nil || claims.Provider != ProviderEmail || claims.ProviderSub != res.AccountID {
		t.Fatalf("session claims %+v err %v", claims, err)
	}
	if n := dbCount(t, pool, `
		SELECT COUNT(*) FROM accounts a
		JOIN account_identities ai ON ai.account_id = a.id AND ai.provider = 'email' AND ai.provider_sub = 'newshop@gmail.com'
		JOIN account_passwords p ON p.account_id = a.id AND p.login_email = $2
		WHERE a.id = $1::uuid AND a.email_verified AND a.google_sub IS NULL
	`, res.AccountID, email); n != 1 {
		t.Fatal("account, identity or password row missing")
	}
	if claims.Epoch == 0 {
		t.Fatal("a new session must carry a session epoch")
	}
	if revoked, err := svc.CheckCredentialRevoked(ctx, install, ProviderEmail, res.AccountID, claims.Epoch); err != nil || revoked {
		t.Fatalf("the new session must authorize: revoked=%v err=%v", revoked, err)
	}
	// The code mail: subject without the code, the code in the body.
	ms := mailsTo(t, pool, email)
	if len(ms) != 1 || sixDigits.MatchString(ms[0].subject) {
		t.Fatalf("mails %+v", ms)
	}
	// The code is single use.
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), email, sixDigits.FindString(ms[0].text), goodPassword,
		SwitchOptions{}); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("reused code: %v", err)
	}
}

// Signed-out flows never add a password to an existing account.
func TestEmailSignUpNeverLinksIntoAnExistingAccount(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	googleAcct := seedGoogleAccount(t, pool, "owner@gmail.com", "g-sub-1")

	if err := svc.EmailSignUpStart(ctx, "owner@gmail.com", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	ms := mailsTo(t, pool, "owner@gmail.com")
	if len(ms) != 1 || sixDigits.MatchString(ms[0].text) || !strings.Contains(ms[0].subject, "Google or Apple") {
		t.Fatalf("a Google account's address must get the notice, not a code: %+v", ms)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_codes`); n != 0 {
		t.Fatal("no code may exist for an address that already has an account")
	}
	// Even a correct-looking code cannot link: there is none to match.
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), "owner@gmail.com", "123456", goodPassword,
		SwitchOptions{}); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("verify: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM account_identities WHERE account_id = $1::uuid`, googleAcct); n != 1 {
		t.Fatal("the Google account gained an identity")
	}

	// An address that already has a password gets the "you already have an
	// account" notice instead of a code.
	signUp(t, svc, pool, "second@shop.af", uuid.NewString())
	ageMailThrottle(t, pool)
	if err := svc.EmailSignUpStart(ctx, "second@shop.af", "fa", anyClient()); err != nil {
		t.Fatal(err)
	}
	ms = mailsTo(t, pool, "second@shop.af")
	if last := ms[len(ms)-1]; sixDigits.MatchString(last.text) {
		t.Fatalf("existing account: the second start must not carry a code: %+v", last)
	}
}

func TestEmailSignInWithEmailOrUsername(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	res := signUp(t, svc, pool, "shop@example.af", uuid.NewString())
	if _, err := svc.SetUsername(ctx, res.AccountID, "  Ahmad_Shop "); err != nil {
		t.Fatalf("set username: %v", err)
	}

	for _, id := range []string{"SHOP@example.af", "ahmad_shop", " Ahmad_Shop "} {
		got, err := svc.EmailSignIn(ctx, uuid.NewString(), id, " "+goodPassword+" ", SwitchOptions{})
		if err != nil || got.AccountID != res.AccountID || got.User.Username != "ahmad_shop" {
			t.Fatalf("sign-in with %q: %+v %v", id, got.User, err)
		}
	}
	// Persian digits typed on another keyboard are the same password.
	if err := svc.EmailSignUpStart(ctx, "digits@example.af", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), "digits@example.af",
		lastCode(t, pool, "digits@example.af"), "Kq-۹۴۷۱۸-zz", SwitchOptions{}); err != nil {
		t.Fatalf("persian-digit password: %v", err)
	}
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "digits@example.af", "Kq-94718-zz", SwitchOptions{}); err != nil {
		t.Fatalf("the same password from a Latin keyboard: %v", err)
	}

	for _, id := range []string{"shop@example.af", "nobody@example.af", "nobody_here"} {
		if _, err := svc.EmailSignIn(ctx, uuid.NewString(), id, otherPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("%q with a wrong password: %v", id, err)
		}
	}
}

// Known and unknown identifiers are throttled identically.
func TestEmailSignInThrottle(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	signUp(t, svc, pool, "known@example.af", uuid.NewString())

	for _, id := range []string{"known@example.af", "unknown@example.af"} {
		var last error
		for i := 0; i < loginMaxAttempts+1; i++ {
			_, last = svc.EmailSignIn(ctx, uuid.NewString(), id, otherPassword, SwitchOptions{})
		}
		var att *AttemptsError
		if !errors.As(last, &att) || att.RetryAfter <= 0 {
			t.Fatalf("%s: attempt %d answered %v, want too_many_attempts", id, loginMaxAttempts+1, last)
		}
	}
	// While throttled, even the right password waits.
	var att *AttemptsError
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "known@example.af", goodPassword, SwitchOptions{}); !errors.As(err, &att) {
		t.Fatalf("throttled sign-in: %v", err)
	}
}

func TestEmailCodeBudgetAndAttempts(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	email := "guess@example.af"
	if err := svc.EmailSignUpStart(ctx, email, "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	real := lastCode(t, pool, email)
	wrong := "000000"
	if wrong == real {
		wrong = "000001"
	}
	for i := 0; i < codeFailBudget; i++ {
		if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), email, wrong, goodPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("wrong code %d: %v", i, err)
		}
	}
	var att *AttemptsError
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), email, real, goodPassword, SwitchOptions{}); !errors.As(err, &att) {
		t.Fatalf("after the budget even the right code waits: %v", err)
	}
	// A weak password is refused before the code is looked at.
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), "other@example.af", "123456", "password1",
		SwitchOptions{}); !errors.As(err, new(*WeakPasswordError)) {
		t.Fatalf("weak password: %v", err)
	}
}

func TestEmailMailThrottleCountsEveryRequest(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	seedGoogleAccount(t, pool, "taken@gmail.com", "g-sub-2")
	// Same answer and same limit whether or not the address has an account.
	for _, email := range []string{"taken@gmail.com", "free@example.af"} {
		if err := svc.EmailSignUpStart(ctx, email, "en", anyClient()); err != nil {
			t.Fatalf("%s first: %v", email, err)
		}
		var thr *ThrottledError
		if err := svc.EmailSignUpStart(ctx, email, "en", anyClient()); !errors.As(err, &thr) || thr.Limit != "minute" {
			t.Fatalf("%s second: %v, want the minute limit", email, err)
		}
		if err := svc.EmailResetStart(ctx, email, "en", anyClient()); !errors.As(err, &thr) {
			t.Fatalf("%s reset shares the limit: %v", email, err)
		}
	}
}

func TestEmailResetFlows(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	seedGoogleAccount(t, pool, "googleonly@gmail.com", "g-sub-3")
	phone1, phone2 := uuid.NewString(), uuid.NewString()
	res := signUp(t, svc, pool, "Reset.Me@shop.af", phone1)
	if _, err := svc.EmailSignIn(ctx, phone2, "reset.me@shop.af", goodPassword, SwitchOptions{}); err != nil {
		t.Fatal(err)
	}

	for _, email := range []string{"nobody@shop.af", "googleonly@gmail.com"} {
		if err := svc.EmailResetStart(ctx, email, "en", anyClient()); err != nil {
			t.Fatal(err)
		}
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_outbox WHERE to_addr = 'nobody@shop.af'`); n != 0 {
		t.Fatal("an unknown address must get nothing")
	}
	if ms := mailsTo(t, pool, "googleonly@gmail.com"); len(ms) != 1 || sixDigits.MatchString(ms[0].text) {
		t.Fatalf("a Google-only account gets the notice, no code: %+v", ms)
	}

	ageMailThrottle(t, pool)
	// Typed differently; the code goes to the proven address.
	if err := svc.EmailResetStart(ctx, "reset.me@SHOP.af", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	code := lastCode(t, pool, "Reset.Me@shop.af")
	phone3 := uuid.NewString()
	if _, err := svc.EmailResetVerify(ctx, phone3, "reset.me@shop.af", code, "short", "en", SwitchOptions{}); !errors.As(err, new(*WeakPasswordError)) {
		t.Fatalf("weak new password: %v", err)
	}
	got, err := svc.EmailResetVerify(ctx, phone3, "reset.me@shop.af", code, otherPassword, "en", SwitchOptions{})
	if err != nil || got.AccountID != res.AccountID {
		t.Fatalf("reset: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_credentials WHERE account_id = $1::uuid`, res.AccountID); n != 1 {
		t.Fatalf("a reset must sign every other phone out (%d credentials left)", n)
	}
	ms := mailsTo(t, pool, "Reset.Me@shop.af")
	if last := ms[len(ms)-1]; !strings.Contains(last.subject, "changed") {
		t.Fatalf("security notice missing: %+v", last)
	}
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "reset.me@shop.af", goodPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("the old password: %v", err)
	}
	if _, err := svc.EmailSignIn(ctx, uuid.NewString(), "reset.me@shop.af", otherPassword, SwitchOptions{}); err != nil {
		t.Fatalf("the new password: %v", err)
	}
}

// The reply to a successful verify was lost and the app retries.
func TestEmailVerifyReplayAfterALostReply(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	install := uuid.NewString()
	email := "retry@shop.af"
	if err := svc.EmailSignUpStart(ctx, email, "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	code := lastCode(t, pool, email)
	first, err := svc.EmailSignUpVerify(ctx, install, email, code, goodPassword, SwitchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	again, err := svc.EmailSignUpVerify(ctx, install, email, code, goodPassword, SwitchOptions{})
	if err != nil || again.AccountID != first.AccountID {
		t.Fatalf("replay: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM accounts`); n != 1 {
		t.Fatalf("the replay created another account (%d)", n)
	}
	// Another phone, or the wrong password, gets nothing from the used code.
	if _, err := svc.EmailSignUpVerify(ctx, uuid.NewString(), email, code, goodPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("another install: %v", err)
	}
	if _, err := svc.EmailSignUpVerify(ctx, install, email, code, otherPassword, SwitchOptions{}); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("wrong password on replay: %v", err)
	}
}

// The server decides "different account on this phone" and writes nothing.
func TestDifferentAccountWritesNothing(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	phoneOwner := signUp(t, svc, pool, "first@shop.af", uuid.NewString())
	install := uuid.NewString()
	email := "second@shop.af"
	if err := svc.EmailSignUpStart(ctx, email, "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	code := lastCode(t, pool, email)
	sw := SwitchOptions{CurrentAccountID: phoneOwner.AccountID}
	var diff *DifferentAccountError
	if _, err := svc.EmailSignUpVerify(ctx, install, email, code, goodPassword, sw); !errors.As(err, &diff) || diff.Email != email {
		t.Fatalf("want different_account with the new address: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM accounts WHERE email = $1`, email); n != 0 {
		t.Fatal("the refused sign-up created the account")
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM email_codes WHERE consumed_at IS NOT NULL AND email = $1`, email); n != 0 {
		t.Fatal("the refused sign-up used the code")
	}
	sw.AllowSwitch = true
	res, err := svc.EmailSignUpVerify(ctx, install, email, code, goodPassword, sw)
	if err != nil {
		t.Fatalf("after the user chose to switch: %v", err)
	}
	// Signing in again as the same account never asks.
	if _, err := svc.EmailSignIn(ctx, install, email, goodPassword, SwitchOptions{CurrentAccountID: res.AccountID}); err != nil {
		t.Fatalf("same account: %v", err)
	}
	if _, err := svc.EmailSignIn(ctx, install, "first@shop.af", goodPassword,
		SwitchOptions{CurrentAccountID: res.AccountID}); !errors.As(err, &diff) {
		t.Fatalf("password sign-in to another account: %v", err)
	}
	var bound string
	if err := pool.QueryRow(ctx, `SELECT account_id::text FROM installs WHERE install_id = $1`, install).Scan(&bound); err != nil || bound != res.AccountID {
		t.Fatalf("the refused sign-in moved the install: %q %v", bound, err)
	}
}

// Any sign-in replaces every other credential of the install; sign-out removes all.
func TestOneCredentialPerInstall(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	install := uuid.NewString()
	other := seedGoogleAccount(t, pool, "previous@gmail.com", "g-sub-4")
	if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id, account_id) VALUES ($1, $2::uuid)`, install, other); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_credentials (install_id, provider, provider_sub, account_id)
		VALUES ($1, 'google', 'g-sub-4', $2::uuid), ($1, 'apple', 'apple-sub', $2::uuid)
	`, install, other); err != nil {
		t.Fatal(err)
	}
	res := signUp(t, svc, pool, "switcher@shop.af", install)
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_credentials WHERE install_id = $1`, install); n != 1 {
		t.Fatalf("%d credentials on the install, want only the new one", n)
	}
	if revoked, _ := svc.CheckCredentialRevoked(ctx, install, ProviderGoogle, other, 0); !revoked {
		t.Fatal("the previous account's session must stop authorizing")
	}
	if err := svc.SignOut(ctx, install, ProviderEmail); err != nil {
		t.Fatal(err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_credentials WHERE install_id = $1`, install); n != 0 {
		t.Fatal("sign-out must remove every credential of the install")
	}
	_ = res
}

// A Google account gets its first password only while signed in.
func TestPasswordSetupForAGoogleAccount(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	acct := seedGoogleAccount(t, pool, "Google.User@gmail.com", "g-sub-5")
	install := uuid.NewString()

	if err := svc.PasswordSetupStart(ctx, acct, "", "en"); err != nil {
		t.Fatalf("setup start: %v", err)
	}
	code := lastCode(t, pool, "Google.User@gmail.com")
	if _, err := svc.PasswordSetupVerify(ctx, acct, install, code, "password1", "en"); !errors.As(err, new(*WeakPasswordError)) {
		t.Fatalf("weak: %v", err)
	}
	login, err := svc.PasswordSetupVerify(ctx, acct, install, code, goodPassword, "en")
	if err != nil || login != "Google.User@gmail.com" {
		t.Fatalf("setup verify: %q %v", login, err)
	}
	if _, err := svc.PasswordSetupVerify(ctx, acct, install, code, goodPassword, "en"); err != nil {
		t.Fatalf("a retried setup verify must succeed: %v", err)
	}
	if err := svc.PasswordSetupStart(ctx, acct, "", "en"); !errors.Is(err, ErrPasswordExists) {
		t.Fatalf("second setup: %v", err)
	}
	got, err := svc.EmailSignIn(ctx, uuid.NewString(), "googleuser@gmail.com", goodPassword, SwitchOptions{})
	if err != nil || got.AccountID != acct {
		t.Fatalf("password sign-in into the Google account: %v", err)
	}
	me, err := svc.AccountMe(ctx, acct)
	if err != nil || !me.HasPassword || me.LoginEmail != "Google.User@gmail.com" || strings.Join(me.Providers, ",") != "email,google" {
		t.Fatalf("me %+v %v", me, err)
	}

	// An Apple relay account must name a real address.
	relay := seedGoogleAccount(t, pool, "x9k2@privaterelay.appleid.com", "g-sub-6")
	if err := svc.PasswordSetupStart(ctx, relay, "", "en"); !errors.Is(err, ErrEmailRequired) {
		t.Fatalf("relay without an address: %v", err)
	}
	// An address another account signs in with is refused.
	signUp(t, svc, pool, "taken@shop.af", uuid.NewString())
	ageMailThrottle(t, pool)
	if err := svc.PasswordSetupStart(ctx, relay, "taken@shop.af", "en"); !errors.Is(err, ErrEmailInUse) {
		t.Fatalf("an address in use: %v", err)
	}
}

func TestChangePasswordUsernameAndName(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	phone1, phone2 := uuid.NewString(), uuid.NewString()
	res := signUp(t, svc, pool, "owner@shop.af", phone1)
	if _, err := svc.EmailSignIn(ctx, phone2, "owner@shop.af", goodPassword, SwitchOptions{}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ChangePassword(ctx, sessionOf(t, res), otherPassword, "Nw7k-Qp2z-Lm4x", "en"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("wrong current: %v", err)
	}
	if _, err := svc.ChangePassword(ctx, sessionOf(t, res), goodPassword, otherPassword, "en"); err != nil {
		t.Fatalf("change: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_credentials WHERE account_id = $1::uuid`, res.AccountID); n != 1 {
		t.Fatalf("a change must sign the other phones out (%d left)", n)
	}

	for raw, reason := range map[string]string{"ab": "format", "1ahmad": "format", "ah..mad": "format",
		"ahmad.": "format", "kaata_shop": "reserved", "my_admin": "reserved"} {
		var bad *InvalidUsernameError
		if _, err := svc.SetUsername(ctx, res.AccountID, raw); !errors.As(err, &bad) || bad.Reason != reason {
			t.Errorf("username %q: %v, want %s", raw, err, reason)
		}
	}
	if u, err := svc.SetUsername(ctx, res.AccountID, "Shop_Owner"); err != nil || u != "shop_owner" {
		t.Fatalf("set: %q %v", u, err)
	}
	second := signUp(t, svc, pool, "second@shop.af", uuid.NewString())
	if _, err := svc.SetUsername(ctx, second.AccountID, "shop_owner"); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("taken: %v", err)
	}
	if u, err := svc.SetUsername(ctx, res.AccountID, ""); err != nil || u != "" {
		t.Fatalf("remove: %v", err)
	}
	google := seedGoogleAccount(t, pool, "named@gmail.com", "g-sub-7")
	if _, err := svc.SetUsername(ctx, google, "named_user"); !errors.Is(err, ErrNoPassword) {
		t.Fatalf("a username needs a password: %v", err)
	}

	if name, err := svc.SetAccountName(ctx, res.AccountID, "  Ahmad‮  Store ​ "); err != nil || name != "Ahmad Store" {
		t.Fatalf("name %q %v", name, err)
	}
	if _, err := svc.SetAccountName(ctx, res.AccountID, "A"); !errors.As(err, new(*InvalidNameError)) {
		t.Fatalf("short name: %v", err)
	}
	if _, err := svc.SetAccountName(ctx, google, "Someone Else"); !errors.Is(err, ErrProviderName) {
		t.Fatalf("a Google account's name: %v", err)
	}
}

func TestEmailFlowsWithoutMail(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool, "test-client-id", emailTestSecret) // no outbox
	if err := svc.EmailSignUpStart(ctx, "a@shop.af", "en", anyClient()); !errors.Is(err, mail.ErrUnavailable) {
		t.Fatalf("no mail driver: %v", err)
	}
	budget := NewService(pool, "test-client-id", emailTestSecret)
	budget.SetMailOutbox(mail.NewOutbox(pool, &captureSender{}, 1, 0))
	if err := budget.EmailSignUpStart(ctx, "b@shop.af", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	if err := budget.EmailSignUpStart(ctx, "c@shop.af", "en", anyClient()); !errors.Is(err, mail.ErrUnavailable) {
		t.Fatalf("over the global budget: %v", err)
	}
}

func TestDeletingAnEmailAccountFreesTheAddress(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	res := signUp(t, svc, pool, "gone@shop.af", uuid.NewString())
	if err := svc.DeleteAccount(ctx, res.AccountID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"account_passwords", "account_identities", "email_codes"} {
		if n := dbCount(t, pool, `SELECT COUNT(*) FROM `+table+` WHERE account_id = $1::uuid`, res.AccountID); n != 0 {
			t.Fatalf("%s kept rows of the deleted account", table)
		}
	}
	ageMailThrottle(t, pool)
	if err := svc.EmailSignUpStart(ctx, "gone@shop.af", "en", anyClient()); err != nil {
		t.Fatal(err)
	}
	if code := lastCode(t, pool, "gone@shop.af"); code == "" {
		t.Fatal("a freed address gets a fresh code")
	}
}

// Google and Apple share the tail: a different account rolls everything back.
func TestSharedTailRefusesADifferentAccountForGoogle(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	a := seedGoogleAccount(t, pool, "a@gmail.com", "g-a")
	b := seedGoogleAccount(t, pool, "b@gmail.com", "g-b")
	install := uuid.NewString()

	run := func(sw SwitchOptions) error {
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _, err = svc.completeSignIn(ctx, tx, signInTail{provider: ProviderGoogle, providerSub: "g-b",
			installID: install, accountID: b, sw: sw, credEmail: "b@gmail.com"})
		return err
	}
	var diff *DifferentAccountError
	if err := run(SwitchOptions{CurrentAccountID: a}); !errors.As(err, &diff) || diff.Email != "b@gmail.com" {
		t.Fatalf("want different_account: %v", err)
	}
	if n := dbCount(t, pool, `SELECT COUNT(*) FROM auth_credentials WHERE install_id = $1`, install); n != 0 {
		t.Fatal("the refused sign-in wrote a credential")
	}
	if err := run(SwitchOptions{CurrentAccountID: a, AllowSwitch: true}); err != nil {
		t.Fatalf("allowed switch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET disabled_at = NOW() WHERE id = $1::uuid`, b); err != nil {
		t.Fatal(err)
	}
	if err := run(SwitchOptions{}); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("disabled account: %v", err)
	}
}
