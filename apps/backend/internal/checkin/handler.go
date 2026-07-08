package checkin

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

// Handler depends on the auth service so it can mint refresh JWTs for
// active sessions. authSvc is nil-safe: in deployments where auth is
// not wired yet, we just skip the refresh branch.
type Handler struct {
	svc     *Service
	authSvc *auth.Service
}

func NewHandler(svc *Service, authSvc *auth.Service) *Handler {
	return &Handler{svc: svc, authSvc: authSvc}
}

func (h *Handler) CheckIn(w http.ResponseWriter, r *http.Request) {
	// Cap the body: /v1/check-in is the hottest unauthenticated POST and its
	// Request carries *string / map fields that force allocation before the
	// post-decode clamp. Without this an attacker can stream a multi-hundred-MB
	// self_name / revocation map to exhaust memory. A legitimate check-in is a
	// few KB. Matches the MaxBytesReader guard on auth / crash-report / visit.
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)

	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if _, err := uuid.Parse(req.InstallID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "install_id must be a uuid")
		return
	}
	if req.AppVersion == "" || req.Platform == "" {
		httpx.Error(w, http.StatusBadRequest, "app_version and platform are required")
		return
	}

	// Forward the authenticated account_id (if any) into the service
	// context so the Phase 5 mesh extension can mint VMC renewals and
	// fetch revocations under the caller's authority. Local-only callers
	// (no claims) get no mesh fields on the response, which is fine —
	// mesh requires a bound account.
	ctx := r.Context()
	if claims, ok := auth.ClaimsFromContext(ctx); ok && claims != nil &&
		claims.InstallID == req.InstallID {
		ctx = WithActorAccountID(ctx, claims.AccountID)
	}

	resp, err := h.svc.Handle(ctx, req, httpx.ClientIP(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "check-in failed")
		return
	}

	// JWT refresh path. /v1/check-in is wrapped in OptionalMiddleware, so
	// claims may or may not be present. When present AND the token is past
	// RefreshIfOlderThan, mint a fresh one — that gives any regularly-active
	// install an infinite rolling window.
	if h.authSvc != nil {
		if claims, ok := auth.ClaimsFromContext(r.Context()); ok {
			if claims.InstallID == req.InstallID && claims.IssuedAtAge() > auth.RefreshIfOlderThan {
				if newJWT, err := h.authSvc.IssueRefreshJWT(claims); err == nil {
					resp.SessionJWTRefresh = &newJWT
				}
			}
		}
	}

	httpx.JSON(w, http.StatusOK, resp)
}
