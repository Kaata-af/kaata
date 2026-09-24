package tabs

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

// maxBody caps every JSON body here. The largest legitimate request is an
// append with a 500-char note; 8 KiB matches the vaults handler's guard.
const maxBody = 8 << 10

// Handler serves the /v1/tabs JSON routes and the /t/{token} page (view.go).
type Handler struct {
	svc          *Service
	webBaseURL   string // canonical site origin for chrome links (kaata.af)
	shareBaseURL string // origin the invite link + og:url resolve to (defaults to webBaseURL)
	apiBaseURL   string // backend's own public origin for the inline fetch; "" → relative
}

// NewHandler mirrors shared.NewHandler's three origins: the invite link is
// built from shareLinkBaseURL (SHARE_LINK_BASE_URL, falling back to
// WEB_BASE_URL) — never a hard-coded kaata.af — and the page's inline script
// fetches from apiBaseURL (PUBLIC_API_BASE_URL) or relatively when unset.
func NewHandler(svc *Service, webBaseURL, shareLinkBaseURL, apiBaseURL string) *Handler {
	web := strings.TrimRight(webBaseURL, "/")
	share := strings.TrimRight(shareLinkBaseURL, "/")
	if share == "" {
		share = web
	}
	return &Handler{
		svc:          svc,
		webBaseURL:   web,
		shareBaseURL: share,
		apiBaseURL:   strings.TrimRight(apiBaseURL, "/"),
	}
}

// inviteURL is D11's link: kaata.af/t/<b_token>, the page AND the credential.
func (h *Handler) inviteURL(token string) string {
	return h.shareBaseURL + "/t/" + token
}

// noStore marks a living-tab response uncacheable. shared.Handler serves
// bills with `public, max-age=300` because a bill is immutable; here an
// accept, dispute or void would otherwise stay invisible for five minutes
// behind any intermediary, and a cache could hand one party's view to the
// other. Set before any write so error responses carry it too.
func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
}

// mapServiceError returns (HTTP status, stable error_code, human message).
// error_code is the client's branch key — keep it stable even if messages
// change. ErrNotFound's triple is the uniform 404 (status, code AND message
// identical for every not-yours / unknown case).
func mapServiceError(err error) (int, string, string) {
	switch {
	case errors.Is(err, ErrAuthRequired):
		return http.StatusUnauthorized, "authentication_required", "authentication required"
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound, "tab_not_found", "tab not found"
	case errors.Is(err, ErrEntryNotFound):
		return http.StatusNotFound, "entry_not_found", "entry not found"
	case errors.Is(err, ErrStaleReview):
		return http.StatusConflict, "stale_review", err.Error()
	case errors.Is(err, ErrTabClosed):
		return http.StatusConflict, "tab_closed", err.Error()
	case errors.Is(err, ErrNotAuthor):
		return http.StatusForbidden, "not_author", err.Error()
	case errors.Is(err, ErrOwnEntry):
		return http.StatusForbidden, "own_entry", err.Error()
	case errors.Is(err, ErrAlreadyVoided):
		return http.StatusConflict, "already_voided", err.Error()
	case errors.Is(err, ErrIDTaken):
		return http.StatusConflict, "id_taken", err.Error()
	case errors.Is(err, ErrInvalidAmount):
		return http.StatusBadRequest, "invalid_amount", err.Error()
	case errors.Is(err, ErrInvalidDirection):
		return http.StatusBadRequest, "invalid_direction", err.Error()
	case errors.Is(err, ErrLabelRequired):
		return http.StatusBadRequest, "label_required", err.Error()
	case errors.Is(err, ErrInvalidLabel):
		return http.StatusBadRequest, "invalid_label", err.Error()
	case errors.Is(err, ErrInvalidNote):
		return http.StatusBadRequest, "invalid_note", err.Error()
	case errors.Is(err, ErrReasonRequired):
		return http.StatusBadRequest, "reason_required", err.Error()
	case errors.Is(err, ErrInvalidReason):
		return http.StatusBadRequest, "invalid_reason", err.Error()
	case errors.Is(err, ErrInvalidCurrency):
		return http.StatusBadRequest, "invalid_currency", err.Error()
	case errors.Is(err, ErrInvalidOccurredAt):
		return http.StatusBadRequest, "invalid_occurred_at", err.Error()
	case errors.Is(err, ErrSameKaata):
		return http.StatusConflict, "same_kaata", err.Error()
	case errors.Is(err, ErrAlreadyLinked):
		return http.StatusConflict, "already_linked", err.Error()
	case errors.Is(err, ErrCurrencyMismatch):
		return http.StatusConflict, "currency_mismatch", err.Error()
	case errors.Is(err, ErrRoleInsufficient):
		return http.StatusForbidden, "role_insufficient", err.Error()
	case errors.Is(err, ErrNotPartyA):
		return http.StatusForbidden, "not_party_a", err.Error()
	case errors.Is(err, ErrNotVaultMember):
		return http.StatusForbidden, "not_vault_member", err.Error()
	default:
		// Never leak err.Error() here — it may carry SQL.
		return http.StatusInternalServerError, "internal_error", "internal error"
	}
}

