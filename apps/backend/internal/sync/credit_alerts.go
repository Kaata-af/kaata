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

// CreditAlerts stores complete advisory policies without altering legacy limits.
// Accepted members can read; owners/admins can save or reset to inheritance.
func (h *Handler) CreditAlerts(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	vaultID := r.URL.Query().Get("vault_id")
	if _, err := uuid.Parse(vaultID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid vault_id")
		return
	}
	if !h.allowCurrencyClient(w, r, vaultID, claims.AccountID) {
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPut && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, PUT, DELETE")
		httpx.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	tx, err := h.svc.pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var activeAccount string
	err = tx.QueryRow(r.Context(), `SELECT id::text FROM accounts WHERE id=$1::uuid AND pending_delete_at IS NULL FOR KEY SHARE`, claims.AccountID).Scan(&activeAccount)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusUnauthorized, "account unavailable")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
		return
	}
	if err := credit.Lock(r.Context(), tx, vaultID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
		return
	}
	var role string
	err = tx.QueryRow(r.Context(), `SELECT m.role FROM vault_members m JOIN vaults v ON v.vault_id=m.vault_id WHERE m.vault_id=$1::uuid AND m.account_id=$2::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL AND (v.archived_at IS NULL OR m.role='owner')`, vaultID, claims.AccountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusForbidden, "not_member", "membership required")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
		return
	}
	if r.Method == http.MethodGet {
		policies, err := credit.ListAlerts(r.Context(), tx, vaultID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
			return
		}
		revision, err := creditAlertRevision(r.Context(), tx, vaultID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
			return
		}
		w.Header().Set("X-Kaata-Credit-Updated-At", strconv.FormatInt(revision, 10))
		httpx.JSON(w, http.StatusOK, policies)
		return
	}
	if role != "owner" && role != "manager" {
		httpx.ErrorCode(w, http.StatusForbidden, "insufficient_role", "manager required")
		return
	}
	if r.Method == http.MethodDelete {
		relationshipID := r.URL.Query().Get("relationship_id")
		if _, err := uuid.Parse(relationshipID); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid relationship_id")
			return
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM customer_credit_alerts WHERE vault_id=$1::uuid AND relationship_id=$2::uuid`, vaultID, relationshipID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
			return
		}
		if err := h.svc.scanCreditAlertVaultTx(r.Context(), tx, vaultID, ""); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
			return
		}
		revision, err := nextCreditAlertRevision(r.Context(), tx, vaultID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
			return
		}
		h.svc.NotifyLive(vaultID)
		w.Header().Set("X-Kaata-Credit-Updated-At", strconv.FormatInt(revision, 10))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var policy credit.AlertPolicy
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&policy) != nil || !policy.Valid() || decoder.Decode(&struct{}{}) != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid credit alerts")
		return
	}
	if _, err := uuid.Parse(policy.RelationshipID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid relationship_id")
		return
	}
	if policy.RelationshipID != credit.DefaultRelationshipID {
		projection, err := LoadVaultProjection(r.Context(), tx, vaultID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
			return
		}
		rel := projection.Relationships[policy.RelationshipID]
		if rel == nil || rel.ArchivedAt != nil {
			httpx.ErrorCode(w, http.StatusConflict, "relationship_missing", "sync customer first")
			return
		}
	}
	groups, err := json.Marshal(policy.Groups)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid credit alerts")
		return
	}
	policy.UpdatedAtMS, err = nextCreditAlertRevision(r.Context(), tx, vaultID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO customer_credit_alerts(vault_id,relationship_id,groups,updated_at_ms) VALUES($1::uuid,$2::uuid,$3::jsonb,$4) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET groups=EXCLUDED.groups,updated_at_ms=EXCLUDED.updated_at_ms`, vaultID, policy.RelationshipID, groups, policy.UpdatedAtMS)
	if err == nil {
		err = h.svc.scanCreditAlertVaultTx(r.Context(), tx, vaultID, "")
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		httpx.Error(w, http.StatusInternalServerError, "storage unavailable")
		return
	}
	h.svc.NotifyLive(vaultID)
	w.Header().Set("X-Kaata-Credit-Updated-At", strconv.FormatInt(policy.UpdatedAtMS, 10))
	httpx.JSON(w, http.StatusOK, policy)
}

// The caller holds credit.Lock. Keep the clock after rows are removed so a
// recreate always supersedes the deletion, including during a clock rollback.
func nextCreditAlertRevision(ctx context.Context, tx pgx.Tx, vaultID string) (int64, error) {
	previous, err := creditAlertRevision(ctx, tx, vaultID)
	if err != nil {
		return 0, err
	}
	next := max(time.Now().UnixMilli(), previous+1)
	_, err = tx.Exec(ctx, `INSERT INTO customer_credit_alert_revisions(vault_id,updated_at_ms) VALUES($1::uuid,$2) ON CONFLICT(vault_id) DO UPDATE SET updated_at_ms=EXCLUDED.updated_at_ms`, vaultID, next)
	return next, err
}

func creditAlertRevision(ctx context.Context, tx pgx.Tx, vaultID string) (int64, error) {
	var revision int64
	err := tx.QueryRow(ctx, `SELECT GREATEST(COALESCE((SELECT updated_at_ms FROM customer_credit_alert_revisions WHERE vault_id=$1::uuid),0),COALESCE((SELECT MAX(updated_at_ms) FROM customer_credit_alerts WHERE vault_id=$1::uuid),0))`, vaultID).Scan(&revision)
	return revision, err
}
