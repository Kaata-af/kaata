package vaults

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

type createRequest struct {
	VaultID     string `json:"vault_id"`
	Name        string `json:"name"`
	Currency    string `json:"currency,omitempty"`
	CreatedAtMS int64  `json:"created_at_ms,omitempty"`
	// VaultTrustAnchorPubkey — Phase 7 local-CA mesh trust anchor.
	//
	// base64-encoded 32-byte Ed25519 public key (44 chars). Optional;
	// omit to keep the vault server-anchored (Phase 5 behavior). When
	// present, the handler decodes and validates length=32 before
	// forwarding to the service. Phase 7 mobile clients send this
	// unconditionally; older clients omit it (back-compat path).
	VaultTrustAnchorPubkey string `json:"vault_trust_anchor_pubkey,omitempty"`
}

// Create — POST /v1/vaults (PROTECTED).
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.VaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}
	if req.Name == "" {
		httpx.Error(w, http.StatusBadRequest, "name is required")
		return
	}

	// Phase 7: decode the optional vault_trust_anchor_pubkey field. nil
	// means "server-anchored" (Phase 5 back-compat). A non-empty value
	// must decode to exactly 32 bytes (Ed25519 pubkey). We accept either
	// standard or URL-safe base64 because the mobile pair-QR encoder uses
	// the URL-safe form while POST /v1/vaults uses the standard form.
	var trustAnchorBytes []byte
	if req.VaultTrustAnchorPubkey != "" {
		decoded, derr := base64.StdEncoding.DecodeString(req.VaultTrustAnchorPubkey)
		if derr != nil {
			decoded, derr = base64.RawURLEncoding.DecodeString(req.VaultTrustAnchorPubkey)
		}
		if derr != nil || len(decoded) != 32 {
			httpx.Error(w, http.StatusBadRequest,
				"vault_trust_anchor_pubkey must be base64-encoded 32-byte Ed25519 pubkey")
			return
		}
		trustAnchorBytes = decoded
	}

	res, err := h.svc.Create(r.Context(), CreateInput{
		AccountID:              claims.AccountID,
		VaultID:                req.VaultID,
		Name:                   req.Name,
		Currency:               req.Currency,
		CreatedAtMS:            req.CreatedAtMS,
		VaultTrustAnchorPubkey: trustAnchorBytes,
	})
	if err != nil {
		if errors.Is(err, ErrVaultCollision) {
			httpx.Error(w, http.StatusConflict, err.Error())
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "vault registration failed")
		return
	}
	httpx.JSON(w, http.StatusCreated, res)
}

// ---------------------------------------------------------------------------
// Phase 4 routes
// ---------------------------------------------------------------------------

func mapServiceError(err error) (int, string) {
	switch {
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound, "vault not found"
	case errors.Is(err, ErrNotMember):
		return http.StatusForbidden, "not a member of this vault"
	case errors.Is(err, ErrNotOwner):
		return http.StatusForbidden, "owner role required"
	case errors.Is(err, ErrLastOwner):
		return http.StatusConflict, err.Error()
	case errors.Is(err, ErrTargetNotMember):
		return http.StatusNotFound, "target account is not a member of this vault"
	case errors.Is(err, ErrAlreadyArchived):
		return http.StatusConflict, "vault is already archived"
	case errors.Is(err, ErrNotArchived):
		return http.StatusConflict, "vault is not archived"
	case errors.Is(err, ErrVaultPurged):
		// 410 Gone is the semantically precise code: the resource
		// existed, was deleted, and is never coming back.
		return http.StatusGone, err.Error()
	case errors.Is(err, ErrInvalidRole),
		errors.Is(err, ErrInvalidDemote),
		errors.Is(err, ErrInvalidEmail),
		errors.Is(err, ErrSelfTransfer):
		return http.StatusBadRequest, err.Error()
	case errors.Is(err, ErrInvitePending):
		return http.StatusConflict, err.Error()
	case errors.Is(err, ErrTooManyPendingInvites):
		return http.StatusTooManyRequests, err.Error()
	case errors.Is(err, ErrInviteNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, ErrInviteEmailMismatch):
		// SECURITY: collapsed to the same 404 response as ErrInviteNotFound
		// so an attacker holding a stolen-but-stale token cannot use the
		// email-mismatch arm to confirm the token is real. The signed-in
		// caller whose email does not match the invitation sees the same
		// shape as if the token had been revoked or expired. UX cost: a
		// legitimate user signed in with the wrong Google account gets a
		// generic "invite not found" — acceptable because the pending-invites
		// list (`/v1/vaults/invites/pending`) already shows them the binding
		// is to a different email.
		return http.StatusNotFound, "invite not found"
	case errors.Is(err, ErrInviteAutoRevoked):
		return http.StatusTooManyRequests, err.Error()
	case errors.Is(err, ErrInviteRateLimited):
		return http.StatusTooManyRequests, err.Error()
	default:
		return http.StatusInternalServerError, "internal error"
	}
}

