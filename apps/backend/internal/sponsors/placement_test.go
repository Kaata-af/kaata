package sponsors

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestNormalizeArtwork(t *testing.T) {
	const injected = "<script>alert(1)</script>"
	var raw bytes.Buffer
	if err := jpeg.Encode(&raw, image.NewRGBA(image.Rect(0, 0, 640, 100)), nil); err != nil {
		t.Fatal(err)
	}
	raw.WriteString(injected)
	art, contentType, err := normalizeArtwork(raw.Bytes())
	if err != nil || contentType != "image/jpeg" || bytes.Contains(art, []byte(injected)) {
		t.Fatalf("JPEG validation or cleanup failed: %s, %v", contentType, err)
	}
	raw.Reset()
	if err := png.Encode(&raw, image.NewRGBA(image.Rect(0, 0, 728, 90))); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range [][]byte{raw.Bytes(), []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), make([]byte, maxImageBytes+1)} {
		if _, _, err := normalizeArtwork(invalid); err == nil {
			t.Fatal("accepted invalid or oversized image")
		}
	}
}

func TestSponsorPlacementLifecycle(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	h := NewHandler(pool)
	const (
		publicPath = "/v1/sponsor-placement"
		adminPath  = "/v1/admin/sponsor-placement"
		uploadPath = "/v1/admin/sponsor-images"
		key        = "test-admin-key"
	)
	router := chi.NewRouter()
	router.Get(publicPath, h.SponsorPlacement)
	router.Get(sponsorImagePath+"{digest}", h.ServeSponsorImage)
	router.Head(sponsorImagePath+"{digest}", h.ServeSponsorImage)
	router.Group(func(admin chi.Router) {
		admin.Use(httpx.AdminKeyMiddleware(key))
		admin.Get(adminPath, h.AdminSponsorPlacement)
		admin.Put(adminPath, h.SaveSponsorPlacement)
		admin.Post(uploadPath, h.UploadSponsorImage)
	})
	request := func(req *http.Request, wantStatus int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != wantStatus {
			t.Fatalf("%s %s: status %d, want %d: %s", req.Method, req.URL, w.Code, wantStatus, w.Body)
		}
		return w
	}
	read := func(path, authKey string) savedPlacement {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if authKey != "" {
			req.Header.Set("Authorization", "Bearer "+authKey)
		}
		res := request(req, http.StatusOK)
		var placement savedPlacement
		if err := json.Unmarshal(res.Body.Bytes(), &placement); err != nil || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid or cacheable response: %s (%v)", res.Body, err)
		}
		return placement
	}
	upload := func(width, height int, authKey string, wantStatus int) string {
		t.Helper()
		var form bytes.Buffer
		writer := multipart.NewWriter(&form)
		part, err := writer.CreateFormFile("image", "banner.png")
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(part, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, uploadPath, &form)
		req.Header.Set("Authorization", "Bearer "+authKey)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		res := request(req, wantStatus)
		if wantStatus != http.StatusCreated {
			return ""
		}
		var uploaded struct {
			ImageURL string `json:"image_url"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &uploaded); err != nil || !strings.HasPrefix(uploaded.ImageURL, sponsorImagePath) {
			t.Fatalf("invalid image response: %s (%v)", res.Body, err)
		}
		return uploaded.ImageURL
	}
	save := func(placement savedPlacement, wantStatus int) {
		t.Helper()
		body, err := json.Marshal(struct {
			sponsorPlacement
			Revision time.Time `json:"expected_updated_at"`
		}{placement.sponsorPlacement, placement.UpdatedAt})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPut, adminPath, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+key)
		request(req, wantStatus)
	}

	request(httptest.NewRequest(http.MethodGet, adminPath, nil), http.StatusUnauthorized)
	upload(320, 50, "wrong-key", http.StatusUnauthorized)
	upload(320, 51, key, http.StatusBadRequest)
	initial := read(publicPath, "")
	if !initial.Button.Enabled || initial.Button.Label != "" || initial.Banner.Enabled || initial.Banner.RotationSeconds != 6 || initial.Banner.Slides == nil || !initial.UpdatedAt.IsZero() {
		t.Fatalf("unexpected initial public settings: %+v", initial)
	}
	first := upload(320, 50, key, http.StatusCreated)
	if retry := upload(320, 50, key, http.StatusCreated); retry != first {
		t.Fatalf("duplicate upload changed its immutable URL: %s -> %s", first, retry)
	}
	second := upload(960, 150, key, http.StatusCreated)
	imageResponse := request(httptest.NewRequest(http.MethodGet, first, nil), http.StatusOK)
	art, format, err := image.DecodeConfig(bytes.NewReader(imageResponse.Body.Bytes()))
	if err != nil || art.Width != 320 || art.Height != 50 || format != "png" || imageResponse.Header().Get("Content-Type") != "image/png" || imageResponse.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("invalid hosted artwork: %+v, %s, %v", art, format, err)
	}
	head := request(httptest.NewRequest(http.MethodHead, first, nil), http.StatusOK)
	if head.Body.Len() != 0 || head.Header().Get("Content-Length") == "" {
		t.Fatal("image HEAD did not return headers without bytes")
	}
	conditional := httptest.NewRequest(http.MethodGet, first, nil)
	conditional.Header.Set("If-None-Match", imageResponse.Header().Get("ETag"))
	request(conditional, http.StatusNotModified)

	edit := read(adminPath, key)
	edit.Button = promotionButton{Enabled: false, Label: "  Work with Kaata  "}
	edit.Banner.Enabled = true
	edit.Banner.RotationSeconds = 8
	edit.Banner.Slides = []placementSlide{
		{ImageURL: second, DestinationURL: " https://example.test/second "},
		{ImageURL: first, DestinationURL: "http://example.test/first"},
	}
	invalid := edit
	invalid.Banner.Slides = []placementSlide{{ImageURL: first, DestinationURL: "javascript:alert(1)"}}
	save(invalid, http.StatusBadRequest)
	invalid.Banner.Slides[0] = placementSlide{ImageURL: sponsorImagePath + strings.Repeat("0", 64), DestinationURL: "https://example.test"}
	save(invalid, http.StatusBadRequest)
	save(edit, http.StatusOK)
	save(edit, http.StatusConflict)
	published := read(publicPath, "")
	if published.Button.Enabled || published.Button.Label != "Work with Kaata" || !published.Banner.Enabled || published.Banner.RotationSeconds != 8 || len(published.Banner.Slides) != 2 || published.Banner.Slides[0].ImageURL != second || published.Banner.Slides[0].DestinationURL != "https://example.test/second" || published.Banner.Slides[1].ImageURL != first {
		t.Fatalf("expected independently enabled banner in admin order: %+v", published)
	}
	paused := read(adminPath, key)
	paused.Button.Enabled = true
	paused.Banner.Enabled = false
	save(paused, http.StatusOK)
	public := read(publicPath, "")
	if !public.Button.Enabled || public.Banner.Enabled || len(public.Banner.Slides) != 0 || public.Banner.Slides == nil || len(read(adminPath, key).Banner.Slides) != 2 {
		t.Fatalf("expected disabled slides to be withheld from public placement and retained in admin settings: %+v", public)
	}
	request(httptest.NewRequest(http.MethodGet, sponsorImagePath+"invalid", nil), http.StatusNotFound)
}
