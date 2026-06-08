package vaults

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ==========================================================================
// Phase 4.1: server-emit vault_member_* events.
//
// When AcceptInvite / SetMemberRole / RevokeMember / Leave /
// TransferOwnership succeed, the backend emits one or two
// vault_member_added / vault_member_role_changed / vault_member_removed
// events into the events table inside the SAME transaction as the
// membership mutation and the audit-log row. These events flow through
// GET /v1/sync/pull to all members' devices, where the Phase 4 mobile
// appliers reconcile vault_members_mirror.
//
// IDEMPOTENCY: event_id is a deterministic UUIDv5 derived from
// (ServerEmitNamespace, "<vault_id>|<audit_log_id>|<event_type>|<target_id>").
// Retries of the same audit row produce the same event_id and collapse
// via INSERT ... ON CONFLICT (event_id) DO NOTHING.
//
// ENG #3: We key on (event_type, target_id) instead of the spec's slice
// index. The TransferOwnership two-event emit produces two specs with
// distinct (event_type, target_id) pairs — promote-other targets the
// new owner, demote-self targets the previous owner. Keying on spec
// shape rather than slice position makes the event_id immune to future
// refactors that reorder specs. If the same (vault, audit_id,
// event_type, target_id) somehow recurs in one spec slice (shouldn't),
// the conflict-on-event_id INSERT collapses the second one to a duplicate.
//
// HLC: per-vault Lamport-pessimistic.
//   physical_ms = max(wall_clock, last_emitted_pms)
//   logical     = (physical_ms == last_emitted_pms ? last_emitted_logical+1 : 0)
// We persist (last_server_emit_hlc_physical_ms, last_server_emit_hlc_logical)
// on the vaults row. Since these emitters are always called inside a tx
// that locks the vault row, updating those columns is contention-free.
//
// SERVER_SEQ: per-vault, monotonically increasing. We re-lock the vaults
// row inside emitVaultMemberEvents (idempotent under the caller's lock)
// and read COALESCE(MAX(server_seq), 0) once.
//
// TransferOwnership emits TWO events. We order them PROMOTE-OTHER first
// (logical 0), DEMOTE-SELF second (logical 1). This avoids a mid-pull
// state where a replica observes the old owner demoted but no new owner
// promoted — that would flag the vault as ownerless. See design
// D-SERVER-EMIT-VAULT-EVENTS §2.
// ==========================================================================

// ServerEmitNamespace is the UUIDv5 namespace used to derive deterministic
// event_ids from vault_audit_log rows. Hard-coded so retries (a re-run of
// the same audit-log id within a tx that previously partially committed)
// produce the same event_id and collapse via ON CONFLICT (event_id) DO
// NOTHING on the events table.
//
// DO NOT CHANGE THIS VALUE — it would orphan all previously-emitted
// vault_member_* events from their idempotency anchor.
var ServerEmitNamespace = uuid.MustParse("a3c5b4f0-7d22-4f1e-9c1f-1d3a7b8e9f01")

// zeroDeviceUUID is the fallback hlc_device_id / device_id stamp when
// BACKEND_DEVICE_ID is unset. The zero UUID cannot be produced by
// uuid.NewRandom() or Crypto.randomUUID(), so it cannot collide with a
// real device id.
const zeroDeviceUUID = "00000000-0000-0000-0000-000000000000"

// backendDeviceID resolves the configured BACKEND_DEVICE_ID env var (or
// the zero-UUID fallback). Validated as a parseable UUID at call time so
// a typo surfaces as an event-emit error, not a silent wrong-id stamp.
func backendDeviceID() (string, error) {
	v := os.Getenv("BACKEND_DEVICE_ID")
	if v == "" {
		v = zeroDeviceUUID
	}
	if _, err := uuid.Parse(v); err != nil {
		return "", fmt.Errorf("BACKEND_DEVICE_ID is not a valid UUID: %w", err)
	}
	return v, nil
}

// emitSpec describes a single vault_member_* event to insert.
type emitSpec struct {
	EventType string         // "vault_member_added" | "vault_member_role_changed" | "vault_member_removed"
	TargetID  string         // account_id this event is about
	Payload   map[string]any // {account_id, role?}
}

