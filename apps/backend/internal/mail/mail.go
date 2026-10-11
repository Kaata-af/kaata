// Package mail sends Kaata's transactional email: the sign-up, reset and
// set-password codes, and the notices that go out instead of a code or after a
// password changes (docs/kaata-accounts.md §5).
//
// Nothing is sent from a request handler. The auth service writes each message
// into email_outbox in the same transaction as the code it carries
// (Enqueue), and the Outbox workers deliver due rows through the configured
// Sender, so a redeploy or a provider outage delays mail instead of losing it.
package mail

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/mail"
	"strconv"
	"strings"
)

// Message is one outgoing email. Every field comes from our own templates and
// a validated address: no user-supplied text ever reaches a mail.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// Sender delivers one message. Implementations are safe for concurrent use.
type Sender interface {
	Send(ctx context.Context, m Message) error
}

// Driver names accepted in MAIL_DRIVER.
const (
	DriverSMTP = "smtp"
	DriverLog  = "log"
)

// Config is the MAIL_* / SMTP_* environment (internal/config).
type Config struct {
	Driver       string
	SMTPHost     string
	SMTPPort     string
	SMTPUsername string
	SMTPPassword string
	// From is MAIL_FROM, an RFC 5322 address with an optional display name,
	// e.g. "Kaata <no-reply@mail.kaata.af>".
	From string
	// Development: KAATA_ENV=development, the explicit opt-in the log driver
	// needs. Production: KAATA_ENV=production or an https PUBLIC_API_BASE_URL.
	Development bool
	Production  bool
}

// ErrLogDriverRefused stops the boot: the log driver prints every code into the
// server log, so it runs only where KAATA_ENV=development says this is a
// laptop. Fail-closed: an unset KAATA_ENV is not enough.
var ErrLogDriverRefused = errors.New(
	"MAIL_DRIVER=log prints sign-in codes into the server log and needs KAATA_ENV=development " +
		"(and no https PUBLIC_API_BASE_URL); on a server use MAIL_DRIVER=smtp")

// IsProduction reports a deployment that must never run the log driver.
func IsProduction(kaataEnv, publicAPIBaseURL string) bool {
	if strings.EqualFold(strings.TrimSpace(kaataEnv), "production") {
		return true
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(publicAPIBaseURL)), "https")
}

// IsDevelopment reports the explicit KAATA_ENV=development opt-in.
func IsDevelopment(kaataEnv string) bool {
	return strings.EqualFold(strings.TrimSpace(kaataEnv), "development")
}

// Selection is the outcome of Select: the active sender (nil = mail is
// disabled) and one line for the boot log. Describe never names credentials.
type Selection struct {
	Sender   Sender
	Describe string
}

// Select picks the mail driver. The choice is explicit: MAIL_DRIVER=smtp with
// the SMTP_* settings and MAIL_FROM, or MAIL_DRIVER=log on a development
// machine (KAATA_ENV=development).
// Anything else disables mail: the code endpoints then answer 503
// email_unavailable while password sign-in keeps working.
//
// The only error is the log driver outside development, which must stop the
// boot.
// An smtp choice with missing or malformed settings disables mail with a loud
// boot line instead, because a mail typo must not take sign-in, sync and every
// other route down with it.
func Select(cfg Config) (Selection, error) {
	driver := strings.ToLower(strings.TrimSpace(cfg.Driver))
	switch driver {
	case DriverLog:
		if cfg.Production || !cfg.Development {
			return Selection{}, ErrLogDriverRefused
		}
		return Selection{
			Sender:   LogSender{},
			Describe: "mail driver: log (prints every message, codes included, into this log; local testing only)",
		}, nil
	case DriverSMTP:
		s, problems := newSMTPSender(cfg)
		if len(problems) > 0 {
			return Selection{Describe: "CRITICAL: mail disabled: MAIL_DRIVER=smtp but " +
				strings.Join(problems, ", ") +
				"; email sign-up, reset and set-password codes answer 503 until this is fixed"}, nil
		}
		return Selection{
			Sender: s,
			Describe: fmt.Sprintf("mail driver: smtp via %s:%s (%s), from %s",
				s.host, s.port, s.tlsMode(), s.from.Address),
		}, nil
	case "":
		return Selection{Describe: "mail disabled (MAIL_DRIVER unset): email sign-up, reset and " +
			"set-password codes answer 503; password sign-in still works"}, nil
	default:
		return Selection{Describe: "mail disabled: unknown MAIL_DRIVER " + strconv.Quote(driver) +
			" (want smtp or log); email codes answer 503"}, nil
	}
}

// parseFrom validates MAIL_FROM. It accepts a bare address or a display name
// plus address, and only ASCII addresses (the display name may be anything:
// it is MIME-encoded when the header is built).
func parseFrom(raw string) (*mail.Address, error) {
	a, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil {
		return nil, err
	}
	for i := 0; i < len(a.Address); i++ {
		if a.Address[i] < 0x21 || a.Address[i] > 0x7e {
			return nil, errors.New("non-ASCII address")
		}
	}
	return a, nil
}

// LogSender prints messages instead of sending them. It exists for local
// testing only and is refused at boot outside development (Select).
type LogSender struct{}

// Send implements Sender.
func (LogSender) Send(_ context.Context, m Message) error {
	log.Printf("mail[log driver] to=%s subject=%q\n%s", m.To, m.Subject, m.Text)
	return nil
}

// Check tests a sender's login without sending, when the sender supports it
// (the SMTP sender does; the log sender has nothing to check).
func Check(ctx context.Context, s Sender) error {
	if c, ok := s.(interface{ Check(context.Context) error }); ok {
		return c.Check(ctx)
	}
	return nil
}
