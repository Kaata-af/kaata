package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/httpx"
)

// CreditBalance uses the same current event projection and latest linked period
// as mobile. A link permanently absorbs pre-link local rows, even after closing.
func CreditBalance(ctx context.Context, tx pgx.Tx, vaultID, relationshipID string, currency ...string) (int64, error) {
	p, err := LoadVaultProjection(ctx, tx, vaultID)
	if err != nil {
		return 0, err
	}
	return creditBalanceWithProjection(ctx, tx, vaultID, relationshipID, p, currency...)
}

func creditBalanceWithProjection(ctx context.Context, tx pgx.Tx, vaultID, relationshipID string, p *Projection, currency ...string) (int64, error) {
	code, err := credit.ResolveCurrency(ctx, tx, vaultID, currency...)
	if err != nil {
		return 0, err
	}
	legacy, err := credit.ResolveCurrency(ctx, tx, vaultID)
	if err != nil {
		return 0, err
	}
	var boundary *int64
	err = tx.QueryRow(ctx, `SELECT p.linked_at_ms FROM tab_parties p JOIN tabs t ON t.id=p.tab_id WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.currency=$3 ORDER BY p.history_order DESC NULLS LAST,t.created_at DESC,t.id DESC,p.role DESC LIMIT 1`, vaultID, relationshipID, code).Scan(&boundary)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	sum := new(big.Int)
	if err == nil {
		var tabSum string
		// Credit exposure remains pending-inclusive. A live opening replaces
		// earlier periods, but rejecting/withdrawing it reveals that earlier
		// exposure instead of turning a previously accepted loan into zero.
		if err := tx.QueryRow(ctx, `WITH periods AS (
		 SELECT p.tab_id,p.role,p.history_order FROM tab_parties p JOIN tabs t ON t.id=p.tab_id WHERE p.vault_id=$1::uuid AND p.relationship_id=$2::uuid AND t.currency=$3
		), checkpoint AS (
		 SELECT MAX(p.history_order) AS history_order FROM periods p JOIN tab_entries e ON e.tab_id=p.tab_id
		 WHERE e.kind='opening' AND e.voided_by_entry_id IS NULL AND e.status IN ('pending','accepted')
		)
		 SELECT COALESCE(SUM(CASE WHEN (p.role='a' AND e.direction='a_to_b') OR (p.role='b' AND e.direction='b_to_a')
		   THEN e.amount_minor ELSE -e.amount_minor END),0)::text
		 FROM periods p JOIN tab_entries e ON e.tab_id=p.tab_id CROSS JOIN checkpoint c
		 WHERE p.history_order>=COALESCE(c.history_order,0) AND e.kind<>'void'
		   AND e.voided_by_entry_id IS NULL AND e.status IN ('pending','accepted')`, vaultID, relationshipID, code).Scan(&tabSum); err != nil {
			return 0, err
		}
		if _, ok := sum.SetString(tabSum, 10); !ok {
			return 0, fmt.Errorf("invalid tab balance")
		}
	}
	for _, e := range p.Entries {
		entryCurrency := e.Currency
		if entryCurrency == "" {
			entryCurrency = legacy
		}
		if entryCurrency != code {
			continue
		}
		recordedAt := e.RecordedAtMS
		if recordedAt == 0 {
			recordedAt = e.CreatedAt // Older serialized projections predate custom dates.
		}
		if e.RelationshipID != relationshipID || e.IsDeleted || e.DeletedAt != nil || e.DisputedAt != nil || (boundary != nil && recordedAt <= *boundary) {
			continue
		}
		n, err := credit.Minor(e.AmountAFN.String())
		if err != nil {
			return 0, err
		}
		if e.Type == "payment" {
			n = -n
		} else if e.Type != "debt" {
			return 0, fmt.Errorf("invalid entry type")
		}
		sum.Add(sum, big.NewInt(n))
	}
	if !sum.IsInt64() {
		return 0, fmt.Errorf("credit balance overflow")
	}
	return sum.Int64(), nil
}

// creditAdmit checks the actual projected delta; forged backfill flags cannot
// turn a clerk's exposure-increasing write into a free repayment.
type creditProjection struct {
	p              *Projection
	head           HLC
	legacyCurrency string
}

