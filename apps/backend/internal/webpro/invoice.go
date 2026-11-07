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

const (
	billingPageSize             = 20
	providerAdminPaymentColumns = `id::text, plan_id, amount_minor, currency, 'hesabpay' AS method, NULL AS reference,
	  COALESCE(paid_at, updated_at) AS recorded_at, NULL AS subscription_expires_at`
	invoiceColumns = `id::text, number, plan_id, amount_minor, currency,
	  CASE WHEN paid_at IS NOT NULL THEN 'paid' WHEN voided_at IS NOT NULL THEN 'void' ELSE 'unpaid' END,
	  bill_to_name, bill_to_email, issued_at, to_char(due_on, 'YYYY-MM-DD'),
	  COALESCE(manual_payment_id, provider_order_id)::text,
	  CASE WHEN manual_payment_id IS NOT NULL THEN 'manual' WHEN provider_order_id IS NOT NULL THEN 'hesabpay' END,
	  paid_at, voided_at, void_reason`
)

var billingKabul = time.FixedZone("Asia/Kabul", 4*60*60+30*60)

type AdminInvoice struct {
	ID            string     `json:"invoice_id"`
	Number        string     `json:"invoice_number"`
	PlanID        string     `json:"plan_id"`
	AmountMinor   int64      `json:"amount_minor"`
	Currency      string     `json:"currency"`
	Status        string     `json:"status"`
	BillToName    string     `json:"bill_to_name"`
	BillToEmail   string     `json:"bill_to_email"`
	IssuedAt      time.Time  `json:"issued_at"`
	DueOn         *string    `json:"due_on"`
	PaymentID     *string    `json:"payment_id"`
	PaymentSource *string    `json:"payment_source"`
	PaidAt        *time.Time `json:"paid_at"`
	VoidedAt      *time.Time `json:"voided_at"`
	VoidReason    *string    `json:"void_reason"`
}

type AdminInvoicePage struct {
	Invoices   []AdminInvoice `json:"invoices"`
	NextOffset *int           `json:"next_offset"`
}

type AdminBillingPaymentPage struct {
	Payments   []AdminBillingPayment `json:"payments"`
	NextOffset *int                  `json:"next_offset"`
}

type AdminBillingPayment struct {
	AdminPayment
	LinkedInvoiceNumber *string `json:"linked_invoice_number,omitempty"`
}

type AdminReceipt struct {
	ID          string       `json:"receipt_id"`
	Number      string       `json:"receipt_number"`
	BillToName  string       `json:"bill_to_name"`
	BillToEmail string       `json:"bill_to_email"`
	IssuedAt    time.Time    `json:"issued_at"`
	Payment     AdminPayment `json:"payment"`
}

type IssueInvoiceInput struct {
	RequestID string  `json:"request_id"`
	PlanID    string  `json:"plan_id"`
	DueOn     *string `json:"due_on"`
}

type BillingPaymentInput struct {
	ID     string `json:"payment_id"`
	Source string `json:"payment_source"`
}

type billingAccount struct {
	ID    string
	Name  string
	Email string
}

func scanInvoice(row pgx.Row) (AdminInvoice, error) {
	var invoice AdminInvoice
	err := row.Scan(&invoice.ID, &invoice.Number, &invoice.PlanID, &invoice.AmountMinor, &invoice.Currency, &invoice.Status,
		&invoice.BillToName, &invoice.BillToEmail, &invoice.IssuedAt, &invoice.DueOn, &invoice.PaymentID,
		&invoice.PaymentSource, &invoice.PaidAt, &invoice.VoidedAt, &invoice.VoidReason)
	return invoice, err
}

