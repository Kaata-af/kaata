package webpro

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestManualGrantKeepsPaidPeriodsSeparate(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	account, other := seedAccount(t, pool), seedAccount(t, pool)
	now := time.Date(2027, time.January, 31, 10, 30, 0, 0, time.UTC)
	svc := NewService(pool, testConfig())
	svc.now = func() time.Time { return now }
	svc.gateway = &fakeGateway{now: now}
	grantInput := ManualGrantInput{OperationID: uuid.NewString(), ExpiresAt: now.AddDate(0, 4, 0), Reason: " Support courtesy "}
	grant, err := svc.GrantManualPro(ctx, account, grantInput)
	if err != nil || grant.Duplicate || grant.Grant.ID != grantInput.OperationID || grant.Grant.Reason != "Support courtesy" {
		t.Fatalf("grant = %+v, %v", grant, err)
	}
	status, err := svc.Status(ctx, account)
	if err != nil || status.Status != "active" || status.Access != "trial_open" || status.PaidExpiresAt != nil ||
		status.SubscriptionExpiresAt == nil || !status.SubscriptionExpiresAt.Equal(grantInput.ExpiresAt) {
		t.Fatalf("complimentary customer status = %+v, %v", status, err)
	}
	view, err := svc.AdminSubscription(ctx, account)
	if err != nil || view.Status != "active" || view.PaidExpiresAt != nil || view.ManualGrant == nil || view.ManualGrant.ID != grant.Grant.ID ||
		len(view.GrantHistory) != 1 || len(view.Payments) != 0 {
		t.Fatalf("complimentary admin view = %+v, %v", view, err)
	}
	if replay, err := svc.GrantManualPro(ctx, account, grantInput); err != nil || !replay.Duplicate || replay.Grant.ID != grant.Grant.ID {
		t.Fatalf("grant replay = %+v, %v", replay, err)
	}
	if _, err := svc.GrantManualPro(ctx, account, ManualGrantInput{OperationID: grantInput.OperationID, ExpiresAt: grantInput.ExpiresAt, Reason: "Changed"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed grant retry = %v", err)
	}
	if _, err := svc.GrantManualPro(ctx, other, grantInput); !errors.Is(err, ErrConflict) {
		t.Fatalf("request ID reused across accounts = %v", err)
	}
	if _, err := svc.GrantManualPro(ctx, account, ManualGrantInput{OperationID: uuid.NewString(), ExpiresAt: grantInput.ExpiresAt, Reason: "Another"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("overlapping grant = %v", err)
	}

	// A cash sale starts from the current time. A provider renewal uses that
	// paid expiry even though the complimentary grant still lasts longer.
	monthly := "web_pro_monthly"
	cash, err := svc.RecordManualPayment(ctx, account, ManualPaymentInput{PlanID: monthly, Method: "cash", Reference: "GRANT-CASH-1"})
	firstExpiry := time.Date(2027, time.February, 28, 10, 30, 0, 0, time.UTC)
	if err != nil || !cash.SubscriptionExpiresAt.Equal(firstExpiry) {
		t.Fatalf("cash expiry included grant time: %+v, %v", cash, err)
	}
	order, err := svc.Checkout(ctx, account, monthly, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.fulfill(ctx, paymentFor(order, now, "synthetic-grant-renewal")); err != nil {
		t.Fatal(err)
	}
	paidExpiry := time.Date(2027, time.March, 28, 10, 30, 0, 0, time.UTC)
	status, err = svc.Status(ctx, account)
	if err != nil || status.PaidExpiresAt == nil || !status.PaidExpiresAt.Equal(paidExpiry) ||
		status.SubscriptionExpiresAt == nil || !status.SubscriptionExpiresAt.Equal(grantInput.ExpiresAt) {
		t.Fatalf("combined status = %+v, %v", status, err)
	}

	revokeInput := RevokeManualGrantInput{OperationID: uuid.NewString(), Reason: " Courtesy ended "}
	if _, err := svc.RevokeManualPro(ctx, other, grant.Grant.ID, revokeInput); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revocation crossed accounts: %v", err)
	}
	revoked, err := svc.RevokeManualPro(ctx, account, grant.Grant.ID, revokeInput)
	if err != nil || revoked.Duplicate || revoked.Grant.RevokedAt == nil || revoked.Grant.RevokeReason == nil || *revoked.Grant.RevokeReason != "Courtesy ended" {
		t.Fatalf("revoke = %+v, %v", revoked, err)
	}
	view, err = svc.AdminSubscription(ctx, account)
	if err != nil || view.ManualGrant != nil || view.SubscriptionExpiresAt == nil || !view.SubscriptionExpiresAt.Equal(paidExpiry) ||
		view.PaidExpiresAt == nil || !view.PaidExpiresAt.Equal(paidExpiry) || len(view.Payments) != 2 || len(view.GrantHistory) != 1 || view.GrantHistory[0].RevokedAt == nil {
		t.Fatalf("revocation changed paid period or removed audit history: %+v, %v", view, err)
	}

	newGrantInput := ManualGrantInput{OperationID: uuid.NewString(), ExpiresAt: grantInput.ExpiresAt.Add(time.Hour), Reason: "New courtesy"}
	newGrant, err := svc.GrantManualPro(ctx, account, newGrantInput)
	if err != nil || newGrant.Duplicate {
		t.Fatalf("new grant = %+v, %v", newGrant, err)
	}
	if replay, err := svc.RevokeManualPro(ctx, account, grant.Grant.ID, revokeInput); err != nil || !replay.Duplicate || replay.Grant.ID != grant.Grant.ID {
		t.Fatalf("old revoke replay = %+v, %v", replay, err)
	}
	if replay, err := svc.GrantManualPro(ctx, account, grantInput); err != nil || !replay.Duplicate || replay.Grant.RevokedAt == nil {
		t.Fatalf("old grant replay reactivated a revoked grant: %+v, %v", replay, err)
	}
	view, err = svc.AdminSubscription(ctx, account)
	if err != nil || view.ManualGrant == nil || view.ManualGrant.ID != newGrant.Grant.ID || len(view.GrantHistory) != 2 {
		t.Fatalf("stale operations changed the new grant: %+v, %v", view, err)
	}
	now = newGrantInput.ExpiresAt
	status, err = svc.Status(ctx, account)
	if err != nil || status.Status != "trial" || status.Access != "trial_open" {
		t.Fatalf("complimentary access continued past expiration: %+v, %v", status, err)
	}
	view, err = svc.AdminSubscription(ctx, account)
	if err != nil || view.ManualGrant != nil || len(view.GrantHistory) != 2 {
		t.Fatalf("expired grant missing from history or still active: %+v, %v", view, err)
	}
}

func TestManualGrantConcurrentOperators(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account := seedAccount(t, pool)
	svc := NewService(pool, Config{})
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, err := svc.GrantManualPro(t.Context(), account, ManualGrantInput{
				OperationID: uuid.NewString(), ExpiresAt: time.Now().Add(time.Hour), Reason: "Courtesy",
			})
			results <- err
		}()
	}
	close(start)
	first, second := <-results, <-results
	if first != nil {
		first, second = second, first
	}
	if first != nil || !errors.Is(second, ErrConflict) {
		t.Fatalf("concurrent grant results = %v, %v", first, second)
	}
	view, err := svc.AdminSubscription(t.Context(), account)
	if err != nil || view.ManualGrant == nil || len(view.GrantHistory) != 1 {
		t.Fatalf("concurrent grant history = %+v, %v", view, err)
	}
}
