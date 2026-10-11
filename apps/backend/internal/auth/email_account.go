package auth

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/unicode/norm"

	"github.com/matee/kaata-backend/internal/mail"
)

// Kaata email + password accounts (docs/kaata-accounts.md). The rules that hold
// everything below together:
//   - a signed-out flow never adds a password to an existing account: sign-up
//     only creates, reset only works where a password exists, and a Google or
//     Apple account gets its first password only while signed in to it;
//   - every start request is admitted (client, address and global budgets)
//     BEFORE the address is looked up, and answered the same way whether or
//     not an account exists;
//   - a first password goes to the account's own email when it can receive
//     mail, so a stolen session cannot attach an address its thief controls;
//   - hashing never runs inside a transaction; writes re-check under the
//     account lock, which is always taken first (DeleteAccount's order);
//   - nothing here logs an address, identifier, code or password.

var (
	ErrAccountExists      = errors.New("an account already uses this email")
	ErrInvalidCredentials = errors.New("email/username or password is incorrect")
	ErrWrongPassword      = errors.New("the current password is incorrect")
	ErrNoPassword         = errors.New("the account has no password")
	ErrPasswordExists     = errors.New("the account already has a password")
	ErrEmailInUse         = errors.New("the email belongs to another account")
	ErrEmailRequired      = errors.New("an email address is required")
	ErrUsernameTaken      = errors.New("the username is taken")
	ErrProviderName       = errors.New("the account name comes from Google or Apple")
	// ErrEmailFixed: a first password must use the account's own email.
	ErrEmailFixed = errors.New("the password must use the account's own email")
	// ErrProviderSessionRequired: only a Google or Apple session may remove the
	// password, so whoever removes it controls the account's other sign-in.
	ErrProviderSessionRequired = errors.New("sign in with Google or Apple to remove the password")
	// ErrSessionRevoked: the session's credential disappeared mid-request (401).
	ErrSessionRevoked = errors.New("the session has been revoked")
)

// InvalidUsernameError carries the refusal reason ("format" or "reserved").
type InvalidUsernameError struct{ Reason string }

func (e *InvalidUsernameError) Error() string { return "invalid username: " + e.Reason }

// InvalidNameError: the display name is empty, too long or unusable.
type InvalidNameError struct{}

func (e *InvalidNameError) Error() string { return "invalid name" }

const noticeTTL = time.Hour

func (s *Service) requireMail() error {
	if !s.outbox.Enabled() {
		return mail.ErrUnavailable
	}
	return nil
}

type queryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// addressOwner is the account that owns an address for sign-in, if any.
type addressOwner struct {
	accountID string
	// signIn: the address IS the account's password sign-in address (an
	// 'email' identity with this key). Otherwise it is the verified email of
	// an account that signs in with Google or Apple.
	signIn bool
	// hasPassword: the account has a password (for a Google/Apple match, one
	// that signs in with another address: loginEmail).
	hasPassword bool
	loginEmail  string
	// email: the account's stored email (the Google/Apple match).
	email string
}

// findAddressOwner says which account owns an address for sign-in: the one
// with that 'email' identity, else an account whose VERIFIED email has the same
// dedupe key and that has identities (kaata_email_key, migration 053).
func findAddressOwner(ctx context.Context, q queryRower, emailKey string) (addressOwner, error) {
	var o addressOwner
	err := q.QueryRow(ctx, `
		SELECT ai.account_id::text, COALESCE(p.login_email, ''), p.account_id IS NOT NULL
		FROM account_identities ai
		LEFT JOIN account_passwords p ON p.account_id = ai.account_id
		WHERE ai.provider = 'email' AND ai.provider_sub = $1
	`, emailKey).Scan(&o.accountID, &o.loginEmail, &o.hasPassword)
	if err == nil {
		o.signIn = true
		return o, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return addressOwner{}, fmt.Errorf("look up email identity: %w", err)
	}
	err = q.QueryRow(ctx, `
		SELECT a.id::text, COALESCE(a.email, ''), COALESCE(p.login_email, ''), p.account_id IS NOT NULL
		FROM accounts a
		LEFT JOIN account_passwords p ON p.account_id = a.id
		WHERE kaata_email_key(a.email) = $1 AND a.email_verified
		  AND EXISTS (SELECT 1 FROM account_identities ai WHERE ai.account_id = a.id)
		ORDER BY a.created_at
		LIMIT 1
	`, emailKey).Scan(&o.accountID, &o.email, &o.loginEmail, &o.hasPassword)
	switch {
	case err == nil:
		return o, nil
	case errors.Is(err, pgx.ErrNoRows):
		return addressOwner{}, nil
	default:
		return addressOwner{}, fmt.Errorf("look up verified email: %w", err)
	}
}

// ownerNotice is the mail a start request sends instead of a code when the
// address already has an account, and where it goes ("" sends nothing).
func ownerNotice(o addressOwner, lang, typed string) (mail.Message, bool) {
	switch {
	case o.signIn:
		return mail.Render(mail.KindAccountExists, lang, typed, ""), true
	case o.email == "":
		return mail.Message{}, false
	case o.hasPassword:
		// The password signs in with another address: say which, masked, so the
		// owner learns where reset codes go (and can remove a password they did
		// not add).
		return mail.RenderElsewhere(lang, o.email, mail.MaskAddress(o.loginEmail)), true
	default:
		return mail.Render(mail.KindProviderOnly, lang, o.email, ""), true
	}
}

