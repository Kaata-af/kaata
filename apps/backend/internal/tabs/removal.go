package tabs

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/httpx"
)

var (
	ErrInvalidRemoval    = errors.New("a valid removal action, request ID and request revision are required")
	ErrRemovalIneligible = errors.New("only an active agreed tally can be removed by agreement")
	ErrRemovalConflict   = errors.New("this removal request has changed; refresh the tally")
	ErrRemovalWrongParty = errors.New("the other party must decide this removal request")
)

const removalSemanticsVersion = "tally-removal-v1"

type RemovalInput struct {
	Action      string `json:"action"`
	RequestID   string `json:"request_id"`
	ExpectedRev *int64 `json:"expected_rev,omitempty"`
}

type removalRequest struct {
	ID, By, AccountID, MemberRole, State string
	ExpectedRev                          int64
	DeciderAccountID                     *string
}

func loadRemovalRequest(ctx context.Context, q querier, tabID, entryID, requestID string) (*removalRequest, error) {
	var r removalRequest
	err := q.QueryRow(ctx, `SELECT id::text,requested_by,requester_account_id::text,requester_member_role,state,expected_rev,decider_account_id::text
	 FROM tab_entry_removal_requests WHERE id=$1::uuid AND tab_id=$2::uuid AND entry_id=$3::uuid`, requestID, tabID, entryID).
		Scan(&r.ID, &r.By, &r.AccountID, &r.MemberRole, &r.State, &r.ExpectedRev, &r.DeciderAccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &r, err
}

// Removal never changes the original acceptance evidence. A second explicit
// agreement appends a reversal, and the original's void pointer changes the
// existing balance projection atomically with that journal entry.
func (s *Service) Removal(ctx context.Context, p Party, entryID string, in RemovalInput) (EntryResponse, error) {
	if p.ActorAccountID == "" {
		return EntryResponse{}, ErrAuthRequired
	}
	if !p.allows(rankEditor) {
		return EntryResponse{}, ErrRoleInsufficient
	}
	id, err := uuid.Parse(in.RequestID)
	if err != nil || id == uuid.Nil || id.String() != in.RequestID ||
		(in.Action != "request" && in.Action != "approve" && in.Action != "decline") ||
		(in.ExpectedRev != nil && *in.ExpectedRev <= 0) || (in.Action == "request" && in.ExpectedRev == nil) {
		return EntryResponse{}, ErrInvalidRemoval
	}
	if _, err = uuid.Parse(entryID); err != nil {
		return EntryResponse{}, ErrEntryNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return EntryResponse{}, err
	}
	defer tx.Rollback(ctx)

	// Request identity is immutable. Read it before taking account locks so
	// approval follows account -> credit -> history -> tab, including the
	// requester's author FK/name lookup. Re-read its state under the tab lock.
	prior, err := loadRemovalRequest(ctx, tx, p.TabID, entryID, in.RequestID)
	if err != nil {
		return EntryResponse{}, err
	}
	if in.Action != "request" && prior == nil {
		return EntryResponse{}, ErrRemovalConflict
	}
	if in.Action != "request" && (prior.By == p.Role || prior.AccountID == p.ActorAccountID) {
		return EntryResponse{}, ErrRemovalWrongParty
	}
	accounts := []string{p.ActorAccountID}
	if in.Action == "approve" && prior.State == "pending" && prior.AccountID != p.ActorAccountID {
		accounts = append(accounts, prior.AccountID)
	}
	sort.Strings(accounts)
	for _, account := range accounts {
		if err = lockActor(ctx, tx, &account); err != nil {
			if account != p.ActorAccountID && errors.Is(err, ErrAuthRequired) {
				return EntryResponse{}, ErrRemovalIneligible
			}
			return EntryResponse{}, err
		}
	}
	selected := p
	var requester *Party
	if in.Action == "approve" && prior.State == "pending" {
		rp, e := partyByAccountRoleQuery(ctx, tx, p.TabID, prior.AccountID, prior.By)
		if e != nil || !rp.allows(rankEditor) {
			if e != nil && !errors.Is(e, ErrNotFound) {
				return EntryResponse{}, e
			}
			return EntryResponse{}, ErrRemovalIneligible
		}
		requester = &rp
	}
	// Both consenting sides retain their current credit restrictions. A
	// restricted editor cannot bypass a repayment cap by asking the peer to
	// perform the balance-changing approval on the editor's behalf.
	vaults := map[string]bool{}
	if p.VaultID != nil {
		vaults[*p.VaultID] = true
	}
	if requester != nil && requester.VaultID != nil {
		vaults[*requester.VaultID] = true
	}
	keys := make([]string, 0, len(vaults))
	for key := range vaults {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err = credit.Lock(ctx, tx, key); err != nil {
			return EntryResponse{}, err
		}
	}
	if err = lockRecordingSource(ctx, tx, p.TabID); err != nil {
		return EntryResponse{}, err
	}
	locked, err := lockOpenTab(ctx, tx, p.TabID)
	if err != nil {
		return EntryResponse{}, err
	}
	p, err = recheckParty(ctx, tx, p, rankEditor, false)
	if err != nil {
		return EntryResponse{}, err
	}
	if !sameCreditVault(selected, p) {
		return EntryResponse{}, ErrNotFound
	}
	if requester != nil {
		current, e := recheckParty(ctx, tx, *requester, rankEditor, false)
		if e != nil {
			return EntryResponse{}, ErrRemovalIneligible
		}
		if !sameCreditVault(*requester, current) {
			return EntryResponse{}, ErrRemovalConflict
		}
		requester = &current
	}
	e, err := loadEntryForUpdate(ctx, tx, p.TabID, entryID)
	if err != nil {
		return EntryResponse{}, err
	}
	prior, err = loadRemovalRequest(ctx, tx, p.TabID, entryID, in.RequestID)
	if err != nil {
		return EntryResponse{}, err
	}
	respond := func() (EntryResponse, error) {
		tab, e2 := loadTabForParty(ctx, tx, p)
		return EntryResponse{Entry: e, Tab: tab}, e2
	}
	if prior != nil {
		if e.RemovalRequestID == nil || *e.RemovalRequestID != in.RequestID {
			return EntryResponse{}, ErrRemovalConflict
		}
		if in.Action == "request" {
			if prior.AccountID != p.ActorAccountID || prior.By != p.Role || prior.ExpectedRev != *in.ExpectedRev {
				return EntryResponse{}, ErrRemovalConflict
			}
			return respond()
		}
		if prior.By == p.Role || prior.AccountID == p.ActorAccountID {
			return EntryResponse{}, ErrRemovalWrongParty
		}
		wanted := "approved"
		if in.Action == "decline" {
			wanted = "declined"
		}
		if prior.State == wanted && prior.DeciderAccountID != nil && *prior.DeciderAccountID == p.ActorAccountID {
			return respond()
		}
		if prior.State != "pending" {
			return EntryResponse{}, ErrRemovalConflict
		}
	} else if in.Action != "request" {
		return EntryResponse{}, ErrRemovalConflict
	}
	if locked.RecordingMode != "review" || e.Kind != "entry" || e.Status != "accepted" {
		return EntryResponse{}, ErrRemovalIneligible
	}
	if e.VoidedByEntryID != nil {
		return EntryResponse{}, ErrAlreadyVoided
	}
	if in.ExpectedRev != nil && e.Rev != *in.ExpectedRev {
		return EntryResponse{}, ErrStaleReview
	}
	if in.Action == "request" && e.RemovalState != nil && *e.RemovalState == "pending" {
		return EntryResponse{}, ErrRemovalConflict
	}
	var settled bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tab_settlements WHERE tab_id=$1::uuid AND through_seq >= $2)`, p.TabID, e.Seq).Scan(&settled); err != nil {
		return EntryResponse{}, err
	}
	if settled {
		return EntryResponse{}, ErrSettledRecord
	}
	carried, err := recordedEntryCarriedForward(ctx, tx, p.TabID)
	if err != nil {
		return EntryResponse{}, err
	}
	if carried {
		return EntryResponse{}, ErrRecordedHistoryFinal
	}

	now := nowMS()
	state, kind := "pending", "entry_removal_requested"
	var admissions []*linkCreditAdmission
	if in.Action == "approve" {
		state, kind = "approved", "entry_removal_approved"
		if requester == nil {
			return EntryResponse{}, ErrRemovalConflict
		}
		for _, party := range []Party{p, *requester} {
			admission, e2 := s.beginPartyCredit(ctx, tx, party)
			if e2 != nil {
				return EntryResponse{}, e2
			}
			admissions = append(admissions, admission)
		}
	} else if in.Action == "decline" {
		state, kind = "declined", "entry_removal_declined"
	}
	if in.Action == "request" {
		result, e2 := tx.Exec(ctx, `INSERT INTO tab_entry_removal_requests
		 (id,tab_id,entry_id,requested_by,requester_account_id,requester_member_role,expected_rev,requested_at_ms,state)
		 VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,$8,'pending') ON CONFLICT(id) DO NOTHING`,
			in.RequestID, p.TabID, entryID, p.Role, p.ActorAccountID, p.evidenceRole(), *in.ExpectedRev, now)
		if e2 != nil {
			return EntryResponse{}, e2
		}
		if result.RowsAffected() != 1 {
			return EntryResponse{}, ErrRemovalConflict
		}
	} else {
		_, err = tx.Exec(ctx, `UPDATE tab_entry_removal_requests SET state=$2,decided_by=$3,decider_account_id=$4::uuid,decided_at_ms=$5 WHERE id=$1::uuid`, in.RequestID, state, p.Role, p.ActorAccountID, now)
		if err != nil {
			return EntryResponse{}, err
		}
	}
	rev, err := bumpRev(ctx, tx, p.TabID, p.Role, p.pushEvent(kind, entryID))
	if err != nil {
		return EntryResponse{}, err
	}
	var reversalID *string
	if in.Action == "approve" {
		seq, e2 := nextSeq(ctx, tx, p.TabID)
		if e2 != nil {
			return EntryResponse{}, e2
		}
		void, e2 := insertEntry(ctx, tx, p.TabID, uuid.NewString(), seq, rev, prior.By, opposite(e.Direction), e.amountMinor, "void", nil, now, "accepted", &now, &e.ID, &prior.AccountID, &prior.MemberRole)
		if e2 != nil {
			return EntryResponse{}, e2
		}
		reversalID = &void.ID
		_, err = tx.Exec(ctx, `UPDATE tab_entries SET reviewer_account_id=$2::uuid,
		 reviewer_name=COALESCE((SELECT COALESCE(display_name,name) FROM accounts WHERE id=$2::uuid),''),
		 reviewer_party=$3,reviewer_member_role=$4,review_semantics_version=$5 WHERE id=$1::uuid`, void.ID, p.ActorAccountID, p.Role, p.evidenceRole(), removalSemanticsVersion)
		if err != nil {
			return EntryResponse{}, err
		}
	}
	requesterSide := p.Role
	if prior != nil {
		requesterSide = prior.By
	}
	e, err = scanEntry(tx.QueryRow(ctx, `UPDATE tab_entries SET removal_request_id=$3::uuid,removal_requested_by=$4,removal_state=$5,rev=$6,
	 voided_by_entry_id=COALESCE($7::uuid,voided_by_entry_id) WHERE tab_id=$1::uuid AND id=$2::uuid RETURNING `+entryCols,
		p.TabID, entryID, in.RequestID, requesterSide, state, rev, reversalID))
	if err != nil {
		return EntryResponse{}, fmt.Errorf("update removal: %w", err)
	}
	if in.Action != "request" {
		if err = markEntryNoticesRead(ctx, tx, p, entryID); err != nil {
			return EntryResponse{}, err
		}
	}
	for _, admission := range admissions {
		if err = s.finishLinkCredit(ctx, tx, admission); err != nil {
			return EntryResponse{}, err
		}
	}
	response, err := respond()
	if err != nil {
		return EntryResponse{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EntryResponse{}, err
	}
	s.poke(ctx, p.TabID)
	return response, nil
}

func (h *Handler) Removal(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	p, ok := h.partyOr404(w, r)
	if !ok {
		return
	}
	var in RemovalInput
	if !decodeBody(w, r, &in) {
		return
	}
	response, err := h.svc.Removal(r.Context(), p, chi.URLParam(r, "id"), in)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}
