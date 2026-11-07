package webpro

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type AdminSubscription struct {
	AccountID             string         `json:"account_id"`
	Status                string         `json:"status"`
	SubscriptionExpiresAt *time.Time     `json:"subscription_expires_at"`
	Plans                 []Plan         `json:"plans"`
	PendingCheckout       bool           `json:"pending_checkout"`
	Payments              []AdminPayment `json:"payments"`
}

type AdminPayment struct {
	PaymentID             string     `json:"payment_id"`
	PlanID                string     `json:"plan_id"`
	AmountMinor           int64      `json:"amount_minor"`
	Currency              string     `json:"currency"`
	Method                string     `json:"method"`
	Reference             *string    `json:"reference,omitempty"`
	RecordedAt            time.Time  `json:"recorded_at"`
	SubscriptionExpiresAt *time.Time `json:"subscription_expires_at,omitempty"`
}

type ManualPaymentInput struct {
	PlanID    string `json:"plan_id"`
	Method    string `json:"method"`
	Reference string `json:"reference"`
}

type ManualPaymentResult struct {
	Payment               AdminPayment `json:"payment"`
	SubscriptionExpiresAt time.Time    `json:"subscription_expires_at"`
	Duplicate             bool         `json:"duplicate"`
}

const adminPaymentColumns = `id::text, plan_id, amount_minor, currency, method, reference, recorded_at, subscription_expires_at`

var manualReference = regexp.MustCompile(`^[A-Za-z0-9._/-]{3,64}$`)

func scanAdminPayment(row pgx.Row) (AdminPayment, error) {
	var payment AdminPayment
	if err := row.Scan(&payment.PaymentID, &payment.PlanID, &payment.AmountMinor, &payment.Currency,
		&payment.Method, &payment.Reference, &payment.RecordedAt, &payment.SubscriptionExpiresAt); err != nil {
		return AdminPayment{}, err
	}
	payment.RecordedAt = payment.RecordedAt.UTC()
	if payment.SubscriptionExpiresAt != nil {
		until := payment.SubscriptionExpiresAt.UTC()
		payment.SubscriptionExpiresAt = &until
	}
	return payment, nil
}

func (s *Service) AdminSubscription(ctx context.Context, accountID string) (AdminSubscription, error) {
	id, err := uuid.Parse(accountID)
	if err != nil {
		return AdminSubscription{}, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return AdminSubscription{}, err
	}
	defer tx.Rollback(ctx)

	out := AdminSubscription{Payments: []AdminPayment{}}
	// An expired checkout link can still have a late payment, so keep the
	// warning until there are no unconfirmed provider orders.
	err = tx.QueryRow(ctx, `
		SELECT a.id::text, s.valid_until,
		  EXISTS(SELECT 1 FROM web_pro_orders o WHERE o.account_id=a.id AND o.status IN ('creating','pending'))
		FROM accounts a LEFT JOIN web_pro_subscriptions s ON s.account_id=a.id
		WHERE a.id=$1::uuid AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
	`, id.String()).Scan(&out.AccountID, &out.SubscriptionExpiresAt, &out.PendingCheckout)
	if errors.Is(err, pgx.ErrNoRows) {
		return AdminSubscription{}, ErrNotFound
	}
	if err != nil {
		return AdminSubscription{}, err
	}
	if out.SubscriptionExpiresAt != nil {
		until := out.SubscriptionExpiresAt.UTC()
		out.SubscriptionExpiresAt = &until
	}
	status := statusAt(out.SubscriptionExpiresAt, false, s.now())
	out.Status, out.Plans = status.Status, status.Plans

	rows, err := tx.Query(ctx, `
		SELECT `+adminPaymentColumns+` FROM web_pro_manual_payments WHERE account_id=$1::uuid
		UNION ALL
		SELECT id::text, plan_id, amount_minor, currency, 'hesabpay', NULL, COALESCE(paid_at,updated_at), NULL
		FROM web_pro_orders WHERE account_id=$1::uuid AND status='paid'
		ORDER BY recorded_at DESC, id DESC LIMIT 20
	`, out.AccountID)
	if err != nil {
		return AdminSubscription{}, err
	}
	defer rows.Close()
	for rows.Next() {
		payment, err := scanAdminPayment(rows)
		if err != nil {
			return AdminSubscription{}, err
		}
		out.Payments = append(out.Payments, payment)
	}
	if err := rows.Err(); err != nil {
		return AdminSubscription{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AdminSubscription{}, err
	}
	return out, nil
}

func (s *Service) RecordManualPayment(ctx context.Context, accountID string, input ManualPaymentInput) (ManualPaymentResult, error) {
	plan, ok := planByID(input.PlanID)
	reference := strings.TrimSpace(input.Reference)
	id, err := uuid.Parse(accountID)
	if err != nil || !ok || !manualReference.MatchString(reference) {
		return ManualPaymentResult{}, ErrInvalid
	}
	switch input.Method {
	case "cash", "bank_transfer", "other":
	default:
		return ManualPaymentResult{}, ErrInvalid
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ManualPaymentResult{}, err
	}
	defer tx.Rollback(ctx)
	// Block account deletion/status changes, while allowing checkout's foreign
	// key reads to take their compatible key-share locks in either order.
	err = tx.QueryRow(ctx, `
		SELECT id::text FROM accounts
		WHERE id=$1::uuid AND disabled_at IS NULL AND pending_delete_at IS NULL
		FOR NO KEY UPDATE
	`, id.String()).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ManualPaymentResult{}, ErrNotFound
	}
	if err != nil {
		return ManualPaymentResult{}, err
	}
	until, err := lockSubscription(ctx, tx, accountID)
	if err != nil {
		return ManualPaymentResult{}, err
	}
	now := s.now().UTC().Truncate(time.Microsecond)
	next := renewalExpiry(now, until, plan.DurationMonths)
	payment, err := scanAdminPayment(tx.QueryRow(ctx, `
		INSERT INTO web_pro_manual_payments(id,account_id,plan_id,amount_minor,currency,duration_months,
		  method,reference,recorded_at,previous_subscription_expires_at,subscription_expires_at)
		VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT (LOWER(reference)) DO NOTHING RETURNING `+adminPaymentColumns,
		uuid.NewString(), accountID, plan.ID, plan.AmountMinor, plan.Currency, plan.DurationMonths, input.Method, reference, now, until, next))
	duplicate := errors.Is(err, pgx.ErrNoRows)
	if duplicate {
		payment, err = scanAdminPayment(tx.QueryRow(ctx, `SELECT `+adminPaymentColumns+`
			FROM web_pro_manual_payments
			WHERE LOWER(reference)=$1 AND account_id=$2::uuid AND plan_id=$3 AND method=$4
		`, strings.ToLower(reference), accountID, plan.ID, input.Method))
		if errors.Is(err, pgx.ErrNoRows) {
			return ManualPaymentResult{}, ErrConflict
		}
		if err != nil {
			return ManualPaymentResult{}, err
		}
		if until == nil {
			return ManualPaymentResult{}, errors.New("recorded manual payment has no subscription expiry")
		}
		next = until.UTC()
	} else {
		if err != nil {
			return ManualPaymentResult{}, err
		}
		_, err = tx.Exec(ctx, `UPDATE web_pro_subscriptions SET valid_until=$2,updated_at=NOW() WHERE account_id=$1::uuid`, accountID, next)
		if err != nil {
			return ManualPaymentResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ManualPaymentResult{}, err
	}
	return ManualPaymentResult{Payment: payment, SubscriptionExpiresAt: next, Duplicate: duplicate}, nil
}
