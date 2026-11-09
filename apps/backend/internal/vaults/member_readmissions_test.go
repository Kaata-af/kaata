package vaults

import (
	"bytes"
	"encoding/base64"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/memberreadmission"
)

func readmissionFixture(t *testing.T) (*graceVaultFixture, string, []byte) {
	t.Helper()
	f := newGraceVaultFixture(t)
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: f.token, AccountID: f.joiner}); err != nil {
		t.Fatal(err)
	}
	install := uuid.NewString()
	pub := bytes.Repeat([]byte{7}, 32)
	accountInviteExec(t, f, `INSERT INTO installs(install_id,account_id) VALUES($1::uuid,$2::uuid)`, install, f.joiner)
	accountInviteExec(t, f, `INSERT INTO auth_credentials(install_id,provider,provider_sub,account_id) VALUES($1::uuid,'google',$2::text,$2::uuid)`, install, f.joiner)
	accountInviteExec(t, f, `INSERT INTO device_keys(install_id,ed25519_pubkey) VALUES($1::uuid,$2)`, install, pub)
	accountInviteExec(t, f, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms) VALUES($1::uuid,$2::uuid,$3,$4::uuid,1)`, f.vault, install, pub, f.joiner)
	if _, err := f.svc.RevokeMember(t.Context(), RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: f.joiner}); err != nil {
		t.Fatal(err)
	}
	return f, install, pub
}

func readmissionCreate(t *testing.T, f *graceVaultFixture) AccountInviteResult {
	t.Helper()
	r, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.joiner, Role: "viewer", ReadmitRemoved: true})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestMemberReadmissionConsentHasNoAccess(t *testing.T) {
	f, install, pub := readmissionFixture(t)
	if _, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.joiner, Role: "viewer"}); !errors.Is(err, ErrMemberReadmissionRequired) {
		t.Fatalf("old client did not fail closed: %v", err)
	}
	r := readmissionCreate(t, f)
	if !r.MemberReadmission {
		t.Fatal("return invitation missing explicit marker")
	}
	if retry := readmissionCreate(t, f); retry.InviteID != r.InviteID {
		t.Fatal("create retry replaced the grant")
	}
	preview, err := f.svc.AccountInviteInfo(t.Context(), f.joiner, r.InviteID)
	if err != nil || preview.Kind != "member_readmission" {
		t.Fatalf("preview %+v %v", preview, err)
	}
	if pending, err := f.svc.ListPendingInvites(t.Context(), f.joiner); err != nil || len(pending) != 1 || pending[0].InviteID != r.InviteID {
		t.Fatalf("inbox %+v %v", pending, err)
	}
	if ready, err := f.svc.ListMemberReadmissions(t.Context(), f.vault, f.owner); err != nil || len(ready) != 0 {
		t.Fatalf("unconsented ready %+v %v", ready, err)
	}
	in := AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner, InstallID: install}
	if _, err := f.svc.AcceptInvite(t.Context(), in); !errors.Is(err, ErrMemberReadmissionRequired) {
		t.Fatalf("old acceptance %v", err)
	}
	in.MemberReadmission = true
	out, err := f.svc.AcceptInvite(t.Context(), in)
	if err != nil || !out.ReadmissionPending || out.ReadmissionDeviceID != install || out.ReadmissionDevicePubkey != base64.StdEncoding.EncodeToString(pub) {
		t.Fatalf("consent %+v %v", out, err)
	}
	if retry, err := f.svc.AcceptInvite(t.Context(), in); err != nil || retry != out {
		t.Fatalf("consent retry %+v %v", retry, err)
	}
	if books, err := f.svc.List(t.Context(), f.joiner); err != nil || len(books) != 0 {
		t.Fatalf("consent granted ACL %+v %v", books, err)
	}
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_request_id=$1::uuid AND accepted_at IS NULL AND account_id IS NULL AND readmission_consented_at IS NOT NULL`, r.InviteID) != 1 {
		t.Fatal("consent activated seat")
	}
	ready, err := f.svc.ListMemberReadmissions(t.Context(), f.vault, f.owner)
	if err != nil || len(ready) != 1 || ready[0].DeviceID != install || ready[0].AfterMS <= 1 {
		t.Fatalf("ready %+v %v", ready, err)
	}
	other := in
	other.InstallID = uuid.NewString()
	if _, err := f.svc.AcceptInvite(t.Context(), other); !errors.Is(err, ErrReadmissionDeviceUnavailable) {
		t.Fatalf("retargeted consent %v", err)
	}
	if err := f.svc.DeclineAccountInvite(t.Context(), f.joiner, r.InviteID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.AcceptInvite(t.Context(), in); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("declined request revived %v", err)
	}
	if ready, err := f.svc.ListMemberReadmissions(t.Context(), f.vault, f.owner); err != nil || len(ready) != 0 {
		t.Fatalf("declined ready %+v %v", ready, err)
	}
}

