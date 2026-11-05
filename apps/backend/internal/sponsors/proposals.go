package sponsors

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/httpx"
)

type proposalInput struct {
	SubmissionID   string `json:"submission_id"`
	BusinessName   string `json:"business_name"`
	ContactName    string `json:"contact_name"`
	Phone          string `json:"phone"`
	Proposal       string `json:"proposal"`
	BudgetAmount   string `json:"budget_amount"`
	BudgetCurrency string `json:"budget_currency"`
	BudgetOffer    string `json:"budget_offer"`
	Duration       string `json:"duration"`
	AppLocale      string `json:"app_locale"`
}

type Proposal struct {
	ID int64 `json:"id"`
	proposalInput
	Status    string    `json:"status"`
	Notes     string    `json:"notes"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type proposalReceipt struct {
	ID           int64     `json:"id"`
	SubmissionID string    `json:"submission_id"`
	CreatedAt    time.Time `json:"created_at"`
}

var proposalPhonePattern = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)
var proposalBudgetPattern = regexp.MustCompile(`^[0-9]{1,12}(\.[0-9]{1,2})?$`)

func (in *proposalInput) normalize() error {
	id, err := uuid.Parse(strings.TrimSpace(in.SubmissionID))
	if err != nil || id == uuid.Nil {
		return errors.New("submission_id must be a nonzero UUID")
	}
	in.SubmissionID = id.String()
	in.BusinessName = strings.TrimSpace(in.BusinessName)
	in.ContactName = strings.TrimSpace(in.ContactName)
	in.Phone = strings.TrimSpace(in.Phone)
	in.Proposal = strings.TrimSpace(in.Proposal)
	in.BudgetAmount = strings.TrimSpace(in.BudgetAmount)
	in.BudgetCurrency = strings.TrimSpace(in.BudgetCurrency)
	in.BudgetOffer = strings.TrimSpace(in.BudgetOffer)
	in.Duration = strings.TrimSpace(in.Duration)
	in.AppLocale = strings.TrimSpace(in.AppLocale)
	freeTextOffer := in.BudgetOffer != ""
	for _, field := range []struct {
		name, value string
		max         int
	}{
		{"business_name", in.BusinessName, 120},
		{"contact_name", in.ContactName, 100},
	} {
		if (!freeTextOffer && field.value == "") || !validProposalText(field.value, field.max) {
			return fmt.Errorf("%s must contain between 1 and %d characters", field.name, field.max)
		}
	}
	if in.Proposal == "" || !validProposalText(in.Proposal, 3000) {
		return errors.New("proposal must contain between 1 and 3000 characters")
	}
	if (!freeTextOffer || in.Phone != "") && !proposalPhonePattern.MatchString(in.Phone) {
		return errors.New("phone must include its international country code")
	}
	if freeTextOffer {
		if !validProposalText(in.BudgetOffer, 1000) {
			return errors.New("budget_offer must contain at most 1000 characters")
		}
		if in.BudgetAmount != "" || in.BudgetCurrency != "" {
			return errors.New("provide either budget_offer or a budget amount and currency")
		}
	} else {
		if !proposalBudgetPattern.MatchString(in.BudgetAmount) {
			return errors.New("budget_amount must be positive with up to 12 whole digits and 2 decimal places")
		}
		minor, err := credit.Minor(in.BudgetAmount)
		if err != nil || minor <= 0 {
			return errors.New("budget_amount must be positive with up to 12 whole digits and 2 decimal places")
		}
		in.BudgetAmount = fmt.Sprintf("%d.%02d", minor/100, minor%100)
		if !credit.ValidCurrency(in.BudgetCurrency) {
			return errors.New("budget_currency must be a three-letter uppercase currency code")
		}
	}
	if !validProposalText(in.Duration, 120) {
		return errors.New("duration must contain at most 120 characters")
	}
	if in.AppLocale != "en" && in.AppLocale != "fa" && in.AppLocale != "ps" {
		return errors.New("app_locale must be en, fa or ps")
	}
	return nil
}

func validProposalText(text string, max int) bool {
	return utf8.ValidString(text) && utf8.RuneCountInString(text) <= max && !strings.ContainsRune(text, 0)
}

const proposalColumns = `id, submission_id::text, business_name, contact_name, phone, proposal,
	COALESCE(budget_amount::text, ''), COALESCE(budget_currency, ''), budget_offer,
	duration, app_locale, status, notes, created_at, updated_at`

func (p *Proposal) scan(row pgx.Row) error {
	return row.Scan(&p.ID, &p.SubmissionID, &p.BusinessName, &p.ContactName, &p.Phone, &p.Proposal,
		&p.BudgetAmount, &p.BudgetCurrency, &p.BudgetOffer, &p.Duration, &p.AppLocale, &p.Status, &p.Notes, &p.CreatedAt, &p.UpdatedAt)
}

func decodeProposal(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(dst) != nil || decoder.Decode(new(json.RawMessage)) != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid proposal data")
		return false
	}
	return true
}

// SubmitProposal saves one immutable proposal. The caller retains submission_id
// across retries, so a lost response cannot create another proposal.
func (h *Handler) SubmitProposal(w http.ResponseWriter, r *http.Request) {
	var input proposalInput
	if !decodeProposal(w, r, &input) {
		return
	}
	if err := input.normalize(); err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	args := []any{input.SubmissionID, input.BusinessName, input.ContactName, input.Phone, input.Proposal,
		input.BudgetAmount, input.BudgetCurrency, input.BudgetOffer, input.Duration, input.AppLocale}
	var receipt proposalReceipt
	err := h.pool.QueryRow(r.Context(), `
		INSERT INTO sponsor_proposals
		(submission_id, business_name, contact_name, phone, proposal, budget_amount, budget_currency, budget_offer, duration, app_locale)
		SELECT $1::uuid, $2, $3, $4, $5, NULLIF($6, '')::numeric, NULLIF($7, ''), $8, $9, $10
		WHERE $9 <> ''
		ON CONFLICT (submission_id) DO NOTHING
		RETURNING id, submission_id::text, created_at
	`, args...).Scan(&receipt.ID, &receipt.SubmissionID, &receipt.CreatedAt)
	status := http.StatusCreated
	if errors.Is(err, pgx.ErrNoRows) {
		// A separate statement sees the committed winner of a concurrent INSERT.
		// Compare only the immutable submitted fields, independent of admin edits.
		status = http.StatusOK
		err = h.pool.QueryRow(r.Context(), `
			SELECT id, submission_id::text, created_at FROM sponsor_proposals
			WHERE submission_id=$1::uuid AND business_name=$2 AND contact_name=$3 AND phone=$4
			AND proposal=$5 AND budget_amount IS NOT DISTINCT FROM NULLIF($6, '')::numeric
			AND budget_currency IS NOT DISTINCT FROM NULLIF($7, '') AND budget_offer=$8 AND duration=$9 AND app_locale=$10
		`, args...).Scan(&receipt.ID, &receipt.SubmissionID, &receipt.CreatedAt)
	}
	if errors.Is(err, pgx.ErrNoRows) && input.Duration == "" {
		// Previously accepted proposals may have no duration. An exact retry
		// above keeps its receipt, while new proposals must provide a duration.
		var exists bool
		if lookupErr := h.pool.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM sponsor_proposals WHERE submission_id=$1::uuid)`, input.SubmissionID).Scan(&exists); lookupErr != nil {
			err = lookupErr
		} else if !exists {
			httpx.Error(w, http.StatusBadRequest, "duration is required")
			return
		}
	}
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, http.StatusConflict, "submission_id has already been used for a different proposal")
	case err != nil:
		httpx.Error(w, http.StatusInternalServerError, "could not save proposal; retry with the same submission_id")
	default:
		httpx.JSON(w, status, receipt)
	}
}