// enqueueNotice queues a security notice (no code) from a verify or a
// password change. It must never fail the flow that sends it: a notice the
// per-recipient or global budget refuses (admitNotice), or that finds mail off,
// is skipped.
func (s *Service) enqueueNotice(ctx context.Context, tx pgx.Tx, kind mail.Kind, lang, to string) error {
	if !s.outbox.Enabled() {
		return nil
	}
	if ok, err := s.admitNotice(ctx, tx, kind, to); err != nil || !ok {
		return err
	}
	err := s.outbox.Enqueue(ctx, tx, mail.Render(kind, lang, to, ""), noticeTTL)
	if errors.Is(err, mail.ErrUnavailable) {
		return nil
	}
	return err
}

// ---------- sign-up ----------

// EmailSignUpStart sends a sign-up code, or a notice when the address already
// has an account. The answer is the same either way. client is the caller's
// ClientKey.
func (s *Service) EmailSignUpStart(ctx context.Context, rawEmail, lang, client string) error {
	email, key, err := parseAccountEmail(rawEmail)
	if err != nil {
		return err
	}
	if err := s.requireMail(); err != nil {
		return err
	}
	if err := s.admitStart(ctx, client, key, purposeSignup); err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	owner, err := findAddressOwner(ctx, tx, key)
	if err != nil {
		return err
	}
	if owner.accountID != "" {
		if m, ok := ownerNotice(owner, lang, email); ok {
			err = s.outbox.Enqueue(ctx, tx, m, noticeTTL)
		}
	} else {
		err = s.issueCode(ctx, tx, purposeSignup, email, key, nil, mail.KindSignupCode, lang)
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit sign-up start: %w", err)
	}
	s.outbox.Nudge()
	return nil
}

