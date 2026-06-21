package vaults

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrVaultCollision means the requested vault_id already exists owned by
// a different account. Handler maps this to HTTP 409.
var ErrVaultCollision = errors.New("vault_id collides with vault owned by a different account")

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// CreateInput is what the handler passes in after JSON decoding.
//
// VaultID is CLIENT-MINTED. Mobile already has events in event_log
// referencing this UUID, so we accept and reuse rather than mint
// a server one.
type CreateInput struct {
	AccountID   string
	VaultID     string
	Name        string
	Currency    string
	CreatedAtMS int64
	// VaultTrustAnchorPubkey — Phase 7 local-CA. 32 raw bytes of an
	// Ed25519 public key, or nil for a server-anchored vault. Persisted
	// verbatim to vaults.vault_trust_anchor_pubkey. Phase 7+ clients
	// always send a value; Phase 5/6 clients omit it (the column stays
	// NULL).
	//
	// Immutable after creation: no PATCH /v1/vaults code path mutates
	// this column. Rotating the trust anchor requires creating a new
	// vault and re-importing events (deferred — see backlog "trust
	// anchor rotation").
	VaultTrustAnchorPubkey []byte
}

type CreateResult struct {
	VaultID string `json:"vault_id"`
}

// Create registers a client-minted vault server-side and seeds the
// owner row in vault_members.
//
// Idempotent retries: calling Create twice with the same (account_id,
// vault_id) is safe.
func (s *Service) Create(ctx context.Context, in CreateInput) (CreateResult, error) {
	if in.AccountID == "" {
		return CreateResult{}, errors.New("account_id is required")
	}
	if in.VaultID == "" {
		return CreateResult{}, errors.New("vault_id is required")
	}
	if in.Name == "" {
		return CreateResult{}, errors.New("name is required")
	}
	currency := in.Currency
	if currency == "" {
		currency = "AFN"
	}

	createdAt := time.Now()
	if in.CreatedAtMS > 0 {
		t := time.UnixMilli(in.CreatedAtMS)
		// Accept a client-stamped created_at as long as it's within a
		// sane window: not more than 5 minutes in the future (clock
		// skew tolerance) and not older than a year (junk data /
		// year-1970 sentinels). Outside the window, fall back to NOW.
		now := time.Now()
		lower := now.Add(-365 * 24 * time.Hour)
		upper := now.Add(5 * time.Minute)
		if t.After(lower) && t.Before(upper) {
			createdAt = t
		}
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return CreateResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Phase 7: include vault_trust_anchor_pubkey ($6). pgx encodes a nil
	// []byte as SQL NULL and a non-nil []byte as BYTEA, matching the
	// CHECK constraint (NULL or exactly 32 bytes) and our two semantic
	// modes. The ON CONFLICT DO UPDATE SET vault_id = vaults.vault_id
	// no-op preserves the original anchor on idempotent retries — we
	// deliberately do NOT update the column on conflict, because the
	// owner's first write is authoritative and a later retry from a
	// different device must never silently rotate the anchor.
	var existingOwner string
	err = tx.QueryRow(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, created_at, vault_trust_anchor_pubkey)
		VALUES ($1::uuid, $2::uuid, $3, $4, 0, $5, $6)
		ON CONFLICT (vault_id) DO UPDATE
		SET vault_id = vaults.vault_id
		RETURNING owner_account_id::text
	`, in.VaultID, in.AccountID, in.Name, currency, createdAt, in.VaultTrustAnchorPubkey).Scan(&existingOwner)
	if err != nil {
		return CreateResult{}, fmt.Errorf("insert vault: %w", err)
	}
	if existingOwner != in.AccountID {
		return CreateResult{}, ErrVaultCollision
	}

	// Seed owner membership row. Idempotent via partial unique index.
	if _, err := tx.Exec(ctx, `
		INSERT INTO vault_members (
			vault_id, account_id, role, invited_at, accepted_at, invited_by
		)
		SELECT $1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid
		WHERE NOT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid
			   AND revoked_at IS NULL
		)
	`, in.VaultID, in.AccountID); err != nil {
		return CreateResult{}, fmt.Errorf("insert vault membership: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, fmt.Errorf("commit tx: %w", err)
	}
	return CreateResult{VaultID: in.VaultID}, nil
}

// ===========================================================================
// Phase 4 — full vault management surface (MVP).
//
// Discipline used everywhere below:
//   1. Read-committed tx
//   2. SELECT FOR UPDATE the caller's membership row (locks the membership
//      grid for the duration; serializes against concurrent role/revoke
//      calls — no last-owner race).
//   3. Mutate vaults / vault_members.
//   4. Bump vaults.vault_epoch by 1 (every membership / settings / archive
//      change).
//   5. Append a row to vault_audit_log.
//   6. Commit.
//
// ACL philosophy: these endpoints judge CURRENT role only — by definition
// you're calling them right now, not replaying an 8h-old batch. The
// lawful-at-HLC rule lives in the sync package.
// ===========================================================================

// M4 (docs/m4-retire-vmc.md): the legacy MeshRevoker hook — which stamped
// revoked_at on the retired vault_credentials_issued ledger inside Leave /
// SetMemberRole / RevokeMember / TransferOwnership — is gone. Mesh revocation
// is now re-sourced from the membership-removal signal these same endpoints
// already write (vault_members.revoked_at) plus the chain's
// vault_devices.removed_at_ms fold; see mesh.GetRevocationsForVault. The
// endpoints below no longer need a separate per-account credential sweep.

// Phase 4 typed errors. Handler maps each to a specific HTTP status.
var (
	ErrNotFound            = errors.New("vault not found")
	ErrNotMember           = errors.New("caller is not a member of this vault")
	ErrNotOwner            = errors.New("owner role required")
	ErrLastOwner           = errors.New("cannot remove the last owner — transfer ownership first")
	ErrTargetNotMember     = errors.New("target account is not a member of this vault")
	ErrSelfTransfer        = errors.New("cannot transfer ownership to yourself")
	ErrAlreadyArchived     = errors.New("vault is already archived")
	ErrInvalidRole         = errors.New("role must be one of owner, editor, viewer")
	ErrInvalidDemote       = errors.New("demote_self_to must be one of editor, leave")
	ErrInvalidEmail        = errors.New("invite_email is required and must contain '@'")
	ErrInvitePending       = errors.New("a pending invitation for this email already exists")
	ErrInviteNotFound      = errors.New("invite not found, already accepted, revoked, or expired")
	ErrInviteRateLimited   = errors.New("too many accept attempts in the last hour")
	ErrInviteAutoRevoked   = errors.New("invite auto-revoked after too many attempts")
	ErrInviteEmailMismatch = errors.New("email does not match invitation")
	// Phase 4.1: unarchive + archive-purge error sentinels.
	ErrVaultPurged = errors.New("vault was permanently purged after the 30-day archive grace — cannot recover")
	ErrNotArchived = errors.New("vault is not archived")
)

const (
	inviteTTL = 7 * 24 * time.Hour
	// inviteSoftCap: caller is rate-limited (429 + ErrInviteRateLimited)
	// once cumulative attempts on the same token reach this threshold.
	// Renamed from inviteAttemptsPerHour — see the long comment in
	// AcceptInvite about why we no longer pretend this is per-hour.
	inviteSoftCap            = 5
	inviteLifetimeAttemptCap = 20
	inviteTokenBytes         = 32
)

// VaultListing is the shape returned by GET /v1/vaults.
type VaultListing struct {
	VaultID      string `json:"vault_id"`
	Name         string `json:"name"`
	Currency     string `json:"currency,omitempty"`
	Role         string `json:"role"`
	MembersCount int    `json:"members_count"`
	CreatedAtMS  int64  `json:"created_at_ms"`
	ArchivedAtMS *int64 `json:"archived_at_ms,omitempty"`
	VaultEpoch   int64  `json:"vault_epoch"`
	// VaultTrustAnchorPubkey — Phase 7 local-CA mesh trust anchor.
	//
	// base64-encoded 32-byte Ed25519 pubkey when the vault is locally
	// anchored, omitted entirely (omitempty + nil pointer) when the
	// vault is server-anchored. Mobile clients writing this column
	// into their local vaults table use it as the verifier key for
	// mesh handshake VMCs (see vmc.verifyVMC).
	//
	// *string instead of string + omitempty so the wire payload
	// distinguishes "field present, empty value" (impossible — the
	// 32-byte check rejects that) from "field absent" (server-anchored
	// vault, Phase 5 vault, or pre-migration row).
	VaultTrustAnchorPubkey *string `json:"vault_trust_anchor_pubkey,omitempty"`
}

func (s *Service) List(ctx context.Context, accountID string) ([]VaultListing, error) {
	if accountID == "" {
		return nil, errors.New("account_id is required")
	}
	rows, err := s.pool.Query(ctx, `
		SELECT v.vault_id::text,
		       v.name,
		       COALESCE(v.currency, ''),
		       vm.role,
		       (SELECT COUNT(*) FROM vault_members vm2
		         WHERE vm2.vault_id = v.vault_id
		           AND vm2.revoked_at IS NULL
		           AND vm2.accepted_at IS NOT NULL) AS members_count,
		       v.created_at,
		       v.archived_at,
		       v.vault_epoch,
		       v.vault_trust_anchor_pubkey
		  FROM vaults v
		  JOIN vault_members vm ON vm.vault_id = v.vault_id
		 WHERE vm.account_id = $1::uuid
		   AND vm.revoked_at IS NULL
		   AND vm.accepted_at IS NOT NULL
		 ORDER BY v.archived_at NULLS FIRST, v.created_at DESC
	`, accountID)
	if err != nil {
		return nil, fmt.Errorf("list vaults: %w", err)
	}
	defer rows.Close()

	out := make([]VaultListing, 0, 4)
	for rows.Next() {
		var (
			vl             VaultListing
			createdAt      time.Time
			archivedAt     *time.Time
			trustAnchorRaw []byte // nil for server-anchored vaults
		)
		if err := rows.Scan(
			&vl.VaultID, &vl.Name, &vl.Currency, &vl.Role,
			&vl.MembersCount, &createdAt, &archivedAt, &vl.VaultEpoch,
			&trustAnchorRaw,
		); err != nil {
			return nil, fmt.Errorf("scan vault row: %w", err)
		}
		vl.CreatedAtMS = createdAt.UnixMilli()
		if archivedAt != nil {
			ms := archivedAt.UnixMilli()
			vl.ArchivedAtMS = &ms
		}
		// Phase 7: surface the trust anchor when populated. Mobile and
		// server both use std base64 (44 chars, no padding stripped) so
		// the same decoder serves both directions.
		if len(trustAnchorRaw) == 32 {
			encoded := base64.StdEncoding.EncodeToString(trustAnchorRaw)
			vl.VaultTrustAnchorPubkey = &encoded
		}
		out = append(out, vl)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate vault rows: %w", err)
	}
	return out, nil
}

// UpdateInput carries the optional fields PATCH /v1/vaults/:vault_id can
// touch. Pointer fields distinguish "not present in body" from "present
// and empty".
type UpdateInput struct {
	AccountID string
	VaultID   string
	Name      *string
	Currency  *string
}

type UpdateResult struct {
	VaultID    string `json:"vault_id"`
	Name       string `json:"name"`
	Currency   string `json:"currency,omitempty"`
	VaultEpoch int64  `json:"vault_epoch"`
}

func (s *Service) Update(ctx context.Context, in UpdateInput) (UpdateResult, error) {
	if in.AccountID == "" || in.VaultID == "" {
		return UpdateResult{}, errors.New("account_id and vault_id are required")
	}
	if in.Name == nil && in.Currency == nil {
		return UpdateResult{}, errors.New("at least one of name or currency is required")
	}
	if in.Name != nil && *in.Name == "" {
		return UpdateResult{}, errors.New("name cannot be empty")
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return UpdateResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := requireOwner(ctx, tx, in.VaultID, in.AccountID); err != nil {
		return UpdateResult{}, err
	}

	var oldName, oldCurrency string
	if err := tx.QueryRow(ctx, `
		SELECT name, COALESCE(currency, '')
		  FROM vaults WHERE vault_id = $1::uuid
	`, in.VaultID).Scan(&oldName, &oldCurrency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return UpdateResult{}, ErrNotFound
		}
		return UpdateResult{}, fmt.Errorf("read vault: %w", err)
	}

	newName := oldName
	if in.Name != nil {
		newName = *in.Name
	}
	newCurrency := oldCurrency
	if in.Currency != nil {
		newCurrency = *in.Currency
	}

	var newEpoch int64
	if err := tx.QueryRow(ctx, `
		UPDATE vaults
		   SET name = $2, currency = $3, vault_epoch = vault_epoch + 1
		 WHERE vault_id = $1::uuid
		RETURNING vault_epoch
	`, in.VaultID, newName, newCurrency).Scan(&newEpoch); err != nil {
		return UpdateResult{}, fmt.Errorf("update vault: %w", err)
	}

	diff := map[string]any{}
	if in.Name != nil && *in.Name != oldName {
		diff["name"] = map[string]string{"from": oldName, "to": *in.Name}
	}
	if in.Currency != nil && *in.Currency != oldCurrency {
		diff["currency"] = map[string]string{"from": oldCurrency, "to": *in.Currency}
	}
	if _, err := writeAudit(ctx, tx, in.VaultID, &in.AccountID, "vault_settings_updated", nil, diff); err != nil {
		return UpdateResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return UpdateResult{}, fmt.Errorf("commit tx: %w", err)
	}
	return UpdateResult{
		VaultID:    in.VaultID,
		Name:       newName,
		Currency:   newCurrency,
		VaultEpoch: newEpoch,
	}, nil
}

// Archive soft-deletes a vault. Single-owner: immediate; multi-owner:
// requires unanimous concurrence (initiator + every other owner). Same
// owner calling again is a no-op.
type ArchiveResult struct {
	Status               string `json:"status"`
	VaultID              string `json:"vault_id"`
	VaultEpoch           int64  `json:"vault_epoch"`
	PendingConcurrences  int    `json:"pending_concurrences,omitempty"`
	RequiredConcurrences int    `json:"required_concurrences,omitempty"`
}

func (s *Service) Archive(ctx context.Context, vaultID, accountID string) (ArchiveResult, error) {
	if accountID == "" || vaultID == "" {
		return ArchiveResult{}, errors.New("account_id and vault_id are required")
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ArchiveResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := requireOwner(ctx, tx, vaultID, accountID); err != nil {
		return ArchiveResult{}, err
	}

	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT archived_at FROM vaults WHERE vault_id = $1::uuid FOR UPDATE
	`, vaultID).Scan(&archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ArchiveResult{}, ErrNotFound
		}
		return ArchiveResult{}, fmt.Errorf("read vault: %w", err)
	}
	if archivedAt != nil {
		return ArchiveResult{}, ErrAlreadyArchived
	}

	ownerCount, err := countActiveOwners(ctx, tx, vaultID)
	if err != nil {
		return ArchiveResult{}, err
	}

	if ownerCount == 1 {
		var newEpoch int64
		if err := tx.QueryRow(ctx, `
			UPDATE vaults
			   SET archived_at = NOW(),
			       vault_epoch = vault_epoch + 1
			 WHERE vault_id = $1::uuid
			RETURNING vault_epoch
		`, vaultID).Scan(&newEpoch); err != nil {
			return ArchiveResult{}, fmt.Errorf("archive vault: %w", err)
		}
		if _, err := writeAudit(ctx, tx, vaultID, &accountID, "vault_archived", nil, map[string]any{
			"mode": "single_owner",
		}); err != nil {
			return ArchiveResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return ArchiveResult{}, fmt.Errorf("commit tx: %w", err)
		}
		return ArchiveResult{Status: "archived", VaultID: vaultID, VaultEpoch: newEpoch}, nil
	}

	// Multi-owner: record this owner's concurrence and check if everyone has voted.
	if _, err := writeAudit(ctx, tx, vaultID, &accountID, "archive_concurred", nil, nil); err != nil {
		return ArchiveResult{}, err
	}

	concur, err := countArchiveConcurrences(ctx, tx, vaultID)
	if err != nil {
		return ArchiveResult{}, err
	}

	if concur >= ownerCount {
		var newEpoch int64
		if err := tx.QueryRow(ctx, `
			UPDATE vaults
			   SET archived_at = NOW(), vault_epoch = vault_epoch + 1
			 WHERE vault_id = $1::uuid
			RETURNING vault_epoch
		`, vaultID).Scan(&newEpoch); err != nil {
			return ArchiveResult{}, fmt.Errorf("finalize archive: %w", err)
		}
		if _, err := writeAudit(ctx, tx, vaultID, &accountID, "vault_archived", nil, map[string]any{
			"mode": "multi_owner", "concurrences": concur,
		}); err != nil {
			return ArchiveResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return ArchiveResult{}, fmt.Errorf("commit tx: %w", err)
		}
		return ArchiveResult{Status: "archived", VaultID: vaultID, VaultEpoch: newEpoch}, nil
	}

	var newEpoch int64
	if err := tx.QueryRow(ctx, `
		UPDATE vaults SET vault_epoch = vault_epoch + 1
		 WHERE vault_id = $1::uuid RETURNING vault_epoch
	`, vaultID).Scan(&newEpoch); err != nil {
		return ArchiveResult{}, fmt.Errorf("bump epoch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ArchiveResult{}, fmt.Errorf("commit tx: %w", err)
	}
	return ArchiveResult{
		Status: "pending", VaultID: vaultID, VaultEpoch: newEpoch,
		PendingConcurrences: concur, RequiredConcurrences: ownerCount,
	}, nil
}

