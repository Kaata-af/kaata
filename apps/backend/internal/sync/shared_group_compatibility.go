package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/httpx"
)

const RejectReasonSharedTallyRequired = "shared_tally_required"

// Call only after membership has been checked. A legacy phone must not replace
// its projection or submit private writes while unaware of account-wide sharing.
func (h *Handler) allowSharedGroupClient(w http.ResponseWriter, r *http.Request, vaultID string) bool {
	if r.Header.Get("X-Kaata-Tab-Group") == "1" {
		return true
	}
	var grouped bool
	err := h.svc.pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM tab_groups
	 WHERE a_vault_id=$1::uuid OR b_vault_id=$1::uuid)`, vaultID).Scan(&grouped)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Could not verify this book's shared accounts")
		return false
	}
	if grouped {
		httpx.ErrorCode(w, http.StatusUpgradeRequired, "shared_account_upgrade_required",
			"Update Kaata to use this book's shared accounts. Your records remain on this phone.")
		return false
	}
	return true
}

// Push already holds the book's credit lock. Group creation/join takes that
// same lock before binding its contact, so this set cannot change mid-batch.
func sharedGroupPushScopes(ctx context.Context, tx pgx.Tx, vaultID string) (map[string]bool, error) {
	rows, err := tx.Query(ctx, `SELECT relationship_id::text FROM (
	 SELECT a_relationship_id AS relationship_id FROM tab_groups WHERE closed_at IS NULL AND a_vault_id=$1::uuid
	 UNION SELECT b_relationship_id FROM tab_groups WHERE closed_at IS NULL AND b_vault_id=$1::uuid
	 ) contacts WHERE relationship_id IS NOT NULL ORDER BY 1`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("read shared account scopes: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	scopes := make(map[string]bool, len(ids))
	for _, id := range ids {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, vaultID+":"+id); err != nil {
			return nil, err
		}
		scopes[id] = true
	}
	return scopes, nil
}

// A shared contact cannot receive a private monetary event, even when a caller
// supplies the new compatibility header or forges its envelope relationship.
// Existing event IDs still follow the normal duplicate verification path.
func privateSharedGroupMutation(ctx context.Context, tx pgx.Tx, vaultID string, ev PushEvent, scopes map[string]bool, state *creditProjection) (bool, error) {
	if len(scopes) == 0 || (ev.EventType != EventEntryCreated && ev.EventType != EventEntryAmended && ev.EventType != EventEntryDeleted && ev.EventType != EventEntrySettled) {
		return false, nil
	}
	var duplicate bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events WHERE vault_id=$1::uuid AND event_id=$2::uuid)`, vaultID, ev.EventID).Scan(&duplicate); err != nil {
		return false, err
	}
	if duplicate {
		return false, nil
	}
	if scopes[derefStr(ev.RelationshipID)] {
		return true, nil
	}
	var payload struct {
		EntryID        string `json:"entry_id"`
		RelationshipID string `json:"relationship_id"`
	}
	_ = json.Unmarshal(ev.Payload, &payload)
	if scopes[payload.RelationshipID] || (ev.EventType == EventEntrySettled && scopes[derefStr(ev.TargetID)]) {
		return true, nil
	}
	// Resolve the stored entry as well: an amendment/delete/create cannot evade
	// sharing by omitting its relationship or claiming a different customer.
	if derefStr(ev.TargetID) == "" && payload.EntryID == "" {
		return false, nil
	}
	projection, err := state.load(ctx, tx, vaultID)
	if err != nil {
		return false, err
	}
	for _, id := range []string{derefStr(ev.TargetID), payload.EntryID} {
		if entry := projection.Entries[id]; entry != nil && scopes[entry.RelationshipID] {
			return true, nil
		}
	}
	return false, nil
}