func TestMemberReadmissionReplacesOnlyUnconsentedInvite(t *testing.T) {
	f, install, _ := readmissionFixture(t)
	original := readmissionCreate(t, f)
	input := CreateAccountInviteInput{
		VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.joiner, Role: "clerk", ReadmitRemoved: true,
	}
	revised, err := f.svc.CreateAccountInvite(t.Context(), input)
	if err != nil || !revised.MemberReadmission || revised.InviteID == original.InviteID {
		t.Fatalf("revised invitation %+v %v", revised, err)
	}
	accept := AcceptInviteInput{Token: original.InviteToken, AccountID: f.joiner, InstallID: install, MemberReadmission: true}
	if _, err := f.svc.AcceptInvite(t.Context(), accept); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("old invitation was still usable: %v", err)
	}
	accept.Token = revised.InviteToken
	if out, err := f.svc.AcceptInvite(t.Context(), accept); err != nil || !out.ReadmissionPending || out.Role != "clerk" {
		t.Fatalf("consent to revised invitation %+v %v", out, err)
	}
	input.Role = "viewer"
	if _, err := f.svc.CreateAccountInvite(t.Context(), input); !errors.Is(err, ErrInviteRoleConflict) {
		t.Fatalf("consented invite was replaced: %v", err)
	}
	if out, err := f.svc.MemberReadmissionStatus(t.Context(), f.joiner, install, revised.InviteID); err != nil || !out.ReadmissionPending || out.Role != "clerk" {
		t.Fatalf("recipient consent did not survive: %+v %v", out, err)
	}
}

func TestMemberReadmissionAuthorityAndLegacyFailClosed(t *testing.T) {
	f, install, _ := readmissionFixture(t)
	accountInviteExec(t, f, `UPDATE vault_members SET role='manager' WHERE vault_id=$1::uuid AND account_id=$2::uuid AND revoked_at IS NULL`, f.vault, f.editor)
	if _, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.editor, TargetAccountID: f.joiner, Role: "viewer", ReadmitRemoved: true}); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("manager returning member %v", err)
	}
	var email string
	if err := f.pool.QueryRow(t.Context(), `SELECT email FROM accounts WHERE id=$1::uuid`, f.joiner).Scan(&email); err != nil {
		t.Fatal(err)
	}
	for _, mail := range []string{"", email} {
		invite, err := f.svc.CreateInvite(t.Context(), CreateInviteInput{VaultID: f.vault, InviterAccID: f.owner, Email: mail, Role: "viewer"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: strings.TrimPrefix(invite.InviteURL, "https://kaata.af/i/"), AccountID: f.joiner, InstallID: install}); !errors.Is(err, ErrMemberReadmissionRequired) {
			t.Fatalf("legacy restored ACL %q: %v", mail, err)
		}
	}
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: f.token, AccountID: f.joiner, InstallID: install}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("old accepted invite resurrected %v", err)
	}
	r := readmissionCreate(t, f)
	if _, err := f.svc.AccountInviteInfo(t.Context(), f.editor, r.InviteID); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("foreign preview %v", err)
	}
	if _, err := f.svc.ListMemberReadmissions(t.Context(), f.vault, f.editor); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("manager reads consent %v", err)
	}
	accountInviteExec(t, f, `UPDATE vault_members SET role='manager' WHERE vault_id=$1::uuid AND account_id=$2::uuid AND revoked_at IS NULL`, f.vault, f.owner)
	if _, err := f.svc.AccountInviteInfo(t.Context(), f.joiner, r.InviteID); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("former-owner preview %v", err)
	}
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner, InstallID: install, MemberReadmission: true}); !errors.Is(err, ErrReadmissionDeviceUnavailable) {
		t.Fatalf("former-owner grant %v", err)
	}
}

