package webpro

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool    *pgxpool.Pool
	cfg     Config
	gateway gateway
	now     func() time.Time
}

func NewService(pool *pgxpool.Pool, cfg Config) *Service {
	cfg = normalizeConfig(cfg)
	return &Service{pool: pool, cfg: cfg, gateway: newHesabPay(cfg), now: func() time.Time { return time.Now().UTC() }}
}

func (s *Service) Status(ctx context.Context, accountID string) (Status, error) {
	var until *time.Time
	err := s.pool.QueryRow(ctx, `SELECT valid_until FROM web_pro_subscriptions WHERE account_id=$1::uuid`, accountID).Scan(&until)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Status{}, err
	}
	if until != nil {
		normalized := until.UTC()
		until = &normalized
	}
	status := statusAt(until, checkoutReady(s.cfg), s.now())
	status.CheckoutHosts = append([]string{}, s.cfg.CheckoutHosts...)
	pending, err := s.pendingOrder(ctx, s.pool, accountID)
	if err == nil {
		status.PendingOrderID = &pending.ID
	} else if !errors.Is(err, ErrNotFound) {
		return Status{}, err
	}
	return status, nil
}

const orderColumns = `id::text,account_id::text,request_id::text,plan_id,status,amount_minor,currency,duration_months,item_name,return_origin,provider_session_id,checkout_url,checkout_expires_at,created_at`

func scanOrder(row pgx.Row) (Order, error) {
	var out Order
	err := row.Scan(&out.ID, &out.accountID, &out.requestID, &out.PlanID, &out.Status, &out.AmountMinor, &out.Currency, &out.durationMonths, &out.itemName, &out.returnOrigin, &out.sessionID, &out.CheckoutURL, &out.ExpiresAt, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, ErrNotFound
	}
	out.CreatedAt = out.CreatedAt.UTC()
	if out.ExpiresAt != nil {
		normalized := out.ExpiresAt.UTC()
		out.ExpiresAt = &normalized
	}
	return out, err
}

func (s *Service) GetOrder(ctx context.Context, accountID, id string) (Order, error) {
	if _, err := uuid.Parse(id); err != nil {
		return Order{}, ErrNotFound
	}
	order, err := scanOrder(s.pool.QueryRow(ctx, `SELECT `+orderColumns+` FROM web_pro_orders WHERE id=$1::uuid AND account_id=$2::uuid`, id, accountID))
	if err != nil {
		return Order{}, err
	}
	if !livePending(order, s.now()) {
		// A checkout link can expire while an already-submitted payment is
		// still settling. Do not turn link expiry into a failed payment.
		order.CheckoutURL = nil
	}
	if order.CheckoutURL != nil && !validCheckoutURL(*order.CheckoutURL, s.cfg.CheckoutHosts) {
		order.CheckoutURL = nil
	}
	order.CanStartNewCheckout = !livePending(order, s.now())
	return order, nil
}

type CheckoutOptions struct{ Origin, ReplaceOrderID string }

func livePending(order Order, now time.Time) bool {
	if order.Status != "creating" && order.Status != "pending" {
		return false
	}
	if order.ExpiresAt != nil {
		return order.ExpiresAt.After(now)
	}
	return order.CreatedAt.Add(15 * time.Minute).After(now)
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *Service) pendingOrder(ctx context.Context, q rowQuerier, accountID string) (Order, error) {
	return scanOrder(q.QueryRow(ctx, `SELECT `+orderColumns+` FROM web_pro_orders WHERE account_id=$1::uuid AND status IN ('creating','pending') ORDER BY (COALESCE(checkout_expires_at,created_at+INTERVAL '15 minutes')>$2) DESC,created_at DESC,id DESC LIMIT 1`, accountID, s.now()))
}

