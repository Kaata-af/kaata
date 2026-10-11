package auth

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/text/unicode/norm"
)

// Passwords for Kaata email accounts (docs/kaata-accounts.md §3).

// passwordNormVersion is stored with every hash (account_passwords.norm_version),
// so the canonicalization below can change later without locking anyone out.
const passwordNormVersion = 1

const (
	passwordMinRunes = 8
	passwordMaxRunes = 128
)

// argon2id parameters: OWASP's minimum (19 MiB, 2 passes, 1 lane).
const (
	argonMemoryKiB = 19456
	argonTime      = 2
	argonThreads   = 1
	argonSaltLen   = 16
	argonKeyLen    = 32
)

// Hashing is memory-hard on purpose; cap concurrent hashes so a burst of
// sign-ins cannot exhaust the server. hashSlotWait bounds the queue.
var hashSlots = make(chan struct{}, 4)

const hashSlotWait = 3 * time.Second

// ErrHashBusy: every hashing slot stayed busy for hashSlotWait. Retryable (503).
var ErrHashBusy = errors.New("password hashing is busy")

// Policy refusal reasons, returned to the app as `reason`.
const (
	PasswordTooShort   = "too_short"
	PasswordTooLong    = "too_long"
	PasswordWhitespace = "whitespace"
	PasswordCommon     = "common"
	PasswordPersonal   = "personal"
	PasswordPattern    = "pattern"
)

// WeakPasswordError carries the policy reason.
type WeakPasswordError struct{ Reason string }

func (e *WeakPasswordError) Error() string { return "weak password: " + e.Reason }

//go:embed common_passwords.txt
var commonPasswordsFile string

var commonPasswords = loadWordList(commonPasswordsFile)

func loadWordList(raw string) map[string]struct{} {
	out := map[string]struct{}{}
	sc := bufio.NewScanner(strings.NewReader(raw))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out[strings.ToLower(line)] = struct{}{}
	}
	return out
}

// canonicalizePassword makes the same visible password the same bytes on every
// keyboard (norm_version 1): NFKC; Persian and Arabic-Indic digits to ASCII;
// Arabic yeh, alef maksura and kaf to their Persian forms; zero-width joiners
// and bidi controls removed.
func canonicalizePassword(s string) string {
	s = norm.NFKC.String(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= 0x06F0 && r <= 0x06F9:
			b.WriteRune('0' + (r - 0x06F0))
		case r >= 0x0660 && r <= 0x0669:
			b.WriteRune('0' + (r - 0x0660))
		case r == 0x064A || r == 0x0649:
			b.WriteRune(0x06CC)
		case r == 0x0643:
			b.WriteRune(0x06A9)
		case r == 0x200C || r == 0x200D || isBidiControl(r):
			// dropped
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) ||
		r == 0x200E || r == 0x200F || r == 0x061C
}

// passwordContext is what the policy compares a new password against.
type passwordContext struct {
	email    string // the sign-in address
	username string
	phone    string // E.164, may be empty
}

// checkPasswordPolicy returns the canonical password, or a *WeakPasswordError.
// It runs on every password that is SET; sign-in never re-checks the policy.
func checkPasswordPolicy(raw string, pc passwordContext) (string, error) {
	p := canonicalizePassword(raw)
	n := utf8.RuneCountInString(p)
	if n < passwordMinRunes {
		return "", &WeakPasswordError{PasswordTooShort}
	}
	if n > passwordMaxRunes {
		return "", &WeakPasswordError{PasswordTooLong}
	}
	first, _ := utf8.DecodeRuneInString(p)
	last, _ := utf8.DecodeLastRuneInString(p)
	if unicode.IsSpace(first) || unicode.IsSpace(last) {
		return "", &WeakPasswordError{PasswordWhitespace}
	}
	lower := strings.ToLower(p)
	if isAllDigits(lower) && n < 12 {
		return "", &WeakPasswordError{PasswordPattern}
	}
	if hasRun(lower, 6) {
		return "", &WeakPasswordError{PasswordPattern}
	}
	if isCommonPassword(lower) {
		return "", &WeakPasswordError{PasswordCommon}
	}
	if containsPersonal(lower, pc) {
		return "", &WeakPasswordError{PasswordPersonal}
	}
	return p, nil
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// hasRun reports a run of n or more identical, ascending or descending
// characters ("aaaaaa", "123456", "fedcba").
func hasRun(s string, n int) bool {
	rs := []rune(s)
	same, up, down := 1, 1, 1
	for i := 1; i < len(rs); i++ {
		if rs[i] == rs[i-1] {
			same++
		} else {
			same = 1
		}
		if rs[i] == rs[i-1]+1 {
			up++
		} else {
			up = 1
		}
		if rs[i] == rs[i-1]-1 {
			down++
		} else {
			down = 1
		}
		if same >= n || up >= n || down >= n {
			return true
		}
	}
	return false
}

// isCommonPassword: the password, or the password without trailing digits and
// symbols ("monkey123!"), is on the list.
func isCommonPassword(lower string) bool {
	if _, ok := commonPasswords[lower]; ok {
		return true
	}
	base := strings.TrimRightFunc(lower, func(r rune) bool {
		return unicode.IsDigit(r) || unicode.IsPunct(r) || unicode.IsSymbol(r)
	})
	if utf8.RuneCountInString(base) >= 3 {
		if _, ok := commonPasswords[base]; ok {
			return true
		}
	}
	return false
}

func containsPersonal(lower string, pc passwordContext) bool {
	if at := strings.LastIndexByte(pc.email, '@'); at >= 4 {
		local := strings.ToLower(pc.email[:at])
		if i := strings.IndexByte(local, '+'); i >= 0 {
			local = local[:i]
		}
		if len(local) >= 4 && strings.Contains(lower, local) {
			return true
		}
	}
	if u := strings.ToLower(pc.username); len(u) >= 3 && strings.Contains(lower, u) {
		return true
	}
	// The national part of the phone: what people type, without the country code.
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, pc.phone)
	if len(digits) >= 9 {
		if national := digits[len(digits)-9:]; strings.Contains(lower, national) {
			return true
		}
	}
	return false
}