// Unarchive lifts an archive within the 30-day grace window. Owner-only.
//
// Refuses with:
//   - ErrNotFound       — vault doesn't exist
//   - ErrNotOwner       — caller is not an owner
//   - ErrNotArchived    — vault is not currently archived (idempotency floor)
//   - ErrVaultPurged    — past the 30-day grace; events + snapshots are gone
//
// On success: clears archived_at, bumps vault_epoch, writes an audit row.
// Mobile observes the epoch bump on next pull and re-enables sync UI.
func (s *Service) Unarchive(ctx context.Context, vaultID, accountID string) (int64, error) {
	if accountID == "" || vaultID == "" {
		return 0, errors.New("account_id and vault_id are required")
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := requireOwner(ctx, tx, vaultID, accountID); err != nil {
		return 0, err
	}

	// Lock the vaults row and read archived_at + purged_at under the lock.
	// Reading both atomically rules out a race against the purge cron:
	// if the cron's tx commits between our requireOwner and this SELECT,
	// we will read purged_at != NULL and refuse with ErrVaultPurged.
	var archivedAt *time.Time
	var purgedAt *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT archived_at, purged_at
		  FROM vaults
		 WHERE vault_id = $1::uuid
		 FOR UPDATE
	`, vaultID).Scan(&archivedAt, &purgedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, fmt.Errorf("read vault: %w", err)
	}
	if purgedAt != nil {
		return 0, ErrVaultPurged
	}
	if archivedAt == nil {
		return 0, ErrNotArchived
	}
	// Defence in depth: if archived_at is older than the grace window
	// but the cron hasn't run yet, refuse the unarchive. Otherwise an
	// owner could "win the race" against the next cron tick and recover
	// a vault we have promised users we'd purge by day 30.
	if time.Since(*archivedAt) >= archiveGrace {
		return 0, ErrVaultPurged
	}

	var newEpoch int64
	if err := tx.QueryRow(ctx, `
		UPDATE vaults
		   SET archived_at = NULL,
		       vault_epoch = vault_epoch + 1
		 WHERE vault_id = $1::uuid
		RETURNING vault_epoch
	`, vaultID).Scan(&newEpoch); err != nil {
		return 0, fmt.Errorf("unarchive vault: %w", err)
	}

	// Audit. Multi-owner archives required unanimous concurrence; un-
	// archive is a single-owner action (any owner can pull the trigger).
	// The audit row records who reversed it.
	if _, err := writeAudit(ctx, tx, vaultID, &accountID, "vault_unarchived", nil, nil); err != nil {
		return 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit tx: %w", err)
	}
	return newEpoch, nil
}

// Leave removes the caller from a vault. Last-owner rejection.
func (s *Service) Leave(ctx context.Context, vaultID, accountID string) (int64, error) {
	if accountID == "" || vaultID == "" {
		return 0, errors.New("account_id and vault_id are required")
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	role, err := lockActiveMembership(ctx, tx, vaultID, accountID)
	if err != nil {
		return 0, err
	}

	if role == "owner" {
		ownerCount, err := countActiveOwners(ctx, tx, vaultID)
		if err != nil {
			return 0, err
		}
		if ownerCount <= 1 {
			return 0, ErrLastOwner
		}
	}

	// SEC FIX 4: stamp last_change_hlc_ms (wall-clock ms) so a stale chain
	// removal/role_changed cannot clobber this self-leave.
	if _, err := tx.Exec(ctx, `
		UPDATE vault_members
		   SET revoked_at = NOW(), revoked_by = $2::uuid,
		       revoked_reason = 'self_leave', updated_at = NOW(),
		       last_change_hlc_ms = GREATEST(COALESCE(last_change_hlc_ms, 0), $3)
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
	`, vaultID, accountID, nowMS()); err != nil {
		return 0, fmt.Errorf("revoke self: %w", err)
	}

	// M4: the leaver's revocation rides vault_members.revoked_at (set above)
	// + the emitted vault_member_removed event; mesh peers learn of it via the
	// re-sourced /v1/check-in revocations delta (mesh.GetRevocationsForVault).

	newEpoch, err := bumpEpoch(ctx, tx, vaultID)
	if err != nil {
		return 0, err
	}
	auditID, err := writeAudit(ctx, tx, vaultID, &accountID, "member_left", &accountID, map[string]any{
		"role_at_leave": role,
	})
	if err != nil {
		return 0, err
	}
	// Phase 4.1: server-emit vault_member_removed so peer devices learn
	// of this departure via /v1/sync/pull without needing the GET /v1/vaults
	// reconcile path.
	if err := emitVaultMemberEvents(ctx, tx, vaultID, accountID, auditID, []emitSpec{
		{
			EventType: "vault_member_removed",
			TargetID:  accountID,
			Payload:   map[string]any{"account_id": accountID},
		},
	}); err != nil {
		return 0, fmt.Errorf("emit vault_member_removed (self-leave): %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit tx: %w", err)
	}
	return newEpoch, nil
}

// TransferInput drives explicit ownership transfer.
type TransferInput struct {
	AccountID    string
	VaultID      string
	ToAccountID  string
	DemoteSelfTo string
}

func (s *Service) TransferOwnership(ctx context.Context, in TransferInput) (int64, error) {
	if in.AccountID == "" || in.VaultID == "" || in.ToAccountID == "" {
		return 0, errors.New("account_id, vault_id, and to_account_id are required")
	}
	if in.ToAccountID == in.AccountID {
		return 0, ErrSelfTransfer
	}
	if in.DemoteSelfTo != "editor" && in.DemoteSelfTo != "leave" {
		return 0, ErrInvalidDemote
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := requireOwner(ctx, tx, in.VaultID, in.AccountID); err != nil {
		return 0, err
	}

	var targetRole string
	if err := tx.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
		 FOR UPDATE
	`, in.VaultID, in.ToAccountID).Scan(&targetRole); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrTargetNotMember
		}
		return 0, fmt.Errorf("read target membership: %w", err)
	}

	// SEC FIX 4: stamp last_change_hlc_ms on every transfer mutation.
	if _, err := tx.Exec(ctx, `
		UPDATE vault_members SET role = 'owner', updated_at = NOW(),
		       last_change_hlc_ms = GREATEST(COALESCE(last_change_hlc_ms, 0), $3)
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
	`, in.VaultID, in.ToAccountID, nowMS()); err != nil {
		return 0, fmt.Errorf("promote target: %w", err)
	}
	// M4: role changes no longer invalidate a credential (the chain carries
	// roles directly via vault_member_role_changed). Only the demote-to-leave
	// branch below removes a member, and that revocation rides
	// vault_members.revoked_at + the emitted vault_member_removed event.

	switch in.DemoteSelfTo {
	case "editor":
		if _, err := tx.Exec(ctx, `
			UPDATE vault_members SET role = 'editor', updated_at = NOW(),
			       last_change_hlc_ms = GREATEST(COALESCE(last_change_hlc_ms, 0), $3)
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
		`, in.VaultID, in.AccountID, nowMS()); err != nil {
			return 0, fmt.Errorf("demote self: %w", err)
		}
	case "leave":
		if _, err := tx.Exec(ctx, `
			UPDATE vault_members SET revoked_at = NOW(), revoked_by = $2::uuid,
			       revoked_reason = 'ownership_transfer', updated_at = NOW(),
			       last_change_hlc_ms = GREATEST(COALESCE(last_change_hlc_ms, 0), $3)
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
		`, in.VaultID, in.AccountID, nowMS()); err != nil {
			return 0, fmt.Errorf("leave on transfer: %w", err)
		}
	}

	newEpoch, err := bumpEpoch(ctx, tx, in.VaultID)
	if err != nil {
		return 0, err
	}
	auditID, err := writeAudit(ctx, tx, in.VaultID, &in.AccountID, "ownership_transferred", &in.ToAccountID, map[string]any{
		"from": in.AccountID, "to": in.ToAccountID, "demote_self_to": in.DemoteSelfTo,
	})
	if err != nil {
		return 0, err
	}
	// Phase 4.1: server-emit. Two events, ordered promote-other first
	// (logical 0) and then demote/leave self (logical 1). This avoids
	// any mid-pull "ownerless" gap a slow replica might observe; see
	// design D-SERVER-EMIT-VAULT-EVENTS §2.
	specs := []emitSpec{
		{
			EventType: "vault_member_role_changed",
			TargetID:  in.ToAccountID,
			Payload:   map[string]any{"account_id": in.ToAccountID, "role": "owner"},
		},
	}
	switch in.DemoteSelfTo {
	case "editor":
		specs = append(specs, emitSpec{
			EventType: "vault_member_role_changed",
			TargetID:  in.AccountID,
			Payload:   map[string]any{"account_id": in.AccountID, "role": "editor"},
		})
	case "leave":
		specs = append(specs, emitSpec{
			EventType: "vault_member_removed",
			TargetID:  in.AccountID,
			Payload:   map[string]any{"account_id": in.AccountID},
		})
	}
	if err := emitVaultMemberEvents(ctx, tx, in.VaultID, in.AccountID, auditID, specs); err != nil {
		return 0, fmt.Errorf("emit transfer events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit tx: %w", err)
	}
	return newEpoch, nil
}

