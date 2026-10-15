package vaults

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/matee/kaata-backend/internal/canonical"
	"github.com/matee/kaata-backend/internal/ownership"
)

var ErrInvalidOwnershipAuthorization = errors.New("invalid ownership authorization; refresh and try again")
var ErrOwnershipSigningUnavailable = errors.New("ownership transfer temporarily unavailable")

// SetOwnershipSigner uses the same pinned server key as mesh witnesses. An
// acceptance cannot commit without its durable, verifiable membership event.
func (s *Service) SetOwnershipSigner(key ed25519.PrivateKey) {
	s.ownershipSigner = append(ed25519.PrivateKey(nil), key...)
}

type CreateOwnershipInviteInput struct {
	AccountID     string
	VaultID       string
	Authorization ownership.Authorization
}

type OwnershipInviteStatus struct {
	TransferID  string    `json:"transfer_id"`
	InviteEmail string    `json:"invite_email"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// ownershipSourceLocked snapshots the exact owner seat. Demotion followed by
// re-promotion must not make a previously issued handover link valid again.
func ownershipSourceLocked(ctx context.Context, tx pgx.Tx, vaultID, accountID string) (int64, int64, time.Time, error) {
	if err := requireOwner(ctx, tx, vaultID, accountID); err != nil {
		return 0, 0, time.Time{}, err
	}
	var canonicalOwner string
	var unavailable bool
	if err := tx.QueryRow(ctx, `SELECT owner_account_id::text, archived_at IS NOT NULL OR purged_at IS NOT NULL
 FROM vaults WHERE vault_id=$1::uuid`, vaultID).Scan(&canonicalOwner, &unavailable); err != nil {
		return 0, 0, time.Time{}, err
	}
	if canonicalOwner != accountID {
		return 0, 0, time.Time{}, ErrNotOwner
	}
	if unavailable {
		return 0, 0, time.Time{}, ErrAlreadyArchived
	}
	var memberID, changed int64
	var updated time.Time
	err := tx.QueryRow(ctx, `SELECT id, COALESCE(last_change_hlc_ms,0), updated_at FROM vault_members
 WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE`, vaultID, accountID).Scan(&memberID, &changed, &updated)
	return memberID, changed, updated, err
}

func ownershipSignerBound(ctx context.Context, tx pgx.Tx, a ownership.Authorization) (bool, error) {
	pub, _ := base64.StdEncoding.DecodeString(a.SignerDevicePubkey)
	var bound bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM vault_devices WHERE vault_id=$1::uuid
 AND account_id=$2::uuid AND device_pubkey=$3 AND removed_at_ms IS NULL)
 AND NOT EXISTS(SELECT 1 FROM vault_devices WHERE vault_id=$1::uuid AND device_pubkey=$3 AND removed_at_ms IS NOT NULL)
 AND EXISTS(SELECT 1 FROM vaults WHERE vault_id=$1::uuid AND octet_length(vault_trust_anchor_pubkey)=32)`, a.Grant.VaultID, a.Grant.FromAccountID, pub).Scan(&bound)
	if err != nil {
		return false, err
	}
	chainID := a.Grant.ChainAccountID()
	if chainID != a.Grant.FromAccountID && !strings.HasPrefix(chainID, "local:") {
		return false, nil
	}
	// The chain itself must contain the active source owner. REST membership
	// alone cannot authorize a proof which other devices cannot verify.
	var eventType, role string
	err = tx.QueryRow(ctx, `SELECT event_type,CASE WHEN COALESCE(local_target_id,target_id::text)=$2 THEN COALESCE(payload->>'role','') ELSE 'editor' END FROM events
	 WHERE vault_id=$1::uuid AND redacted_at IS NULL AND (COALESCE(local_target_id,target_id::text)=$2
	 OR COALESCE(NULLIF(payload#>>'{ownership_transfer,authorization,grant,from_chain_account_id}',''),payload#>>'{ownership_transfer,authorization,grant,from_account_id}')=$2
	 OR payload#>>'{ownership_transfer,authorization,grant,from_account_id}'=$2)
	 AND event_type IN ('vault_member_added','vault_member_role_changed','vault_member_removed')
	 AND NULLIF(event_sig_b64,'') IS NOT NULL
	 ORDER BY hlc_physical_ms DESC,hlc_logical DESC,hlc_device_id DESC,event_id DESC LIMIT 1`, a.Grant.VaultID, chainID).Scan(&eventType, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if eventType == "vault_member_removed" || role != "owner" {
		return false, nil
	}
	if bound && chainID == a.Grant.FromAccountID {
		return true, nil
	}
	// Original offline vaults have a local: genesis owner which cannot fit the
	// UUID-only operational device table. Permit that exact anchor identity,
	// corroborated by the actual owner's registered key and immutable genesis.
	var anchor []byte
	var registered, removed, genesis bool
	err = tx.QueryRow(ctx, `SELECT v.vault_trust_anchor_pubkey,
	 EXISTS(SELECT 1 FROM device_keys dk JOIN installs i ON i.install_id=dk.install_id
	 WHERE i.account_id=$2::uuid AND i.account_deleted_at IS NULL AND dk.ed25519_pubkey=$3),
	 EXISTS(SELECT 1 FROM vault_devices WHERE vault_id=$1::uuid AND device_pubkey=$3 AND removed_at_ms IS NOT NULL),
	 COALESCE((SELECT COALESCE(local_target_id,target_id::text)=$4 AND payload->>'role'='owner'
	 AND signer_device_pubkey=$5 AND NULLIF(event_sig_b64,'') IS NOT NULL FROM events
	 WHERE vault_id=$1::uuid AND redacted_at IS NULL AND event_type='vault_member_added' ORDER BY server_seq LIMIT 1),FALSE)
	 FROM vaults v WHERE v.vault_id=$1::uuid`, a.Grant.VaultID, a.Grant.FromAccountID, pub, chainID, a.SignerDevicePubkey).Scan(&anchor, &registered, &removed, &genesis)
	return err == nil && registered && !removed && genesis && bytes.Equal(anchor, pub), err
}

