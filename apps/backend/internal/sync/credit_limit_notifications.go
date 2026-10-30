package sync

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/httpx"
)

// This shared switch is deliberately separate from both combined-rule
// inheritance and each recipient's personal delivery preferences.
func (h *Handler) CreditLimitNotifications(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Kaata-Credit-Limit-Notifications", "1")
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, 401, "authentication required")
		return
	}
	vaultID := r.URL.Query().Get("vault_id")
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, 400, "invalid vault_id")
		return
	}
	if !h.allowCurrencyClient(w, r, vaultID, claims.AccountID) {
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPut && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, PUT, DELETE")
		httpx.Error(w, 405, "method not allowed")
		return
	}
	tx, err := h.svc.pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	defer tx.Rollback(r.Context())
	var account string
	err = tx.QueryRow(r.Context(), `SELECT id::text FROM accounts WHERE id=$1::uuid AND pending_delete_at IS NULL FOR KEY SHARE`, claims.AccountID).Scan(&account)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 401, "account unavailable")
		return
	}
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if err = credit.Lock(r.Context(), tx, vaultID); err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	var role string
	err = tx.QueryRow(r.Context(), `SELECT m.role FROM vault_members m JOIN vaults v ON v.vault_id=m.vault_id WHERE m.vault_id=$1::uuid AND m.account_id=$2::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL AND (v.archived_at IS NULL OR m.role='owner')`, vaultID, claims.AccountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, 403, "not_member", "membership required")
		return
	}
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if r.Method == http.MethodGet {
		policies, err := credit.ListLimitNotifications(r.Context(), tx, vaultID)
		if err != nil {
			httpx.Error(w, 500, "storage unavailable")
			return
		}
		revision, err := creditLimitNotificationRevision(r.Context(), tx, vaultID)
		if err != nil {
			httpx.Error(w, 500, "storage unavailable")
			return
		}
		w.Header().Set("X-Kaata-Credit-Updated-At", strconv.FormatInt(revision, 10))
		httpx.JSON(w, 200, policies)
		return
	}
	if role != "owner" && role != "manager" {
		httpx.ErrorCode(w, 403, "insufficient_role", "manager required")
		return
	}
	var policy credit.LimitNotificationPolicy
	if r.Method == http.MethodDelete {
		policy.RelationshipID = r.URL.Query().Get("relationship_id")
	} else {
		var input struct {
			RelationshipID string `json:"relationship_id"`
			Enabled        *bool  `json:"enabled"`
			UpdatedAtMS    int64  `json:"updated_at_ms"`
		}
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		d.DisallowUnknownFields()
		if d.Decode(&input) != nil || input.Enabled == nil || d.Decode(new(any)) != io.EOF {
			httpx.Error(w, 400, "invalid credit limit notifications")
			return
		}
		policy.RelationshipID = input.RelationshipID
		policy.Enabled = *input.Enabled
	}
	if _, err := uuid.Parse(policy.RelationshipID); err != nil {
		httpx.Error(w, 400, "invalid relationship_id")
		return
	}
	if policy.RelationshipID != credit.DefaultRelationshipID {
		projection, err := LoadVaultProjection(r.Context(), tx, vaultID)
		if err != nil {
			httpx.Error(w, 500, "storage unavailable")
			return
		}
		rel := projection.Relationships[policy.RelationshipID]
		if rel == nil || rel.ArchivedAt != nil {
			httpx.ErrorCode(w, 409, "relationship_missing", "sync customer first")
			return
		}
	}
	policy.UpdatedAtMS, err = nextCreditLimitNotificationRevision(r.Context(), tx, vaultID)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if r.Method == http.MethodDelete {
		_, err = tx.Exec(r.Context(), `DELETE FROM customer_credit_limit_notifications WHERE vault_id=$1::uuid AND relationship_id=$2::uuid`, vaultID, policy.RelationshipID)
	} else {
		_, err = tx.Exec(r.Context(), `INSERT INTO customer_credit_limit_notifications(vault_id,relationship_id,enabled,updated_at_ms) VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at_ms=EXCLUDED.updated_at_ms`, vaultID, policy.RelationshipID, policy.Enabled, policy.UpdatedAtMS)
	}
	if err == nil {
		err = h.svc.scanCreditAlertVaultTx(r.Context(), tx, vaultID, "")
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	h.svc.NotifyLive(vaultID)
	w.Header().Set("X-Kaata-Credit-Updated-At", strconv.FormatInt(policy.UpdatedAtMS, 10))
	if r.Method == http.MethodDelete {
		w.WriteHeader(http.StatusNoContent)
	} else {
		httpx.JSON(w, 200, policy)
	}
}

func creditLimitNotificationRevision(ctx context.Context, tx pgx.Tx, vaultID string) (int64, error) {
	var n int64
	err := tx.QueryRow(ctx, `SELECT GREATEST(COALESCE((SELECT updated_at_ms FROM customer_credit_limit_notification_revisions WHERE vault_id=$1::uuid),0),COALESCE((SELECT MAX(updated_at_ms) FROM customer_credit_limit_notifications WHERE vault_id=$1::uuid),0))`, vaultID).Scan(&n)
	return n, err
}
func nextCreditLimitNotificationRevision(ctx context.Context, tx pgx.Tx, vaultID string) (int64, error) {
	previous, err := creditLimitNotificationRevision(ctx, tx, vaultID)
	if err != nil {
		return 0, err
	}
	next := max(time.Now().UnixMilli(), previous+1)
	_, err = tx.Exec(ctx, `INSERT INTO customer_credit_limit_notification_revisions(vault_id,updated_at_ms) VALUES($1::uuid,$2) ON CONFLICT(vault_id) DO UPDATE SET updated_at_ms=EXCLUDED.updated_at_ms`, vaultID, next)
	return next, err
}