// SetMemberRole flips a member to owner / editor / viewer (owner-only).
func (s *Service) SetMemberRole(ctx context.Context, vaultID, callerID, targetID, newRole string) (int64, error) {
	if vaultID == "" || callerID == "" || targetID == "" {
		return 0, errors.New("vault_id, caller, and target are required")
	}
	if !isValidRole(newRole) {
		return 0, ErrInvalidRole
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := requireOwner(ctx, tx, vaultID, callerID); err != nil {
		return 0, err
	}

	var oldRole string
	if err := tx.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
		 FOR UPDATE
	`, vaultID, targetID).Scan(&oldRole); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrTargetNotMember
		}
		return 0, fmt.Errorf("read target role: %w", err)
	}

	if oldRole == newRole {
		var epoch int64
		if err := tx.QueryRow(ctx,
			`SELECT vault_epoch FROM vaults WHERE vault_id = $1::uuid`, vaultID).Scan(&epoch); err != nil {
			return 0, fmt.Errorf("read epoch: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return 0, fmt.Errorf("commit tx: %w", err)
		}
		return epoch, nil
	}

	if oldRole == "owner" && newRole != "owner" {
		ownerCount, err := countActiveOwners(ctx, tx, vaultID)
		if err != nil {
			return 0, err
		}
		if ownerCount <= 1 {
			return 0, ErrLastOwner
		}
	}

	// SEC FIX 4: stamp last_change_hlc_ms with the server wall-clock (ms) so
	// a stale chain vault_member_role_changed (whose HLC is genuinely older)
	// cannot later clobber this real-time owner action. The chain fold's
	// `>= last_change_hlc_ms` guard reads this stamp. We MAX() against any
	// existing stamp so an out-of-order legacy call can't move the clock
	// backward; a wall-clock NOW() is normally already the newest.
	if _, err := tx.Exec(ctx, `
		UPDATE vault_members
		   SET role = $3, updated_at = NOW(),
		       last_change_hlc_ms = GREATEST(COALESCE(last_change_hlc_ms, 0), $4)
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
	`, vaultID, targetID, newRole, nowMS()); err != nil {
		return 0, fmt.Errorf("update role: %w", err)
	}

	// M4: a role flip no longer invalidates a credential — there is no
	// credential. The chain carries the new role directly via the emitted
	// vault_member_role_changed event; peers re-derive role from it.

	newEpoch, err := bumpEpoch(ctx, tx, vaultID)
	if err != nil {
		return 0, err
	}
	auditID, err := writeAudit(ctx, tx, vaultID, &callerID, "role_changed", &targetID, map[string]any{
		"from": oldRole, "to": newRole,
	})
	if err != nil {
		return 0, err
	}
	if err := emitVaultMemberEvents(ctx, tx, vaultID, callerID, auditID, []emitSpec{
		{
			EventType: "vault_member_role_changed",
			TargetID:  targetID,
			Payload:   map[string]any{"account_id": targetID, "role": newRole},
		},
	}); err != nil {
		return 0, fmt.Errorf("emit vault_member_role_changed: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit tx: %w", err)
	}
	return newEpoch, nil
}

// RevokeMember (owner-only).
type RevokeInput struct {
	VaultID       string
	CallerID      string
	TargetID      string
	RevokedReason string
}

func (s *Service) RevokeMember(ctx context.Context, in RevokeInput) (int64, error) {
	if in.VaultID == "" || in.CallerID == "" || in.TargetID == "" {
		return 0, errors.New("vault_id, caller, and target are required")
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := requireOwner(ctx, tx, in.VaultID, in.CallerID); err != nil {
		return 0, err
	}

	var targetRole string
	if err := tx.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
		 FOR UPDATE
	`, in.VaultID, in.TargetID).Scan(&targetRole); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrTargetNotMember
		}
		return 0, fmt.Errorf("read target role: %w", err)
	}

	if targetRole == "owner" {
		ownerCount, err := countActiveOwners(ctx, tx, in.VaultID)
		if err != nil {
			return 0, err
		}
		if ownerCount <= 1 {
			return 0, ErrLastOwner
		}
	}

	reason := in.RevokedReason
	if reason == "" {
		reason = "owner_revoked"
	}

	// SEC FIX 4: stamp last_change_hlc_ms (wall-clock ms) so a stale chain
	// vault_member_removed/role_changed cannot clobber this real-time revoke.
	if _, err := tx.Exec(ctx, `
		UPDATE vault_members
		   SET revoked_at = NOW(), revoked_by = $3::uuid,
		       revoked_reason = $4, updated_at = NOW(),
		       last_change_hlc_ms = GREATEST(COALESCE(last_change_hlc_ms, 0), $5)
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL
	`, in.VaultID, in.TargetID, in.CallerID, reason, nowMS()); err != nil {
		return 0, fmt.Errorf("revoke member: %w", err)
	}

	// M4: the target's revocation rides vault_members.revoked_at (set above)
	// + the emitted vault_member_removed event. Mesh peers refuse handshake
	// once the re-sourced /v1/check-in revocations delta names the device;
	// no separate credential sweep is needed (credentials are retired).

	newEpoch, err := bumpEpoch(ctx, tx, in.VaultID)
	if err != nil {
		return 0, err
	}
	auditID, err := writeAudit(ctx, tx, in.VaultID, &in.CallerID, "member_revoked", &in.TargetID, map[string]any{
		"revoked_role": targetRole, "reason": reason,
	})
	if err != nil {
		return 0, err
	}
	if err := emitVaultMemberEvents(ctx, tx, in.VaultID, in.CallerID, auditID, []emitSpec{
		{
			EventType: "vault_member_removed",
			TargetID:  in.TargetID,
			Payload:   map[string]any{"account_id": in.TargetID},
		},
	}); err != nil {
		return 0, fmt.Errorf("emit vault_member_removed: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit tx: %w", err)
	}
	return newEpoch, nil
}