func (s *Service) CreateOwnershipInvite(ctx context.Context, in CreateOwnershipInviteInput) (CreateInviteResult, error) {
	a, g := in.Authorization, in.Authorization.Grant
	now := time.Now()
	if ownership.VerifyAuthorization(a) != nil || g.VaultID != in.VaultID || g.FromAccountID != in.AccountID ||
		g.IssuedAtMS < now.Add(-5*time.Minute).UnixMilli() || g.IssuedAtMS > now.Add(5*time.Minute).UnixMilli() ||
		g.ExpiresAtMS <= now.UnixMilli() || g.ExpiresAtMS > now.Add(7*24*time.Hour+5*time.Minute).UnixMilli() {
		return CreateInviteResult{}, ErrInvalidOwnershipAuthorization
	}
	if len(s.ownershipSigner) != ed25519.PrivateKeySize {
		return CreateInviteResult{}, ErrOwnershipSigningUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CreateInviteResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = lockActiveAccounts(ctx, tx, in.AccountID); err != nil {
		return CreateInviteResult{}, err
	}
	memberID, changed, updated, err := ownershipSourceLocked(ctx, tx, in.VaultID, in.AccountID)
	if err != nil {
		return CreateInviteResult{}, err
	}
	bound, err := ownershipSignerBound(ctx, tx, a)
	if err != nil {
		return CreateInviteResult{}, err
	}
	if !bound {
		return CreateInviteResult{}, ErrInvalidOwnershipAuthorization
	}
	var selfEmail string
	if err = tx.QueryRow(ctx, `SELECT email FROM accounts WHERE id=$1::uuid`, in.AccountID).Scan(&selfEmail); err != nil {
		return CreateInviteResult{}, err
	}
	if NormalizeInviteEmail(selfEmail) == g.RecipientEmailNormalized {
		return CreateInviteResult{}, ErrSelfTransfer
	}
	var reused bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM vault_ownership_invites WHERE transfer_id=$1::uuid)`, g.TransferID).Scan(&reused); err != nil {
		return CreateInviteResult{}, err
	}
	if reused {
		return CreateInviteResult{}, ErrInvitePending
	}
	token, err := newInviteToken()
	if err != nil {
		return CreateInviteResult{}, err
	}
	raw, err := json.Marshal(a)
	if err != nil {
		return CreateInviteResult{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE vault_ownership_invites SET revoked_at=NOW() WHERE vault_id=$1::uuid AND revoked_at IS NULL AND accepted_at IS NULL`, in.VaultID); err != nil {
		return CreateInviteResult{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO vault_ownership_invites
 (transfer_id,vault_id,from_account_id,recipient_email_normalized,source_member_id,source_last_change_hlc_ms,source_updated_at,authorization_payload,token_hash,expires_at)
 VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9,$10)`, g.TransferID, in.VaultID, in.AccountID, g.RecipientEmailNormalized, memberID, changed, updated, string(raw), hashInviteToken(token), time.UnixMilli(g.ExpiresAtMS)); err != nil {
		return CreateInviteResult{}, fmt.Errorf("insert ownership invite: %w", err)
	}
	if _, err = writeAudit(ctx, tx, in.VaultID, &in.AccountID, "ownership_invite_issued", nil, map[string]any{"transfer_id": g.TransferID, "target_email": g.RecipientEmailNormalized}); err != nil {
		return CreateInviteResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CreateInviteResult{}, err
	}
	return CreateInviteResult{InviteURL: "https://kaata.af/i/" + token, InviteEmail: g.RecipientEmailNormalized, ExpiresAt: time.UnixMilli(g.ExpiresAtMS)}, nil
}

func (s *Service) OwnershipInviteStatus(ctx context.Context, vaultID, accountID string) (*OwnershipInviteStatus, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = lockActiveAccounts(ctx, tx, accountID); err != nil {
		return nil, err
	}
	memberID, changed, updated, err := ownershipSourceLocked(ctx, tx, vaultID, accountID)
	if err != nil {
		return nil, err
	}
	var out OwnershipInviteStatus
	err = tx.QueryRow(ctx, `SELECT transfer_id::text,recipient_email_normalized,expires_at FROM vault_ownership_invites
 WHERE vault_id=$1::uuid AND from_account_id=$2::uuid AND source_member_id=$3 AND source_last_change_hlc_ms=$4 AND source_updated_at=$5
 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>NOW()`, vaultID, accountID, memberID, changed, updated).Scan(&out.TransferID, &out.InviteEmail, &out.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &out, err
}

func (s *Service) CancelOwnershipInvite(ctx context.Context, vaultID, accountID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = lockActiveAccounts(ctx, tx, accountID); err != nil {
		return err
	}
	if _, _, _, err = ownershipSourceLocked(ctx, tx, vaultID, accountID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE vault_ownership_invites SET revoked_at=NOW() WHERE vault_id=$1::uuid AND revoked_at IS NULL AND accepted_at IS NULL`, vaultID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		if _, err = writeAudit(ctx, tx, vaultID, &accountID, "ownership_invite_cancelled", nil, nil); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) ownershipInviteInfo(ctx context.Context, tokenHash string) (InviteInfoResult, error) {
	var out InviteInfoResult
	var email string
	var expiry time.Time
	err := s.pool.QueryRow(ctx, `SELECT v.name,COALESCE(a.email,''),`+inviterNameSQL("a")+`,i.expires_at
 FROM vault_ownership_invites i JOIN vaults v ON v.vault_id=i.vault_id
 JOIN accounts a ON a.id=i.from_account_id
 JOIN vault_members vm ON vm.id=i.source_member_id
 WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at>NOW()
 AND v.archived_at IS NULL AND v.purged_at IS NULL AND v.owner_account_id=i.from_account_id
 AND a.pending_delete_at IS NULL AND a.disabled_at IS NULL
 AND vm.account_id=i.from_account_id AND vm.role='owner' AND vm.revoked_at IS NULL AND vm.accepted_at IS NOT NULL
 AND COALESCE(vm.last_change_hlc_ms,0)=i.source_last_change_hlc_ms AND vm.updated_at=i.source_updated_at`, tokenHash).Scan(&out.VaultName, &email, &out.InviterName, &expiry)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrInviteNotFound
	}
	if err != nil {
		return out, err
	}
	out.Kind = "ownership_transfer"
	out.Role = "owner"
	out.InviterEmailRedacted = redactEmail(email)
	out.ExpiresAt = expiry.UTC().Format(time.RFC3339)
	return out, nil
}

