package shared

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"html"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

const billArtworkAlt = "کاتا؛ حساب‌وکتاب شخصی، بدون انترنت، برای همیشه رایگان"

var previewMetaPattern = regexp.MustCompile(`<meta (?:property|name)="([^"]+)" content="([^"]*)">`)

func previewHead(t *testing.T, page string) (string, map[string]string) {
	t.Helper()
	_, after, ok := strings.Cut(page, "<head>")
	if !ok {
		t.Fatal("bill has no document head")
	}
	head, _, ok := strings.Cut(after, "</head>")
	if !ok {
		t.Fatal("bill has no closing document head")
	}
	meta := make(map[string]string)
	for _, match := range previewMetaPattern.FindAllStringSubmatch(head, -1) {
		if _, exists := meta[match[1]]; exists {
			t.Fatalf("duplicate preview meta %q", match[1])
		}
		meta[match[1]] = html.UnescapeString(match[2])
	}
	return head, meta
}

func requireBillArtwork(t *testing.T, meta map[string]string, image string, secure bool) {
	t.Helper()
	for name, want := range map[string]string{
		"og:image": image, "og:image:type": "image/png",
		"og:image:width": "1200", "og:image:height": "630", "og:image:alt": billArtworkAlt,
		"twitter:card": "summary_large_image", "twitter:image": image, "twitter:image:alt": billArtworkAlt,
	} {
		if meta[name] != want {
			t.Errorf("%s = %q, want %q", name, meta[name], want)
		}
	}
	if secure {
		if meta["og:image:secure_url"] != image {
			t.Errorf("secure artwork URL = %q, want %q", meta["og:image:secure_url"], image)
		}
	} else if _, exists := meta["og:image:secure_url"]; exists {
		t.Error("HTTP artwork must not advertise a secure URL")
	}
}

func TestBillOGImageHTTP(t *testing.T) {
	historyPayload, err := json.Marshal(historyBill(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, path, payload, title string
		descriptions               []string
	}{
		{
			name: "v1", path: "/v/synthetic-token",
			payload:      `{"v":1,"person":"Customer < & \"name\"","shop":"Shop < & \"name\"","locale":"en","calendar":"gregorian","currency":"AFN","balance":12.5,"generated_at":1700000000000,"entries":[]}`,
			title:        "Customer < & \"name\" — Shop < & \"name\"",
			descriptions: []string{"Bill dated 15 Nov 2023 — Balance to settle: 12.50 AFN"},
		},
		{
			name: "v2", path: "/v2/synthetic-token", payload: multiBillFixture,
			title: "Synthetic customer — Synthetic shop",
			descriptions: []string{
				"Bill dated 15 Nov 2023 — Balance to settle: 10.10 AFN ؋",
				"In your favour: 10.10 USD $", "All settled — nothing owed. (AUD A$)",
			},
		},
		{
			name: "v3", path: "/v3/synthetic-token", payload: string(historyPayload),
			title: "Synthetic customer — Synthetic shop",
			descriptions: []string{
				"Bill dated 15 Nov 2023 — Balance to settle: 10.10 AFN ؋",
				"In your favour: 10.10 USD $", "All settled — nothing owed. (AUD A$)",
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &memorySnapshotStore{payload: []byte(tc.payload)}
			h := NewHandler(store, "https://kaata.af///", "https://bills.example", "https://api.example")
			r := chi.NewRouter()
			r.Get("/v/{token}", h.View)
			r.Get("/v2/{token}", h.View)
			r.Get("/v3/{token}", h.View)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "https://untrusted.example"+tc.path, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("view: %d %s", w.Code, w.Body.String())
			}
			if got := w.Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
				t.Errorf("bill indexing header = %q", got)
			}
			head, meta := previewHead(t, w.Body.String())
			if meta["robots"] != "noindex, nofollow" {
				t.Errorf("bill indexing meta = %q", meta["robots"])
			}
			requireBillArtwork(t, meta, "https://kaata.af/og/kaata-fa-v1.png", true)
			if meta["og:title"] != tc.title || meta["twitter:title"] != tc.title {
				t.Fatalf("customer/shop title changed: %#v", meta)
			}
			if !strings.Contains(head, "<title>"+html.EscapeString(tc.title)+"</title>") {
				t.Error("document title must preserve and escape customer/shop labels")
			}
			for _, want := range tc.descriptions {
				if !strings.Contains(meta["og:description"], want) {
					t.Errorf("dated balance preview missing %q: %s", want, meta["og:description"])
				}
			}
			if meta["twitter:description"] != meta["og:description"] || meta["description"] != meta["og:description"] {
				t.Error("preview descriptions differ")
			}
			if meta["og:url"] != "https://bills.example"+tc.path {
				t.Errorf("bill canonical URL changed: %s", meta["og:url"])
			}
			if strings.Contains(meta["og:image"], "synthetic-token") || strings.Contains(meta["og:image:alt"], tc.title) {
				t.Error("public artwork must remain generic and independent of customer/token")
			}
			if store.writes != 0 || string(store.payload) != tc.payload {
				t.Error("rendering preview must not change the frozen financial snapshot")
			}
		})
	}
}

