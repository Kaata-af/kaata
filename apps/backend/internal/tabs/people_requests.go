package tabs

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/httpx"
)

var ErrPeopleRequestLimited = errors.New("a request was already sent to this person recently")
var ErrPeopleRequestInboxFull = errors.New("this person has too many pending requests; try again later")

type PeopleRequest struct {
	ID          string                  `json:"id"`
	GroupID     string                  `json:"group_id"`
	Token       string                  `json:"token"`
	From        auth.DiscoverablePerson `json:"from"`
	CreatedAtMS int64                   `json:"created_at_ms"`
}

// Direct selectors carry no secret. Every use rechecks the recipient in the
// same transaction as joining, including when a normal link token is supplied.
func directRequestID(token string) (string, bool) {
	if !strings.HasPrefix(token, "r_") {
		return "", false
	}
	id, err := uuid.Parse(strings.TrimPrefix(token, "r_"))
	if err != nil {
		return "", false
	}
	return id.String(), true
}

func groupInvitationID(ctx context.Context, q querier, token, account string) (string, error) {
	var id string
	var err error
	if request, ok := directRequestID(token); ok {
		err = q.QueryRow(ctx, `SELECT group_id::text FROM people_requests WHERE id=$1::uuid AND recipient_account_id=$2::uuid`, request, account).Scan(&id)
	} else {
		value, e := groupToken(token)
		if e != nil {
			return "", e
		}
		err = q.QueryRow(ctx, `SELECT id::text FROM tab_groups WHERE invite_token_hash=$1`, hashPartyToken(value)).Scan(&id)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

func checkGroupInvitation(ctx context.Context, q querier, g groupRow, token, account string) error {
	var requestID, recipient string
	var declined *time.Time
	var expires time.Time
	var senderActive bool
	err := q.QueryRow(ctx, `SELECT r.id::text,r.recipient_account_id::text,r.declined_at,r.expires_at,
 a.disabled_at IS NULL AND a.pending_delete_at IS NULL
 FROM people_requests r JOIN accounts a ON a.id=r.sender_account_id WHERE r.group_id=$1::uuid`, g.ID).Scan(&requestID, &recipient, &declined, &expires, &senderActive)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	hasRequest := err == nil
	if hasRequest {
		// Accepted joins remain replayable after expiry. Declining a pending
		// request also revokes the sender's original link for this group.
		if recipient != account || declined != nil || (g.BJoined == nil && (!senderActive || !expires.After(time.Now()))) {
			return ErrNotFound
		}
	}
	if request, ok := directRequestID(token); ok {
		if !hasRequest || request != requestID {
			return ErrNotFound
		}
		return nil
	}
	value, err := groupToken(token)
	if err != nil || g.InviteHash != hashPartyToken(value) {
		return ErrNotFound
	}
	return nil
}

func (s *Service) SendPeopleRequest(ctx context.Context, account, groupID, recipient string) (PeopleRequest, error) {
	out := PeopleRequest{}
	if _, err := uuid.Parse(groupID); err != nil {
		return out, ErrNotFound
	}
	if _, err := uuid.Parse(recipient); err != nil || recipient == account {
		return out, ErrNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	// Friendship mutation and account deletion lock accounts before groups.
	// Taking only the sender first can deadlock with a pair update while the
	// request insert waits on its recipient FK, so acquire both in UUID order.
	rows, err := tx.Query(ctx, `SELECT id::text,disabled_at IS NULL AND pending_delete_at IS NULL
 FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, []string{account, recipient})
	if err != nil {
		return out, err
	}
	active := map[string]bool{}
	for rows.Next() {
		var id string
		var available bool
		if err := rows.Scan(&id, &available); err != nil {
			rows.Close()
			return out, err
		}
		active[id] = available
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	if !active[account] {
		return out, ErrAuthRequired
	}
	if !active[recipient] {
		return out, ErrNotFound
	}
	g, err := loadGroup(ctx, tx, groupID, true)
	if err != nil {
		return out, err
	}
	p, err := groupAuthorized(ctx, tx, g, account, "a", rankEditor)
	if err != nil || p.Role != "a" {
		return out, ErrNotFound
	}
	if g.Closed != nil || g.BClaimed || g.BAccount != nil || g.BVault != nil {
		return out, ErrGroupChanged
	}
	// A lost send response retries the same request without extending expiry
	// or generating another inbox item. Its destination cannot be changed.
	var existingRecipient string
	var created time.Time
	var valid bool
	err = tx.QueryRow(ctx, `SELECT id::text,recipient_account_id::text,created_at,declined_at IS NULL AND expires_at>NOW() FROM people_requests WHERE group_id=$1::uuid`, groupID).Scan(&out.ID, &existingRecipient, &created, &valid)
	if err == nil {
		if recipient != existingRecipient {
			return out, ErrGroupChanged
		}
		if !valid {
			return out, ErrPeopleRequestLimited
		}
		out.GroupID, out.Token, out.CreatedAtMS = groupID, "r_"+out.ID, created.UnixMilli()
		return out, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	var eligible bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM accounts WHERE id=$1::uuid
 AND disabled_at IS NULL AND pending_delete_at IS NULL
 AND (discovery_enabled OR EXISTS(SELECT 1 FROM account_friendships f
 WHERE f.account_low_id=LEAST($1::uuid,$2::uuid) AND f.account_high_id=GREATEST($1::uuid,$2::uuid)
 AND f.status='accepted')))`, recipient, account).Scan(&eligible)
	if err != nil {
		return out, err
	}
	if !eligible {
		return out, ErrNotFound
	}
	// A sender cannot evade the per-person cooldown by making new groups.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "people-recipient:"+recipient); err != nil {
		return out, err
	}
	var recent bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM people_requests WHERE sender_account_id=$1::uuid AND recipient_account_id=$2::uuid AND created_at>NOW()-INTERVAL '1 day')`, account, recipient).Scan(&recent)
	if err != nil {
		return out, err
	}
	if recent {
		return out, ErrPeopleRequestLimited
	}
	var pending int
	err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM people_requests r JOIN tab_groups g ON g.id=r.group_id
 WHERE r.recipient_account_id=$1::uuid AND r.declined_at IS NULL AND r.expires_at>NOW()
 AND g.closed_at IS NULL AND g.b_joined_at IS NULL AND NOT g.b_account_bound_once`, recipient).Scan(&pending)
	if err != nil {
		return out, err
	}
	if pending >= 50 {
		return out, ErrPeopleRequestInboxFull
	}
	err = tx.QueryRow(ctx, `INSERT INTO people_requests(group_id,sender_account_id,recipient_account_id) VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id::text,created_at`, groupID, account, recipient).Scan(&out.ID, &created)
	if err != nil {
		return out, err
	}
	out.GroupID, out.Token, out.CreatedAtMS = groupID, "r_"+out.ID, created.UnixMilli()
	return out, tx.Commit(ctx)
}

