package tabs

import (
	"errors"
	"html/template"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/locale"
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
	RecordingMode string
	Token         string
	Lang          string
	RTL           bool
	Origin        string
	PlayURL       string
	AppStoreURL   string
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
	lang := locale.FromAcceptLanguage(r.Header.Get("Accept-Language"))
	rtl := locale.RTL(lang)
	token := chi.URLParam(r, "token")

	if strings.HasPrefix(token, "g_") {
		raw, err := groupToken(token)
		var mode string
		var closed *time.Time
		if err == nil {
			err = h.svc.pool.QueryRow(r.Context(), `SELECT recording_mode,closed_at FROM tab_groups WHERE invite_token_hash=$1`, hashPartyToken(raw)).Scan(&mode, &closed)
		}
		if errors.Is(err, ErrNotFound) || errors.Is(err, pgx.ErrNoRows) || closed != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			_ = notFoundTmpl.Execute(w, viewData{Origin: h.webBaseURL, Lang: lang, RTL: rtl})
			return
		}
		if err != nil {
			log.Printf("tabs: group invitation lookup failed: %v", err)
			httpx.Error(w, http.StatusInternalServerError, "could not load tab")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err = viewTmpl.Execute(w, viewData{RecordingMode: mode, Token: token, Lang: lang, RTL: rtl, Origin: h.webBaseURL, PlayURL: playStoreURL, AppStoreURL: appStoreURL}); err != nil {
			log.Printf("tabs: group invitation render failed: %v", err)
		}
		return
	}

	party, err := h.svc.PartyByToken(r.Context(), token, "")
	if errors.Is(err, ErrNotFound) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_ = notFoundTmpl.Execute(w, viewData{Origin: h.webBaseURL, Lang: lang, RTL: rtl})
		return
	}
	if err != nil {
		log.Printf("tabs: view party lookup failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not load tab")
		return
	}
	data := viewData{Token: token, Lang: lang, RTL: rtl, Origin: h.webBaseURL,
		PlayURL: playStoreURL, AppStoreURL: appStoreURL}
	if err := h.svc.pool.QueryRow(r.Context(), `SELECT recording_mode FROM tabs WHERE id=$1::uuid`, party.TabID).Scan(&data.RecordingMode); err != nil {
		log.Printf("tabs: view recording mode lookup failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not load tab")
		return
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

// Language supports legacy callers that only set RTL. New responses always set Lang.
func (v viewData) Language() string {
	if v.Lang != "" {
		return locale.Normalize(v.Lang)
	}
	if v.RTL {
		return "fa"
	}
	return "en"
}