// EmailSignUpVerify proves the address with its code and creates the account,
// then signs this install in. Create-only: an address that has an account by
// now answers ErrAccountExists, and nothing links into it.
func (s *Service) EmailSignUpVerify(ctx context.Context, installID, rawEmail, rawCode, password string,
	sw SwitchOptions) (GoogleSignInResult, error) {
	email, key, err := parseAccountEmail(rawEmail)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	code, err := normalizeCode(rawCode)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	canonical, err := checkPasswordPolicy(password, passwordContext{email: email})
	if err != nil {
		return GoogleSignInResult{}, err
	}
	scope := codeScope{purpose: purposeSignup, emailKey: key}

	// The reply to an earlier, successful verify was lost: sign in again.
	if row, err := s.replayedCode(ctx, scope, code, installID); err != nil {
		return GoogleSignInResult{}, err
	} else if row != nil && row.accountID != nil {
		return s.replayPasswordSignIn(ctx, installID, *row.accountID, canonical, sw)
	}

	pre, err := s.preMatchCode(ctx, scope, code)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	if pre == nil {
		return GoogleSignInResult{}, s.recordCodeFailure(ctx, scope, code)
	}
	hash, err := hashPassword(ctx, canonical)
	if err != nil {
		return GoogleSignInResult{}, err
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hit, err := s.matchCodeLocked(ctx, tx, scope, code)
	if errors.Is(err, errCodeMismatch) {
		if err := tx.Commit(ctx); err != nil {
			return GoogleSignInResult{}, fmt.Errorf("commit code failure: %w", err)
		}
		return GoogleSignInResult{}, ErrInvalidCode
	}
	if err != nil {
		return GoogleSignInResult{}, err
	}
	if owner, err := findAddressOwner(ctx, tx, key); err != nil {
		return GoogleSignInResult{}, err
	} else if owner.accountID != "" {
		return GoogleSignInResult{}, ErrAccountExists
	}

	var accountID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO accounts (email, email_normalized, email_verified, last_login_at)
		VALUES ($1, $2, TRUE, NOW())
		RETURNING id::text
	`, email, normalizeEmail(email)).Scan(&accountID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("create account: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_identities (account_id, provider, provider_sub, verified_at, created_at)
		VALUES ($1::uuid, 'email', $2, NOW(), NOW())
	`, accountID, key); err != nil {
		if isUniqueViolation(err) {
			return GoogleSignInResult{}, ErrAccountExists
		}
		return GoogleSignInResult{}, fmt.Errorf("create email identity: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_passwords (account_id, password_hash, norm_version, login_email)
		VALUES ($1::uuid, $2, $3, $4)
	`, accountID, hash, passwordNormVersion, email); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("store password: %w", err)
	}
	if err := consumeCode(ctx, tx, hit.id, installID, accountID); err != nil {
		return GoogleSignInResult{}, err
	}
	return s.finishEmailSignIn(ctx, tx, installID, accountID, email, sw)
}

// finishEmailSignIn runs the shared tail for an email session.
func (s *Service) finishEmailSignIn(ctx context.Context, tx pgx.Tx, installID, accountID, credEmail string,
	sw SwitchOptions) (GoogleSignInResult, error) {
	result, acct, err := s.completeSignIn(ctx, tx, signInTail{
		provider:    ProviderEmail,
		providerSub: accountID,
		installID:   installID,
		accountID:   accountID,
		sw:          sw,
		credEmail:   credEmail,
	})
	if err != nil {
		return GoogleSignInResult{}, err
	}
	// user.sub stays empty: an email session has no provider subject.
	result.User = User{
		Email:       acct.email,
		Name:        acct.name,
		Phone:       acct.phone,
		Username:    acct.username,
		HasPassword: acct.hasPassword,
	}
	return result, nil
}

// replayPasswordSignIn answers a retried verify whose code this install already
// used: it signs in again only if the password matches the account's current
// one, and writes nothing else.
func (s *Service) replayPasswordSignIn(ctx context.Context, installID, accountID, canonical string,
	sw SwitchOptions) (GoogleSignInResult, error) {
	var phc, loginEmail string
	err := s.pool.QueryRow(ctx, `SELECT password_hash, login_email FROM account_passwords WHERE account_id = $1::uuid`,
		accountID).Scan(&phc, &loginEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return GoogleSignInResult{}, ErrInvalidCode
	}
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("read password: %w", err)
	}
	ok, _, err := verifyPassword(ctx, canonical, phc)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	if !ok {
		return GoogleSignInResult{}, ErrInvalidCode
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockAccountPassword(ctx, tx, accountID, phc); err != nil {
		if errors.Is(err, ErrInvalidCredentials) {
			return GoogleSignInResult{}, ErrInvalidCode
		}
		return GoogleSignInResult{}, err
	}
	return s.finishEmailSignIn(ctx, tx, installID, accountID, loginEmail, sw)
}

// lockAccountPassword takes the account lock first, then proves the hash that
// was verified outside the transaction is still the current one.
func lockAccountPassword(ctx context.Context, tx pgx.Tx, accountID, verifiedPHC string) error {
	if _, err := tx.Exec(ctx, `SELECT id FROM accounts WHERE id = $1::uuid FOR UPDATE`, accountID); err != nil {
		return fmt.Errorf("lock account: %w", err)
	}
	var current string
	err := tx.QueryRow(ctx, `SELECT password_hash FROM account_passwords WHERE account_id = $1::uuid`,
		accountID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && current != verifiedPHC) {
		return ErrInvalidCredentials
	}
	if err != nil {
		return fmt.Errorf("re-read password: %w", err)
	}
	return nil
}

// ---------- sign-in ----------

// EmailSignIn signs in with an email address or username and the password.
// Known and unknown identifiers cost the same and are throttled the same.
func (s *Service) EmailSignIn(ctx context.Context, installID, identifier, password string,
	sw SwitchOptions) (GoogleSignInResult, error) {
	id := strings.TrimSpace(foldDigits(identifier))
	// People type their handle as "@name"; no email or username starts with "@".
	if strings.HasPrefix(id, "@") && strings.Count(id, "@") == 1 {
		id = strings.TrimSpace(id[1:])
	}
	canonical := canonicalizePassword(strings.TrimSpace(password))

	var throttleID, lookupKey string
	byEmail := strings.Contains(id, "@")
	if byEmail {
		if _, key, err := parseAccountEmail(id); err == nil {
			lookupKey = key
		}
		throttleID = "e:" + strings.ToLower(id)
		if lookupKey != "" {
			throttleID = "e:" + lookupKey
		}
	} else {
		lookupKey = strings.ToLower(id)
		throttleID = "u:" + lookupKey
	}
	throttle, err := s.admitAttempt(ctx, throttleLogin, throttleID, loginWindow, loginMaxAttempts)
	if err != nil {
		return GoogleSignInResult{}, err
	}

	var accountID, phc, loginEmail string
	switch {
	case lookupKey == "":
		err = pgx.ErrNoRows
	case byEmail:
		err = s.pool.QueryRow(ctx, `
			SELECT p.account_id::text, p.password_hash, p.login_email
			FROM account_identities ai JOIN account_passwords p ON p.account_id = ai.account_id
			WHERE ai.provider = 'email' AND ai.provider_sub = $1
		`, lookupKey).Scan(&accountID, &phc, &loginEmail)
	default:
		err = s.pool.QueryRow(ctx, `
			SELECT p.account_id::text, p.password_hash, p.login_email
			FROM accounts a JOIN account_passwords p ON p.account_id = a.id
			WHERE a.username = $1
		`, lookupKey).Scan(&accountID, &phc, &loginEmail)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// Same cost and same answers as a known identifier, ErrHashBusy included.
		if err := dummyVerify(ctx, canonical); err != nil {
			return GoogleSignInResult{}, err
		}
		return GoogleSignInResult{}, ErrInvalidCredentials
	}
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("look up sign-in: %w", err)
	}
	ok, rehash, err := verifyPassword(ctx, canonical, phc)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	if !ok {
		return GoogleSignInResult{}, ErrInvalidCredentials
	}
	newHash := ""
	if rehash {
		if newHash, err = hashPassword(ctx, canonical); err != nil {
			newHash = ""
		}
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockAccountPassword(ctx, tx, accountID, phc); err != nil {
		return GoogleSignInResult{}, err
	}
	if newHash != "" {
		if _, err := tx.Exec(ctx, `
			UPDATE account_passwords SET password_hash = $2, norm_version = $3, updated_at = NOW()
			WHERE account_id = $1::uuid
		`, accountID, newHash, passwordNormVersion); err != nil {
			return GoogleSignInResult{}, fmt.Errorf("rehash password: %w", err)
		}
	}
	result, err := s.finishEmailSignIn(ctx, tx, installID, accountID, loginEmail, sw)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	if err := clearThrottle(ctx, s.pool, throttleLogin, throttle); err != nil {
		log.Printf("auth/email: clearing a sign-in throttle failed: %v", err)
	}
	return result, nil
}

// ---------- password reset ----------

// EmailResetStart sends a reset code to an account that has a password, at its
// proven sign-in address. A Google/Apple account gets a notice instead (it has
// no password, or its password signs in with another address); an unknown
// address gets nothing. The answer is the same in every case. client is the
// caller's ClientKey.
func (s *Service) EmailResetStart(ctx context.Context, rawEmail, lang, client string) error {
	_, key, err := parseAccountEmail(rawEmail)
	if err != nil {
		return err
	}
	if err := s.requireMail(); err != nil {
		return err
	}
	if err := s.admitStart(ctx, client, key, purposeReset); err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	owner, err := findAddressOwner(ctx, tx, key)
	if err != nil {
		return err
	}
	switch {
	case owner.signIn && owner.hasPassword:
		// Deliver to the address that was proven, never the one typed.
		accountID := owner.accountID
		err = s.issueCode(ctx, tx, purposeReset, owner.loginEmail, key, &accountID, mail.KindResetCode, lang)
	case owner.accountID != "" && !owner.signIn:
		if m, ok := ownerNotice(owner, lang, ""); ok {
			err = s.outbox.Enqueue(ctx, tx, m, noticeTTL)
		}
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit reset start: %w", err)
	}
	s.outbox.Nudge()
	return nil
}

type passwordAccount struct {
	loginEmail string
	username   string
	phone      string
}

func readPasswordAccount(ctx context.Context, q queryRower, accountID string) (passwordAccount, bool, error) {
	var pa passwordAccount
	var has bool
	err := q.QueryRow(ctx, `
		SELECT COALESCE(p.login_email, ''), COALESCE(a.username, ''), COALESCE(a.phone_e164, ''),
		       p.account_id IS NOT NULL
		FROM accounts a LEFT JOIN account_passwords p ON p.account_id = a.id
		WHERE a.id = $1::uuid
	`, accountID).Scan(&pa.loginEmail, &pa.username, &pa.phone, &has)
	if errors.Is(err, pgx.ErrNoRows) {
		return pa, false, nil
	}
	if err != nil {
		return pa, false, fmt.Errorf("read account: %w", err)
	}
	return pa, has, nil
}

// EmailResetVerify sets a new password with the reset code, signs every OTHER
// install of the account out (all providers), sends a security notice and
// signs this install in.
func (s *Service) EmailResetVerify(ctx context.Context, installID, rawEmail, rawCode, newPassword, lang string,
	sw SwitchOptions) (GoogleSignInResult, error) {
	_, key, err := parseAccountEmail(rawEmail)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	code, err := normalizeCode(rawCode)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	scope := codeScope{purpose: purposeReset, emailKey: key}

	pre, err := s.preMatchCode(ctx, scope, code)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	if pre == nil {
		if row, err := s.replayedCode(ctx, scope, code, installID); err != nil {
			return GoogleSignInResult{}, err
		} else if row != nil && row.accountID != nil {
			return s.replayPasswordSignIn(ctx, installID, *row.accountID, canonicalizePassword(newPassword), sw)
		}
		return GoogleSignInResult{}, s.recordCodeFailure(ctx, scope, code)
	}
	if pre.accountID == nil {
		return GoogleSignInResult{}, ErrInvalidCode
	}
	accountID := *pre.accountID
	pa, hasPassword, err := readPasswordAccount(ctx, s.pool, accountID)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	if !hasPassword {
		return GoogleSignInResult{}, ErrInvalidCode
	}
	canonical, err := checkPasswordPolicy(newPassword, passwordContext{email: pa.loginEmail, username: pa.username, phone: pa.phone})
	if err != nil {
		return GoogleSignInResult{}, err
	}
	hash, err := hashPassword(ctx, canonical)
	if err != nil {
		return GoogleSignInResult{}, err
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT id FROM accounts WHERE id = $1::uuid FOR UPDATE`, accountID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("lock account: %w", err)
	}
	hit, err := s.matchCodeLocked(ctx, tx, scope, code)
	if errors.Is(err, errCodeMismatch) {
		if err := tx.Commit(ctx); err != nil {
			return GoogleSignInResult{}, fmt.Errorf("commit code failure: %w", err)
		}
		return GoogleSignInResult{}, ErrInvalidCode
	}
	if err != nil {
		return GoogleSignInResult{}, err
	}
	if hit.accountID == nil || *hit.accountID != accountID {
		return GoogleSignInResult{}, ErrInvalidCode
	}
	tag, err := tx.Exec(ctx, `
		UPDATE account_passwords SET password_hash = $2, norm_version = $3, updated_at = NOW()
		WHERE account_id = $1::uuid
	`, accountID, hash, passwordNormVersion)
	if err != nil {
		return GoogleSignInResult{}, fmt.Errorf("set password: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return GoogleSignInResult{}, ErrInvalidCode
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_credentials WHERE account_id = $1::uuid AND install_id <> $2`,
		accountID, installID); err != nil {
		return GoogleSignInResult{}, fmt.Errorf("sign out other installs: %w", err)
	}
	if err := s.enqueueNotice(ctx, tx, mail.KindPasswordChanged, noticeLang(lang, hit.lang), pa.loginEmail); err != nil {
		return GoogleSignInResult{}, err
	}
	if err := consumeCode(ctx, tx, hit.id, installID, accountID); err != nil {
		return GoogleSignInResult{}, err
	}
	result, err := s.finishEmailSignIn(ctx, tx, installID, accountID, pa.loginEmail, sw)
	if err != nil {
		return GoogleSignInResult{}, err
	}
	s.outbox.Nudge()
	s.clearLoginThrottles(ctx, key, pa.username)
	return result, nil
}

// noticeLang: the request's language, else the one the code was mailed in.
func noticeLang(requested, codeLang string) string {
	if strings.TrimSpace(requested) != "" {
		return requested
	}
	return codeLang
}

func (s *Service) clearLoginThrottles(ctx context.Context, emailKey, username string) {
	ids := []string{"e:" + emailKey}
	if username != "" {
		ids = append(ids, "u:"+username)
	}
	for _, id := range ids {
		if err := clearThrottle(ctx, s.pool, throttleLogin, s.throttleKey(throttleLogin, id)); err != nil {
			log.Printf("auth/email: clearing a sign-in throttle failed: %v", err)
		}
	}
}

// ---------- signed in: first password, change, username, name ----------

// setupAddress is where a first password's code goes: the account's own email
// when it can receive mail (valid, not an Apple relay, not disposable) and no
// OTHER account signs in with it, which a stolen session cannot change;
// otherwise ("", "", false) an address the user names.
func setupAddress(ctx context.Context, q queryRower, accountID, stored string) (email, key string, fixed bool, err error) {
	if strings.TrimSpace(stored) == "" {
		return "", "", false, nil
	}
	email, key, perr := parseAccountEmail(stored)
	if perr != nil {
		return "", "", false, nil
	}
	var taken bool
	if err := q.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM account_identities
		               WHERE provider = 'email' AND provider_sub = $1 AND account_id <> $2::uuid)
	`, key, accountID).Scan(&taken); err != nil {
		return "", "", false, fmt.Errorf("read sign-in address: %w", err)
	}
	if taken {
		return "", "", false, nil
	}
	return email, key, true, nil
}

// setupConflict reports another account that owns an address a first password
// would use. For the account's own (fixed) address only a password sign-in
// counts: another account that merely shares the verified email (a duplicate
// from before accounts were linked) must not lock this one out.
func setupConflict(ctx context.Context, q queryRower, accountID, key string, fixed bool) (bool, error) {
	if fixed {
		var taken bool
		err := q.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM account_identities
			               WHERE provider = 'email' AND provider_sub = $1 AND account_id <> $2::uuid)
		`, key, accountID).Scan(&taken)
		return taken, err
	}
	owner, err := findAddressOwner(ctx, q, key)
	if err != nil {
		return false, err
	}
	return owner.accountID != "" && owner.accountID != accountID, nil
}

// PasswordSetupStart sends a code for a first password to a Google/Apple
// account: to the account's own email when it can receive mail (a different
// address answers ErrEmailFixed), else to the address the user names.
func (s *Service) PasswordSetupStart(ctx context.Context, accountID, rawEmail, lang string) error {
	var stored string
	var hasPassword bool
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(a.email, ''), EXISTS (SELECT 1 FROM account_passwords p WHERE p.account_id = a.id)
		FROM accounts a WHERE a.id = $1::uuid
	`, accountID).Scan(&stored, &hasPassword); err != nil {
		return fmt.Errorf("read account: %w", err)
	}
	if hasPassword {
		return ErrPasswordExists
	}
	named := strings.TrimSpace(rawEmail)
	email, key, fixed, err := setupAddress(ctx, s.pool, accountID, stored)
	if err != nil {
		return err
	}
	switch {
	case fixed && named != "":
		if _, namedKey, err := parseAccountEmail(named); err != nil || namedKey != key {
			return ErrEmailFixed
		}
	case !fixed && named == "":
		return ErrEmailRequired
	case !fixed:
		if email, key, err = parseAccountEmail(named); err != nil {
			return err
		}
	}
	if err := s.requireMail(); err != nil {
		return err
	}
	if err := s.admitStart(ctx, "account:"+accountID, key, purposeSetup); err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if conflict, err := setupConflict(ctx, tx, accountID, key, fixed); err != nil {
		return err
	} else if conflict {
		return ErrEmailInUse
	}
	if err := s.issueCode(ctx, tx, purposeSetup, email, key, &accountID, mail.KindSetupCode, lang); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit setup start: %w", err)
	}
	s.outbox.Nudge()
	return nil
}

