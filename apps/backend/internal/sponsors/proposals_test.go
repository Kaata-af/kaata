package sponsors

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/db"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestProposalInputValidation(t *testing.T) {
	base := proposalInput{
		SubmissionID: uuid.NewString(), BusinessName: " Synthetic business ", ContactName: " Synthetic contact ",
		Phone: "+93700000001", Proposal: " Promote a new product ", BudgetAmount: "001250.5",
		BudgetCurrency: "AFN", AppLocale: "fa",
	}
	valid := base
	if err := valid.normalize(); err != nil || valid.BusinessName != "Synthetic business" || valid.BudgetAmount != "1250.50" {
		t.Fatalf("valid proposal normalization: %+v, %v", valid, err)
	}
	for _, tc := range []struct {
		name   string
		change func(*proposalInput)
	}{
		{"missing id", func(in *proposalInput) { in.SubmissionID = "" }},
		{"zero id", func(in *proposalInput) { in.SubmissionID = uuid.Nil.String() }},
		{"empty business", func(in *proposalInput) { in.BusinessName = " " }},
		{"long business", func(in *proposalInput) { in.BusinessName = strings.Repeat("ژ", 121) }},
		{"empty contact", func(in *proposalInput) { in.ContactName = "" }},
		{"long contact", func(in *proposalInput) { in.ContactName = strings.Repeat("x", 101) }},
		{"empty proposal", func(in *proposalInput) { in.Proposal = "" }},
		{"long proposal", func(in *proposalInput) { in.Proposal = strings.Repeat("ژ", 3001) }},
		{"NUL text", func(in *proposalInput) { in.Proposal = "text\x00" }},
		{"national phone", func(in *proposalInput) { in.Phone = "0700000001" }},
		{"short phone", func(in *proposalInput) { in.Phone = "+123456" }},
		{"long phone", func(in *proposalInput) { in.Phone = "+1234567890123456" }},
		{"zero phone country", func(in *proposalInput) { in.Phone = "+012345678" }},
		{"empty budget", func(in *proposalInput) { in.BudgetAmount = "" }},
		{"zero budget", func(in *proposalInput) { in.BudgetAmount = "0.00" }},
		{"negative budget", func(in *proposalInput) { in.BudgetAmount = "-1" }},
		{"fraction precision", func(in *proposalInput) { in.BudgetAmount = "1.001" }},
		{"huge budget", func(in *proposalInput) { in.BudgetAmount = "1000000000000" }},
		{"budget exponent", func(in *proposalInput) { in.BudgetAmount = "1e100000000" }},
		{"fraction expression", func(in *proposalInput) { in.BudgetAmount = "1/2" }},
		{"currency case", func(in *proposalInput) { in.BudgetCurrency = "afn" }},
		{"currency format", func(in *proposalInput) { in.BudgetCurrency = "ABCD" }},
		{"long duration", func(in *proposalInput) { in.Duration = strings.Repeat("x", 121) }},
		{"bad locale", func(in *proposalInput) { in.AppLocale = "unknown" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := base
			tc.change(&input)
			if err := input.normalize(); err == nil {
				t.Fatal("invalid proposal was accepted")
			}
		})
	}
}

func TestProposalTextOfferValidation(t *testing.T) {
	base := proposalInput{
		SubmissionID: uuid.NewString(), Proposal: "Promote my trade", BudgetOffer: "  ۵۰۰۰ افغانی برای دو هفته\nقابل مذاکره  ", AppLocale: "fa",
	}
	valid := base
	if err := valid.normalize(); err != nil || valid.BudgetOffer != "۵۰۰۰ افغانی برای دو هفته\nقابل مذاکره" {
		t.Fatalf("free text offer normalization: %+v, %v", valid, err)
	}
	for _, tc := range []struct {
		name   string
		change func(*proposalInput)
	}{
		{"missing offer", func(in *proposalInput) { in.BudgetOffer = " " }},
		{"long offer", func(in *proposalInput) { in.BudgetOffer = strings.Repeat("ژ", 1001) }},
		{"NUL offer", func(in *proposalInput) { in.BudgetOffer = "Offer\x00" }},
		{"mixed amount", func(in *proposalInput) { in.BudgetAmount = "50" }},
		{"mixed currency", func(in *proposalInput) { in.BudgetCurrency = "AFN" }},
		{"invalid supplied phone", func(in *proposalInput) { in.Phone = "0700000001" }},
		{"long supplied business", func(in *proposalInput) { in.BusinessName = strings.Repeat("ژ", 121) }},
		{"long supplied contact", func(in *proposalInput) { in.ContactName = strings.Repeat("ژ", 101) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := base
			tc.change(&input)
			if err := input.normalize(); err == nil {
				t.Fatal("invalid free text proposal was accepted")
			}
		})
	}
	valid.BudgetOffer = strings.Repeat("ژ", 1000)
	valid.Phone = "+93700000001"
	if err := valid.normalize(); err != nil {
		t.Fatal(err)
	}
}