// emitVaultMemberEvents inserts one or more vault_member_* events into
// the events table inside the caller's transaction.
//
// Caller responsibilities:
//   - tx is already in flight (we BEGIN nothing).
//   - audit_log_id is the BIGSERIAL id of the audit row this event mirrors.
//     event_id = uuidv5(namespace, "<vault_id>|<audit_id>|<event_type>|<target_id>")
//     so an idempotent retry of the whole tx produces the same event_id.
//     ENG #3: keying on (event_type, target_id) rather than slice index
//     keeps the id stable across future refactors of the specs slice.
//
// HLC ordering for multi-event emit (TransferOwnership):
//   - specs[0] gets logical = baseLogical
//   - specs[1] gets logical = baseLogical + 1
//   - all specs share physical_ms.
func emitVaultMemberEvents(
	ctx context.Context,
	tx pgx.Tx,
	vaultID string,
	actorAccountID string,
	auditLogID int64,
	specs []emitSpec,
) error {
	if len(specs) == 0 {
		return nil
	}

	deviceID, err := backendDeviceID()
	if err != nil {
		return err
	}

	// Re-lock the vaults row. Idempotent if caller already holds it.
	if _, err := tx.Exec(ctx, `
		SELECT 1 FROM vaults WHERE vault_id = $1::uuid FOR UPDATE
	`, vaultID); err != nil {
		return fmt.Errorf("lock vault row: %w", err)
	}

	// Read per-vault HLC emitter state.
	var lastPMS, lastLogical int64
	if err := tx.QueryRow(ctx, `
		SELECT last_server_emit_hlc_physical_ms, last_server_emit_hlc_logical
		  FROM vaults WHERE vault_id = $1::uuid
	`, vaultID).Scan(&lastPMS, &lastLogical); err != nil {
		return fmt.Errorf("read vault hlc state: %w", err)
	}

	// Lamport-pessimistic HLC.
	wall := time.Now().UnixMilli()
	var physMS, baseLogical int64
	if wall > lastPMS {
		physMS = wall
		baseLogical = 0
	} else {
		// Wall clock didn't advance (clock skew, sub-ms re-entry, multi-event burst).
		physMS = lastPMS
		baseLogical = lastLogical + 1
	}

	// Read current max server_seq once.
	var curSeq int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) FROM events WHERE vault_id = $1::uuid
	`, vaultID).Scan(&curSeq); err != nil {
		return fmt.Errorf("read current server_seq: %w", err)
	}

	for i, spec := range specs {
		eventLogical := baseLogical + int64(i)
		nextSeq := curSeq + 1

		// Deterministic event_id. The trailing (event_type, target_id)
		// disambiguates TransferOwnership's two events (both share the
		// same audit row id but target distinct accounts). ENG #3:
		// previously we keyed on the slice index `i`, which was fragile
		// to spec-ordering refactors. The (event_type, target_id) pair
		// is the canonical identifier of the spec's intent.
		seedName := fmt.Sprintf("%s|%d|%s|%s", vaultID, auditLogID, spec.EventType, spec.TargetID)
		eventID := uuid.NewSHA1(ServerEmitNamespace, []byte(seedName)).String()

		payloadJSON, err := json.Marshal(spec.Payload)
		if err != nil {
			return fmt.Errorf("marshal payload: %w", err)
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
				$4, 1,
				$5, $6, $7::uuid,
				$8::uuid, $9::uuid,
				$10::uuid, NULL,
				$11::jsonb, NOW()
			)
			ON CONFLICT (event_id) DO NOTHING
		`,
			eventID, vaultID, nextSeq,
			spec.EventType,
			physMS, eventLogical, deviceID,
			deviceID, actorAccountID,
			spec.TargetID,
			string(payloadJSON),
		)
		if err != nil {
			return fmt.Errorf("insert server-emitted event: %w", err)
		}

		if tag.RowsAffected() > 0 {
			curSeq = nextSeq
			// Notify the sync service so snapshot pending count climbs.
			if serverEmitSnapshotHook != nil {
				serverEmitSnapshotHook(vaultID)
			}
		}
	}

	// Persist the highest HLC we used. Even on full-duplicate emit (every
	// row collided) we still bump — the in-memory wall clock saw this HLC,
	// and the next emit must not re-use it.
	finalLogical := baseLogical + int64(len(specs)-1)
	if _, err := tx.Exec(ctx, `
		UPDATE vaults
		   SET last_server_emit_hlc_physical_ms = $2,
		       last_server_emit_hlc_logical     = $3
		 WHERE vault_id = $1::uuid
	`, vaultID, physMS, finalLogical); err != nil {
		return fmt.Errorf("update vault hlc state: %w", err)
	}

	return nil
}

// serverEmitSnapshotHook is wired at startup by main.go so emitted events
// increment the same per-vault pending-snapshot counter that PushEvents
// drives. Optional: tests leave it nil.
var serverEmitSnapshotHook func(vaultID string)

// SetServerEmitSnapshotHook wires the snapshot pending-counter increment.
// Called once from main.go after sync.Service is constructed.
func SetServerEmitSnapshotHook(fn func(vaultID string)) {
	serverEmitSnapshotHook = fn
}