// PasswordSetupVerify adds the 'email' identity and the first password to the
// signed-in account. It does not start a new session.
func (s *Service) PasswordSetupVerify(ctx context.Context, accountID, installID, rawCode, newPassword, lang string) (string, error) {
	code, err := normalizeCode(rawCode)
	if err != nil {
		return "", err
	}
	scope := codeScope{purpose: purposeSetup, accountID: accountID}
	pa, hasPassword, err := readPasswordAccount(ctx, s.pool, accountID)
	if err != nil {
		return "", err
	}
	if hasPassword {
		// The retry of a verify whose reply was lost, or a real conflict.
		if row, err := s.replayedCode(ctx, scope, code, installID); err != nil {
			return "", err
		} else if row != nil {
			var phc string
			if err := s.pool.QueryRow(ctx, `SELECT password_hash FROM account_passwords WHERE account_id = $1::uuid`,
				accountID).Scan(&phc); err == nil {
				if ok, _, _ := verifyPassword(ctx, canonicalizePassword(newPassword), phc); ok {
					return pa.loginEmail, nil
				}
			}
		}
		return "", ErrPasswordExists
	}
	pre, err := s.preMatchCode(ctx, scope, code)
	if err != nil {
		return "", err
	}
	if pre == nil {
		return "", s.recordCodeFailure(ctx, scope, code)
	}
	canonical, err := checkPasswordPolicy(newPassword, passwordContext{email: pre.email, username: pa.username, phone: pa.phone})
	if err != nil {
		return "", err
	}
	hash, err := hashPassword(ctx, canonical)
	if err != nil {
		return "", err
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT id FROM accounts WHERE id = $1::uuid FOR UPDATE`, accountID); err != nil {
		return "", fmt.Errorf("lock account: %w", err)
	}
	hit, err := s.matchCodeLocked(ctx, tx, scope, code)
	if errors.Is(err, errCodeMismatch) {
		if err := tx.Commit(ctx); err != nil {
			return "", fmt.Errorf("commit code failure: %w", err)
		}
		return "", ErrInvalidCode
	}
	if err != nil {
		return "", err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM account_passwords WHERE account_id = $1::uuid)`,
		accountID).Scan(&exists); err != nil {
		return "", fmt.Errorf("re-read password: %w", err)
	}
	if exists {
		return "", ErrPasswordExists
	}
	var stored string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(email, '') FROM accounts WHERE id = $1::uuid`, accountID).Scan(&stored); err != nil {
		return "", fmt.Errorf("read account email: %w", err)
	}
	_, ownKey, _, err := setupAddress(ctx, tx, accountID, stored)
	if err != nil {
		return "", err
	}
	if conflict, err := setupConflict(ctx, tx, accountID, hit.emailKey, ownKey != "" && ownKey == hit.emailKey); err != nil {
		return "", err
	} else if conflict {
		return "", ErrEmailInUse
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_identities (account_id, provider, provider_sub, verified_at, created_at)
		VALUES ($1::uuid, 'email', $2, NOW(), NOW())
	`, accountID, hit.emailKey); err != nil {
		if isUniqueViolation(err) {
			return "", ErrEmailInUse
		}
		return "", fmt.Errorf("create email identity: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_passwords (account_id, password_hash, norm_version, login_email)
		VALUES ($1::uuid, $2, $3, $4)
	`, accountID, hash, passwordNormVersion, hit.email); err != nil {
		if isUniqueViolation(err) {
			return "", ErrPasswordExists
		}
		return "", fmt.Errorf("store password: %w", err)
	}
	if err := consumeCode(ctx, tx, hit.id, installID, accountID); err != nil {
		return "", err
	}
	if err := s.enqueueNotice(ctx, tx, mail.KindPasswordChanged, noticeLang(lang, hit.lang), hit.email); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit setup: %w", err)
	}
	s.outbox.Nudge()
	return hit.email, nil
}

// ChangePassword replaces the password after checking the current one, signs
// every OTHER install of the account out and sends a security notice. This
// session stays (the usual rule: a password change ends the other sessions), so
// a retry after a lost reply still authenticates; it returns a re-signed JWT
// of the same session for the app to keep. A reset, which is a sign-in, is what
// gives the install a fresh epoch.
//
// Retry safety: when the current password no longer matches because a change
// whose reply was lost just set the new one, it answers the same way and
// changes nothing else.
func (s *Service) ChangePassword(ctx context.Context, sess *SessionClaims, current, next, lang string) (string, error) {
	accountID, installID := sess.AccountID, sess.InstallID
	throttle, err := s.admitAttempt(ctx, throttlePwChange, accountID, loginWindow, loginMaxAttempts)
	if err != nil {
		return "", err
	}
	var phc string
	var updatedAt time.Time
	err = s.pool.QueryRow(ctx, `SELECT password_hash, updated_at FROM account_passwords WHERE account_id = $1::uuid`,
		accountID).Scan(&phc, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNoPassword
	}
	if err != nil {
		return "", fmt.Errorf("read password: %w", err)
	}
	ok, _, err := verifyPassword(ctx, canonicalizePassword(strings.TrimSpace(current)), phc)
	if err != nil {
		return "", err
	}
	if !ok {
		if time.Since(updatedAt) < codeReplayWindow {
			same, _, err := verifyPassword(ctx, canonicalizePassword(next), phc)
			if err != nil {
				return "", err
			}
			if same {
				return s.reissueSession(ctx, s.pool, sess)
			}
		}
		return "", ErrWrongPassword
	}
	pa, _, err := readPasswordAccount(ctx, s.pool, accountID)
	if err != nil {
		return "", err
	}
	canonical, err := checkPasswordPolicy(next, passwordContext{email: pa.loginEmail, username: pa.username, phone: pa.phone})
	if err != nil {
		return "", err
	}
	hash, err := hashPassword(ctx, canonical)
	if err != nil {
		return "", err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockAccountPassword(ctx, tx, accountID, phc); err != nil {
		if errors.Is(err, ErrInvalidCredentials) {
			return "", ErrWrongPassword
		}
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE account_passwords SET password_hash = $2, norm_version = $3, updated_at = NOW()
		WHERE account_id = $1::uuid
	`, accountID, hash, passwordNormVersion); err != nil {
		return "", fmt.Errorf("set password: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_credentials WHERE account_id = $1::uuid AND install_id <> $2`,
		accountID, installID); err != nil {
		return "", fmt.Errorf("sign out other installs: %w", err)
	}
	sessionJWT, err := s.reissueSession(ctx, tx, sess)
	if err != nil {
		return "", err
	}
	if err := s.enqueueNotice(ctx, tx, mail.KindPasswordChanged, lang, pa.loginEmail); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit password change: %w", err)
	}
	s.outbox.Nudge()
	if err := clearThrottle(ctx, s.pool, throttlePwChange, throttle); err != nil {
		log.Printf("auth/email: clearing a password-change throttle failed: %v", err)
	}
	return sessionJWT, nil
}

