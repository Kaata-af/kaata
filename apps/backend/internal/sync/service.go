package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	gosync "sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	lru "github.com/hashicorp/golang-lru/v2"
)

// ErrNotMember is returned when the caller is not an accepted, non-revoked
// member of the target vault. The handler maps this to HTTP 403.
var ErrNotMember = errors.New("not a member of this vault")

// ErrVaultNotFound is returned by membership lookup when the vault row
// itself is missing. The handler folds this into ErrNotMember externally;
// keeping them distinct internally helps logging tell the two apart.
var ErrVaultNotFound = errors.New("vault not found")

// snapshotEventThreshold is how many newly-accepted events triggers a
// snapshot regeneration goroutine. The cron job runs as a backstop;
// this counter-based trigger keeps snapshots fresh during burst writes.
const snapshotEventThreshold = 1000

// membershipCacheTTL mirrors the auth middleware's revocation cache TTL.
const membershipCacheTTL = 60 * time.Second

// pullCacheTTL is how long a (vault, after, limit) page lives in memory.
// Events are append-only so the cache key naturally avoids stale data.
const pullCacheTTL = 60 * time.Second

// pullCacheSize is the LRU capacity. Generous; tune down if RSS grows.
const pullCacheSize = 1024

type membershipEntry struct {
	checkedAt time.Time
	role      string // "" → not a member
}

type pullCacheEntry struct {
	storedAt time.Time
	result   *PullResult
}

// SnapshotTrigger is invoked (non-blocking) when a vault's accepted event
// count crosses snapshotEventThreshold since its last snapshot.
type SnapshotTrigger func(vaultID string)

type Service struct {
	pool       *pgxpool.Pool
	membership *lru.Cache[string, membershipEntry]
	// snapshotPending tracks per-vault event counts since last snapshot.
	snapshotPending *lru.Cache[string, int]
	onSnapshot      SnapshotTrigger

	pullCache *lru.Cache[string, pullCacheEntry]
	pullMu    gosync.Mutex // serializes cache misses

	// Phase 4.1: retroactive account_bound resolver. Used by
	// CheckEventPermission to attribute pre-sign-in events (stored
	// account_id IS NULL) and by PullEvents to re-stamp account_id on
	// the response wire shape.
	binding *BindingResolver
}

func NewService(pool *pgxpool.Pool) *Service {
	memCache, _ := lru.New[string, membershipEntry](4096)
	snapCache, _ := lru.New[string, int](1024)
	pullCache, _ := lru.New[string, pullCacheEntry](pullCacheSize)
	return &Service{
		pool:            pool,
		membership:      memCache,
		snapshotPending: snapCache,
		onSnapshot:      func(string) {},
		pullCache:       pullCache,
		binding:         NewBindingResolver(pool),
	}
}

// SetSnapshotTrigger wires the snapshot generator. Called at startup from
// main.go.
func (s *Service) SetSnapshotTrigger(t SnapshotTrigger) {
	if t != nil {
		s.onSnapshot = t
	}
}

// InvalidateMembership purges any cached membership state for (vaultID,
// accountID). Called by Phase 4 invite/revoke flows.
func (s *Service) InvalidateMembership(vaultID, accountID string) {
	s.membership.Remove(vaultID + "|" + accountID)
}

// ResetSnapshotPending is called by the snapshot worker after generation.
func (s *Service) ResetSnapshotPending(vaultID string) {
	s.snapshotPending.Remove(vaultID)
}

// BumpSnapshotPending records +1 pending event for snapshot threshold
// accounting. Used by server-side emitters (vaults/event_emit.go) that
// don't go through PushEvents — keeps the counter consistent so the
// snapshot trigger fires at the right time regardless of how the events
// were produced.
func (s *Service) BumpSnapshotPending(vaultID string) {
	prev, _ := s.snapshotPending.Get(vaultID)
	next := prev + 1
	s.snapshotPending.Add(vaultID, next)
	if next >= snapshotEventThreshold {
		go s.onSnapshot(vaultID)
	}
}

