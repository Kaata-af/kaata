package sponsors

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/httpx"
)

type promotionButton struct {
	Enabled bool   `json:"enabled"`
	Label   string `json:"label"`
}

type placementSlide struct {
	ImageURL       string  `json:"image_url"`
	DestinationURL string  `json:"destination_url"`
	AspectRatio    float64 `json:"aspect_ratio"`
}

type leaderboard struct {
	Enabled         bool             `json:"enabled"`
	RotationSeconds int              `json:"rotation_seconds"`
	Slides          []placementSlide `json:"slides"`
}

type sponsorPlacement struct {
	Button promotionButton `json:"button"`
	Banner leaderboard     `json:"banner"`
}

type localizedPlacement struct {
	ButtonLabel string           `json:"button_label"`
	Slides      []placementSlide `json:"slides"`
}

type savedPlacement struct {
	Button struct {
		Enabled bool `json:"enabled"`
	} `json:"button"`
	Banner struct {
		Enabled         bool `json:"enabled"`
		RotationSeconds int  `json:"rotation_seconds"`
	} `json:"banner"`
	Locales   map[string]*localizedPlacement `json:"locales"`
	UpdatedAt time.Time                      `json:"updated_at"`
}

const placementColumns = "button_enabled, banner_enabled, rotation_seconds, locale_settings, updated_at"

var placementLocales = [...]string{"en", "fa", "ps"}

func (p *savedPlacement) scan(row pgx.Row) error {
	if err := row.Scan(&p.Button.Enabled, &p.Banner.Enabled, &p.Banner.RotationSeconds, &p.Locales, &p.UpdatedAt); err != nil {
		return err
	}
	for _, content := range p.Locales {
		fillLegacyAspectRatios(content.Slides)
	}
	return nil
}

// Prior placement JSON does not contain ratios. All of that artwork used 320 × 50 proportions.
func fillLegacyAspectRatios(slides []placementSlide) {
	for i := range slides {
		if slides[i].AspectRatio == 0 {
			slides[i].AspectRatio = legacyArtworkRatio
		}
	}
}

func (h *Handler) SponsorPlacement(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	locale := r.URL.Query().Get("locale")
	if locale != "fa" && locale != "ps" {
		locale = "en"
	}
	var public sponsorPlacement
	var content localizedPlacement
	err := h.pool.QueryRow(r.Context(), `
		SELECT button_enabled, banner_enabled, rotation_seconds, locale_settings->$1::text
		FROM sponsor_placement WHERE singleton`, locale).
		Scan(&public.Button.Enabled, &public.Banner.Enabled, &public.Banner.RotationSeconds, &content)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not load sponsor placement")
		return
	}
	public.Button.Label = content.ButtonLabel
	if public.Banner.Enabled {
		fillLegacyAspectRatios(content.Slides)
		public.Banner.Slides = content.Slides
	} else {
		public.Banner.Slides = []placementSlide{}
	}
	body, err := json.Marshal(public)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not encode sponsor placement")
		return
	}
	// Hash the public representation so a no-op save or an edit to hidden
	// slides does not invalidate the app's saved copy. A weak tag remains
	// valid if the proxy compresses the response.
	w.Header().Set("ETag", fmt.Sprintf(`W/"%x"`, sha256.Sum256(body)))
	w.Header().Set("Access-Control-Expose-Headers", "ETag")
	w.Header().Set("Content-Type", "application/json")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}

func (h *Handler) AdminSponsorPlacement(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var placement savedPlacement
	if err := placement.scan(h.pool.QueryRow(r.Context(), `SELECT `+placementColumns+` FROM sponsor_placement WHERE singleton`)); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not load sponsor placement")
		return
	}
	httpx.JSON(w, http.StatusOK, placement)
}

type placementInput struct {
	Button struct {
		Enabled *bool `json:"enabled"`
	} `json:"button"`
	Banner struct {
		Enabled         *bool `json:"enabled"`
		RotationSeconds int   `json:"rotation_seconds"`
	} `json:"banner"`
	Locales           map[string]*localizedPlacement `json:"locales"`
	ExpectedUpdatedAt time.Time                      `json:"expected_updated_at"`
}

