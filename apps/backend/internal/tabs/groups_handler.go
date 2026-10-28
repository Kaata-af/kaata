package tabs

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

func groupHeaders(w http.ResponseWriter, r *http.Request, mode string) bool {
	if r.Header.Get("X-Kaata-Tab-Group") != "1" {
		httpx.ErrorCode(w, http.StatusUpgradeRequired, "shared_account_upgrade_required", "Update Kaata to open this multi-currency shared account")
		return false
	}
	if mode == "" {
		mode = "notify"
	}
	if !recordingHeadersSupportMode(mode, r.Header.Get("X-Kaata-Tab-Recording"), r.Header.Get("X-Kaata-Tab-One-Way")) {
		httpx.ErrorCode(w, http.StatusUpgradeRequired, "recording_upgrade_required", "Update Kaata to open this shared account")
		return false
	}
	return true
}
func groupClaims(w http.ResponseWriter, r *http.Request) (*auth.SessionClaims, bool) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok || claims == nil {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return nil, false
	}
	return claims, true
}
func decodeGroupBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_body", "invalid json body")
		return false
	}
	return true
}
func groupIDFromURL(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "group_id")
	if _, err := uuid.Parse(id); err != nil {
		writeServiceError(w, ErrNotFound)
		return "", false
	}
	return id, true
}
func (h *Handler) groupInviteURL(token string) string { return h.shareBaseURL + "/t/g_" + token }

func (h *Handler) CreateGroup(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	var in GroupCreateInput
	if !decodeGroupBody(w, r, &in) {
		return
	}
	if !groupHeaders(w, r, in.RecordingMode) {
		return
	}
	in.AccountID = claims.AccountID
	in.InstallID = installIDFromClaims(claims)
	out, err := h.svc.CreateGroup(r.Context(), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	token, _ := groupToken(in.InviteToken)
	out.InviteURL = h.groupInviteURL(token)
	httpx.JSON(w, http.StatusCreated, out)
}

// Before Join, PreviewGroup returns invitation metadata only and an empty
// tabs array. Ledger records are returned only to an already bound participant.
func (h *Handler) GroupByToken(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if !decodeGroupBody(w, r, &req) {
		return
	}
	out, err := h.svc.PreviewGroup(r.Context(), req.Token, claims.AccountID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if !groupHeaders(w, r, out.Group.RecordingMode) {
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *Handler) GetGroup(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	id, ok := groupIDFromURL(w, r)
	if !ok {
		return
	}
	out, err := h.svc.GetGroup(r.Context(), id, claims.AccountID, r.Header.Get("X-Kaata-Party"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if !groupHeaders(w, r, out.Group.RecordingMode) {
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *Handler) JoinGroup(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	id, ok := groupIDFromURL(w, r)
	if !ok {
		return
	}
	var in GroupJoinInput
	if !decodeGroupBody(w, r, &in) {
		return
	}
	preview, err := h.svc.PreviewGroup(r.Context(), in.Token, claims.AccountID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if preview.Group.ID != id {
		writeServiceError(w, ErrNotFound)
		return
	}
	if !groupHeaders(w, r, preview.Group.RecordingMode) {
		return
	}
	in.AccountID = claims.AccountID
	in.InstallID = installIDFromClaims(claims)
	out, err := h.svc.JoinGroup(r.Context(), id, in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *Handler) CloseGroup(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	id, ok := groupIDFromURL(w, r)
	if !ok {
		return
	}
	before, err := h.svc.GetGroup(r.Context(), id, claims.AccountID, r.Header.Get("X-Kaata-Party"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if !groupHeaders(w, r, before.Group.RecordingMode) {
		return
	}
	var req struct {
		Withdraw bool `json:"withdraw_unjoined_opening"`
	}
	if r.ContentLength != 0 && !decodeGroupBody(w, r, &req) {
		return
	}
	out, err := h.svc.CloseGroup(r.Context(), id, claims.AccountID, before.Group.You, req.Withdraw)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
func (h *Handler) RegenerateGroup(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	id, ok := groupIDFromURL(w, r)
	if !ok {
		return
	}
	before, err := h.svc.GetGroup(r.Context(), id, claims.AccountID, r.Header.Get("X-Kaata-Party"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if !groupHeaders(w, r, before.Group.RecordingMode) {
		return
	}
	out, token, err := h.svc.RegenerateGroup(r.Context(), id, claims.AccountID, before.Group.You)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	out.InviteURL = h.groupInviteURL(token)
	httpx.JSON(w, http.StatusOK, out)
}
func (h *Handler) EnsureGroupCurrency(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	id, ok := groupIDFromURL(w, r)
	if !ok {
		return
	}
	before, err := h.svc.GetGroup(r.Context(), id, claims.AccountID, r.Header.Get("X-Kaata-Party"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if !groupHeaders(w, r, before.Group.RecordingMode) {
		return
	}
	var in GroupCurrencyInput
	if !decodeGroupBody(w, r, &in) {
		return
	}
	out, err := h.svc.EnsureGroupCurrency(r.Context(), id, claims.AccountID, before.Group.You, in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// Joining, closing or rotating only one leg would split the shared contact.
func (h *Handler) ungroupedManagement(w http.ResponseWriter, r *http.Request, p Party) bool {
	var grouped bool
	if err := h.svc.pool.QueryRow(r.Context(), `SELECT group_id IS NOT NULL FROM tabs WHERE id=$1::uuid`, p.TabID).Scan(&grouped); err != nil {
		writeServiceError(w, err)
		return false
	}
	if grouped {
		writeServiceError(w, ErrGroupOperation)
		return false
	}
	return true
}
