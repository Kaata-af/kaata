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

// No financial fields: this template is only an app invitation.
type viewData struct {
	Token       string
	RTL         bool
	Origin      string
	PlayURL     string
	AppStoreURL string
}

// viewTmpl / notFoundTmpl are html/template ON PURPOSE: {{.Token}},
// {{.TabID}} and friends sit inside <script>, and only html/template's
// contextual escaping JSON-quotes them. text/template would emit them bare
// (CLAUDE.md).
var viewTmpl = template.Must(template.New("tab").Parse(viewHTML))
var notFoundTmpl = template.Must(template.New("tabnf").Parse(notFoundHTML))

// View serves a generic app-only invitation, never a ledger or financial OG preview.
func (h *Handler) View(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Vary", "Accept-Language")
	rtl := acceptsPersian(r.Header.Get("Accept-Language"))
	token := chi.URLParam(r, "token")

	_, err := h.svc.PartyByToken(r.Context(), token, "")
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
	data := viewData{Token: token, RTL: rtl, Origin: h.webBaseURL,
		PlayURL: playStoreURL, AppStoreURL: appStoreURL}
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

// acceptsPersian reports whether the request's highest-priority
// Accept-Language tag is Persian (fa), Dari (prs) or Pashto (ps). Copied from
// internal/shared (unexported there); picks the shell's initial language,
// matching the invitation language.
func acceptsPersian(header string) bool {
	first, _, _ := strings.Cut(header, ",")
	tag := strings.ToLower(strings.TrimSpace(first))
	return strings.HasPrefix(tag, "fa") || strings.HasPrefix(tag, "prs") || strings.HasPrefix(tag, "ps")
}
