// Package mesh implements the server's remaining trust role in the M2
// membership chain: device-key registration (POST /v1/devices/register-key)
// and witness attestation (POST /v1/vaults/:vault_id/witness, witness.go).
// The server never participates in peer-to-peer transport — it only registers
// the per-device Ed25519 pubkeys two phones verify against and signs the
// narrow witness tuples the chain rules accept. See docs/m2-membership-chain.md
// and docs/m4-retire-vmc.md (the legacy VMC issuance + pair-token subsystem
// was retired in M4; the membership chain is now the sole trust system).
package mesh

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrDeviceKeyNotRegistered is returned by IssueWitness when the caller has
// not yet registered an Ed25519 public key. Handler maps to HTTP 412
// Precondition Failed so the client knows to call /v1/devices/register-key
// first and retry.
var ErrDeviceKeyNotRegistered = errors.New("device key not registered for install_id; call /v1/devices/register-key first")

// ErrNotMember is returned when the caller is not an active member of the
// requested vault. Handler maps to 403.
var ErrNotMember = errors.New("not a member of this vault")

// ErrSigningUnavailable is returned by every signing Service method when the
// server boots without MESH_SIGNING_PRIVKEY_PRIMARY. The rest of the
// backend keeps working; mesh routes return 503.
var ErrSigningUnavailable = errors.New("mesh signing key not configured on this server")

// Service registers device keys and mints membership-chain witnesses.
//
// signingPriv is the Ed25519 private key used to sign witness tuples. When
// nil (boot-time misconfig) the signing methods return ErrSigningUnavailable.
// The rest of the backend continues to serve normally — mesh just degrades to
// "server sync still works, peer-to-peer witness attestation disabled."
type Service struct {
	pool        *pgxpool.Pool
	signingPriv ed25519.PrivateKey
	// signingPubB64 is the base64-encoded public half corresponding to
	// signingPriv. Echoed on every /v1/check-in response so the mobile
	// client can pin it. Empty when signing is disabled.
	signingPubB64 string
	// rotationPubB64 is the optional rotation pubkey announced alongside
	// signingPubB64 during a key-rotation window. Empty by default.
	rotationPubB64 string
}

// NewService constructs a Service. Pass nil signingPriv to put the service
// in disabled mode (caller logs a critical warning at startup).
func NewService(pool *pgxpool.Pool, signingPriv ed25519.PrivateKey, signingPubB64, rotationPubB64 string) *Service {
	return &Service{
		pool:           pool,
		signingPriv:    signingPriv,
		signingPubB64:  signingPubB64,
		rotationPubB64: rotationPubB64,
	}
}

// SigningEnabled reports whether the service can sign witnesses. main.go uses
// this to log a startup warning when false.
func (s *Service) SigningEnabled() bool {
	return s.signingPriv != nil
}

// SigningPubkeyB64 returns the base64-encoded primary pubkey. Empty when
// signing is disabled.
func (s *Service) SigningPubkeyB64() string { return s.signingPubB64 }

// RotationPubkeyB64 returns the base64-encoded rotation pubkey or "" when
// no rotation is currently announced.
func (s *Service) RotationPubkeyB64() string { return s.rotationPubB64 }

// RegisterKey idempotently upserts the device's Ed25519 public key. Pubkey
// is exactly 32 bytes; non-32-byte input is rejected to avoid storing
// truncated/oversize keys that would fail ed25519.Verify at handshake time.
//
// We require an installs(install_id) row to exist before accepting the key.
// device_keys.install_id has an FK on installs, so an INSERT without a
// matching parent row would fail with a foreign-key violation; we surface
// a friendlier error so the client (which races sign-in against the first
// check-in) knows to retry after the next check-in.
func (s *Service) RegisterKey(ctx context.Context, installID string, pubkey []byte) error {
	if _, err := uuid.Parse(installID); err != nil {
		return fmt.Errorf("install_id must be a uuid: %w", err)
	}
	if len(pubkey) != ed25519.PublicKeySize {
		return fmt.Errorf("ed25519 pubkey must be %d bytes (got %d)", ed25519.PublicKeySize, len(pubkey))
	}

	tag, err := s.pool.Exec(ctx, `
		INSERT INTO device_keys (install_id, ed25519_pubkey, registered_at)
		SELECT $1::uuid, $2, NOW()
		WHERE EXISTS (SELECT 1 FROM installs WHERE install_id = $1::uuid)
		ON CONFLICT (install_id) DO UPDATE
		SET ed25519_pubkey = EXCLUDED.ed25519_pubkey,
		    registered_at  = NOW()
	`, installID, pubkey)
	if err != nil {
		return fmt.Errorf("upsert device key: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// The WHERE EXISTS gate prevented the insert because there is no
		// installs row yet. Return a typed error so the handler can map
		// to 409 / retry-after rather than 500.
		return errors.New("install not yet registered server-side; check-in first then retry")
	}
	return nil
}