// AuditEntry is one row of vault_audit_log shaped for the wire.
type AuditEntry struct {
	ID         int64           `json:"id"`
	VaultID    string          `json:"vault_id"`
	ActorID    *string         `json:"actor_id,omitempty"`
	Kind       string          `json:"kind"`
	TargetID   *string         `json:"target_id,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	OccurredAt int64           `json:"occurred_at_ms"`
}

type AuditPage struct {
	Entries     []AuditEntry `json:"entries"`
	NextSinceID int64        `json:"next_since_id"`
	HasMore     bool         `json:"has_more"`
}

func (s *Service) AuditLog(ctx context.Context, vaultID, accountID string, sinceID int64, limit int) (AuditPage, error) {
	if vaultID == "" || accountID == "" {
		return AuditPage{}, errors.New("vault_id and account_id are required")
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	role, err := s.memberRole(ctx, vaultID, accountID)
	if err != nil {
		return AuditPage{}, err
	}
	if role == "viewer" {
		return AuditPage{}, ErrNotOwner
	}

	var rows pgx.Rows
	if role == "owner" {
		if sinceID > 0 {
			rows, err = s.pool.Query(ctx, `
				SELECT id, vault_id::text, actor_id::text, kind, target_id::text,
				       payload, occurred_at
				  FROM vault_audit_log
				 WHERE vault_id = $1::uuid AND id < $2
				 ORDER BY id DESC LIMIT $3
			`, vaultID, sinceID, limit+1)
		} else {
			rows, err = s.pool.Query(ctx, `
				SELECT id, vault_id::text, actor_id::text, kind, target_id::text,
				       payload, occurred_at
				  FROM vault_audit_log WHERE vault_id = $1::uuid
				 ORDER BY id DESC LIMIT $2
			`, vaultID, limit+1)
		}
	} else { // editor
		if sinceID > 0 {
			rows, err = s.pool.Query(ctx, `
				SELECT id, vault_id::text, actor_id::text, kind, target_id::text,
				       payload, occurred_at
				  FROM vault_audit_log
				 WHERE vault_id = $1::uuid
				   AND (actor_id = $2::uuid OR target_id = $2::uuid)
				   AND id < $3
				 ORDER BY id DESC LIMIT $4
			`, vaultID, accountID, sinceID, limit+1)
		} else {
			rows, err = s.pool.Query(ctx, `
				SELECT id, vault_id::text, actor_id::text, kind, target_id::text,
				       payload, occurred_at
				  FROM vault_audit_log
				 WHERE vault_id = $1::uuid
				   AND (actor_id = $2::uuid OR target_id = $2::uuid)
				 ORDER BY id DESC LIMIT $3
			`, vaultID, accountID, limit+1)
		}
	}
	if err != nil {
		return AuditPage{}, fmt.Errorf("query audit log: %w", err)
	}
	defer rows.Close()

	out := make([]AuditEntry, 0, limit)
	for rows.Next() {
		var (
			e          AuditEntry
			actor      *string
			target     *string
			payload    []byte
			occurredAt time.Time
		)
		if err := rows.Scan(&e.ID, &e.VaultID, &actor, &e.Kind, &target, &payload, &occurredAt); err != nil {
			return AuditPage{}, fmt.Errorf("scan audit row: %w", err)
		}
		e.ActorID = actor
		e.TargetID = target
		if len(payload) > 0 {
			e.Payload = json.RawMessage(payload)
		}
		e.OccurredAt = occurredAt.UnixMilli()
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return AuditPage{}, fmt.Errorf("iterate audit rows: %w", err)
	}

	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	var nextSince int64
	if len(out) > 0 {
		nextSince = out[len(out)-1].ID
	}
	return AuditPage{Entries: out, NextSinceID: nextSince, HasMore: hasMore}, nil
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

// NormalizeInviteEmail: trim, lowercase. For Gmail family addresses
// (gmail.com / googlemail.com): rewrite domain to gmail.com, strip dots
// from the local part, and drop everything after '+' in the local part.
// MUST match the SQL backfill in migration 006 line 64–73 byte-for-byte
// so accounts.email_normalized populated by that backfill compare equal
// to NormalizeInviteEmail(callerEmail) at accept-time.
//
// Security finding (SEC #5 / ENG #8): pre-fix, `googlemail.com` was kept
// as-is and `+tag` was preserved, so a fresh sign-in by a Gmail user with
// either of those forms would never match invitations addressed to their
// canonical form. The migration 006 SQL backfill (which Go did not match)
// is now the contract.
func NormalizeInviteEmail(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	at := strings.LastIndex(s, "@")
	if at < 0 {
		return s
	}
	local, domain := s[:at], s[at+1:]
	if domain == "gmail.com" || domain == "googlemail.com" {
		// Strip + suffix first, then dots. Matches migration 006:
		//   REPLACE(SPLIT_PART(LOWER(email), '+', 1), '.', '') || '@gmail.com'
		if plus := strings.IndexByte(local, '+'); plus >= 0 {
			local = local[:plus]
		}
		local = strings.ReplaceAll(local, ".", "")
		return local + "@gmail.com"
	}
	return s
}

type CreateInviteInput struct {
	VaultID      string
	InviterAccID string
	Email        string
	Role         string
}

type CreateInviteResult struct {
	InviteURL   string    `json:"invite_url"`
	InviteEmail string    `json:"invite_email"`
	ExpiresAt   time.Time `json:"expires_at"`
}

func (s *Service) CreateInvite(ctx context.Context, in CreateInviteInput) (CreateInviteResult, error) {
	if in.Role != "editor" && in.Role != "viewer" {
		return CreateInviteResult{}, ErrInvalidRole
	}
	normalized := NormalizeInviteEmail(in.Email)
	if normalized == "" || !strings.Contains(normalized, "@") {
		return CreateInviteResult{}, ErrInvalidEmail
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return CreateInviteResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := requireOwner(ctx, tx, in.VaultID, in.InviterAccID); err != nil {
		return CreateInviteResult{}, err
	}

	// Mint a 32-byte URL-safe token. We return the PLAINTEXT in the
	// response URL (one-time, to the inviter) and persist only the
	// SHA-256 hash. See hashInviteToken for the threat-model rationale.
	token, err := newInviteToken()
	if err != nil {
		return CreateInviteResult{}, fmt.Errorf("mint invite token: %w", err)
	}
	tokenHash := hashInviteToken(token)
	expiresAt := time.Now().Add(inviteTTL)

	_, err = tx.Exec(ctx, `
		INSERT INTO vault_members (
			vault_id, role, invited_by, invited_at,
			invite_email, invite_token_hash, invite_expires_at, invite_attempts
		) VALUES ($1::uuid, $2, $3::uuid, NOW(), $4, $5, $6, 0)
	`, in.VaultID, in.Role, in.InviterAccID, normalized, tokenHash, expiresAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return CreateInviteResult{}, ErrInvitePending
		}
		return CreateInviteResult{}, fmt.Errorf("insert invite: %w", err)
	}

	if _, err := writeAudit(ctx, tx, in.VaultID, &in.InviterAccID, "invite_issued", nil, map[string]any{
		"target_email": normalized, "role": in.Role,
	}); err != nil {
		return CreateInviteResult{}, err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE vaults SET vault_epoch = vault_epoch + 1 WHERE vault_id = $1::uuid
	`, in.VaultID); err != nil {
		return CreateInviteResult{}, fmt.Errorf("bump vault_epoch: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return CreateInviteResult{}, fmt.Errorf("commit tx: %w", err)
	}

	return CreateInviteResult{
		InviteURL:   "https://kaata.af/i/" + token,
		InviteEmail: normalized,
		ExpiresAt:   expiresAt,
	}, nil
}