func TestMemberReadmissionReadyInvalidation(t *testing.T) {
	for _, scenario := range []string{"expiry", "rotated_key", "signed_out", "account_switch", "recipient_deletion", "new_removal", "explicit_device_removal", "same_key_alias_removal", "foreign_device_binding", "foreign_key_binding", "unpublished_other_device_removal", "owner_demoted_and_restored"} {
		t.Run(scenario, func(t *testing.T) {
			f, install, pub := readmissionFixture(t)
			r := readmissionCreate(t, f)
			in := AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner, InstallID: install, MemberReadmission: true}
			if _, err := f.svc.AcceptInvite(t.Context(), in); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "expiry":
				accountInviteExec(t, f, `UPDATE vault_members SET invite_expires_at=NOW()-INTERVAL '1 minute' WHERE invite_request_id=$1::uuid`, r.InviteID)
			case "rotated_key":
				accountInviteExec(t, f, `UPDATE device_keys SET ed25519_pubkey=$2 WHERE install_id=$1::uuid`, install, bytes.Repeat([]byte{8}, 32))
			case "signed_out":
				accountInviteExec(t, f, `DELETE FROM auth_credentials WHERE install_id=$1::uuid`, install)
			case "account_switch":
				accountInviteExec(t, f, `UPDATE installs SET account_id=$2::uuid WHERE install_id=$1::uuid`, install, f.editor)
			case "recipient_deletion":
				accountInviteExec(t, f, `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.joiner)
			case "owner_demoted_and_restored":
				accountInviteExec(t, f, `UPDATE vault_members SET role='manager',last_change_hlc_ms=last_change_hlc_ms+1 WHERE vault_id=$1::uuid AND account_id=$2::uuid AND revoked_at IS NULL`, f.vault, f.owner)
				accountInviteExec(t, f, `UPDATE vault_members SET role='owner',last_change_hlc_ms=last_change_hlc_ms+1 WHERE vault_id=$1::uuid AND account_id=$2::uuid AND revoked_at IS NULL`, f.vault, f.owner)
			case "foreign_device_binding":
				accountInviteExec(t, f, `UPDATE vault_devices SET account_id=$3::uuid WHERE vault_id=$1::uuid AND device_id=$2::uuid`, f.vault, install, f.editor)
			case "foreign_key_binding":
				accountInviteExec(t, f, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms) VALUES($1::uuid,$2::uuid,$3,$4::uuid,1)`, f.vault, uuid.NewString(), pub, f.editor)
			case "unpublished_other_device_removal":
				accountInviteExec(t, f, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms) VALUES($1::uuid,$2::uuid,$3,$4::uuid,1)`, f.vault, uuid.NewString(), bytes.Repeat([]byte{9}, 32), f.joiner)
			case "new_removal":
				accountInviteExec(t, f, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at,revoked_at,last_change_hlc_ms) VALUES($1::uuid,$2::uuid,'viewer',NOW(),NOW()+INTERVAL '1 second',$3)`, f.vault, f.joiner, time.Now().UnixMilli()+1000)
			case "explicit_device_removal", "same_key_alias_removal":
				removedDevice := install
				if scenario == "same_key_alias_removal" {
					removedDevice = uuid.NewString()
					accountInviteExec(t, f, `INSERT INTO vault_devices(vault_id,device_id,device_pubkey,account_id,added_at_ms,removed_at_ms) VALUES($1::uuid,$2::uuid,$3,$4::uuid,1,2)`, f.vault, removedDevice, pub, f.joiner)
				}
				accountInviteExec(t, f, `INSERT INTO events(event_id,vault_id,server_seq,event_type,schema_version,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,payload) VALUES($1::uuid,$2::uuid,1,'vault_device_removed',1,1,0,$3::uuid,$3::uuid,jsonb_build_object('device_id',$4::text))`, uuid.NewString(), f.vault, uuid.NewString(), removedDevice)
			}
			if ready, err := f.svc.ListMemberReadmissions(t.Context(), f.vault, f.owner); err != nil || len(ready) != 0 {
				t.Fatalf("stale consent remained ready %+v %v", ready, err)
			}
			if _, err := f.svc.AcceptInvite(t.Context(), in); err == nil {
				t.Fatal("stale consent retry succeeded")
			}
			if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid AND accepted_at IS NOT NULL AND revoked_at IS NULL`, f.vault, f.joiner) != 0 {
				t.Fatal("invalid consent restored ACL")
			}
		})
	}
}

func TestMemberReadmissionStatusIsReadOnlyAndSessionBound(t *testing.T) {
	f, install, _ := readmissionFixture(t)
	r := readmissionCreate(t, f)
	router := accountInvitesRouter(f.svc)
	path := "/v1/vaults/invites/requests/" + r.InviteID + "/readmission"
	get := func(account, device string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("GET", path, nil)
		if account != "" {
			token, err := auth.SignSession(creditPermissionTestSecret, account, device, "google", "status-test")
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, request)
		return w
	}
	if w := get("", install); w.Code != 401 {
		t.Fatalf("anonymous status %d", w.Code)
	}
	if w := get(f.joiner, install); w.Code != 404 {
		t.Fatalf("status initialized consent %d %s", w.Code, w.Body.String())
	}
	in := AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner, InstallID: install, MemberReadmission: true}
	if _, err := f.svc.AcceptInvite(t.Context(), in); err != nil {
		t.Fatal(err)
	}
	var before, after string
	if err := f.pool.QueryRow(t.Context(), `SELECT row_to_json(vm)::text FROM vault_members vm WHERE invite_request_id=$1::uuid`, r.InviteID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	audits := graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`)
	for i := 0; i < 3; i++ {
		if w := get(f.joiner, install); w.Code != 200 || !strings.Contains(w.Body.String(), `"member_readmission":true`) || !strings.Contains(w.Body.String(), `"readmission_pending":true`) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("pending status %d %s", w.Code, w.Body.String())
		}
	}
	if w := get(f.editor, install); w.Code != 404 {
		t.Fatalf("foreign status %d", w.Code)
	}
	if w := get(f.joiner, uuid.NewString()); w.Code != 409 {
		t.Fatalf("changed-device status %d", w.Code)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT row_to_json(vm)::text FROM vault_members vm WHERE invite_request_id=$1::uuid`, r.InviteID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after || audits != graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`) {
		t.Fatal("status polling mutated consent or audit history")
	}
	memberEvent, deviceEvent := uuid.NewString(), uuid.NewString()
	accountInviteExec(t, f, `UPDATE vault_members SET account_id=invite_account_id,accepted_at=NOW(),readmission_member_event_id=$2::uuid,readmission_device_event_id=$3::uuid WHERE invite_request_id=$1::uuid`, r.InviteID, memberEvent, deviceEvent)
	if w := get(f.joiner, install); w.Code != 200 || !strings.Contains(w.Body.String(), memberEvent) || !strings.Contains(w.Body.String(), deviceEvent) || strings.Contains(w.Body.String(), `"readmission_pending":true`) {
		t.Fatalf("completed status %d %s", w.Code, w.Body.String())
	}
	ordinary := accountInviteCreate(t, f, f.owner, accountInviteSeed(t, f), "viewer")
	if _, err := f.svc.MemberReadmissionStatus(t.Context(), f.joiner, install, ordinary.InviteID); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("ordinary invitation status accepted: %v", err)
	}
}

