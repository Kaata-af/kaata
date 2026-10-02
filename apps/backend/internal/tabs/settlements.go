package tabs

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/httpx"
)

var (
	ErrSettlementNotZero = errors.New("shared balance must be zero before settling")
	ErrSettlementPending = errors.New("review all pending tallies before settling")
	ErrSettlementEmpty   = errors.New("there are no new tallies to settle")
	ErrStaleSettlement   = errors.New("shared account changed; refresh before settling")
)

// A marker records one authorized actor's action at a server-verified zero
// balance with no pending reviews. It is not a payment, debt waiver, signature,
// or statement that the other party separately agreed to this marker.
const settlementSemanticsVersion = "tally-zero-settlement-v1"

type Settlement struct {
	ID               string `json:"id"`
	Rev              int64  `json:"rev"`
	ThroughSeq       int64  `json:"through_seq"`
	SettledAtMS      int64  `json:"settled_at_ms"`
	CreatedBy        string `json:"created_by"`
	ActorAccountID   string `json:"actor_account_id"`
	ActorName        string `json:"actor_name"`
	ActorMemberRole  string `json:"actor_member_role"`
	SemanticsVersion string `json:"semantics_version"`
}

type SettleInput struct {
	ID          string
	ExpectedRev int64
}

type SettlementResponse struct {
	Settlement Settlement `json:"settlement"`
	Tab        Tab        `json:"tab"`
	Created    bool       `json:"-"`
}

const settlementCols = `id::text, rev, through_seq, settled_at_ms, created_by,
	actor_account_id::text, actor_name, actor_member_role, semantics_version`

func scanSettlement(row pgx.Row) (Settlement, error) {
	var s Settlement
	err := row.Scan(&s.ID, &s.Rev, &s.ThroughSeq, &s.SettledAtMS, &s.CreatedBy,
		&s.ActorAccountID, &s.ActorName, &s.ActorMemberRole, &s.SemanticsVersion)
	return s, err
}

