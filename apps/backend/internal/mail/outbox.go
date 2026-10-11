package mail

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrUnavailable means no mail can be queued: the driver is off, the mail
// server refuses our login, or the global start budget is spent. The code
// endpoints answer 503 email_unavailable.
var ErrUnavailable = errors.New("email delivery is unavailable")

const (
	// claimLease is how long a claimed row is left alone before another worker
	// may retry it. Longer than one SMTP delivery (smtpTimeout), so a slow send
	// is never sent twice.
	claimLease = 60 * time.Second
	// bookkeepingTimeout bounds the row update after a delivery. It runs even
	// after shutdown began, so a message the provider accepted is marked sent.
	bookkeepingTimeout = 5 * time.Second
	// defaultRecheck: how often a failed mail login is tried again.
	defaultRecheck = 60 * time.Second
)

// Outbox queues messages in email_outbox and delivers them with background
// workers. A row is written in the same transaction as the code it carries,
// so a code exists only if its mail will be attempted, and a redeploy or a
// provider outage delays delivery instead of dropping it.
type Outbox struct {
	pool       *pgxpool.Pool
	sender     Sender
	maxPerHour int
	maxPerDay  int
	nudge      chan struct{}
	// unhealthy: the last login check (or a delivery) could not reach or log
	// in to the mail server. Mail is then off until a re-check succeeds, so the
	// app hears "unavailable" instead of "sent" for a code that cannot arrive.
	unhealthy atomic.Bool
	recheck   time.Duration
	wg        sync.WaitGroup
}

// NewOutbox wires the outbox. A nil sender disables mail (Enabled is false).
// maxPerHour/maxPerDay are the global start budget (zero means no cap), which
// the auth service enforces per request before anything is queued.
func NewOutbox(pool *pgxpool.Pool, sender Sender, maxPerHour, maxPerDay int) *Outbox {
	return &Outbox{pool: pool, sender: sender, maxPerHour: maxPerHour, maxPerDay: maxPerDay,
		nudge: make(chan struct{}, 1), recheck: defaultRecheck}
}

// Enabled reports whether mail can be sent right now.
func (o *Outbox) Enabled() bool { return o != nil && o.sender != nil && !o.unhealthy.Load() }

// Limits returns the global start budget (per hour, per day; 0 = no cap).
func (o *Outbox) Limits() (perHour, perDay int) {
	if o == nil {
		return 0, 0
	}
	return o.maxPerHour, o.maxPerDay
}

