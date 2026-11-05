package sponsors

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestCampaignInputValidation(t *testing.T) {
	stringPtr := func(s string) *string { return &s }
	active := true
	base := campaignInput{
		Sponsor: "  Test supplier ", Title: "Stock up", Body: strings.Repeat("ژ", 180),
		ImageURL: stringPtr(" https://example.test/product.png "), CTALabel: stringPtr("View offer"),
		CTAURL: stringPtr("http://example.test/offer"), IsActive: &active,
		StartsAt: time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC),
		EndsAt:   time.Date(2026, 11, 6, 10, 0, 0, 0, time.UTC),
	}
	valid := base
	if err := valid.normalize(); err != nil || valid.Sponsor != "Test supplier" || *valid.ImageURL != "https://example.test/product.png" {
		t.Fatalf("valid campaign normalization: %+v, %v", valid, err)
	}
	for _, tc := range []struct {
		name   string
		change func(*campaignInput)
	}{
		{"missing sponsor", func(in *campaignInput) { in.Sponsor = "  " }},
		{"too much body copy", func(in *campaignInput) { in.Body += "ژ" }},
		{"NUL in text", func(in *campaignInput) { in.Title += "\x00" }},
		{"label without destination", func(in *campaignInput) { in.CTAURL = nil }},
		{"destination without label", func(in *campaignInput) { in.CTALabel = stringPtr("  ") }},
		{"long label", func(in *campaignInput) { in.CTALabel = stringPtr(strings.Repeat("x", 33)) }},
		{"insecure image", func(in *campaignInput) { in.ImageURL = stringPtr("http://example.test") }},
		{"custom destination scheme", func(in *campaignInput) { in.CTAURL = stringPtr("javascript:alert(1)") }},
		{"credentials in destination", func(in *campaignInput) { in.CTAURL = stringPtr("https://example.test@other.test") }},
		{"no hostname", func(in *campaignInput) { in.CTAURL = stringPtr("https:///offer") }},
		{"ambiguous hostname", func(in *campaignInput) { in.CTAURL = stringPtr(`https://example.test\@other.test`) }},
		{"long URL", func(in *campaignInput) { in.CTAURL = stringPtr("https://example.test/" + strings.Repeat("x", 2048)) }},
		{"no end", func(in *campaignInput) { in.EndsAt = time.Time{} }},
		{"reversed window", func(in *campaignInput) { in.EndsAt = in.StartsAt.Add(-time.Hour) }},
		{"window rounds away", func(in *campaignInput) { in.EndsAt = in.StartsAt.Add(time.Nanosecond) }},
		{"no active setting", func(in *campaignInput) { in.IsActive = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := base
			tc.change(&input)
			if err := input.normalize(); err == nil {
				t.Fatal("invalid campaign was accepted")
			}
		})
	}
}

