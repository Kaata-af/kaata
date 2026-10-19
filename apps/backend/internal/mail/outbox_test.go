package mail

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// blockingSender holds every delivery until released, like a slow provider.
type blockingSender struct {
	started chan struct{}
	release chan struct{}
	sends   atomic.Int32
}

func newBlockingSender() *blockingSender {
	return &blockingSender{started: make(chan struct{}, 8), release: make(chan struct{})}
}

func (b *blockingSender) Send(_ context.Context, _ Message) error {
	b.sends.Add(1)
	b.started <- struct{}{}
	<-b.release
	return nil
}

func queueOne(t *testing.T, pool *pgxpool.Pool, o *Outbox, m Message) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := o.Enqueue(ctx, tx, m, 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A claimed row is leased longer than one delivery, so a slow send is never
// claimed and sent a second time.
func TestOutboxLeaseOutlastsASlowSend(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	sender := newBlockingSender()
	o := NewOutbox(pool, sender, 0, 0)
	queueOne(t, pool, o, Render(KindSignupCode, "en", "slow@shop.af", "112233"))

	done := make(chan struct{})
	go func() {
		o.drain(ctx)
		close(done)
	}()
	<-sender.started
	var leased bool
	if err := pool.QueryRow(ctx, `SELECT next_attempt_at > NOW() + INTERVAL '50 seconds' FROM email_outbox`).Scan(&leased); err != nil {
		t.Fatal(err)
	}
	if !leased {
		t.Fatal("the claim must lease the row past one delivery")
	}
	o.drain(ctx) // a second worker finds nothing due
	if n := sender.sends.Load(); n != 1 {
		t.Fatalf("%d deliveries started, want 1", n)
	}
	close(sender.release)
	<-done
	var sent bool
	if err := pool.QueryRow(ctx, `SELECT sent_at IS NOT NULL FROM email_outbox`).Scan(&sent); err != nil || !sent {
		t.Fatalf("the slow delivery was not recorded: %v", err)
	}
}

// A delivery the provider accepted while shutdown began is marked sent, so the
// next container does not send it again.
func TestOutboxRecordsADeliveryAfterShutdownBegan(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	sender := newBlockingSender()
	o := NewOutbox(pool, sender, 0, 0)
	queueOne(t, pool, o, Render(KindResetCode, "en", "shutdown@shop.af", "445566"))
	ctx, cancel := context.WithCancel(context.Background())
	o.Start(ctx, 2)
	<-sender.started
	cancel()
	close(sender.release)
	o.Wait(5 * time.Second)
	var sent bool
	var body *string
	if err := pool.QueryRow(context.Background(), `SELECT sent_at IS NOT NULL, text_body FROM email_outbox`).Scan(&sent, &body); err != nil {
		t.Fatal(err)
	}
	if !sent || body != nil {
		t.Fatalf("after shutdown: sent=%v body kept=%v", sent, body != nil)
	}
}

// checkSender fails its login check until told otherwise.
type checkSender struct {
	mu   sync.Mutex
	fail bool
}

func (c *checkSender) Send(context.Context, Message) error { return nil }
func (c *checkSender) Check(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail {
		return &connectError{errors.New("smtp auth: 535 invalid key")}
	}
	return nil
}

func (c *checkSender) set(fail bool) {
	c.mu.Lock()
	c.fail = fail
	c.mu.Unlock()
}

// A failed login turns mail off, so the API answers "unavailable" instead of
// "sent", until a re-check passes.
func TestFailedLoginTurnsMailOffUntilARecheckPasses(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	sender := &checkSender{fail: true}
	o := NewOutbox(pool, sender, 0, 0)
	o.recheck = 30 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		o.Wait(2 * time.Second)
	}()
	o.Start(ctx, 1)
	waitFor(t, "mail to turn off", func() bool { return !o.Enabled() })
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := o.Enqueue(ctx, tx, Render(KindSignupCode, "en", "x@shop.af", "123456"), time.Minute); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("enqueue while the login fails: %v", err)
	}
	_ = tx.Rollback(ctx)
	sender.set(false)
	waitFor(t, "mail to come back", o.Enabled)

	// A delivery that cannot connect turns mail off the same way.
	o.record(ctx, 0, 1, &connectError{errors.New("smtp dial: connection refused")})
	if o.Enabled() {
		t.Fatal("a connect failure must turn mail off")
	}
	waitFor(t, "the re-check to turn mail back on", o.Enabled)
}

func TestSMTPConnectFailuresAreConnectErrors(t *testing.T) {
	s, problems := newSMTPSender(Config{SMTPHost: "127.0.0.1", SMTPPort: "1", SMTPUsername: "u", SMTPPassword: "p",
		From: "Kaata <no-reply@mail.kaata.af>"})
	if len(problems) > 0 {
		t.Fatal(problems)
	}
	ctx := context.Background()
	if err := s.Check(ctx); !IsConnectError(err) {
		t.Fatalf("check against a closed port: %v", err)
	}
	if err := s.Send(ctx, Render(KindSignupCode, "en", "x@shop.af", "123456")); !IsConnectError(err) {
		t.Fatalf("send against a closed port: %v", err)
	}
	if IsConnectError(errors.New("550 mailbox unavailable")) {
		t.Fatal("a refused message is not a connect failure")
	}
}

func TestPasswordNotices(t *testing.T) {
	if got := MaskAddress("thief@evil.af"); got != "t***@evil.af" {
		t.Fatalf("mask %q", got)
	}
	if Lang(" FA ") != "fa" || Lang("") != "en" || Lang("ps") != "ps" {
		t.Fatal("Lang misjudged")
	}
	for _, lang := range []string{"en", "fa", "ps"} {
		m := RenderElsewhere(lang, "owner@gmail.com", "t***@evil.af")
		if m.To != "owner@gmail.com" || strings.Contains(m.Text, "{address}") || strings.Contains(m.HTML, "{address}") {
			t.Fatalf("%s: %+v", lang, m)
		}
		if !strings.Contains(m.HTML, `<span dir="ltr">t***@evil.af</span>`) {
			t.Fatalf("%s: the address must be an LTR span in HTML", lang)
		}
		if lang != "en" && !strings.Contains(m.Text, "⁦t***@evil.af⁩") {
			t.Fatal("fa: the address must be LTR-isolated in text")
		}
		if lang == "en" && !strings.Contains(m.Text, "t***@evil.af") {
			t.Fatal("en: the address is missing")
		}
		removed := Render(KindPasswordRemoved, lang, "owner@gmail.com", "")
		if removed.Subject == "" || removed.Text == "" {
			t.Fatalf("%s: the removal notice is empty", lang)
		}
	}
}
