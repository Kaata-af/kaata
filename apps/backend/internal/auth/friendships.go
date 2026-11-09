package auth

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrPersonUnavailable     = errors.New("person unavailable")
	ErrFriendRequestNotFound = errors.New("friend request not found")
	ErrFriendRequestLimited  = errors.New("please wait before sending another friend request")
	ErrFriendRequestCapacity = errors.New("too many pending friend requests")
	ErrInvalidFriendAccount  = errors.New("account_id must identify another account")
	ErrInvalidFriendCursor   = errors.New("invalid friends cursor")
)

const friendRequestTTL = 14 * 24 * time.Hour
const friendRequestCooldown = 24 * time.Hour
const maxPendingFriendRequests = 50
const friendPageSize = 50

type FriendshipState struct {
	State string `json:"state"`
	ID    string `json:"id,omitempty"`
}

type FriendshipResult struct {
	Friendship FriendshipState `json:"friendship"`
}

type PersonProfileResult struct {
	Person             DiscoverablePerson     `json:"person"`
	Friendship         FriendshipState        `json:"friendship"`
	CanReceiveRequests bool                   `json:"can_receive_requests"`
	Activity           *PersonProfileActivity `json:"activity,omitempty"`
}

type FriendsPage struct {
	Friends    []DiscoverablePerson `json:"friends"`
	NextCursor string               `json:"next_cursor,omitempty"`
}

type FriendRequest struct {
	ID          string             `json:"id"`
	From        DiscoverablePerson `json:"from"`
	CreatedAtMS int64              `json:"created_at_ms"`
}

type friendshipRow struct {
	id, low, high, requestedBy, status string
	created, updated, expires          time.Time
}

func canonicalFriendID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

func (f friendshipRow) state(viewer string) FriendshipState {
	if f.status == "accepted" {
		return FriendshipState{State: "friends", ID: f.id}
	}
	if f.status == "pending" && f.expires.After(time.Now()) {
		if f.requestedBy == viewer {
			return FriendshipState{State: "outgoing", ID: f.id}
		}
		return FriendshipState{State: "incoming", ID: f.id}
	}
	return FriendshipState{State: "none"}
}

func scanFriendship(row pgx.Row) (friendshipRow, error) {
	var f friendshipRow
	err := row.Scan(&f.id, &f.low, &f.high, &f.requestedBy, &f.status, &f.created, &f.updated, &f.expires)
	return f, err
}

const friendshipColumns = `id::text,account_low_id::text,account_high_id::text,requested_by::text,status,created_at,updated_at,expires_at`

type friendAccountState struct{ active, discoverable bool }

// Match deletion's account-first order. Strong sorted locks serialize all
// incoming/outgoing limits and pair transitions, including cross-send races.
func lockFriendAccounts(ctx context.Context, tx pgx.Tx, ids ...string) (map[string]friendAccountState, error) {
	rows, err := tx.Query(ctx, `SELECT id::text,disabled_at IS NULL AND pending_delete_at IS NULL,discovery_enabled FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := map[string]friendAccountState{}
	for rows.Next() {
		var id string
		var state friendAccountState
		if err := rows.Scan(&id, &state.active, &state.discoverable); err != nil {
			return nil, err
		}
		states[id] = state
	}
	return states, rows.Err()
}

func (s *Service) activeFriendViewer(ctx context.Context, viewer string) error {
	if !canonicalFriendID(viewer) {
		return ErrSessionRevoked
	}
	var active bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM accounts WHERE id=$1::uuid AND disabled_at IS NULL AND pending_delete_at IS NULL)`, viewer).Scan(&active); err != nil {
		return err
	}
	if !active {
		return ErrSessionRevoked
	}
	return nil
}

func (s *Service) PeopleProfile(ctx context.Context, viewer, target string) (PersonProfileResult, error) {
	out := PersonProfileResult{Friendship: FriendshipState{State: "none"}}
	if !canonicalFriendID(target) {
		return out, ErrPersonUnavailable
	}
	if err := s.activeFriendViewer(ctx, viewer); err != nil {
		return out, err
	}
	var f friendshipRow
	err := s.pool.QueryRow(ctx, `SELECT a.id::text,COALESCE(NULLIF(a.display_name,''),a.name,''),
 CASE WHEN a.discovery_enabled OR f.status='accepted' OR a.id=$1::uuid THEN COALESCE(a.username,'') ELSE '' END,COALESCE(a.picture_url,''),
 COALESCE(f.id::text,''),COALESCE(f.requested_by::text,''),COALESCE(f.status,''),COALESCE(f.expires_at,NOW()),
 a.id<>$1::uuid AND (a.discovery_enabled OR COALESCE(f.status='accepted',FALSE))
 FROM accounts a LEFT JOIN account_friendships f ON f.account_low_id=LEAST(a.id,$1::uuid) AND f.account_high_id=GREATEST(a.id,$1::uuid)
 WHERE a.id=$2::uuid AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
 AND EXISTS(SELECT 1 FROM accounts viewer WHERE viewer.id=$1::uuid AND viewer.disabled_at IS NULL AND viewer.pending_delete_at IS NULL)
 AND (a.id=$1::uuid OR a.discovery_enabled OR f.status='accepted' OR (f.status='pending' AND f.expires_at>NOW()))`, viewer, target).
		Scan(&out.Person.AccountID, &out.Person.Name, &out.Person.Username, &out.Person.PictureURL, &f.id, &f.requestedBy, &f.status, &f.expires, &out.CanReceiveRequests)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrPersonUnavailable
	}
	if err != nil {
		return out, err
	}
	out.Friendship = f.state(viewer)
	return out, nil
}

