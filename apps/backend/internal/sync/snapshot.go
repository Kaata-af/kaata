package sync

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	gosync "sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SnapshotSchemaVersion is the JSON shape version emitted by BuildSnapshot.
const SnapshotSchemaVersion = 1

// Tuning knobs for the snapshot cron.
const (
	// snapshotMinNewEvents — minimum events since prior snapshot before
	// we'll bother regenerating.
	snapshotMinNewEvents = 1000

	// snapshotMaxAge — even if the new-event threshold isn't met, refresh
	// any snapshot older than this.
	snapshotMaxAge = 24 * time.Hour

	// snapshotMinInterval — hard floor between consecutive snapshot
	// generations for the same vault.
	snapshotMinInterval = 1 * time.Hour
)

// SnapshotResponse is the GET /v1/sync/snapshot response body.
//
// The shape mirrors apps/mobile/lib/restore.ts Snapshot: the projection is
// expanded into per-table arrays (users, relationships, entries) plus
// shop_profile and vault rows, all in the SQLite-row shape the mobile
// restoreFromSnapshot writes via INSERT OR REPLACE. The `events` field is
// the tail of events appended AFTER the snapshot's up_to_server_seq, so
// the client lands on the live projection without a follow-up pull
// round-trip. hlc_last seeds the mobile HLC frontier.
//
// MembershipEvents (M5 recovery) is the vault's FULL membership chain in HLC
// order, INDEPENDENT of the snapshot cursor — a recovering device needs the
// whole chain (genesis + member/device adds) to build a proof bundle and
// fold its own membership, even though most of those events sit at or below
// the snapshot's up_to_server_seq and so never appear in the post-cursor
// tail. An event can legitimately be BOTH in MembershipEvents and in Events
// (Events is cursor-bound, MembershipEvents is not); mobile ingests by
// event_id idempotently, so the overlap is harmless.
type SnapshotResponse struct {
	VaultID           string                 `json:"vault_id"`
	SnapshotServerSeq int64                  `json:"snapshot_server_seq"`
	GeneratedAtMS     int64                  `json:"generated_at_ms"`
	SchemaVersion     int                    `json:"schema_version"`
	Vault             SnapshotVault          `json:"vault"`
	ShopProfile       *SnapshotShopProfile   `json:"shop_profile"`
	Users             []SnapshotUser         `json:"users"`
	Relationships     []SnapshotRelationship `json:"relationships"`
	Entries           []SnapshotEntry        `json:"entries"`
	HLCLast           HLC                    `json:"hlc_last"`
	Events            []PulledEvent          `json:"events"`
	MembershipEvents  []PulledEvent          `json:"membership_events"`
}

// SnapshotVault mirrors the SQLite vaults row shape on mobile.
type SnapshotVault struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Currency  string  `json:"currency"`
	CreatedAt int64   `json:"created_at"`
	UpdatedAt int64   `json:"updated_at"`
	IsDefault int     `json:"is_default"`
	AccountID *string `json:"account_id"`
	// VaultTrustAnchorPubkey (M5 recovery) — base64(std) of the vault's
	// Phase 7 local-CA Ed25519 trust anchor (32 raw bytes). nil for
	// server-anchored (Phase 5 back-compat) vaults. A recovering device
	// pins THIS verbatim instead of (incorrectly) adopting itself as the
	// anchor. Same std-base64 encoding GET /v1/vaults uses.
	VaultTrustAnchorPubkey *string `json:"vault_trust_anchor_pubkey"`
}

type SnapshotShopProfile struct {
	VaultID   string  `json:"vault_id"`
	OwnerName *string `json:"owner_name"`
	ShopName  string  `json:"shop_name"`
	CreatedAt int64   `json:"created_at"`
	UpdatedAt int64   `json:"updated_at"`
}

