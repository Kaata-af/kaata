package webpro

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestManualPaymentLifecycle(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	accountID := seedAccount(t, pool)
	now := time.Date(2027, time.January, 31, 10, 30, 0, 0, time.UTC)
	svc := NewService(pool, testConfig())
	svc.now = func() time.Time { return now }
	svc.gateway = &fakeGateway{now: now}

	initial, err := svc.AdminSubscription(ctx, accountID)
	if err != nil || initial.AccountID != accountID || initial.Status != "trial" || initial.SubscriptionExpiresAt != nil ||
		initial.PendingCheckout || initial.Payments == nil || len(initial.Payments) != 0 || len(initial.Plans) != 2 {
		t.Fatalf("initial subscription = %+v, %v", initial, err)
	}
	order, err := svc.Checkout(ctx, accountID, "web_pro_yearly", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE web_pro_orders SET checkout_expires_at=$2 WHERE id=$1::uuid`, order.ID, now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}

	input := ManualPaymentInput{PlanID: "web_pro_monthly", Method: "cash", Reference: "  Cash/INV-31  "}
	recorded, err := svc.RecordManualPayment(ctx, accountID, input)
	firstExpiry := time.Date(2027, time.February, 28, 10, 30, 0, 0, time.UTC)
	if err != nil || recorded.Duplicate || !recorded.SubscriptionExpiresAt.Equal(firstExpiry) ||
		recorded.Payment.SubscriptionExpiresAt == nil || !recorded.Payment.SubscriptionExpiresAt.Equal(firstExpiry) ||
		recorded.Payment.Reference == nil || *recorded.Payment.Reference != "Cash/INV-31" ||
		recorded.Payment.AmountMinor != 20000 || recorded.Payment.Currency != "AFN" || recorded.Payment.Method != "cash" {
		t.Fatalf("recorded payment = %+v, %v", recorded, err)
	}
	if owns, err := svc.ownsWebhookOrder(ctx, recorded.Payment.PaymentID); err != nil || owns {
		t.Fatalf("manual payment classified as a provider order: %v, %v", owns, err)
	}
	active, err := svc.AdminSubscription(ctx, accountID)
	if err != nil || active.Status != "active" || !active.PendingCheckout || len(active.Payments) != 1 {
		t.Fatalf("active account lost its pending checkout or receipt: %+v, %v", active, err)
	}
	userStatus, err := svc.Status(ctx, accountID)
	if err != nil || userStatus.Status != "active" || userStatus.Access != "trial_open" || userStatus.PendingOrderID == nil || *userStatus.PendingOrderID != order.ID {
		t.Fatalf("manual payment changed trial access or provider checkout: %+v, %v", userStatus, err)
	}
	if err := svc.fulfill(ctx, paymentFor(order, now, "synthetic-verified-renewal")); err != nil {
		t.Fatal(err)
	}
	currentExpiry := time.Date(2028, time.February, 28, 10, 30, 0, 0, time.UTC)
	input.Reference = "cash/inv-31"
	replayed, err := svc.RecordManualPayment(ctx, accountID, input)
	if err != nil || !replayed.Duplicate || replayed.Payment.PaymentID != recorded.Payment.PaymentID ||
		!replayed.SubscriptionExpiresAt.Equal(currentExpiry) || replayed.Payment.SubscriptionExpiresAt == nil ||
		!replayed.Payment.SubscriptionExpiresAt.Equal(firstExpiry) {
		t.Fatalf("receipt replay after a renewal = %+v, %v", replayed, err)
	}
	for _, mismatch := range []ManualPaymentInput{
		{PlanID: "web_pro_yearly", Method: "cash", Reference: "CASH/INV-31"},
		{PlanID: "web_pro_monthly", Method: "bank_transfer", Reference: "CASH/INV-31"},
	} {
		if _, err := svc.RecordManualPayment(ctx, accountID, mismatch); !errors.Is(err, ErrConflict) {
			t.Fatalf("mismatched receipt = %v", err)
		}
	}
	final, err := svc.AdminSubscription(ctx, accountID)
	if err != nil || final.PendingCheckout || len(final.Payments) != 2 ||
		final.SubscriptionExpiresAt == nil || !final.SubscriptionExpiresAt.Equal(currentExpiry) {
		t.Fatalf("combined billing history = %+v, %v", final, err)
	}
	for _, payment := range final.Payments {
		if payment.Method == "hesabpay" && (payment.Reference != nil || payment.SubscriptionExpiresAt != nil || payment.PaymentID != order.ID || payment.AmountMinor != 200000) {
			t.Fatalf("unexpected provider history fields: %+v", payment)
		}
	}

	for _, condition := range []string{"disabled_at=NOW(),pending_delete_at=NULL", "pending_delete_at=NOW(),disabled_at=NULL"} {
		if _, err := pool.Exec(ctx, `UPDATE accounts SET `+condition+` WHERE id=$1::uuid`, accountID); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.AdminSubscription(ctx, accountID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("inactive account billing lookup = %v", err)
		}
		if _, err := svc.RecordManualPayment(ctx, accountID, ManualPaymentInput{PlanID: input.PlanID, Method: "cash", Reference: "new-cash"}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("inactive account receipt accepted: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM accounts WHERE id=$1::uuid`, accountID); err != nil {
		t.Fatalf("manual receipt blocked deletion: %v", err)
	}
	var receipts int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM web_pro_manual_payments WHERE account_id=$1::uuid`, accountID).Scan(&receipts); err != nil || receipts != 0 {
		t.Fatalf("deleted account receipts = %d, %v", receipts, err)
	}
}

func TestManualPaymentValidatesInput(t *testing.T) {
	svc := &Service{}
	for _, input := range []ManualPaymentInput{
		{PlanID: "invented", Method: "cash", Reference: "valid"},
		{PlanID: "web_pro_monthly", Method: "hesabpay", Reference: "valid"},
		{PlanID: "web_pro_monthly", Method: "cash", Reference: " "},
		{PlanID: "web_pro_monthly", Method: "cash", Reference: "12"},
		{PlanID: "web_pro_monthly", Method: "cash", Reference: "bad space"},
		{PlanID: "web_pro_monthly", Method: "cash", Reference: "İNV-41"},
		{PlanID: "web_pro_monthly", Method: "cash", Reference: strings.Repeat("a", 65)},
	} {
		if _, err := svc.RecordManualPayment(t.Context(), uuid.NewString(), input); !errors.Is(err, ErrInvalid) {
			t.Errorf("invalid input %+v returned %v", input, err)
		}
	}
	if _, err := svc.RecordManualPayment(t.Context(), "email@example.test", ManualPaymentInput{PlanID: "web_pro_monthly", Method: "cash", Reference: "valid"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("invalid account returned %v", err)
	}
}

func TestManualPaymentConcurrentRenewal(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	accountID, other := seedAccount(t, pool), seedAccount(t, pool)
	now := time.Date(2027, time.January, 15, 10, 0, 0, 0, time.UTC)
	svc := NewService(pool, testConfig())
	svc.now = func() time.Time { return now }
	svc.gateway = &fakeGateway{now: now}
	order, err := svc.Checkout(ctx, accountID, "web_pro_monthly", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	online := paymentFor(order, now, "concurrent-verified-payment")

	type outcome struct {
		payment ManualPaymentResult
		err     error
	}
	start, manual, provider := make(chan struct{}), make(chan outcome, 2), make(chan error, 2)
	for _, reference := range []string{"Cash-CONCURRENT", "cash-concurrent"} {
		go func() {
			<-start
			payment, err := svc.RecordManualPayment(ctx, accountID, ManualPaymentInput{
				PlanID: "web_pro_monthly", Method: "cash", Reference: reference,
			})
			manual <- outcome{payment, err}
		}()
		go func() {
			<-start
			provider <- svc.fulfill(ctx, online)
		}()
	}
	close(start)
	first, second := <-manual, <-manual
	if first.err != nil || second.err != nil || first.payment.Duplicate == second.payment.Duplicate ||
		first.payment.Payment.PaymentID != second.payment.Payment.PaymentID {
		t.Fatalf("concurrent same-account receipt results = %+v / %+v", first, second)
	}
	if a, b := <-provider, <-provider; a != nil || b != nil {
		t.Fatalf("concurrent provider results = %v / %v", a, b)
	}
	status, err := svc.AdminSubscription(ctx, accountID)
	if err != nil || status.SubscriptionExpiresAt == nil || !status.SubscriptionExpiresAt.Equal(now.AddDate(0, 2, 0)) || len(status.Payments) != 2 {
		t.Fatalf("two concurrent legitimate payments did not each add one month: %+v, %v", status, err)
	}

	// Use a fresh receipt so this tests cross-account insert arbitration,
	// not just the existing-receipt lookup.
	start = make(chan struct{})
	for _, id := range []string{accountID, other} {
		go func() {
			<-start
			payment, err := svc.RecordManualPayment(ctx, id, ManualPaymentInput{
				PlanID: "web_pro_yearly", Method: "bank_transfer", Reference: "bank-123",
			})
			manual <- outcome{payment, err}
		}()
	}
	close(start)
	first, second = <-manual, <-manual
	if first.err != nil {
		first, second = second, first
	}
	if first.err != nil || first.payment.Duplicate || !errors.Is(second.err, ErrConflict) {
		t.Fatalf("concurrent cross-account receipt results = %+v / %+v", first, second)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM web_pro_manual_payments`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("receipt total = %d, %v", count, err)
	}
}