func (state *creditProjection) load(ctx context.Context, tx pgx.Tx, vaultID string) (*Projection, error) {
	if state.p != nil {
		return state.p, nil
	}
	p, err := LoadVaultProjection(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `SELECT legacy_currency FROM vaults WHERE vault_id=$1::uuid`, vaultID).Scan(&state.legacyCurrency); err != nil {
		return nil, err
	}
	err = tx.QueryRow(ctx, `SELECT hlc_physical_ms,hlc_logical,hlc_device_id::text FROM events WHERE vault_id=$1::uuid AND redacted_at IS NULL ORDER BY hlc_physical_ms DESC,hlc_logical DESC,hlc_device_id DESC LIMIT 1`, vaultID).Scan(&state.head.PMS, &state.head.L, &state.head.DID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	state.p = p
	return p, nil
}

// Most outboxes are monotonic. Fold each accepted mutation into the cached
// transaction projection; backdated history invalidates it for a sorted reload.
func (state *creditProjection) accepted(vaultID string, ev PushEvent) {
	if state.p == nil {
		return
	}
	hlc := HLC{PMS: ev.HLC.PhysicalMS, L: ev.HLC.Logical, DID: ev.HLC.DeviceID}
	if CompareHLC(hlc, state.head) <= 0 {
		state.p = nil
		return
	}
	e := LedgerEvent{EventID: ev.EventID, VaultID: vaultID, EventType: ev.EventType, PayloadSchema: ev.SchemaVersion, HLC: hlc, DeviceID: ev.HLC.DeviceID, TargetID: derefStr(ev.TargetID), RelationshipID: ev.RelationshipID, ActorAccountID: ev.ActorAccountID, Payload: ev.Payload}
	e.LegacyCurrency = state.legacyCurrency
	if applyOne(state.p, &e) != nil {
		state.p = nil
		return
	}
	state.head = hlc
}

func isCreditMutation(eventType string) bool {
	return eventType == EventEntryCreated || eventType == EventEntryAmended || eventType == EventEntryDeleted
}

func creditLedgerEvent(vaultID string, ev PushEvent) LedgerEvent {
	return LedgerEvent{EventID: ev.EventID, VaultID: vaultID, EventType: ev.EventType, PayloadSchema: ev.SchemaVersion,
		HLC: HLC{PMS: ev.HLC.PhysicalMS, L: ev.HLC.Logical, DID: ev.HLC.DeviceID}, DeviceID: ev.HLC.DeviceID,
		TargetID: derefStr(ev.TargetID), RelationshipID: ev.RelationshipID, ActorAccountID: ev.ActorAccountID, Payload: ev.Payload}
}

// proposed uses the real projection rules, including per-field LWW and sticky
// deletion. Backdated events require a sorted replay: applying an old deletion
// onto the current projection could otherwise remove a row created after it.
func (state *creditProjection) proposed(ctx context.Context, tx pgx.Tx, vaultID string, ev PushEvent) (*Projection, error) {
	p, err := state.load(ctx, tx, vaultID)
	if err != nil {
		return nil, err
	}
	ledger := creditLedgerEvent(vaultID, ev)
	ledger.LegacyCurrency = state.legacyCurrency
	if CompareHLC(ledger.HLC, state.head) <= 0 {
		events, _, err := loadVaultEvents(ctx, tx, vaultID)
		if err != nil {
			return nil, err
		}
		events = append(events, ledger)
		candidate, err := ApplyEvents(events)
		return &candidate, err
	}
	candidate := *p
	candidate.Entries = make(map[string]*EntryProjection, len(p.Entries)+1)
	for id, entry := range p.Entries {
		candidate.Entries[id] = entry
	}
	if old := p.Entries[ledger.TargetID]; old != nil {
		entry := *old
		candidate.Entries[ledger.TargetID] = &entry
	}
	if err := applyOne(&candidate, &ledger); err != nil {
		return nil, err
	}
	return &candidate, nil
}

func creditAdmit(ctx context.Context, tx pgx.Tx, vaultID string, ev PushEvent, actorRole, actorAccountID string, state *creditProjection) error {
	if !isCreditMutation(ev.EventType) {
		return nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events WHERE event_id=$1::uuid)`, ev.EventID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		matches, err := creditDuplicateMatches(ctx, tx, vaultID, ev)
		if err != nil {
			return err
		}
		if !matches {
			return credit.ErrLimit
		}
		return nil
	}
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customer_credit_event_refusals WHERE vault_id=$1::uuid AND event_id=$2::uuid)`, vaultID, ev.EventID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return credit.ErrLimit
	}
	if actorRole != "clerk" && actorRole != "editor" {
		return nil
	}
	override, err := credit.MemberOverride(ctx, tx, vaultID, actorAccountID)
	if err != nil {
		return err
	}
	var relationshipID string
	var currency string
	var targetCurrency string
	var created entryCreatedPayload
	if ev.EventType == EventEntryCreated {
		if err := json.Unmarshal(ev.Payload, &created); err != nil {
			return nil // Opaque legacy events carry no projection exposure.
		}
		// Entry IDs are global. Editors cannot evade one customer's hard limit
		// by reusing its row ID under a different, warning-only customer.
		if created.EntryID != "" {
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events WHERE event_type IN ('entry_created','entry_amended','entry_deleted','entry_settled','entry_disputed','entry_accepted') AND (COALESCE(local_target_id,target_id::text)=$1 OR payload->>'entry_id'=$1) AND redacted_at IS NULL)`, created.EntryID).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return credit.ErrLimit
			}
		}
		relationshipID = created.RelationshipID
		currency = created.Currency
	} else {
		if override == "bypass" {
			return nil
		}
		// Warning-only/no-policy editing retains its existing offline behavior
		// and avoids loading the complete ledger on the server.
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customer_credit_limits WHERE vault_id=$1::uuid AND mode='clerk_block' AND ($2 OR restrict_editors))`, vaultID, actorRole == "clerk" || override == "enforce").Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return nil
		}
		projection, err := state.load(ctx, tx, vaultID)
		if err != nil {
			return err
		}
		entry := projection.Entries[derefStr(ev.TargetID)]
		if entry == nil {
			// Do not plant an orphan amendment/deletion that a later backdated
			// create could activate without another exposure check.
			return credit.ErrLimit
		}
		relationshipID = entry.RelationshipID
		currency = entry.Currency
		if ev.EventType == EventEntryAmended {
			var amendment entryAmendedPayload
			if err := json.Unmarshal(ev.Payload, &amendment); err != nil {
				return credit.ErrLimit
			}
			var err error
			targetCurrency, err = amendedCurrency(amendment.Changes)
			if err != nil {
				return credit.ErrLimit
			}
			if targetCurrency == "" && amendment.Changes.AmountAFN != nil {
				targetCurrency = entry.OriginalCurrency
			}
		}
	}
	if _, err := uuid.Parse(relationshipID); err != nil {
		return nil
	}
	if targetCurrency == "" {
		targetCurrency = currency
	}
	policies := map[string]*credit.Policy{}
	for i, code := range []string{currency, targetCurrency} {
		if i > 0 && code == currency {
			continue
		}
		policy, err := credit.Effective(ctx, tx, vaultID, relationshipID, code)
		if err != nil {
			return err
		}
		if policy != nil && policy.Restricts(actorRole, override) {
			policies[code] = policy
		}
	}
	if len(policies) == 0 {
		return nil
	}
	if ev.RelationshipID == nil || *ev.RelationshipID != relationshipID {
		return credit.ErrLimit
	}
	if ev.EventType == EventEntryCreated {
		minor, err := credit.Minor(created.AmountAFN.String())
		if err != nil || minor <= 0 || (created.Type != "payment" && created.Type != "debt") || created.BackfillSynthetic != nil || created.BackfillDisputedAt != nil || created.BackfillSettledAt != nil || created.BackfillAcceptedAt != nil || created.EntryID == "" || derefStr(ev.TargetID) != created.EntryID {
			return credit.ErrLimit
		}
	}
	projection, err := state.load(ctx, tx, vaultID)
	if err != nil {
		return err
	}
	candidate, err := state.proposed(ctx, tx, vaultID, ev)
	if err != nil {
		return credit.ErrLimit
	}
	for code, policy := range policies {
		before, err := creditBalanceWithProjection(ctx, tx, vaultID, relationshipID, projection, code)
		if err != nil {
			return err
		}
		after, err := creditBalanceWithProjection(ctx, tx, vaultID, relationshipID, candidate, code)
		if err != nil {
			return credit.ErrLimit
		}
		if policy.Exceeded(before, after) {
			return errCreditOverLimit
		}
	}
	return nil
}