// writeServiceError maps and writes; the 500 arm logs the real cause.
func writeServiceError(w http.ResponseWriter, err error) {
	status, code, msg := mapServiceError(err)
	if status == http.StatusInternalServerError {
		log.Printf("tabs: %v", err)
	}
	httpx.ErrorCode(w, status, code, msg)
}

// decodeBody reads a small JSON body into dst; a decode failure is 400
// invalid_body and the caller returns.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_body", "invalid json body")
		return false
	}
	return true
}

// optionalUUID normalizes a nullable uuid field: nil / "" → nil, a
// well-formed uuid → itself, anything else → an error naming the field.
func optionalUUID(w http.ResponseWriter, field string, v *string) (*string, bool) {
	if v == nil || strings.TrimSpace(*v) == "" {
		return nil, true
	}
	s := strings.TrimSpace(*v)
	if _, err := uuid.Parse(s); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_body", field+" must be a uuid")
		return nil, false
	}
	return &s, true
}

// tabIDFromURL reads {tab_id}. A malformed id is the UNIFORM 404 rather than
// a 400: "unknown tab id" and "not a uuid" must be indistinguishable.
func tabIDFromURL(r *http.Request) (string, bool) {
	id := chi.URLParam(r, "tab_id")
	if _, err := uuid.Parse(id); err != nil {
		return "", false
	}
	return id, true
}

// partyOr404 resolves the caller for the URL's tab and writes the uniform
// 404 when it cannot. Any other failure is a 500.
func (h *Handler) partyOr404(w http.ResponseWriter, r *http.Request) (Party, bool) {
	tabID, ok := tabIDFromURL(r)
	if !ok {
		writeServiceError(w, ErrNotFound)
		return Party{}, false
	}
	p, err := h.resolveParty(r, tabID)
	if err != nil {
		writeServiceError(w, err)
		return Party{}, false
	}
	return p, true
}

// accountFromClaims returns the session account + install as nullable
// strings for the binding inputs.
func accountFromClaims(r *http.Request) (accountID, installID *string) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok || claims == nil {
		return nil, nil
	}
	acct := claims.AccountID
	return &acct, installIDFromClaims(claims)
}

// --------------------------------------------------------------------------
// Request bodies (§3.4)
// --------------------------------------------------------------------------

type openingRequest struct {
	Direction    string  `json:"direction"`
	Amount       string  `json:"amount"`
	Note         *string `json:"note"`
	OccurredAtMS int64   `json:"occurred_at_ms"`
}

type createRequest struct {
	LinkedAtMS     *int64          `json:"linked_at_ms"`
	Currency       string          `json:"currency"`
	Label          string          `json:"label"`
	VaultID        *string         `json:"vault_id"`
	RelationshipID *string         `json:"relationship_id"`
	Opening        *openingRequest `json:"opening"`
}

// CreateResponse — 201 for POST /v1/tabs. Both plaintext tokens appear here
// exactly once.
type CreateResponse struct {
	Tab         Tab     `json:"tab"`
	Entries     []Entry `json:"entries"`
	MyToken     string  `json:"my_token"`
	InviteToken string  `json:"invite_token"`
	InviteURL   string  `json:"invite_url"`
}

type joinRequest struct {
	LinkedAtMS     *int64  `json:"linked_at_ms"`
	Token          string  `json:"token"`
	Label          string  `json:"label"`
	VaultID        *string `json:"vault_id"`
	RelationshipID *string `json:"relationship_id"`
}

