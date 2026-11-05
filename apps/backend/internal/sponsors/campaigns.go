package sponsors

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type Banner struct {
	ID       int64     `json:"id"`
	Sponsor  string    `json:"sponsor"`
	Title    string    `json:"title"`
	Body     string    `json:"body"`
	ImageURL *string   `json:"image_url"`
	CTALabel *string   `json:"cta_label"`
	CTAURL   *string   `json:"cta_url"`
	StartsAt time.Time `json:"starts_at"`
	EndsAt   time.Time `json:"ends_at"`
}

type Campaign struct {
	Banner
	IsActive  bool      `json:"is_active"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type campaignInput struct {
	Sponsor  string    `json:"sponsor"`
	Title    string    `json:"title"`
	Body     string    `json:"body"`
	ImageURL *string   `json:"image_url"`
	CTALabel *string   `json:"cta_label"`
	CTAURL   *string   `json:"cta_url"`
	StartsAt time.Time `json:"starts_at"`
	EndsAt   time.Time `json:"ends_at"`
	IsActive *bool     `json:"is_active"`
}

func (in *campaignInput) normalize() error {
	in.Sponsor = strings.TrimSpace(in.Sponsor)
	in.Title = strings.TrimSpace(in.Title)
	in.Body = strings.TrimSpace(in.Body)
	in.ImageURL = trimOptional(in.ImageURL)
	in.CTALabel = trimOptional(in.CTALabel)
	in.CTAURL = trimOptional(in.CTAURL)
	for _, field := range []struct {
		name, value string
		max         int
	}{
		{"Sponsor", in.Sponsor, 80},
		{"Title", in.Title, 100},
		{"Body", in.Body, 180},
	} {
		if field.value == "" || utf8.RuneCountInString(field.value) > field.max || strings.ContainsRune(field.value, 0) {
			return fmt.Errorf("%s must contain between 1 and %d characters", field.name, field.max)
		}
	}
	if (in.CTALabel == nil) != (in.CTAURL == nil) {
		return errors.New("provide both a button label and a destination URL")
	}
	if in.CTALabel != nil && (utf8.RuneCountInString(*in.CTALabel) > 32 || strings.ContainsRune(*in.CTALabel, 0)) {
		return errors.New("button label must contain at most 32 characters")
	}
	if in.ImageURL != nil && !validWebURL(*in.ImageURL, true) {
		return errors.New("image URL must be a valid HTTPS URL of at most 2048 bytes")
	}
	if in.CTAURL != nil && !validWebURL(*in.CTAURL, false) {
		return errors.New("destination URL must be a valid HTTP or HTTPS URL of at most 2048 bytes")
	}
	// Store and compare at PostgreSQL's timestamp precision. Checking the raw
	// nanoseconds first would allow a window that collapses on insert.
	in.StartsAt = in.StartsAt.UTC().Truncate(time.Microsecond)
	in.EndsAt = in.EndsAt.UTC().Truncate(time.Microsecond)
	if in.StartsAt.IsZero() || in.EndsAt.IsZero() || in.StartsAt.Year() < 1 || in.EndsAt.Year() > 9999 || !in.EndsAt.After(in.StartsAt) {
		return errors.New("provide a start time and an end time after it")
	}
	if in.IsActive == nil {
		return errors.New("choose whether the campaign is active")
	}
	return nil
}

func trimOptional(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func validWebURL(raw string, httpsOnly bool) bool {
	if len(raw) > 2048 || strings.ContainsAny(raw, " \\") {
		return false
	}
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Hostname() != "" && parsed.User == nil &&
		(parsed.Scheme == "https" || (!httpsOnly && parsed.Scheme == "http"))
}

const bannerColumns = "id, sponsor, title, body, image_url, cta_label, cta_url, starts_at, ends_at"
const campaignColumns = bannerColumns + ", is_active, created_at, updated_at"

type campaignQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// Current returns the highest-ID campaign in the half-open display window.
func Current(ctx context.Context, db campaignQuerier) (*Banner, error) {
	var banner Banner
	err := db.QueryRow(ctx, `
		SELECT `+bannerColumns+` FROM sponsor_campaigns
		WHERE is_active AND starts_at <= NOW() AND ends_at > NOW()
		ORDER BY id DESC LIMIT 1
	`).Scan(&banner.ID, &banner.Sponsor, &banner.Title, &banner.Body, &banner.ImageURL,
		&banner.CTALabel, &banner.CTAURL, &banner.StartsAt, &banner.EndsAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &banner, nil
}

func (c *Campaign) scan(row pgx.Row) error {
	return row.Scan(&c.ID, &c.Sponsor, &c.Title, &c.Body, &c.ImageURL, &c.CTALabel, &c.CTAURL,
		&c.StartsAt, &c.EndsAt, &c.IsActive, &c.CreatedAt, &c.UpdatedAt)
}