// errCreditOverLimit is the one refusal an owner is told about: a clerk's
// tally that the limit stopped. The other ErrLimit answers (replays, id
// collisions, malformed backfills) are protocol guards, not attempts.
var errCreditOverLimit = fmt.Errorf("%w: over the limit", credit.ErrLimit)

// author_seq is intentionally excluded: legacy re-announcements and seq
// conflict recovery may change it. Every immutable financial envelope field
// must still match before an HTTPS duplicate can authorize local application.
func creditDuplicateMatches(ctx context.Context, tx pgx.Tx, vaultID string, ev PushEvent) (bool, error) {
	var matches bool
	err := tx.QueryRow(ctx, `SELECT vault_id=$2::uuid AND event_type=$3 AND schema_version=$4 AND payload=$5::jsonb AND hlc_physical_ms=$6 AND hlc_logical=$7 AND hlc_device_id=$8::uuid AND target_id IS NOT DISTINCT FROM NULLIF($9,'')::uuid AND relationship_id IS NOT DISTINCT FROM NULLIF($10,'')::uuid AND (CASE WHEN NULLIF(event_sig_b64,'') IS NOT NULL THEN signed_actor_account_id ELSE account_id END) IS NOT DISTINCT FROM NULLIF($11,'')::uuid AND (NULLIF(event_sig_b64,'') IS NULL OR (event_sig_b64=$12 AND signer_device_pubkey=$13)) FROM events WHERE event_id=$1::uuid`, ev.EventID, vaultID, ev.EventType, ev.SchemaVersion, string(ev.Payload), ev.HLC.PhysicalMS, ev.HLC.Logical, ev.HLC.DeviceID, derefStr(ev.TargetID), derefStr(ev.RelationshipID), derefStr(ev.ActorAccountID), derefStr(ev.EventSigB64), derefStr(ev.SignerDevicePubkeyB64)).Scan(&matches)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return matches, err
}