func acquireHashSlot(ctx context.Context) (func(), error) {
	timer := time.NewTimer(hashSlotWait)
	defer timer.Stop()
	select {
	case hashSlots <- struct{}{}:
		return func() { <-hashSlots }, nil
	case <-timer.C:
		return nil, ErrHashBusy
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// hashPassword returns an argon2id PHC string for a canonical password. Never
// call it inside a DB transaction: it holds a hashing slot for ~50 ms.
func hashPassword(ctx context.Context, canonical string) (string, error) {
	release, err := acquireHashSlot(ctx)
	if err != nil {
		return "", err
	}
	defer release()
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("password salt: %w", err)
	}
	return argonPHC(canonical, salt), nil
}

// argonPHC hashes with today's parameters and formats the PHC string. It takes
// no hashing slot: callers either hold one or run it once (dummyHash).
func argonPHC(canonical string, salt []byte) string {
	key := argon2.IDKey([]byte(canonical), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemoryKiB, argonTime,
		argonThreads, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}

type phcParams struct {
	memory  uint32
	time    uint32
	threads uint8
	salt    []byte
	key     []byte
}

func parsePHC(phc string) (phcParams, error) {
	parts := strings.Split(phc, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return phcParams{}, errors.New("not an argon2id hash")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return phcParams{}, errors.New("unsupported argon2 version")
	}
	var p phcParams
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.memory, &p.time, &p.threads); err != nil {
		return phcParams{}, errors.New("malformed argon2 parameters")
	}
	var err error
	if p.salt, err = base64.RawStdEncoding.DecodeString(parts[4]); err != nil {
		return phcParams{}, errors.New("malformed salt")
	}
	if p.key, err = base64.RawStdEncoding.DecodeString(parts[5]); err != nil || len(p.key) == 0 {
		return phcParams{}, errors.New("malformed key")
	}
	if p.memory == 0 || p.memory > 1<<20 || p.time == 0 || p.time > 10 || p.threads == 0 {
		return phcParams{}, errors.New("argon2 parameters out of range")
	}
	return p, nil
}

// verifyPassword compares a canonical password with a stored PHC string in
// constant time. needsRehash is true when the stored parameters are weaker than
// today's. Never call it inside a DB transaction.
func verifyPassword(ctx context.Context, canonical, phc string) (ok, needsRehash bool, err error) {
	p, err := parsePHC(phc)
	if err != nil {
		return false, false, err
	}
	release, err := acquireHashSlot(ctx)
	if err != nil {
		return false, false, err
	}
	defer release()
	key := argon2.IDKey([]byte(canonical), p.salt, p.time, p.memory, p.threads, uint32(len(p.key)))
	ok = subtle.ConstantTimeCompare(key, p.key) == 1
	needsRehash = p.memory < argonMemoryKiB || p.time < argonTime || len(p.key) < argonKeyLen
	return ok, needsRehash, nil
}

// dummyVerify runs a full verification against a throwaway hash when the
// identifier is unknown, so a miss costs the same time as a wrong password and
// waits for a hashing slot the same way: under load it returns ErrHashBusy
// exactly as a known identifier would.
var (
	dummyOnce sync.Once
	dummyPHC  string
)

// dummyHash is built once, directly, without a hashing slot, so it can never
// be missing (a failed build cached forever would skip argon2 for every
// unknown identifier, a timing oracle).
func dummyHash() string {
	dummyOnce.Do(func() {
		salt := make([]byte, argonSaltLen)
		_, _ = rand.Read(salt)
		dummyPHC = argonPHC("kaata-dummy-password-for-timing", salt)
	})
	return dummyPHC
}

func dummyVerify(ctx context.Context, canonical string) error {
	_, _, err := verifyPassword(ctx, canonical, dummyHash())
	return err
}
