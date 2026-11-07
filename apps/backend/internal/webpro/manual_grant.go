package webpro

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type ManualGrant struct {
	ID           string     `json:"id"`
	GrantedAt    time.Time  `json:"granted_at"`
	ExpiresAt    time.Time  `json:"expires_at"`
	Reason       string     `json:"reason"`
	RevokedAt    *time.Time `json:"revoked_at,omitempty"`
	RevokeReason *string    `json:"revoke_reason,omitempty"`

	revokeOperationID *string
}

type ManualGrantInput struct {
	OperationID string    `json:"operation_id"`
	ExpiresAt   time.Time `json:"expires_at"`
	Reason      string    `json:"reason"`
}

type RevokeManualGrantInput struct {
	OperationID string `json:"operation_id"`
	Reason      string `json:"reason"`
}

type ManualGrantResult struct {
	Grant     ManualGrant `json:"grant"`
	Duplicate bool        `json:"duplicate"`
}

const manualGrantColumns = `id::text, granted_at, expires_at, reason, revoked_at, revoke_reason, revoke_operation_id::text`

func scanManualGrant(row pgx.Row) (ManualGrant, error) {
	var grant ManualGrant
	err := row.Scan(&grant.ID, &grant.GrantedAt, &grant.ExpiresAt, &grant.Reason, &grant.RevokedAt, &grant.RevokeReason, &grant.revokeOperationID)
	if err != nil {
		return ManualGrant{}, err
	}
	grant.GrantedAt = grant.GrantedAt.UTC()
	grant.ExpiresAt = grant.ExpiresAt.UTC()
	grant.RevokedAt = utcTime(grant.RevokedAt)
	return grant, nil
}

func utcTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	utc := t.UTC()
	return &utc
}

func effectiveProExpiry(paid, complimentary *time.Time) *time.Time {
	if complimentary != nil && (paid == nil || complimentary.After(*paid)) {
		return complimentary
	}
	return paid
}

func grantReason(input string) (string, bool) {
	reason := strings.TrimSpace(input)
	return reason, reason != "" && utf8.ValidString(reason) && utf8.RuneCountInString(reason) <= 240 && strings.IndexFunc(reason, unicode.IsControl) < 0
}