// IsMember implements MembershipChecker for the snapshot handler.
func (s *Service) IsMember(ctx context.Context, accountID, vaultID string) (bool, error) {
	err := s.checkMembershipFresh(ctx, accountID, vaultID)
	if errors.Is(err, ErrNotMember) || errors.Is(err, ErrVaultNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ==========================================================================
// PUSH
// ==========================================================================

// PushInput is what the handler hands to PushEvents after JSON decode.
type PushInput struct {
	AccountID string
	VaultID   string
	DeviceID  string
	Events    []PushEvent
}

// PushEvents validates membership, then inserts events one-by-one inside a
// single transaction. Per-vault server_seq assigned via SELECT FOR UPDATE
// on the vaults row.
//
// Idempotency: event_id is the primary key on the events table.
//
// Failure semantics: any per-event error rolls back the entire batch.
func (s *Service) PushEvents(ctx context.Context, in PushInput) (*PushResponse, error) {
	role, err := s.checkMembership(ctx, in.VaultID, in.AccountID)
	if err != nil {
		return nil, fmt.Errorf("membership check: %w", err)
	}
	if role == "" {
		return nil, ErrNotMember
	}

	accepted := make([]AcceptedEvent, 0, len(in.Events))
	duplicates := make([]string, 0)
	rejected := make([]RejectedEvent, 0)

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Lock the vault row for the duration of the tx.
	if _, err := tx.Exec(ctx, `
		SELECT 1 FROM vaults WHERE vault_id = $1::uuid FOR UPDATE
	`, in.VaultID); err != nil {
		return nil, fmt.Errorf("lock vault row: %w", err)
	}

	var curSeq int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) FROM events WHERE vault_id = $1::uuid
	`, in.VaultID).Scan(&curSeq); err != nil {
		return nil, fmt.Errorf("read current server_seq: %w", err)
	}

	// Pre-parse account/vault uuids once; reused per-event for the
	// lawful-at-HLC role lookup. Either failure causes a wholesale push
	// failure; that's fine because the same uuids drove membership lookup
	// above and would have already rejected at that gate.
	accountUUID, _ := uuid.Parse(in.AccountID)
	vaultUUID, _ := uuid.Parse(in.VaultID)

	for _, ev := range in.Events {
		// Phase 4 lawful-at-HLC ACL + Phase 4.1 retroactive binding.
		// We evaluate the author's role AT THE EVENT'S HLC time per
		// vault_audit_log — so a recently-demoted editor's offline
		// batch still lands at the prior role. When the event was
		// authored before sign-in (stored actor_account_id is NULL),
		// we resolve the effective author via the account_bound chain.
		// account_bound itself is special-cased inside
		// CheckEventPermission.
		evIDUUID, evErr := uuid.Parse(ev.EventID)
		if evErr != nil {
			return nil, fmt.Errorf("bad event_id %q: %w", ev.EventID, evErr)
		}
		hlcDevUUID, hlcErr := uuid.Parse(ev.HLC.DeviceID)
		if hlcErr != nil {
			return nil, fmt.Errorf("bad hlc.device_id on %s: %w", ev.EventID, hlcErr)
		}

		var storedActor *uuid.UUID
		if ev.ActorAccountID != nil && *ev.ActorAccountID != "" {
			parsed, parseErr := uuid.Parse(*ev.ActorAccountID)
			if parseErr != nil {
				return nil, fmt.Errorf("bad actor_account_id on %s: %w", ev.EventID, parseErr)
			}
			storedActor = &parsed
		}

		allowed, atRole, requiredRole, err := CheckEventPermission(
			ctx, tx, s.binding,
			accountUUID, vaultUUID,
			evIDUUID, ev.EventType, storedActor,
			ev.HLC.PhysicalMS, ev.HLC.Logical, hlcDevUUID,
		)
		if err != nil {
			return nil, fmt.Errorf("permission check for %s: %w", ev.EventID, err)
		}
		if !allowed {
			reason := "insufficient_role"
			// Phase 4.1 signal: an empty currentRole on a NULL-actor
			// event means no binding covered it.
			if atRole == "" && storedActor == nil {
				reason = "unauthored_pre_binding"
			}
			if atRole == "" {
				atRole = role
			}
			if requiredRole == "" {
				requiredRole = RequiredRoleFor(ev.EventType)
			}
			rejected = append(rejected, RejectedEvent{
				EventID:      ev.EventID,
				Reason:       reason,
				CurrentRole:  atRole,
				RequiredRole: requiredRole,
			})
			continue
		}

		nextSeq := curSeq + 1
		// Allow nullable target_id / relationship_id / account_id.
		var targetID interface{}
		if ev.TargetID != nil && *ev.TargetID != "" {
			targetID = *ev.TargetID
		}
		var relID interface{}
		if ev.RelationshipID != nil && *ev.RelationshipID != "" {
			relID = *ev.RelationshipID
		}
		var actorID interface{}
		if storedActor != nil {
			actorID = storedActor.String()
		}

		tag, err := tx.Exec(ctx, `
			INSERT INTO events (
				event_id, vault_id, server_seq,
				event_type, schema_version,
				hlc_physical_ms, hlc_logical, hlc_device_id,
				device_id, account_id,
				target_id, relationship_id,
				payload, server_received_at
			) VALUES (
				$1::uuid, $2::uuid, $3,
				$4, $5,
				$6, $7, $8::uuid,
				$9::uuid, $10,
				$11, $12,
				$13::jsonb, NOW()
			)
			ON CONFLICT (event_id) DO NOTHING
		`,
			ev.EventID, in.VaultID, nextSeq,
			ev.EventType, ev.SchemaVersion,
			ev.HLC.PhysicalMS, ev.HLC.Logical, ev.HLC.DeviceID,
			in.DeviceID, actorID,
			targetID, relID,
			string(ev.Payload),
		)
		if err != nil {
			return nil, fmt.Errorf("insert event %s: %w", ev.EventID, err)
		}

		if tag.RowsAffected() == 0 {
			duplicates = append(duplicates, ev.EventID)
			continue
		}

		// Phase 4.1: invalidate the binding cache so subsequent
		// permission checks within the same batch (and pulls within
		// the cache TTL) re-scan account_bound events.
		if ev.EventType == "account_bound" {
			s.binding.InvalidateVault(in.VaultID)
			// SEC H2: pullCache holds fully-materialized response
			// pages whose AccountID fields were stamped via the
			// binding resolver at write time. A new account_bound
			// changes future binding answers — pages cached under
			// the old binding would surface NULL account_ids that
			// should now resolve. Purge the vault's pull pages so
			// the next pull re-runs the post-process. The cache
			// itself sees a brief miss-storm; acceptable for the
			// freshness invariant.
			s.invalidatePullCacheForVault(in.VaultID)
		}

		accepted = append(accepted, AcceptedEvent{
			EventID:   ev.EventID,
			ServerSeq: nextSeq,
		})
		curSeq = nextSeq
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit push tx: %w", err)
	}

	if n := len(accepted); n > 0 {
		prev, _ := s.snapshotPending.Get(in.VaultID)
		next := prev + n
		s.snapshotPending.Add(in.VaultID, next)
		if next >= snapshotEventThreshold {
			go s.onSnapshot(in.VaultID)
		}
	}

	return &PushResponse{
		Accepted:           accepted,
		Duplicates:         duplicates,
		Rejected:           rejected,
		VaultServerSeqHigh: curSeq,
	}, nil
}

func (s *Service) checkMembership(ctx context.Context, vaultID, accountID string) (string, error) {
	key := vaultID + "|" + accountID
	now := time.Now()
	if entry, ok := s.membership.Get(key); ok {
		if now.Sub(entry.checkedAt) < membershipCacheTTL {
			return entry.role, nil
		}
	}
	var role string
	err := s.pool.QueryRow(ctx, `
		SELECT role
		FROM vault_members
		WHERE vault_id = $1::uuid
		  AND account_id = $2::uuid
		  AND accepted_at IS NOT NULL
		  AND revoked_at IS NULL
		LIMIT 1
	`, vaultID, accountID).Scan(&role)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		role = ""
	case err != nil:
		return "", err
	}
	s.membership.Add(key, membershipEntry{checkedAt: now, role: role})
	return role, nil
}

// checkMembershipFresh never caches — used by pull and snapshot read paths
// where revocation needs to land within a single request.
func (s *Service) checkMembershipFresh(ctx context.Context, accountID, vaultID string) error {
	var exists bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM vaults WHERE vault_id = $1::uuid)
	`, vaultID).Scan(&exists); err != nil {
		return fmt.Errorf("membership: vault lookup: %w", err)
	}
	if !exists {
		return ErrVaultNotFound
	}

	var isMember bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid
			   AND account_id = $2::uuid
			   AND accepted_at IS NOT NULL
			   AND revoked_at IS NULL
		)
	`, vaultID, accountID).Scan(&isMember); err != nil {
		return fmt.Errorf("membership: member lookup: %w", err)
	}
	if !isMember {
		return ErrNotMember
	}
	return nil
}

// ==========================================================================
// PULL
// ==========================================================================

type PullInput struct {
	AccountID      string
	VaultID        string
	AfterServerSeq int64
	Limit          int
}

type PullResult struct {
	VaultID            string        `json:"vault_id"`
	Events             []PulledEvent `json:"events"`
	NextAfterServerSeq int64         `json:"next_after_server_seq"`
	HasMore            bool          `json:"has_more"`
	ServerTime         string        `json:"server_time"`
}

type PulledEvent struct {
	EventID   string  `json:"event_id"`
	HLC       HLC     `json:"hlc"`
	DeviceID  string  `json:"device_id"`
	AccountID *string `json:"account_id"`
	// Envelope columns. Required for projection appliers on the receiving
	// device (entry_amended / entry_deleted / person_renamed /
	// person_archived / person_phone_changed / shop_profile_updated all
	// key off target_id; person_added / person_archived key off
	// relationship_id). Without these the remote projection silently
	// no-ops and diverges from the server's view.
	TargetID         *string         `json:"target_id"`
	RelationshipID   *string         `json:"relationship_id"`
	EventType        string          `json:"event_type"`
	SchemaVersion    int             `json:"schema_version"`
	Payload          json.RawMessage `json:"payload"`
	ServerSeq        int64           `json:"server_seq"`
	ServerReceivedAt string          `json:"server_received_at"`
}

// PullEvents serves GET /v1/sync/pull.
func (s *Service) PullEvents(ctx context.Context, in PullInput) (*PullResult, error) {
	if in.AccountID == "" {
		return nil, errors.New("account_id is required")
	}
	if in.VaultID == "" {
		return nil, errors.New("vault_id is required")
	}
	if in.Limit <= 0 {
		in.Limit = 200
	}
	if in.Limit > 1000 {
		in.Limit = 1000
	}
	if in.AfterServerSeq < 0 {
		in.AfterServerSeq = 0
	}

	if err := s.checkMembershipFresh(ctx, in.AccountID, in.VaultID); err != nil {
		return nil, err
	}

	cacheKey := pullCacheKey(in.VaultID, in.AfterServerSeq, in.Limit)
	if entry, ok := s.pullCache.Get(cacheKey); ok {
		if time.Since(entry.storedAt) < pullCacheTTL {
			out := *entry.result
			out.ServerTime = nowRFC3339()
			return &out, nil
		}
	}

	s.pullMu.Lock()
	defer s.pullMu.Unlock()
	if entry, ok := s.pullCache.Get(cacheKey); ok {
		if time.Since(entry.storedAt) < pullCacheTTL {
			out := *entry.result
			out.ServerTime = nowRFC3339()
			return &out, nil
		}
	}

	// ENG #8: Compute the window's true high-water mark BEFORE filtering
	// redacted rows. Without this, a page whose Limit window is fully
	// composed of redacted events would return zero rows AND leave
	// next_after_server_seq at the caller's input, stalling pull forever.
	// windowHigh is the MAX(server_seq) of the first <Limit> qualifying
	// rows ignoring redaction. We advance the cursor to windowHigh on an
	// empty page so the client can step over the redacted hole.
	// Subquery alias is "page_hwm" — NOT "window_hwm". Postgres's WINDOW is a
	// reserved keyword (introduces a window-function definition between HAVING
	// and ORDER BY). At least in some Postgres versions, an alias that starts
	// with "window" triggers `syntax error at or near "window"` (SQLSTATE 42601)
	// because the parser tries to enter window-clause mode. Rename = safest fix.
	var windowHigh int64
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) FROM (
			SELECT server_seq
			  FROM events
			 WHERE vault_id = $1::uuid
			   AND server_seq > $2
			 ORDER BY server_seq ASC
			 LIMIT $3
		) AS page_hwm
	`, in.VaultID, in.AfterServerSeq, in.Limit).Scan(&windowHigh); err != nil {
		return nil, fmt.Errorf("pull events: page high-water: %w", err)
	}

	const pageSQL = `
		SELECT
			event_id::text,
			hlc_physical_ms,
			hlc_logical,
			hlc_device_id::text,
			device_id::text,
			account_id::text,
			target_id::text,
			relationship_id::text,
			event_type,
			schema_version,
			payload,
			server_seq,
			server_received_at
		FROM events
		WHERE vault_id = $1::uuid
		  AND server_seq > $2
		  AND redacted_at IS NULL
		ORDER BY server_seq ASC
		LIMIT $3
	`

	rows, err := s.pool.Query(ctx, pageSQL, in.VaultID, in.AfterServerSeq, in.Limit)
	if err != nil {
		return nil, fmt.Errorf("pull events: query: %w", err)
	}
	defer rows.Close()

	events := make([]PulledEvent, 0, in.Limit)
	for rows.Next() {
		var (
			ev               PulledEvent
			accountID        *string
			targetID         *string
			relID            *string
			payload          []byte
			serverReceivedAt time.Time
		)
		if err := rows.Scan(
			&ev.EventID,
			&ev.HLC.PMS,
			&ev.HLC.L,
			&ev.HLC.DID,
			&ev.DeviceID,
			&accountID,
			&targetID,
			&relID,
			&ev.EventType,
			&ev.SchemaVersion,
			&payload,
			&ev.ServerSeq,
			&serverReceivedAt,
		); err != nil {
			return nil, fmt.Errorf("pull events: scan: %w", err)
		}
		ev.AccountID = accountID
		ev.TargetID = targetID
		ev.RelationshipID = relID
		if len(payload) == 0 {
			ev.Payload = json.RawMessage("null")
		} else {
			ev.Payload = json.RawMessage(payload)
		}
		ev.ServerReceivedAt = serverReceivedAt.UTC().Format(time.RFC3339Nano)
		events = append(events, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("pull events: rows: %w", err)
	}

	// Phase 4.1: re-stamp account_id on events that had NULL stored
	// account_id but are covered by a subsequent account_bound binding.
	// Shared with the snapshot tail (ENG #7) so the snapshot bootstrap
	// path receives the same attribution the steady-state pull would.
	s.resolveBindingsOnPulled(ctx, in.VaultID, events)

	// ENG #8: Cursor advance even on a page emptied by redaction.
	//   - If we got rows, the cursor advances to the last row's seq
	//     (standard).
	//   - If the page is empty but windowHigh > in.AfterServerSeq, then
	//     the Limit window scanned some rows that were ALL redacted —
	//     advance to windowHigh so the client steps past the hole.
	//   - Otherwise (nothing scanned at all), leave the cursor as-is.
	nextAfter := in.AfterServerSeq
	if n := len(events); n > 0 {
		nextAfter = events[n-1].ServerSeq
	} else if windowHigh > in.AfterServerSeq {
		nextAfter = windowHigh
	}
	// has_more MUST be false on an empty page even if the client's cursor
	// trails the high-water mark: otherwise a client whose page filled
	// entirely with redacted events (server-side filter) would loop with
	// no cursor progress. The redaction-window cursor advance above is the
	// signal to the client that they SHOULD retry — they should observe
	// next_after_server_seq > their input even though events is empty,
	// and step forward. Returning has_more=true on an empty page is still
	// a contract violation per pull.ts's loop invariant.
	hasMore := len(events) == in.Limit && len(events) > 0

	result := &PullResult{
		VaultID:            in.VaultID,
		Events:             events,
		NextAfterServerSeq: nextAfter,
		HasMore:            hasMore,
		ServerTime:         nowRFC3339(),
	}

	cached := *result
	cached.ServerTime = ""
	s.pullCache.Add(cacheKey, pullCacheEntry{
		storedAt: time.Now(),
		result:   &cached,
	})

	return result, nil
}