func TestProposalOfferMigrationKeepsLegacyReplay(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	// Recreate only this standalone table as it existed before migration 080,
	// then run the real migrator with a preexisting legacy proposal.
	if _, err := pool.Exec(ctx, `DROP TABLE sponsor_proposals; DELETE FROM schema_migrations WHERE name='080_sponsor_proposal_offers.sql'`); err != nil {
		t.Fatal(err)
	}
	previous, err := os.ReadFile("../db/migrations/079_sponsor_proposals.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(previous)); err != nil {
		t.Fatal(err)
	}
	input := proposalInput{SubmissionID: uuid.NewString(), BusinessName: "Existing business", ContactName: "Existing contact", Phone: "+93700000001", Proposal: "Existing proposal", BudgetAmount: "1250.50", BudgetCurrency: "AFN", Duration: "Two weeks", AppLocale: "fa"}
	var original proposalReceipt
	if err := pool.QueryRow(ctx, `INSERT INTO sponsor_proposals (submission_id,business_name,contact_name,phone,proposal,budget_amount,budget_currency,duration,app_locale) VALUES ($1::uuid,$2,$3,$4,$5,$6::numeric,$7,$8,$9) RETURNING id, submission_id::text, created_at`, input.SubmissionID, input.BusinessName, input.ContactName, input.Phone, input.Proposal, input.BudgetAmount, input.BudgetCurrency, input.Duration, input.AppLocale).Scan(&original.ID, &original.SubmissionID, &original.CreatedAt); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	NewHandler(pool).SubmitProposal(response, httptest.NewRequest(http.MethodPost, "/v1/sponsor-proposals", strings.NewReader(string(body))))
	var replay proposalReceipt
	if err := json.Unmarshal(response.Body.Bytes(), &replay); err != nil || response.Code != http.StatusOK || replay.ID != original.ID || replay.SubmissionID != original.SubmissionID || !replay.CreatedAt.Equal(original.CreatedAt) {
		t.Fatalf("legacy replay changed after migration: %d %s (%v)", response.Code, response.Body, err)
	}
	var amount, currency, offer string
	if err := pool.QueryRow(ctx, `SELECT budget_amount::text,budget_currency,budget_offer FROM sponsor_proposals WHERE id=$1`, original.ID).Scan(&amount, &currency, &offer); err != nil || amount != "1250.50" || currency != "AFN" || offer != "" {
		t.Fatalf("legacy fields changed: %q %q %q (%v)", amount, currency, offer, err)
	}
}