type AcceptInviteInput struct {
	Token     string
	AccountID string
	InstallID string
}

type AcceptInviteResult struct {
	VaultID   string `json:"vault_id"`
	VaultName string `json:"vault_name"`
	Role      string `json:"role"`
}

func (s *Service) AcceptInvite(ctx context.Context, in AcceptInviteInput) (AcceptInviteResult, error) {
	if in.Token == "" || len(in.Token) > 512 {
		// Symmetric with InviteInfo's guard: never SHA-256 an oversized token.
		return AcceptInviteResult{}, ErrInviteNotFound
	}
	if in.AccountID == "" {
		return AcceptInviteResult{}, errors.New("account_id is required")
	}

	// Hash before touching the DB. The plaintext lives only in this
	// request scope; we never log it and never persist it.
	tokenHash := hashInviteToken(in.Token)

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return AcceptInviteResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		memberID    int64
		vaultID     string
		role        string
		inviteEmail string
		expiresAt   time.Time
		attempts    int
		acceptedAt  *time.Time
		revokedAt   *time.Time
		acceptedBy  *string
	)
	err = tx.QueryRow(ctx, `
		SELECT id, vault_id::text, role, invite_email,
		       invite_expires_at, invite_attempts, accepted_at, revoked_at,
		       account_id::text
		  FROM vault_members WHERE invite_token_hash = $1 FOR UPDATE
	`, tokenHash).Scan(&memberID, &vaultID, &role, &inviteEmail,
		&expiresAt, &attempts, &acceptedAt, &revokedAt, &acceptedBy)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return AcceptInviteResult{}, ErrInviteNotFound
	case err != nil:
		return AcceptInviteResult{}, fmt.Errorf("lookup invite: %w", err)
	}
	// Idempotent retry: a flaky mobile network can drop the RESPONSE of a
	// successful accept, so the client re-sends the same token. If THIS account
	// already accepted it, return success rather than "invite not found". A
	// DIFFERENT account still falls through to ErrInviteNotFound below, so we
	// never reveal that the token was consumed by someone else.
	if acceptedAt != nil && acceptedBy != nil && *acceptedBy == in.AccountID {
		var vaultName string
		if err := tx.QueryRow(ctx, `
			SELECT name FROM vaults WHERE vault_id = $1::uuid
		`, vaultID).Scan(&vaultName); err != nil {
			return AcceptInviteResult{}, fmt.Errorf("lookup vault name: %w", err)
		}
		return AcceptInviteResult{VaultID: vaultID, VaultName: vaultName, Role: role}, nil
	}
	if acceptedAt != nil || revokedAt != nil || time.Now().After(expiresAt) {
		return AcceptInviteResult{}, ErrInviteNotFound
	}

	// SECURITY (ENG #2 / SEC #3): the attempts counter is bumped only
	// AFTER the caller's email matches the invitation. Pre-fix, a
	// signed-in attacker holding a stolen-but-correctly-targeted token
	// could observe the boundary between "mismatch" and "rate-limited"
	// (5 hits) as confirmation that the token referred to a real,
	// outstanding invite. Worse, anyone holding the URL could grief
	// the legitimate invitee by burning 5 attempts before they ever
	// signed in. With this re-order:
	//   * mismatched callers never bump invite_attempts;
	//   * the soft cap and lifetime cap only count genuine accept
	//     attempts by the right-mailbox caller;
	//   * a token holder cannot probe its existence by attempts alone.
	// We keep ErrInviteEmailMismatch the same as ErrInviteNotFound at
	// the HTTP layer (see handler.go mapServiceError) so the attacker
	// also cannot distinguish "token unknown" from "token real, wrong
	// email" from outside.
	var callerEmail string
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(email_normalized, LOWER(email))
		  FROM accounts WHERE id = $1::uuid
	`, in.AccountID).Scan(&callerEmail)
	if err != nil {
		return AcceptInviteResult{}, fmt.Errorf("lookup caller email: %w", err)
	}
	if NormalizeInviteEmail(callerEmail) != inviteEmail {
		// Commit nothing (no attempts bump, no audit log) so the caller
		// cannot use the wrong-email arm to confirm the token is real.
		return AcceptInviteResult{}, ErrInviteEmailMismatch
	}

	newAttempts := attempts + 1
	if _, err := tx.Exec(ctx, `
		UPDATE vault_members SET invite_attempts = $1, updated_at = NOW() WHERE id = $2
	`, newAttempts, memberID); err != nil {
		return AcceptInviteResult{}, fmt.Errorf("bump attempts: %w", err)
	}

	if newAttempts > inviteLifetimeAttemptCap {
		if _, err := tx.Exec(ctx, `
			UPDATE vault_members SET revoked_at = NOW(),
			       revoked_reason = 'too_many_attempts', updated_at = NOW()
			 WHERE id = $1
		`, memberID); err != nil {
			return AcceptInviteResult{}, fmt.Errorf("auto-revoke: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return AcceptInviteResult{}, fmt.Errorf("commit auto-revoke: %w", err)
		}
		return AcceptInviteResult{}, ErrInviteAutoRevoked
	}
	if newAttempts >= inviteSoftCap {
		if err := tx.Commit(ctx); err != nil {
			return AcceptInviteResult{}, fmt.Errorf("commit rate-limit: %w", err)
		}
		return AcceptInviteResult{}, ErrInviteRateLimited
	}

	if _, err := tx.Exec(ctx, `
		UPDATE vault_members SET accepted_at = NOW(), account_id = $1::uuid,
		       updated_at = NOW() WHERE id = $2
	`, in.AccountID, memberID); err != nil {
		return AcceptInviteResult{}, fmt.Errorf("accept invite: %w", err)
	}

	var vaultName string
	if err := tx.QueryRow(ctx, `
		UPDATE vaults SET vault_epoch = vault_epoch + 1
		 WHERE vault_id = $1::uuid RETURNING name
	`, vaultID).Scan(&vaultName); err != nil {
		return AcceptInviteResult{}, fmt.Errorf("bump vault_epoch: %w", err)
	}

	auditID, err := writeAudit(ctx, tx, vaultID, nil, "invite_accepted", &in.AccountID, map[string]any{
		"role": role, "install_id": in.InstallID,
	})
	if err != nil {
		return AcceptInviteResult{}, err
	}

	// Phase 4.1: server-emit vault_member_added. The accepting account is
	// the actor; the audit log row's actor_id is intentionally NULL (the
	// audit-log convention treats the invitee as a passive target of the
	// invite system) but the EVENTS row's account_id is the accepting
	// account so projection on other devices can attribute the join.
	if err := emitVaultMemberEvents(ctx, tx, vaultID, in.AccountID, auditID, []emitSpec{
		{
			EventType: "vault_member_added",
			TargetID:  in.AccountID,
			Payload:   map[string]any{"account_id": in.AccountID, "role": role},
		},
	}); err != nil {
		return AcceptInviteResult{}, fmt.Errorf("emit vault_member_added: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return AcceptInviteResult{}, fmt.Errorf("commit accept: %w", err)
	}
	return AcceptInviteResult{VaultID: vaultID, VaultName: vaultName, Role: role}, nil
}

// PendingInvite intentionally omits the plaintext invite_token: after the
// Phase 4.1 hash migration the server only stores the hash, and the device
// already learned the plaintext via the inviter's share-link side channel.
// To accept, the device sends the token it stored locally in
// pending_invitations.invite_token.
type PendingInvite struct {
	VaultID      string    `json:"vault_id"`
	VaultName    string    `json:"vault_name"`
	InviterEmail string    `json:"inviter_email"`
	InviterName  string    `json:"inviter_name"`
	Role         string    `json:"role"`
	InvitedAt    time.Time `json:"invited_at"`
	ExpiresAt    time.Time `json:"expires_at"`
}

func (s *Service) ListPendingInvites(ctx context.Context, accountID string) ([]PendingInvite, error) {
	if accountID == "" {
		return nil, errors.New("account_id is required")
	}

	var rawNormalized string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(email_normalized, LOWER(email))
		  FROM accounts WHERE id = $1::uuid
	`, accountID).Scan(&rawNormalized)
	if err != nil {
		return nil, fmt.Errorf("lookup caller email: %w", err)
	}
	matchEmail := NormalizeInviteEmail(rawNormalized)

	rows, err := s.pool.Query(ctx, `
		SELECT vm.vault_id::text, v.name,
		       COALESCE(inviter.email, ''), COALESCE(inviter.name, ''),
		       vm.role, vm.invited_at, vm.invite_expires_at
		  FROM vault_members vm
		  JOIN vaults v ON v.vault_id = vm.vault_id
		  LEFT JOIN accounts inviter ON inviter.id = vm.invited_by
		 WHERE vm.invite_email = $1
		   AND vm.accepted_at IS NULL
		   AND vm.revoked_at IS NULL
		   AND vm.invite_expires_at > NOW()
		   AND vm.invite_token_hash IS NOT NULL
		 ORDER BY vm.invited_at DESC
	`, matchEmail)
	if err != nil {
		return nil, fmt.Errorf("list pending invites: %w", err)
	}
	defer rows.Close()

	out := make([]PendingInvite, 0, 4)
	for rows.Next() {
		var p PendingInvite
		if err := rows.Scan(
			&p.VaultID, &p.VaultName,
			&p.InviterEmail, &p.InviterName,
			&p.Role, &p.InvitedAt, &p.ExpiresAt,
		); err != nil {
			return nil, fmt.Errorf("scan pending invite: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows err: %w", err)
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Public invite info (kaata.af landing)
// ---------------------------------------------------------------------------

type InviteInfoResult struct {
	VaultName            string `json:"vault_name"`
	Role                 string `json:"role"`
	InviterEmailRedacted string `json:"inviter_email_redacted"`
	InviterName          string `json:"inviter_name"`
	ExpiresAt            string `json:"expires_at"`
}

func (s *Service) InviteInfo(ctx context.Context, token string) (InviteInfoResult, error) {
	token = strings.TrimSpace(token)
	// 512-char ceiling bounds CPU on sha256() for absurd inputs before
	// we touch the DB. Legitimate tokens base64url-encode 32 bytes
	// (~43 chars), so this is far above any honest caller.
	if token == "" || len(token) > 512 {
		return InviteInfoResult{}, ErrInviteNotFound
	}
	tokenHash := hashInviteToken(token)
	const q = `
		SELECT v.name, vm.role,
		       COALESCE(a.email, ''), COALESCE(a.name, ''),
		       vm.invite_expires_at
		  FROM vault_members vm
		  JOIN vaults v ON v.vault_id = vm.vault_id
		  LEFT JOIN accounts a ON a.id = vm.invited_by
		 WHERE vm.invite_token_hash = $1
		   AND vm.accepted_at IS NULL
		   AND vm.revoked_at IS NULL
		   AND vm.invite_expires_at IS NOT NULL
		   AND vm.invite_expires_at > NOW()
		   AND v.archived_at IS NULL
	`
	var (
		vaultName    string
		role         string
		inviterEmail string
		inviterName  string
		expiresAt    time.Time
	)
	err := s.pool.QueryRow(ctx, q, tokenHash).Scan(&vaultName, &role, &inviterEmail, &inviterName, &expiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return InviteInfoResult{}, ErrInviteNotFound
		}
		return InviteInfoResult{}, fmt.Errorf("query invite: %w", err)
	}
	return InviteInfoResult{
		VaultName:            vaultName,
		Role:                 role,
		InviterEmailRedacted: redactEmail(inviterEmail),
		InviterName:          inviterName,
		ExpiresAt:            expiresAt.UTC().Format(time.RFC3339),
	}, nil
}

func redactEmail(email string) string {
	email = strings.TrimSpace(email)
	if email == "" {
		return ""
	}
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return ""
	}
	local := email[:at]
	domain := email[at:]
	return string(local[0]) + "***" + domain
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

func requireOwner(ctx context.Context, tx pgx.Tx, vaultID, accountID string) error {
	var dummy string
	err := tx.QueryRow(ctx,
		`SELECT vault_id::text FROM vaults WHERE vault_id = $1::uuid`, vaultID).Scan(&dummy)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("read vault: %w", err)
	}

	var role string
	err = tx.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
		 FOR UPDATE
	`, vaultID, accountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotMember
	}
	if err != nil {
		return fmt.Errorf("read membership: %w", err)
	}
	if role != "owner" {
		return ErrNotOwner
	}
	return nil
}

func lockActiveMembership(ctx context.Context, tx pgx.Tx, vaultID, accountID string) (string, error) {
	var dummy string
	err := tx.QueryRow(ctx,
		`SELECT vault_id::text FROM vaults WHERE vault_id = $1::uuid`, vaultID).Scan(&dummy)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("read vault: %w", err)
	}

	var role string
	err = tx.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
		 FOR UPDATE
	`, vaultID, accountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotMember
	}
	if err != nil {
		return "", fmt.Errorf("read membership: %w", err)
	}
	return role, nil
}

