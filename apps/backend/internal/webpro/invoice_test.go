package webpro

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

func billingNumberMatchesID(number, prefix, id string) bool {
	compact := strings.ToUpper(strings.ReplaceAll(id, "-", ""))
	return len(compact) == 32 && number == prefix+compact[:12]+compact[24:]
}

func TestInvoiceAndReceiptLifecycle(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	accountID, otherID := seedAccount(t, pool), seedAccount(t, pool)
	svc := NewService(pool, testConfig())
	now := time.Date(2027, 1, 31, 21, 0, 0, 0, time.UTC) // February 1 in Kabul.
	svc.now = func() time.Time { return now }

	empty, err := svc.ListInvoices(ctx, accountID, 0)
	if err != nil || empty.Invoices == nil || len(empty.Invoices) != 0 || empty.NextOffset != nil {
		t.Fatalf("initial invoices = %+v, %v", empty, err)
	}
	tooEarly := "2027-01-31"
	if _, err := svc.IssueInvoice(ctx, accountID, IssueInvoiceInput{uuid.NewString(), "web_pro_monthly", &tooEarly}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("accepted due date before Kabul issue date: %v", err)
	}
	due := "2027-02-01"
	input := IssueInvoiceInput{uuid.NewString(), "web_pro_monthly", &due}
	invoice, err := svc.IssueInvoice(ctx, accountID, input)
	if err != nil || invoice.Status != "unpaid" || !billingNumberMatchesID(invoice.Number, "KPRO-I-", invoice.ID) || invoice.AmountMinor != 20000 || invoice.Currency != "AFN" ||
		invoice.DueOn == nil || *invoice.DueOn != due || invoice.PaidAt != nil || invoice.BillToName != "Synthetic Billing Account" || invoice.BillToEmail != accountID+"@example.test" {
		t.Fatalf("new invoice = %+v, %v", invoice, err)
	}
	status, err := svc.Status(ctx, accountID)
	if err != nil || status.Status != "trial" || status.SubscriptionExpiresAt != nil {
		t.Fatalf("issuing invoice activated Pro: %+v, %v", status, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET display_name='New account name' WHERE id=$1::uuid`, accountID); err != nil {
		t.Fatal(err)
	}
	now = now.AddDate(0, 0, 1)
	replayed, err := svc.IssueInvoice(ctx, accountID, input)
	if err != nil || !reflect.DeepEqual(invoice, replayed) {
		t.Fatalf("invoice retry changed after due date and profile change: %+v, %v", replayed, err)
	}
	if _, err := svc.IssueInvoice(ctx, accountID, IssueInvoiceInput{input.RequestID, "web_pro_yearly", &due}); !errors.Is(err, ErrConflict) {
		t.Fatalf("request ID reused with different plan: %v", err)
	}

	offline, err := svc.RecordManualPayment(ctx, accountID, ManualPaymentInput{"web_pro_monthly", "cash", "Invoice/CASH-123"})
	if err != nil {
		t.Fatal(err)
	}
	cash := BillingPaymentInput{offline.Payment.PaymentID, "manual"}
	if _, err := svc.IssueReceipt(ctx, otherID, cash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("generated another account's receipt: %v", err)
	}
	if _, err := svc.ApplyInvoicePayment(ctx, otherID, invoice.ID, cash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("modified another account's invoice: %v", err)
	}
	otherInvoice, err := svc.IssueInvoice(ctx, otherID, IssueInvoiceInput{uuid.NewString(), "web_pro_monthly", nil})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ApplyInvoicePayment(ctx, otherID, otherInvoice.ID, cash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("applied another account's payment: %v", err)
	}
	yearlyInvoice, err := svc.IssueInvoice(ctx, accountID, IssueInvoiceInput{uuid.NewString(), "web_pro_yearly", nil})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ApplyInvoicePayment(ctx, accountID, yearlyInvoice.ID, cash); !errors.Is(err, ErrConflict) {
		t.Fatalf("applied wrong plan/amount: %v", err)
	}
	paid, err := svc.ApplyInvoicePayment(ctx, accountID, invoice.ID, cash)
	if err != nil || paid.Status != "paid" || paid.PaymentID == nil || *paid.PaymentID != cash.ID || paid.PaymentSource == nil || *paid.PaymentSource != "manual" ||
		paid.PaidAt == nil || !paid.PaidAt.Equal(offline.Payment.RecordedAt) {
		t.Fatalf("applied cash payment = %+v, %v", paid, err)
	}
	if replay, err := svc.ApplyInvoicePayment(ctx, accountID, invoice.ID, cash); err != nil || !reflect.DeepEqual(replay, paid) {
		t.Fatalf("apply retry changed invoice: %+v, %v", replay, err)
	}
	if _, err := svc.VoidInvoice(ctx, accountID, paid.ID, "Replaced"); !errors.Is(err, ErrConflict) {
		t.Fatalf("voided a paid invoice: %v", err)
	}
	paidStatus, err := svc.Status(ctx, accountID)
	if err != nil || paidStatus.SubscriptionExpiresAt == nil || !paidStatus.SubscriptionExpiresAt.Equal(offline.SubscriptionExpiresAt) {
		t.Fatalf("invoice linking changed paid entitlement: %+v, %v", paidStatus, err)
	}

	svc.gateway = &fakeGateway{now: now}
	order, err := svc.Checkout(ctx, accountID, "web_pro_yearly", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	provider := BillingPaymentInput{order.ID, "hesabpay"}
	if _, err := svc.IssueReceipt(ctx, accountID, provider); !errors.Is(err, ErrNotFound) {
		t.Fatalf("generated receipt for unconfirmed checkout: %v", err)
	}
	if _, err := svc.ApplyInvoicePayment(ctx, accountID, yearlyInvoice.ID, provider); !errors.Is(err, ErrNotFound) {
		t.Fatalf("applied unconfirmed checkout: %v", err)
	}
	if err := svc.fulfill(ctx, paymentFor(order, now, "synthetic-invoice-renewal")); err != nil {
		t.Fatal(err)
	}
	providerPaid, err := svc.ApplyInvoicePayment(ctx, accountID, yearlyInvoice.ID, provider)
	if err != nil || providerPaid.Status != "paid" || providerPaid.PaymentSource == nil || *providerPaid.PaymentSource != "hesabpay" {
		t.Fatalf("applied HesabPay payment = %+v, %v", providerPaid, err)
	}
	providerReceipt, err := svc.IssueReceipt(ctx, accountID, provider)
	if err != nil || !billingNumberMatchesID(providerReceipt.Number, "KPRO-R-", providerReceipt.ID) || providerReceipt.Payment.Method != "hesabpay" || providerReceipt.Payment.Reference != nil {
		t.Fatalf("HesabPay receipt = %+v, %v", providerReceipt, err)
	}
	cashReceipt, err := svc.IssueReceipt(ctx, accountID, cash)
	if err != nil || !billingNumberMatchesID(cashReceipt.Number, "KPRO-R-", cashReceipt.ID) || cashReceipt.Number == providerReceipt.Number || cashReceipt.BillToName != "New account name" || cashReceipt.Payment.PaymentID != cash.ID {
		t.Fatalf("offline receipt = %+v, %v", cashReceipt, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET display_name='Renamed again' WHERE id=$1::uuid`, accountID); err != nil {
		t.Fatal(err)
	}
	if replay, err := svc.IssueReceipt(ctx, accountID, cash); err != nil || !reflect.DeepEqual(replay, cashReceipt) {
		t.Fatalf("receipt retry changed original document: %+v, %v", replay, err)
	}
	payments, err := svc.ListBillingPayments(ctx, accountID, 0)
	if err != nil || len(payments.Payments) != 2 || payments.NextOffset != nil {
		t.Fatalf("linked payment history = %+v, %v", payments, err)
	}
	for _, payment := range payments.Payments {
		wantNumber := paid.Number
		if payment.Method == "hesabpay" {
			wantNumber = providerPaid.Number
		}
		if payment.LinkedInvoiceNumber == nil || *payment.LinkedInvoiceNumber != wantNumber {
			t.Fatalf("confirmed payment missing matching invoice: %+v", payment)
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM accounts WHERE id=$1::uuid`, accountID); err != nil {
		t.Fatalf("document references blocked account deletion: %v", err)
	}
	if _, err := svc.ListInvoices(ctx, accountID, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted account invoice listing returned: %v", err)
	}
}

func TestOnePaymentCanSettleOneInvoiceUnderConcurrentRequests(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	accountID := seedAccount(t, pool)
	svc := NewService(pool, Config{})
	payment, err := svc.RecordManualPayment(ctx, accountID, ManualPaymentInput{"web_pro_monthly", "bank_transfer", "Transfer-123"})
	if err != nil {
		t.Fatal(err)
	}
	invoices := make([]AdminInvoice, 2)
	for i := range invoices {
		invoices[i], err = svc.IssueInvoice(ctx, accountID, IssueInvoiceInput{uuid.NewString(), "web_pro_monthly", nil})
		if err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	ref := BillingPaymentInput{payment.Payment.PaymentID, "manual"}
	for _, invoice := range invoices {
		go func() {
			<-start
			_, err := svc.ApplyInvoicePayment(ctx, accountID, invoice.ID, ref)
			results <- err
		}()
	}
	close(start)
	first, second := <-results, <-results
	if !(first == nil && errors.Is(second, ErrConflict) || second == nil && errors.Is(first, ErrConflict)) {
		t.Fatalf("concurrent invoice applications = %v, %v", first, second)
	}
	page, err := svc.ListInvoices(ctx, accountID, 0)
	if err != nil || len(page.Invoices) != 2 {
		t.Fatalf("invoices = %+v, %v", page, err)
	}
	for _, invoice := range page.Invoices {
		if invoice.Status != "unpaid" {
			continue
		}
		voided, err := svc.VoidInvoice(ctx, accountID, invoice.ID, "  Duplicate invoice  ")
		if err != nil || voided.Status != "void" || voided.VoidedAt == nil || voided.VoidReason == nil || *voided.VoidReason != "Duplicate invoice" {
			t.Fatalf("void invoice = %+v, %v", voided, err)
		}
		if replay, err := svc.VoidInvoice(ctx, accountID, invoice.ID, "Duplicate invoice"); err != nil || !reflect.DeepEqual(replay, voided) {
			t.Fatalf("void retry changed document: %+v, %v", replay, err)
		}
		if _, err := svc.ApplyInvoicePayment(ctx, accountID, invoice.ID, ref); !errors.Is(err, ErrConflict) {
			t.Fatalf("applied payment to void invoice: %v", err)
		}
	}
}

func TestBillingHistoryPaginatesOlderDocumentsAndPayments(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	accountID := seedAccount(t, pool)
	svc := NewService(pool, Config{})
	now := time.Date(2027, 2, 1, 9, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	var firstInvoice, firstPayment string
	issued := make([]AdminInvoice, 0, billingPageSize+1)
	numbers := make(map[string]bool)
	for i := range billingPageSize + 1 {
		now = now.Add(time.Minute)
		invoice, err := svc.IssueInvoice(ctx, accountID, IssueInvoiceInput{uuid.NewString(), "web_pro_monthly", nil})
		if err != nil {
			t.Fatal(err)
		}
		if numbers[invoice.Number] || !billingNumberMatchesID(invoice.Number, "KPRO-I-", invoice.ID) {
			t.Fatalf("invalid or duplicate public invoice number %q", invoice.Number)
		}
		numbers[invoice.Number] = true
		issued = append(issued, invoice)
		payment, err := svc.RecordManualPayment(ctx, accountID, ManualPaymentInput{"web_pro_monthly", "cash", fmt.Sprintf("CASH-%02d", i)})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			firstInvoice, firstPayment = invoice.ID, payment.Payment.PaymentID
		}
	}
	invoices, err := svc.ListInvoices(ctx, accountID, 0)
	if err != nil || len(invoices.Invoices) != billingPageSize || invoices.NextOffset == nil {
		t.Fatalf("first invoices page = %+v, %v", invoices, err)
	}
	for i, invoice := range invoices.Invoices {
		if want := issued[len(issued)-i-1].ID; invoice.ID != want {
			t.Fatalf("invoice at position %d is %s, want %s by issue date", i, invoice.ID, want)
		}
	}
	lastInvoices, err := svc.ListInvoices(ctx, accountID, *invoices.NextOffset)
	if err != nil || len(lastInvoices.Invoices) != 1 || lastInvoices.Invoices[0].ID != firstInvoice || lastInvoices.NextOffset != nil {
		t.Fatalf("last invoices page = %+v, %v", lastInvoices, err)
	}
	payments, err := svc.ListBillingPayments(ctx, accountID, 0)
	if err != nil || len(payments.Payments) != billingPageSize || payments.NextOffset == nil {
		t.Fatalf("first payments page = %+v, %v", payments, err)
	}
	lastPayments, err := svc.ListBillingPayments(ctx, accountID, *payments.NextOffset)
	if err != nil || len(lastPayments.Payments) != 1 || lastPayments.Payments[0].PaymentID != firstPayment || lastPayments.NextOffset != nil {
		t.Fatalf("last payments page = %+v, %v", lastPayments, err)
	}
}