type AcceptOwnershipInviteResult struct {
	VaultID              string `json:"vault_id"`
	VaultName            string `json:"vault_name"`
	Role                 string `json:"role"`
	OwnershipTransferred bool   `json:"ownership_transferred"`
	OwnershipEventID     string `json:"ownership_event_id"`
}

func (s *Service) AcceptOwnershipInvite(ctx context.Context, in AcceptInviteInput) (AcceptOwnershipInviteResult, error) {
	var out AcceptOwnershipInviteResult
	if in.Token == "" || len(in.Token) > 512 {
		return out, ErrInviteNotFound
	}
	hash := hashInviteToken(in.Token)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Discover IDs first, then lock accounts before vault/invite rows, matching
	// account deletion and every membership mutation's global lock order.
	var vaultID, sourceID string
	if err = tx.QueryRow(ctx, `SELECT vault_id::text,from_account_id::text FROM vault_ownership_invites WHERE token_hash=$1`, hash).Scan(&vaultID, &sourceID); errors.Is(err, pgx.ErrNoRows) {
		return out, ErrInviteNotFound
	} else if err != nil {
		return out, err
	}
	if in.AccountID == sourceID {
		return out, ErrSelfTransfer
	}
	if err = lockActiveAccounts(ctx, tx, in.AccountID, sourceID); err != nil {
		return out, err
	}
	var canonicalOwner, vaultName string
	var unavailable bool
	if err = tx.QueryRow(ctx, `SELECT owner_account_id::text,name,archived_at IS NOT NULL OR purged_at IS NOT NULL FROM vaults WHERE vault_id=$1::uuid FOR UPDATE`, vaultID).Scan(&canonicalOwner, &vaultName, &unavailable); errors.Is(err, pgx.ErrNoRows) {
		return out, ErrInviteNotFound
	} else if err != nil {
		return out, err
	}
	if unavailable {
		return out, ErrInviteNotFound
	}
	var transferID, email string
	var raw []byte
	var memberID, sourceChanged int64
	var sourceUpdated, expires time.Time
	var accepted, revoked *time.Time
	var acceptedBy *string
	var existingEventID *string
	err = tx.QueryRow(ctx, `SELECT transfer_id::text,recipient_email_normalized,authorization_payload,source_member_id,source_last_change_hlc_ms,source_updated_at,expires_at,accepted_at,revoked_at,accepted_by::text,event_id::text
 FROM vault_ownership_invites WHERE token_hash=$1 AND vault_id=$2::uuid FOR UPDATE`, hash, vaultID).Scan(&transferID, &email, &raw, &memberID, &sourceChanged, &sourceUpdated, &expires, &accepted, &revoked, &acceptedBy, &existingEventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrInviteNotFound
	}
	if err != nil {
		return out, err
	}
	// A response-loss retry only reports current access. It never mutates ACL,
	// creates another proof, or resurrects a removed member after later changes.
	if accepted != nil && acceptedBy != nil && *acceptedBy == in.AccountID && revoked == nil {
		var role string
		err = tx.QueryRow(ctx, `SELECT role FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL`, vaultID, in.AccountID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			return out, ErrInviteNotFound
		}
		if err != nil {
			return out, err
		}
		if existingEventID == nil {
			return out, ErrInviteNotFound
		}
		return AcceptOwnershipInviteResult{vaultID, vaultName, role, true, *existingEventID}, nil
	}
	if accepted != nil || revoked != nil || !time.Now().Before(expires) || canonicalOwner != sourceID {
		return out, ErrInviteNotFound
	}
	var callerEmail string
	var verified, callerDisabled, sourceInactive bool
	if err = tx.QueryRow(ctx, `SELECT email,email_verified,disabled_at IS NOT NULL FROM accounts WHERE id=$1::uuid`, in.AccountID).Scan(&callerEmail, &verified, &callerDisabled); err != nil {
		return out, err
	}
	if !verified || callerDisabled || NormalizeInviteEmail(callerEmail) != email {
		return out, ErrInviteEmailMismatch
	}
	// A fresh explicit owner grant may re-admit an account. It never revives
	// that account's removed device: accepting from such an install would
	// strand the new owner before it can publish a valid device admission.
	if in.InstallID != "" {
		var removedDevice bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vault_devices vd JOIN device_keys dk
		 ON vd.device_pubkey=dk.ed25519_pubkey WHERE vd.vault_id=$1::uuid AND dk.install_id=$2::uuid
		 AND vd.removed_at_ms IS NOT NULL)`, vaultID, in.InstallID).Scan(&removedDevice); err != nil {
			return out, err
		}
		if removedDevice {
			return out, ErrInviteNotFound
		}
	}
	if err = tx.QueryRow(ctx, `SELECT pending_delete_at IS NOT NULL OR disabled_at IS NOT NULL FROM accounts WHERE id=$1::uuid`, sourceID).Scan(&sourceInactive); errors.Is(err, pgx.ErrNoRows) {
		return out, ErrInviteNotFound
	} else if err != nil {
		return out, err
	}
	if sourceInactive {
		return out, ErrInviteNotFound
	}
	id, changed, updated, err := ownershipSourceLocked(ctx, tx, vaultID, sourceID)
	if err != nil {
		return out, ErrInviteNotFound
	}
	if id != memberID || changed != sourceChanged || !updated.Equal(sourceUpdated) {
		return out, ErrInviteNotFound
	}
	var authorization ownership.Authorization
	if json.Unmarshal(raw, &authorization) != nil || ownership.VerifyAuthorization(authorization) != nil {
		return out, ErrInviteNotFound
	}
	bound, err := ownershipSignerBound(ctx, tx, authorization)
	if err != nil {
		return out, err
	}
	if !bound {
		return out, ErrInviteNotFound
	}
	if len(s.ownershipSigner) != ed25519.PrivateKeySize {
		return out, ErrOwnershipSigningUnavailable
	}
	var maximum int64
	if err = tx.QueryRow(ctx, `SELECT GREATEST(COALESCE((SELECT MAX(hlc_physical_ms) FROM events WHERE vault_id=$1::uuid),0),COALESCE((SELECT MAX(last_change_hlc_ms) FROM vault_members WHERE vault_id=$1::uuid),0))`, vaultID).Scan(&maximum); err != nil {
		return out, err
	}
	stamp := time.Now().UnixMilli()
	if maximum > stamp {
		stamp = maximum
	}
	if authorization.Grant.IssuedAtMS > stamp {
		stamp = authorization.Grant.IssuedAtMS
	}
	stamp++
	if stamp > authorization.Grant.ExpiresAtMS {
		return out, ErrInviteNotFound
	}
	// Existing staff keep their seat; a removed recipient gets a fresh seat.
	var targetMember int64
	err = tx.QueryRow(ctx, `SELECT id FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND revoked_at IS NULL FOR UPDATE`, vaultID, in.AccountID).Scan(&targetMember)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `INSERT INTO vault_members(vault_id,account_id,role,invited_by,accepted_at,last_change_hlc_ms) VALUES($1::uuid,$2::uuid,'owner',$3::uuid,NOW(),$4) RETURNING id`, vaultID, in.AccountID, sourceID, stamp).Scan(&targetMember)
	} else if err == nil {
		_, err = tx.Exec(ctx, `UPDATE vault_members SET role='owner',accepted_at=COALESCE(accepted_at,NOW()),last_change_hlc_ms=$2,updated_at=NOW() WHERE id=$1`, targetMember, stamp)
	}
	if err != nil {
		return out, fmt.Errorf("promote ownership recipient: %w", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE vault_members SET role='editor',last_change_hlc_ms=$2,updated_at=NOW() WHERE id=$1`, memberID, stamp); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE vaults SET owner_account_id=$2::uuid WHERE vault_id=$1::uuid`, vaultID, in.AccountID); err != nil {
		return out, err
	}
	epoch, err := bumpEpoch(ctx, tx, vaultID)
	if err != nil {
		return out, err
	}
	eventID := uuid.NewString()
	grantHash, err := ownership.GrantHash(authorization.Grant)
	if err != nil {
		return out, err
	}
	proof := ownership.Proof{Authorization: authorization, Receipt: ownership.Receipt{Domain: ownership.ReceiptDomain, TransferID: transferID, VaultID: vaultID, GrantSHA256: grantHash, ToAccountID: in.AccountID, AcceptedAtMS: stamp, EventID: eventID, VaultEpoch: epoch}}
	if err = ownership.VerifyProof(proof, ownership.EventIdentity{VaultID: vaultID, EventID: eventID, TargetID: in.AccountID, HLCPhysicalMS: stamp}); err != nil {
		return out, err
	}
	if err = s.persistOwnershipEvent(ctx, tx, vaultID, eventID, in.AccountID, stamp, proof); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE vault_ownership_invites SET accepted_at=NOW(),accepted_by=$2::uuid,event_id=$3::uuid WHERE transfer_id=$1::uuid`, transferID, in.AccountID, eventID); err != nil {
		return out, err
	}
	if _, err = writeAudit(ctx, tx, vaultID, &sourceID, "ownership_transferred", &in.AccountID, map[string]any{"from": sourceID, "to": in.AccountID, "demote_self_to": "editor", "transfer_id": transferID}); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.invalidateMembership(vaultID, sourceID, in.AccountID)
	if n, ok := s.invalidator.(interface{ NotifyLive(string) }); ok {
		n.NotifyLive(vaultID)
	}
	return AcceptOwnershipInviteResult{vaultID, vaultName, "owner", true, eventID}, nil
}