type SnapshotUser struct {
	ID          string  `json:"id"`
	PhoneE164   *string `json:"phone_e164"`
	DisplayName string  `json:"display_name"`
	IsLocalSelf int     `json:"is_local_self"`
	GoogleSub   *string `json:"google_sub"`
	AccountID   *string `json:"account_id"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
	ArchivedAt  *int64  `json:"archived_at"`
}

type SnapshotRelationship struct {
	ID         string `json:"id"`
	VaultID    string `json:"vault_id"`
	UserAID    string `json:"user_a_id"`
	UserBID    string `json:"user_b_id"`
	Context    string `json:"context"`
	CreatedAt  int64  `json:"created_at"`
	UpdatedAt  int64  `json:"updated_at"`
	ArchivedAt *int64 `json:"archived_at"`
}

type SnapshotEntry struct {
	ID               string  `json:"id"`
	VaultID          string  `json:"vault_id"`
	RelationshipID   string  `json:"relationship_id"`
	Type             string  `json:"type"`
	AmountAFN        int64   `json:"amount_afn"`
	Note             *string `json:"note"`
	CreatedAt        int64   `json:"created_at"`
	UpdatedAt        int64   `json:"updated_at"`
	DeletedAt        *int64  `json:"deleted_at"`
	ProposedByUserID *string `json:"proposed_by_user_id"`
	CurrentEventID   *string `json:"current_event_id"`
	IsDeleted        int     `json:"is_deleted"`
	IsSettled        int     `json:"is_settled"`
	AcceptedAt       *int64  `json:"accepted_at"`
	DisputedAt       *int64  `json:"disputed_at"`
	DisputedReason   *string `json:"disputed_reason"`
	SettledAt        *int64  `json:"settled_at"`
}

// LatestSnapshot returns the most recent vault_snapshots row for vaultID,
// re-expanded into the per-table shape the mobile restore consumer expects,
// PLUS the tail of events appended after up_to_server_seq. Returns
// pgx.ErrNoRows if no snapshot has been generated yet.
func (s *Service) LatestSnapshot(ctx context.Context, vaultID string) (*SnapshotResponse, error) {
	var (
		upTo      int64
		schemaVer int
		payload   []byte
		createdAt time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT up_to_server_seq, schema_version, snapshot, created_at
		FROM vault_snapshots
		WHERE vault_id = $1::uuid
		ORDER BY up_to_server_seq DESC
		LIMIT 1
	`, vaultID).Scan(&upTo, &schemaVer, &payload, &createdAt)
	if err != nil {
		return nil, err
	}

	var projection Projection
	if err := json.Unmarshal(payload, &projection); err != nil {
		return nil, fmt.Errorf("unmarshal snapshot: %w", err)
	}

	// Fetch the vaults row so the mobile vault seed has authoritative
	// columns (name, currency, account_id, is_default) that the projection
	// does NOT carry (projection is ledger-state only).
	var (
		vaultName      string
		vaultCurrency  string
		vaultCreated   time.Time
		vaultUpdated   time.Time
		vaultAccount   *string
		trustAnchorRaw []byte // nil for server-anchored vaults
	)
	if err := s.pool.QueryRow(ctx, `
		SELECT name, currency, created_at, COALESCE(updated_at, created_at), owner_account_id::text, vault_trust_anchor_pubkey
		FROM vaults
		WHERE vault_id = $1::uuid
	`, vaultID).Scan(&vaultName, &vaultCurrency, &vaultCreated, &vaultUpdated, &vaultAccount, &trustAnchorRaw); err != nil {
		return nil, fmt.Errorf("read vault row: %w", err)
	}
	// M5: surface the pinned trust anchor when populated. Same std-base64
	// encoding GET /v1/vaults uses, so the mobile decoder serves both paths.
	var trustAnchorB64 *string
	if len(trustAnchorRaw) == 32 {
		encoded := base64.StdEncoding.EncodeToString(trustAnchorRaw)
		trustAnchorB64 = &encoded
	}

	// Drain the post-snapshot event tail in pulled-event shape.
	tail, err := s.pullTail(ctx, vaultID, upTo)
	if err != nil {
		return nil, fmt.Errorf("read snapshot tail: %w", err)
	}
	// ENG #7: re-stamp NULL actor_account_ids via the binding resolver
	// so the snapshot-bootstrap path matches steady-state pull output.
	// Without this, a fresh-install client that bootstraps via
	// /v1/sync/snapshot receives NULL account_ids for pre-binding tail
	// events even when an account_bound covers them.
	s.resolveBindingsOnPulled(ctx, vaultID, tail)

	// M5 recovery: the vault's FULL membership chain in HLC order, regardless
	// of the snapshot cursor. A recovering device needs every membership
	// event (genesis + member/device adds) to build a proof bundle and fold
	// its own membership; the cursor-bound tail above does not carry the ones
	// that predate up_to_server_seq. Same wire shape + binding resolution as
	// the tail (mobile ingests by event_id idempotently, so overlap is fine).
	membership, err := s.pullMembershipChain(ctx, vaultID)
	if err != nil {
		return nil, fmt.Errorf("read membership chain: %w", err)
	}
	s.resolveBindingsOnPulled(ctx, vaultID, membership)

	// Compute hlc_last as the MAX HLC observed in the snapshot's events
	// (which we don't keep explicitly — we approximate by walking the
	// projection's updated_at fields and the tail). Membership events are
	// intentionally NOT folded in here: they are pre-cursor history, the
	// projection's updated_at fields already bound the live frontier, and
	// any membership event also present in the tail is already counted.
	hlcLast := snapshotMaxHLC(&projection, tail)

	resp := &SnapshotResponse{
		VaultID:           vaultID,
		SnapshotServerSeq: upTo,
		GeneratedAtMS:     createdAt.UnixMilli(),
		SchemaVersion:     schemaVer,
		Vault: SnapshotVault{
			ID:                     vaultID,
			Name:                   vaultName,
			Currency:               vaultCurrency,
			CreatedAt:              vaultCreated.UnixMilli(),
			UpdatedAt:              vaultUpdated.UnixMilli(),
			IsDefault:              1,
			AccountID:              vaultAccount,
			VaultTrustAnchorPubkey: trustAnchorB64,
		},
		ShopProfile:      projectShopProfile(vaultID, projection.ShopProfile),
		Users:            projectUsers(projection.Users),
		Relationships:    projectRelationships(projection.Relationships),
		Entries:          projectEntries(projection.Entries),
		HLCLast:          hlcLast,
		Events:           tail,
		MembershipEvents: membership,
	}
	return resp, nil
}