func (s *Service) Friends(ctx context.Context, viewer, after string) (FriendsPage, error) {
	out := FriendsPage{Friends: []DiscoverablePerson{}}
	if after != "" && !canonicalFriendID(after) {
		return out, ErrInvalidFriendCursor
	}
	if err := s.activeFriendViewer(ctx, viewer); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT a.id::text,COALESCE(NULLIF(a.display_name,''),a.name,''),COALESCE(a.username,''),COALESCE(a.picture_url,'')
 FROM account_friendships f JOIN accounts a ON a.id=CASE WHEN f.account_low_id=$1::uuid THEN f.account_high_id ELSE f.account_low_id END
 WHERE (f.account_low_id=$1::uuid OR f.account_high_id=$1::uuid) AND f.status='accepted'
 AND EXISTS(SELECT 1 FROM accounts viewer WHERE viewer.id=$1::uuid AND viewer.disabled_at IS NULL AND viewer.pending_delete_at IS NULL)
 AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL AND (NULLIF($2,'')::uuid IS NULL OR a.id>NULLIF($2,'')::uuid)
 ORDER BY a.id LIMIT $3`, viewer, after, friendPageSize+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var p DiscoverablePerson
		if err := rows.Scan(&p.AccountID, &p.Name, &p.Username, &p.PictureURL); err != nil {
			return out, err
		}
		out.Friends = append(out.Friends, p)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Friends) > friendPageSize {
		out.Friends = out.Friends[:friendPageSize]
		out.NextCursor = out.Friends[friendPageSize-1].AccountID
	}
	return out, nil
}

func (s *Service) FriendRequests(ctx context.Context, viewer string) ([]FriendRequest, error) {
	out := []FriendRequest{}
	if err := s.activeFriendViewer(ctx, viewer); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT f.id::text,f.created_at,a.id::text,COALESCE(NULLIF(a.display_name,''),a.name,''),
 CASE WHEN a.discovery_enabled THEN COALESCE(a.username,'') ELSE '' END,COALESCE(a.picture_url,'')
 FROM account_friendships f JOIN accounts a ON a.id=f.requested_by
 WHERE CASE WHEN f.requested_by=f.account_low_id THEN f.account_high_id ELSE f.account_low_id END=$1::uuid
 AND EXISTS(SELECT 1 FROM accounts viewer WHERE viewer.id=$1::uuid AND viewer.disabled_at IS NULL AND viewer.pending_delete_at IS NULL)
 AND f.status='pending' AND f.expires_at>NOW() AND a.disabled_at IS NULL AND a.pending_delete_at IS NULL
 ORDER BY f.created_at DESC,f.id DESC LIMIT $2`, viewer, maxPendingFriendRequests)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var r FriendRequest
		var created time.Time
		if err := rows.Scan(&r.ID, &created, &r.From.AccountID, &r.From.Name, &r.From.Username, &r.From.PictureURL); err != nil {
			return out, err
		}
		r.CreatedAtMS = created.UnixMilli()
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) SendFriendRequest(ctx context.Context, viewer, target string) (FriendshipState, error) {
	if !canonicalFriendID(target) || target == viewer {
		return FriendshipState{}, ErrInvalidFriendAccount
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FriendshipState{}, err
	}
	defer tx.Rollback(ctx)
	states, err := lockFriendAccounts(ctx, tx, viewer, target)
	if err != nil {
		return FriendshipState{}, err
	}
	if !states[viewer].active {
		return FriendshipState{}, ErrSessionRevoked
	}
	if !states[target].active {
		return FriendshipState{}, ErrPersonUnavailable
	}
	low, high := viewer, target
	if high < low {
		low, high = high, low
	}
	f, err := scanFriendship(tx.QueryRow(ctx, `SELECT `+friendshipColumns+` FROM account_friendships WHERE account_low_id=$1::uuid AND account_high_id=$2::uuid FOR UPDATE`, low, high))
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return FriendshipState{}, err
	}
	if exists && f.state(viewer).State != "none" {
		return f.state(viewer), nil
	}
	if !states[target].discoverable {
		return FriendshipState{}, ErrPersonUnavailable
	}
	if exists && f.status != "pending" && time.Since(f.updated) < friendRequestCooldown {
		return FriendshipState{}, ErrFriendRequestLimited
	}
	var outgoing, incoming int
	if err := tx.QueryRow(ctx, `SELECT
 (SELECT COUNT(*) FROM account_friendships WHERE status='pending' AND expires_at>NOW() AND requested_by=$1::uuid),
 (SELECT COUNT(*) FROM account_friendships WHERE status='pending' AND expires_at>NOW()
  AND CASE WHEN requested_by=account_low_id THEN account_high_id ELSE account_low_id END=$2::uuid)`, viewer, target).Scan(&outgoing, &incoming); err != nil {
		return FriendshipState{}, err
	}
	if outgoing >= maxPendingFriendRequests || incoming >= maxPendingFriendRequests {
		return FriendshipState{}, ErrFriendRequestCapacity
	}
	id := uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, err = tx.Exec(ctx, `INSERT INTO account_friendships(id,account_low_id,account_high_id,requested_by,created_at,updated_at,expires_at)
 VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$5,$6)
 ON CONFLICT(account_low_id,account_high_id) DO UPDATE SET id=EXCLUDED.id,requested_by=EXCLUDED.requested_by,status='pending',created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at,accepted_at=NULL`, id, low, high, viewer, now, now.Add(friendRequestTTL))
	if err != nil {
		return FriendshipState{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FriendshipState{}, err
	}
	return FriendshipState{State: "outgoing", ID: id}, nil
}