func (in *placementInput) normalize() ([]string, error) {
	if in.Button.Enabled == nil || in.Banner.Enabled == nil {
		return nil, errors.New("choose whether the button and banner are enabled")
	}
	if in.ExpectedUpdatedAt.IsZero() || !in.ExpectedUpdatedAt.Equal(in.ExpectedUpdatedAt.Truncate(time.Microsecond)) {
		return nil, errors.New("provide the current updated_at timestamp as expected_updated_at")
	}
	if in.Banner.RotationSeconds < 3 || in.Banner.RotationSeconds > 30 {
		return nil, errors.New("banner rotation must be between 3 and 30 seconds")
	}
	if len(in.Locales) != len(placementLocales) {
		return nil, errors.New("provide English, Dari, and Pashto placement settings")
	}
	seen := make(map[string]bool)
	var digests []string
	for _, locale := range placementLocales {
		content := in.Locales[locale]
		if content == nil {
			return nil, errors.New("provide English, Dari, and Pashto placement settings")
		}
		content.ButtonLabel = strings.TrimSpace(content.ButtonLabel)
		if utf8.RuneCountInString(content.ButtonLabel) > 32 || strings.ContainsRune(content.ButtonLabel, 0) {
			return nil, errors.New("each button label must contain at most 32 characters")
		}
		if len(content.Slides) > 8 {
			return nil, errors.New("the banner supports up to 8 slides per language")
		}
		if content.Slides == nil {
			content.Slides = []placementSlide{}
		}
		for i := range content.Slides {
			slide := &content.Slides[i]
			slide.DestinationURL = strings.TrimSpace(slide.DestinationURL)
			if !validWebURL(slide.DestinationURL) {
				return nil, errors.New("each slide needs a valid HTTP or HTTPS destination URL of at most 2048 bytes")
			}
			digest, ok := strings.CutPrefix(slide.ImageURL, sponsorImagePath)
			if !ok || !validImageDigest(digest) {
				return nil, errors.New("upload an image for each slide")
			}
			if !seen[digest] {
				digests = append(digests, digest)
				seen[digest] = true
			}
		}
	}
	if *in.Banner.Enabled && len(digests) == 0 {
		return nil, errors.New("add a slide in at least one language before enabling the banner")
	}
	return digests, nil
}

func validWebURL(raw string) bool {
	if len(raw) > 2048 || strings.ContainsAny(raw, " \\") {
		return false
	}
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Hostname() != "" && parsed.User == nil &&
		(parsed.Scheme == "https" || parsed.Scheme == "http")
}

func (h *Handler) SaveSponsorPlacement(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// Up to 24 2048-byte URLs, including escaped JSON characters.
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 320<<10))
	decoder.DisallowUnknownFields()
	var input placementInput
	if err := decoder.Decode(&input); err != nil || decoder.Decode(new(json.RawMessage)) != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid sponsor placement data")
		return
	}
	digests, err := input.normalize()
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(digests) > 0 {
		// Assets are immutable. An upload can be retried and does not publish a slide.
		rows, err := h.pool.Query(r.Context(), `SELECT digest, aspect_ratio FROM sponsor_images WHERE digest = ANY($1)`, digests)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "could not verify the banner images")
			return
		}
		var digest string
		var aspectRatio float64
		ratios := make(map[string]float64, len(digests))
		_, err = pgx.ForEachRow(rows, []any{&digest, &aspectRatio}, func() error {
			ratios[digest] = aspectRatio
			return nil
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "could not verify the banner images")
			return
		}
		if len(ratios) != len(digests) {
			httpx.Error(w, http.StatusBadRequest, "one or more banner images could not be found. Upload them again.")
			return
		}
		for _, content := range input.Locales {
			for i := range content.Slides {
				slide := &content.Slides[i]
				slide.AspectRatio = ratios[strings.TrimPrefix(slide.ImageURL, sponsorImagePath)]
			}
		}
	}
	var placement savedPlacement
	err = placement.scan(h.pool.QueryRow(r.Context(), `
		UPDATE sponsor_placement
		SET button_enabled=$1, banner_enabled=$2, rotation_seconds=$3, locale_settings=$4,
			updated_at=GREATEST(NOW(), updated_at + INTERVAL '1 microsecond')
		WHERE singleton AND updated_at=$5
		RETURNING `+placementColumns, *input.Button.Enabled, *input.Banner.Enabled, input.Banner.RotationSeconds,
		input.Locales, input.ExpectedUpdatedAt))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, http.StatusConflict, "sponsor placement has changed. Refresh the dashboard and try again.")
	case err != nil:
		httpx.Error(w, http.StatusInternalServerError, "could not save sponsor placement")
	default:
		httpx.JSON(w, http.StatusOK, placement)
	}
}
