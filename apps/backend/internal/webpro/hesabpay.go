package webpro

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// HesabPay's public verification API accepts signature/timestamp only; its
// documentation does not establish binding to all webhook fields. The separate
// high-entropy callback URL token is therefore also required to authenticate
// delivery. Neither credential is sent to a browser or included in logs.
type Config struct {
	APIKey                string
	Environment           string
	WebhookToken          string
	WebhookReady          bool
	CheckoutHosts         []string
	WebBaseURL            string
	ForeignWebhookURL     string
	foreignWebhookInvalid bool
}

type gateway interface {
	Create(context.Context, Order, string) (checkoutSession, error)
	Verify(context.Context, string, string) error
}

type checkoutSession struct {
	ID, URL   string
	ExpiresAt time.Time
}

type hesabPay struct {
	cfg     Config
	client  *http.Client
	baseURL string
}

var hostnamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
var amountPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,2}))?$`)

func normalizeConfig(cfg Config) Config {
	cfg.APIKey = strings.TrimSpace(cfg.APIKey)
	if strings.ContainsAny(cfg.APIKey, "\r\n<>") {
		cfg.APIKey = ""
	}
	cfg.WebhookToken = strings.TrimSpace(cfg.WebhookToken)
	if !tokenPattern.MatchString(cfg.WebhookToken) {
		cfg.WebhookToken = ""
	}
	if cfg.Environment == "" {
		cfg.Environment = "production"
	}
	seen := map[string]bool{}
	hosts := []string{}
	for _, host := range cfg.CheckoutHosts {
		host = strings.ToLower(strings.TrimSpace(host))
		if len(host) <= 253 && strings.Contains(host, ".") && hostnamePattern.MatchString(host) && !strings.Contains(host, "..") && !seen[host] {
			hosts = append(hosts, host)
			seen[host] = true
		}
	}
	cfg.CheckoutHosts = hosts
	if cfg.ForeignWebhookURL != "" && !validForeignWebhookURL(cfg.ForeignWebhookURL) {
		cfg.foreignWebhookInvalid = true
		cfg.ForeignWebhookURL = ""
	}
	web, err := url.Parse(cfg.WebBaseURL)
	if err != nil || web.Scheme != "https" || web.Hostname() == "" || web.User != nil || web.RawQuery != "" || web.Fragment != "" || (web.Path != "" && web.Path != "/") {
		cfg.WebBaseURL = ""
	} else {
		cfg.WebBaseURL = strings.TrimRight(cfg.WebBaseURL, "/")
	}
	return cfg
}

func checkoutReady(cfg Config) bool {
	return cfg.APIKey != "" && cfg.WebhookToken != "" && cfg.WebhookReady && !cfg.foreignWebhookInvalid && len(cfg.CheckoutHosts) > 0 && cfg.WebBaseURL != "" && (cfg.Environment == "production" || cfg.Environment == "sandbox")
}

func allowedReturnOrigin(cfg Config, requested string) (string, bool) {
	if requested == "" {
		return cfg.WebBaseURL, cfg.WebBaseURL != ""
	}
	if requested == cfg.WebBaseURL {
		return requested, true
	}
	if cfg.WebBaseURL == "https://kaata.af" && requested == "https://www.kaata.af" {
		return requested, true
	}
	return "", false
}

func validCheckoutURL(raw string, hosts []string) bool {
	if len(raw) > 8192 {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") || u.Hostname() == "" {
		return false
	}
	for _, host := range hosts {
		if strings.EqualFold(u.Hostname(), host) {
			return true
		}
	}
	return false
}

func newHesabPay(cfg Config) *hesabPay {
	base := "https://api.hesab.com"
	if cfg.Environment == "sandbox" {
		base = "https://api-sandbox.hesab.com"
	}
	return &hesabPay{cfg: cfg, baseURL: base, client: &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (h *hesabPay) post(ctx context.Context, path string, input any, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return ErrUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return ErrUnavailable
	}
	req.Header.Set("Authorization", "API-KEY "+h.cfg.APIKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		return ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ErrUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
	if err != nil || len(data) > 65536 {
		return ErrUnavailable
	}
	if json.Unmarshal(data, output) != nil {
		return ErrUnavailable
	}
	return nil
}

func moneyNumber(minor int64) json.Number {
	return json.Number(fmt.Sprintf("%d.%02d", minor/100, minor%100))
}

func parseMinor(number json.Number) (int64, bool) {
	parts := amountPattern.FindStringSubmatch(number.String())
	if parts == nil {
		return 0, false
	}
	whole, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return 0, false
	}
	frac := parts[2]
	if len(frac) == 1 {
		frac += "0"
	}
	if frac == "" {
		frac = "00"
	}
	cents, _ := strconv.ParseInt(frac, 10, 64)
	return whole*100 + cents, true
}

type paymentItem struct {
	ID    string      `json:"id"`
	Name  string      `json:"name"`
	Price json.Number `json:"price"`
}

func (h *hesabPay) Create(ctx context.Context, order Order, returnURL string) (checkoutSession, error) {
	input := struct {
		UserID     string        `json:"user_id"`
		Items      []paymentItem `json:"items"`
		SuccessURL string        `json:"redirect_success_url"`
		FailureURL string        `json:"redirect_failure_url"`
	}{order.ID, []paymentItem{{order.ID, order.itemName, moneyNumber(order.AmountMinor)}}, returnURL, returnURL}
	var out struct {
		Success    bool   `json:"success"`
		StatusCode int    `json:"status_code"`
		SessionID  string `json:"session_id"`
		URL        string `json:"url"`
		ExpiresAt  string `json:"expires_at"`
		UserID     string `json:"user_id"`
	}
	if err := h.post(ctx, "/api/v1/payment/create-session", input, &out); err != nil {
		return checkoutSession{}, err
	}
	expires, err := time.Parse(time.RFC3339, out.ExpiresAt)
	if err != nil {
		expires, err = time.Parse("2006-01-02 15:04:05", out.ExpiresAt)
	}
	if !out.Success || out.StatusCode != 10 || out.UserID != order.ID || out.SessionID == "" || err != nil || !validCheckoutURL(out.URL, h.cfg.CheckoutHosts) || !expires.After(time.Now()) || expires.After(time.Now().Add(time.Hour)) {
		return checkoutSession{}, ErrUnavailable
	}
	if _, err := uuid.Parse(out.SessionID); err != nil {
		return checkoutSession{}, ErrUnavailable
	}
	return checkoutSession{ID: out.SessionID, URL: out.URL, ExpiresAt: expires.UTC()}, nil
}

func (h *hesabPay) Verify(ctx context.Context, signature, timestamp string) error {
	var out struct {
		Success bool `json:"success"`
	}
	if err := h.post(ctx, "/api/v1/hesab/webhooks/verify-signature", map[string]string{"signature": signature, "timestamp": timestamp}, &out); err != nil {
		return ErrUnavailable
	}
	if !out.Success {
		return ErrVerification
	}
	return nil
}