func projectShopProfile(vaultID string, sp *ShopProfileProjection) *SnapshotShopProfile {
	if sp == nil {
		return nil
	}
	shopName := ""
	if sp.ShopName != nil {
		shopName = *sp.ShopName
	}
	return &SnapshotShopProfile{
		VaultID:   vaultID,
		OwnerName: sp.OwnerName,
		ShopName:  shopName,
		CreatedAt: sp.UpdatedAt,
		UpdatedAt: sp.UpdatedAt,
	}
}

func projectUsers(in map[string]*UserProjection) []SnapshotUser {
	out := make([]SnapshotUser, 0, len(in))
	for _, u := range in {
		out = append(out, SnapshotUser{
			ID:          u.ID,
			PhoneE164:   u.PhoneE164,
			DisplayName: u.DisplayName,
			IsLocalSelf: boolToInt(u.IsLocalSelf),
			GoogleSub:   u.GoogleSub,
			AccountID:   u.AccountID,
			CreatedAt:   u.CreatedAt,
			UpdatedAt:   u.UpdatedAt,
			ArchivedAt:  u.ArchivedAt,
		})
	}
	return out
}

func projectRelationships(in map[string]*RelationshipProjection) []SnapshotRelationship {
	out := make([]SnapshotRelationship, 0, len(in))
	for _, r := range in {
		out = append(out, SnapshotRelationship{
			ID:         r.ID,
			VaultID:    r.VaultID,
			UserAID:    r.UserAID,
			UserBID:    r.UserBID,
			Context:    r.Context,
			CreatedAt:  r.CreatedAt,
			UpdatedAt:  r.UpdatedAt,
			ArchivedAt: r.ArchivedAt,
		})
	}
	return out
}