func (s *Service) AcceptFriendRequest(ctx context.Context, viewer, id string) (FriendshipState, error) {
	return s.changeFriendship(ctx, viewer, id, "accept")
}
func (s *Service) DeleteFriendRequest(ctx context.Context, viewer, id string) error {
	_, err := s.changeFriendship(ctx, viewer, id, "request_delete")
	return err
}
func (s *Service) RemoveFriend(ctx context.Context, viewer, id string) error {
	_, err := s.changeFriendship(ctx, viewer, id, "remove")
	return err
}

func (s *Service) changeFriendship(ctx context.Context, viewer, id, action string) (FriendshipState, error) {
	if !canonicalFriendID(id) {
		return FriendshipState{}, ErrFriendRequestNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FriendshipState{}, err
	}
	defer tx.Rollback(ctx)
	lookup := `SELECT ` + friendshipColumns + ` FROM account_friendships WHERE id=$1::uuid AND (account_low_id=$2::uuid OR account_high_id=$2::uuid)`
	f, err := scanFriendship(tx.QueryRow(ctx, lookup, id, viewer))
	if errors.Is(err, pgx.ErrNoRows) {
		return FriendshipState{}, ErrFriendRequestNotFound
	}
	if err != nil {
		return FriendshipState{}, err
	}
	states, err := lockFriendAccounts(ctx, tx, f.low, f.high)
	if err != nil {
		return FriendshipState{}, err
	}
	if !states[viewer].active {
		return FriendshipState{}, ErrSessionRevoked
	}
	f, err = scanFriendship(tx.QueryRow(ctx, lookup+` FOR UPDATE`, id, viewer))
	if errors.Is(err, pgx.ErrNoRows) {
		return FriendshipState{}, ErrFriendRequestNotFound
	}
	if err != nil {
		return FriendshipState{}, err
	}
	status := ""
	switch action {
	case "accept":
		if !states[f.low].active || !states[f.high].active {
			return FriendshipState{}, ErrFriendRequestNotFound
		}
		if f.status == "accepted" {
			return f.state(viewer), nil
		}
		if f.status != "pending" || f.requestedBy == viewer || !f.expires.After(time.Now()) {
			return FriendshipState{}, ErrFriendRequestNotFound
		}
		status = "accepted"
	case "request_delete":
		if f.status == "declined" || f.status == "cancelled" {
			return FriendshipState{State: "none"}, nil
		}
		if f.status != "pending" {
			return FriendshipState{}, ErrFriendRequestNotFound
		}
		status = "declined"
		if f.requestedBy == viewer {
			status = "cancelled"
		}
	case "remove":
		if f.status == "removed" {
			return FriendshipState{State: "none"}, nil
		}
		if f.status != "accepted" {
			return FriendshipState{}, ErrFriendRequestNotFound
		}
		status = "removed"
	default:
		return FriendshipState{}, ErrFriendRequestNotFound
	}
	_, err = tx.Exec(ctx, `UPDATE account_friendships SET status=$2,updated_at=NOW(),accepted_at=CASE WHEN $2='accepted' THEN NOW() ELSE accepted_at END WHERE id=$1::uuid`, id, status)
	if err != nil {
		return FriendshipState{}, err
	}
	if status == "accepted" {
		_, err = tx.Exec(ctx, `INSERT INTO account_friend_notifications(friend_request_id,recipient_account_id,actor_account_id,actor_label)
 SELECT $1::uuid,$2::uuid,a.id,COALESCE(NULLIF(a.display_name,''),a.name,'') FROM accounts a WHERE a.id=$3::uuid`, id, f.requestedBy, viewer)
		if err != nil {
			return FriendshipState{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return FriendshipState{}, err
	}
	if status == "accepted" {
		return FriendshipState{State: "friends", ID: id}, nil
	}
	return FriendshipState{State: "none"}, nil
}