// resolveBindingsOnPulled re-stamps account_id on PulledEvent rows whose
// stored account_id is NULL but are covered by a subsequent
// account_bound binding. Mutates the slice in place. Soft-fails per
// event: a lookup error leaves account_id nil rather than aborting the
// page. The events table itself is NEVER mutated — only the wire
// response shape.
//
// Shared between PullEvents and pullTail (ENG #7 — snapshot tail
// previously skipped post-process and surfaced stale NULLs to bootstrap
// clients).
func (s *Service) resolveBindingsOnPulled(ctx context.Context, vaultID string, events []PulledEvent) {
	if s.binding == nil || len(events) == 0 {
		return
	}
	vaultUUID, perr := uuid.Parse(vaultID)
	if perr != nil {
		return
	}
	for i := range events {
		if events[i].AccountID != nil && *events[i].AccountID != "" {
			continue
		}
		evIDUUID, perr := uuid.Parse(events[i].EventID)
		if perr != nil {
			continue
		}
		hlcDevUUID, perr := uuid.Parse(events[i].HLC.DID)
		if perr != nil {
			continue
		}
		bound, found, berr := s.binding.ResolvePool(
			ctx, vaultUUID, evIDUUID,
			events[i].HLC.PMS, events[i].HLC.L, hlcDevUUID,
		)
		if berr != nil || !found {
			continue
		}
		boundStr := bound.String()
		events[i].AccountID = &boundStr
	}
}