func projectEntries(in map[string]*EntryProjection) []SnapshotEntry {
	out := make([]SnapshotEntry, 0, len(in))
	for _, e := range in {
		var currentEventID *string
		if e.CurrentEventID != "" {
			id := e.CurrentEventID
			currentEventID = &id
		}
		var proposedByUserID *string
		if e.ProposedByUserID != "" {
			id := e.ProposedByUserID
			proposedByUserID = &id
		}
		out = append(out, SnapshotEntry{
			ID:               e.ID,
			VaultID:          e.VaultID,
			RelationshipID:   e.RelationshipID,
			Type:             e.Type,
			AmountAFN:        e.AmountAFN,
			Note:             e.Note,
			CreatedAt:        e.CreatedAt,
			UpdatedAt:        e.UpdatedAt,
			DeletedAt:        e.DeletedAt,
			ProposedByUserID: proposedByUserID,
			CurrentEventID:   currentEventID,
			IsDeleted:        boolToInt(e.IsDeleted),
			IsSettled:        boolToInt(e.IsSettled),
			AcceptedAt:       e.AcceptedAt,
			DisputedAt:       e.DisputedAt,
			DisputedReason:   e.DisputedReason,
			SettledAt:        e.SettledAt,
		})
	}
	return out
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func snapshotMaxHLC(p *Projection, tail []PulledEvent) HLC {
	max := HLC{}
	for _, ev := range tail {
		if CompareHLC(ev.HLC, max) > 0 {
			max = ev.HLC
		}
	}
	for _, u := range p.Users {
		if u.UpdatedAt > max.PMS {
			max = HLC{PMS: u.UpdatedAt}
		}
	}
	for _, r := range p.Relationships {
		if r.UpdatedAt > max.PMS {
			max = HLC{PMS: r.UpdatedAt}
		}
	}
	for _, e := range p.Entries {
		if e.UpdatedAt > max.PMS {
			max = HLC{PMS: e.UpdatedAt}
		}
	}
	return max
}

// pulledEventColumns is the SELECT list (in scan order) shared by pullTail
// and pullMembershipChain so both produce byte-identical PulledEvent wire
// shapes — incl. event_sig_b64 / signer_device_pubkey / author_seq, which
// the receiving replica needs to verify the membership chain end-to-end.
const pulledEventColumns = `
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
		author_seq,
		event_sig_b64,
		signer_device_pubkey,
		server_seq,
		server_received_at`

// scanPulledEvents drains rows shaped by pulledEventColumns into PulledEvents.
func scanPulledEvents(rows pgx.Rows) ([]PulledEvent, error) {
	defer rows.Close()
	events := make([]PulledEvent, 0)
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
			&ev.AuthorSeq,
			&ev.EventSigB64,
			&ev.SignerDevicePubkey,
			&ev.ServerSeq,
			&serverReceivedAt,
		); err != nil {
			return nil, err
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
	return events, rows.Err()
}

// pullTail returns events appended after upTo for the given vault, in the
// same shape as PullEvents.
func (s *Service) pullTail(ctx context.Context, vaultID string, upTo int64) ([]PulledEvent, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT`+pulledEventColumns+`
		FROM events
		WHERE vault_id = $1::uuid
		  AND server_seq > $2
		  AND redacted_at IS NULL
		ORDER BY server_seq ASC
	`, vaultID, upTo)
	if err != nil {
		return nil, err
	}
	return scanPulledEvents(rows)
}

// pullMembershipChain returns the vault's FULL membership chain (the M2
// IsMembershipEventType set: vault_member_added / vault_member_removed /
// vault_member_role_changed / vault_device_added / vault_device_removed) in
// HLC order (hlc_physical_ms, hlc_logical, hlc_device_id, event_id),
// IGNORING the snapshot cursor. A recovering device folds these to rebuild
// its membership proof bundle. Tiny (<100/vault). Same wire shape as the
// tail; mobile ingests by event_id so overlap with the tail is idempotent.
func (s *Service) pullMembershipChain(ctx context.Context, vaultID string) ([]PulledEvent, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT`+pulledEventColumns+`
		FROM events
		WHERE vault_id = $1::uuid
		  AND redacted_at IS NULL
		  AND event_type = ANY($2)
		ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC, event_id ASC
	`, vaultID, membershipEventTypes)
	if err != nil {
		return nil, err
	}
	return scanPulledEvents(rows)
}

