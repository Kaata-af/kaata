package auth

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/matee/kaata-backend/internal/httpx"
)

func friendClaims(w http.ResponseWriter, r *http.Request) (*SessionClaims, bool) {
	w.Header().Set("Cache-Control", "no-store")
	c, ok := ClaimsFromContext(r.Context())
	if !ok || c == nil {
		httpx.Error(w, 401, "authentication required")
		return nil, false
	}
	return c, true
}
func writeFriendError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrSessionRevoked):
		httpx.ErrorCode(w, 401, "session_ended", "session has ended")
	case errors.Is(err, ErrPersonUnavailable):
		httpx.ErrorCode(w, 404, "person_unavailable", err.Error())
	case errors.Is(err, ErrFriendRequestNotFound):
		httpx.ErrorCode(w, 404, "friend_request_not_found", err.Error())
	case errors.Is(err, ErrFriendRequestLimited):
		httpx.ErrorCode(w, 429, "friend_request_cooldown", err.Error())
	case errors.Is(err, ErrFriendRequestCapacity):
		httpx.ErrorCode(w, 429, "friend_request_limit", err.Error())
	case errors.Is(err, ErrInvalidFriendAccount):
		httpx.ErrorCode(w, 400, "invalid_account_id", err.Error())
	case errors.Is(err, ErrInvalidFriendCursor):
		httpx.ErrorCode(w, 400, "invalid_cursor", err.Error())
	default:
		httpx.ErrorCode(w, 500, "internal_error", "friendship operation unavailable")
	}
}

func (h *Handler) PeopleProfile(w http.ResponseWriter, r *http.Request) {
	c, ok := friendClaims(w, r)
	if !ok {
		return
	}
	target := chi.URLParam(r, "account_id")
	profile, err := h.svc.PeopleProfile(r.Context(), c.AccountID, target)
	if err != nil {
		writeFriendError(w, err)
		return
	}
	profile.Activity, err = h.svc.loadPersonProfileActivity(r.Context(), c.AccountID, target, r.URL.Query().Get("vault_id"))
	if err != nil {
		writeFriendError(w, err)
		return
	}
	if profile.Activity != nil {
		profile.Person.ExistingRelationshipID = profile.Activity.ExistingRelationshipID
	}
	httpx.JSON(w, 200, profile)
}
func (h *Handler) Friends(w http.ResponseWriter, r *http.Request) {
	c, ok := friendClaims(w, r)
	if !ok {
		return
	}
	page, err := h.svc.Friends(r.Context(), c.AccountID, r.URL.Query().Get("after"))
	if err != nil {
		writeFriendError(w, err)
		return
	}
	httpx.JSON(w, 200, page)
}
func (h *Handler) FriendRequests(w http.ResponseWriter, r *http.Request) {
	c, ok := friendClaims(w, r)
	if !ok {
		return
	}
	requests, err := h.svc.FriendRequests(r.Context(), c.AccountID)
	if err != nil {
		writeFriendError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"requests": requests})
}
func (h *Handler) SendFriendRequest(w http.ResponseWriter, r *http.Request) {
	c, ok := friendClaims(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var body struct {
		AccountID string `json:"account_id"`
	}
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(&body); err != nil {
		httpx.ErrorCode(w, 400, "invalid_body", "invalid request body")
		return
	}
	if err := d.Decode(new(any)); err != io.EOF {
		httpx.ErrorCode(w, 400, "invalid_body", "invalid request body")
		return
	}
	state, err := h.svc.SendFriendRequest(r.Context(), c.AccountID, body.AccountID)
	if err != nil {
		writeFriendError(w, err)
		return
	}
	httpx.JSON(w, 200, FriendshipResult{Friendship: state})
}
func (h *Handler) AcceptFriendRequest(w http.ResponseWriter, r *http.Request) {
	c, ok := friendClaims(w, r)
	if !ok {
		return
	}
	state, err := h.svc.AcceptFriendRequest(r.Context(), c.AccountID, chi.URLParam(r, "request_id"))
	if err != nil {
		writeFriendError(w, err)
		return
	}
	httpx.JSON(w, 200, FriendshipResult{Friendship: state})
}
func (h *Handler) DeleteFriendRequest(w http.ResponseWriter, r *http.Request) {
	c, ok := friendClaims(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteFriendRequest(r.Context(), c.AccountID, chi.URLParam(r, "request_id")); err != nil {
		writeFriendError(w, err)
		return
	}
	w.WriteHeader(204)
}
func (h *Handler) RemoveFriend(w http.ResponseWriter, r *http.Request) {
	c, ok := friendClaims(w, r)
	if !ok {
		return
	}
	if err := h.svc.RemoveFriend(r.Context(), c.AccountID, chi.URLParam(r, "friendship_id")); err != nil {
		writeFriendError(w, err)
		return
	}
	w.WriteHeader(204)
}