// Acquire global entry-id locks in one order before the per-vault admission
// lock. Different vaults cannot concurrently admit a reused mobile row id.
func lockCreditEntryIDs(ctx context.Context, tx pgx.Tx, events []PushEvent) error {
	ids := map[string]bool{}
	for _, ev := range events {
		if ev.EventType != EventEntryCreated && ev.EventType != EventEntryAmended && ev.EventType != EventEntryDeleted && ev.EventType != EventEntrySettled && ev.EventType != "entry_disputed" && ev.EventType != "entry_accepted" {
			continue
		}
		if ev.TargetID != nil && *ev.TargetID != "" {
			ids[*ev.TargetID] = true
		}
		var p entryCreatedPayload
		if json.Unmarshal(ev.Payload, &p) == nil && p.EntryID != "" {
			ids[p.EntryID] = true
		}
	}
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	for _, id := range ordered {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "credit-entry:"+id); err != nil {
			return err
		}
	}
	return nil
}

// recordCreditRefusal keeps a refused event from ever becoming money on a
// later retry. A genuine over-limit attempt also keeps what an owner needs to
// hear about it (customer, direction, amount, clerk); other refusals keep
// NULL details and are never listed.
func recordCreditRefusal(ctx context.Context, tx pgx.Tx, vaultID string, ev PushEvent, actorAccountID string, overLimit bool) error {
	var relationshipID, entryType, actor *string
	var amountMinor *int64
	var payload entryCreatedPayload
	if overLimit && json.Unmarshal(ev.Payload, &payload) == nil {
		if minor, err := credit.Minor(payload.AmountAFN.String()); err == nil && minor > 0 {
			if _, err := uuid.Parse(payload.RelationshipID); err == nil && (payload.Type == "debt" || payload.Type == "payment") {
				relationshipID, entryType, amountMinor = &payload.RelationshipID, &payload.Type, &minor
			}
		}
		if _, err := uuid.Parse(actorAccountID); err == nil {
			actor = &actorAccountID
		}
	}
	code, err := credit.ResolveCurrency(ctx, tx, vaultID, payload.Currency)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO customer_credit_event_refusals(vault_id,event_id,relationship_id,entry_type,amount_minor,actor_account_id,currency) SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7 WHERE NOT EXISTS(SELECT 1 FROM events WHERE event_id=$2::uuid) ON CONFLICT DO NOTHING`, vaultID, ev.EventID, relationshipID, entryType, amountMinor, actor, code)
	return err
}

// CreditRefusal is one clerk tally a limit stopped, for owners and managers.
type CreditRefusal struct {
	Currency       string `json:"currency"`
	RelationshipID string `json:"relationship_id"`
	Type           string `json:"type"`
	AmountMinor    int64  `json:"amount_minor"`
	ActorAccountID string `json:"actor_account_id"`
	ActorName      string `json:"actor_name"`
	RefusedAtMS    int64  `json:"refused_at_ms"`
}

// CreditRefusals lists the last 30 days of clerk tallies a limit stopped,
// newest first (audit #24: the owner never learned of them). Owner/manager
// only: the people who set limits. Both refusal paths are listed: kaata pushes
// and shared-account appends.
func (h *Handler) CreditRefusals(w http.ResponseWriter, r *http.Request) {
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
	var role string
	err := h.svc.pool.QueryRow(r.Context(), `SELECT m.role FROM vault_members m JOIN vaults v ON v.vault_id=m.vault_id JOIN accounts a ON a.id=m.account_id WHERE m.vault_id=$1::uuid AND m.account_id=$2::uuid AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL AND a.pending_delete_at IS NULL AND (v.archived_at IS NULL OR m.role='owner')`, vaultID, claims.AccountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, 403, "not_member", "membership required")
		return
	}
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if role != "owner" && role != "manager" {
		httpx.ErrorCode(w, 403, "insufficient_role", "manager required")
		return
	}
	rows, err := h.svc.pool.Query(r.Context(), `
		SELECT r.currency,r.relationship_id::text, r.entry_type, r.amount_minor,
		       COALESCE(r.actor_account_id::text, ''),
		       COALESCE(NULLIF(a.display_name, ''), i.self_name, NULLIF(a.name, ''), ''),
		       (EXTRACT(EPOCH FROM r.refused_at) * 1000)::bigint
		  FROM (
		        SELECT currency,relationship_id, entry_type, amount_minor, actor_account_id, refused_at
		          FROM customer_credit_event_refusals
		         WHERE vault_id = $1::uuid AND relationship_id IS NOT NULL
		           AND refused_at > NOW() - INTERVAL '30 days'
		        UNION ALL
		        SELECT t.currency,f.relationship_id, f.entry_type, f.amount_minor, f.actor_account_id, f.refused_at
		          FROM customer_credit_tab_refusals f JOIN tabs t ON t.id=f.tab_id
		         WHERE f.vault_id = $1::uuid AND f.relationship_id IS NOT NULL
		           AND f.refused_at > NOW() - INTERVAL '30 days'
		  ) r
		  LEFT JOIN accounts a ON a.id = r.actor_account_id
		  LEFT JOIN LATERAL (
		        SELECT self_name FROM installs
		         WHERE account_id = r.actor_account_id
		           AND self_name IS NOT NULL AND self_name <> ''
		         ORDER BY last_seen_at DESC
		         LIMIT 1
		  ) i ON TRUE
		 WHERE r.currency=COALESCE(NULLIF($2,''),(SELECT legacy_currency FROM vaults WHERE vault_id=$1::uuid))
		 ORDER BY r.refused_at DESC
		 LIMIT 50`, vaultID, r.URL.Query().Get("currency"))
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	defer rows.Close()
	out := []CreditRefusal{}
	for rows.Next() {
		var item CreditRefusal
		if err := rows.Scan(&item.Currency, &item.RelationshipID, &item.Type, &item.AmountMinor, &item.ActorAccountID, &item.ActorName, &item.RefusedAtMS); err != nil {
			httpx.Error(w, 500, "storage unavailable")
			return
		}
		out = append(out, item)
	}
	if rows.Err() != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	httpx.JSON(w, 200, map[string]any{"refusals": out})
}

// CreditLimits is authoritative [] when empty. GET and PUT are member scoped;
// PUT requires owner/manager and rechecks that standing inside the save lock.
func (h *Handler) CreditLimits(w http.ResponseWriter, r *http.Request) {
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
	tx, err := h.svc.pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var activeAccount string
	err = tx.QueryRow(r.Context(), `SELECT id::text FROM accounts
	 WHERE id=$1::uuid AND pending_delete_at IS NULL FOR KEY SHARE`, claims.AccountID).Scan(&activeAccount)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 401, "account unavailable")
		return
	}
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	if err := credit.Lock(r.Context(), tx, vaultID); err != nil {
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
	if r.Method == http.MethodPut {
		if role != "owner" && role != "manager" {
			httpx.ErrorCode(w, 403, "insufficient_role", "manager required")
			return
		}
		// Missing on older apps: preserve the existing editor restriction rather
		// than silently weakening it when they change a cap.
		var input struct {
			credit.Policy
			RestrictEditors *bool `json:"restrict_editors"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || !input.Policy.Valid() {
			httpx.Error(w, 400, "invalid credit limit")
			return
		}
		p := input.Policy
		p.Currency, err = credit.ResolveCurrency(r.Context(), tx, vaultID, p.Currency)
		if err != nil {
			httpx.Error(w, 400, "invalid currency")
			return
		}
		if _, err := uuid.Parse(p.RelationshipID); err != nil {
			httpx.Error(w, 400, "invalid relationship_id")
			return
		}
		if input.RestrictEditors != nil {
			p.RestrictEditors = *input.RestrictEditors
		} else {
			previous, err := credit.Read(r.Context(), tx, vaultID, p.RelationshipID, p.Currency)
			if err != nil {
				httpx.Error(w, 500, "storage unavailable")
				return
			}
			if previous != nil {
				p.RestrictEditors = previous.RestrictEditors
			}
		}
		projection, err := LoadVaultProjection(r.Context(), tx, vaultID)
		if err != nil {
			httpx.Error(w, 500, "storage unavailable")
			return
		}
		// The kaata default belongs to no customer.
		if p.RelationshipID != credit.DefaultRelationshipID {
			rel := projection.Relationships[p.RelationshipID]
			if rel == nil || rel.ArchivedAt != nil {
				httpx.ErrorCode(w, 409, "relationship_missing", "sync customer first")
				return
			}
		}
		if p.Mode == "clerk_block" {
			for _, member := range projection.Members {
				if p.Restricts(member.Role, "inherit") && member.RemovedAt == nil && strings.HasPrefix(member.AccountID, "local:") {
					code := "clerk_cloud_enrollment_required"
					if member.Role == "editor" {
						code = "staff_cloud_enrollment_required"
					}
					httpx.ErrorCode(w, 409, code, "enroll restricted members with cloud accounts before hard limits")
					return
				}
			}
		}
		p.UpdatedAtMS = time.Now().UnixMilli()
		_, err = tx.Exec(r.Context(), `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms,currency) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8) ON CONFLICT(vault_id,relationship_id,currency) DO UPDATE SET max_collect_minor=EXCLUDED.max_collect_minor,max_pay_minor=EXCLUDED.max_pay_minor,mode=EXCLUDED.mode,restrict_editors=EXCLUDED.restrict_editors,updated_at_ms=EXCLUDED.updated_at_ms`, vaultID, p.RelationshipID, p.MaxCollectMinor, p.MaxPayMinor, p.Mode, p.RestrictEditors, p.UpdatedAtMS, p.Currency)
		if err != nil || tx.Commit(r.Context()) != nil {
			httpx.Error(w, 500, "storage unavailable")
			return
		}
		h.svc.NotifyLive(vaultID)
		httpx.JSON(w, 200, p)
		return
	}
	rows, err := tx.Query(r.Context(), `SELECT relationship_id::text,currency,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms FROM customer_credit_limits WHERE vault_id=$1::uuid ORDER BY relationship_id,currency`, vaultID)
	if err != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	out := []credit.Policy{}
	for rows.Next() {
		var p credit.Policy
		if rows.Scan(&p.RelationshipID, &p.Currency, &p.MaxCollectMinor, &p.MaxPayMinor, &p.Mode, &p.RestrictEditors, &p.UpdatedAtMS) != nil {
			rows.Close()
			httpx.Error(w, 500, "storage unavailable")
			return
		}
		out = append(out, p)
	}
	rows.Close()
	if rows.Err() != nil {
		httpx.Error(w, 500, "storage unavailable")
		return
	}
	httpx.JSON(w, 200, out)
}
