package vaults

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

func (h *Handler) CustomRoles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	result, err := h.svc.ListCustomRoles(r.Context(), vaultID, claims.AccountID)
	if err != nil {
		writeCustomRoleError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) SaveCustomRole(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	var body struct {
		Name        string   `json:"name"`
		BaseRole    string   `json:"base_role"`
		Permissions []string `json:"permissions"`
	}
	if !decodeCustomRoleBody(w, r, &body) || body.Permissions == nil {
		writeCustomRoleError(w, errInvalidCustomRole)
		return
	}
	id := ""
	if r.Method == http.MethodPut {
		id = customRoleIDFromURL(w, r)
		if id == "" {
			return
		}
	}
	saved, err := h.svc.SaveCustomRole(r.Context(), vaultID, claims.AccountID, CustomRole{
		ID: id, Name: body.Name, BaseRole: body.BaseRole, Permissions: body.Permissions,
	})
	if err != nil {
		writeCustomRoleError(w, err)
		return
	}
	status := http.StatusOK
	if id == "" {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, saved)
}

func (h *Handler) DeleteCustomRole(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	id := customRoleIDFromURL(w, r)
	if id == "" {
		return
	}
	if err := h.svc.DeleteCustomRole(r.Context(), vaultID, claims.AccountID, id); err != nil {
		writeCustomRoleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) AssignCustomRole(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	accountID := accountIDFromURL(w, r)
	if accountID == "" {
		return
	}
	var body struct {
		RoleID json.RawMessage `json:"role_id"`
	}
	var roleID *string
	if !decodeCustomRoleBody(w, r, &body) || json.Unmarshal(body.RoleID, &roleID) != nil {
		writeCustomRoleError(w, errInvalidCustomRole)
		return
	}
	if roleID != nil {
		id, err := uuid.Parse(*roleID)
		if err != nil || id == uuid.Nil {
			writeCustomRoleError(w, errInvalidCustomRole)
			return
		}
		canonical := id.String()
		roleID = &canonical
	}
	if err := h.svc.AssignCustomRole(r.Context(), vaultID, claims.AccountID, accountID, roleID); err != nil {
		writeCustomRoleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeCustomRoleBody(w http.ResponseWriter, r *http.Request, body any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	decoder.DisallowUnknownFields()
	return decoder.Decode(body) == nil && decoder.Decode(&struct{}{}) == io.EOF
}

func customRoleIDFromURL(w http.ResponseWriter, r *http.Request) string {
	id, err := uuid.Parse(chi.URLParam(r, "role_id"))
	if err != nil || id == uuid.Nil {
		writeCustomRoleError(w, errInvalidCustomRole)
		return ""
	}
	return id.String()
}

func writeCustomRoleError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInvalidCustomRole):
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_custom_role", err.Error())
	case errors.Is(err, errCustomRoleNameTaken):
		httpx.ErrorCode(w, http.StatusConflict, "custom_role_name_taken", err.Error())
	case errors.Is(err, errCustomRoleLimit):
		httpx.ErrorCode(w, http.StatusConflict, "custom_role_limit", err.Error())
	case errors.Is(err, errCustomRoleInUse):
		httpx.ErrorCode(w, http.StatusConflict, "custom_role_in_use", err.Error())
	case errors.Is(err, errCustomRoleBaseMismatch):
		httpx.ErrorCode(w, http.StatusConflict, "custom_role_base_mismatch", err.Error())
	default:
		writeServiceError(w, err)
	}
}