func (s *Service) memberRole(ctx context.Context, vaultID, accountID string) (string, error) {
	var dummy string
	err := s.pool.QueryRow(ctx,
		`SELECT vault_id::text FROM vaults WHERE vault_id = $1::uuid`, vaultID).Scan(&dummy)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("read vault: %w", err)
	}

	var role string
	err = s.pool.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
	`, vaultID, accountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotMember
	}
	if err != nil {
		return "", fmt.Errorf("read membership: %w", err)
	}
	return role, nil
}

// countActiveOwners locks the entire active-owner row set of the vault
// FOR UPDATE in a deterministic order (id ASC) and returns the count
// observed under that lock.
//
// Concurrency fix (ENG #6): pre-fix, Leave / SetMemberRole / RevokeMember
// only held FOR UPDATE on the caller's own membership row. Two owners
// running Leave concurrently each saw "owner count = 2", each passed the
// `<= 1` last-owner gate, each revoked themselves → 0 owners. Same race
// in SetMemberRole demoting an owner and RevokeMember revoking another
// owner. Locking every active-owner row in a stable order — and doing it
// in the same tx before the count — serializes the three paths so the
// second tx blocks until the first commits, at which point its read sees
// the new count and the last-owner gate rejects correctly.
//
// Deadlock safety: every caller takes these locks in (id ASC) order
// after first locking their own membership row via requireOwner /
// lockActiveMembership. Because requireOwner / lockActiveMembership
// also take their lock with `account_id = ?` (single-row), and this
// helper then claims a superset that includes any owner row already
// locked, the second tx waits on a single row already locked by the
// first — classic single-resource ordering, no cycle possible.
func countActiveOwners(ctx context.Context, tx pgx.Tx, vaultID string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		WITH locked AS (
			SELECT id FROM vault_members
			 WHERE vault_id = $1::uuid AND role = 'owner'
			   AND revoked_at IS NULL AND accepted_at IS NOT NULL
			 ORDER BY id
			 FOR UPDATE
		)
		SELECT COUNT(*) FROM locked
	`, vaultID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count owners: %w", err)
	}
	return n, nil
}

