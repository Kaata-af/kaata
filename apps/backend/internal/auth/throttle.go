package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"net"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/matee/kaata-backend/internal/mail"
)

// Throttles for Kaata email accounts (docs/kaata-accounts.md §4, §6). Every
// row in auth_throttle_events is keyed by an HMAC, never the identifier. Every
// limit counts the requests it ADMITS, whatever they led to, and refuses
// without recording, so a known address and an unknown one are throttled
// identically and the advertised retry time is exact.

const (
	throttleMail       = "mail"        // start requests per address, every purpose
	throttleMailClient = "mail_client" // start requests per client (IP or account)
	throttleMailGlobal = "mail_global" // mail across everyone: admitted starts and notices
	throttleNotice     = "notice"      // security notices per recipient
	throttleCodeFail   = "code_fail"   // wrong codes per address (and per account for setup)
	throttleLogin      = "login"       // password sign-in attempts per identifier
	throttlePwChange   = "pw_change"   // change-password attempts per account
)

type mailLimit struct {
	window time.Duration
	max    int
	label  string
}

// Per address, across every mail kind.
var mailLimits = []mailLimit{
	{time.Minute, 1, "minute"},
	{time.Hour, 5, "hour"},
	{24 * time.Hour, 10, "day"},
}

// Per client: one IP (an IPv6 address by its /64) for the public starts, the
// account for set-password. Below the global budget, so one client cannot
// spend it for everyone, and loose enough for a mobile carrier's shared
// (CGNAT) address, which fronts many shops: the per-address and global budgets
// are the real brakes.
var mailClientLimits = []mailLimit{
	{time.Hour, 10, "hour"},
	{24 * time.Hour, 30, "day"},
}

// Per recipient and kind, for the security notices a verify or a password
// change sends (they carry no code). Repeats of one kind closer together are
// coalesced: the first says all a later one would. Another kind (a removal
// right after a password was set) still goes out.
var noticeLimits = []mailLimit{
	{10 * time.Minute, 1, "minutes"},
	{24 * time.Hour, 6, "day"},
}

// signupBudgetShare: sign-up may use only this share of the global budget, so a
// sign-up flood cannot starve password recovery.
const signupBudgetShare = 0.8

const (
	loginWindow      = 15 * time.Minute
	loginMaxAttempts = 10
	codeFailWindow   = 24 * time.Hour
	codeFailBudget   = 10
)

// ThrottledError: the per-address mail limits refused the request (429
// too_many_requests). Limit says which window, so the app can tell a resend
// that came too soon from a real refusal.
type ThrottledError struct {
	RetryAfter time.Duration
	Limit      string
}

func (e *ThrottledError) Error() string { return "too many requests (" + e.Limit + ")" }

// RateLimitedError: the client's own start budget is spent (429 rate_limited).
type RateLimitedError struct{ RetryAfter time.Duration }

func (e *RateLimitedError) Error() string { return "too many requests from this client" }

// AttemptsError: too many sign-in, password or code attempts (429
// too_many_attempts).
type AttemptsError struct{ RetryAfter time.Duration }

func (e *AttemptsError) Error() string { return "too many attempts" }

// RetryAfterSeconds rounds up, never below 1.
func RetryAfterSeconds(d time.Duration) int {
	s := int(math.Ceil(d.Seconds()))
	if s < 1 {
		return 1
	}
	return s
}

// derivedKey separates the HMAC keys used here from the session secret.
func (s *Service) derivedKey(label string) []byte {
	sum := sha256.Sum256([]byte(label + "\x00" + s.sessionSecret))
	return sum[:]
}

func (s *Service) throttleKey(scope, id string) []byte {
	mac := hmac.New(sha256.New, s.derivedKey("kaata-auth-throttle-v1"))
	mac.Write([]byte(scope))
	mac.Write([]byte{0})
	mac.Write([]byte(id))
	return mac.Sum(nil)
}

