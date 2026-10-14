package vaults

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

// A lost accept response must be retryable, but an old consumed invitation
// must not tell a removed member that joining succeeded. The later witness
// request correctly refuses that membership, leaving old clients showing a
// joined kaata that cannot sync.
func TestAcceptInviteRetryHonorsMembershipRevocation(t *testing.T) {
	for _, removal := range []string{"owner revokes", "member leaves"} {
		t.Run(removal, func(t *testing.T) {
			f := newGraceVaultFixture(t)
			ctx := t.Context()
			input := AcceptInviteInput{Token: f.token, AccountID: f.joiner, InstallID: uuid.NewString()}
			accepted, err := f.svc.AcceptInvite(ctx, input)
			if err != nil {
				t.Fatalf("first accept: %v", err)
			}
			if accepted.VaultID != f.vault || accepted.Role != "viewer" {
				t.Fatalf("first accept = %+v", accepted)
			}
			audits := graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`)
			for _, expired := range []bool{false, true} {
				if expired {
					if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET invite_expires_at=NOW()-INTERVAL '1 day'
					 WHERE invite_token_hash=$1`, hashInviteToken(f.token)); err != nil {
						t.Fatal(err)
					}
				}
				retried, err := f.svc.AcceptInvite(ctx, input)
				if err != nil || retried != accepted {
					t.Fatalf("active accepted retry (expired=%t) = %+v, %v; want %+v", expired, retried, err, accepted)
				}
				if got := graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`); got != audits {
					t.Fatalf("idempotent retry emitted an audit: %d -> %d", audits, got)
				}
			}
			// Another signed-in account cannot claim the consumed token.
			if _, err := f.svc.AcceptInvite(ctx, AcceptInviteInput{
				Token: f.token, AccountID: f.editor, InstallID: uuid.NewString(),
			}); !errors.Is(err, ErrInviteNotFound) {
				t.Fatalf("other-account retry = %v, want ErrInviteNotFound", err)
			}
			if removal == "owner revokes" {
				_, err = f.svc.RevokeMember(ctx, RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: f.joiner})
			} else {
				_, err = f.svc.Leave(ctx, f.vault, f.joiner)
			}
			if err != nil {
				t.Fatalf("remove accepted member: %v", err)
			}
			audits = graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`)
			epoch := graceVaultCount(t, f, `SELECT vault_epoch FROM vaults WHERE vault_id=$1::uuid`, f.vault)
			if _, err := f.svc.AcceptInvite(ctx, input); !errors.Is(err, ErrInviteNotFound) {
				t.Fatalf("removed-member retry = %v, want ErrInviteNotFound", err)
			}
			if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members
			 WHERE vault_id=$1::uuid AND account_id=$2::uuid AND revoked_at IS NOT NULL`, f.vault, f.joiner) != 1 ||
				graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`) != audits ||
				graceVaultCount(t, f, `SELECT vault_epoch FROM vaults WHERE vault_id=$1::uuid`, f.vault) != epoch {
				t.Fatal("refused retry changed membership, audit history, or vault epoch")
			}
		})
	}
}