// ==========================================================================
// CRON
// ==========================================================================

// OpenSnapshotPool creates the dedicated, small pool used by the cron.
// SNAPSHOT_DB_POOL_MAX env var overrides the default of 4.
func OpenSnapshotPool(ctx context.Context, dbURL string) (*pgxpool.Pool, int32, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, 0, fmt.Errorf("parse db url: %w", err)
	}
	max := int32(4)
	if raw := os.Getenv("SNAPSHOT_DB_POOL_MAX"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 && v <= 64 {
			max = int32(v)
		}
	}
	cfg.MaxConns = max
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, 0, fmt.Errorf("create snapshot pool: %w", err)
	}
	return pool, max, nil
}

// StartSnapshotCron blocks until ctx is cancelled, ticking every interval.
//
// The cron is safe to run on multiple backend replicas — vault_snapshots'
// (vault_id, up_to_server_seq) PRIMARY KEY makes duplicate writes a no-op
// via ON CONFLICT DO NOTHING.
func StartSnapshotCron(ctx context.Context, pool *pgxpool.Pool, interval time.Duration, maxConns int32) {
	log.Printf("snapshot cron running with %d max conns, tick=%s", maxConns, interval)

	tick := func() {
		if err := runSnapshotTick(ctx, pool); err != nil {
			log.Printf("snapshot cron: tick failed: %v", err)
		}
	}
	tick()

	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("snapshot cron: shutting down")
			return
		case <-t.C:
			tick()
		}
	}
}

type snapshotCandidate struct {
	vaultID          string
	maxServerSeq     int64
	priorUpTo        int64
	priorCreatedAt   time.Time
	hasPriorSnapshot bool
}

func runSnapshotTick(ctx context.Context, pool *pgxpool.Pool) error {
	candidates, err := findSnapshotCandidates(ctx, pool)
	if err != nil {
		return fmt.Errorf("find candidates: %w", err)
	}
	if len(candidates) == 0 {
		return nil
	}

	now := time.Now()
	generated := 0
	skipped := 0
	failed := 0
	for _, c := range candidates {
		if c.hasPriorSnapshot && now.Sub(c.priorCreatedAt) < snapshotMinInterval {
			skipped++
			continue
		}
		if err := generateSnapshotForVault(ctx, pool, c); err != nil {
			log.Printf("snapshot cron: vault=%s generate failed: %v", c.vaultID, err)
			failed++
			continue
		}
		generated++
		log.Printf("snapshot cron: vault=%s generated up_to_server_seq=%d", c.vaultID, c.maxServerSeq)
	}
	log.Printf("snapshot cron: tick done — generated=%d skipped=%d failed=%d", generated, skipped, failed)
	return nil
}

