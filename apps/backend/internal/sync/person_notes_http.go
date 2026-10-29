package sync

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

type PersonNotesResponse struct {
	VaultID            string        `json:"vault_id"`
	Events             []PulledEvent `json:"events"`
	HasMore            bool          `json:"has_more"`
	NextAfterServerSeq int64         `json:"next_after_server_seq"`
}

// PersonNotes serves a separate, bounded recovery stream. Clients that restored
// an older snapshot can recover ignored notes without rewinding financial sync.
func (h *Handler) PersonNotes(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	vaultID, err := uuid.Parse(r.URL.Query().Get("vault_id"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "vault_id must be a uuid")
		return
	}
	after := int64(0)
	if raw := r.URL.Query().Get("after_server_seq"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || after < 0 {
			httpx.Error(w, http.StatusBadRequest, "after_server_seq must be a nonnegative integer")
			return
		}
	}
	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit <= 0 {
			httpx.Error(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
	}
	if !h.allowCurrencyClient(w, r, vaultID.String(), claims.AccountID) {
		return
	}
	response, err := h.svc.PersonNoteEvents(r.Context(), claims.AccountID, vaultID.String(), after, limit)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember), errors.Is(err, ErrVaultNotFound), errors.Is(err, ErrVaultArchived):
			writeMembershipDenied(w, err)
		default:
			log.Printf("sync.person-notes failed for account=%s vault=%s: %v", claims.AccountID, vaultID, err)
			httpx.Error(w, http.StatusServiceUnavailable, "customer notes recovery failed")
		}
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (s *Service) PersonNoteEvents(ctx context.Context, accountID, vaultID string, after int64, limit int) (*PersonNotesResponse, error) {
	// Same uncached ACL as ordinary pull: revoked/invited/nonmember contacts
	// cannot obtain staff notes, including notes on a linked shared account.
	if err := s.checkMembershipFresh(ctx, accountID, vaultID); err != nil {
		return nil, err
	}
	response, err := readPersonNotePage(ctx, s.pool, vaultID, after, limit)
	if err != nil {
		return nil, err
	}
	s.resolveBindingsOnPulled(ctx, vaultID, response.Events)
	return response, nil
}

func readPersonNotePage(ctx context.Context, query snapshotEventQuerier, vaultID string, after int64, limit int) (*PersonNotesResponse, error) {
	if after < 0 {
		return nil, errors.New("invalid note recovery cursor")
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := query.Query(ctx, `
		SELECT`+pulledEventColumns+`
		FROM events
		WHERE vault_id = $1::uuid
		  AND server_seq > $2
		  AND redacted_at IS NULL
		  AND event_type = 'person_note_set'
		ORDER BY server_seq ASC
		LIMIT $3
	`, vaultID, after, limit+1)
	if err != nil {
		return nil, err
	}
	events, err := scanPulledEvents(rows)
	if err != nil {
		return nil, err
	}
	hasMore := len(events) > limit
	if hasMore {
		events = events[:limit]
	}
	next := after
	if len(events) > 0 {
		next = events[len(events)-1].ServerSeq
	}
	return &PersonNotesResponse{VaultID: vaultID, Events: events, HasMore: hasMore, NextAfterServerSeq: next}, nil
}