func TestBillOGImageOriginsAndEscaping(t *testing.T) {
	for _, tc := range []struct {
		origin, image string
		secure        bool
	}{
		{" https://kaata.af/// ", "https://kaata.af/og/kaata-fa-v1.png", true},
		{"http://localhost:8080/", "http://localhost:8080/og/kaata-fa-v1.png", false},
		{"https://preview.example&site", "https://preview.example&site/og/kaata-fa-v1.png", true},
		{"", "", false}, {"/relative", "", false}, {"//kaata.af", "", false},
		{"javascript:alert(1)", "", false}, {"https://kaata.af?x=1&y=2", "", false},
		{"https://kaata.af?", "", false}, {"https://kaata.af#", "", false},
		{"https://kaata.af/path", "", false}, {"https://user:secret@kaata.af", "", false},
		{"https://kaata.af\" onerror=\"alert(1)", "", false},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			var page bytes.Buffer
			if err := viewTmpl.Execute(&page, viewData{Origin: tc.origin, Direction: "settled"}); err != nil {
				t.Fatal(err)
			}
			head, meta := previewHead(t, page.String())
			if tc.image == "" {
				if strings.Contains(head, `property="og:image`) || strings.Contains(head, `name="twitter:image`) || meta["twitter:card"] != "summary" {
					t.Error("invalid/unset canonical origin must not advertise image metadata")
				}
				return
			}
			requireBillArtwork(t, meta, tc.image, tc.secure)
			if strings.Contains(tc.origin, "&") && !strings.Contains(head, "preview.example&amp;site/og/") {
				t.Error("absolute artwork URL must be HTML-escaped in attributes")
			}
		})
	}
}

type unavailablePreviewStore struct {
	payload []byte
	err     error
}

func (s unavailablePreviewStore) Create(context.Context, []byte) (string, error) {
	return "", errors.New("unexpected write")
}
func (s unavailablePreviewStore) Get(context.Context, string) ([]byte, error) {
	return s.payload, s.err
}

func TestBillOGImageUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name   string
		store  unavailablePreviewStore
		status int
	}{
		{"not found", unavailablePreviewStore{err: ErrNotFound}, http.StatusNotFound},
		{"private failure", unavailablePreviewStore{err: errors.New("private store error")}, http.StatusInternalServerError},
		{"invalid bill", unavailablePreviewStore{payload: []byte(`{"v":2,"person":"Private customer","currencies":[]}`)}, http.StatusUnprocessableEntity},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(tc.store, "https://kaata.af", "", "")
			r := chi.NewRouter()
			r.Get("/v/{token}", h.View)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v/missing", nil))
			if w.Code != tc.status {
				t.Fatalf("view: %d, want %d", w.Code, tc.status)
			}
			for _, forbidden := range []string{"og:image", "twitter:image", "summary_large_image", "kaata-fa-v1.png", "Private customer", "private store error"} {
				if strings.Contains(w.Body.String(), forbidden) {
					t.Errorf("unavailable response leaked preview field %q", forbidden)
				}
			}
		})
	}
}