func TestManualPaymentRollsBackReceiptIfSubscriptionUpdateFails(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	accountID := seedAccount(t, pool)
	svc := NewService(pool, Config{})
	input := ManualPaymentInput{PlanID: "web_pro_yearly", Method: "other", Reference: "other-001"}
	if _, err := pool.Exec(ctx, `ALTER TABLE web_pro_subscriptions ADD CONSTRAINT test_no_renewals CHECK(valid_until IS NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RecordManualPayment(ctx, accountID, input); err == nil {
		t.Fatal("write succeeded despite blocked expiry update")
	}
	var receipts, subscriptions int
	err := pool.QueryRow(ctx, `
		SELECT (SELECT COUNT(*) FROM web_pro_manual_payments WHERE account_id=$1::uuid),
			(SELECT COUNT(*) FROM web_pro_subscriptions WHERE account_id=$1::uuid)
	`, accountID).Scan(&receipts, &subscriptions)
	if err != nil || receipts != 0 || subscriptions != 0 {
		t.Fatalf("failed update left %d receipts and %d subscriptions: %v", receipts, subscriptions, err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE web_pro_subscriptions DROP CONSTRAINT test_no_renewals`); err != nil {
		t.Fatal(err)
	}
	if result, err := svc.RecordManualPayment(ctx, accountID, input); err != nil || result.Duplicate {
		t.Fatalf("failed attempt consumed the receipt: %+v, %v", result, err)
	}
}