// HasCurrencyHistory is the admission proof for extending a joined account to
// a new currency. A zero net balance is insufficient: deleted, amended, settled
// or earlier shared history still needs an explicit opening/history workflow.
func HasCurrencyHistory(ctx context.Context, tx pgx.Tx, vaultID, relationshipID, currency string) (bool, error) {
	if !credit.ValidCurrency(currency) {
		return false, fmt.Errorf("invalid history currency")
	}
	if _, err := uuid.Parse(relationshipID); err != nil {
		return false, fmt.Errorf("invalid history relationship")
	}
	projection, err := LoadVaultProjection(ctx, tx, vaultID)
	if err != nil {
		return false, err
	}
	legacy, err := credit.ResolveCurrency(ctx, tx, vaultID)
	if err != nil {
		return false, err
	}
	for _, entry := range projection.Entries {
		code := entry.Currency
		if code == "" {
			code = legacy
		}
		if entry.RelationshipID == relationshipID && (code == currency || entry.OriginalCurrency == currency) {
			return true, nil
		}
	}
	var sharedOrSettled bool
	err = tx.QueryRow(ctx, `SELECT
	 EXISTS(SELECT 1 FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
	  WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.currency=$3)
	 OR EXISTS(SELECT 1 FROM events e WHERE e.vault_id=$1::uuid AND e.event_type='entry_settled'
	  AND (e.relationship_id=$2::uuid OR e.target_id=$2::uuid)
	  AND COALESCE(e.payload->>'currency',$4)=$3 AND e.redacted_at IS NULL)`,
		vaultID, relationshipID, currency, legacy).Scan(&sharedOrSettled)
	return sharedOrSettled, err
}

// GroupSourceLatestRecordedAt bounds the cutover by recording time, rather than
// an editable business date. An opening must not also leave its own source rows
// in the post-link private balance. Callers reject a stale cutover and retry;
// an arbitrary future source timestamp must not silently move the boundary.
func GroupSourceLatestRecordedAt(ctx context.Context, tx pgx.Tx, vaultID, relationshipID, currency string) (int64, error) {
	projection, err := LoadVaultProjection(ctx, tx, vaultID)
	if err != nil {
		return 0, err
	}
	legacy, err := credit.ResolveCurrency(ctx, tx, vaultID)
	if err != nil {
		return 0, err
	}
	var latest int64
	for _, entry := range projection.Entries {
		code := entry.Currency
		if code == "" {
			code = legacy
		}
		if entry.RelationshipID != relationshipID || code != currency || entry.IsDeleted || entry.DeletedAt != nil {
			continue
		}
		recordedAt := entry.RecordedAtMS
		if recordedAt == 0 {
			recordedAt = entry.CreatedAt
		}
		if recordedAt > latest {
			latest = recordedAt
		}
	}
	return latest, nil
}

// GroupSourceCurrencies prevents a concurrently synced denomination from being
// omitted by an older Create snapshot. Owner settings and recorded money both
// contribute; another customer's private currencies do not.
func GroupSourceCurrencies(ctx context.Context, tx pgx.Tx, vaultID, relationshipID string) ([]string, error) {
	projection, err := LoadVaultProjection(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}
	var current, legacy string
	if err := tx.QueryRow(ctx, `SELECT currency,legacy_currency FROM vaults WHERE vault_id=$1::uuid`, vaultID).Scan(&current, &legacy); err != nil {
		return nil, err
	}
	codes := map[string]bool{current: true}
	if raw := projection.VaultSettings["enabled_currencies"]; raw != "" {
		var enabled []string
		if err := json.Unmarshal([]byte(raw), &enabled); err != nil {
			return nil, fmt.Errorf("invalid recorded currency settings: %w", err)
		}
		for _, code := range enabled {
			codes[code] = true
		}
	}
	for _, entry := range projection.Entries {
		if entry.RelationshipID != relationshipID || entry.IsDeleted || entry.DeletedAt != nil {
			continue
		}
		code := entry.Currency
		if code == "" {
			code = legacy
		}
		codes[code] = true
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT t.currency FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
	 WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid`, vaultID, relationshipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		codes[code] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(codes))
	for code := range codes {
		if !credit.ValidCurrency(code) {
			return nil, fmt.Errorf("invalid recorded currency")
		}
		out = append(out, code)
	}
	sort.Strings(out)
	return out, nil
}