// Serializes operator mutations for this account and rejects accounts that are
// disabled or being deleted. The lock allows billing foreign-key key shares.
func lockActiveAdminAccount(ctx context.Context, tx pgx.Tx, accountID string) error {
	var found int
	err := tx.QueryRow(ctx, `SELECT 1 FROM accounts
		WHERE id=$1::uuid AND disabled_at IS NULL AND pending_delete_at IS NULL
		FOR NO KEY UPDATE`, accountID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func adminGrantHistory(ctx context.Context, tx pgx.Tx, accountID string, now time.Time) ([]ManualGrant, *ManualGrant, error) {
	rows, err := tx.Query(ctx, `SELECT `+manualGrantColumns+`
		FROM web_pro_manual_grants WHERE account_id=$1::uuid
		ORDER BY (revoked_at IS NULL AND expires_at>$2) DESC, granted_at DESC, id DESC LIMIT 20`, accountID, now)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	history := []ManualGrant{}
	for rows.Next() {
		grant, err := scanManualGrant(rows)
		if err != nil {
			return nil, nil, err
		}
		history = append(history, grant)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var active *ManualGrant
	if len(history) != 0 && history[0].RevokedAt == nil && history[0].ExpiresAt.After(now) {
		active = &history[0]
	}
	return history, active, nil
}

func (s *Service) GrantManualPro(ctx context.Context, accountID string, input ManualGrantInput) (ManualGrantResult, error) {
	account, accountErr := uuid.Parse(accountID)
	op, opErr := uuid.Parse(input.OperationID)
	reason, reasonOK := grantReason(input.Reason)
	expiresAt := input.ExpiresAt.UTC().Truncate(time.Microsecond)
	if accountErr != nil || account == uuid.Nil || opErr != nil || op == uuid.Nil || !reasonOK || expiresAt.IsZero() || expiresAt.Year() > 9999 {
		return ManualGrantResult{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ManualGrantResult{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockActiveAdminAccount(ctx, tx, account.String()); err != nil {
		return ManualGrantResult{}, err
	}
	grant, err := scanManualGrant(tx.QueryRow(ctx, `SELECT `+manualGrantColumns+`
		FROM web_pro_manual_grants WHERE id=$1::uuid AND account_id=$2::uuid`, op.String(), account.String()))
	if err == nil {
		if grant.Reason != reason || !grant.ExpiresAt.Equal(expiresAt) {
			return ManualGrantResult{}, ErrConflict
		}
		return ManualGrantResult{Grant: grant, Duplicate: true}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ManualGrantResult{}, err
	}
	now := s.now().UTC().Truncate(time.Microsecond)
	if !expiresAt.After(now) {
		return ManualGrantResult{}, ErrInvalid
	}
	// Account locking serializes the check and insert. Operation IDs also
	// prevent an uncertain response from creating another grant on retry.
	grant, err = scanManualGrant(tx.QueryRow(ctx, `
		INSERT INTO web_pro_manual_grants(id, account_id, granted_at, expires_at, reason)
		SELECT $1::uuid, $2::uuid, $3, $4, $5 WHERE NOT EXISTS (
			SELECT 1 FROM web_pro_manual_grants WHERE account_id=$2::uuid AND revoked_at IS NULL AND expires_at>$3
		) ON CONFLICT (id) DO NOTHING RETURNING `+manualGrantColumns,
		op.String(), account.String(), now, expiresAt, reason))
	if errors.Is(err, pgx.ErrNoRows) {
		return ManualGrantResult{}, ErrConflict
	}
	if err != nil {
		return ManualGrantResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ManualGrantResult{}, err
	}
	return ManualGrantResult{Grant: grant}, nil
}

func (s *Service) RevokeManualPro(ctx context.Context, accountID, grantID string, input RevokeManualGrantInput) (ManualGrantResult, error) {
	account, accountErr := uuid.Parse(accountID)
	grantUUID, grantErr := uuid.Parse(grantID)
	op, opErr := uuid.Parse(input.OperationID)
	reason, reasonOK := grantReason(input.Reason)
	if accountErr != nil || account == uuid.Nil || grantErr != nil || grantUUID == uuid.Nil || opErr != nil || op == uuid.Nil || !reasonOK {
		return ManualGrantResult{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ManualGrantResult{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockActiveAdminAccount(ctx, tx, account.String()); err != nil {
		return ManualGrantResult{}, err
	}
	grant, err := scanManualGrant(tx.QueryRow(ctx, `SELECT `+manualGrantColumns+`
		FROM web_pro_manual_grants WHERE id=$1::uuid AND account_id=$2::uuid`, grantUUID.String(), account.String()))
	if errors.Is(err, pgx.ErrNoRows) {
		return ManualGrantResult{}, ErrNotFound
	}
	if err != nil {
		return ManualGrantResult{}, err
	}
	if grant.RevokedAt != nil {
		if *grant.revokeOperationID == op.String() && *grant.RevokeReason == reason {
			return ManualGrantResult{Grant: grant, Duplicate: true}, nil
		}
		return ManualGrantResult{}, ErrConflict
	}
	now := s.now().UTC().Truncate(time.Microsecond)
	if !grant.ExpiresAt.After(now) {
		return ManualGrantResult{}, ErrConflict
	}
	grant, err = scanManualGrant(tx.QueryRow(ctx, `UPDATE web_pro_manual_grants
		SET revoked_at=$2, revoke_reason=$3, revoke_operation_id=$4::uuid WHERE id=$1::uuid
		RETURNING `+manualGrantColumns, grantUUID.String(), now, reason, op.String()))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "web_pro_manual_grants_revoke_operation_id_key" {
		return ManualGrantResult{}, ErrConflict
	}
	if err != nil {
		return ManualGrantResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ManualGrantResult{}, err
	}
	return ManualGrantResult{Grant: grant}, nil
}
