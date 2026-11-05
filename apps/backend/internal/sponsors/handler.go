package sponsors

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	pool *pgxpool.Pool
}

func NewHandler(pool *pgxpool.Pool) *Handler {
	return &Handler{pool: pool}
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.pool.Query(r.Context(), `SELECT `+campaignColumns+` FROM sponsor_campaigns ORDER BY id DESC`)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not list sponsor campaigns")
		return
	}
	campaigns, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Campaign, error) {
		var campaign Campaign
		err := campaign.scan(row)
		return campaign, err
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not list sponsor campaigns")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Campaigns []Campaign `json:"campaigns"`
	}{Campaigns: campaigns})
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	h.save(w, r, 0)
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid sponsor campaign ID")
		return
	}
	h.save(w, r, id)
}

func (h *Handler) save(w http.ResponseWriter, r *http.Request, id int64) {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	var input campaignInput
	var expectedUpdatedAt time.Time
	var decodeErr error
	if id > 0 {
		var edit struct {
			campaignInput
			ExpectedUpdatedAt time.Time `json:"expected_updated_at"`
		}
		decodeErr = decoder.Decode(&edit)
		input = edit.campaignInput
		expectedUpdatedAt = edit.ExpectedUpdatedAt
	} else {
		decodeErr = decoder.Decode(&input)
	}
	if decodeErr != nil || decoder.Decode(new(json.RawMessage)) != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid campaign data")
		return
	}
	if id > 0 && (expectedUpdatedAt.IsZero() || !expectedUpdatedAt.Equal(expectedUpdatedAt.Truncate(time.Microsecond))) {
		httpx.Error(w, http.StatusBadRequest, "provide the campaign's current updated_at timestamp as expected_updated_at")
		return
	}
	if err := input.normalize(); err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	args := []any{input.Sponsor, input.Title, input.Body, input.ImageURL, input.CTALabel,
		input.CTAURL, input.StartsAt, input.EndsAt, *input.IsActive}
	status := http.StatusCreated
	query := `
		INSERT INTO sponsor_campaigns (sponsor, title, body, image_url, cta_label, cta_url, starts_at, ends_at, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING ` + campaignColumns
	if id > 0 {
		status = http.StatusOK
		query = `
			UPDATE sponsor_campaigns SET sponsor=$1, title=$2, body=$3, image_url=$4, cta_label=$5, cta_url=$6,
			starts_at=$7, ends_at=$8, is_active=$9, updated_at=GREATEST(NOW(), updated_at + INTERVAL '1 microsecond')
			WHERE id=$10 AND updated_at=$11
			RETURNING ` + campaignColumns
		args = append(args, id, expectedUpdatedAt)
	}
	var campaign Campaign
	err := campaign.scan(h.pool.QueryRow(r.Context(), query, args...))
	switch {
	case id > 0 && errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, http.StatusConflict, "campaign has changed or is missing. Refresh the campaign list and try again.")
	case err != nil:
		httpx.Error(w, http.StatusInternalServerError, "could not save sponsor campaign")
	default:
		httpx.JSON(w, status, campaign)
	}
}
