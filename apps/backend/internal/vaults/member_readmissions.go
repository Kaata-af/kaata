package vaults

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/connectionnotice"
	"github.com/matee/kaata-backend/internal/httpx"
	"github.com/matee/kaata-backend/internal/memberreadmission"
)

var ErrReadmissionDeviceUnavailable = errors.New("this device cannot be restored by this invitation")

// Consent is deliberately separate from accepted_at/account_id. Only a later
// atomic owner-signed member/device publication can activate this seat.
func consentMemberReadmission(ctx context.Context, tx pgx.Tx, in AcceptInviteInput, memberID int64, vaultID, inviter string) (AcceptInviteResult, error) {
	if !in.MemberReadmission {
		return AcceptInviteResult{}, ErrMemberReadmissionRequired
	}
	var pinnedInstall *string
	if err := tx.QueryRow(ctx, `SELECT readmission_install_id::text FROM vault_members WHERE id=$1`, memberID).Scan(&pinnedInstall); err != nil {
		return AcceptInviteResult{}, err
	}
	if pinnedInstall != nil && *pinnedInstall != in.InstallID {
		return AcceptInviteResult{}, ErrReadmissionDeviceUnavailable
	}
	if in.ReadmissionStatusOnly && pinnedInstall == nil {
		return AcceptInviteResult{}, ErrInviteNotFound
	}
	if in.InstallID == "" {
		return AcceptInviteResult{}, ErrReadmissionDeviceUnavailable
	}
	if pinnedInstall == nil {
		tag, err := tx.Exec(ctx, `UPDATE vault_members vm SET readmission_consented_at=NOW(),
 readmission_install_id=i.install_id,readmission_device_pubkey=dk.ed25519_pubkey,
 readmission_after_ms=GREATEST((EXTRACT(EPOCH FROM NOW())*1000)::bigint,
  COALESCE((SELECT last_change_hlc_ms FROM vault_members WHERE id=vm.readmission_from_id),0),
  COALESCE((SELECT MAX(hlc_physical_ms) FROM events WHERE vault_id=vm.vault_id),0),
  COALESCE((SELECT MAX(GREATEST(added_at_ms,COALESCE(removed_at_ms,0))) FROM vault_devices WHERE vault_id=vm.vault_id),0)),updated_at=NOW()
 FROM installs i JOIN device_keys dk ON dk.install_id=i.install_id
 WHERE vm.id=$1 AND i.install_id=$2::uuid AND i.account_id=$3::uuid AND i.account_deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM auth_credentials c WHERE c.install_id=i.install_id AND c.account_id=i.account_id AND c.revoked_at IS NULL)`, memberID, in.InstallID, in.AccountID)
		if err != nil {
			return AcceptInviteResult{}, err
		}
		if tag.RowsAffected() != 1 {
			return AcceptInviteResult{}, ErrReadmissionDeviceUnavailable
		}
	}
	requestID, _ := accountInviteSelector(in.Token)
	load := memberreadmission.LoadReadyForApproval
	if in.ReadmissionStatusOnly {
		load = memberreadmission.LoadReady
	}
	ready, err := load(ctx, tx, vaultID, requestID, inviter)
	if errors.Is(err, memberreadmission.ErrNotReady) {
		return AcceptInviteResult{}, ErrReadmissionDeviceUnavailable
	}
	if err != nil {
		return AcceptInviteResult{}, err
	}
	out, err := readmissionAcceptResult(ctx, tx, memberID, in)
	if err != nil {
		return AcceptInviteResult{}, err
	}
	out.ReadmissionPending = true
	if in.ReadmissionStatusOnly {
		return out, nil
	}
	if pinnedInstall == nil {
		if _, err := writeAudit(ctx, tx, vaultID, &in.AccountID, "invite_consented", &in.AccountID,
			map[string]any{"kind": "member_readmission", "invite_id": requestID, "device_id": ready.DeviceID}); err != nil {
			return AcceptInviteResult{}, err
		}
		if err := connectionnotice.Add(ctx, tx, connectionnotice.Notice{Kind: "vault_member_return_requested", SourceID: requestID, RecipientID: inviter, ActorID: in.AccountID, VaultID: vaultID, Detail: out.Role}); err != nil {
			return AcceptInviteResult{}, err
		}
	}
	if err := connectionnotice.Handled(ctx, tx, "vault_invite_requested", requestID); err != nil {
		return AcceptInviteResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptInviteResult{}, err
	}
	return out, nil
}

func (s *Service) MemberReadmissionStatus(ctx context.Context, accountID, installID, inviteID string) (AcceptInviteResult, error) {
	if _, ok := accountInviteSelector("v_" + inviteID); !ok {
		return AcceptInviteResult{}, ErrInviteNotFound
	}
	return s.AcceptInvite(ctx, AcceptInviteInput{Token: "v_" + inviteID, AccountID: accountID, InstallID: installID, MemberReadmission: true, ReadmissionStatusOnly: true})
}