func findSnapshotCandidates(ctx context.Context, pool *pgxpool.Pool) ([]snapshotCandidate, error) {
	rows, err := pool.Query(ctx, `
		WITH event_maxes AS (
			SELECT vault_id, MAX(server_seq) AS max_server_seq
			FROM events
			GROUP BY vault_id
		)
		SELECT
			em.vault_id::text,
			em.max_server_seq,
			COALESCE(s.up_to_server_seq, 0)         AS prior_up_to,
			COALESCE(s.created_at, 'epoch'::timestamptz) AS prior_created_at,
			s.up_to_server_seq IS NOT NULL          AS has_prior
		FROM event_maxes em
		LEFT JOIN LATERAL (
			SELECT up_to_server_seq, created_at
			FROM vault_snapshots
			WHERE vault_id = em.vault_id
			ORDER BY created_at DESC
			LIMIT 1
		) s ON TRUE
		WHERE
			(em.max_server_seq > COALESCE(s.up_to_server_seq, 0) + $1)
			OR
			(
				s.created_at IS NOT NULL
				AND s.created_at < NOW() - $2::interval
				AND em.max_server_seq > s.up_to_server_seq
			)
			OR
			(s.up_to_server_seq IS NULL AND em.max_server_seq > 0)
	`, snapshotMinNewEvents, snapshotMaxAge.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []snapshotCandidate
	for rows.Next() {
		var c snapshotCandidate
		if err := rows.Scan(
			&c.vaultID, &c.maxServerSeq, &c.priorUpTo, &c.priorCreatedAt, &c.hasPriorSnapshot,
		); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// BuildPushSnapshotTrigger returns a SnapshotTrigger that, when fired by
// the push handler crossing snapshotEventThreshold, kicks an in-flight-
// bounded goroutine to regenerate the vault's snapshot off the dedicated
// snapshot pool. On success the per-vault pending counter is reset so the
// next threshold crossing fires fresh.
//
// Concurrent triggers for the same vault are coalesced: a second trigger
// while one is in-flight is dropped because the first will already pick
// up the new events as part of its replay.
func BuildPushSnapshotTrigger(ctx context.Context, pool *pgxpool.Pool, svc *Service) SnapshotTrigger {
	var (
		inFlightMu gosync.Mutex
		inFlight   = make(map[string]bool)
	)
	return func(vaultID string) {
		inFlightMu.Lock()
		if inFlight[vaultID] {
			inFlightMu.Unlock()
			return
		}
		inFlight[vaultID] = true
		inFlightMu.Unlock()

		go func() {
			defer func() {
				inFlightMu.Lock()
				delete(inFlight, vaultID)
				inFlightMu.Unlock()
			}()
			// Read prior up_to so generateSnapshotForVault can short-circuit
			// when nothing new has actually arrived since the last snapshot.
			var (
				maxSeq         int64
				priorUpTo      int64
				priorCreatedAt time.Time
				hasPrior       bool
			)
			err := pool.QueryRow(ctx, `
				SELECT
					COALESCE((SELECT MAX(server_seq) FROM events WHERE vault_id = $1::uuid AND redacted_at IS NULL), 0),
					COALESCE((SELECT up_to_server_seq FROM vault_snapshots WHERE vault_id = $1::uuid ORDER BY up_to_server_seq DESC LIMIT 1), 0),
					COALESCE((SELECT created_at FROM vault_snapshots WHERE vault_id = $1::uuid ORDER BY up_to_server_seq DESC LIMIT 1), 'epoch'::timestamptz),
					EXISTS (SELECT 1 FROM vault_snapshots WHERE vault_id = $1::uuid)
			`, vaultID).Scan(&maxSeq, &priorUpTo, &priorCreatedAt, &hasPrior)
			if err != nil {
				log.Printf("snapshot trigger: vault=%s read state failed: %v", vaultID, err)
				return
			}
			if maxSeq <= priorUpTo {
				svc.ResetSnapshotPending(vaultID)
				return
			}
			c := snapshotCandidate{
				vaultID:          vaultID,
				maxServerSeq:     maxSeq,
				priorUpTo:        priorUpTo,
				priorCreatedAt:   priorCreatedAt,
				hasPriorSnapshot: hasPrior,
			}
			if err := generateSnapshotForVault(ctx, pool, c); err != nil {
				log.Printf("snapshot trigger: vault=%s generate failed: %v", vaultID, err)
				return
			}
			svc.ResetSnapshotPending(vaultID)
			log.Printf("snapshot trigger: vault=%s generated up_to_server_seq=%d", vaultID, maxSeq)
		}()
	}
}

func generateSnapshotForVault(ctx context.Context, pool *pgxpool.Pool, c snapshotCandidate) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadWrite})
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	payload, upTo, err := buildSnapshotInTx(ctx, tx, c.vaultID, c.priorUpTo, c.hasPriorSnapshot)
	if err != nil {
		return fmt.Errorf("build snapshot: %w", err)
	}
	if upTo <= c.priorUpTo {
		return nil
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO vault_snapshots (
			vault_id, up_to_server_seq, schema_version,
			snapshot, byte_size, created_at
		)
		VALUES ($1::uuid, $2, $3, $4::jsonb, $5, NOW())
		ON CONFLICT (vault_id, up_to_server_seq) DO NOTHING
	`, c.vaultID, upTo, SnapshotSchemaVersion, string(payload), len(payload)); err != nil {
		return fmt.Errorf("insert vault_snapshots: %w", err)
	}

	return tx.Commit(ctx)
}

// buildSnapshotInTx: rebuilds the projection from scratch by replaying ALL
// events for the vault. Returns the serialized projection + the highest
// server_seq seen.
//
// Why "from scratch" instead of incremental on top of the prior snapshot:
// the in-memory projection carries per-field HLC bookkeeping (hlcAmount /
// hlcNote / hlcType / hlcOccurredAt / hlcShopName / hlcOwnerName) which is
// json:"-" — stripped on serialize. A "load prior + apply new" path would
// re-parse those fields as zero HLCs, so any out-of-order amend touching
// the same field as a prior event would always win the LWW comparison
// (CompareHLC against {0,0,""} is always >0). That silently breaks LWW
// at every snapshot regeneration. Replaying from scratch keeps the
// per-field winners deterministic at the cost of one full table scan per
// snapshot — acceptable because the cron is throttled to one snapshot
// per vault per hour.
//
// priorUpTo/hasPrior are kept on the signature for the caller's
// "did this snapshot actually advance?" check after the build.
func buildSnapshotInTx(ctx context.Context, tx pgx.Tx, vaultID string, priorUpTo int64, hasPrior bool) ([]byte, int64, error) {
	_ = priorUpTo
	_ = hasPrior
	projection := NewProjection()

	// Read ALL events for the vault, ordered by server_seq. Replay-from-
	// scratch is deliberate — see comment above.
	rows, err := tx.Query(ctx, `
		SELECT
			event_id::text,
			event_type,
			vault_id::text,
			hlc_physical_ms,
			hlc_logical,
			hlc_device_id::text,
			device_id::text,
			account_id::text,
			target_id::text,
			relationship_id::text,
			payload,
			server_seq,
			schema_version
		FROM events
		WHERE vault_id = $1::uuid
		  AND redacted_at IS NULL
		ORDER BY server_seq ASC
	`, vaultID)
	if err != nil {
		return nil, 0, fmt.Errorf("read events: %w", err)
	}
	defer rows.Close()

	var events []LedgerEvent
	var upTo int64 = 0
	for rows.Next() {
		var (
			ev            LedgerEvent
			accountID     *string
			targetID      *string
			relID         *string
			payload       []byte
			schemaVersion int
		)
		if err := rows.Scan(
			&ev.EventID,
			&ev.EventType,
			&ev.VaultID,
			&ev.HLC.PMS,
			&ev.HLC.L,
			&ev.HLC.DID,
			&ev.DeviceID,
			&accountID,
			&targetID,
			&relID,
			&payload,
			&ev.ServerSeq,
			&schemaVersion,
		); err != nil {
			return nil, 0, fmt.Errorf("scan event: %w", err)
		}
		ev.ActorAccountID = accountID
		if targetID != nil {
			ev.TargetID = *targetID
		}
		ev.RelationshipID = relID
		ev.PayloadSchema = schemaVersion
		if len(payload) == 0 {
			ev.Payload = json.RawMessage("null")
		} else {
			ev.Payload = json.RawMessage(payload)
		}
		events = append(events, ev)
		if ev.ServerSeq > upTo {
			upTo = ev.ServerSeq
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("rows err: %w", err)
	}

	if err := ApplyEventsOnto(&projection, events); err != nil {
		return nil, 0, fmt.Errorf("apply events to projection: %w", err)
	}

	out, err := ProjectionToJSON(projection)
	if err != nil {
		return nil, 0, fmt.Errorf("serialize projection: %w", err)
	}
	return out, upTo, nil
}
