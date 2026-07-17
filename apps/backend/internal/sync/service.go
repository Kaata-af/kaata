package sync

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
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
// itself is missing. The handler maps it to 403 like ErrNotMember but with
// a distinct error_code ("vault_unknown" vs "not_member") — a removed
// member's device has no other channel to learn of its own removal (the
// revocation lands in the same tx as the removal event, so its next pull
// 403s before it can fetch that event), and without the distinction the
// client misreads the 403 as "vault not registered" and strands local
// writes forever. Vault ids are UUIDv4, so the existence signal this
// discloses to authenticated non-members is not guessable-oracle material.
var ErrVaultNotFound = errors.New("vault not found")

// ErrVaultArchived is returned when the vault exists and the caller IS an
// active member, but the vault is archived and the caller is not its owner
// ("archive = stop sharing" — only the owner keeps sync access during the
// 30-day grace). The handler maps it to 403 with error_code "vault_archived",
// DISTINCT from "not_member": the mobile client's reaction to not_member is
// to permanently revoke its own local membership row (the only signal a
// removed member ever gets), which is irreversible client-side. An archived
// kaata must instead archive locally — collapsing the two codes made every
// owner-side archive silently DELETE the kaata from every member's phone
// instead of moving it to their archived list.
var ErrVaultArchived = errors.New("vault is archived")

// snapshotEventThreshold is how many newly-accepted events triggers a
// snapshot regeneration goroutine. The cron job runs as a backstop;
// this counter-based trigger keeps snapshots fresh during burst writes.
const snapshotEventThreshold = 1000

// membershipCacheTTL mirrors the auth middleware's revocation cache TTL.
const membershipCacheTTL = 60 * time.Second

// maxFutureHLCSkewMS bounds how far ahead of server time a pushed event's HLC
// may be. 48h is far beyond any real device clock drift, so a merely-skewed
// clock is never rejected; it only blocks gross future-dating. Events past this
// are rejected with RejectReasonFutureHLC, which the client treats as retryable.
const maxFutureHLCSkewMS int64 = 48 * 60 * 60 * 1000

// pullCacheTTL is how long a (vault, after, limit) page lives in memory.
// Events are append-only, so a FULL page never goes stale — but the tip
// page (short/empty, at the high-water cursor) has an open window that new
// appends land inside, and a polling client re-hits the identical key.
// PushEvents therefore purges the vault's pages after any accepted commit;
// this TTL is only the backstop for writes that bypass that path.
const pullCacheTTL = 60 * time.Second

// pullCacheSize is the LRU capacity. Generous; tune down if RSS grows.
const pullCacheSize = 1024

// roleArchivedDenied is the cached-membership sentinel for "active non-owner
// member of an ARCHIVED vault" — denied, but NOT not_member (see
// ErrVaultArchived). Never a real role value ("owner"/"editor"/"viewer").
const roleArchivedDenied = "\x00archived"

