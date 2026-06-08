// Package mesh implements Phase 5 vault membership credential (VMC) issuance,
// device-key registration, and revocation bookkeeping. The server never
// participates in peer-to-peer transport — it ONLY mints the signed proofs
// that two phones use to convince each other they are on the same vault and
// hold the role they claim. See docs/sync-implementation-plan.md §Phase 5.
package mesh

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PairTokenLifetimeMax is the maximum server-accepted TTL for a same-account
// QR pair token. Matches the mobile-side PAIR_QR_TTL_MS exactly (5 minutes)
// so the server window does not extend past what the client UI tells the
// owner the code is valid for. The 60-second skew tolerance applied in
// ConsumePairToken provides the only slack — covering benign clock drift,
// not a deliberately longer window.
const PairTokenLifetimeMax = 5 * time.Minute

// ErrPairTokenInvalid means the supplied token doesn't match a row, is
// expired, or has already been consumed. Handler maps to 403.
var ErrPairTokenInvalid = errors.New("pair token invalid, expired, or already consumed")

// ErrPairTokenVaultMismatch means the token resolves to a different vault
// than the URL claims. Handler maps to 403.
var ErrPairTokenVaultMismatch = errors.New("pair token vault_id does not match request vault_id")

// ErrPairTokenIssuedAtTooOld means the token's issued_at_ms (as supplied
// by the QR payload) is older than PairTokenLifetimeMax. The server uses
// its OWN clock for this check so a scanner whose device clock was rolled
// back cannot bypass the 5-minute window. Handler maps to 403.
var ErrPairTokenIssuedAtTooOld = errors.New("pair token issued_at is outside the server-side validity window")

// VMCLifetime is the validity window for an issued VMC. 60 days is the
// founder-decided default: long enough that a phone offline for a vacation
// still mesh-syncs on return; short enough that key-rotation + revocation
// converge within two months. Refresh happens opportunistically on
// /v1/check-in (mesh package side) and explicitly via POST
// /v1/vaults/:vault_id/credential.
const VMCLifetime = 60 * 24 * time.Hour

// VMCWireVersion is the wire-format version stamped into every VMC. Bump
// only on breaking format changes; mesh handshake refuses unknown versions.
const VMCWireVersion = 1

// VMCIssuer is the iss field stamped into every VMC. Pinned in mesh handshake
// to defeat cross-issuer confusion if we ever ship a sibling backend that
// shares the same Ed25519 keypair (we will not, but defense in depth).
const VMCIssuer = "kaata-mesh-v1"

// ErrDeviceKeyNotRegistered is returned by IssueVMC when the caller has not
// yet registered an Ed25519 public key. Handler maps to HTTP 412
// Precondition Failed so the client knows to call /v1/devices/register-key
// first and retry.
var ErrDeviceKeyNotRegistered = errors.New("device key not registered for install_id; call /v1/devices/register-key first")

// ErrNotMember is returned when the caller is not an active member of the
// requested vault. Handler maps to 403.
var ErrNotMember = errors.New("not a member of this vault")

// ErrSigningUnavailable is returned by every Service method when the
// server boots without MESH_SIGNING_PRIVKEY_PRIMARY. The rest of the
// backend keeps working; mesh routes return 503.
var ErrSigningUnavailable = errors.New("mesh signing key not configured on this server")

// Service mints and tracks vault membership credentials.
//
// signingPriv is the Ed25519 private key used to sign VMC blobs. When nil
// (boot-time misconfig) every method returns ErrSigningUnavailable. The
// rest of the backend continues to serve normally — mesh just degrades to
// "server sync still works, peer-to-peer sync disabled."
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

// SigningEnabled reports whether the service can issue VMCs. main.go uses
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

// IssuedVMC carries the wire blob + bookkeeping back to the caller.
type IssuedVMC struct {
	VMCBlob   string    `json:"vmc_blob"`
	ExpiresAt time.Time `json:"expires_at"`
}