// ClientKey names the client of a public start request: the IP, or for IPv6
// its /64, which one subscriber usually holds whole.
func ClientKey(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return "ip:" + ip
	}
	if v4 := parsed.To4(); v4 != nil {
		return "ip:" + v4.String()
	}
	return "ip6:" + parsed.Mask(net.CIDRMask(64, 128)).String()
}

type execQuerier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func recordThrottle(ctx context.Context, q execQuerier, scope string, key []byte) error {
	if _, err := q.Exec(ctx, `INSERT INTO auth_throttle_events (scope, key) VALUES ($1, $2)`, scope, key); err != nil {
		return fmt.Errorf("record throttle event: %w", err)
	}
	return nil
}

// throttleWindow counts events inside the window and says when the oldest of
// them leaves it.
func throttleWindow(ctx context.Context, q execQuerier, scope string, key []byte, window time.Duration) (int, time.Duration, error) {
	var n int
	var oldest *time.Time
	if err := q.QueryRow(ctx, `
		SELECT COUNT(*), MIN(created_at) FROM auth_throttle_events
		WHERE scope = $1 AND key = $2 AND created_at > NOW() - make_interval(secs => $3)
	`, scope, key, window.Seconds()).Scan(&n, &oldest); err != nil {
		return 0, 0, fmt.Errorf("read throttle window: %w", err)
	}
	retry := window
	if oldest != nil {
		retry = time.Until(oldest.Add(window))
	}
	return n, retry, nil
}

// limitsAllow checks every window of one key. When some are full it returns
// the LONGEST wait and that window's label, so the advertised retry time is
// when the request would really be admitted.
func limitsAllow(ctx context.Context, q execQuerier, scope string, key []byte, limits []mailLimit) (bool, time.Duration, string, error) {
	ok, wait, label := true, time.Duration(0), ""
	for _, l := range limits {
		n, retry, err := throttleWindow(ctx, q, scope, key, l.window)
		if err != nil {
			return false, 0, "", err
		}
		if n >= l.max && (ok || retry > wait) {
			ok, wait, label = false, retry, l.label
		}
	}
	return ok, wait, label, nil
}

func clearThrottle(ctx context.Context, q execQuerier, scope string, key []byte) error {
	if _, err := q.Exec(ctx, `DELETE FROM auth_throttle_events WHERE scope = $1 AND key = $2`, scope, key); err != nil {
		return fmt.Errorf("clear throttle: %w", err)
	}
	return nil
}

// lockThrottleKey serializes every check-then-record on one key for the rest
// of the transaction, so a burst cannot slip past a limit.
func lockThrottleKey(ctx context.Context, tx pgx.Tx, scope string, key []byte) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		scope+":"+hex.EncodeToString(key)); err != nil {
		return fmt.Errorf("lock throttle key: %w", err)
	}
	return nil
}

// admitStart admits one start request (sign-up, reset or set-password) in a
// short transaction of its own, BEFORE the address is looked up, so every
// address gets the same answer: the client's budget, then the address's, then
// the global one, locked in that order. A refused request records nothing; an
// admitted one is recorded in all three, whatever it then leads to.
func (s *Service) admitStart(ctx context.Context, client, emailKey, purpose string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	clientKey := s.throttleKey(throttleMailClient, client)
	if err := lockThrottleKey(ctx, tx, throttleMailClient, clientKey); err != nil {
		return err
	}
	if ok, retry, _, err := limitsAllow(ctx, tx, throttleMailClient, clientKey, mailClientLimits); err != nil {
		return err
	} else if !ok {
		return &RateLimitedError{RetryAfter: retry}
	}

	addrKey := s.throttleKey(throttleMail, emailKey)
	if err := lockThrottleKey(ctx, tx, throttleMail, addrKey); err != nil {
		return err
	}
	if ok, retry, label, err := limitsAllow(ctx, tx, throttleMail, addrKey, mailLimits); err != nil {
		return err
	} else if !ok {
		return &ThrottledError{RetryAfter: retry, Limit: label}
	}

	globalKey := s.throttleKey(throttleMailGlobal, "all")
	if ok, label, err := s.globalMailAllows(ctx, tx, globalKey, purpose == purposeSignup); err != nil {
		return err
	} else if !ok {
		log.Printf("mail: ALERT global mail budget spent for %s (%s window); answering 503", purpose, label)
		return mail.ErrUnavailable
	}

	for _, rec := range []struct {
		scope string
		key   []byte
	}{{throttleMailClient, clientKey}, {throttleMail, addrKey}, {throttleMailGlobal, globalKey}} {
		if err := recordThrottle(ctx, tx, rec.scope, rec.key); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit start admission: %w", err)
	}
	return nil
}