type bindRequest struct {
	LinkedAtMS     *int64  `json:"linked_at_ms"`
	Token          string  `json:"token"`
	VaultID        *string `json:"vault_id"`
	RelationshipID *string `json:"relationship_id"`
}

type labelRequest struct {
	Label string `json:"label"`
}

type appendRequest struct {
	ID           string  `json:"id"`
	Direction    string  `json:"direction"`
	Amount       string  `json:"amount"`
	Note         *string `json:"note"`
	OccurredAtMS int64   `json:"occurred_at_ms"`
}

type disputeRequest struct {
	ExpectedRev int64  `json:"expected_rev"`
	Reason      string `json:"reason"`
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

// Create — POST /v1/tabs. The caller becomes party 'a'; a session on the
// request binds the account (D10) so the phone can recover the tab later.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	if _, ok := auth.ClaimsFromContext(r.Context()); !ok {
		httpx.Error(w, 401, "authentication required")
		return
	}
	var req createRequest
	if !decodeBody(w, r, &req) {
		return
	}
	vaultID, ok := optionalUUID(w, "vault_id", req.VaultID)
	if !ok {
		return
	}
	relationshipID, ok := optionalUUID(w, "relationship_id", req.RelationshipID)
	if !ok {
		return
	}
	accountID, installID := accountFromClaims(r)
	in := CreateInput{
		LinkedAtMS:     req.LinkedAtMS,
		Currency:       req.Currency,
		Label:          req.Label,
		VaultID:        vaultID,
		RelationshipID: relationshipID,
		AccountID:      accountID,
		InstallID:      installID,
	}
	if req.Opening != nil {
		in.Opening = &OpeningInput{
			Direction:    req.Opening.Direction,
			Amount:       req.Opening.Amount,
			Note:         req.Opening.Note,
			OccurredAtMS: req.Opening.OccurredAtMS,
		}
	}
	res, err := h.svc.Create(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, CreateResponse{
		Tab:         res.Tab,
		Entries:     res.Entries,
		MyToken:     res.MyToken,
		InviteToken: res.InviteToken,
		InviteURL:   h.inviteURL(res.InviteToken),
	})
}