// countArchiveConcurrences returns the number of distinct CURRENTLY-ACTIVE
// owners who have logged an archive_concurred row for this vault.
//
// ARCH FIX #2 / ENG #7: pre-fix the query trusted every actor_id that ever
// logged a concurrence. A would-be-archived owner who concurred and was
// later revoked still counted toward the threshold, so a malicious
// surviving owner could revoke their dissenting peers, log their own
// concurrence, and trip the unanimity gate with stale votes from
// already-revoked owners. We now intersect the concurrence actors with
// the current active-owner set on every count.
//
// (We also note: this counter is monotonic in the audit log only —
// re-voting by the same active owner is idempotent via DISTINCT, but the
// row IS appended. That's a cosmetic clutter, not a security bug.)
func countArchiveConcurrences(ctx context.Context, tx pgx.Tx, vaultID string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT COUNT(DISTINCT log.actor_id)
		  FROM vault_audit_log log
		  JOIN vault_members vm
		    ON vm.vault_id   = log.vault_id
		   AND vm.account_id = log.actor_id
		 WHERE log.vault_id  = $1::uuid
		   AND log.kind      = 'archive_concurred'
		   AND log.actor_id IS NOT NULL
		   AND vm.role        = 'owner'
		   AND vm.revoked_at  IS NULL
		   AND vm.accepted_at IS NOT NULL
	`, vaultID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count concurrences: %w", err)
	}
	return n, nil
}

// nowMS is the server wall-clock in milliseconds, used by SEC FIX 4 to
// stamp vault_members.last_change_hlc_ms on legacy membership mutations so
// the chain fold's HLC arbitration treats real-time owner actions as the
// newest change vs any genuinely-older chain event.
func nowMS() int64 {
	return time.Now().UnixMilli()
}

func bumpEpoch(ctx context.Context, tx pgx.Tx, vaultID string) (int64, error) {
	var epoch int64
	err := tx.QueryRow(ctx, `
		UPDATE vaults SET vault_epoch = vault_epoch + 1
		 WHERE vault_id = $1::uuid RETURNING vault_epoch
	`, vaultID).Scan(&epoch)
	if err != nil {
		return 0, fmt.Errorf("bump epoch: %w", err)
	}
	return epoch, nil
}

// writeAudit appends a vault_audit_log row. Payload marshalled to JSONB;
// errors propagate up so the tx rolls back rather than silently dropping
// the audit row.
//
// Returns the auto-generated row id (used by Phase 4.1 server-emit code
// paths as the idempotency anchor for the corresponding event_id). All
// callers that don't emit may pass _ as the first return value.
func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	vaultID string,
	actorID *string,
	kind string,
	targetID *string,
	payload map[string]any,
) (int64, error) {
	var payloadJSON []byte
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return 0, fmt.Errorf("marshal audit payload: %w", err)
		}
		payloadJSON = b
	}
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO vault_audit_log (vault_id, actor_id, kind, target_id, payload)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb)
		RETURNING id
	`, vaultID, actorID, kind, targetID, payloadJSON).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("insert audit: %w", err)
	}
	return id, nil
}

