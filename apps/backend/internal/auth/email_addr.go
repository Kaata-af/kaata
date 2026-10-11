package auth

import (
	_ "embed"
	"net/mail"
	"strings"
)

// Email addresses for Kaata accounts (docs/kaata-accounts.md §4).

// Address refusal reasons, returned to the app as `reason`.
const (
	EmailBadFormat  = "format"
	EmailRelay      = "relay"
	EmailDisposable = "disposable"
)

// InvalidEmailError carries the refusal reason.
type InvalidEmailError struct{ Reason string }

func (e *InvalidEmailError) Error() string { return "invalid email: " + e.Reason }

//go:embed disposable_domains.txt
var disposableDomainsFile string

var disposableDomains = loadWordList(disposableDomainsFile)

// appleRelayDomain: Apple's private relay addresses cannot be typed by the
// user, so they are never a password sign-in address.
const appleRelayDomain = "privaterelay.appleid.com"

// foldDigits turns Persian and Arabic-Indic digits into ASCII.
func foldDigits(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 0x06F0 && r <= 0x06F9:
			return '0' + (r - 0x06F0)
		case r >= 0x0660 && r <= 0x0669:
			return '0' + (r - 0x0660)
		}
		return r
	}, s)
}

// parseAccountEmail validates a typed address and returns it trimmed (the form
// kept for display and delivery) plus its dedupe key. Only plain ASCII
// addr-specs are accepted: no display names, comments, quotes or IP literals.
func parseAccountEmail(raw string) (email, key string, err error) {
	email = foldDigits(strings.TrimSpace(raw))
	if email == "" || len(email) > 254 {
		return "", "", &InvalidEmailError{EmailBadFormat}
	}
	for i := 0; i < len(email); i++ {
		if email[i] < 0x21 || email[i] > 0x7e {
			return "", "", &InvalidEmailError{EmailBadFormat}
		}
	}
	parsed, perr := mail.ParseAddress(email)
	if perr != nil || parsed.Name != "" || parsed.Address != email {
		return "", "", &InvalidEmailError{EmailBadFormat}
	}
	at := strings.LastIndexByte(email, '@')
	local, domain := email[:at], strings.ToLower(email[at+1:])
	if local == "" || len(local) > 64 || strings.ContainsAny(local, `"\`) {
		return "", "", &InvalidEmailError{EmailBadFormat}
	}
	if !validDomain(domain) {
		return "", "", &InvalidEmailError{EmailBadFormat}
	}
	if domain == appleRelayDomain {
		return "", "", &InvalidEmailError{EmailRelay}
	}
	if _, bad := disposableDomains[domain]; bad {
		return "", "", &InvalidEmailError{EmailDisposable}
	}
	return email, emailDedupeKey(local, domain), nil
}

func validDomain(d string) bool {
	if len(d) > 253 || !strings.Contains(d, ".") || strings.ContainsAny(d, "[]:") {
		return false
	}
	for _, label := range strings.Split(d, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

// emailDedupeKey: one 'email' identity per mailbox. Lowercase, the +tag
// dropped on every domain (sub-addressing reaches the same inbox), and Gmail's
// dots ignored. The address as typed is still what we deliver to.
// normalizeEmail (service.go) stays as it is: stored rows depend on it.
func emailDedupeKey(local, domain string) string {
	local = strings.ToLower(local)
	if i := strings.IndexByte(local, '+'); i > 0 {
		local = local[:i]
	}
	domain = strings.ToLower(domain)
	if domain == "gmail.com" || domain == "googlemail.com" {
		local = strings.ReplaceAll(local, ".", "")
		domain = "gmail.com"
	}
	return local + "@" + domain
}

// isAppleRelay reports an Apple private relay address (stored account emails
// of "Hide My Email" users).
func isAppleRelay(email string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(email)), "@"+appleRelayDomain)
}
