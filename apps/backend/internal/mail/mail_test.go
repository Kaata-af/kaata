package mail

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestDriverSelectionIsExplicit(t *testing.T) {
	for _, cfg := range []Config{
		{Driver: "log", Production: true},
		{Driver: "log", Development: true, Production: true},
		{Driver: "log"}, // fail-closed: KAATA_ENV unset is not development
	} {
		if _, err := Select(cfg); !errors.Is(err, ErrLogDriverRefused) {
			t.Fatalf("log driver with %+v: %v", cfg, err)
		}
	}
	if !IsDevelopment(" Development ") || IsDevelopment("") || IsDevelopment("production") {
		t.Fatal("IsDevelopment misjudged")
	}
	if !IsProduction("production", "") || !IsProduction("", "https://api.kaata.af") || IsProduction("", "http://192.168.1.5:8080") {
		t.Fatal("IsProduction misjudged")
	}
	sel, err := Select(Config{Driver: "log", Development: true})
	if err != nil || sel.Sender == nil {
		t.Fatalf("log driver locally: %v", err)
	}
	for _, cfg := range []Config{
		{},
		{Driver: "smtp"},
		{Driver: "smtp", SMTPHost: "smtp.example.com", SMTPUsername: "u", SMTPPassword: "p", From: "not an address"},
		// The env template's placeholders count as empty: mail stays off.
		{Driver: "smtp", SMTPHost: "smtp.resend.com", SMTPUsername: "resend",
			SMTPPassword: "<paste-the-resend-api-key-here>", From: "Kaata <no-reply@mail.kaata.af>"},
		{Driver: "sendmail"},
	} {
		sel, err := Select(cfg)
		if err != nil || sel.Sender != nil || sel.Describe == "" {
			t.Fatalf("%+v: sender %v err %v; want mail disabled with a boot line", cfg, sel.Sender, err)
		}
		if strings.Contains(sel.Describe, "p") && cfg.SMTPPassword == "p" && strings.Contains(sel.Describe, "password=p") {
			t.Fatal("the boot line must not print credentials")
		}
	}
	sel, err = Select(Config{Driver: "smtp", SMTPHost: "smtp.example.com", SMTPPort: "587", SMTPUsername: "resend",
		SMTPPassword: "secret-key", From: "Kaata <no-reply@mail.kaata.af>"})
	if err != nil || sel.Sender == nil || strings.Contains(sel.Describe, "secret-key") {
		t.Fatalf("smtp: %v %q", err, sel.Describe)
	}
}

func TestTemplatesKeepTheCodeOutOfTheSubject(t *testing.T) {
	for _, lang := range []string{"en", "fa"} {
		for _, kind := range []Kind{KindSignupCode, KindResetCode, KindSetupCode} {
			m := Render(kind, lang, "a@shop.af", "482913")
			if strings.Contains(m.Subject, "482913") || !strings.Contains(m.Text, "482913") || !strings.Contains(m.HTML, "482913") {
				t.Fatalf("%s %s: the code must be in the body only", lang, kind)
			}
			if strings.Index(m.Text, "482913") == 0 {
				t.Fatalf("%s %s: the body must open with a sentence, not the code", lang, kind)
			}
			if lang == "fa" && !strings.Contains(m.Text, "⁦482913⁩") {
				t.Fatalf("fa %s: the code must be LTR-isolated", kind)
			}
		}
		for _, kind := range []Kind{KindAccountExists, KindProviderOnly, KindPasswordChanged} {
			m := Render(kind, lang, "a@shop.af", "")
			if m.Subject == "" || m.Text == "" || strings.ContainsAny(m.Text, "0123456789") && lang == "en" {
				t.Fatalf("%s %s: notice %+v", lang, kind, m)
			}
		}
	}
}

