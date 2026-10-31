package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/httpx"
)

// WebActivity refreshes an existing browser session's presence. It does not
// create an installation, report ledger usage, or claim mobile attribution.
// Active browsers renew the same credential on mobile's rolling-session policy.
func (h *Handler) WebActivity(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims == nil {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var req struct {
		Locale string `json:"locale"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if req.Locale != "" && req.Locale != "en" && req.Locale != "fa" && req.Locale != "ps" {
		httpx.Error(w, http.StatusBadRequest, "unsupported locale")
		return
	}
	if err := h.svc.RecordWebActivity(r.Context(), claims, req.Locale); err != nil {
		if errors.Is(err, ErrSessionRevoked) {
			httpx.Error(w, http.StatusUnauthorized, "session has ended; sign in again")
			return
		}
		httpx.Error(w, http.StatusServiceUnavailable, "activity unavailable")
		return
	}
	if claims.IssuedAtAge() > RefreshIfOlderThan {
		// RecordWebActivity checked the exact live account/install/epoch under
		// locks. Keep that epoch when renewing: a concurrent sign-out or account
		// deletion still revokes this token through the normal authorization path.
		refreshed, err := h.svc.IssueRefreshJWT(claims)
		if err != nil {
			httpx.Error(w, http.StatusServiceUnavailable, "session renewal unavailable")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		httpx.JSON(w, http.StatusOK, map[string]string{"session_jwt_refresh": refreshed})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) RecordWebActivity(ctx context.Context, claims *SessionClaims, locale string) error {
	if claims == nil {
		return ErrSessionRevoked
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Match sign-in/deletion's account-before-install lock order. A cached
	// middleware verdict must not write presence after deletion or a switch.
	var id string
	err = tx.QueryRow(ctx, `SELECT id::text FROM accounts
		WHERE id=$1::uuid AND pending_delete_at IS NULL AND disabled_at IS NULL
		FOR UPDATE`, claims.AccountID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSessionRevoked
	}
	if err != nil {
		return err
	}
	var platform string
	err = tx.QueryRow(ctx, `SELECT COALESCE(platform,'') FROM installs
		WHERE install_id=$1::uuid AND account_id=$2::uuid AND account_deleted_at IS NULL
		FOR UPDATE`, claims.InstallID, claims.AccountID).Scan(&platform)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSessionRevoked
	}
	if err != nil {
		return err
	}
	// Hold the exact live credential until commit: concurrent sign-out then
	// either wins first and prevents this update, or completes after it.
	err = tx.QueryRow(ctx, `SELECT install_id::text FROM auth_credentials
		WHERE install_id=$1::uuid AND provider=$2 AND COALESCE(account_id,$3::uuid)=$3::uuid
		AND session_epoch=$4 AND revoked_at IS NULL FOR SHARE`,
		claims.InstallID, claims.Provider, claims.AccountID, claims.Epoch).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSessionRevoked
	}
	if err != nil {
		return err
	}
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "web", "unknown", "":
		_, err = tx.Exec(ctx, `UPDATE installs SET platform='web', app_version='web', last_seen_at=NOW(),
			app_locale=COALESCE(NULLIF($2,''),app_locale) WHERE install_id=$1::uuid`, claims.InstallID, locale)
		if err != nil {
			return err
		}
	default:
		// Platform is an analytics hint, never authority to relabel a phone.
	}
	return tx.Commit(ctx)
}