// IssueVMC mints a signed credential for (vault, account, install) at the
// caller's CURRENT role and the vault's CURRENT epoch. Wire format:
//
//	base64(canonical_json) + "." + base64(ed25519_signature)
//
// canonical_json sorts keys to make signature verification deterministic
// regardless of map iteration order in Go or the mesh peer's runtime.
//
// Caller's authority: this function does NOT check whether the caller is
// allowed to act on behalf of (vault, account, install) — the handler
// enforces that the JWT's account_id matches and the install_id comes
// from the JWT claim, not request body. IssueVMC is reusable from the
// /v1/check-in renewal path, which uses the same JWT.
func (s *Service) IssueVMC(
	ctx context.Context,
	vaultID, accountID, installID string,
) (IssuedVMC, error) {
	if s.signingPriv == nil {
		return IssuedVMC{}, ErrSigningUnavailable
	}
	if _, err := uuid.Parse(vaultID); err != nil {
		return IssuedVMC{}, fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(accountID); err != nil {
		return IssuedVMC{}, fmt.Errorf("account_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(installID); err != nil {
		return IssuedVMC{}, fmt.Errorf("install_id must be a uuid: %w", err)
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return IssuedVMC{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Look up device pubkey. Refusing here is critical — without binding
	// the credential to a known pubkey, a stolen VMC blob would be usable
	// by any device with the right install_id, which the network cannot
	// authenticate.
	var pubkey []byte
	err = tx.QueryRow(ctx, `
		SELECT ed25519_pubkey FROM device_keys WHERE install_id = $1::uuid
	`, installID).Scan(&pubkey)
	if errors.Is(err, pgx.ErrNoRows) {
		return IssuedVMC{}, ErrDeviceKeyNotRegistered
	}
	if err != nil {
		return IssuedVMC{}, fmt.Errorf("read device key: %w", err)
	}
	if len(pubkey) != ed25519.PublicKeySize {
		return IssuedVMC{}, fmt.Errorf("stored device key has wrong length %d", len(pubkey))
	}

	// Snapshot CURRENT role + vault_epoch under a row lock. Without
	// FOR UPDATE on the vault row, a concurrent SetMemberRole could
	// bump the epoch between our role-read and our epoch-read, and we
	// would mint a VMC with mismatched (role, epoch). The bumped epoch
	// would later cause the VMC to fail handshake unnecessarily.
	if _, err := tx.Exec(ctx, `
		SELECT 1 FROM vaults WHERE vault_id = $1::uuid FOR UPDATE
	`, vaultID); err != nil {
		return IssuedVMC{}, fmt.Errorf("lock vault row: %w", err)
	}

	var role string
	err = tx.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
	`, vaultID, accountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return IssuedVMC{}, ErrNotMember
	}
	if err != nil {
		return IssuedVMC{}, fmt.Errorf("read membership: %w", err)
	}

	var vaultEpoch int64
	if err := tx.QueryRow(ctx, `
		SELECT vault_epoch FROM vaults WHERE vault_id = $1::uuid
	`, vaultID).Scan(&vaultEpoch); err != nil {
		return IssuedVMC{}, fmt.Errorf("read vault epoch: %w", err)
	}

	now := time.Now()
	expires := now.Add(VMCLifetime)

	// Build canonical JSON. Field names must match the mesh client's
	// verification path exactly. Sorted-key encoding is required for
	// signature reproducibility on the peer side.
	body := map[string]any{
		"v":             VMCWireVersion,
		"vault_id":      vaultID,
		"account_id":    accountID,
		"device_id":     installID,
		"device_pubkey": base64.StdEncoding.EncodeToString(pubkey),
		"role":          role,
		"vault_epoch":   vaultEpoch,
		"issued_at_ms":  now.UnixMilli(),
		"expires_at_ms": expires.UnixMilli(),
		"iss":           VMCIssuer,
	}
	canonical, err := canonicalJSON(body)
	if err != nil {
		return IssuedVMC{}, fmt.Errorf("canonicalize vmc body: %w", err)
	}

	sig := ed25519.Sign(s.signingPriv, canonical)
	blob := base64.StdEncoding.EncodeToString(canonical) + "." + base64.StdEncoding.EncodeToString(sig)

	// Record the issuance. We always insert a new row — multiple
	// renewals of the same (vault, install) leave a trail in
	// vault_credentials_issued; older rows are not deleted because
	// revocation can target a SPECIFIC issuance for forensics.
	if _, err := tx.Exec(ctx, `
		INSERT INTO vault_credentials_issued
			(vault_id, account_id, install_id, role, vault_epoch, issued_at, expires_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
	`, vaultID, accountID, installID, role, vaultEpoch, now, expires); err != nil {
		return IssuedVMC{}, fmt.Errorf("insert issued vmc: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return IssuedVMC{}, fmt.Errorf("commit tx: %w", err)
	}

	return IssuedVMC{VMCBlob: blob, ExpiresAt: expires}, nil
}

// canonicalJSON serialises a map with sorted top-level keys and no
// surrounding whitespace. Required so the peer that VERIFIES the
// signature can rebuild the byte-for-byte identical input regardless of
// its language's default map iteration order.
//
// We do NOT support nested objects with ordering requirements — the VMC
// body is flat. If we ever add nested objects, extend this function to
// recurse.
func canonicalJSON(body map[string]any) ([]byte, error) {
	keys := make([]string, 0, len(body))
	for k := range body {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := []byte{'{'}
	for i, k := range keys {
		if i > 0 {
			out = append(out, ',')
		}
		kb, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		out = append(out, kb...)
		out = append(out, ':')
		vb, err := json.Marshal(body[k])
		if err != nil {
			return nil, err
		}
		out = append(out, vb...)
	}
	out = append(out, '}')
	return out, nil
}

// IssuedVMCForVault is the per-vault wire entry used by the /v1/check-in
// extension. Identical to IssuedVMC but tagged with the vault_id so the
// mobile client can dispatch to the right cache row without scanning the
// blob.
type IssuedVMCForVault struct {
	VaultID     string `json:"vault_id"`
	VMCBlob     string `json:"vmc_blob"`
	ExpiresAtMS int64  `json:"expires_at_ms"`
}

// hashPairToken returns sha256(plaintext) — the plaintext never persists.
func hashPairToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// PromotePairTokenMembership idempotently creates a vault_members row for
// (vaultID, accountID) so the just-consumed pair-token caller is, going
// forward, a regular member of the vault. Re-runs are no-ops.
//
// Role is hard-coded to 'editor': a same-account second device should be
// able to write, but doesn't need the privilege to revoke other members
// or transfer ownership. Owners can promote it manually later if they
// want. (The two devices share an account; either device can still mint
// further pair tokens because the owner role still belongs to the
// account itself, not the install — but only THIS install's VMC carries
// the editor role on the wire.)
func (s *Service) PromotePairTokenMembership(
	ctx context.Context,
	vaultID, accountID, installID string,
) error {
	if _, err := uuid.Parse(vaultID); err != nil {
		return fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(accountID); err != nil {
		return fmt.Errorf("account_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(installID); err != nil {
		return fmt.Errorf("install_id must be a uuid: %w", err)
	}

	// Same-account joins via QR yield an editor seat unless an active
	// (not-revoked) row already exists, in which case we leave it alone.
	// The active-uniqueness partial index (idx_vault_members_active_unique)
	// means we cannot use ON CONFLICT — we mirror the WHERE-NOT-EXISTS
	// pattern used by vault creation in vaults/service.go.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO vault_members
			(vault_id, account_id, role, invited_at, accepted_at)
		SELECT $1::uuid, $2::uuid, 'editor', NOW(), NOW()
		WHERE NOT EXISTS (
			SELECT 1 FROM vault_members
			 WHERE vault_id = $1::uuid AND account_id = $2::uuid
			   AND revoked_at IS NULL
		)
	`, vaultID, accountID); err != nil {
		return fmt.Errorf("promote pair-token membership: %w", err)
	}
	_ = installID // currently informational; emit a future audit hook if needed.
	return nil
}

// RegisterPairToken stores a single-use ticket for the owner-side QR
// pairing flow. The handler validates the JWT belongs to the same
// account_id that's being committed as issuer, then calls this.
//
// If expiresAtMS is more than PairTokenLifetimeMax in the future, the
// stored row is clamped to NOW() + PairTokenLifetimeMax. A caller-supplied
// expires_at earlier than NOW() yields ErrPairTokenInvalid (we don't store
// already-expired tokens).
func (s *Service) RegisterPairToken(
	ctx context.Context,
	token, vaultID, accountID, installID string,
	expiresAtMS int64,
) error {
	if token == "" {
		return ErrPairTokenInvalid
	}
	if _, err := uuid.Parse(vaultID); err != nil {
		return fmt.Errorf("vault_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(accountID); err != nil {
		return fmt.Errorf("account_id must be a uuid: %w", err)
	}
	if _, err := uuid.Parse(installID); err != nil {
		return fmt.Errorf("install_id must be a uuid: %w", err)
	}

	now := time.Now()
	expires := time.UnixMilli(expiresAtMS)
	if expires.Before(now) {
		return ErrPairTokenInvalid
	}
	maxExpires := now.Add(PairTokenLifetimeMax)
	if expires.After(maxExpires) {
		expires = maxExpires
	}

	// Refuse to register a pair token for a vault the caller isn't an
	// owner of. Editors and viewers should not be able to mint pairing
	// codes — the security model assumes only the owner ever does so.
	var role string
	err := s.pool.QueryRow(ctx, `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
	`, vaultID, accountID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotMember
	}
	if err != nil {
		return fmt.Errorf("read membership: %w", err)
	}
	if role != "owner" {
		return ErrNotMember
	}

	if _, err := s.pool.Exec(ctx, `
		INSERT INTO vault_pair_tokens
			(token_hash, vault_id, issuer_account_id, issuer_install_id, issued_at, expires_at)
		VALUES ($1, $2::uuid, $3::uuid, $4::uuid, NOW(), $5)
		ON CONFLICT (token_hash) DO NOTHING
	`, hashPairToken(token), vaultID, accountID, installID, expires); err != nil {
		return fmt.Errorf("insert pair token: %w", err)
	}
	return nil
}

// ConsumePairToken atomically marks the token consumed and returns nil iff:
//   - the token hash matches a row;
//   - the row's vault_id matches the request's vault_id;
//   - expires_at > NOW();
//   - consumed_at IS NULL.
//
// Otherwise returns ErrPairTokenInvalid / ErrPairTokenVaultMismatch /
// ErrPairTokenIssuedAtTooOld. The caller (IssueVMC via handler) supplies
// issuedAtMS from the QR payload; the server checks it against its own
// clock so a scanner-clock rollback can't bypass the 5-minute window.
//
// installIDConsuming is recorded for forensics. It's the JWT-derived
// install_id of the scanner phone — not user-controlled.
func (s *Service) ConsumePairToken(
	ctx context.Context,
	token, vaultID, installIDConsuming string,
	issuedAtMS int64,
) error {
	if token == "" {
		return ErrPairTokenInvalid
	}
	if _, err := uuid.Parse(vaultID); err != nil {
		return fmt.Errorf("vault_id must be a uuid: %w", err)
	}

	// Server-clock check on issued_at: the QR's claim must be within the
	// allowed window relative to OUR clock, regardless of the scanner's
	// device clock. A 60s skew tolerance handles benign drift.
	const skew = 60 * time.Second
	issuedAt := time.UnixMilli(issuedAtMS)
	now := time.Now()
	if issuedAt.After(now.Add(skew)) {
		return ErrPairTokenIssuedAtTooOld
	}
	if now.Sub(issuedAt) > PairTokenLifetimeMax+skew {
		return ErrPairTokenIssuedAtTooOld
	}

	tag, err := s.pool.Exec(ctx, `
		UPDATE vault_pair_tokens
		   SET consumed_at = NOW(),
		       consumed_by_install_id = $3::uuid
		 WHERE token_hash = $1
		   AND vault_id = $2::uuid
		   AND consumed_at IS NULL
		   AND expires_at > NOW()
	`, hashPairToken(token), vaultID, installIDConsuming)
	if err != nil {
		return fmt.Errorf("consume pair token: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Distinguish "vault mismatch" from "expired / missing / consumed"
		// by a follow-up read. Helps observability without changing the
		// 403 the handler returns to the client.
		var dbVaultID string
		err := s.pool.QueryRow(ctx, `
			SELECT vault_id::text FROM vault_pair_tokens WHERE token_hash = $1
		`, hashPairToken(token)).Scan(&dbVaultID)
		if err == nil && dbVaultID != vaultID {
			return ErrPairTokenVaultMismatch
		}
		return ErrPairTokenInvalid
	}
	return nil
}
