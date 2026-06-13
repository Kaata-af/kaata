package mesh

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

// Handler exposes the mesh-supporting HTTP endpoints (device-key
// registration here; witness attestation in witness.go). Both routes are
// installed behind the protected JWT middleware in main.go; the handlers
// re-read the claim so callers can rely on a consistent ClaimsFromContext
// failure path (401) rather than a nil deref.
type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

type registerKeyRequest struct {
	// Ed25519PubkeyB64 is the standard-base64 (NOT url-safe) encoding of
	// the device's 32-byte Ed25519 public key. Mobile derives this from
	// the private key it generated on first run and stored in
	// expo-secure-store; only the pubkey ever crosses the network.
	Ed25519PubkeyB64 string `json:"ed25519_pubkey"`
}

// RegisterKey — POST /v1/devices/register-key
//
// Idempotent UPSERT keyed on the install_id stamped in the caller's JWT.
// We deliberately do NOT take install_id from the request body: a stolen
// JWT could otherwise be used to overwrite another install's pubkey,
// effectively hijacking its identity for mesh handshakes.
func (h *Handler) RegisterKey(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req registerKeyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if req.Ed25519PubkeyB64 == "" {
		httpx.Error(w, http.StatusBadRequest, "ed25519_pubkey is required")
		return
	}

	pubkey, err := base64.StdEncoding.DecodeString(req.Ed25519PubkeyB64)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "ed25519_pubkey must be standard base64")
		return
	}

	if err := h.svc.RegisterKey(r.Context(), claims.InstallID, pubkey); err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"install_id": claims.InstallID,
		"registered": true,
	})
}
