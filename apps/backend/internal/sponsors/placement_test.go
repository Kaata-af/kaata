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
	art, err := normalizeArtwork(raw.Bytes())
	if err != nil || art.contentType != "image/jpeg" || art.aspectRatio != legacyArtworkRatio || bytes.Contains(art.data, []byte(injected)) {
		t.Fatalf("JPEG validation or cleanup failed: %s, %v", art.contentType, err)
	}
	for _, size := range []image.Point{{X: 728, Y: 90}, {X: 640, Y: 250}, {X: 2048, Y: 1024}} {
		raw.Reset()
		if err := png.Encode(&raw, image.NewRGBA(image.Rectangle{Max: size})); err != nil {
			t.Fatal(err)
		}
		art, err := normalizeArtwork(raw.Bytes())
		if err != nil || art.contentType != "image/png" || art.aspectRatio != float64(size.X)/float64(size.Y) {
			t.Fatalf("failed to normalize %s PNG: %v", size, err)
		}
	}
	for _, size := range []image.Point{{X: 640, Y: 321}, {X: 2049, Y: 120}, {X: 2048, Y: 1025}} {
		raw.Reset()
		if err := png.Encode(&raw, image.NewRGBA(image.Rectangle{Max: size})); err != nil {
			t.Fatal(err)
		}
		if _, err := normalizeArtwork(raw.Bytes()); err == nil {
			t.Fatalf("accepted invalid artwork dimensions %s", size)
		}
	}
	for _, invalid := range [][]byte{[]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), make([]byte, maxImageBytes+1)} {
		if _, err := normalizeArtwork(invalid); err == nil {
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
	router.Use(httpx.CORS)
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
	read := func(path, authKey string, into any) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if authKey != "" {
			req.Header.Set("Authorization", "Bearer "+authKey)
		}
		res := request(req, http.StatusOK)
		if err := json.Unmarshal(res.Body.Bytes(), into); err != nil || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid or cacheable response: %s (%v)", res.Body, err)
		}
	}
	readAdmin := func() savedPlacement {
		t.Helper()
		var placement savedPlacement
		read(adminPath, key, &placement)
		return placement
	}
	readPublic := func(path string) sponsorPlacement {
		t.Helper()
		var placement sponsorPlacement
		read(path, "", &placement)
		return placement
	}
	readPublicTag := func(path, etag string, wantStatus int) string {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if etag != "" {
			req.Header.Set("If-None-Match", etag)
		}
		res := request(req, wantStatus)
		tag := res.Header().Get("ETag")
		if tag == "" || res.Header().Get("Cache-Control") != "no-store" || res.Header().Get("Access-Control-Expose-Headers") != "ETag" {
			t.Fatalf("missing revalidation headers: %v", res.Header())
		}
		if wantStatus == http.StatusNotModified && (res.Body.Len() != 0 || tag != etag) {
			t.Fatalf("unchanged placement returned body %q or a different tag %q", res.Body.String(), tag)
		}
		return tag
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
			ImageURL    string  `json:"image_url"`
			AspectRatio float64 `json:"aspect_ratio"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &uploaded); err != nil || !strings.HasPrefix(uploaded.ImageURL, sponsorImagePath) || uploaded.AspectRatio != float64(width)/float64(height) {
			t.Fatalf("invalid image response: %s (%v)", res.Body, err)
		}
		return uploaded.ImageURL
	}
	save := func(placement savedPlacement, wantStatus int) {
		t.Helper()
		body, err := json.Marshal(map[string]any{
			"button":              placement.Button,
			"banner":              placement.Banner,
			"locales":             placement.Locales,
			"expected_updated_at": placement.UpdatedAt,
		})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPut, adminPath, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+key)
		request(req, wantStatus)
	}

	request(httptest.NewRequest(http.MethodGet, adminPath, nil), http.StatusUnauthorized)
	upload(320, 50, "wrong-key", http.StatusUnauthorized)
	upload(320, 161, key, http.StatusBadRequest)
	initial := readPublic(publicPath)
	if !initial.Button.Enabled || initial.Button.Label != "" || initial.Banner.Enabled || initial.Banner.RotationSeconds != 6 || initial.Banner.Slides == nil {
		t.Fatalf("unexpected initial public settings: %+v", initial)
	}
	preflight := request(httptest.NewRequest(http.MethodOptions, publicPath, nil), http.StatusNoContent)
	if !strings.Contains(preflight.Header().Get("Access-Control-Allow-Headers"), "If-None-Match") {
		t.Fatal("browser revalidation is blocked by CORS")
	}
	initialTag := readPublicTag(publicPath, "", http.StatusOK)
	readPublicTag(publicPath, initialTag, http.StatusNotModified)
	first := upload(320, 50, key, http.StatusCreated)
	if retry := upload(320, 50, key, http.StatusCreated); retry != first {
		t.Fatalf("duplicate upload changed its immutable URL: %s -> %s", first, retry)
	}
	second := upload(960, 300, key, http.StatusCreated)
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

	edit := readAdmin()
	edit.Button.Enabled = false
	edit.Banner.Enabled = true
	edit.Banner.RotationSeconds = 8
	save(edit, http.StatusBadRequest)
	edit.Locales["en"] = &localizedPlacement{
		ButtonLabel: "  Work with Kaata  ",
		Slides: []placementSlide{
			{ImageURL: second, DestinationURL: " https://example.test/second ", AspectRatio: 99},
			{ImageURL: first, DestinationURL: "http://example.test/first"},
		},
	}
	edit.Locales["fa"] = &localizedPlacement{ButtonLabel: "همکاری با کاته"}
	edit.Locales["ps"] = &localizedPlacement{ButtonLabel: "له کاټه سره کار"}
	edit.Locales["fa"].Slides = []placementSlide{{ImageURL: first, DestinationURL: "javascript:alert(1)"}}
	save(edit, http.StatusBadRequest)
	edit.Locales["fa"].Slides[0] = placementSlide{ImageURL: sponsorImagePath + strings.Repeat("0", 64), DestinationURL: "https://example.test"}
	save(edit, http.StatusBadRequest)
	edit.Locales["fa"].Slides[0] = placementSlide{ImageURL: first, DestinationURL: "https://example.test/dari"}
	delete(edit.Locales, "ps")
	save(edit, http.StatusBadRequest)
	edit.Locales["ps"] = &localizedPlacement{ButtonLabel: "له کاټه سره کار"}
	save(edit, http.StatusOK)
	save(edit, http.StatusConflict)
	published := readPublic(publicPath)
	if published.Button.Enabled || published.Button.Label != "Work with Kaata" || !published.Banner.Enabled || published.Banner.RotationSeconds != 8 || len(published.Banner.Slides) != 2 || published.Banner.Slides[0].ImageURL != second || published.Banner.Slides[0].DestinationURL != "https://example.test/second" || published.Banner.Slides[1].ImageURL != first {
		t.Fatalf("expected independently enabled banner in admin order: %+v", published)
	}
	if published.Banner.Slides[0].AspectRatio != 3.2 || published.Banner.Slides[1].AspectRatio != legacyArtworkRatio || readAdmin().Locales["en"].Slides[0].AspectRatio != 3.2 {
		t.Fatalf("expected aspect ratios from the hosted artwork, regardless of the input: %+v", published.Banner.Slides)
	}
	if _, err := pool.Exec(t.Context(), `
		UPDATE sponsor_placement
		SET locale_settings = jsonb_set(locale_settings, '{en,slides,1}', (locale_settings #> '{en,slides,1}') - 'aspect_ratio')`); err != nil {
		t.Fatal(err)
	}
	if readPublic(publicPath).Banner.Slides[1].AspectRatio != legacyArtworkRatio || readAdmin().Locales["en"].Slides[1].AspectRatio != legacyArtworkRatio {
		t.Fatal("expected prior slides without ratio metadata to retain the original proportions")
	}
	dari := readPublic(publicPath + "?locale=fa")
	if dari.Button.Label != "همکاری با کاته" || len(dari.Banner.Slides) != 1 || dari.Banner.Slides[0].DestinationURL != "https://example.test/dari" {
		t.Fatalf("expected the Dari label and link: %+v", dari)
	}
	pashto := readPublic(publicPath + "?locale=ps")
	if pashto.Button.Label != "له کاټه سره کار" || !pashto.Banner.Enabled || pashto.Banner.Slides == nil || len(pashto.Banner.Slides) != 0 {
		t.Fatalf("empty Pashto banner should not fall back to English artwork: %+v", pashto)
	}
	publishedTag := readPublicTag(publicPath, initialTag, http.StatusOK)
	if publishedTag == initialTag {
		t.Fatal("publishing slides did not invalidate the cached placement")
	}
	readPublicTag(publicPath+"?locale=invalid", publishedTag, http.StatusNotModified)
	dariTag := readPublicTag(publicPath+"?locale=fa", publishedTag, http.StatusOK)
	editDari := readAdmin()
	editDari.Locales["fa"].Slides[0].DestinationURL = "https://example.test/dari-new"
	save(editDari, http.StatusOK)
	readPublicTag(publicPath+"?locale=en", publishedTag, http.StatusNotModified)
	readPublicTag(publicPath+"?locale=fa", dariTag, http.StatusOK)
	save(readAdmin(), http.StatusOK)
	readPublicTag(publicPath, publishedTag, http.StatusNotModified)
	paused := readAdmin()
	paused.Button.Enabled = true
	paused.Banner.Enabled = false
	save(paused, http.StatusOK)
	public := readPublic(publicPath)
	if !public.Button.Enabled || public.Banner.Enabled || len(public.Banner.Slides) != 0 || public.Banner.Slides == nil || len(readAdmin().Locales["en"].Slides) != 2 {
		t.Fatalf("expected disabled slides to be withheld from public placement and retained in admin settings: %+v", public)
	}
	pausedTag := readPublicTag(publicPath, publishedTag, http.StatusOK)
	if pausedTag == publishedTag {
		t.Fatal("hiding the banner did not invalidate the cached placement")
	}
	paused = readAdmin()
	english := paused.Locales["en"]
	english.Slides[0], english.Slides[1] = english.Slides[1], english.Slides[0]
	save(paused, http.StatusOK)
	readPublicTag(publicPath, pausedTag, http.StatusNotModified)

	pashtoOnly := readAdmin()
	pashtoOnly.Banner.Enabled = true
	pashtoOnly.Locales["en"].Slides = nil
	pashtoOnly.Locales["fa"].Slides = nil
	pashtoOnly.Locales["ps"].Slides = []placementSlide{{ImageURL: second, DestinationURL: "https://example.test/pashto"}}
	save(pashtoOnly, http.StatusOK)
	pashto = readPublic(publicPath + "?locale=ps")
	if !pashto.Banner.Enabled || len(pashto.Banner.Slides) != 1 || pashto.Banner.Slides[0].DestinationURL != "https://example.test/pashto" || len(readPublic(publicPath).Banner.Slides) != 0 {
		t.Fatalf("Pashto-only art was not isolated: %+v", pashto)
	}
	request(httptest.NewRequest(http.MethodGet, sponsorImagePath+"invalid", nil), http.StatusNotFound)
}