func claimsOrUnauthorized(w http.ResponseWriter, r *http.Request) *auth.SessionClaims {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return nil
	}
	return claims
}

func vaultIDFromURL(w http.ResponseWriter, r *http.Request) string {
	id := chi.URLParam(r, "vault_id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return ""
	}
	return id
}

func accountIDFromURL(w http.ResponseWriter, r *http.Request) string {
	id := chi.URLParam(r, "account_id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Error(w, http.StatusBadRequest, "account_id must be a uuid")
		return ""
	}
	return id
}

// List — GET /v1/vaults
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaults, err := h.svc.List(r.Context(), claims.AccountID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to list vaults")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"vaults": vaults})
}

type updateRequest struct {
	Name     *string `json:"name,omitempty"`
	Currency *string `json:"currency,omitempty"`
}

// Update — PATCH /v1/vaults/:vault_id
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req updateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}

	res, err := h.svc.Update(r.Context(), UpdateInput{
		AccountID: claims.AccountID,
		VaultID:   vaultID,
		Name:      req.Name,
		Currency:  req.Currency,
	})
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Archive — POST /v1/vaults/:vault_id/archive
func (h *Handler) Archive(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	res, err := h.svc.Archive(r.Context(), vaultID, claims.AccountID)
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	if res.Status == "pending" {
		httpx.JSON(w, http.StatusAccepted, res)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// Unarchive — POST /v1/vaults/:vault_id/unarchive
//
// Owner-only. Lifts a soft-delete within the 30-day grace window.
// Returns 200 with the new vault_epoch, 410 Gone if the vault has been
// purged, 409 if it is not currently archived.
func (h *Handler) Unarchive(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	epoch, err := h.svc.Unarchive(r.Context(), vaultID, claims.AccountID)
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"vault_id": vaultID, "vault_epoch": epoch,
	})
}

// Leave — POST /v1/vaults/:vault_id/leave
func (h *Handler) Leave(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	epoch, err := h.svc.Leave(r.Context(), vaultID, claims.AccountID)
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"vault_id": vaultID, "vault_epoch": epoch,
	})
}

type transferRequest struct {
	ToAccountID  string `json:"to_account_id"`
	DemoteSelfTo string `json:"demote_self_to"`
}

// TransferOwnership — POST /v1/vaults/:vault_id/transfer-ownership
func (h *Handler) TransferOwnership(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req transferRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.ToAccountID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "to_account_id must be a uuid")
		return
	}

	epoch, err := h.svc.TransferOwnership(r.Context(), TransferInput{
		AccountID:    claims.AccountID,
		VaultID:      vaultID,
		ToAccountID:  req.ToAccountID,
		DemoteSelfTo: req.DemoteSelfTo,
	})
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"vault_id": vaultID, "vault_epoch": epoch})
}

type setRoleRequest struct {
	Role string `json:"role"`
}

// SetMemberRole — POST /v1/vaults/:vault_id/members/:account_id/role
func (h *Handler) SetMemberRole(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	targetID := accountIDFromURL(w, r)
	if targetID == "" {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req setRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}

	epoch, err := h.svc.SetMemberRole(r.Context(), vaultID, claims.AccountID, targetID, req.Role)
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"vault_id": vaultID, "account_id": targetID, "role": req.Role, "vault_epoch": epoch,
	})
}

type revokeRequest struct {
	Reason string `json:"reason,omitempty"`
}

