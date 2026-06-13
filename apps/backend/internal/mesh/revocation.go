package mesh

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Revocation is one entry in the wire-format revocation list returned to
// peers via /v1/check-in. device_id is the device whose membership has been
// invalidated; mesh peers refuse handshake with any peer whose device_id
// appears here.
type Revocation struct {
	VaultID     string `json:"vault_id"`
	DeviceID    string `json:"device_id"` // device_id (== install_id) of the revoked device
	RevokedAtMS int64  `json:"revoked_at_ms"`
}

// GetRevocationsForVault returns the (vault, device) revocations on vaultID
// whose effective revocation time is STRICTLY GREATER THAN sinceMs. The
// client passes the largest revoked_at_ms it has previously seen; the server
// returns everything newer.
//
// M4 re-sourcing (docs/m4-retire-vmc.md §3): revocation is no longer a view
// over the retired vault_credentials_issued ledger. A device is revoked iff a
// membership removal applies to it in the server's deterministic fold — the
// SAME operational tables the push/pull ACL is derived from. Two removal
// signals exist and they are NOT co-located on one table:
//
//   - DEVICE-LEVEL: vault_device_removed → the device's
//     vault_devices.removed_at_ms is set (HLC physical_ms of the removal
//     event). Only the chain fold (sync/membership.go) ever writes this.
//   - MEMBER-LEVEL: vault_member_removed → the account's seat is revoked. The
//     chain fold stamps BOTH vault_members.revoked_at AND every bound device's
//     vault_devices.removed_at_ms, but the Phase-4 server-side endpoints
//     (Leave / RevokeMember / TransferOwnership-leave) stamp ONLY
//     vault_members.revoked_at — they never touch vault_devices.
//
// THE REGRESSION THIS FIXES: a member can be revoked at the member level
// while having NO vault_devices row at all. Reachable precondition: a
// server-email-invited member (vaults.AcceptInvite inserts vault_members +
// emits vault_member_added but creates NO vault_devices row) whose
// vault_device_added chain event has not yet pushed/folded server-side. The
// ONLY writer of vault_devices is the chain fold of vault_device_added, so
// such a member's seat is live in vault_members yet absent from
// vault_devices. A query rooted "FROM vault_devices" would NEVER emit this
// removed member into the delta, and the mobile handshake's isRevoked()
// early-reject (fed by this delta) would keep letting them mesh. The old
// vault_credentials_issued set did report it (keyed on install_id), so the
// FROM-vault_devices rooting was a strict regression.
//
// Knowing a member's device_id(s) WITHOUT a vault_devices row: the device_id
// on the mesh wire IS the install_id (mobile presents getInstallIdSync() as
// device_id; vault_devices.device_id and the witness device tuple both use
// install_id). The server links account → installs via installs.account_id,
// and a real mesh device is one with a registered key in device_keys
// (keyed by install_id). So an account's revocable devices are:
//
//	(a) every vault_devices row for that account in the vault, AND
//	(b) every installs.install_id for that account that has a device_keys row.
//
// (b) is what recovers the no-vault_devices-row case; its install_id is the
// exact identifier mobile isRevoked(vault_id, device_id) matches against.
//
// The set below is a UNION of:
//
//	(1) DEVICE-LEVEL — every vault_devices row in the vault with
//	    removed_at_ms IS NOT NULL, at removed_at_ms.
//	(2) MEMBER-LEVEL — for every account revoked in vault_members
//	    (revoked_at NOT NULL), ALL that account's known devices from BOTH
//	    vault_devices (account-keyed) AND installs⋈device_keys
//	    (account-keyed), at the member's revoked_at (in ms).
//
// Per (vault, device_id) we take MIN across both branches: a device becomes
// untrusted at the FIRST removal that names it (or its account), so MIN is
// the correct effective instant and keeps the per-vault cursor monotonic
// across both removal paths. We emit a row whenever at least one signal fires.
//
// Equivalence to the old vault_credentials_issued-sourced set: that set
// listed a device's install_id with revoked_at = NOW() the moment its member
// or device was removed. This UNION lists the same device_id (== install_id)
// the moment the same removal applies, with the removal's timestamp —
// covering the chain path (vault_devices fold), the Phase-4 path
// (vault_members revoke with a device row), AND the no-device-row Phase-4
// path (vault_members revoke resolved through installs⋈device_keys), which
// the old install_id-keyed ledger also covered and the FROM-vault_devices
// query had dropped. (Role-change-driven revocations are intentionally NOT
// re-sourced: in M4 the chain carries roles directly via
// vault_member_role_changed, so a role flip no longer invalidates a
// credential — there is no credential.)
//
// Caller authority: this MUST be gated on the caller being a current active
// member of the vault — leaking revocation timestamps from a vault the caller
// doesn't belong to would be a privacy leak. The check-in extension enforces
// this (IsMember) before calling.
func (s *Service) GetRevocationsForVault(
	ctx context.Context,
	vaultID string,
	sinceMs int64,
) ([]Revocation, error) {
	if _, err := uuid.Parse(vaultID); err != nil {
		return nil, fmt.Errorf("vault_id must be a uuid: %w", err)
	}

	// UNION of the device-level and member-level removal signals, taking
	// MIN(revoked_ms) per (vault, device_id) so the earliest applicable
	// removal wins (monotonic cursor). The member-level branch resolves an
	// account's devices through BOTH vault_devices (account-keyed) AND
	// installs⋈device_keys (account-keyed) so a member with NO vault_devices
	// row — the regression case — is still emitted by its install_id, which
	// is the device_id the mobile handshake presents and isRevoked() matches.
	rows, err := s.pool.Query(ctx, `
		WITH device_level AS (
		    -- (1) DEVICE-LEVEL: this device's own removal.
		    SELECT vd.device_id::text AS device_id, vd.removed_at_ms AS revoked_ms
		      FROM vault_devices vd
		     WHERE vd.vault_id = $1::uuid
		       AND vd.removed_at_ms IS NOT NULL
		),
		revoked_members AS (
		    -- Accounts whose seat is revoked, with the member-level instant
		    -- (vault_members.revoked_at) expressed in ms.
		    SELECT vm.account_id,
		           (EXTRACT(EPOCH FROM vm.revoked_at) * 1000)::bigint AS revoked_ms
		      FROM vault_members vm
		     WHERE vm.vault_id = $1::uuid
		       AND vm.account_id IS NOT NULL
		       AND vm.revoked_at IS NOT NULL
		),
		member_level AS (
		    -- (2a) MEMBER-LEVEL via a known vault_devices row for the account.
		    SELECT vd.device_id::text AS device_id, rm.revoked_ms
		      FROM revoked_members rm
		      JOIN vault_devices vd
		        ON vd.vault_id = $1::uuid
		       AND vd.account_id = rm.account_id
		    UNION ALL
		    -- (2b) MEMBER-LEVEL via the account's installs that registered a
		    -- mesh device key — recovers the no-vault_devices-row case. The
		    -- install_id is the device_id the mobile client presents.
		    SELECT i.install_id::text AS device_id, rm.revoked_ms
		      FROM revoked_members rm
		      JOIN installs i
		        ON i.account_id = rm.account_id
		      JOIN device_keys dk
		        ON dk.install_id = i.install_id
		),
		all_signals AS (
		    SELECT device_id, revoked_ms FROM device_level
		    UNION ALL
		    SELECT device_id, revoked_ms FROM member_level
		)
		SELECT device_id, MIN(revoked_ms) AS revoked_ms
		  FROM all_signals
		 GROUP BY device_id
		HAVING MIN(revoked_ms) > $2
		 ORDER BY revoked_ms ASC
	`, vaultID, sinceMs)
	if err != nil {
		return nil, fmt.Errorf("query revocations: %w", err)
	}
	defer rows.Close()

	out := make([]Revocation, 0, 8)
	for rows.Next() {
		var (
			deviceID    string
			revokedAtMS int64
		)
		if err := rows.Scan(&deviceID, &revokedAtMS); err != nil {
			return nil, fmt.Errorf("scan revocation row: %w", err)
		}
		out = append(out, Revocation{
			VaultID:     vaultID,
			DeviceID:    deviceID,
			RevokedAtMS: revokedAtMS,
		})
	}
	return out, rows.Err()
}

// IsMember reports whether the caller is a currently active member of
// the vault. Used by the check-in path before disclosing revocation
// entries.
func (s *Service) IsMember(ctx context.Context, vaultID, accountID string) (bool, error) {
	if _, err := uuid.Parse(vaultID); err != nil {
		return false, fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(accountID); err != nil {
		return false, fmt.Errorf("account_id must be a uuid: %w", err)
	}
	var one int
	err := s.pool.QueryRow(ctx, `
		SELECT 1 FROM vault_members
		 WHERE vault_id   = $1::uuid
		   AND account_id = $2::uuid
		   AND revoked_at IS NULL
		   AND accepted_at IS NOT NULL
		 LIMIT 1
	`, vaultID, accountID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check membership: %w", err)
	}
	return true, nil
}