// globalMailAllows locks the global budget, which counts every mail
// (admitted starts and notices), for the rest of tx and checks it. Sign-up
// gets only its share, so a sign-up flood cannot starve recovery.
func (s *Service) globalMailAllows(ctx context.Context, tx pgx.Tx, globalKey []byte, signup bool) (bool, string, error) {
	if err := lockThrottleKey(ctx, tx, throttleMailGlobal, globalKey); err != nil {
		return false, "", err
	}
	perHour, perDay := s.outbox.Limits()
	if signup {
		perHour, perDay = signupShare(perHour), signupShare(perDay)
	}
	var global []mailLimit
	if perHour > 0 {
		global = append(global, mailLimit{time.Hour, perHour, "hour"})
	}
	if perDay > 0 {
		global = append(global, mailLimit{24 * time.Hour, perDay, "day"})
	}
	ok, _, label, err := limitsAllow(ctx, tx, throttleMailGlobal, globalKey, global)
	return ok, label, err
}

// admitNotice decides inside tx whether a security notice of this kind to this
// recipient goes out: at most one per 10 minutes and 6 a day, and only while
// the global mail budget has room. A refused notice is simply skipped, never
// an error: the flow that sends it has already succeeded. Lock order: the
// recipient, then the global key, both after whatever tx already holds.
func (s *Service) admitNotice(ctx context.Context, tx pgx.Tx, kind mail.Kind, recipient string) (bool, error) {
	key := s.throttleKey(throttleNotice, string(kind)+"\x00"+strings.ToLower(strings.TrimSpace(recipient)))
	if err := lockThrottleKey(ctx, tx, throttleNotice, key); err != nil {
		return false, err
	}
	if ok, _, _, err := limitsAllow(ctx, tx, throttleNotice, key, noticeLimits); err != nil || !ok {
		return false, err
	}
	globalKey := s.throttleKey(throttleMailGlobal, "all")
	if ok, label, err := s.globalMailAllows(ctx, tx, globalKey, false); err != nil {
		return false, err
	} else if !ok {
		log.Printf("mail: ALERT global mail budget spent (%s window); skipping a security notice", label)
		return false, nil
	}
	if err := recordThrottle(ctx, tx, throttleNotice, key); err != nil {
		return false, err
	}
	if err := recordThrottle(ctx, tx, throttleMailGlobal, globalKey); err != nil {
		return false, err
	}
	return true, nil
}

// signupShare is sign-up's part of a global limit (0 = no limit stays 0).
func signupShare(max int) int {
	if max <= 0 {
		return max
	}
	n := int(float64(max) * signupBudgetShare)
	if n < 1 {
		n = 1
	}
	return n
}

// admitAttempt admits one sign-in or password-change attempt: refused, without
// recording, once max admitted attempts are inside the window; otherwise
// recorded BEFORE the password is checked, so a failed attempt counts too.
// Success clears the key (clearThrottle). RetryAfter is exact: it is when the
// oldest admitted attempt leaves the window.
func (s *Service) admitAttempt(ctx context.Context, scope, id string, window time.Duration, max int) ([]byte, error) {
	key := s.throttleKey(scope, id)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockThrottleKey(ctx, tx, scope, key); err != nil {
		return nil, err
	}
	n, retry, err := throttleWindow(ctx, tx, scope, key, window)
	if err != nil {
		return nil, err
	}
	if n >= max {
		return nil, &AttemptsError{RetryAfter: retry}
	}
	if err := recordThrottle(ctx, tx, scope, key); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit attempt: %w", err)
	}
	return key, nil
}
