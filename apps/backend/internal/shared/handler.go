package shared

import (
	"context"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/locale"
)

// Complete bills are bounded, never truncated into a misleading partial bill.
const maxPayload = 4 << 20 // 4 MiB
const maxSharedEntries = 5000
const maxSharedCurrencies = 256

type snapshotStore interface {
	Create(context.Context, []byte) (string, error)
	Get(context.Context, string) ([]byte, error)
}

type Handler struct {
	svc          snapshotStore
	webBaseURL   string // canonical site origin, e.g. https://kaata.af (chrome links)
	shareBaseURL string // origin the share link + og:url resolve to (defaults to webBaseURL)
	apiBaseURL   string // backend's own public origin, e.g. https://api.kaata.af; "" → relative fetch
}

func NewHandler(svc snapshotStore, webBaseURL, shareLinkBaseURL, apiBaseURL string) *Handler {
	web := strings.TrimRight(webBaseURL, "/")
	share := strings.TrimRight(shareLinkBaseURL, "/")
	if share == "" {
		share = web
	}
	return &Handler{
		svc:          svc,
		webBaseURL:   web,
		shareBaseURL: share,
		apiBaseURL:   strings.TrimRight(apiBaseURL, "/"),
	}
}

// Capabilities keeps versioned bills away from renderers that would omit data.
func (h *Handler) Capabilities(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=300")
	httpx.JSON(w, http.StatusOK, map[string]any{"bill_versions": []int{1, 2, 3}, "multi_currency": true})
}

// sharePayload is the snapshot shape the mobile app sends and the SSR shell
// reads. Only the summary fields are used server-side (for the OG preview); the
// full `entries` list is rendered by the web client from GET /v1/shared/<token>.
type sharePayload struct {
	V            int     `json:"v"`
	Shop         string  `json:"shop"`
	Person       string  `json:"person"`
	Currency     string  `json:"currency"`
	CurrencyCode string  `json:"currency_code"`
	Balance      float64 `json:"balance"`
	Locale       string  `json:"locale"`
	// Calendar the shopkeeper had selected when this bill was cut:
	// "gregorian" | "jalali" | "qamari". FROZEN at issue time under the paper rule — a
	// bill is the recipient's permanent asset and must not change shape when
	// the shopkeeper later flips their setting. Absent on every snapshot
	// predating the calendar setting; resolveCalendar falls back to deriving
	// it from Locale, which is exactly the old behaviour.
	Calendar string `json:"calendar"`
	// The shopkeeper's Qamari adjustment in days, frozen like Calendar (audit
	// #15): the tabular Qamari date can sit a day or two off the local moon
	// sighting. Absent on other calendars and on older bills; see
	// resolveQamariOffset.
	QamariOffset *float64              `json:"qamari_offset"`
	Entries      []shareEntry          `json:"entries"`
	Currencies   []shareCurrencyLedger `json:"currencies"`
	GeneratedAt  int64                 `json:"generated_at"`
}

// resolveCalendar resolves the frozen bill's calendar.
//
// An explicit snapshot value always wins — that is the shopkeeper's frozen
// choice. Only when the field is absent (a snapshot cut before the calendar
// setting existed, or by an older client) do we fall back to the old rule,
// where the calendar was a side effect of the message language. Any unknown
// string is treated as absent rather than trusted.
func resolveCalendar(calendar string, rtl bool) string {
	switch calendar {
	case "jalali", "gregorian", "qamari":
		return calendar
	default:
		if rtl {
			return "jalali"
		}
		return "gregorian"
	}
}

// resolveQamariOffset narrows the frozen adjustment: whole days within ±2,
// else none. The snapshot is untrusted JSON, so anything else is ignored
// rather than trusted, exactly as resolveCalendar treats an unknown calendar.
func resolveQamariOffset(raw *float64) int {
	if raw == nil || *raw != float64(int(*raw)) || *raw < -2 || *raw > 2 {
		return 0
	}
	return int(*raw)
}