// reissueSession signs a fresh JWT for the same session (same epoch) after
// checking that its credential is still the live one.
func (s *Service) reissueSession(ctx context.Context, q queryRower, sess *SessionClaims) (string, error) {
	var epoch int64
	err := q.QueryRow(ctx, `
		SELECT session_epoch FROM auth_credentials
		WHERE install_id = $1 AND provider = $2 AND account_id = $3::uuid AND revoked_at IS NULL
	`, sess.InstallID, sess.Provider, sess.AccountID).Scan(&epoch)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && epoch != sess.Epoch) {
		return "", ErrSessionRevoked
	}
	if err != nil {
		return "", fmt.Errorf("read session: %w", err)
	}
	return SignSessionEpoch(s.sessionSecret, sess.AccountID, sess.InstallID, sess.Provider, sess.ProviderSub, epoch)
}

// RemovePassword removes the password sign-in: the password, the 'email'
// identity, the username (it only works with a password) and every
// email-provider session of the account, then mails a notice to the old
// sign-in address. Only a Google or Apple session may do it, so whoever removes
// it controls the account's other sign-in; it is the way out when someone else
// added a password. Removing a password that does not exist succeeds.
func (s *Service) RemovePassword(ctx context.Context, accountID, sessionProvider, lang string) error {
	if sessionProvider != ProviderGoogle && sessionProvider != ProviderApple {
		return ErrProviderSessionRequired
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var hasProvider bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM account_identities ai WHERE ai.account_id = a.id AND ai.provider = $2)
		FROM accounts a WHERE a.id = $1::uuid FOR UPDATE
	`, accountID, sessionProvider).Scan(&hasProvider); err != nil {
		return fmt.Errorf("lock account: %w", err)
	}
	if !hasProvider {
		return ErrProviderSessionRequired
	}
	var loginEmail string
	err = tx.QueryRow(ctx, `DELETE FROM account_passwords WHERE account_id = $1::uuid RETURNING login_email`,
		accountID).Scan(&loginEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove password: %w", err)
	}
	for _, stmt := range []string{
		`DELETE FROM account_identities WHERE account_id = $1::uuid AND provider = 'email'`,
		`UPDATE accounts SET username = NULL WHERE id = $1::uuid`,
		`DELETE FROM auth_credentials WHERE account_id = $1::uuid AND provider = 'email'`,
		`UPDATE email_codes SET consumed_at = NOW() WHERE account_id = $1::uuid AND consumed_at IS NULL`,
	} {
		if _, err := tx.Exec(ctx, stmt, accountID); err != nil {
			return fmt.Errorf("remove password sign-in: %w", err)
		}
	}
	if err := s.enqueueNotice(ctx, tx, mail.KindPasswordRemoved, lang, loginEmail); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit password removal: %w", err)
	}
	s.outbox.Nudge()
	return nil
}

var (
	usernamePattern  = regexp.MustCompile(`^[a-z][a-z0-9_.]{2,29}$`)
	reservedUsername = []string{"kaata", "admin", "support", "help", "official", "verified", "staff",
		"team", "security", "moderator", "system", "root"}
)

// SetUsername sets or (with "") removes the private sign-in handle. Only an
// account with a password may have one: a username alone cannot sign in.
func (s *Service) SetUsername(ctx context.Context, accountID, raw string) (string, error) {
	u := strings.ToLower(strings.TrimSpace(foldDigits(raw)))
	if u == "" {
		if _, err := s.pool.Exec(ctx, `UPDATE accounts SET username = NULL WHERE id = $1::uuid`, accountID); err != nil {
			return "", fmt.Errorf("remove username: %w", err)
		}
		return "", nil
	}
	if !usernamePattern.MatchString(u) || strings.Contains(u, "..") || strings.HasSuffix(u, ".") {
		return "", &InvalidUsernameError{Reason: "format"}
	}
	for _, r := range reservedUsername {
		if strings.Contains(u, r) {
			return "", &InvalidUsernameError{Reason: "reserved"}
		}
	}
	var hasPassword bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM account_passwords WHERE account_id = $1::uuid)`,
		accountID).Scan(&hasPassword); err != nil {
		return "", fmt.Errorf("read password: %w", err)
	}
	if !hasPassword {
		return "", ErrNoPassword
	}
	if _, err := s.pool.Exec(ctx, `UPDATE accounts SET username = $2 WHERE id = $1::uuid`, accountID, u); err != nil {
		if isUniqueViolation(err) {
			return "", ErrUsernameTaken
		}
		return "", fmt.Errorf("set username: %w", err)
	}
	return u, nil
}

