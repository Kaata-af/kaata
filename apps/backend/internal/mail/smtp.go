package mail

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// smtpTimeout bounds one whole delivery: dial, TLS, auth and DATA.
const smtpTimeout = 15 * time.Second

type smtpSender struct {
	host     string
	port     string
	username string
	password string
	from     *mail.Address
}

// connectError marks a failure to reach or log in to the mail server, as
// opposed to the refusal of one message: the outbox then turns mail off until
// a login check passes again.
type connectError struct{ err error }

func (e *connectError) Error() string { return e.err.Error() }
func (e *connectError) Unwrap() error { return e.err }

// IsConnectError reports a failure to reach or log in to the mail server.
func IsConnectError(err error) bool {
	var ce *connectError
	return errors.As(err, &ce)
}

// unset treats a value still holding a "<placeholder>" from an env template as
// empty, so pasting the template before the real key exists leaves mail off.
func unset(v string) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, "<") && strings.HasSuffix(v, ">") {
		return ""
	}
	return v
}

// newSMTPSender validates the SMTP_* settings. It reports every problem at
// once, never the values themselves (the password must not reach a log).
func newSMTPSender(cfg Config) (*smtpSender, []string) {
	var problems []string
	host := unset(cfg.SMTPHost)
	if host == "" {
		problems = append(problems, "SMTP_HOST is empty")
	}
	port := strings.TrimSpace(cfg.SMTPPort)
	if port == "" {
		port = "587"
	}
	if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
		problems = append(problems, "SMTP_PORT is not a port number")
	}
	username := unset(cfg.SMTPUsername)
	if username == "" || unset(cfg.SMTPPassword) == "" {
		problems = append(problems, "SMTP_USERNAME or SMTP_PASSWORD is empty")
	}
	from, err := parseFrom(cfg.From)
	if err != nil {
		problems = append(problems, "MAIL_FROM is not a valid address")
	}
	if len(problems) > 0 {
		return nil, problems
	}
	return &smtpSender{host: host, port: port, username: username, password: cfg.SMTPPassword, from: from}, nil
}

// tlsMode: port 465 is implicit TLS; every other port must offer STARTTLS.
func (s *smtpSender) tlsMode() string {
	if s.port == "465" {
		return "implicit TLS"
	}
	return "STARTTLS"
}

// Check logs in and quits without sending anything, so a wrong host or key
// shows at boot instead of as codes that never arrive.
func (s *smtpSender) Check(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, smtpTimeout)
	defer cancel()
	c, err := s.dial(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = c.Close() }()
	return c.Quit()
}

// Send implements Sender. It never falls back to plaintext: a server without
// STARTTLS is an error, so the credentials and codes only travel encrypted.
func (s *smtpSender) Send(ctx context.Context, m Message) error {
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return errors.New("invalid recipient address")
	}
	body, err := buildMessage(s.from, to, m, time.Now())
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, smtpTimeout)
	defer cancel()
	c, err := s.dial(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = c.Close() }()
	if err := c.Mail(s.from.Address); err != nil {
		return fmt.Errorf("smtp MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to.Address); err != nil {
		return fmt.Errorf("smtp RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		_ = w.Close()
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp end of data: %w", err)
	}
	return c.Quit()
}

// dial connects, upgrades to TLS and authenticates. Every failure here is a
// connectError.
func (s *smtpSender) dial(ctx context.Context) (*smtp.Client, error) {
	c, err := s.connect(ctx)
	if err != nil {
		return nil, &connectError{err}
	}
	return c, nil
}

func (s *smtpSender) connect(ctx context.Context) (*smtp.Client, error) {
	var err error
	tlsConfig := &tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12}
	addr := net.JoinHostPort(s.host, s.port)
	dialer := &net.Dialer{Timeout: smtpTimeout}
	var conn net.Conn
	if s.port == "465" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: tlsConfig}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, fmt.Errorf("smtp dial: %w", err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	c, err := smtp.NewClient(conn, s.host)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("smtp greeting: %w", err)
	}
	if s.port != "465" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			_ = c.Close()
			return nil, errors.New("smtp server does not offer STARTTLS")
		}
		if err := c.StartTLS(tlsConfig); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if err := c.Auth(smtp.PlainAuth("", s.username, s.password, s.host)); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("smtp auth: %w", err)
	}
	return c, nil
}

// buildMessage renders a multipart/alternative message. Headers come from
// net/mail and mime encoders, never from concatenating raw input, and both
// parts are base64 so Dari text survives any relay.
func buildMessage(from, to *mail.Address, m Message, now time.Time) ([]byte, error) {
	boundary, err := randomHex(12)
	if err != nil {
		return nil, err
	}
	idPart, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	domain := "kaata.af"
	if at := strings.LastIndexByte(from.Address, '@'); at >= 0 {
		domain = from.Address[at+1:]
	}

	var b bytes.Buffer
	header := func(k, v string) { b.WriteString(k + ": " + v + "\r\n") }
	header("From", from.String())
	header("To", to.String())
	header("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	header("Date", now.Format(time.RFC1123Z))
	header("Message-ID", "<"+idPart+"@"+domain+">")
	header("MIME-Version", "1.0")
	header("Auto-Submitted", "auto-generated")
	header("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")
	part := func(contentType, content string) {
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: " + contentType + "; charset=utf-8\r\n")
		b.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		enc := base64.StdEncoding.EncodeToString([]byte(content))
		for len(enc) > 76 {
			b.WriteString(enc[:76] + "\r\n")
			enc = enc[76:]
		}
		b.WriteString(enc + "\r\n")
	}
	part("text/plain", m.Text)
	if m.HTML != "" {
		part("text/html", m.HTML)
	}
	b.WriteString("--" + boundary + "--\r\n")
	return b.Bytes(), nil
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