func (s *Service) persistOwnershipEvent(ctx context.Context, tx pgx.Tx, vaultID, eventID, target string, stamp int64, proof ownership.Proof) error {
	pub := s.ownershipSigner.Public().(ed25519.PublicKey)
	deviceID := uuid.NewSHA1(uuid.NameSpaceOID, append([]byte("kaata-ownership-server:"), pub...)).String()
	payload := map[string]any{"account_id": target, "role": "owner", "ownership_transfer": proof}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	wirePayload, err := canonical.Decode(raw)
	if err != nil {
		return err
	}
	envelope := map[string]any{"actor_account_id": nil, "device_id": deviceID, "event_id": eventID, "event_type": "vault_member_added", "hlc": map[string]any{"did": deviceID, "l": 0, "pms": stamp}, "payload": wirePayload, "payload_schema": 1, "relationship_id": nil, "target_id": target, "vault_id": vaultID}
	signable, err := canonical.Canonicalize(envelope)
	if err != nil {
		return err
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(s.ownershipSigner, signable))
	_, err = tx.Exec(ctx, `INSERT INTO events(event_id,vault_id,server_seq,event_type,schema_version,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,account_id,target_id,payload,event_sig_b64,signer_device_pubkey)
 VALUES($1::uuid,$2::uuid,(SELECT COALESCE(MAX(server_seq),0)+1 FROM events WHERE vault_id=$2::uuid),'vault_member_added',1,$3,0,$4::uuid,$4::uuid,NULL,$5::uuid,$6::jsonb,$7,$8)`, eventID, vaultID, stamp, deviceID, target, string(raw), sig, base64.StdEncoding.EncodeToString(pub))
	return err
}