// SetAccountName sets the account name of an account no provider names. Shared
// tallies, reviews and pushes show accounts.name, so an email account needs one.
func (s *Service) SetAccountName(ctx context.Context, accountID, raw string) (string, error) {
	name := sanitizeDisplayName(raw)
	if n := utf8.RuneCountInString(name); n < 2 || n > 60 {
		return "", &InvalidNameError{}
	}
	var providerNamed bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM account_identities
		               WHERE account_id = $1::uuid AND provider IN ('google', 'apple'))
	`, accountID).Scan(&providerNamed); err != nil {
		return "", fmt.Errorf("read identities: %w", err)
	}
	if providerNamed {
		return "", ErrProviderName
	}
	if _, err := s.pool.Exec(ctx, `UPDATE accounts SET name = $2, display_name = $2 WHERE id = $1::uuid`, accountID, name); err != nil {
		return "", fmt.Errorf("set name: %w", err)
	}
	return name, nil
}

// SetAccountDisplayName is the explicit Kaata profile edit for every provider.
// It never changes the provider identity, proven email, credential or password.
func (s *Service) SetAccountDisplayName(ctx context.Context, accountID, raw string) (string, error) {
	name := sanitizeDisplayName(raw)
	if n := utf8.RuneCountInString(name); n < 2 || n > 60 {
		return "", &InvalidNameError{}
	}
	result, err := s.pool.Exec(ctx, `UPDATE accounts SET display_name = $2 WHERE id = $1::uuid AND disabled_at IS NULL`, accountID, name)
	if err != nil {
		return "", fmt.Errorf("set display name: %w", err)
	}
	if result.RowsAffected() != 1 {
		return "", ErrSessionRevoked
	}
	return name, nil
}

// sanitizeDisplayName: NFC, bidi controls and invisible characters removed,
// whitespace collapsed. ZWNJ and ZWJ stay: Dari spelling needs them (they
// decide which letters join), so a name keeps its written form.
func sanitizeDisplayName(raw string) string {
	s := norm.NFC.String(raw)
	s = strings.Map(func(r rune) rune {
		if isBidiControl(r) || r == 0x200B || r == 0x2060 || r == 0xFEFF {
			return -1
		}
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// AccountMe is GET /v1/account/me. SetupEmail is the address a first
// password's code goes to; empty when the user must name one.
type AccountMe struct {
	Email       string   `json:"email"`
	LoginEmail  string   `json:"login_email,omitempty"`
	Username    string   `json:"username,omitempty"`
	HasPassword bool     `json:"has_password"`
	Providers   []string `json:"providers"`
	Name        string   `json:"name,omitempty"`
	SetupEmail  string   `json:"setup_email,omitempty"`
}

func (s *Service) AccountMe(ctx context.Context, accountID string) (AccountMe, error) {
	var me AccountMe
	var login *string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(a.email, ''), COALESCE(a.username, ''), COALESCE(a.display_name, a.name, ''), p.login_email,
		       ARRAY(SELECT DISTINCT provider FROM account_identities WHERE account_id = a.id ORDER BY provider)
		FROM accounts a LEFT JOIN account_passwords p ON p.account_id = a.id
		WHERE a.id = $1::uuid
	`, accountID).Scan(&me.Email, &me.Username, &me.Name, &login, &me.Providers)
	if err != nil {
		return AccountMe{}, fmt.Errorf("read account: %w", err)
	}
	if login != nil {
		me.LoginEmail, me.HasPassword = *login, true
	}
	if me.Providers == nil {
		me.Providers = []string{}
	}
	if !me.HasPassword {
		email, _, fixed, err := setupAddress(ctx, s.pool, accountID, me.Email)
		if err != nil {
			return AccountMe{}, err
		}
		if fixed {
			me.SetupEmail = email
		}
	}
	return me, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
