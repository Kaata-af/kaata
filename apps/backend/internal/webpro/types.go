// Package webpro records voluntary subscriptions for the web workspace. It is
// deliberately not an access middleware: every account keeps open-trial access.
package webpro

import (
	"errors"
	"time"
)

var (
	ErrUnavailable  = errors.New("web pro checkout unavailable")
	ErrInvalid      = errors.New("invalid web pro request")
	ErrConflict     = errors.New("web pro request conflicts with existing order")
	ErrPending      = errors.New("web pro checkout is still being confirmed")
	ErrNotFound     = errors.New("web pro order not found")
	ErrVerification = errors.New("payment could not be verified")
)

type Plan struct {
	ID             string `json:"id"`
	AmountMinor    int64  `json:"amount_minor"`
	Currency       string `json:"currency"`
	DurationMonths int    `json:"duration_months"`
}

func Plans() []Plan {
	return []Plan{
		{ID: "web_pro_monthly", AmountMinor: 20000, Currency: "AFN", DurationMonths: 1},
		{ID: "web_pro_yearly", AmountMinor: 200000, Currency: "AFN", DurationMonths: 12},
	}
}

func planByID(id string) (Plan, bool) {
	for _, plan := range Plans() {
		if plan.ID == id {
			return plan, true
		}
	}
	return Plan{}, false
}

func itemName(planID string) string {
	if planID == "web_pro_yearly" {
		return "Kaata Pro - 1 year"
	}
	return "Kaata Pro - 1 month"
}

type Status struct {
	Status                string     `json:"status"`
	Access                string     `json:"access"`
	SubscriptionExpiresAt *time.Time `json:"subscription_expires_at"`
	CheckoutReady         bool       `json:"checkout_ready"`
	Plans                 []Plan     `json:"plans"`
	CheckoutHosts         []string   `json:"checkout_hosts"`
	PendingOrderID        *string    `json:"pending_order_id"`
}

func statusAt(validUntil *time.Time, ready bool, now time.Time) Status {
	status := "trial"
	if validUntil != nil && validUntil.After(now) {
		status = "active"
	}
	return Status{Status: status, Access: "trial_open", SubscriptionExpiresAt: validUntil, CheckoutReady: ready, Plans: Plans(), CheckoutHosts: []string{}}
}

type Order struct {
	ID                  string     `json:"order_id"`
	PlanID              string     `json:"plan_id"`
	Status              string     `json:"status"`
	AmountMinor         int64      `json:"amount_minor"`
	Currency            string     `json:"currency"`
	CreatedAt           time.Time  `json:"created_at"`
	ExpiresAt           *time.Time `json:"checkout_expires_at"`
	CheckoutURL         *string    `json:"checkout_url,omitempty"`
	CanStartNewCheckout bool       `json:"can_start_new_checkout"`
	accountID           string
	requestID           string
	durationMonths      int
	itemName            string
	returnOrigin        string
	sessionID           *string
}

// addMonths clamps the day at month end; January 31 + one month must not
// silently become March 3 as time.AddDate's normalization would allow.
func addMonths(start time.Time, months int) time.Time {
	start = start.UTC()
	first := time.Date(start.Year(), start.Month()+time.Month(months), 1, start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), time.UTC)
	lastDay := time.Date(first.Year(), first.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	day := start.Day()
	if day > lastDay {
		day = lastDay
	}
	return time.Date(first.Year(), first.Month(), day, start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), time.UTC)
}