func isValidRole(role string) bool {
	switch role {
	case "owner", "editor", "viewer":
		return true
	}
	return false
}

func newInviteToken() (string, error) {
	buf := make([]byte, inviteTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// hashInviteToken returns the lowercase hex SHA-256 of the supplied
// plaintext invite token. We persist only this hash in
// vault_members.invite_token_hash; the plaintext is returned to the
// inviter exactly once (in the CreateInvite response URL) and lives on
// the invitee's device until they accept.
//
// THREAT-MODEL BOUNDARY
//   - The *device* (inviter, invitee) knows the plaintext token.
//   - The *server* DB only ever sees the hash at rest.
//   - The plaintext crosses the wire on three occasions only:
//     CreateInvite response (HTTPS, to the inviter),
//     GET /v1/vaults/invites/:token/info request (HTTPS, public),
//     POST /v1/vaults/invites/accept request body (HTTPS, authed).
//
// SHA-256 (not bcrypt/argon2) is deliberate: the input has ~256 bits of
// entropy (32 random bytes), so fast preimage / dictionary attack is
// not in scope. Length-extension is irrelevant — we never concatenate
// untrusted suffixes. Hex output matches the migration 008 backfill so
// CreateInvite rows and backfilled rows compare byte-for-byte.
func hashInviteToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
