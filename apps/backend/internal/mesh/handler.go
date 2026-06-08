package mesh

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

// Handler exposes the two mesh-supporting HTTP endpoints. Both routes are
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

type issueCredentialRequest struct {
	// PairToken (optional but REQUIRED when the caller is not already a
	// member of the vault). Single-use ticket the OWNER posted to
	// /v1/vaults/:vault_id/pair-tokens. Consuming the token enforces the
	// 5-minute window on the SERVER's clock, defeating a scanner-clock
	// rollback attack on the QR's client-side expiry check.
	PairToken      string `json:"pair_token,omitempty"`
	PairIssuedAtMS int64  `json:"pair_issued_at_ms,omitempty"`
}

type issueCredentialResponse struct {
	VMCBlob     string `json:"vmc_blob"`
	ExpiresAt   string `json:"expires_at"`    // ISO8601 for human readability
	ExpiresAtMS int64  `json:"expires_at_ms"` // canonical wire form (HLC-friendly)
}

// IssueCredential — POST /v1/vaults/:vault_id/credential
//
// Returns a fresh VMC for the caller's current role on the given vault.
// Per design, vault_id comes from the URL and (account_id, install_id)
// from the JWT — the only body fields used are the optional same-account
// pair-token claim (see issueCredentialRequest). We refuse 503 when the
// server's signing key is missing so monitoring can flag the misconfig
// cleanly.
//
// Pair-token semantics: when the body carries pair_token, the server
// consumes it (single-use) BEFORE minting the VMC. The token's vault_id
// must match the URL's. If the caller is ALREADY a member of the vault
// (existing device) we skip the token check — minting is JWT-authorised
// in that case. The new-device path (pair-scan.tsx) doesn't yet have
// vault_members membership and relies on the token to prove the owner
// just authorised this device.
//
// NOTE on backward compat: requests without a body still work for
// already-members (the legacy in-vault renewal path). New devices joining
// via QR MUST forward pair_token + pair_issued_at_ms or the call 403s.
func (h *Handler) IssueCredential(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	vaultID := chi.URLParam(r, "vault_id")
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}

	// Body is optional — empty body decodes to a zero-value struct,
	// which means "no pair token, must be existing member."
	var req issueCredentialRequest
	if r.ContentLength > 0 {
		r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid json body")
			return
		}
	}

	// Check membership FIRST. If the caller is already a member, the
	// token (if any) is ignored — this is the steady-state renewal
	// path. If the caller is NOT a member, the token is REQUIRED and
	// is consumed atomically before minting.
	ok2, memberErr := h.svc.IsMember(r.Context(), vaultID, claims.AccountID)
	if memberErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "membership check failed")
		return
	}
	if !ok2 {
		if req.PairToken == "" {
			httpx.Error(w, http.StatusForbidden, "not a member of this vault; missing pair_token")
			return
		}
		if err := h.svc.ConsumePairToken(
			r.Context(),
			req.PairToken,
			vaultID,
			claims.InstallID,
			req.PairIssuedAtMS,
		); err != nil {
			switch {
			case errors.Is(err, ErrPairTokenInvalid),
				errors.Is(err, ErrPairTokenVaultMismatch),
				errors.Is(err, ErrPairTokenIssuedAtTooOld):
				httpx.Error(w, http.StatusForbidden, err.Error())
			default:
				httpx.Error(w, http.StatusInternalServerError, "pair token check failed")
			}
			return
		}
		// Successfully consumed the pair token; promote to membership.
		// The pair-scan client also writes a local vault_members_mirror
		// row for offline rendering, but the canonical source of truth
		// is the server-side vault_members row we INSERT here.
		if err := h.svc.PromotePairTokenMembership(
			r.Context(), vaultID, claims.AccountID, claims.InstallID,
		); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "promote membership failed")
			return
		}
	}

	res, err := h.svc.IssueVMC(r.Context(), vaultID, claims.AccountID, claims.InstallID)
	if err != nil {
		switch {
		case errors.Is(err, ErrSigningUnavailable):
			httpx.Error(w, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, ErrDeviceKeyNotRegistered):
			// 412 Precondition Failed signals "do the device-key
			// registration step first" without conflating with a
			// stale-token 401.
			httpx.Error(w, http.StatusPreconditionFailed, err.Error())
		case errors.Is(err, ErrNotMember):
			httpx.Error(w, http.StatusForbidden, err.Error())
		default:
			httpx.Error(w, http.StatusInternalServerError, "vmc issuance failed")
		}
		return
	}

	httpx.JSON(w, http.StatusOK, issueCredentialResponse{
		VMCBlob:     res.VMCBlob,
		ExpiresAt:   res.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z"),
		ExpiresAtMS: res.ExpiresAt.UnixMilli(),
	})
}

// ---------------------------------------------------------------------------
// Pair-token issuance (owner side of the QR flow)
// ---------------------------------------------------------------------------

type registerPairTokenRequest struct {
	Token       string `json:"token"`
	ExpiresAtMS int64  `json:"expires_at_ms"`
}

// RegisterPairToken — POST /v1/vaults/:vault_id/pair-tokens
//
// Owner generates a QR locally (apps/mobile/app/vault/pair.tsx) and then
// IMMEDIATELY POSTs the token plaintext + the QR's expires_at to this
// endpoint. The server stores SHA-256(token) so the plaintext never
// touches the DB. The token is single-use and is consumed by the matching
// /credential call from the SCANNER side.
//
// Only owners can mint pair tokens (enforced inside the service). The
// caller's account_id + install_id come from JWT claims — the body is
// strictly (token, expires_at_ms).
//
// Rate-limited by the same RegisterKeyLimit family so a buggy retry loop
// can't flood the table.
func (h *Handler) RegisterPairToken(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}

	vaultID := chi.URLParam(r, "vault_id")
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req registerPairTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if req.Token == "" {
		httpx.Error(w, http.StatusBadRequest, "token is required")
		return
	}
	if req.ExpiresAtMS <= 0 {
		httpx.Error(w, http.StatusBadRequest, "expires_at_ms is required")
		return
	}

	if err := h.svc.RegisterPairToken(
		r.Context(), req.Token, vaultID, claims.AccountID, claims.InstallID, req.ExpiresAtMS,
	); err != nil {
		switch {
		case errors.Is(err, ErrPairTokenInvalid):
			httpx.Error(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, ErrNotMember):
			httpx.Error(w, http.StatusForbidden, "only the vault owner can mint pair tokens")
		default:
			httpx.Error(w, http.StatusInternalServerError, "register pair token failed")
		}
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"registered": true})
}
