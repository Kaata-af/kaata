package tabs

import (
	"errors"
	"html/template"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/matee/kaata-backend/internal/httpx"
)

// Store listings for the page's "Get the app" button. Stable brand URLs
// (app ids never change across releases) — the same values as
// apps/web/src/env.ts, hard-coded here because the Go page cannot import
// the web bundle's config.
const (
	playStoreURL = "https://play.google.com/store/apps/details?id=af.kaata.app"
	appStoreURL  = "https://apps.apple.com/us/app/kaata/id6789651127"
)

// viewData feeds viewHTML. Everything the inline script needs to talk to
// the API is here (Token, TabID, You, APIBase); everything else is the
// server-painted first frame and the OG card.
type viewData struct {
	Token      string
	TabID      string
	You        string // the link holder's role
	Lang       string // "fa" | "en" — the shell's initial language
	RTL        bool
	Origin     string // canonical site origin for chrome links (kaata.af)
	ShareURL   string // this page's own canonical URL (for og:url)
	APIBase    string // absolute API origin for the inline fetch; "" → relative
	OGTitle    string
	OGDesc     string
	Currency   string
	MyLabel    string
	OtherLabel string
	// AbsBalance is |balance| from the link holder's view, grouped and in
	// the shell language's digits; Direction colours it (owe|credit|settled).
	AbsBalance  string
	Direction   string
	PlayURL     string
	AppStoreURL string
}

// viewTmpl / notFoundTmpl are html/template ON PURPOSE: {{.Token}},
// {{.TabID}} and friends sit inside <script>, and only html/template's
// contextual escaping JSON-quotes them. text/template would emit them bare
// (CLAUDE.md).
var viewTmpl = template.Must(template.New("tab").Parse(viewHTML))
var notFoundTmpl = template.Must(template.New("tabnf").Parse(notFoundHTML))

// View — GET /t/{token} (PUBLIC, HTML). The link holder's party is resolved
// from the token in the path; the shell is painted from THEIR view (OG
// balance sentence, hero, labels), then the inline script takes over with
// `Authorization: Tab <token>`. Unknown / rotated tokens get the uniform
// 404 page in the viewer's language. Never cached: a living tab behind a
// five-minute public cache would show one party's stale view to the other.
func (h *Handler) View(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Vary", "Accept-Language")
	rtl := acceptsPersian(r.Header.Get("Accept-Language"))
	token := chi.URLParam(r, "token")

	p, err := h.svc.PartyByToken(r.Context(), token, "")
	if errors.Is(err, ErrNotFound) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_ = notFoundTmpl.Execute(w, viewData{Origin: h.webBaseURL, RTL: rtl})
		return
	}
	if err != nil {
		log.Printf("tabs: view party lookup failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not load tab")
		return
	}
	h.svc.touchParty(r.Context(), p, nil)

	tab, err := loadTab(r.Context(), h.svc.pool, p.TabID, p.Role)
	if err != nil {
		log.Printf("tabs: view load failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not load tab")
		return
	}

	lang := "en"
	if rtl {
		lang = "fa"
	}
	myLabel := tab.Parties[p.Role].Label
	otherLabel := tab.Parties[p.Other()].Label
	balanceMinor, _ := parseSignedMinor(tab.Balance[p.Role])
	dir := "settled"
	switch {
	case balanceMinor < 0:
		dir = "owe"
	case balanceMinor > 0:
		dir = "credit"
	}

	data := viewData{
		Token:       token,
		TabID:       p.TabID,
		You:         p.Role,
		Lang:        lang,
		RTL:         rtl,
		Origin:      h.webBaseURL,
		ShareURL:    h.shareBaseURL + "/t/" + token,
		APIBase:     h.apiBaseURL,
		OGTitle:     ogTitle(myLabel, otherLabel, rtl),
		OGDesc:      ogDesc(balanceMinor, tab.Currency, otherLabel, rtl),
		Currency:    tab.Currency,
		MyLabel:     myLabel,
		OtherLabel:  otherLabel,
		AbsBalance:  displayAmount(balanceMinor, rtl),
		Direction:   dir,
		PlayURL:     playStoreURL,
		AppStoreURL: appStoreURL,
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := viewTmpl.Execute(w, data); err != nil {
		log.Printf("tabs: view render failed: %v", err)
	}
}

