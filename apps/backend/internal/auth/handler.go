package auth

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/httpx"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

type googleSignInRequest struct {
	InstallID string `json:"install_id"`
	IDToken   string `json:"id_token"`
}

// GoogleSignIn — POST /v1/auth/google
// Body: { install_id, id_token }
// Returns: { session_jwt, user: { email, name, picture_url } }
//
// The mobile client calls @react-native-google-signin/google-signin to get
// a Google ID token, then posts it here. Backend verifies the token against
// Google's public keys with our Web Client ID as the audience, upserts an
// auth_credentials row, and returns a session JWT.
func (h *Handler) GoogleSignIn(w http.ResponseWriter, r *http.Request) {
	var req googleSignInRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "install_id must be a uuid")
		return
	}
	if req.IDToken == "" {
		httpx.Error(w, http.StatusBadRequest, "id_token is required")
		return
	}

	result, err := h.svc.SignInWithGoogle(r.Context(), req.InstallID, req.IDToken)
	if err != nil {
		// Surface the Google-token-validation failure as a 401 because
		// it's almost always a stale/forged/wrong-audience token — not a
		// server bug. Other errors (DB unreachable, missing config) hit
		// the 500 path.
		httpx.Error(w, http.StatusUnauthorized, "google sign-in failed: "+err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

// SignOut — POST /v1/auth/signout
// Authorization: Bearer <session_jwt>
//
// Removes the auth_credentials row for the install attached to the JWT.
// The JWT itself isn't actively invalidated (no blacklist) but a missing
// credential means no protected resources can be touched. Mobile should
// also discard its stored session_jwt after this call.
func (h *Handler) SignOut(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if err := h.svc.SignOut(r.Context(), claims.InstallID, claims.Provider); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "sign-out failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
