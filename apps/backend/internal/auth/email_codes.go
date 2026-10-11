package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/mail"
)

// Emailed one-time codes (docs/kaata-accounts.md §4). Only an HMAC of each
// code is stored; the plaintext exists in the outbox row until it is sent.

const (
	codeTTL          = 15 * time.Minute
	codeMaxAttempts  = 5
	codeLiveChecked  = 3 // a resend never kills a code that is already on its way
	codeReplayWindow = 15 * time.Minute
)

const (
	purposeSignup = "signup"
	purposeReset  = "reset"
	purposeSetup  = "setup"
)

var (
	// ErrInvalidCode: wrong, expired, used up or unknown (401 invalid_code).
	ErrInvalidCode = errors.New("invalid or expired code")
	// ErrInvalidCodeFormat: not 6 digits; no attempt is used (400).
	ErrInvalidCodeFormat = errors.New("the code must be 6 digits")
	// errCodeMismatch: the failure bookkeeping is in the transaction, which the
	// caller must COMMIT before answering ErrInvalidCode.
	errCodeMismatch = errors.New("code mismatch")
)

// normalizeCode folds Persian/Arabic digits and drops spaces and dashes; the
// result must be exactly 6 ASCII digits.
func normalizeCode(raw string) (string, error) {
	s := strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' || r == ' ' || r == '‌' || isBidiControl(r) {
			return -1
		}
		return r
	}, foldDigits(strings.TrimSpace(raw)))
	if len(s) != 6 {
		return "", ErrInvalidCodeFormat
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return "", ErrInvalidCodeFormat
		}
	}
	return s, nil
}

func newCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", fmt.Errorf("generate code: %w", err)
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func (s *Service) codeHash(id, code string) []byte {
	mac := hmac.New(sha256.New, s.derivedKey("kaata-email-code-v1"))
	mac.Write([]byte(id))
	mac.Write([]byte{0})
	mac.Write([]byte(code))
	return mac.Sum(nil)
}

// codeScope selects the codes one verification may use: by address for
// sign-up and reset, by account for a signed-in first password.
type codeScope struct {
	purpose   string
	emailKey  string
	accountID string
}

func (c codeScope) filter() (string, []any) {
	if c.purpose == purposeSetup {
		return "purpose = $1 AND account_id = $2::uuid", []any{c.purpose, c.accountID}
	}
	return "purpose = $1 AND email_key = $2", []any{c.purpose, c.emailKey}
}

type codeRow struct {
	id        string
	email     string
	emailKey  string
	accountID *string
	hash      []byte
	lang      string // the language its mail went out in
}

// issueCode inserts a code and queues its mail inside tx.
func (s *Service) issueCode(ctx context.Context, tx pgx.Tx, purpose, email, emailKey string,
	accountID *string, kind mail.Kind, lang string) error {
	code, err := newCode()
	if err != nil {
		return err
	}
	id := uuid.NewString()
	if _, err := tx.Exec(ctx, `
		INSERT INTO email_codes (id, purpose, email, email_key, account_id, code_hash, expires_at, lang)
		VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, NOW() + make_interval(secs => $7), $8)
	`, id, purpose, email, emailKey, accountID, s.codeHash(id, code), codeTTL.Seconds(), mail.Lang(lang)); err != nil {
		return fmt.Errorf("store code: %w", err)
	}
	return s.outbox.Enqueue(ctx, tx, mail.Render(kind, lang, email, code), codeTTL)
}

type rowsQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func (s *Service) selectCodes(ctx context.Context, q rowsQuerier, scope codeScope, extraWhere, suffix string, extra ...any) ([]codeRow, error) {
	where, args := scope.filter()
	args = append(args, extra...)
	rows, err := q.Query(ctx, `
		SELECT id::text, email, email_key, account_id::text, code_hash, lang
		FROM email_codes WHERE `+where+` AND `+extraWhere+`
		ORDER BY created_at DESC LIMIT `+fmt.Sprint(codeLiveChecked)+suffix, args...)
	if err != nil {
		return nil, fmt.Errorf("read codes: %w", err)
	}
	defer rows.Close()
	var out []codeRow
	for rows.Next() {
		var r codeRow
		if err := rows.Scan(&r.id, &r.email, &r.emailKey, &r.accountID, &r.hash, &r.lang); err != nil {
			return nil, fmt.Errorf("scan code: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// liveCodes: unconsumed, unexpired, with attempts left.
func (s *Service) liveCodes(ctx context.Context, q rowsQuerier, scope codeScope, lock bool) ([]codeRow, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	return s.selectCodes(ctx, q, scope,
		fmt.Sprintf("consumed_at IS NULL AND expires_at > NOW() AND attempts < %d", codeMaxAttempts), suffix)
}

// firstMatch compares against every row in constant time, so the position of a
// match does not change the time taken.
func (s *Service) firstMatch(rows []codeRow, code string) *codeRow {
	var hit *codeRow
	for i := range rows {
		if subtle.ConstantTimeCompare(s.codeHash(rows[i].id, code), rows[i].hash) == 1 && hit == nil {
			hit = &rows[i]
		}
	}
	return hit
}

// preMatchCode is a read-only check, without locks or bookkeeping, used to
// skip expensive work for a code that cannot be right.
func (s *Service) preMatchCode(ctx context.Context, scope codeScope, code string) (*codeRow, error) {
	rows, err := s.liveCodes(ctx, s.pool, scope, false)
	if err != nil {
		return nil, err
	}
	return s.firstMatch(rows, code), nil
}

// failureIDs names the wrong-code budgets one check spends, in lock order: the
// address for sign-up and reset; for a set-password check the account AND the
// address of every live code it compares, so several accounts cannot each spend
// a fresh budget guessing codes sent to one address.
func (s *Service) failureIDs(ctx context.Context, q rowsQuerier, scope codeScope) ([]string, error) {
	if scope.purpose != purposeSetup {
		return []string{"email:" + scope.emailKey}, nil
	}
	rows, err := s.liveCodes(ctx, q, scope, false)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var addresses []string
	for _, r := range rows {
		if !seen[r.emailKey] {
			seen[r.emailKey] = true
			addresses = append(addresses, "email:"+r.emailKey)
		}
	}
	sort.Strings(addresses)
	return append([]string{"account:" + scope.accountID}, addresses...), nil
}

// matchCodeLocked runs inside tx. It refuses once a wrong-code budget is
// spent, locks the live codes and compares. On a mismatch it adds an attempt to
// each live code, records the failure on every budget and returns
// errCodeMismatch: the caller commits that bookkeeping and answers
// ErrInvalidCode.
func (s *Service) matchCodeLocked(ctx context.Context, tx pgx.Tx, scope codeScope, code string) (*codeRow, error) {
	ids, err := s.failureIDs(ctx, tx, scope)
	if err != nil {
		return nil, err
	}
	failKeys := make([][]byte, 0, len(ids))
	var spent *AttemptsError // the longest wait among spent budgets
	for _, id := range ids {
		key := s.throttleKey(throttleCodeFail, id)
		if err := lockThrottleKey(ctx, tx, throttleCodeFail, key); err != nil {
			return nil, err
		}
		n, retry, err := throttleWindow(ctx, tx, throttleCodeFail, key, codeFailWindow)
		if err != nil {
			return nil, err
		}
		if n >= codeFailBudget && (spent == nil || retry > spent.RetryAfter) {
			spent = &AttemptsError{RetryAfter: retry}
		}
		failKeys = append(failKeys, key)
	}
	if spent != nil {
		return nil, spent
	}
	rows, err := s.liveCodes(ctx, tx, scope, true)
	if err != nil {
		return nil, err
	}
	if hit := s.firstMatch(rows, code); hit != nil {
		return hit, nil
	}
	codeIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		codeIDs = append(codeIDs, r.id)
	}
	if len(codeIDs) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE email_codes SET attempts = attempts + 1 WHERE id = ANY($1::uuid[])`, codeIDs); err != nil {
			return nil, fmt.Errorf("count code attempt: %w", err)
		}
	}
	for _, key := range failKeys {
		if err := recordThrottle(ctx, tx, throttleCodeFail, key); err != nil {
			return nil, err
		}
	}
	return nil, errCodeMismatch
}

// recordCodeFailure books a wrong code that the read-only pre-check already
// rejected, in its own committed transaction.
func (s *Service) recordCodeFailure(ctx context.Context, scope codeScope, code string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hit, err := s.matchCodeLocked(ctx, tx, scope, code)
	if errors.Is(err, errCodeMismatch) {
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit code failure: %w", err)
		}
		return ErrInvalidCode
	}
	if err != nil {
		return err
	}
	// A code issued between the pre-check and the lock matched. Leave it
	// unused; the user simply submits again.
	_ = hit
	return ErrInvalidCode
}

// consumeCode marks a code used, compare-and-set, recording which install used
// it (for replay) and the account it produced or targets.
func consumeCode(ctx context.Context, tx pgx.Tx, id, installID, accountID string) error {
	var install any
	if installID != "" {
		install = installID
	}
	tag, err := tx.Exec(ctx, `
		UPDATE email_codes
		SET consumed_at = NOW(), consumed_by_install = $2::uuid, account_id = COALESCE(account_id, $3::uuid)
		WHERE id = $1::uuid AND consumed_at IS NULL
	`, id, install, accountID)
	if err != nil {
		return fmt.Errorf("consume code: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrInvalidCode
	}
	return nil
}

// replayedCode finds a code this install already used, within the replay
// window, that matches: the retry of a request whose reply was lost.
func (s *Service) replayedCode(ctx context.Context, scope codeScope, code, installID string) (*codeRow, error) {
	if installID == "" {
		return nil, nil
	}
	rows, err := s.selectCodes(ctx, s.pool, scope,
		"consumed_at > NOW() - make_interval(secs => $3) AND consumed_by_install = $4::uuid", "",
		codeReplayWindow.Seconds(), installID)
	if err != nil {
		return nil, err
	}
	return s.firstMatch(rows, code), nil
}