func TestSponsorCampaignLifecycle(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	h := NewHandler(pool)
	router := chi.NewRouter()
	router.Use(httpx.AdminKeyMiddleware("test-admin-key"))
	const path = "/v1/admin/sponsor-campaigns"
	router.Get(path, h.List)
	router.Post(path, h.Create)
	router.Put(path+"/{id}", h.Update)
	request := func(method, path, key, body string, wantStatus int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+key)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != wantStatus {
			t.Fatalf("%s %s: status %d, want %d: %s", method, path, w.Code, wantStatus, w.Body)
		}
		return w
	}
	request(http.MethodGet, path, "wrong-key", "", http.StatusUnauthorized)
	if w := request(http.MethodGet, path, "test-admin-key", "", http.StatusOK); strings.TrimSpace(w.Body.String()) != `{"campaigns":[]}` {
		t.Fatalf("unexpected empty list response: %s", w.Body)
	}
	var now time.Time
	if err := pool.QueryRow(t.Context(), "SELECT NOW()").Scan(&now); err != nil {
		t.Fatal(err)
	}
	body := func(starts, ends time.Time, active bool) string {
		return fmt.Sprintf(`{"sponsor":"Supplier","title":"New stock","body":"See the offer","image_url":null,"cta_label":"Offer","cta_url":"https://example.test/offer","starts_at":%q,"ends_at":%q,"is_active":%t}`,
			starts.Format(time.RFC3339Nano), ends.Format(time.RFC3339Nano), active)
	}
	create := func(starts, ends time.Time, active bool) Campaign {
		t.Helper()
		w := request(http.MethodPost, path, "test-admin-key", body(starts, ends, active), http.StatusCreated)
		var campaign Campaign
		if err := json.Unmarshal(w.Body.Bytes(), &campaign); err != nil || campaign.ID <= 0 || campaign.CreatedAt.IsZero() || campaign.IsActive != active {
			t.Fatalf("invalid campaign response: %s (%v)", w.Body, err)
		}
		return campaign
	}
	checkCurrent := func(want int64) {
		t.Helper()
		got, err := Current(t.Context(), pool)
		if err != nil || (want == 0 && got != nil) || (want != 0 && (got == nil || got.ID != want)) {
			t.Fatalf("current campaign = %+v, want ID %d, err %v", got, want, err)
		}
	}
	checkCurrent(0)
	starts, ends := now.Add(-time.Hour), now.Add(time.Hour)
	older := create(starts, ends, true)
	newer := create(starts, ends, true)
	create(now.Add(time.Hour), now.Add(2*time.Hour), true)
	create(now.Add(-2*time.Hour), now.Add(-time.Hour), true)
	create(starts, ends, false)
	checkCurrent(newer.ID)
	newerPath := fmt.Sprintf("%s/%d", path, newer.ID)
	withRevision := func(body string, revision time.Time) string {
		return strings.TrimSuffix(body, "}") + fmt.Sprintf(`,"expected_updated_at":%q}`, revision.Format(time.RFC3339Nano))
	}
	request(http.MethodPut, newerPath, "test-admin-key", body(starts, ends, true), http.StatusBadRequest)
	request(http.MethodPost, path, "test-admin-key", withRevision(body(starts, ends, true), newer.UpdatedAt), http.StatusBadRequest)
	edit := strings.Replace(withRevision(body(starts, ends, true), newer.UpdatedAt), "New stock", "Fresh stock", 1)
	edit = strings.Replace(edit, `"image_url":null`, `"image_url":"https://example.test/product.png"`, 1)
	w := request(http.MethodPut, newerPath, "test-admin-key", edit, http.StatusOK)
	var updated Campaign
	if err := json.Unmarshal(w.Body.Bytes(), &updated); err != nil || updated.ID != newer.ID || updated.Title != "Fresh stock" || updated.ImageURL == nil || !updated.UpdatedAt.After(newer.UpdatedAt) {
		t.Fatalf("invalid edited campaign response: %s (%v)", w.Body, err)
	}
	request(http.MethodPut, newerPath, "test-admin-key", withRevision(body(starts, ends, false), newer.UpdatedAt), http.StatusConflict)
	got, err := Current(t.Context(), pool)
	if err != nil || got == nil || got.Title != updated.Title || got.ImageURL == nil || *got.ImageURL != *updated.ImageURL {
		t.Fatalf("campaign edit missing from delivery: %+v (%v)", got, err)
	}
	request(http.MethodPut, path+"/12345678", "test-admin-key", withRevision(body(starts, ends, false), updated.UpdatedAt), http.StatusConflict)
	request(http.MethodPut, newerPath, "test-admin-key", withRevision(body(starts, ends, false), updated.UpdatedAt), http.StatusOK)
	checkCurrent(older.ID)

	// NOW() stays fixed in a transaction, so both boundaries can be checked
	// at the exact stored timestamp without sleeping or racing the clock.
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	var atStartID int64
	if err := tx.QueryRow(t.Context(), `
		INSERT INTO sponsor_campaigns (sponsor, title, body, starts_at, ends_at, is_active)
		VALUES ('Supplier', 'Starts now', 'Offer', NOW(), NOW() + INTERVAL '1 hour', TRUE)
		RETURNING id
	`).Scan(&atStartID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO sponsor_campaigns (sponsor, title, body, starts_at, ends_at, is_active)
		VALUES ('Supplier', 'Ends now', 'Offer', NOW() - INTERVAL '1 hour', NOW(), TRUE)
	`); err != nil {
		t.Fatal(err)
	}
	got, err = Current(t.Context(), tx)
	if err != nil || got == nil || got.ID != atStartID {
		t.Fatalf("campaign at time boundary = %+v, want ID %d, err %v", got, atStartID, err)
	}
}