func (s *Service) reserveCheckout(ctx context.Context, accountID, requestID, origin, replaces string, plan Plan) (Order, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO web_pro_subscriptions(account_id)VALUES($1::uuid) ON CONFLICT DO NOTHING`, accountID); err != nil {
		return Order{}, false, err
	}
	var locked string
	if err = tx.QueryRow(ctx, `SELECT account_id::text FROM web_pro_subscriptions WHERE account_id=$1::uuid FOR UPDATE`, accountID).Scan(&locked); err != nil {
		return Order{}, false, err
	}
	existing, err := scanOrder(tx.QueryRow(ctx, `SELECT `+orderColumns+` FROM web_pro_orders WHERE account_id=$1::uuid AND request_id=$2::uuid`, accountID, requestID))
	if err == nil {
		return existing, false, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Order{}, false, err
	}
	pending, err := s.pendingOrder(ctx, tx, accountID)
	if err == nil {
		if livePending(pending, s.now()) || replaces != pending.ID {
			return pending, false, ErrPending
		}
	} else if !errors.Is(err, ErrNotFound) {
		return Order{}, false, err
	} else if replaces != "" {
		return Order{}, false, ErrConflict
	}
	id := uuid.NewString()
	_, err = tx.Exec(ctx, `INSERT INTO web_pro_orders(id,account_id,request_id,plan_id,amount_minor,currency,duration_months,item_name,return_origin,status,created_at,updated_at)
	VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,'creating',$10,$10)`, id, accountID, requestID, plan.ID, plan.AmountMinor, plan.Currency, plan.DurationMonths, itemName(plan.ID), origin, s.now())
	if err != nil {
		return Order{}, false, err
	}
	order, err := scanOrder(tx.QueryRow(ctx, `SELECT `+orderColumns+` FROM web_pro_orders WHERE id=$1::uuid`, id))
	if err != nil {
		return Order{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Order{}, false, err
	}
	return order, true, nil
}

func (s *Service) Checkout(ctx context.Context, accountID, planID, requestID string, options ...CheckoutOptions) (Order, error) {
	plan, ok := planByID(planID)
	if !ok {
		return Order{}, ErrInvalid
	}
	if _, err := uuid.Parse(requestID); err != nil {
		return Order{}, ErrInvalid
	}
	if !checkoutReady(s.cfg) {
		return Order{}, ErrUnavailable
	}
	option := CheckoutOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	if option.ReplaceOrderID != "" {
		if _, err := uuid.Parse(option.ReplaceOrderID); err != nil {
			return Order{}, ErrInvalid
		}
	}
	origin := option.Origin
	origin, ok = allowedReturnOrigin(s.cfg, origin)
	if !ok {
		return Order{}, ErrInvalid
	}
	order, created, err := s.reserveCheckout(ctx, accountID, requestID, origin, option.ReplaceOrderID, plan)
	if err != nil {
		return order, err
	}
	if order.PlanID != planID || order.returnOrigin != origin {
		return order, ErrConflict
	}
	if !created {
		if order.Status == "paid" || order.Status == "failed" || (order.ExpiresAt != nil && !order.ExpiresAt.After(s.now())) {
			return order, ErrConflict
		}
		if order.CheckoutURL != nil && validCheckoutURL(*order.CheckoutURL, s.cfg.CheckoutHosts) {
			return order, nil
		}
		return order, ErrPending
	}
	returnURL := order.returnOrigin + "/app/subscription?order=" + order.ID
	session, err := s.gateway.Create(ctx, order, returnURL)
	if err != nil {
		// A provider response may be lost after creating its session. Never
		// automatically create a second session for the same request ID.
		updateCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = s.pool.Exec(updateCtx, `UPDATE web_pro_orders SET status='pending',updated_at=NOW() WHERE id=$1::uuid AND status='creating'`, order.ID)
		return order, ErrPending
	}
	// The gateway implementation validates the response. Repeat the URL guard
	// at persistence so an alternate gateway cannot turn checkout into a redirect.
	if !validCheckoutURL(session.URL, s.cfg.CheckoutHosts) || !session.ExpiresAt.After(s.now()) {
		return order, ErrPending
	}
	_, err = s.pool.Exec(ctx, `UPDATE web_pro_orders SET status=CASE WHEN status='paid' THEN status ELSE 'pending' END,provider_session_id=$2,checkout_url=$3,checkout_expires_at=$4,updated_at=NOW() WHERE id=$1::uuid`, order.ID, session.ID, session.URL, session.ExpiresAt)
	if err != nil {
		return order, ErrPending
	}
	return s.GetOrder(ctx, accountID, order.ID)
}

// fulfill takes an already authenticated, independently API-verified delivery.
// Locking the subscription serializes renewals for the same account; the paid
// marker and globally unique transaction ID make replay unable to add time.
func (s *Service) fulfill(ctx context.Context, payment webhookPayment) error {
	var accountID string
	err := s.pool.QueryRow(ctx, `SELECT account_id::text FROM web_pro_orders WHERE id=$1::uuid`, payment.UserID).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO web_pro_subscriptions(account_id) VALUES($1::uuid) ON CONFLICT DO NOTHING`, accountID)
	if err != nil {
		return err
	}
	var until *time.Time
	err = tx.QueryRow(ctx, `SELECT valid_until FROM web_pro_subscriptions WHERE account_id=$1::uuid FOR UPDATE`, accountID).Scan(&until)
	if err != nil {
		return err
	}
	order, err := scanOrder(tx.QueryRow(ctx, `SELECT `+orderColumns+` FROM web_pro_orders WHERE id=$1::uuid FOR UPDATE`, payment.UserID))
	if err != nil {
		return err
	}
	if !payment.matches(order) {
		return ErrVerification
	}
	var previousTxn *string
	err = tx.QueryRow(ctx, `SELECT provider_transaction_id FROM web_pro_orders WHERE id=$1::uuid`, order.ID).Scan(&previousTxn)
	if err != nil {
		return err
	}
	if order.Status == "paid" {
		if previousTxn == nil || *previousTxn != payment.TransactionID {
			return ErrVerification
		}
		return tx.Commit(ctx)
	}
	var transactionUsed bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM web_pro_orders WHERE provider_transaction_id=$1)`, payment.TransactionID).Scan(&transactionUsed)
	if err != nil {
		return err
	}
	if transactionUsed {
		return ErrVerification
	}
	start := s.now()
	if until != nil && until.After(start) {
		start = *until
	}
	next := addMonths(start, order.durationMonths)
	_, err = tx.Exec(ctx, `UPDATE web_pro_subscriptions SET valid_until=$2,updated_at=NOW() WHERE account_id=$1::uuid`, accountID, next)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE web_pro_orders SET status='paid',provider_transaction_id=$2,paid_at=NOW(),updated_at=NOW() WHERE id=$1::uuid`, order.ID, payment.TransactionID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