func loadSettlements(ctx context.Context, q querier, tabID string, afterRev int64) ([]Settlement, error) {
	rows, err := q.Query(ctx, `SELECT `+settlementCols+` FROM tab_settlements
		WHERE tab_id=$1::uuid AND rev>$2 ORDER BY rev`, tabID, afterRev)
	if err != nil {
		return nil, fmt.Errorf("load settlements: %w", err)
	}
	defer rows.Close()
	out := make([]Settlement, 0)
	for rows.Next() {
		s, err := scanSettlement(rows)
		if err != nil {
			return nil, fmt.Errorf("scan settlement: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (s *Service) Settle(ctx context.Context, p Party, in SettleInput) (SettlementResponse, error) {
	if p.ActorAccountID == "" {
		return SettlementResponse{}, ErrAuthRequired
	}
	if !p.allows(rankEditor) {
		return SettlementResponse{}, ErrRoleInsufficient
	}
	if _, err := uuid.Parse(in.ID); err != nil {
		return SettlementResponse{}, ErrIDTaken
	}
	tx, err := s.beginMutation(ctx, p.actorAccount())
	if err != nil {
		return SettlementResponse{}, err
	}
	defer tx.Rollback(ctx)
	locked, err := lockTab(ctx, tx, p.TabID)
	if err != nil {
		return SettlementResponse{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, false)
	if err != nil {
		return SettlementResponse{}, err
	}
	// Same-request retries read the existing action even after later entries
	// or closure. They never create another marker or change actor attribution.
	var existingTab string
	err = tx.QueryRow(ctx, `SELECT tab_id::text FROM tab_settlements WHERE id=$1::uuid`, in.ID).Scan(&existingTab)
	if err == nil {
		if existingTab != p.TabID {
			return SettlementResponse{}, ErrIDTaken
		}
		marker, err := scanSettlement(tx.QueryRow(ctx, `SELECT `+settlementCols+` FROM tab_settlements WHERE id=$1::uuid`, in.ID))
		if err != nil {
			return SettlementResponse{}, err
		}
		if marker.CreatedBy != p.Role || marker.ActorAccountID != p.ActorAccountID {
			return SettlementResponse{}, ErrIDTaken
		}
		tab, err := loadTab(ctx, tx, p.TabID, p.Role)
		return SettlementResponse{Settlement: marker, Tab: tab}, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return SettlementResponse{}, fmt.Errorf("settlement idempotency: %w", err)
	}
	if locked.ClosedAt != nil {
		return SettlementResponse{}, ErrTabClosed
	}
	if in.ExpectedRev <= 0 || locked.Rev != in.ExpectedRev {
		return SettlementResponse{}, ErrStaleSettlement
	}
	var throughSeq, balance, pending, newEntries int64
	err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq),0),
		COALESCE(SUM(CASE WHEN direction='a_to_b' THEN amount_minor ELSE -amount_minor END)
		  FILTER (WHERE kind<>'void' AND voided_by_entry_id IS NULL AND status<>'disputed'),0)::bigint,
		COUNT(*) FILTER (WHERE kind<>'void' AND voided_by_entry_id IS NULL AND status='pending'),
		COUNT(*) FILTER (WHERE kind<>'void' AND seq>COALESCE(
		  (SELECT MAX(through_seq) FROM tab_settlements WHERE tab_id=$1::uuid),0))
		FROM tab_entries WHERE tab_id=$1::uuid`, p.TabID).Scan(&throughSeq, &balance, &pending, &newEntries)
	if err != nil {
		return SettlementResponse{}, fmt.Errorf("check settlement boundary: %w", err)
	}
	if pending != 0 {
		return SettlementResponse{}, ErrSettlementPending
	}
	if balance != 0 {
		return SettlementResponse{}, ErrSettlementNotZero
	}
	if newEntries == 0 {
		return SettlementResponse{}, ErrSettlementEmpty
	}
	rev, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent("updated", ""))
	if err != nil {
		return SettlementResponse{}, err
	}
	marker, err := scanSettlement(tx.QueryRow(ctx, `INSERT INTO tab_settlements
		(id,tab_id,rev,through_seq,settled_at_ms,created_by,actor_account_id,actor_name,actor_member_role,semantics_version)
		VALUES($1::uuid,$2::uuid,$3,$4,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint,$5,$6::uuid,
		  COALESCE((SELECT name FROM accounts WHERE id=$6::uuid),''),$7,$8)
		ON CONFLICT(id) DO NOTHING RETURNING `+settlementCols,
		in.ID, p.TabID, rev, throughSeq, p.Role, p.ActorAccountID, p.evidenceRole(), settlementSemanticsVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		return SettlementResponse{}, ErrIDTaken
	}
	if err != nil {
		return SettlementResponse{}, fmt.Errorf("insert settlement: %w", err)
	}
	tab, err := loadTab(ctx, tx, p.TabID, p.Role)
	if err != nil {
		return SettlementResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SettlementResponse{}, fmt.Errorf("commit settlement: %w", err)
	}
	s.poke(ctx, p.TabID)
	return SettlementResponse{Settlement: marker, Tab: tab, Created: true}, nil
}

// Settle requires a server-confirmed current view; it is not an offline write.
func (h *Handler) Settle(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	var req struct {
		ID          string `json:"id"`
		ExpectedRev *int64 `json:"expected_rev"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if _, err := uuid.Parse(req.ID); err != nil || req.ExpectedRev == nil || *req.ExpectedRev <= 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_body", "id must be a uuid and expected_rev must be a positive integer")
		return
	}
	res, err := h.svc.Settle(r.Context(), p, SettleInput{ID: req.ID, ExpectedRev: *req.ExpectedRev})
	if err != nil {
		writeServiceError(w, err)
		return
	}
	status := http.StatusOK
	if res.Created {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, res)
}