// beginBilling keeps each document operation scoped to a live account. Writes
// serialize on the account row, the same first lock used by offline payments.
func (s *Service) beginBilling(ctx context.Context, accountID string, write bool) (pgx.Tx, billingAccount, error) {
	id, err := uuid.Parse(accountID)
	if err != nil || id == uuid.Nil {
		return nil, billingAccount{}, ErrInvalid
	}
	query := `SELECT id::text, COALESCE(NULLIF(BTRIM(display_name),''), NULLIF(BTRIM(name),''), ''), email
		FROM accounts WHERE id=$1::uuid AND disabled_at IS NULL AND pending_delete_at IS NULL`
	var opts pgx.TxOptions
	if write {
		query += ` FOR NO KEY UPDATE`
	} else {
		opts = pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}
	}
	tx, err := s.pool.BeginTx(ctx, opts)
	if err != nil {
		return nil, billingAccount{}, err
	}
	var account billingAccount
	if err := tx.QueryRow(ctx, query, id.String()).Scan(&account.ID, &account.Name, &account.Email); err != nil {
		_ = tx.Rollback(ctx)
		return nil, billingAccount{}, billingMissing(err)
	}
	return tx, account, nil
}

func billingMissing(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func (s *Service) ListInvoices(ctx context.Context, accountID string, offset int) (AdminInvoicePage, error) {
	if offset < 0 {
		return AdminInvoicePage{}, ErrInvalid
	}
	tx, account, err := s.beginBilling(ctx, accountID, false)
	if err != nil {
		return AdminInvoicePage{}, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT `+invoiceColumns+` FROM web_pro_invoices i WHERE i.account_id=$1::uuid
		ORDER BY i.issued_at DESC, i.id DESC LIMIT $2 OFFSET $3`, account.ID, billingPageSize+1, offset)
	if err != nil {
		return AdminInvoicePage{}, err
	}
	invoices, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (AdminInvoice, error) { return scanInvoice(row) })
	if err != nil {
		return AdminInvoicePage{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AdminInvoicePage{}, err
	}
	invoices, next := trimBillingPage(invoices, offset)
	return AdminInvoicePage{Invoices: invoices, NextOffset: next}, nil
}

func (s *Service) ListBillingPayments(ctx context.Context, accountID string, offset int) (AdminBillingPaymentPage, error) {
	if offset < 0 {
		return AdminBillingPaymentPage{}, ErrInvalid
	}
	tx, account, err := s.beginBilling(ctx, accountID, false)
	if err != nil {
		return AdminBillingPaymentPage{}, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `WITH payments AS (
			SELECT `+adminPaymentColumns+` FROM web_pro_manual_payments WHERE account_id=$1::uuid
			UNION ALL SELECT `+providerAdminPaymentColumns+` FROM web_pro_orders WHERE account_id=$1::uuid AND status='paid'
			ORDER BY recorded_at DESC, id DESC, method DESC LIMIT $2 OFFSET $3
		)
		SELECT p.*, i.number FROM payments p LEFT JOIN web_pro_invoices i ON i.account_id=$1::uuid AND (
			(p.method <> 'hesabpay' AND i.manual_payment_id=p.id::uuid) OR (p.method = 'hesabpay' AND i.provider_order_id=p.id::uuid)
		)
		ORDER BY p.recorded_at DESC, p.id DESC, p.method DESC`, account.ID, billingPageSize+1, offset)
	if err != nil {
		return AdminBillingPaymentPage{}, err
	}
	payments, err := pgx.CollectRows(rows, scanBillingPayment)
	if err != nil {
		return AdminBillingPaymentPage{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AdminBillingPaymentPage{}, err
	}
	payments, next := trimBillingPage(payments, offset)
	return AdminBillingPaymentPage{Payments: payments, NextOffset: next}, nil
}

func scanBillingPayment(row pgx.CollectableRow) (AdminBillingPayment, error) {
	var payment AdminBillingPayment
	err := row.Scan(&payment.PaymentID, &payment.PlanID, &payment.AmountMinor, &payment.Currency, &payment.Method,
		&payment.Reference, &payment.RecordedAt, &payment.SubscriptionExpiresAt, &payment.LinkedInvoiceNumber)
	return payment, err
}

func trimBillingPage[T any](page []T, offset int) ([]T, *int) {
	if len(page) > billingPageSize {
		next := offset + billingPageSize
		return page[:billingPageSize], &next
	}
	return page, nil
}

func (s *Service) IssueInvoice(ctx context.Context, accountID string, input IssueInvoiceInput) (AdminInvoice, error) {
	requestID, err := uuid.Parse(input.RequestID)
	plan, ok := planByID(input.PlanID)
	if err != nil || requestID == uuid.Nil || !ok {
		return AdminInvoice{}, ErrInvalid
	}
	if input.DueOn != nil {
		date, err := time.Parse(time.DateOnly, *input.DueOn)
		if err != nil || date.Year() < 1 || date.Format(time.DateOnly) != *input.DueOn {
			return AdminInvoice{}, ErrInvalid
		}
	}
	tx, account, err := s.beginBilling(ctx, accountID, true)
	if err != nil {
		return AdminInvoice{}, err
	}
	defer tx.Rollback(ctx)
	invoice, err := scanInvoice(tx.QueryRow(ctx, `SELECT `+invoiceColumns+` FROM web_pro_invoices
		WHERE account_id=$1::uuid AND request_id=$2::uuid`, account.ID, requestID.String()))
	if errors.Is(err, pgx.ErrNoRows) {
		now := s.now().UTC().Truncate(time.Microsecond)
		if input.DueOn != nil && *input.DueOn < now.In(billingKabul).Format(time.DateOnly) {
			return AdminInvoice{}, ErrInvalid
		}
		invoice, err = scanInvoice(tx.QueryRow(ctx, `INSERT INTO web_pro_invoices
			(id, account_id, request_id, plan_id, amount_minor, currency, bill_to_name, bill_to_email, issued_at, due_on)
			VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::text::date) RETURNING `+invoiceColumns,
			uuid.NewString(), account.ID, requestID.String(), plan.ID, plan.AmountMinor, plan.Currency, account.Name, account.Email, now, input.DueOn))
	} else if err == nil && (invoice.PlanID != plan.ID || !sameDueDate(invoice.DueOn, input.DueOn)) {
		return AdminInvoice{}, ErrConflict
	}
	if err != nil {
		return AdminInvoice{}, err
	}
	return invoice, tx.Commit(ctx)
}

func sameDueDate(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

type billingPaymentRef struct {
	manual   *string
	provider *string
}

func parseBillingPayment(input BillingPaymentInput) (billingPaymentRef, error) {
	id, err := uuid.Parse(input.ID)
	if err != nil || id == uuid.Nil {
		return billingPaymentRef{}, ErrInvalid
	}
	key := id.String()
	switch input.Source {
	case "manual":
		return billingPaymentRef{manual: &key}, nil
	case "hesabpay":
		return billingPaymentRef{provider: &key}, nil
	default:
		return billingPaymentRef{}, ErrInvalid
	}
}

func (ref billingPaymentRef) confirmed(ctx context.Context, tx pgx.Tx, accountID string) (AdminPayment, error) {
	var row pgx.Row
	if ref.manual != nil {
		row = tx.QueryRow(ctx, `SELECT `+adminPaymentColumns+` FROM web_pro_manual_payments WHERE account_id=$1::uuid AND id=$2::uuid`, accountID, *ref.manual)
	} else {
		row = tx.QueryRow(ctx, `SELECT `+providerAdminPaymentColumns+` FROM web_pro_orders WHERE account_id=$1::uuid AND id=$2::uuid AND status='paid'`, accountID, *ref.provider)
	}
	payment, err := scanAdminPayment(row)
	return payment, billingMissing(err)
}

func (s *Service) ApplyInvoicePayment(ctx context.Context, accountID, invoiceID string, input BillingPaymentInput) (AdminInvoice, error) {
	id, err := uuid.Parse(invoiceID)
	if err != nil || id == uuid.Nil {
		return AdminInvoice{}, ErrInvalid
	}
	ref, err := parseBillingPayment(input)
	if err != nil {
		return AdminInvoice{}, err
	}
	tx, account, err := s.beginBilling(ctx, accountID, true)
	if err != nil {
		return AdminInvoice{}, err
	}
	defer tx.Rollback(ctx)
	invoice, err := scanInvoice(tx.QueryRow(ctx, `SELECT `+invoiceColumns+` FROM web_pro_invoices WHERE account_id=$1::uuid AND id=$2::uuid`, account.ID, id.String()))
	if err != nil {
		return AdminInvoice{}, billingMissing(err)
	}
	if invoice.Status == "void" {
		return AdminInvoice{}, ErrConflict
	}
	payment, err := ref.confirmed(ctx, tx, account.ID)
	if err != nil {
		return AdminInvoice{}, err
	}
	if invoice.Status == "paid" {
		if *invoice.PaymentID != payment.PaymentID || *invoice.PaymentSource != input.Source {
			return AdminInvoice{}, ErrConflict
		}
		return invoice, tx.Commit(ctx)
	}
	if invoice.PlanID != payment.PlanID || invoice.AmountMinor != payment.AmountMinor || invoice.Currency != payment.Currency {
		return AdminInvoice{}, ErrConflict
	}
	invoice, err = scanInvoice(tx.QueryRow(ctx, `UPDATE web_pro_invoices
		SET manual_payment_id=$3::uuid, provider_order_id=$4::uuid, paid_at=$5 WHERE account_id=$1::uuid AND id=$2::uuid
		RETURNING `+invoiceColumns, account.ID, id.String(), ref.manual, ref.provider, payment.RecordedAt))
	var constraint *pgconn.PgError
	if errors.As(err, &constraint) && constraint.Code == "23505" {
		return AdminInvoice{}, ErrConflict
	}
	if err != nil {
		return AdminInvoice{}, err
	}
	return invoice, tx.Commit(ctx)
}

func (s *Service) VoidInvoice(ctx context.Context, accountID, invoiceID, reason string) (AdminInvoice, error) {
	id, err := uuid.Parse(invoiceID)
	reason = strings.TrimSpace(reason)
	if err != nil || id == uuid.Nil || reason == "" || utf8.RuneCountInString(reason) > 240 || strings.ContainsFunc(reason, unicode.IsControl) {
		return AdminInvoice{}, ErrInvalid
	}
	tx, account, err := s.beginBilling(ctx, accountID, true)
	if err != nil {
		return AdminInvoice{}, err
	}
	defer tx.Rollback(ctx)
	invoice, err := scanInvoice(tx.QueryRow(ctx, `SELECT `+invoiceColumns+` FROM web_pro_invoices WHERE account_id=$1::uuid AND id=$2::uuid`, account.ID, id.String()))
	if err != nil {
		return AdminInvoice{}, billingMissing(err)
	}
	if invoice.Status == "void" && *invoice.VoidReason == reason {
		return invoice, tx.Commit(ctx)
	}
	if invoice.Status != "unpaid" {
		return AdminInvoice{}, ErrConflict
	}
	invoice, err = scanInvoice(tx.QueryRow(ctx, `UPDATE web_pro_invoices SET voided_at=$3, void_reason=$4
		WHERE account_id=$1::uuid AND id=$2::uuid RETURNING `+invoiceColumns, account.ID, id.String(), s.now().UTC(), reason))
	if err != nil {
		return AdminInvoice{}, err
	}
	return invoice, tx.Commit(ctx)
}

func (s *Service) IssueReceipt(ctx context.Context, accountID string, input BillingPaymentInput) (AdminReceipt, error) {
	ref, err := parseBillingPayment(input)
	if err != nil {
		return AdminReceipt{}, err
	}
	tx, account, err := s.beginBilling(ctx, accountID, true)
	if err != nil {
		return AdminReceipt{}, err
	}
	defer tx.Rollback(ctx)
	payment, err := ref.confirmed(ctx, tx, account.ID)
	if err != nil {
		return AdminReceipt{}, err
	}
	receipt := AdminReceipt{Payment: payment}
	const columns = `id::text, number, bill_to_name, bill_to_email, issued_at`
	fields := []any{&receipt.ID, &receipt.Number, &receipt.BillToName, &receipt.BillToEmail, &receipt.IssuedAt}
	err = tx.QueryRow(ctx, `SELECT `+columns+` FROM web_pro_receipts
		WHERE account_id=$1::uuid AND (manual_payment_id=$2::uuid OR provider_order_id=$3::uuid)`, account.ID, ref.manual, ref.provider).Scan(fields...)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `INSERT INTO web_pro_receipts (id, account_id, bill_to_name, bill_to_email, issued_at, manual_payment_id, provider_order_id)
			VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid) RETURNING `+columns,
			uuid.NewString(), account.ID, account.Name, account.Email, s.now().UTC(), ref.manual, ref.provider).Scan(fields...)
	}
	if err != nil {
		return AdminReceipt{}, err
	}
	return receipt, tx.Commit(ctx)
}
