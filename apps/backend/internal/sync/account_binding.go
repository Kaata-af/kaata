package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	gosync "sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	lru "github.com/hashicorp/golang-lru/v2"
)

// ============================================================================
// Phase 4.1: retroactive account_bound ACL attribution.
//
// Pre-sign-in events have account_id = NULL on the events row. Per design,
// account_bound events emitted *after* sign-in carry a
// retroactive_through_event_id, asserting "every event in this vault up to
// and including event X was authored by me (account_id Y)". The lawful-at-HLC
// ACL must re-attribute such events to the binding account when judging the
// author's role.
//
// Rules:
//
//   1. An account_bound binding covers an event E iff:
//        - the account_bound event lives in the same vault as E, AND
//        - the HLC of the event identified by retroactive_through_event_id
//          is >= E's HLC (event E is at or before the cut-off).
//
//   2. We scan the earliest 10 account_bound events in the vault by HLC
//      and pick the FIRST (earliest by HLC) whose cut-off covers E. Reason:
//      a later account_bound (different google_sub) MAY have re-bound on
//      this device; that later binding cannot retroactively claim events
//      already claimed by the earlier one.
//
//   3. If no binding covers E, the event remains unattributed → permission
//      check fails (reason: unauthored_pre_binding).
//
// HLC ordering is (physical_ms, logical, device_id) lexicographic.
// ============================================================================

// boundingCacheTTL is how long a (vault_id, event_id) → bound_account_id
// resolution is cached. 60s matches the rest of the sync package's cache
// freshness contract.
const boundingCacheTTL = 60 * time.Second

// boundingCacheSize is the LRU capacity. Each entry is ~40 bytes; 4096
// entries is ~160 KiB.
const boundingCacheSize = 4096

// boundingCacheEntry holds a memoized binding lookup. resolved == nil means
// "no binding covers this event" (negative result — also cached so we don't
// re-scan account_bound rows on every push).
type boundingCacheEntry struct {
	storedAt time.Time
	resolved *uuid.UUID
}

// account_bound payload shape on the wire & in DB.
type accountBoundPayload struct {
	AccountID                 string `json:"account_id"`
	RetroactiveThroughEventID string `json:"retroactive_through_event_id"`
	FromUserID                string `json:"from_user_id"`
}

// scannedBinding is one row of the bounded scan in scanBindings / pool.
type scannedBinding struct {
	accountID                 uuid.UUID
	retroactiveThroughEventID uuid.UUID
	hlcPMS                    int64
	hlcLogical                int64
	hlcDeviceID               uuid.UUID
}

// BindingResolver looks up the bound account_id for an event whose stored
// account_id is NULL. Safe for concurrent use.
type BindingResolver struct {
	pool  *pgxpool.Pool
	cache *lru.Cache[string, boundingCacheEntry]
	mu    gosync.Mutex // serializes cache misses per process
}

// NewBindingResolver constructs a resolver.
func NewBindingResolver(pool *pgxpool.Pool) *BindingResolver {
	c, _ := lru.New[string, boundingCacheEntry](boundingCacheSize)
	return &BindingResolver{pool: pool, cache: c}
}

// ResolveTx is the transaction-aware variant. Used inside PushEvents where a
// pgx.Tx is already in flight (so the binding lookup sees the same snapshot
// as the insert).
//
// Returns (boundAccountID, true, nil) when a binding covers the event,
// (uuid.Nil, false, nil) when no binding covers it, or an error on hard
// failure.
func (br *BindingResolver) ResolveTx(
	ctx context.Context,
	tx pgx.Tx,
	vaultID uuid.UUID,
	eventID uuid.UUID,
	hlcPMS int64,
	hlcLogical int64,
	hlcDeviceID uuid.UUID,
) (uuid.UUID, bool, error) {
	key := vaultID.String() + "|" + eventID.String()
	if entry, ok := br.cache.Get(key); ok && time.Since(entry.storedAt) < boundingCacheTTL {
		if entry.resolved == nil {
			return uuid.Nil, false, nil
		}
		return *entry.resolved, true, nil
	}

	br.mu.Lock()
	defer br.mu.Unlock()
	if entry, ok := br.cache.Get(key); ok && time.Since(entry.storedAt) < boundingCacheTTL {
		if entry.resolved == nil {
			return uuid.Nil, false, nil
		}
		return *entry.resolved, true, nil
	}

	resolved, found, err := scanBindings(ctx, tx, vaultID, hlcPMS, hlcLogical, hlcDeviceID)
	if err != nil {
		return uuid.Nil, false, err
	}

	cached := boundingCacheEntry{storedAt: time.Now()}
	if found {
		v := resolved
		cached.resolved = &v
	}
	br.cache.Add(key, cached)

	if !found {
		return uuid.Nil, false, nil
	}
	return resolved, true, nil
}