func TestMemberReadmissionCompletedSeatSurvivesHistoryAndPromotion(t *testing.T) {
	f, install, _ := readmissionFixture(t)
	r := readmissionCreate(t, f)
	in := AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner, InstallID: install, MemberReadmission: true}
	if _, err := f.svc.AcceptInvite(t.Context(), in); err != nil {
		t.Fatal(err)
	}
	memberEvent, deviceEvent := uuid.NewString(), uuid.NewString()
	accountInviteExec(t, f, `UPDATE vault_members SET accepted_at=NOW(),account_id=invite_account_id,
 readmission_member_event_id=$2::uuid,readmission_device_event_id=$3::uuid WHERE invite_request_id=$1::uuid`, r.InviteID, memberEvent, deviceEvent)
	out, err := f.svc.AcceptInvite(t.Context(), in)
	if err != nil || out.ReadmissionPending || out.ReadmissionMemberEventID != memberEvent || out.ReadmissionDeviceEventID != deviceEvent {
		t.Fatalf("completed retry %+v %v", out, err)
	}
	accountInviteExec(t, f, `UPDATE vault_members SET role='manager' WHERE invite_request_id=$1::uuid`, r.InviteID)
	accountInviteExec(t, f, `DELETE FROM vault_members WHERE id=(SELECT readmission_from_id FROM vault_members WHERE invite_request_id=$1::uuid)`, r.InviteID)
	accountInviteExec(t, f, `DELETE FROM vault_members WHERE id=(SELECT readmission_owner_member_id FROM vault_members WHERE invite_request_id=$1::uuid)`, r.InviteID)
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_request_id=$1::uuid AND accepted_at IS NOT NULL AND role='manager'`, r.InviteID) != 1 {
		t.Fatal("historical evidence deletion deleted current seat")
	}
	accountInviteExec(t, f, `UPDATE vault_devices SET removed_at_ms=99 WHERE vault_id=$1::uuid AND device_id=$2::uuid`, f.vault, install)
	if _, err := f.svc.AcceptInvite(t.Context(), in); !errors.Is(err, ErrReadmissionDeviceUnavailable) {
		t.Fatalf("removed returning device received completion: %v", err)
	}
}

func TestMemberReadmissionApprovalLocksCurrentDeviceAndCredential(t *testing.T) {
	f, install, _ := readmissionFixture(t)
	r := readmissionCreate(t, f)
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner, InstallID: install, MemberReadmission: true}); err != nil {
		t.Fatal(err)
	}
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := lockInviteAccounts(t.Context(), tx, f.owner, f.joiner); err != nil {
		t.Fatal(err)
	}
	if err := requireOwner(t.Context(), tx, f.vault, f.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := memberreadmission.LoadReadyForApproval(t.Context(), tx, f.vault, r.InviteID, f.owner); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{`UPDATE device_keys SET ed25519_pubkey=decode(repeat('08',32),'hex') WHERE install_id=$1::uuid`, `DELETE FROM auth_credentials WHERE install_id=$1::uuid`} {
		other, err := f.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = other.Exec(t.Context(), `SET LOCAL lock_timeout='100ms'`); err != nil {
			t.Fatal(err)
		}
		_, err = other.Exec(t.Context(), sql, install)
		_ = other.Rollback(t.Context())
		var dbErr *pgconn.PgError
		if !errors.As(err, &dbErr) || dbErr.Code != "55P03" {
			t.Fatalf("device/session mutation did not wait for approval transaction: %v", err)
		}
	}
}
