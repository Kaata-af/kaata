package sponsors

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/httpx"
)

const (
	sponsorImagePath = "/v1/sponsor-images/"
	maxImageBytes    = 1 << 20
)

func validImageDigest(digest string) bool {
	if len(digest) != sha256.Size*2 || digest != strings.ToLower(digest) {
		return false
	}
	_, err := hex.DecodeString(digest)
	return err == nil
}

func normalizeArtwork(raw []byte) ([]byte, string, error) {
	if len(raw) > maxImageBytes {
		return nil, "", errors.New("image must be at most 1 MiB")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "png" && format != "jpeg") {
		return nil, "", errors.New("upload a valid PNG or JPEG image")
	}
	// The dimensions are checked before decoding to bound work and memory even
	// when a small compressed file claims huge dimensions.
	if config.Height < 50 || config.Height > 150 || config.Height%50 != 0 || config.Width != 320*(config.Height/50) {
		return nil, "", errors.New("image must be 320 × 50, 640 × 100, or 960 × 150 pixels")
	}
	art, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil || art.Bounds().Dx() != config.Width || art.Bounds().Dy() != config.Height {
		return nil, "", errors.New("upload a valid PNG or JPEG image")
	}
	// Re-encode so only decoded artwork is hosted on Kaata's public API origin.
	// This strips metadata and any non-image bytes appended to the upload.
	var output bytes.Buffer
	contentType := "image/" + format
	if format == "png" {
		err = png.Encode(&output, art)
	} else {
		err = jpeg.Encode(&output, art, &jpeg.Options{Quality: 90})
	}
	if err != nil || output.Len() > maxImageBytes {
		return nil, "", errors.New("image could not be saved within 1 MiB")
	}
	return output.Bytes(), contentType, nil
}

func (h *Handler) UploadSponsorImage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, maxImageBytes+(4<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "upload one image using multipart form data")
		return
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "image" {
		httpx.Error(w, http.StatusBadRequest, "upload one file in the image field")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(part, maxImageBytes+1))
	if len(raw) > maxImageBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "image must be at most 1 MiB")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "could not read the uploaded image")
		return
	}
	if _, err := reader.NextPart(); err != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "upload one file in the image field")
		return
	}
	artwork, contentType, err := normalizeArtwork(raw)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	digest := sha256.Sum256(artwork)
	id := hex.EncodeToString(digest[:])
	_, err = h.pool.Exec(r.Context(), `
		INSERT INTO sponsor_images (digest, content_type, artwork) VALUES ($1, $2, $3)
		ON CONFLICT (digest) DO NOTHING`, id, contentType, artwork)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not save the banner image")
		return
	}
	httpx.JSON(w, http.StatusCreated, struct {
		ImageURL string `json:"image_url"`
	}{ImageURL: sponsorImagePath + id})
}

func (h *Handler) ServeSponsorImage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "digest")
	if !validImageDigest(id) {
		http.NotFound(w, r)
		return
	}
	var artwork []byte
	var contentType string
	err := h.pool.QueryRow(r.Context(), `SELECT artwork, content_type FROM sponsor_images WHERE digest=$1`, id).Scan(&artwork, &contentType)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not load the banner image")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+id+`"`)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(artwork))
}