// ResolvePool is the pool-backed variant used by PullEvents post-processing
// where there is no in-flight transaction.
func (br *BindingResolver) ResolvePool(
	ctx context.Context,
	vaultID uuid.UUID,
	eventID uuid.UUID,
	hlcPMS int64,
	hlcLogical int64,
	hlcDeviceID uuid.UUID,
) (uuid.UUID, bool, error) {
	key := vaultID.String() + "|" + eventID.String()
	if entry, ok := br.cache.Get(key); ok && time.Since(entry.storedAt) < boundingCacheTTL {
		if entry.resolved == nil {
			return uuid.Nil, false, nil
		}
		return *entry.resolved, true, nil
	}

	br.mu.Lock()
	defer br.mu.Unlock()
	if entry, ok := br.cache.Get(key); ok && time.Since(entry.storedAt) < boundingCacheTTL {
		if entry.resolved == nil {
			return uuid.Nil, false, nil
		}
		return *entry.resolved, true, nil
	}

	resolved, found, err := scanBindingsPool(ctx, br.pool, vaultID, hlcPMS, hlcLogical, hlcDeviceID)
	if err != nil {
		return uuid.Nil, false, err
	}

	cached := boundingCacheEntry{storedAt: time.Now()}
	if found {
		v := resolved
		cached.resolved = &v
	}
	br.cache.Add(key, cached)

	if !found {
		return uuid.Nil, false, nil
	}
	return resolved, true, nil
}

// InvalidateVault drops cached bindings for vaultID. Called from
// PushEvents after a batch lands so any newly-inserted account_bound
// events are reflected in subsequent lookups.
//
// SEC H1: only entries with the matching vault prefix are removed.
// Previously this purged the entire LRU, which let any adversary that
// pushed a single account_bound event evict cached bindings across every
// other vault on the deployment — a throughput-DoS surface. The cache key
// shape is "<vault_id>|<event_id>" so a prefix scan is correct.
func (br *BindingResolver) InvalidateVault(vaultID string) {
	if vaultID == "" {
		br.cache.Purge()
		return
	}
	prefix := vaultID + "|"
	for _, k := range br.cache.Keys() {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			br.cache.Remove(k)
		}
	}
}

func scanBindings(
	ctx context.Context,
	tx pgx.Tx,
	vaultID uuid.UUID,
	evtPMS int64,
	evtLogical int64,
	evtDeviceID uuid.UUID,
) (uuid.UUID, bool, error) {
	const q = `
		SELECT account_id::text, payload,
		       hlc_physical_ms, hlc_logical, hlc_device_id::text
		  FROM events
		 WHERE vault_id   = $1::uuid
		   AND event_type = 'account_bound'
		 ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC
		 LIMIT 10
	`
	rows, err := tx.Query(ctx, q, vaultID)
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("scan account_bound events: %w", err)
	}
	defer rows.Close()
	bindings, err := scanBindingRows(rows)
	if err != nil {
		return uuid.Nil, false, err
	}
	if len(bindings) == 0 {
		return uuid.Nil, false, nil
	}
	for _, b := range bindings {
		cutoffPMS, cutoffLogical, cutoffDevice, err := eventHLCTx(ctx, tx, vaultID, b.retroactiveThroughEventID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// retroactive_through_event_id points to an event we haven't
				// seen yet (out-of-order arrival). Skip; a subsequent retry
				// will resolve it.
				continue
			}
			return uuid.Nil, false, err
		}
		if hlcLEQ(evtPMS, evtLogical, evtDeviceID, cutoffPMS, cutoffLogical, cutoffDevice) {
			return b.accountID, true, nil
		}
	}
	return uuid.Nil, false, nil
}

