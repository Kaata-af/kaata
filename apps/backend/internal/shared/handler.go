package shared

import (
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/matee/kaata-backend/internal/httpx"
)

// maxPayload caps a shared snapshot. A per-person ledger with up to ~100
// entries is well under this; bigger means abuse or a bug.
const maxPayload = 128 << 10 // 128 KiB

type Handler struct {
	svc        *Service
	webBaseURL string // canonical site origin, e.g. https://kaata.af (for OG url)
}

func NewHandler(svc *Service, webBaseURL string) *Handler {
	return &Handler{svc: svc, webBaseURL: strings.TrimRight(webBaseURL, "/")}
}

// sharePayload is the snapshot shape the mobile app sends and the SSR shell
// reads. Only the summary fields are used server-side (for the OG preview); the
// full `entries` list is rendered by the web client from GET /v1/shared/<token>.
type sharePayload struct {
	V        int     `json:"v"`
	Shop     string  `json:"shop"`
	Person   string  `json:"person"`
	Currency string  `json:"currency"`
	Balance  float64 `json:"balance"`
	Locale   string  `json:"locale"`
	Entries  []struct {
		Type   string  `json:"type"`
		Amount float64 `json:"amount"`
		Note   *string `json:"note"`
		Date   int64   `json:"date"`
	} `json:"entries"`
	GeneratedAt int64 `json:"generated_at"`
}

// Create — POST /v1/shared (PUBLIC, rate-limited). Body: the snapshot JSON.
// Response: { token }. The link is kaata.af/v/<token>.
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
	if strings.TrimSpace(p.Person) == "" {
		httpx.Error(w, http.StatusBadRequest, "person is required")
		return
	}
	if len(p.Entries) > 500 {
		httpx.Error(w, http.StatusBadRequest, "too many entries")
		return
	}
	token, err := h.svc.Create(r.Context(), raw)
	if err != nil {
		log.Printf("shared: create failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not create share")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{
		"token": token,
		"url":   h.webBaseURL + "/v/" + token,
	})
}

// Get — GET /v1/shared/{token} (PUBLIC). Returns the stored snapshot JSON for
// the web client to render. 404 when unknown/expired.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	payload, err := h.svc.Get(r.Context(), token)
	if errors.Is(err, ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "share not found or expired")
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
		w.WriteHeader(http.StatusNotFound)
		_ = notFoundTmpl.Execute(w, viewData{Origin: h.webBaseURL})
		return
	}
	if err != nil {
		log.Printf("shared: view get failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "could not load share")
		return
	}
	var p sharePayload
	_ = json.Unmarshal(payload, &p) // payload was validated on create

	// Owed-direction copy from the RECEIVER's (customer's) perspective: a
	// positive balance means the customer owes the shop.
	owesShop := p.Balance > 0
	dir := "settled"
	if owesShop {
		dir = "owe"
	} else if p.Balance < 0 {
		dir = "credit"
	}
	rtl := strings.HasPrefix(p.Locale, "fa") || strings.HasPrefix(p.Locale, "ps")

	data := viewData{
		Token:      token,
		Shop:       p.Shop,
		Person:     p.Person,
		Currency:   p.Currency,
		AbsBalance: absFmt(p.Balance),
		Direction:  dir,
		RTL:        rtl,
		Origin:     h.webBaseURL,
		OGTitle:    ogTitle(p),
		OGDesc:     ogDesc(p, dir),
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	if err := viewTmpl.Execute(w, data); err != nil {
		log.Printf("shared: view render failed: %v", err)
	}
}

type viewData struct {
	Token      string
	Shop       string
	Person     string
	Currency   string
	AbsBalance string
	Direction  string // owe | credit | settled
	RTL        bool
	Origin     string
	OGTitle    string
	OGDesc     string
}

func ogTitle(p sharePayload) string {
	if p.Shop != "" {
		return p.Person + " — " + p.Shop
	}
	return p.Person + " — Kaata"
}

func ogDesc(p sharePayload, dir string) string {
	amt := absFmt(p.Balance) + " " + p.Currency
	switch dir {
	case "owe":
		return "Balance to settle: " + amt
	case "credit":
		return "In your favour: " + amt
	default:
		return "All settled — nothing owed."
	}
}

// viewTmpl is intentionally tiny + self-contained (inline CSS, one small inline
// script). It is the "server-rendered small packet"; the script fetches the full
// snapshot and renders the entry list on the client.
var viewTmpl = template.Must(template.New("view").Parse(viewHTML))
var notFoundTmpl = template.Must(template.New("nf").Parse(notFoundHTML))
