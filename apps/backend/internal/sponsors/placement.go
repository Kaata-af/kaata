package sponsors

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
	ImageURL       string `json:"image_url"`
	DestinationURL string `json:"destination_url"`
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

type savedPlacement struct {
	sponsorPlacement
	UpdatedAt time.Time `json:"updated_at"`
}

const placementColumns = "button_enabled, button_label, banner_enabled, rotation_seconds, slides, updated_at"

func (p *savedPlacement) scan(row pgx.Row) error {
	return row.Scan(&p.Button.Enabled, &p.Button.Label, &p.Banner.Enabled,
		&p.Banner.RotationSeconds, &p.Banner.Slides, &p.UpdatedAt)
}

func (h *Handler) SponsorPlacement(w http.ResponseWriter, r *http.Request) {
	h.readPlacement(w, r, false)
}

func (h *Handler) AdminSponsorPlacement(w http.ResponseWriter, r *http.Request) {
	h.readPlacement(w, r, true)
}

func (h *Handler) readPlacement(w http.ResponseWriter, r *http.Request, admin bool) {
	w.Header().Set("Cache-Control", "no-store")
	var placement savedPlacement
	if err := placement.scan(h.pool.QueryRow(r.Context(), `SELECT `+placementColumns+` FROM sponsor_placement WHERE singleton`)); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not load sponsor placement")
		return
	}
	if admin {
		httpx.JSON(w, http.StatusOK, placement)
		return
	}
	if !placement.Banner.Enabled {
		placement.Banner.Slides = []placementSlide{}
	}
	body, err := json.Marshal(placement.sponsorPlacement)
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

type placementInput struct {
	Button struct {
		Enabled *bool  `json:"enabled"`
		Label   string `json:"label"`
	} `json:"button"`
	Banner struct {
		Enabled         *bool            `json:"enabled"`
		RotationSeconds int              `json:"rotation_seconds"`
		Slides          []placementSlide `json:"slides"`
	} `json:"banner"`
	ExpectedUpdatedAt time.Time `json:"expected_updated_at"`
}

func (in *placementInput) normalize() ([]string, error) {
	if in.Button.Enabled == nil || in.Banner.Enabled == nil {
		return nil, errors.New("choose whether the button and banner are enabled")
	}
	if in.ExpectedUpdatedAt.IsZero() || !in.ExpectedUpdatedAt.Equal(in.ExpectedUpdatedAt.Truncate(time.Microsecond)) {
		return nil, errors.New("provide the current updated_at timestamp as expected_updated_at")
	}
	in.Button.Label = strings.TrimSpace(in.Button.Label)
	if utf8.RuneCountInString(in.Button.Label) > 32 || strings.ContainsRune(in.Button.Label, 0) {
		return nil, errors.New("button label must contain at most 32 characters")
	}
	if in.Banner.RotationSeconds < 3 || in.Banner.RotationSeconds > 30 {
		return nil, errors.New("banner rotation must be between 3 and 30 seconds")
	}
	if len(in.Banner.Slides) > 8 || (*in.Banner.Enabled && len(in.Banner.Slides) == 0) {
		return nil, errors.New("the banner supports up to 8 slides and requires at least one slide to be enabled")
	}
	if in.Banner.Slides == nil {
		in.Banner.Slides = []placementSlide{}
	}
	seen := make(map[string]bool, len(in.Banner.Slides))
	digests := make([]string, 0, len(in.Banner.Slides))
	for i := range in.Banner.Slides {
		slide := &in.Banner.Slides[i]
		slide.DestinationURL = strings.TrimSpace(slide.DestinationURL)
		if !validWebURL(slide.DestinationURL, false) {
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
	return digests, nil
}

func (h *Handler) SaveSponsorPlacement(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
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
		var count int
		err := h.pool.QueryRow(r.Context(), `SELECT count(*) FROM sponsor_images WHERE digest = ANY($1)`, digests).Scan(&count)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "could not verify the banner images")
			return
		}
		if count != len(digests) {
			httpx.Error(w, http.StatusBadRequest, "one or more banner images could not be found. Upload them again.")
			return
		}
	}
	var placement savedPlacement
	err = placement.scan(h.pool.QueryRow(r.Context(), `
		UPDATE sponsor_placement
		SET button_enabled=$1, button_label=$2, banner_enabled=$3, rotation_seconds=$4, slides=$5,
			updated_at=GREATEST(NOW(), updated_at + INTERVAL '1 microsecond')
		WHERE singleton AND updated_at=$6
		RETURNING `+placementColumns, *input.Button.Enabled, input.Button.Label, *input.Banner.Enabled,
		input.Banner.RotationSeconds, input.Banner.Slides, input.ExpectedUpdatedAt))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, http.StatusConflict, "sponsor placement has changed. Refresh the dashboard and try again.")
	case err != nil:
		httpx.Error(w, http.StatusInternalServerError, "could not save sponsor placement")
	default:
		httpx.JSON(w, http.StatusOK, placement)
	}
}