func scanBindingsPool(
	ctx context.Context,
	pool *pgxpool.Pool,
	vaultID uuid.UUID,
	evtPMS int64,
	evtLogical int64,
	evtDeviceID uuid.UUID,
) (uuid.UUID, bool, error) {
	const q = `
		SELECT account_id::text, payload,
		       hlc_physical_ms, hlc_logical, hlc_device_id::text
		  FROM events
		 WHERE vault_id   = $1::uuid
		   AND event_type = 'account_bound'
		 ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC
		 LIMIT 10
	`
	rows, err := pool.Query(ctx, q, vaultID)
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("scan account_bound events: %w", err)
	}
	defer rows.Close()
	bindings, err := scanBindingRows(rows)
	if err != nil {
		return uuid.Nil, false, err
	}
	if len(bindings) == 0 {
		return uuid.Nil, false, nil
	}
	for _, b := range bindings {
		cutoffPMS, cutoffLogical, cutoffDevice, err := eventHLCPool(ctx, pool, vaultID, b.retroactiveThroughEventID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			return uuid.Nil, false, err
		}
		if hlcLEQ(evtPMS, evtLogical, evtDeviceID, cutoffPMS, cutoffLogical, cutoffDevice) {
			return b.accountID, true, nil
		}
	}
	return uuid.Nil, false, nil
}

// scanBindingRows parses raw scan rows. Defensively skips rows whose
// payload doesn't decode or whose account_id / retroactive_through_event_id
// is missing/malformed.
func scanBindingRows(rows pgx.Rows) ([]scannedBinding, error) {
	bindings := make([]scannedBinding, 0, 4)
	for rows.Next() {
		var (
			accountIDStr *string
			payloadRaw   []byte
			pms          int64
			logical      int64
			deviceStr    string
		)
		if err := rows.Scan(&accountIDStr, &payloadRaw, &pms, &logical, &deviceStr); err != nil {
			return nil, fmt.Errorf("scan account_bound row: %w", err)
		}
		if accountIDStr == nil || *accountIDStr == "" {
			continue
		}
		acctUUID, err := uuid.Parse(*accountIDStr)
		if err != nil {
			continue
		}
		var p accountBoundPayload
		if err := json.Unmarshal(payloadRaw, &p); err != nil {
			continue
		}
		if p.RetroactiveThroughEventID == "" {
			continue
		}
		retroUUID, err := uuid.Parse(p.RetroactiveThroughEventID)
		if err != nil {
			continue
		}
		devUUID, err := uuid.Parse(deviceStr)
		if err != nil {
			continue
		}
		bindings = append(bindings, scannedBinding{
			accountID:                 acctUUID,
			retroactiveThroughEventID: retroUUID,
			hlcPMS:                    pms,
			hlcLogical:                logical,
			hlcDeviceID:               devUUID,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("account_bound rows: %w", err)
	}
	return bindings, nil
}

func eventHLCTx(
	ctx context.Context,
	tx pgx.Tx,
	vaultID uuid.UUID,
	eventID uuid.UUID,
) (int64, int64, uuid.UUID, error) {
	const q = `
		SELECT hlc_physical_ms, hlc_logical, hlc_device_id
		  FROM events
		 WHERE vault_id = $1::uuid
		   AND event_id = $2::uuid
	`
	var pms, logical int64
	var dev uuid.UUID
	err := tx.QueryRow(ctx, q, vaultID, eventID).Scan(&pms, &logical, &dev)
	return pms, logical, dev, err
}

func eventHLCPool(
	ctx context.Context,
	pool *pgxpool.Pool,
	vaultID uuid.UUID,
	eventID uuid.UUID,
) (int64, int64, uuid.UUID, error) {
	const q = `
		SELECT hlc_physical_ms, hlc_logical, hlc_device_id
		  FROM events
		 WHERE vault_id = $1::uuid
		   AND event_id = $2::uuid
	`
	var pms, logical int64
	var dev uuid.UUID
	err := pool.QueryRow(ctx, q, vaultID, eventID).Scan(&pms, &logical, &dev)
	return pms, logical, dev, err
}

// hlcLEQ returns true iff (aPMS, aLog, aDev) <= (bPMS, bLog, bDev) in HLC
// lexicographic order. device_id comparison is string-wise (matches
// Postgres uuid sort order: byte-wise comparison ≡ hex string order).
func hlcLEQ(
	aPMS int64, aLog int64, aDev uuid.UUID,
	bPMS int64, bLog int64, bDev uuid.UUID,
) bool {
	if aPMS != bPMS {
		return aPMS < bPMS
	}
	if aLog != bLog {
		return aLog < bLog
	}
	return aDev.String() <= bDev.String()
}