// Enqueue writes m into the outbox inside the caller's transaction. ttl bounds
// how long delivery is retried (a code is useless once it has expired).
func (o *Outbox) Enqueue(ctx context.Context, tx pgx.Tx, m Message, ttl time.Duration) error {
	if !o.Enabled() {
		return ErrUnavailable
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO email_outbox (to_addr, subject, text_body, html_body, not_after)
		VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))
	`, m.To, m.Subject, m.Text, m.HTML, ttl.Seconds()); err != nil {
		return fmt.Errorf("queue mail: %w", err)
	}
	return nil
}

// Nudge wakes a worker. Call it after the enqueuing transaction committed.
func (o *Outbox) Nudge() {
	if o == nil {
		return
	}
	select {
	case o.nudge <- struct{}{}:
	default:
	}
}

// Start runs n delivery workers and the login monitor until ctx ends. A
// disabled outbox starts none.
func (o *Outbox) Start(ctx context.Context, n int) {
	if o == nil || o.sender == nil {
		return
	}
	o.wg.Add(1)
	go o.monitor(ctx)
	for i := 0; i < n; i++ {
		o.wg.Add(1)
		go func() {
			defer o.wg.Done()
			o.worker(ctx)
		}()
	}
}

// Wait blocks until the workers have stopped (after ctx ended) or timeout
// passes, so a delivery in flight at shutdown is recorded before the process
// exits.
func (o *Outbox) Wait(timeout time.Duration) {
	if o == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		o.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		log.Printf("mail: shutdown went ahead with a delivery still in flight")
	}
}

// monitor logs in once at boot and then, while logins fail, every recheck.
func (o *Outbox) monitor(ctx context.Context) {
	defer o.wg.Done()
	o.checkLogin(ctx, true)
	tick := time.NewTicker(o.recheck)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if o.unhealthy.Load() {
				o.checkLogin(ctx, false)
			}
		}
	}
}

func (o *Outbox) checkLogin(ctx context.Context, boot bool) {
	err := Check(ctx, o.sender)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		o.markUnhealthy(err)
		return
	}
	if o.unhealthy.Swap(false) {
		log.Println("mail: the SMTP login check passed again; email codes are back on")
	} else if boot {
		log.Println("mail: SMTP login check passed")
	}
}

func (o *Outbox) markUnhealthy(err error) {
	if !o.unhealthy.Swap(true) {
		log.Printf("CRITICAL: mail: cannot reach or log in to the mail server (%s); email codes answer 503 "+
			"until a re-check every %s succeeds", redactAddresses(err.Error()), o.recheck)
	}
}

func (o *Outbox) worker(ctx context.Context) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		o.drain(ctx)
		select {
		case <-ctx.Done():
			return
		case <-o.nudge:
		case <-tick.C:
		}
	}
}

// drain sends due rows until none is left (at most 20 per wake-up, so one
// worker cannot starve shutdown).
func (o *Outbox) drain(ctx context.Context) {
	// Mail that can no longer be sent must not keep a code in the database.
	if _, err := o.pool.Exec(ctx, `
		UPDATE email_outbox SET text_body = NULL, html_body = NULL
		WHERE sent_at IS NULL AND not_after <= NOW() AND text_body IS NOT NULL
	`); err != nil && ctx.Err() == nil {
		log.Printf("mail: clearing expired outbox bodies failed: %v", err)
	}
	for i := 0; i < 20 && ctx.Err() == nil && o.Enabled(); i++ {
		var id int64
		var attempt int
		var m Message
		var text, html *string
		err := o.pool.QueryRow(ctx, `
			UPDATE email_outbox
			SET attempts = attempts + 1, next_attempt_at = NOW() + make_interval(secs => $1)
			WHERE id = (
				SELECT id FROM email_outbox
				WHERE sent_at IS NULL AND next_attempt_at <= NOW() AND not_after > NOW()
				  AND text_body IS NOT NULL
				ORDER BY id
				LIMIT 1
				FOR UPDATE SKIP LOCKED
			)
			RETURNING id, attempts, to_addr, subject, text_body, html_body
		`, claimLease.Seconds()).Scan(&id, &attempt, &m.To, &m.Subject, &text, &html)
		if errors.Is(err, pgx.ErrNoRows) {
			return
		}
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("mail: claiming an outbox row failed: %v", err)
			}
			return
		}
		if text != nil {
			m.Text = *text
		}
		if html != nil {
			m.HTML = *html
		}
		sendErr := o.sender.Send(ctx, m)
		o.record(ctx, id, attempt, sendErr)
	}
}

// record writes the outcome of one delivery. It runs on a context that
// shutdown does not cancel, bounded by bookkeepingTimeout.
func (o *Outbox) record(ctx context.Context, id int64, attempt int, sendErr error) {
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), bookkeepingTimeout)
	defer cancel()
	if sendErr == nil {
		if _, err := o.pool.Exec(bctx, `
			UPDATE email_outbox SET sent_at = NOW(), text_body = NULL, html_body = NULL, last_error = NULL
			WHERE id = $1
		`, id); err != nil {
			log.Printf("mail: marking outbox row %d sent: %v", id, err)
		}
		return
	}
	// Provider errors can quote the recipient; never log or store it.
	reason := redactAddresses(sendErr.Error())
	if len(reason) > 300 {
		reason = reason[:300]
	}
	log.Printf("mail: outbox row %d attempt %d failed: %s", id, attempt, reason)
	if _, err := o.pool.Exec(bctx, `
		UPDATE email_outbox
		SET last_error = $2,
		    next_attempt_at = NOW() + make_interval(secs => LEAST(300, 5 * power(2, attempts - 1)))
		WHERE id = $1 AND sent_at IS NULL
	`, id, reason); err != nil {
		log.Printf("mail: recording outbox failure %d: %v", id, err)
	}
	if IsConnectError(sendErr) && ctx.Err() == nil {
		o.markUnhealthy(sendErr)
	}
}

var addressPattern = regexp.MustCompile(`[^\s<>"'(),;:]+@[^\s<>"'(),;:]+`)

func redactAddresses(s string) string {
	return addressPattern.ReplaceAllString(s, "<address>")
}