// Mine — GET /v1/tabs/mine (JWT only; 401 otherwise). Token callers have no
// "mine": a capability link is one tab.
func (h *Handler) Mine(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	res, err := h.svc.Mine(r.Context(), claims.AccountID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Get — GET /v1/tabs/{tab_id}?after_rev=N. Entries with rev > N; full=true
// when N is 0/absent so the client may replace its cache.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	var afterRev int64
	if raw := r.URL.Query().Get("after_rev"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_body", "after_rev must be an integer")
			return
		}
		afterRev = n
	}
	res, err := h.svc.Get(r.Context(), p, afterRev)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// ByToken resolves an invitation without putting its credential in an API URL.
func (h *Handler) ByToken(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, 401, "authentication required")
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	p, err := h.svc.PartyByToken(r.Context(), req.Token, "")
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if p.AccountBoundOnce || p.AccountID != nil || p.VaultID != nil {
		p, err = h.svc.partyByAccountRole(r.Context(), p.TabID, claims.AccountID, p.Role)
		if err != nil {
			writeServiceError(w, err)
			return
		}
	}
	res, err := h.svc.Get(r.Context(), p, 0)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Joining/binding needs TWO proofs: the invitation identifies the party,
// and a Bearer session identifies the account to bind. Body tokens are read
// only on these routes; a bad token never falls back to unrelated JWT access.
func (h *Handler) invitationParty(w http.ResponseWriter, r *http.Request, token string) (Party, bool) {
	claims, signedIn := auth.ClaimsFromContext(r.Context())
	if !signedIn {
		httpx.Error(w, 401, "authentication required")
		return Party{}, false
	}
	if token == "" {
		return h.partyOr404(w, r)
	}
	tabID, ok := tabIDFromURL(r)
	if !ok {
		writeServiceError(w, ErrNotFound)
		return Party{}, false
	}
	p, err := h.svc.PartyByToken(r.Context(), token, tabID)
	if err != nil {
		writeServiceError(w, err)
		return Party{}, false
	}
	if p.AccountBoundOnce || p.AccountID != nil || p.VaultID != nil {
		p, err = h.svc.partyByAccountRole(r.Context(), p.TabID, claims.AccountID, p.Role)
		if err != nil {
			writeServiceError(w, err)
			return Party{}, false
		}
	}
	return p, true
}

// Join — POST /v1/tabs/{tab_id}/join. Token = the caller's (B's invite
// link); a JWT on the request binds the account.
func (h *Handler) Join(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	var req joinRequest
	if !decodeBody(w, r, &req) {
		return
	}
	p, ok := h.invitationParty(w, r, req.Token)
	if !ok {
		return
	}
	vaultID, ok := optionalUUID(w, "vault_id", req.VaultID)
	if !ok {
		return
	}
	relationshipID, ok := optionalUUID(w, "relationship_id", req.RelationshipID)
	if !ok {
		return
	}
	accountID, installID := accountFromClaims(r)
	res, err := h.svc.Join(r.Context(), p, JoinInput{
		LinkedAtMS:     req.LinkedAtMS,
		Label:          req.Label,
		VaultID:        vaultID,
		RelationshipID: relationshipID,
		AccountID:      accountID,
		InstallID:      installID,
	})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Bind — POST /v1/tabs/{tab_id}/bind. Token + JWT → binds account_id /
// vault_id / relationship_id. 401 without a session.
func (h *Handler) Bind(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var req bindRequest
	if r.ContentLength != 0 && !decodeBody(w, r, &req) {
		return
	}
	p, ok := h.invitationParty(w, r, req.Token)
	if !ok {
		return
	}
	vaultID, ok := optionalUUID(w, "vault_id", req.VaultID)
	if !ok {
		return
	}
	relationshipID, ok := optionalUUID(w, "relationship_id", req.RelationshipID)
	if !ok {
		return
	}
	res, err := h.svc.Bind(r.Context(), p, BindInput{
		LinkedAtMS:     req.LinkedAtMS,
		AccountID:      claims.AccountID,
		InstallID:      installIDFromClaims(claims),
		VaultID:        vaultID,
		RelationshipID: relationshipID,
	})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Label — POST /v1/tabs/{tab_id}/label {label}.
func (h *Handler) Label(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	var req labelRequest
	if !decodeBody(w, r, &req) {
		return
	}
	res, err := h.svc.SetLabel(r.Context(), p, req.Label)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Append — POST /v1/tabs/{tab_id}/entries. 201 for a new row, 200 for an
// idempotent replay of the same client id.
func (h *Handler) Append(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	var req appendRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if _, err := uuid.Parse(req.ID); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_body", "id must be a uuid")
		return
	}
	res, err := h.svc.Append(r.Context(), p, AppendInput{
		ID:           req.ID,
		Direction:    req.Direction,
		Amount:       req.Amount,
		Note:         req.Note,
		OccurredAtMS: req.OccurredAtMS,
	})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	status := http.StatusOK
	if res.Created {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, EntryResponse{Entry: res.Entry, Tab: res.Tab, DuplicateHint: res.DuplicateHint})
}

// Accept — POST /v1/tabs/{tab_id}/entries/{id}/accept {}.
func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	var req disputeRequest
	if r.ContentLength != 0 && !decodeBody(w, r, &req) {
		return
	}
	res, err := h.svc.Accept(r.Context(), p, chi.URLParam(r, "id"), req.ExpectedRev)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Dispute — POST /v1/tabs/{tab_id}/entries/{id}/dispute {reason}.
func (h *Handler) Dispute(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	var req disputeRequest
	if !decodeBody(w, r, &req) {
		return
	}
	res, err := h.svc.Dispute(r.Context(), p, chi.URLParam(r, "id"), req.Reason, req.ExpectedRev)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Void — POST /v1/tabs/{tab_id}/entries/{id}/void {} → 201 {voided, void}.
func (h *Handler) Void(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	res, err := h.svc.Void(r.Context(), p, chi.URLParam(r, "id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, res)
}

// Close — POST /v1/tabs/{tab_id}/close {} → 200 TabResponse.
func (h *Handler) Close(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	res, err := h.svc.Close(r.Context(), p)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// RegenerateLink — POST /v1/tabs/{tab_id}/regenerate-link (party A only) →
// 200 {invite_url}. B's old link stops working immediately.
func (h *Handler) RegenerateLink(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	token, err := h.svc.RegenerateLink(r.Context(), p)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"invite_url": h.inviteURL(token)})
}
