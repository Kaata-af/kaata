package webpro

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// This target is an operator-configured existing merchant receiver. No webhook
// or browser parameter can select it, and no Kaata credential is relayed.
func validForeignWebhookURL(raw string) bool {
	if len(raw) > 2048 || strings.TrimSpace(raw) != raw {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Port() != "" || u.Host == "" || u.Host != u.Hostname() || strings.HasPrefix(path.Clean(u.Path), "/v1/web-pro/hesabpay/webhook") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return len(host) <= 253 && strings.Contains(host, ".") && !strings.Contains(host, "..") && hostnamePattern.MatchString(host) && net.ParseIP(host) == nil
}

func newForeignWebhookClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (s *Service) forwardForeignWebhook(ctx context.Context, raw []byte) error {
	if s.cfg.foreignWebhookInvalid {
		return ErrUnavailable
	}
	if s.cfg.ForeignWebhookURL == "" {
		return nil
	}
	if !validForeignWebhookURL(s.cfg.ForeignWebhookURL) {
		return ErrUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.ForeignWebhookURL, bytes.NewReader(raw))
	if err != nil {
		return ErrUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.foreignClient.Do(req)
	if err != nil {
		return ErrUnavailable
	}
	defer resp.Body.Close()
	// Bounded draining allows connection reuse without reflecting or logging
	// another application's response body. Only HTTP 200 acknowledges delivery.
	if _, err = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)); err != nil {
		return ErrUnavailable
	}
	if resp.StatusCode != http.StatusOK {
		return ErrUnavailable
	}
	return nil
}

type webhookEnvelope struct {
	signature, timestamp, userID, eventType, validationID, kind string
	test                                                        bool
	successState                                                int
}

func rawString(value json.RawMessage) (string, bool) {
	var out string
	if len(value) == 0 || json.Unmarshal(value, &out) != nil {
		return "", false
	}
	return out, true
}

func timestampString(value json.RawMessage) (string, bool) {
	if out, ok := rawString(value); ok {
		return out, true
	}
	if len(value) == 0 || len(value) > 12 {
		return "", false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return "", false
		}
	}
	return string(value), true
}

func parseWebhookEnvelope(raw []byte) (webhookEnvelope, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return webhookEnvelope{}, ErrVerification
	}
	var out webhookEnvelope
	var ok bool
	if out.signature, ok = rawString(fields["signature"]); !ok {
		return out, ErrVerification
	}
	if out.timestamp, ok = timestampString(fields["timestamp"]); !ok {
		return out, ErrVerification
	}
	out.userID, _ = rawString(fields["user_id"])
	out.kind, _ = rawString(fields["type"])
	out.eventType, _ = rawString(fields["event_type"])
	out.validationID, _ = rawString(fields["validation_id"])
	switch string(bytes.TrimSpace(fields["success"])) {
	case "true":
		out.successState = 1
	case "false":
		out.successState = -1
	}
	if value, exists := fields["test"]; exists && string(value) != "null" {
		if json.Unmarshal(value, &out.test) != nil {
			return out, ErrVerification
		}
	}
	return out, nil
}

func (p *webhookPayment) UnmarshalJSON(raw []byte) error {
	type alias webhookPayment
	var decoded struct {
		*alias
		Timestamp json.RawMessage `json:"timestamp"`
	}
	decoded.alias = (*alias)(p)
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	stamp, ok := timestampString(decoded.Timestamp)
	if !ok {
		return errors.New("invalid notification timestamp")
	}
	p.Timestamp = stamp
	return nil
}