func (s *Service) ListPeopleRequests(ctx context.Context, account string) ([]PeopleRequest, error) {
	out := []PeopleRequest{}
	rows, err := s.pool.Query(ctx, `SELECT r.id::text,r.group_id::text,r.created_at,a.id::text,
 COALESCE(NULLIF(a.display_name,''),a.name,''),CASE WHEN a.discovery_enabled THEN COALESCE(a.username,'') ELSE '' END,COALESCE(a.picture_url,'')
 FROM people_requests r JOIN tab_groups g ON g.id=r.group_id JOIN accounts a ON a.id=r.sender_account_id
 WHERE r.recipient_account_id=$1::uuid AND r.declined_at IS NULL AND r.expires_at>NOW()
 AND g.closed_at IS NULL AND g.b_joined_at IS NULL AND NOT g.b_account_bound_once
 AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL ORDER BY r.created_at DESC,r.id DESC LIMIT 50`, account)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item PeopleRequest
		var created time.Time
		if err := rows.Scan(&item.ID, &item.GroupID, &created, &item.From.AccountID, &item.From.Name, &item.From.Username, &item.From.PictureURL); err != nil {
			return out, err
		}
		item.Token, item.CreatedAtMS = "r_"+item.ID, created.UnixMilli()
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Service) DeclinePeopleRequest(ctx context.Context, account, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return ErrNotFound
	}
	tx, err := s.beginMutation(ctx, &account)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var group string
	err = tx.QueryRow(ctx, `SELECT group_id::text FROM people_requests WHERE id=$1::uuid AND recipient_account_id=$2::uuid`, id, account).Scan(&group)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	g, err := loadGroup(ctx, tx, group, true)
	if err != nil {
		return err
	}
	if g.BJoined != nil || g.BClaimed {
		return ErrGroupChanged
	}
	_, err = tx.Exec(ctx, `UPDATE people_requests SET declined_at=COALESCE(declined_at,NOW()) WHERE id=$1::uuid`, id)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (h *Handler) SendPeopleRequest(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	var req struct {
		GroupID   string `json:"group_id"`
		Recipient string `json:"recipient_account_id"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	out, err := h.svc.SendPeopleRequest(r.Context(), claims.AccountID, req.GroupID, req.Recipient)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, 201, out)
}
func (h *Handler) ListPeopleRequests(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	items, err := h.svc.ListPeopleRequests(r.Context(), claims.AccountID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"requests": items})
}
func (h *Handler) DeclinePeopleRequest(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	claims, ok := groupClaims(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeclinePeopleRequest(r.Context(), claims.AccountID, chi.URLParam(r, "request_id")); err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
