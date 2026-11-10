package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/matee/kaata-backend/internal/httpx"
)

// WebActivity refreshes an existing browser session's presence. It does not
// create an installation, report ledger usage, or claim mobile attribution.
// Record presence separately from native app activity.
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

	platform, err := lockWebSession(ctx, tx, claims)
	if err != nil {
		return err
	}
	if browserProfilePlatform(platform) {
		profiles, err := ReadOwnWebProfiles(ctx, tx, []string{claims.AccountID})
		if err != nil {
			return err
		}
		if err := syncWebInstallProfile(ctx, tx, claims.InstallID, profiles[claims.AccountID]); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			WITH seen AS (
			  UPDATE installs SET platform='web', app_version='web', last_seen_at=statement_timestamp(),
			    app_locale=COALESCE(NULLIF($2,''),app_locale) WHERE install_id=$1::uuid
			  RETURNING install_id, account_id, last_seen_at
			)
			INSERT INTO web_workspace_days (install_id, account_id, active_day, last_seen_at)
			SELECT install_id, account_id, (last_seen_at AT TIME ZONE 'Asia/Kabul')::date, last_seen_at FROM seen
			ON CONFLICT (install_id, account_id, active_day) DO UPDATE
			SET last_seen_at=GREATEST(web_workspace_days.last_seen_at, EXCLUDED.last_seen_at)
		`, claims.InstallID, locale)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