// parseSignedMinor reads a wire balance ("-1250", "0.25") back into integer
// hundredths — the inverse of formatMinor, sign allowed.
func parseSignedMinor(s string) (int64, error) {
	neg := strings.HasPrefix(s, "-")
	minor, err := parseAmountMinor(strings.TrimPrefix(s, "-"))
	if err != nil {
		// parseAmountMinor rejects "0" (a tally must be positive); a zero
		// BALANCE is legitimate.
		if strings.TrimPrefix(s, "-") == "0" {
			return 0, nil
		}
		return 0, err
	}
	if neg {
		minor = -minor
	}
	return minor, nil
}

// ogTitle is "<other> ⇄ <you>" once both sides have a name, else the
// generic card — the link is often opened before B has joined.
func ogTitle(myLabel, otherLabel string, rtl bool) string {
	if myLabel == "" || otherLabel == "" {
		if rtl {
			return "حساب مشترک کاتا"
		}
		return "Kaata tab"
	}
	return otherLabel + " ⇄ " + myLabel
}

// ogDesc is the WhatsApp card line from the LINK HOLDER's view. Unlike the
// bill, a tab is alive, so the card must say so rather than assert the
// number as a permanent balance — WhatsApp caches the card per URL and the
// figure will lag the page.
func ogDesc(balanceMinor int64, currency, otherLabel string, rtl bool) string {
	amt := displayAmount(balanceMinor, rtl) + " " + currency
	var body string
	if rtl {
		switch {
		case balanceMinor < 0:
			body = "شما " + amt + " قرضدار هستید"
		case balanceMinor > 0 && otherLabel != "":
			body = otherLabel + " " + amt + " به شما قرضدار است"
		case balanceMinor > 0:
			body = amt + " به نفع شما"
		default:
			body = "تصفیه شده"
		}
		return body + " — حساب زندهٔ کاتا، با هر معامله تازه می‌شود"
	}
	switch {
	case balanceMinor < 0:
		body = "You owe " + amt
	case balanceMinor > 0 && otherLabel != "":
		body = otherLabel + " owes you " + amt
	case balanceMinor > 0:
		body = "You are owed " + amt
	default:
		body = "Settled"
	}
	return body + " — Live tab on Kaata — updates as tallies are added"
}

// displayAmount renders |minor| for humans: thousands grouping, no trailing
// zeros, Persian digits + Arabic separators for the Dari shell so the
// server-painted hero matches the script's fmtMinor byte for byte.
func displayAmount(minor int64, rtl bool) string {
	if minor < 0 {
		minor = -minor
	}
	whole, frac, _ := strings.Cut(formatMinor(minor), ".")
	out := groupThousands(whole)
	if frac != "" {
		out += "." + frac
	}
	if rtl {
		out = localizeNum(out)
	}
	return out
}

// acceptsPersian reports whether the request's highest-priority
// Accept-Language tag is Persian (fa), Dari (prs) or Pashto (ps). Copied from
// internal/shared (unexported there); picks the shell's initial language,
// which the page's toggle can override.
func acceptsPersian(header string) bool {
	first, _, _ := strings.Cut(header, ",")
	tag := strings.ToLower(strings.TrimSpace(first))
	return strings.HasPrefix(tag, "fa") || strings.HasPrefix(tag, "prs") || strings.HasPrefix(tag, "ps")
}

// localizeNum rewrites ASCII digits + separators to their Dari (fa-AF)
// equivalents — Persian digits (U+06F0..U+06F9), the Arabic thousands
// separator (U+066C) and decimal separator (U+066B). Copied from
// internal/shared/templates.go so the server-painted hero matches the inline
// script's output exactly.
func localizeNum(s string) string {
	var b strings.Builder
	b.Grow(len(s) * 2)
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune('۰' + (r - '0'))
		case r == ',':
			b.WriteRune('٬')
		case r == '.':
			b.WriteRune('٫')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// groupThousands inserts commas into a run of ASCII digits (copied from
// internal/shared/templates.go).
func groupThousands(s string) string {
	n := len(s)
	if n <= 3 {
		return s
	}
	out := make([]byte, 0, n+n/3)
	pre := n % 3
	if pre > 0 {
		out = append(out, s[:pre]...)
		if n > pre {
			out = append(out, ',')
		}
	}
	for i := pre; i < n; i += 3 {
		out = append(out, s[i:i+3]...)
		if i+3 < n {
			out = append(out, ',')
		}
	}
	return string(out)
}