func (h *Handler) ListProposals(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	rows, err := h.pool.Query(r.Context(), `SELECT `+proposalColumns+` FROM sponsor_proposals ORDER BY created_at DESC, id DESC`)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not list proposals")
		return
	}
	proposals, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Proposal, error) {
		var proposal Proposal
		err := proposal.scan(row)
		return proposal, err
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "could not list proposals")
		return
	}
	if proposals == nil {
		proposals = []Proposal{}
	}
	httpx.JSON(w, http.StatusOK, struct {
		Proposals []Proposal `json:"proposals"`
	}{Proposals: proposals})
}

func (h *Handler) UpdateProposal(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid proposal ID")
		return
	}
	var input struct {
		Status            string    `json:"status"`
		Notes             string    `json:"notes"`
		ExpectedUpdatedAt time.Time `json:"expected_updated_at"`
	}
	if !decodeProposal(w, r, &input) {
		return
	}
	input.Notes = strings.TrimSpace(input.Notes)
	if !validProposalText(input.Notes, 5000) {
		httpx.Error(w, http.StatusBadRequest, "notes must contain at most 5000 characters")
		return
	}
	switch input.Status {
	case "new", "reviewing", "contacted", "accepted", "declined", "archived":
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid proposal status")
		return
	}
	if input.ExpectedUpdatedAt.IsZero() || !input.ExpectedUpdatedAt.Equal(input.ExpectedUpdatedAt.Truncate(time.Microsecond)) {
		httpx.Error(w, http.StatusBadRequest, "provide the proposal's current updated_at timestamp as expected_updated_at")
		return
	}
	var proposal Proposal
	err = proposal.scan(h.pool.QueryRow(r.Context(), `
		UPDATE sponsor_proposals SET status=$1, notes=$2,
		updated_at=GREATEST(NOW(), updated_at + INTERVAL '1 microsecond')
		WHERE id=$3 AND updated_at=$4
		RETURNING `+proposalColumns, input.Status, input.Notes, id, input.ExpectedUpdatedAt))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, http.StatusConflict, "proposal has changed or is missing. Refresh the proposal list and try again.")
	case err != nil:
		httpx.Error(w, http.StatusInternalServerError, "could not update proposal")
	default:
		httpx.JSON(w, http.StatusOK, proposal)
	}
}