func TestProposalLifecycle(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	h := NewHandler(pool)
	router := chi.NewRouter()
	const publicPath = "/v1/sponsor-proposals"
	const adminPath = "/v1/admin/sponsor-proposals"
	router.With(httpx.RateLimitPerIP(60, time.Hour)).Post(publicPath, h.SubmitProposal)
	router.Group(func(r chi.Router) {
		r.Use(httpx.AdminKeyMiddleware("test-admin-key"))
		r.Get(adminPath, h.ListProposals)
		r.Put(adminPath+"/{id}", h.UpdateProposal)
	})
	request := func(method, path, key, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = "192.0.2.1:12345"
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	check := func(w *httptest.ResponseRecorder, want int) {
		t.Helper()
		if w.Code != want {
			t.Fatalf("status %d, want %d: %s", w.Code, want, w.Body)
		}
	}
	input := proposalInput{
		SubmissionID: uuid.NewString(), BusinessName: "Synthetic business", ContactName: "Synthetic contact",
		Phone: "+93700000001", Proposal: "Promote a new product", BudgetAmount: "1250.5",
		BudgetCurrency: "AFN", Duration: "One month", AppLocale: "fa",
	}
	encode := func(value any) string {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	body := encode(input)
	check(request(http.MethodGet, adminPath, "", ""), http.StatusUnauthorized)
	check(request(http.MethodGet, adminPath, "wrong-key", ""), http.StatusUnauthorized)
	first := request(http.MethodPost, publicPath, "", body)
	check(first, http.StatusCreated)
	var receipt proposalReceipt
	if err := json.Unmarshal(first.Body.Bytes(), &receipt); err != nil || receipt.ID <= 0 || receipt.SubmissionID != input.SubmissionID || receipt.CreatedAt.IsZero() {
		t.Fatalf("invalid receipt: %s (%v)", first.Body, err)
	}
	retry := request(http.MethodPost, publicPath, "", body)
	check(retry, http.StatusOK)
	if retry.Body.String() != first.Body.String() {
		t.Fatalf("retry changed receipt: %s / %s", first.Body, retry.Body)
	}
	changed := input
	changed.Proposal = "Different proposal"
	check(request(http.MethodPost, publicPath, "", encode(changed)), http.StatusConflict)
	check(request(http.MethodPost, publicPath, "", body+" {}"), http.StatusBadRequest)
	check(request(http.MethodPost, publicPath, "", strings.TrimSuffix(body, "}")+`,"unknown":true}`), http.StatusBadRequest)
	check(request(http.MethodPost, publicPath, "", `{"proposal":"`+strings.Repeat("x", 33<<10)+`"}`), http.StatusBadRequest)
	list := request(http.MethodGet, adminPath, "test-admin-key", "")
	check(list, http.StatusOK)
	var result struct {
		Proposals []Proposal `json:"proposals"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &result); err != nil || len(result.Proposals) != 1 {
		t.Fatalf("proposal list: %s (%v)", list.Body, err)
	}
	p := result.Proposals[0]
	if p.BudgetAmount != "1250.50" || p.Phone != input.Phone || p.Status != "new" || p.Duration != input.Duration {
		t.Fatalf("stored proposal mismatch: %+v", p)
	}
	path := fmt.Sprintf("%s/%d", adminPath, p.ID)
	edit := func(status, notes string, revision time.Time) string {
		return encode(map[string]any{"status": status, "notes": notes, "expected_updated_at": revision})
	}
	check(request(http.MethodPut, path, "", edit("reviewing", "", p.UpdatedAt)), http.StatusUnauthorized)
	check(request(http.MethodPut, path, "test-admin-key", edit("invalid", "", p.UpdatedAt)), http.StatusBadRequest)
	check(request(http.MethodPut, path, "test-admin-key", edit("new", strings.Repeat("x", 5001), p.UpdatedAt)), http.StatusBadRequest)
	check(request(http.MethodPut, path, "test-admin-key", `{"status":"reviewing"}`), http.StatusBadRequest)
	updated := request(http.MethodPut, path, "test-admin-key", edit("reviewing", "Call back tomorrow", p.UpdatedAt))
	check(updated, http.StatusOK)
	var current Proposal
	if err := json.Unmarshal(updated.Body.Bytes(), &current); err != nil || current.Notes != "Call back tomorrow" || !current.UpdatedAt.After(p.UpdatedAt) {
		t.Fatalf("invalid update: %s (%v)", updated.Body, err)
	}
	check(request(http.MethodPut, path, "test-admin-key", edit("declined", "stale notes", p.UpdatedAt)), http.StatusConflict)
	archived := request(http.MethodPut, path, "test-admin-key", edit("archived", current.Notes, current.UpdatedAt))
	check(archived, http.StatusOK)
	if err := json.Unmarshal(archived.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	check(request(http.MethodPut, path, "test-admin-key", edit("new", current.Notes, current.UpdatedAt)), http.StatusOK)
	check(request(http.MethodPost, publicPath, "", body), http.StatusOK)

	// Concurrent retries all refer to one durable row and one stable receipt.
	input.SubmissionID = uuid.NewString()
	concurrentBody := encode(input)
	var wait sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 8)
	for range 8 {
		wait.Go(func() { responses <- request(http.MethodPost, publicPath, "", concurrentBody) })
	}
	wait.Wait()
	close(responses)
	var concurrentID int64
	for response := range responses {
		if response.Code != http.StatusOK && response.Code != http.StatusCreated {
			t.Fatalf("concurrent retry failed: %d %s", response.Code, response.Body)
		}
		var got proposalReceipt
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if concurrentID != 0 && concurrentID != got.ID {
			t.Fatal("concurrent retries created duplicate proposals")
		}
		concurrentID = got.ID
	}
	var count int
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM sponsor_proposals").Scan(&count); err != nil || count != 2 {
		t.Fatalf("saved rows %d, want 2: %v", count, err)
	}
	free := proposalInput{SubmissionID: uuid.NewString(), Proposal: "Promote a new trade", BudgetOffer: "۵۰۰۰ افغانی برای دو هفته\nقابل مذاکره", AppLocale: "fa"}
	freeBody := encode(free)
	freeFirst := request(http.MethodPost, publicPath, "", freeBody)
	check(freeFirst, http.StatusCreated)
	freeReplay := request(http.MethodPost, publicPath, "", freeBody)
	check(freeReplay, http.StatusOK)
	if freeFirst.Body.String() != freeReplay.Body.String() {
		t.Fatal("free text retry changed receipt")
	}
	changedFree := free
	changedFree.BudgetOffer = "Another offer"
	check(request(http.MethodPost, publicPath, "", encode(changedFree)), http.StatusConflict)
	list = request(http.MethodGet, adminPath, "test-admin-key", "")
	check(list, http.StatusOK)
	if err := json.Unmarshal(list.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, saved := range result.Proposals {
		if saved.SubmissionID == free.SubmissionID {
			found = true
			if saved.BudgetOffer != free.BudgetOffer || saved.BudgetAmount != "" || saved.BudgetCurrency != "" || saved.BusinessName != "" || saved.ContactName != "" || saved.Phone != "" {
				t.Fatalf("free text snapshot changed: %+v", saved)
			}
		}
	}
	if !found {
		t.Fatal("free text proposal missing from admin list")
	}
	var limited *httptest.ResponseRecorder
	for range 61 {
		limited = request(http.MethodPost, publicPath, "", body)
		if limited.Code == http.StatusTooManyRequests {
			break
		}
	}
	check(limited, http.StatusTooManyRequests)
	if limited.Header().Get("Retry-After") == "" {
		t.Fatal("public proposal limit did not give a retry delay")
	}
}