func (h *Handler) MemberReadmissionStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	result, err := h.svc.MemberReadmissionStatus(r.Context(), claims.AccountID, claims.InstallID, chi.URLParam(r, "invite_id"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func readmissionAcceptResult(ctx context.Context, tx pgx.Tx, memberID int64, in AcceptInviteInput) (AcceptInviteResult, error) {
	out := AcceptInviteResult{MemberReadmission: true}
	err := tx.QueryRow(ctx, `SELECT v.vault_id::text,v.name,vm.role,v.currency,v.legacy_currency,v.default_entry_currency,
 vm.readmission_install_id::text,encode(vm.readmission_device_pubkey,'base64'),
 COALESCE(vm.readmission_member_event_id::text,''),COALESCE(vm.readmission_device_event_id::text,'')
 FROM vault_members vm JOIN vaults v ON v.vault_id=vm.vault_id
 JOIN installs i ON i.install_id=vm.readmission_install_id AND i.account_id=vm.invite_account_id AND i.account_deleted_at IS NULL
 JOIN device_keys dk ON dk.install_id=i.install_id AND dk.ed25519_pubkey=vm.readmission_device_pubkey
 WHERE vm.id=$1 AND vm.invite_account_id=$2::uuid AND vm.readmission_install_id=$3::uuid
 AND EXISTS(SELECT 1 FROM auth_credentials c WHERE c.install_id=i.install_id AND c.account_id=i.account_id AND c.revoked_at IS NULL)
 AND (vm.accepted_at IS NULL OR (vm.readmission_member_event_id IS NOT NULL AND vm.readmission_device_event_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM vault_devices vd WHERE vd.vault_id=vm.vault_id AND vd.account_id=vm.invite_account_id
   AND vd.device_id=vm.readmission_install_id AND vd.device_pubkey=vm.readmission_device_pubkey AND vd.removed_at_ms IS NULL)))`, memberID, in.AccountID, in.InstallID).
		Scan(&out.VaultID, &out.VaultName, &out.Role, &out.Currency, &out.LegacyCurrency, &out.DefaultEntryCurrency,
			&out.ReadmissionDeviceID, &out.ReadmissionDevicePubkey, &out.ReadmissionMemberEventID, &out.ReadmissionDeviceEventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptInviteResult{}, ErrReadmissionDeviceUnavailable
	}
	return out, err
}

type MemberReadmissionRequest struct {
	InviteID     string `json:"invite_id"`
	AccountID    string `json:"account_id"`
	Name         string `json:"name"`
	Role         string `json:"role"`
	DeviceID     string `json:"device_id"`
	DevicePubkey string `json:"device_pubkey"`
	AfterMS      int64  `json:"after_ms"`
}

func (s *Service) ListMemberReadmissions(ctx context.Context, vaultID, ownerID string) ([]MemberReadmissionRequest, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveAccounts(ctx, tx, ownerID); err != nil {
		return nil, err
	}
	if err := requireOwner(ctx, tx, vaultID, ownerID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT vm.invite_request_id::text,COALESCE(a.name,'') FROM vault_members vm
 JOIN accounts a ON a.id=vm.invite_account_id WHERE vm.vault_id=$1::uuid AND vm.invited_by=$2::uuid
 AND vm.readmission_consented_at IS NOT NULL AND vm.accepted_at IS NULL AND vm.revoked_at IS NULL
 AND vm.invite_expires_at>NOW() ORDER BY vm.readmission_consented_at LIMIT $3`, vaultID, ownerID, maxPendingAccountInvites)
	if err != nil {
		return nil, err
	}
	candidates := make([]MemberReadmissionRequest, 0)
	for rows.Next() {
		var r MemberReadmissionRequest
		if err := rows.Scan(&r.InviteID, &r.Name); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]MemberReadmissionRequest, 0, len(candidates))
	for _, r := range candidates {
		ready, err := memberreadmission.LoadReady(ctx, tx, vaultID, r.InviteID, ownerID)
		if errors.Is(err, memberreadmission.ErrNotReady) {
			continue
		}
		if err != nil {
			return nil, err
		}
		r.AccountID, r.Role, r.DeviceID, r.DevicePubkey, r.AfterMS = ready.AccountID, ready.Role, ready.DeviceID, ready.DevicePubkey, ready.AfterMS
		out = append(out, r)
	}
	return out, nil
}

func (h *Handler) ListMemberReadmissions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims := claimsOrUnauthorized(w, r)
	if claims == nil {
		return
	}
	vaultID := vaultIDFromURL(w, r)
	if vaultID == "" {
		return
	}
	requests, err := h.svc.ListMemberReadmissions(r.Context(), vaultID, claims.AccountID)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"requests": requests})
}