func TestMessageHeaders(t *testing.T) {
	from, _ := mail.ParseAddress("Kaata <no-reply@mail.kaata.af>")
	to, _ := mail.ParseAddress("owner@shop.af")
	b, err := buildMessage(from, to, Render(KindSignupCode, "fa", "owner@shop.af", "123456"), time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	head := string(b[:strings.Index(string(b), "\r\n\r\n")])
	for _, want := range []string{"From: \"Kaata\" <no-reply@mail.kaata.af>", "To: <owner@shop.af>", "Subject: =?utf-8?q?",
		"MIME-Version: 1.0", "multipart/alternative"} {
		if !strings.Contains(head, want) {
			t.Fatalf("header %q missing in:\n%s", want, head)
		}
	}
	if strings.Contains(string(b), "123456") {
		t.Fatal("the code must only appear base64-encoded in the body parts")
	}
}

func TestRedactAddresses(t *testing.T) {
	got := redactAddresses("550 5.1.1 <owner@shop.af>: Recipient address rejected")
	if strings.Contains(got, "owner@shop.af") || !strings.Contains(got, "<address>") {
		t.Fatalf("redacted %q", got)
	}
}

type flakySender struct {
	mu   sync.Mutex
	fail bool
	sent []Message
}

func (f *flakySender) Send(_ context.Context, m Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("550 mailbox owner@shop.af unavailable")
	}
	f.sent = append(f.sent, m)
	return nil
}

func TestOutboxDeliversRetriesAndClearsBodies(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	sender := &flakySender{fail: true}
	o := NewOutbox(pool, sender, 0, 0)

	enqueue := func(m Message, ttl time.Duration) {
		tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if err := o.Enqueue(ctx, tx, m, ttl); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	enqueue(Render(KindSignupCode, "en", "owner@shop.af", "246810"), 15*time.Minute)

	o.drain(ctx)
	var attempts int
	var lastErr *string
	var text *string
	if err := pool.QueryRow(ctx, `SELECT attempts, last_error, text_body FROM email_outbox`).Scan(&attempts, &lastErr, &text); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || lastErr == nil || strings.Contains(*lastErr, "owner@shop.af") || text == nil {
		t.Fatalf("after a failure: attempts=%d last_error=%v body kept=%v", attempts, lastErr, text != nil)
	}

	sender.mu.Lock()
	sender.fail = false
	sender.mu.Unlock()
	if _, err := pool.Exec(ctx, `UPDATE email_outbox SET next_attempt_at = NOW()`); err != nil {
		t.Fatal(err)
	}
	o.drain(ctx)
	var sent bool
	if err := pool.QueryRow(ctx, `SELECT sent_at IS NOT NULL, text_body FROM email_outbox`).Scan(&sent, &text); err != nil {
		t.Fatal(err)
	}
	if !sent || text != nil || len(sender.sent) != 1 || !strings.Contains(sender.sent[0].Text, "246810") {
		t.Fatalf("after delivery: sent=%v body cleared=%v deliveries=%d", sent, text == nil, len(sender.sent))
	}

	// Mail past its deadline is never sent, and its code is wiped.
	enqueue(Render(KindResetCode, "en", "late@shop.af", "135790"), time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	o.drain(ctx)
	var lateBody *string
	if err := pool.QueryRow(ctx, `SELECT text_body FROM email_outbox WHERE to_addr = 'late@shop.af'`).Scan(&lateBody); err != nil {
		t.Fatal(err)
	}
	if lateBody != nil || len(sender.sent) != 1 {
		t.Fatalf("expired mail: body kept=%v deliveries=%d", lateBody != nil, len(sender.sent))
	}

	if (*Outbox)(nil).Enabled() || NewOutbox(pool, nil, 0, 0).Enabled() {
		t.Fatal("an outbox without a sender must be disabled")
	}
	if h, d := NewOutbox(pool, sender, 30, 90).Limits(); h != 30 || d != 90 {
		t.Fatalf("limits %d/%d", h, d)
	}
}
