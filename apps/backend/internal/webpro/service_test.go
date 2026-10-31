package webpro

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/testutil"
)

type fakeGateway struct {
	mu                       sync.Mutex
	createCalls, verifyCalls int
	createErr, verifyErr     error
	now                      time.Time
}

func (f *fakeGateway) Create(_ context.Context, o Order, returnURL string) (checkoutSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls++
	if f.createErr != nil {
		return checkoutSession{}, f.createErr
	}
	if returnURL != o.returnOrigin+"/app/subscription?order="+o.ID {
		return checkoutSession{}, ErrInvalid
	}
	return checkoutSession{ID: uuid.NewString(), URL: "https://developers.hesab.com/checkout/" + o.ID + "?data=synthetic", ExpiresAt: f.now.Add(15 * time.Minute)}, nil
}
func (f *fakeGateway) Verify(context.Context, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.verifyCalls++
	return f.verifyErr
}

func seedAccount(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	id := uuid.NewString()
	_, err := pool.Exec(context.Background(), `INSERT INTO accounts(id,name,email,email_normalized)VALUES($1::uuid,'Synthetic Billing Account',$2,$2)`, id, id+"@example.test")
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func paymentFor(order Order, now time.Time, txn string) webhookPayment {
	return webhookPayment{Success: true, StatusCode: 10, TransactionID: txn, UserID: order.ID, Amount: moneyNumber(order.AmountMinor), Items: []paymentItem{{ID: order.ID, Name: order.itemName, Price: moneyNumber(order.AmountMinor)}}, Signature: "synthetic-signature", Timestamp: strconv.FormatInt(now.Unix(), 10)}
}

func webhookRequest(s *Service, payment webhookPayment, token string) int {
	body, _ := json.Marshal(payment)
	router := chi.NewRouter()
	router.Post("/v1/web-pro/hesabpay/webhook/{token}", NewHandler(s).Webhook)
	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/v1/web-pro/hesabpay/webhook/"+token, bytes.NewReader(body)))
	return res.Code
}

func TestCheckoutAndVerifiedRenewalLifecycle(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	accountID, other := seedAccount(t, pool), seedAccount(t, pool)
	now := time.Date(2027, 1, 31, 15, 5, 6, 0, time.UTC)
	cfg := testConfig()
	s := NewService(pool, cfg)
	s.now = func() time.Time { return now }
	gw := &fakeGateway{now: now}
	s.gateway = gw
	var foreignCalls atomic.Int64
	legacy := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { foreignCalls.Add(1); w.WriteHeader(200) }))
	defer legacy.Close()
	s.cfg.ForeignWebhookURL = "https://example.com/api/webhooks/hesabpay"
	s.foreignClient.Transport = foreignTLSTransport(t, legacy)
	status, err := s.Status(ctx, accountID)
	if err != nil || status.Access != "trial_open" || status.Status != "trial" || !status.CheckoutReady {
		t.Fatalf("initial status=%+v,%v", status, err)
	}
	req := uuid.NewString()
	order, err := s.Checkout(ctx, accountID, "web_pro_monthly", req)
	if err != nil {
		t.Fatal(err)
	}
	// Model an existing checkout created before the Kaata Pro rename. Its
	// stored invoice name must survive retries and late payment confirmation.
	order.itemName = "Kaata Web Pro - 1 month"
	if _, err = pool.Exec(ctx, `UPDATE web_pro_orders SET item_name=$2 WHERE id=$1::uuid`, order.ID, order.itemName); err != nil {
		t.Fatal(err)
	}
	again, err := s.Checkout(ctx, accountID, "web_pro_monthly", req)
	if err != nil || order.ID != again.ID || again.itemName != order.itemName || gw.createCalls != 1 {
		t.Fatalf("retry duplicated checkout: %+v,%v,calls%d", again, err, gw.createCalls)
	}
	status, _ = s.Status(ctx, accountID)
	if status.PendingOrderID == nil || *status.PendingOrderID != order.ID {
		t.Fatal("pending order cannot be resumed after reload")
	}
	if pending, err := s.Checkout(ctx, accountID, "web_pro_yearly", uuid.NewString()); !errors.Is(err, ErrPending) || pending.ID != order.ID || gw.createCalls != 1 {
		t.Fatal("another tab created a duplicate pending checkout")
	}
	if _, err = s.Checkout(ctx, accountID, "web_pro_yearly", req); !errors.Is(err, ErrConflict) {
		t.Fatal("request id changed price")
	}
	if _, err = s.GetOrder(ctx, other, order.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("another account read order")
	}
	// Link expiry is not a payment verdict. Its already-submitted payment can
	// still complete, so hide only the expired link and retain pending status.
	if _, err = pool.Exec(ctx, `UPDATE web_pro_orders SET checkout_expires_at=$2 WHERE id=$1::uuid`, order.ID, now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	expiredLink, err := s.GetOrder(ctx, accountID, order.ID)
	if err != nil || expiredLink.Status != "pending" || expiredLink.CheckoutURL != nil || !expiredLink.CanStartNewCheckout {
		t.Fatalf("expired link was treated as a payment failure: %+v,%v", expiredLink, err)
	}
	if _, err = s.Checkout(ctx, accountID, "web_pro_free", uuid.NewString()); !errors.Is(err, ErrInvalid) {
		t.Fatal("client invented plan")
	}
	if _, err = s.Checkout(ctx, accountID, "web_pro_monthly", uuid.NewString(), CheckoutOptions{Origin: "https://evil.test"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("arbitrary payment return origin accepted")
	}
	wwwOrder, err := s.Checkout(ctx, seedAccount(t, pool), "web_pro_monthly", uuid.NewString(), CheckoutOptions{Origin: "https://www.kaata.af"})
	if err != nil || wwwOrder.returnOrigin != "https://www.kaata.af" {
		t.Fatalf("www session origin lost: %+v,%v", wwwOrder, err)
	}
	payment := paymentFor(order, now, "txn-synthetic-month")
	bad := payment
	bad.Amount = moneyNumber(1)
	if got := webhookRequest(s, bad, cfg.WebhookToken); got != 400 {
		t.Fatalf("wrong amount status%d", got)
	}
	bad = payment
	bad.Items = append([]paymentItem{}, payment.Items...)
	bad.Items[0].ID = uuid.NewString()
	if got := webhookRequest(s, bad, cfg.WebhookToken); got != 400 {
		t.Fatalf("wrong item status%d", got)
	}
	bad = payment
	bad.Items = append([]paymentItem{}, payment.Items...)
	bad.Items[0].Name = itemName(order.PlanID)
	if got := webhookRequest(s, bad, cfg.WebhookToken); got != 400 {
		t.Fatalf("current product name replaced the stored invoice name: %d", got)
	}
	bad = payment
	bad.Currency = "USD"
	if got := webhookRequest(s, bad, cfg.WebhookToken); got != 400 {
		t.Fatalf("wrong currency status%d", got)
	}
	bad = payment
	bad.Timestamp = strconv.FormatInt(now.Add(-11*time.Minute).Unix(), 10)
	calls := gw.verifyCalls
	if got := webhookRequest(s, bad, cfg.WebhookToken); got != 400 || gw.verifyCalls != calls {
		t.Fatalf("old signature invoked verifier: %d", got)
	}
	gw.verifyErr = ErrVerification
	if got := webhookRequest(s, payment, cfg.WebhookToken); got != 400 {
		t.Fatalf("invalid signature status%d", got)
	}
	gw.verifyErr = nil
	if got := webhookRequest(s, payment, strings.Repeat("b", 64)); got != 404 {
		t.Fatalf("wrong callback token status%d", got)
	}
	// Checkout readiness is an operations switch only. Already-created orders
	// and signed dashboard probes must still be verifiable while it is off.
	s.cfg.WebhookReady = false
	if got := webhookRequest(s, payment, cfg.WebhookToken); got != 200 {
		t.Fatalf("valid paid webhook=%d", got)
	}
	status, err = s.Status(ctx, accountID)
	if err != nil || status.Status != "active" || status.Access != "trial_open" || status.CheckoutReady || status.SubscriptionExpiresAt == nil || status.SubscriptionExpiresAt.Format(time.RFC3339) != "2027-02-28T15:05:06Z" {
		t.Fatalf("paid status=%+v,%v", status, err)
	}
	until := *status.SubscriptionExpiresAt
	if got := webhookRequest(s, payment, cfg.WebhookToken); got != 200 {
		t.Fatalf("duplicate webhook=%d", got)
	}
	status, _ = s.Status(ctx, accountID)
	if !status.SubscriptionExpiresAt.Equal(until) {
		t.Fatal("duplicate extended subscription")
	}
	failed := payment
	failed.Success = false
	failed.StatusCode = 0
	if got := webhookRequest(s, failed, cfg.WebhookToken); got != 200 {
		t.Fatal("failed notification not acknowledged")
	}
	after, _ := s.GetOrder(ctx, accountID, order.ID)
	if after.Status != "paid" {
		t.Fatal("failure downgraded paid order")
	}
	legacyFailure := []byte(fmt.Sprintf(`{"signature":"synthetic-signature","timestamp":"%d","user_id":"%s","success":false,"status_code":"declined","transaction_id":123456,"amount":null}`, now.Unix(), order.ID))
	if got := rawWebhookRequest(s, legacyFailure, cfg.WebhookToken).Code; got != 200 {
		t.Fatalf("known Kaata failure with provider field variants was not acknowledged: %d", got)
	}
	after, _ = s.GetOrder(ctx, accountID, order.ID)
	if after.Status != "paid" {
		t.Fatal("legacy failure downgraded paid order")
	}
	s.cfg.WebhookReady = true
	year, err := s.Checkout(ctx, accountID, "web_pro_yearly", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if got := webhookRequest(s, paymentFor(year, now, "txn-synthetic-year"), cfg.WebhookToken); got != 200 {
		t.Fatalf("year payment=%d", got)
	}
	status, _ = s.Status(ctx, accountID)
	if status.SubscriptionExpiresAt.Format(time.RFC3339) != "2028-02-28T15:05:06Z" {
		t.Fatalf("renewal did not extend previous expiry: %v", status.SubscriptionExpiresAt)
	}
	otherOrder, err := s.Checkout(ctx, other, "web_pro_monthly", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if got := webhookRequest(s, paymentFor(otherOrder, now, payment.TransactionID), cfg.WebhookToken); got != 400 {
		t.Fatalf("transaction replayed across orders=%d", got)
	}
	otherStatus, _ := s.Status(ctx, other)
	if otherStatus.Status != "trial" {
		t.Fatal("replay granted another account")
	}
	// FK policy must not make native account deletion fail.
	if foreignCalls.Load() != 0 {
		t.Fatal("known Kaata payment/replay/tamper/failure was forwarded to another application")
	}
	if _, err = pool.Exec(ctx, `DELETE FROM accounts WHERE id=$1::uuid`, accountID); err != nil {
		t.Fatalf("billing blocks account deletion: %v", err)
	}
	if got := webhookRequest(s, payment, cfg.WebhookToken); got != 200 {
		t.Fatal("deleted-account delivery should be acknowledged without resurrection")
	}
	foreign := payment
	foreign.UserID = "another-application-order"
	if got := webhookRequest(s, foreign, cfg.WebhookToken); got != 200 {
		t.Fatal("verified foreign merchant order was not acknowledged")
	}
	foreign.UserID = uuid.NewString()
	if got := webhookRequest(s, foreign, cfg.WebhookToken); got != 200 {
		t.Fatal("verified unknown merchant UUID was not acknowledged")
	}
	if foreignCalls.Load() != 3 {
		t.Fatalf("verified foreign deliveries not preserved: %d", foreignCalls.Load())
	}
}

func TestLostCheckoutResponseRemainsPendingWithoutNewSession(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	id := seedAccount(t, pool)
	now := time.Now().UTC()
	s := NewService(pool, testConfig())
	s.now = func() time.Time { return now }
	s.gateway = &fakeGateway{now: now, createErr: ErrUnavailable}
	gw := s.gateway.(*fakeGateway)
	req := uuid.NewString()
	order, err := s.Checkout(ctx, id, "web_pro_monthly", req)
	if !errors.Is(err, ErrPending) || order.ID == "" {
		t.Fatalf("uncertain create=%+v,%v", order, err)
	}
	for i := 0; i < 2; i++ {
		again, err := s.Checkout(ctx, id, "web_pro_monthly", req)
		if !errors.Is(err, ErrPending) || again.ID != order.ID {
			t.Fatal("uncertain session was replaced")
		}
	}
	if gw.createCalls != 1 {
		t.Fatal("lost response created duplicate session")
	}
	now = now.Add(16 * time.Minute)
	expired, err := s.GetOrder(ctx, id, order.ID)
	if err != nil || !expired.CanStartNewCheckout || expired.Status != "pending" {
		t.Fatal("abandoned unknown creation cannot be reviewed after the retry window")
	}
	if pending, err := s.Checkout(ctx, id, "web_pro_monthly", uuid.NewString()); !errors.Is(err, ErrPending) || pending.ID != order.ID {
		t.Fatal("abandoned payment was replaced without explicit acknowledgement")
	}
	gw.createErr = nil
	gw.now = now
	fresh, err := s.Checkout(ctx, id, "web_pro_monthly", uuid.NewString(), CheckoutOptions{ReplaceOrderID: order.ID})
	if err != nil || fresh.ID == order.ID || gw.createCalls != 2 {
		t.Fatalf("explicit fresh checkout unavailable: %+v,%v", fresh, err)
	}
	status, _ := s.Status(ctx, id)
	if status.Status != "trial" || status.Access != "trial_open" {
		t.Fatal("pending checkout locked trial")
	}
}

func TestConcurrentTabsReserveOneHostedCheckout(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	id := seedAccount(t, pool)
	now := time.Now().UTC()
	s := NewService(pool, testConfig())
	s.now = func() time.Time { return now }
	gw := &fakeGateway{now: now}
	s.gateway = gw
	type result struct {
		order Order
		err   error
	}
	out := make(chan result, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			o, e := s.Checkout(ctx, id, "web_pro_monthly", uuid.NewString())
			out <- result{o, e}
		}()
	}
	wg.Wait()
	close(out)
	orderID := ""
	created := 0
	for res := range out {
		if orderID == "" {
			orderID = res.order.ID
		}
		if res.order.ID != orderID {
			t.Fatal("tabs reserved different pending orders")
		}
		if res.err == nil {
			created++
		} else if !errors.Is(res.err, ErrPending) {
			t.Fatal(res.err)
		}
	}
	if created != 1 || gw.createCalls != 1 {
		t.Fatalf("created%d, provider calls%d", created, gw.createCalls)
	}
}

func TestConcurrentPaidOrdersExtendExactlyOnce(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	id := seedAccount(t, pool)
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	s := NewService(pool, testConfig())
	s.now = func() time.Time { return now }
	s.gateway = &fakeGateway{now: now}
	first, err := s.Checkout(ctx, id, "web_pro_monthly", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE web_pro_orders SET checkout_expires_at=$2 WHERE id=$1::uuid`, first.ID, now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if pending, err := s.Checkout(ctx, id, "web_pro_monthly", uuid.NewString()); !errors.Is(err, ErrPending) || pending.ID != first.ID {
		t.Fatal("expired pending payment was replaced without explicit acknowledgement")
	}
	second, err := s.Checkout(ctx, id, "web_pro_monthly", uuid.NewString(), CheckoutOptions{ReplaceOrderID: first.ID})
	if err != nil {
		t.Fatal(err)
	}
	orders := []Order{first, second}
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			order := orders[i%2]
			results <- s.fulfill(ctx, paymentFor(order, now, fmt.Sprintf("txn-%d", i%2)))
		}(i)
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	status, err := s.Status(ctx, id)
	if err != nil || status.SubscriptionExpiresAt == nil || status.SubscriptionExpiresAt.Format(time.RFC3339) != "2026-12-30T12:00:00Z" {
		t.Fatalf("concurrent renewal=%+v,%v", status, err)
	}
}

func TestDashboardValidationNeverFulfillsAndUnauthenticatedReadsFail(t *testing.T) {
	s := NewService(nil, testConfig())
	gw := &fakeGateway{now: time.Now().UTC()}
	s.gateway = gw
	s.cfg.WebhookReady = false
	probe := webhookPayment{Type: "webhook.validation", Test: true, ValidationID: uuid.NewString(), EventType: "payment_success", Signature: "probe", Timestamp: strconv.FormatInt(time.Now().Unix(), 10), Success: true, StatusCode: 10}
	if got := webhookRequest(s, probe, s.cfg.WebhookToken); got != 200 || gw.verifyCalls != 1 {
		t.Fatalf("validation with no database=%d", got)
	}
	gw.verifyErr = ErrVerification
	if got := webhookRequest(s, probe, s.cfg.WebhookToken); got != 400 {
		t.Fatal("invalid probe accepted")
	}
	gw.verifyErr = nil
	probe.Type = "payment_success"
	if got := webhookRequest(s, probe, s.cfg.WebhookToken); got != 400 {
		t.Fatal("test notification treated as payment")
	}
	h := NewHandler(s)
	for _, fn := range []http.HandlerFunc{h.Status, h.Checkout, h.Order} {
		res := httptest.NewRecorder()
		fn(res, httptest.NewRequest(http.MethodGet, "/v1/web-pro", nil))
		if res.Code != 401 || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("anonymous billing request accepted")
		}
	}
}