// invalidatePullCacheForVault removes every cached pull page whose key
// begins with "<vaultID>|". Called when an event whose presence changes
// the post-process attribution (account_bound) lands. The LRU has no
// prefix-scan, so we walk Keys() and Remove() in place.
func (s *Service) invalidatePullCacheForVault(vaultID string) {
	if vaultID == "" {
		s.pullCache.Purge()
		return
	}
	prefix := vaultID + "|"
	for _, k := range s.pullCache.Keys() {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			s.pullCache.Remove(k)
		}
	}
}

// pullCacheKey builds the LRU cache key.
func pullCacheKey(vaultID string, after int64, limit int) string {
	var b strings.Builder
	b.Grow(len(vaultID) + 32)
	b.WriteString(vaultID)
	b.WriteByte('|')
	b.WriteString(strconv.FormatInt(after, 10))
	b.WriteByte('|')
	b.WriteString(strconv.Itoa(limit))
	return b.String()
}

// nowRFC3339 returns the server's current wall-clock as UTC RFC3339.
func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// ResolveBoundActor exposes the binding resolver for use by the snapshot
// worker. Returns the bound account_id for an event whose stored
// account_id is NULL, or (uuid.Nil, false) if no binding covers it.
//
// Pool-backed: callers must NOT hold an in-flight pgx.Tx; use the
// transactional CheckEventPermission path when inside push.
func (s *Service) ResolveBoundActor(
	ctx context.Context,
	vaultID uuid.UUID,
	eventID uuid.UUID,
	hlcPMS int64,
	hlcLogical int64,
	hlcDeviceID uuid.UUID,
) (uuid.UUID, bool, error) {
	if s.binding == nil {
		return uuid.Nil, false, nil
	}
	return s.binding.ResolvePool(ctx, vaultID, eventID, hlcPMS, hlcLogical, hlcDeviceID)
}