// Create — POST /v1/shared (PUBLIC, rate-limited). Body: the snapshot JSON.
// Response: { token, url }. `url` is the field the mobile fleet actually
// reads — clients silently drop the link from the WhatsApp message when it's
// missing/empty; `token` is informational.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPayload)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "body too large or unreadable")
		return
	}
	// Validate it's well-formed JSON with the minimum we need to render.
	var p sharePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := validateSharePayload(p); err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	token, err := h.svc.Create(r.Context(), raw)
	if err != nil {
		log.Printf("shared: create failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not create share")
		return
	}
	// PAPER RULE: no revoke_secret in the response. Bills are permanent —
	// see the package comment. (1.0.5-and-earlier clients look for the field
	// to register a revocable link; its absence simply skips that write.)
	response := map[string]any{
		"token": token,
		"url":   h.shareBaseURL + "/v/" + token,
	}
	if p.V == 2 || p.V == 3 {
		response["bill_version"] = p.V
		path := "/v2/"
		if p.V == 3 {
			path = "/v3/"
		}
		response["url"] = h.shareBaseURL + path + token
	}
	httpx.JSON(w, http.StatusOK, response)
}

// Get — GET /v1/shared/{token} (PUBLIC). Returns the stored snapshot JSON for
// the web client to render. 404 when unknown.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	payload, err := h.svc.Get(r.Context(), token)
	if errors.Is(err, ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "share not found")
		return
	}
	if err != nil {
		log.Printf("shared: get failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not load share")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// Public share — cacheable for a short window (the snapshot is immutable).
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(payload)
}

// View — GET /v/{token} (PUBLIC, HTML). The lightweight SSR "small packet":
// renders OG/Twitter preview meta + an instant summary server-side, then hands
// off to the web client (which fetches GET /v1/shared/{token} and renders the
// full entry list). Keeps the server cheap — no per-request ledger compute
// beyond reading the stored snapshot.
func (h *Handler) View(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	payload, err := h.svc.Get(r.Context(), token)
	if errors.Is(err, ErrNotFound) {
		// Unknown link — no snapshot to carry the shopkeeper's message
		// language, so fall back to the customer's browser language (the same
		// choice the web client's error state makes).
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Vary", "Accept-Language")
		w.WriteHeader(http.StatusNotFound)
		lang := locale.FromAcceptLanguage(r.Header.Get("Accept-Language"))
		_ = notFoundTmpl.Execute(w, viewData{Origin: h.webBaseURL, Lang: lang, RTL: locale.RTL(lang)})
		return
	}
	if err != nil {
		log.Printf("shared: view get failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not load share")
		return
	}
	var p sharePayload
	_ = json.Unmarshal(payload, &p) // payload was validated on create
	if p.V == 2 || p.V == 3 {
		if err := validateSharePayload(p); err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid bill")
			return
		}
	}

	// Owed-direction copy from the RECEIVER's (customer's) perspective: a
	// positive balance means the customer owes the shop.
	owesShop := p.Balance > 0
	dir := "settled"
	if owesShop {
		dir = "owe"
	} else if p.Balance < 0 {
		dir = "credit"
	}
	lang := locale.Normalize(p.Locale)
	rtl := locale.RTL(lang)
	calendar := resolveCalendar(p.Calendar, rtl)
	qamariOffset := resolveQamariOffset(p.QamariOffset)

	// Format the balance once, in the snapshot's locale, so the instant
	// server-painted hero matches the JS-rendered (fa-AF) row amounts.
	absBal := absFmt(p.Balance)
	if rtl {
		absBal = localizeNum(absBal)
	}
	currency := billCurrencyLabel(p.CurrencyCode, p.Currency)

	data := viewData{
		Token:        token,
		Shop:         p.Shop,
		Person:       p.Person,
		Currency:     currency,
		AbsBalance:   absBal,
		Direction:    dir,
		Lang:         lang,
		RTL:          rtl,
		Calendar:     calendar,
		QamariOffset: qamariOffset,
		Origin:       h.webBaseURL,
		ShareURL:     h.shareBaseURL + "/v/" + token,
		APIBase:      h.apiBaseURL,
		OGTitle:      ogTitle(p),
		OGDesc:       ogDescForLanguage(absBal, currency, dir, lang, billDateForLanguage(p.GeneratedAt, lang, calendar, qamariOffset)),
		// Bills are permanent (paper rule), so the issue date is load-bearing:
		// a two-year-old link must read as "bill dated X", never as the
		// current balance. Formatted by the inline script's fmtDate (Afghan
		// Solar Hijri for fa) at first paint; 0 (pre-date snapshots) hides it.
		GeneratedAtMs: p.GeneratedAt,
	}
	if p.V == 2 || p.V == 3 {
		path := "/v2/"
		if p.V == 3 {
			path = "/v3/"
		}
		data.ShareURL = h.shareBaseURL + path + token
		data.Currencies = currencyPreviews(p, lang)
		data.Direction = "multi"
		parts := make([]string, 0, len(data.Currencies))
		for i, currency := range data.Currencies {
			date := ""
			if i == 0 {
				date = billDateForLanguage(p.GeneratedAt, lang, calendar, qamariOffset)
			}
			description := ogDescForLanguage(currency.AbsBalance, currency.Currency, currency.Direction, lang, date)
			if currency.Direction == "settled" {
				description += " (" + currency.Currency + ")"
			}
			parts = append(parts, description)
		}
		data.OGDesc = strings.Join(parts, "; ")
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	if err := viewTmpl.Execute(w, data); err != nil {
		log.Printf("shared: view render failed: %v", err)
	}
}