// RevokeMember — POST /v1/vaults/:vault_id/members/:account_id/revoke
func (h *Handler) RevokeMember(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	targetID := accountIDFromURL(w, r)
	if targetID == "" {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req revokeRequest
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid json body")
			return
		}
	}

	epoch, err := h.svc.RevokeMember(r.Context(), RevokeInput{
		VaultID: vaultID, CallerID: claims.AccountID,
		TargetID: targetID, RevokedReason: req.Reason,
	})
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"vault_id": vaultID, "account_id": targetID, "vault_epoch": epoch,
	})
}

// AuditLog — GET /v1/vaults/:vault_id/audit-log
func (h *Handler) AuditLog(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}

	var sinceID int64
	if raw := r.URL.Query().Get("since_id"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			httpx.Error(w, http.StatusBadRequest, "since_id must be a non-negative integer")
			return
		}
		sinceID = n
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			httpx.Error(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = n
	}

	page, err := h.svc.AuditLog(r.Context(), vaultID, claims.AccountID, sinceID, limit)
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, page)
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

type createInviteRequest struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

type createInviteResponse struct {
	InviteURL   string `json:"invite_url"`
	InviteEmail string `json:"invite_email"`
	ExpiresAt   string `json:"expires_at"`
}

// CreateInvite — POST /v1/vaults/{vault_id}/invites
func (h *Handler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req createInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}

	res, err := h.svc.CreateInvite(r.Context(), CreateInviteInput{
		VaultID: vaultID, InviterAccID: claims.AccountID,
		Email: req.Email, Role: req.Role,
	})
	if err != nil {
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusCreated, createInviteResponse{
		InviteURL:   res.InviteURL,
		InviteEmail: res.InviteEmail,
		ExpiresAt:   res.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

type acceptInviteRequest struct {
	Token     string `json:"token"`
	InstallID string `json:"install_id"`
}

// AcceptInvite — POST /v1/vaults/invites/accept
func (h *Handler) AcceptInvite(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var req acceptInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if req.Token == "" {
		httpx.Error(w, http.StatusBadRequest, "token is required")
		return
	}

	res, err := h.svc.AcceptInvite(r.Context(), AcceptInviteInput{
		Token: req.Token, AccountID: claims.AccountID, InstallID: req.InstallID,
	})
	if err != nil {
		// NB: no Retry-After header on ErrInviteRateLimited. The soft-cap
		// is cumulative on the token (not a rolling window) so we cannot
		// promise a moment at which retry will succeed — the inviter must
		// re-issue the invite. Pre-fix this returned "Retry-After: 3600",
		// which was a lie and encouraged clients to spin pointlessly.
		status, msg := mapServiceError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

// pendingInviteRow intentionally omits invite_token after the Phase 4.1
// hash migration. The device already stores the plaintext locally in
// pending_invitations.invite_token (received via the inviter's share-link
// side channel); the server can no longer regenerate it. To accept, the
// device sends its locally-stored plaintext to POST /v1/vaults/invites/accept.
type pendingInviteRow struct {
	VaultID      string `json:"vault_id"`
	VaultName    string `json:"vault_name"`
	InviterEmail string `json:"inviter_email"`
	InviterName  string `json:"inviter_name"`
	Role         string `json:"role"`
	InvitedAt    string `json:"invited_at"`
	ExpiresAt    string `json:"expires_at"`
}

// PendingInvites — GET /v1/vaults/invites/pending
func (h *Handler) PendingInvites(w http.ResponseWriter, r *http.Request) {
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	invites, err := h.svc.ListPendingInvites(r.Context(), claims.AccountID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "list pending invites failed")
		return
	}
	out := make([]pendingInviteRow, 0, len(invites))
	for _, p := range invites {
		out = append(out, pendingInviteRow{
			VaultID:      p.VaultID,
			VaultName:    p.VaultName,
			InviterEmail: p.InviterEmail,
			InviterName:  p.InviterName,
			Role:         p.Role,
			InvitedAt:    p.InvitedAt.UTC().Format(time.RFC3339),
			ExpiresAt:    p.ExpiresAt.UTC().Format(time.RFC3339),
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"pending": out})
}

// InviteInfo — GET /v1/vaults/invites/:token/info (PUBLIC)
func (h *Handler) InviteInfo(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	res, err := h.svc.InviteInfo(r.Context(), token)
	if err != nil {
		if errors.Is(err, ErrInviteNotFound) {
			httpx.Error(w, http.StatusNotFound, "invite not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "invite lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}