type membershipEntry struct {
	checkedAt time.Time
	role      string // "" → not a member; roleArchivedDenied → archived cutoff
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

	// M2 (membership.go): pinned server signing pubkey set for verifying
	// the `witness` field on membership events. Set via SetWitnessPubkeys
	// at startup; empty disables the witness authorization arm.
	witnessPubkeys []ed25519.PublicKey
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
	if errors.Is(err, ErrNotMember) || errors.Is(err, ErrVaultNotFound) ||
		errors.Is(err, ErrVaultArchived) {
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
//
// DeviceID is the batch-level TRANSPORT device — whoever is pushing right
// now. It is NOT necessarily the author of the events in the batch: a relay
// (sync v2 §4 scenario 4) legitimately pushes events authored on other
// devices. Everything author-keyed (events.device_id stamping, author_seq
// slots, device vectors) keys on each event's hlc.device_id instead.
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
	if role == roleArchivedDenied {
		// Active member of an archived vault (non-owner). Distinct from
		// not_member so the client archives locally instead of self-revoking.
		return nil, ErrVaultArchived
	}
	if role == "" {
		// Distinguish "vault exists, you're not an active member" from
		// "no such vault" so the handler can stamp the right error_code —
		// a removed member's device relies on not_member (vs vault_unknown)
		// to detect its own removal. checkMembership's single joined query
		// can't tell the two apart, so resolve on the denial path only.
		var exists bool
		if lerr := s.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM vaults WHERE vault_id = $1::uuid)
		`, in.VaultID).Scan(&exists); lerr != nil {
			return nil, fmt.Errorf("membership: vault existence: %w", lerr)
		}
		if !exists {
			return nil, ErrVaultNotFound
		}
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

	// M2: the vault trust anchor (NULL on legacy server-anchored vaults).
	// Signed membership events on anchored vaults take the chain-
	// verification path below instead of the JWT ACL.
	var vaultAnchor []byte
	if err := tx.QueryRow(ctx, `
		SELECT vault_trust_anchor_pubkey FROM vaults WHERE vault_id = $1::uuid
	`, in.VaultID).Scan(&vaultAnchor); err != nil {
		return nil, fmt.Errorf("read vault trust anchor: %w", err)
	}

	// M2: membership-cache invalidations collected from chain folds,
	// applied after commit.
	var foldInvalidations []string

	// Pre-parse account/vault uuids once; reused per-event for the
	// lawful-at-HLC role lookup. Either failure causes a wholesale push
	// failure; that's fine because the same uuids drove membership lookup
	// above and would have already rejected at that gate.
	accountUUID, _ := uuid.Parse(in.AccountID)
	vaultUUID, _ := uuid.Parse(in.VaultID)

	// SEC FIX 1: verify+fold membership events in deterministic
	// (HLC, event_id) order, NOT wire order. The membership chain folds
	// in-batch state (a vault_member_added then its later removal, a device
	// binding then an event that relies on it) and each event is verified
	// against the fold state built so far. If we iterated wire order, an
	// attacker could reorder the batch to make verification read fold state
	// at an attacker-chosen point. Mobile and the ledger projection both
	// fold strictly by (hlc_physical_ms, hlc_logical, hlc_device_id,
	// event_id) (apps/mobile/lib/trust/proof.ts, project.go) — match that
	// total order here so every replica folds identically.
	//
	// We sort a COPY of the slice. The per-event response arrays (accepted /
	// duplicates / rejected) are keyed by event_id, not position, so the
	// reorder leaves the wire contract intact. author_seq slot assignment
	// keys on (vault_id, hlc.device_id, author_seq) and reads committed /
	// in-tx DB rows under the vaults-row FOR UPDATE lock — it never depends
	// on in-batch iteration order — so the sort is safe for it too.
	ordered := make([]PushEvent, len(in.Events))
	copy(ordered, in.Events)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := &ordered[i], &ordered[j]
		if a.HLC.PhysicalMS != b.HLC.PhysicalMS {
			return a.HLC.PhysicalMS < b.HLC.PhysicalMS
		}
		if a.HLC.Logical != b.HLC.Logical {
			return a.HLC.Logical < b.HLC.Logical
		}
		if a.HLC.DeviceID != b.HLC.DeviceID {
			return a.HLC.DeviceID < b.HLC.DeviceID
		}
		return a.EventID < b.EventID
	})

	nowMS := time.Now().UnixMilli()

	for i := range ordered {
		ev := ordered[i]
		// HLC future-clamp: reject events dated implausibly far ahead of server
		// time. Real device clocks drift by minutes/hours, never 2 days; this
		// blocks an editor from FUTURE-dating events (to dominate last-write-wins
		// or survive a later revocation) without touching legitimate past-dated
		// offline batches. The window is deliberately WIDE so a merely-skewed
		// clock is never rejected. The client treats this reject as RETRYABLE
		// (no rejected_at) so the event is never DROPPED — it re-pushes and is
		// accepted once server time advances to within the window of the device's
		// (monotonic, ratchet-forward) HLC. A gross skew therefore DELAYS that
		// vault's sync (until real time catches up) but never loses the event.
		if ev.HLC.PhysicalMS > nowMS+maxFutureHLCSkewMS {
			rejected = append(rejected, RejectedEvent{
				EventID: ev.EventID,
				Reason:  RejectReasonFutureHLC,
			})
			continue
		}
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

		// M2 (membership.go): a SIGNED membership event on an ANCHORED
		// vault is judged by the chain rules (anchor / bound owner device /
		// server witness) instead of the JWT ACL — the witnessed self-
		// admission flows are precisely the ones the role matrix would
		// wrongly refuse. Anchor-less vaults and unsigned events keep the
		// legacy path below unchanged (no regression for old clients).
		m2Verified := false
		if IsMembershipEventType(ev.EventType) &&
			len(vaultAnchor) == ed25519.PublicKeySize &&
			derefStr(ev.EventSigB64) != "" &&
			derefStr(ev.SignerDevicePubkeyB64) != "" {
			ok, verr := s.verifyMembershipEvent(ctx, tx, in.VaultID, in.AccountID, vaultAnchor, &ev)
			if verr != nil {
				return nil, fmt.Errorf("membership verification for %s: %w", ev.EventID, verr)
			}
			if !ok {
				rejected = append(rejected, RejectedEvent{
					EventID: ev.EventID,
					Reason:  RejectReasonMembershipUnverified,
				})
				continue
			}
			m2Verified = true
		}

		// Legacy-path self-leave ("leave kaata" on an anchor-less vault, or an
		// unsigned event): the role matrix demands owner for
		// vault_member_removed and has no self-arm, so without this a member's
		// own leave — which the mobile gate can apply locally when the LOCAL
		// vault row carries an anchor the server never got (pre-Phase-7
		// registration) — would reject insufficient_role forever: the leaver's
		// phone shows them gone while the server keeps them active, a silent
		// permanent split. Authorization is the SESSION, not the wire: the
		// target must equal the PUSHING (JWT-authenticated) account, so a
		// forged actor_account_id can never remove anyone but the pusher
		// themselves. Folded below exactly like a chain-verified removal
		// (foldMembershipEvent's member_removed arm: last-owner guard + HLC
		// arbitration + audit row), mirroring what the REST /leave endpoint
		// does for these vaults.
		legacySelfLeave := false
		if !m2Verified && ev.EventType == EventVaultMemberRemoved {
			var p memberRemovedWire
			if json.Unmarshal(ev.Payload, &p) == nil && p.AccountID == in.AccountID {
				legacySelfLeave = true
			}
		}

		if !m2Verified && !legacySelfLeave {
			allowed, atRole, requiredRole, err := CheckEventPermission(
				ctx, tx, s.binding,
				accountUUID, vaultUUID,
				evIDUUID, ev.EventType, storedActor,
				ev.HLC.PhysicalMS, ev.HLC.Logical, hlcDevUUID,
			)
			if err != nil {
				// Unknown event_type is a per-event rejection, not a batch
				// 500: otherwise a newer APK shipping one new type wedges
				// the whole outbox behind it forever (the client re-sends
				// the identical batch on 5xx). The reason is retryable on
				// the client (safety net: user-ledger events stay unacked
				// with backoff, never rejected_at).
				if errors.Is(err, ErrUnknownEventType) {
					rejected = append(rejected, RejectedEvent{
						EventID: ev.EventID,
						Reason:  RejectReasonUnknownEventType,
					})
					continue
				}
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
		}

		// M1 (sync v2 §5): author_seq slot check. Slots are keyed by the
		// EVENT'S AUTHOR — (vault_id, hlc.device_id, author_seq) — never by
		// the batch-level pushing device (in.DeviceID): relays push events
		// authored on other devices, and keying the slot on the pusher
		// would corrupt the per-author sequence space. The partial unique
		// index events_vault_device_author_seq guarantees one (vault,
		// author device, seq) slot per event; we pre-check it here — safe
		// because the vaults-row FOR UPDATE above serializes pushes per
		// vault — so a DIFFERENT event claiming a taken slot becomes a
		// per-event "seq_conflict" rejection instead of a tx-aborting
		// unique violation (no 500, batch continues). The SAME event
		// re-claiming its own slot falls through to the insert, where the
		// event_id PK arbiter routes it to duplicates[] exactly as before.
		if ev.AuthorSeq != nil {
			var slotEventID string
			err := tx.QueryRow(ctx, `
				SELECT event_id::text FROM events
				WHERE vault_id = $1::uuid AND device_id = $2::uuid AND author_seq = $3
			`, in.VaultID, ev.HLC.DeviceID, *ev.AuthorSeq).Scan(&slotEventID)
			switch {
			case err == nil && slotEventID != ev.EventID:
				// Slot held by a different event. If THIS event is already
				// stored, this is a duplicate re-announce carrying a
				// conflicting seq — report it as a plain duplicate (the
				// stored row keeps whatever author_seq it has, first value
				// wins). seq_conflict is reserved for fresh events.
				var exists bool
				if derr := tx.QueryRow(ctx, `
					SELECT EXISTS (SELECT 1 FROM events WHERE event_id = $1::uuid)
				`, ev.EventID).Scan(&exists); derr != nil {
					return nil, fmt.Errorf("duplicate check for %s: %w", ev.EventID, derr)
				}
				if exists {
					duplicates = append(duplicates, ev.EventID)
					continue
				}
				rejected = append(rejected, RejectedEvent{
					EventID: ev.EventID,
					Reason:  "seq_conflict",
				})
				continue
			case err != nil && !errors.Is(err, pgx.ErrNoRows):
				return nil, fmt.Errorf("author_seq slot check for %s: %w", ev.EventID, err)
			}
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
		var authorSeq interface{}
		if ev.AuthorSeq != nil {
			authorSeq = *ev.AuthorSeq
		}
		// M2: persist the author signature material when supplied so pull /
		// snapshot-tail relay the proof bytes to other replicas verbatim.
		var eventSig interface{}
		if derefStr(ev.EventSigB64) != "" {
			eventSig = *ev.EventSigB64
		}
		var signerPubkey interface{}
		if derefStr(ev.SignerDevicePubkeyB64) != "" {
			signerPubkey = *ev.SignerDevicePubkeyB64
		}

		// device_id is stamped from the EVENT's author (hlc.device_id), not
		// from in.DeviceID: relayed events carry hlc_device_id != pusher,
		// and 007's CHECK (device_id = hlc_device_id) would 500 the whole
		// batch — permanently wedging the relayer's outbox — if we stamped
		// the pusher here.
		tag, err := tx.Exec(ctx, `
			INSERT INTO events (
				event_id, vault_id, server_seq,
				event_type, schema_version,
				hlc_physical_ms, hlc_logical, hlc_device_id,
				device_id, account_id,
				target_id, relationship_id,
				author_seq,
				event_sig_b64, signer_device_pubkey,
				payload, server_received_at
			) VALUES (
				$1::uuid, $2::uuid, $3,
				$4, $5,
				$6, $7, $8::uuid,
				$9::uuid, $10,
				$11, $12,
				$13,
				$14, $15,
				$16::jsonb, NOW()
			)
			ON CONFLICT (event_id) DO NOTHING
		`,
			ev.EventID, in.VaultID, nextSeq,
			ev.EventType, ev.SchemaVersion,
			ev.HLC.PhysicalMS, ev.HLC.Logical, ev.HLC.DeviceID,
			ev.HLC.DeviceID, actorID,
			targetID, relID,
			authorSeq,
			eventSig, signerPubkey,
			string(ev.Payload),
		)
		if err != nil {
			return nil, fmt.Errorf("insert event %s: %w", ev.EventID, err)
		}

		if tag.RowsAffected() == 0 {
			// Duplicate by event_id. M1 re-announce: when the wire carries
			// an author_seq and the stored row predates M1 (author_seq IS
			// NULL), adopt the announced seq — this is how pre-M1 history
			// gains sequence numbers (mobile ships a one-shot re-announce
			// that re-pushes its own acked history as duplicates). The slot
			// pre-check above already verified the (vault, author, seq)
			// slot is free or held by this very event, and the vault lock
			// keeps that read stable for the rest of the tx, so this UPDATE
			// cannot trip the unique index. The device_id guard pins the
			// claim to the author the slot check keyed on; author_seq IS
			// NULL makes a conflicting re-announce a silent no-op (first
			// value wins).
			if ev.AuthorSeq != nil {
				if _, uerr := tx.Exec(ctx, `
					UPDATE events SET author_seq = $4
					WHERE event_id = $1::uuid
					  AND vault_id = $2::uuid
					  AND device_id = $3::uuid
					  AND author_seq IS NULL
				`, ev.EventID, in.VaultID, ev.HLC.DeviceID, *ev.AuthorSeq); uerr != nil {
					return nil, fmt.Errorf("re-announce author_seq for %s: %w", ev.EventID, uerr)
				}
			}
			duplicates = append(duplicates, ev.EventID)
			continue
		}

		// M2: chain-verified membership events fold into the server's
		// operational ACL tables (vault_members / vault_devices) inside
		// this same transaction. Fold only on a FRESH insert — duplicates
		// were folded when first accepted. Legacy self-leaves fold too:
		// accepting the event without revoking the vault_members row would
		// leave the server ACL forever out of step with the leaver's device.
		if m2Verified || legacySelfLeave {
			accts, ferr := s.foldMembershipEvent(ctx, tx, in.VaultID, in.AccountID, &ev)
			if ferr != nil {
				return nil, fmt.Errorf("fold membership event %s: %w", ev.EventID, ferr)
			}
			foldInvalidations = append(foldInvalidations, accts...)
		}

		// Phase 4.1: invalidate the binding cache so subsequent
		// permission checks within the same batch (and pulls within
		// the cache TTL) re-scan account_bound events.
		if ev.EventType == "account_bound" {
			s.binding.InvalidateVault(in.VaultID)
			// SEC H2: pullCache holds fully-materialized response pages
			// whose AccountID fields were stamped via the binding resolver
			// at write time; a new account_bound changes future binding
			// answers, so those pages must be purged. The purge itself now
			// happens post-commit (this event lands in accepted[], and the
			// post-commit invalidatePullCacheForVault covers it) — purging
			// here, pre-commit, let a racing pull re-cache the pre-commit
			// page and reopen the staleness window.
		}

		// S1 data-loss fix: mirror the reserved 'archived_at' vault setting onto
		// the vaults.archived_at COLUMN. A modern local-CA vault is archived by
		// emitting a vault_setting_set{key:'archived_at'} event (lib/vault-router.ts)
		// — it never calls the explicit Archive endpoint — and the in-memory
		// VaultSettings projection never reached the column, so GET /v1/vaults
		// reported the vault as live and a reinstall+restore resurrected it as a
		// live kaata. Recompute the column from the HLC-LATEST archived_at event so
		// this is order-independent + LWW-correct (handles archive→unarchive toggles
		// and out-of-order delivery), matching the mobile applier
		// (lib/projection/vault_settings.ts). Empty/non-numeric value clears it
		// (unarchived); a numeric ms value sets it.
		if ev.EventType == "vault_setting_set" {
			var vss struct {
				Key string `json:"key"`
			}
			if json.Unmarshal(ev.Payload, &vss) == nil && vss.Key == "archived_at" {
				if _, uerr := tx.Exec(ctx, `
					UPDATE vaults v SET archived_at = sub.ts
					FROM (
						SELECT CASE
							-- Anchor archived_at to SERVER time, NOT the client's
							-- ms value: the archive-purge cron hard-deletes vaults
							-- where archived_at < NOW() - 30 days, so writing a
							-- backdated/clock-skewed client timestamp could purge a
							-- freshly-archived vault instantly. Recovery + GET
							-- /v1/vaults only care whether archived_at IS NULL, so
							-- NOW() on archive / NULL on unarchive is sufficient and
							-- matches the explicit Archive endpoint's semantics.
							WHEN COALESCE(e.payload->>'value', '') = '' THEN NULL
							WHEN e.payload->>'value' ~ '^[0-9]+$' THEN NOW()
							ELSE NULL
						END AS ts
						FROM events e
						WHERE e.vault_id = $1::uuid
						  AND e.event_type = 'vault_setting_set'
						  AND e.payload->>'key' = 'archived_at'
						ORDER BY e.hlc_physical_ms DESC, e.hlc_logical DESC, e.hlc_device_id DESC
						LIMIT 1
					) sub
					WHERE v.vault_id = $1::uuid
				`, in.VaultID); uerr != nil {
					return nil, fmt.Errorf("mirror archived_at for vault %s: %w", in.VaultID, uerr)
				}
			}
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

	// M2: folded membership changes must land within one request on the
	// cached membership path, same contract as the Phase 4 endpoints'
	// InvalidateMembership calls.
	for _, acct := range foldInvalidations {
		s.InvalidateMembership(in.VaultID, acct)
	}

	if n := len(accepted); n > 0 {
		// Freshness: accepted events extended the tip of the log, and the
		// tip page is cached under the same (vault, after, limit) key a
		// polling co-editor keeps re-hitting — without this purge a peer's
		// push-on-write edit stays invisible for up to pullCacheTTL. Runs
		// AFTER commit so a racing pull can't re-cache the pre-commit page.
		s.invalidatePullCacheForVault(in.VaultID)

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
	var archived bool
	err := s.pool.QueryRow(ctx, `
		SELECT m.role, (v.archived_at IS NOT NULL)
		FROM vault_members m
		JOIN vaults v ON v.vault_id = m.vault_id
		WHERE m.vault_id = $1::uuid
		  AND m.account_id = $2::uuid
		  AND m.accepted_at IS NOT NULL
		  AND m.revoked_at IS NULL
		LIMIT 1
	`, vaultID, accountID).Scan(&role, &archived)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		role = ""
	case err != nil:
		return "", err
	}
	// Archived kaata: only the OWNER retains sync access, so non-owner members
	// are cut off immediately ("archive = stop sharing") instead of keeping
	// access for the 30-day purge grace. Owner-exempt keeps the owner's reads /
	// restore / any push working. (Archive & unarchive themselves are owner-only
	// REST endpoints in the vaults package — requireOwner, setting/clearing
	// vaults.archived_at directly — so they never route through this gate.) No
	// membership row is revoked, so the M2 chain stays consistent. NOTE: this
	// role is cached for membershipCacheTTL, and Unarchive doesn't invalidate
	// that cache, so a non-owner's PUSH gate can lag ≤60s after unarchive —
	// self-healing, never data loss (reads use the uncached fresh path).
	//
	// The denial is a DISTINCT sentinel (not role=""): the caller must map it
	// to ErrVaultArchived / error_code "vault_archived", never "not_member" —
	// the client's not_member reaction is an irreversible local self-revoke.
	if archived && role != "owner" {
		role = roleArchivedDenied
	}
	s.membership.Add(key, membershipEntry{checkedAt: now, role: role})
	return role, nil
}

// checkMembershipFresh never caches — used by pull and snapshot read paths
// where revocation needs to land within a single request.
func (s *Service) checkMembershipFresh(ctx context.Context, accountID, vaultID string) error {
	var archived bool
	switch err := s.pool.QueryRow(ctx, `
		SELECT (archived_at IS NOT NULL) FROM vaults WHERE vault_id = $1::uuid
	`, vaultID).Scan(&archived); {
	case errors.Is(err, pgx.ErrNoRows):
		return ErrVaultNotFound
	case err != nil:
		return fmt.Errorf("membership: vault lookup: %w", err)
	}

	var role string
	switch err := s.pool.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid
		   AND account_id = $2::uuid
		   AND accepted_at IS NOT NULL
		   AND revoked_at IS NULL
		 LIMIT 1
	`, vaultID, accountID).Scan(&role); {
	case errors.Is(err, pgx.ErrNoRows):
		return ErrNotMember
	case err != nil:
		return fmt.Errorf("membership: member lookup: %w", err)
	}

	// Archived kaata: only the owner keeps read access (for restore/unarchive).
	// Non-owner members are denied — same cutoff the push gate applies, and
	// the same DISTINCT error: vault_archived tells the client to archive
	// locally; not_member would make it self-revoke its membership forever.
	if archived && role != "owner" {
		return ErrVaultArchived
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
	TargetID       *string         `json:"target_id"`
	RelationshipID *string         `json:"relationship_id"`
	EventType      string          `json:"event_type"`
	SchemaVersion  int             `json:"schema_version"`
	Payload        json.RawMessage `json:"payload"`
	// AuthorSeq is the per-device monotonic counter (sync v2 §5).
	// null on the wire for legacy rows pushed before M1.
	AuthorSeq *int64 `json:"author_seq"`
	// M2: author signature material, relayed verbatim so receiving
	// replicas can verify the membership chain (and, later, every event)
	// end-to-end. null for rows pushed by pre-M2 clients — keys are
	// always present on the wire, mirroring author_seq.
	EventSigB64        *string `json:"event_sig_b64"`
	SignerDevicePubkey *string `json:"signer_device_pubkey"`
	ServerSeq          int64   `json:"server_seq"`
	ServerReceivedAt   string  `json:"server_received_at"`
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
			author_seq,
			event_sig_b64,
			signer_device_pubkey,
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
			&ev.AuthorSeq,
			&ev.EventSigB64,
			&ev.SignerDevicePubkey,
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

// ==========================================================================
// VECTOR (sync v2 §5 — M1)
// ==========================================================================

// DeviceVector summarizes one authoring device's author_seq coverage on
// the server replica. Clients infer "provably complete from 1" as
// MinSeq == 1 && Count == MaxSeq.
type DeviceVector struct {
	MaxSeq int64 `json:"max_seq"`
	Count  int64 `json:"count"`
	MinSeq int64 `json:"min_seq"`
}

// VectorResult is the GET /v1/sync/vector response body.
type VectorResult struct {
	DeviceVectors      map[string]DeviceVector `json:"device_vectors"`
	VaultServerSeqHigh int64                   `json:"vault_server_seq_high"`
}

// DeviceVectors serves GET /v1/sync/vector. Same membership gating as
// pull (fresh check, no cache — revocation lands within one request).
//
// NOTE: this endpoint is ADVISORY in M1 — HTTPS clients keep their outbox
// as the source of truth for what still needs pushing; this summary just
// lets a relay ask "what is the server missing?" in one round trip. The
// LAN/BLE channels in M3/M4 are where strict vector-driven transfer takes
// over (the epoch-boundary problem is documented in
// docs/sync-v2-architecture.md §5).
func (s *Service) DeviceVectors(ctx context.Context, accountID, vaultID string) (*VectorResult, error) {
	if err := s.checkMembershipFresh(ctx, accountID, vaultID); err != nil {
		return nil, err
	}

	res := &VectorResult{DeviceVectors: make(map[string]DeviceVector)}

	// Single GROUP BY over the live (non-redacted) sequenced rows, keyed by
	// the AUTHOR device (hlc_device_id). §5 defines the vector per authoring
	// device; the pusher is irrelevant. device_id is equal by 007's CHECK,
	// but grouping on hlc_device_id keeps the author semantics explicit.
	// max/count/min only — gap enumeration is the client's job.
	rows, err := s.pool.Query(ctx, `
		SELECT hlc_device_id::text, MAX(author_seq), COUNT(*), MIN(author_seq)
		FROM events
		WHERE vault_id = $1::uuid
		  AND author_seq IS NOT NULL
		  AND redacted_at IS NULL
		GROUP BY hlc_device_id
	`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("device vectors: query: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var deviceID string
		var v DeviceVector
		if err := rows.Scan(&deviceID, &v.MaxSeq, &v.Count, &v.MinSeq); err != nil {
			return nil, fmt.Errorf("device vectors: scan: %w", err)
		}
		res.DeviceVectors[deviceID] = v
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("device vectors: rows: %w", err)
	}

	// Same semantics as PushResponse.VaultServerSeqHigh: the vault's
	// high-water server_seq including redacted rows (redaction preserves
	// the seq slot).
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) FROM events WHERE vault_id = $1::uuid
	`, vaultID).Scan(&res.VaultServerSeqHigh); err != nil {
		return nil, fmt.Errorf("device vectors: server_seq high: %w", err)
	}

	return res, nil
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
// begins with "<vaultID>|". Called after a push commits (and when an event
// whose presence changes account_bound attribution lands). The LRU has no
// prefix-scan, so we walk Keys() and Remove() in place.
//
// Takes pullMu so it serializes against an in-flight PullEvents cache-miss:
// without it, a pull that read the DB pre-commit could complete its
// pullCache.Add AFTER this invalidation runs, re-inserting the stale
// pre-commit page and starving the co-editor's tip for a full pullCacheTTL.
// Holding pullMu makes the invalidation wait for that Add, then remove it.
func (s *Service) invalidatePullCacheForVault(vaultID string) {
	s.pullMu.Lock()
	defer s.pullMu.Unlock()
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