type viewData struct {
	Token         string
	Shop          string
	Person        string
	Currency      string
	AbsBalance    string
	Direction     string // owe | credit | settled
	Lang          string
	RTL           bool
	Calendar      string // resolved frozen calendar (see sharePayload.Calendar)
	QamariOffset  int    // frozen Qamari adjustment in days (resolveQamariOffset)
	Origin        string // canonical site origin for chrome links (kaata.af)
	ShareURL      string // this page's own canonical URL (for og:url)
	APIBase       string // absolute API origin for the inline fetch; "" → relative
	OGTitle       string
	OGDesc        string
	GeneratedAtMs int64 // bill issue date (epoch ms); 0 hides the date line
	Currencies    []currencyPreview
}

func ogTitle(p sharePayload) string {
	if p.Shop != "" {
		return p.Person + " — " + p.Shop
	}
	return p.Person + " — Kaata"
}

// ogDesc is the WhatsApp/social preview line — per-person and to-the-point so the
// link card itself carries the balance. Phrased
// from the RECEIVER's (customer's) view and localized to the shopkeeper's language.
// absBal is the already-locale-formatted balance string (Persian digits for fa).
//
// PAPER RULE: bills are permanent, and the link card is read by people who
// never tap through — so the card itself must date the bill ("Bill dated X — …"),
// never assert the amount as a current balance. dateStr comes from billDate();
// "" (pre-date snapshots) falls back to the undated phrasing.
func ogDesc(absBal, currency, dir string, rtl bool, dateStr string) string {
	lang := "en"
	if rtl {
		lang = "fa"
	}
	return ogDescForLanguage(absBal, currency, dir, lang, dateStr)
}

func ogDescForLanguage(absBal, currency, dir, lang, dateStr string) string {
	rtl := locale.RTL(lang)
	amt := absBal + " " + currency
	var body string
	if lang == "ps" {
		switch dir {
		case "owe":
			body = "د تصفیې پاتې حساب: " + amt
		case "credit":
			body = "ستاسو په ګټه: " + amt
		default:
			body = "حساب تصفیه دی — څه پاتې نه دي."
		}
		if dateStr != "" {
			return "د " + dateStr + " نېټې بل — " + body
		}
		return body
	}
	if rtl {
		switch dir {
		case "owe":
			body = "مانده برای تصفیه: " + amt
		case "credit":
			body = "به نفع شما: " + amt
		default:
			body = "حساب صاف است — چیزی باقی نمانده."
		}
		if dateStr != "" {
			return "بل مورخ " + dateStr + " — " + body
		}
		return body
	}
	switch dir {
	case "owe":
		body = "Balance to settle: " + amt
	case "credit":
		body = "In your favour: " + amt
	default:
		body = "All settled — nothing owed."
	}
	if dateStr != "" {
		return "Bill dated " + dateStr + " — " + body
	}
	return body
}

// viewTmpl is intentionally tiny + self-contained (inline CSS, one small inline
// script). It is the "server-rendered small packet"; the script fetches the full
// snapshot and renders the entry list on the client.
var viewTmpl = template.Must(template.New("view").Parse(viewHTML))
var notFoundTmpl = template.Must(template.New("nf").Parse(notFoundHTML))

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

// OGImageURL uses the configured public site, never the requesting bill host.
// An unset or invalid origin must not produce a relative or unsafe image URL.
func (v viewData) OGImageURL() string {
	origin := strings.TrimRight(strings.TrimSpace(v.Origin), "/")
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" ||
		u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(origin, "#") {
		return ""
	}
	return origin + "/og/kaata-fa-v1.png"
}

func (v viewData) OGImageSecureURL() string {
	image := v.OGImageURL()
	if strings.HasPrefix(image, "https://") {
		return image
	}
	return ""
}
