package vaults

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

type liveInvalidationProbe func(vaultID, accountID string)

func (probe liveInvalidationProbe) InvalidateMembership(vaultID, accountID string) {
	probe(vaultID, accountID)
}

// Read through the pool, outside the writer's transaction. A callback before
// commit would observe missing creation or the old name/archive state, exactly
// like a connected browser immediately following the notification with a read.
func expectCommittedLiveInvalidation(t *testing.T, f *graceVaultFixture, vaultID, accountID, name string, archived bool) *int {
	t.Helper()
	calls := new(int)
	f.svc.SetMembershipInvalidator(liveInvalidationProbe(func(gotVault, gotAccount string) {
		t.Helper()
		*calls++
		if gotVault != vaultID || gotAccount != accountID {
			t.Fatalf("notification = (%s, %s), want (%s, %s)", gotVault, gotAccount, vaultID, accountID)
		}
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
		defer cancel()
		var gotName string
		var gotArchived, activeMember bool
		if err := f.pool.QueryRow(ctx, `SELECT v.name, v.archived_at IS NOT NULL,
		 EXISTS(SELECT 1 FROM vault_members m WHERE m.vault_id=v.vault_id AND m.account_id=$2::uuid
		 AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL)
		 FROM vaults v WHERE v.vault_id=$1::uuid`, gotVault, gotAccount).
			Scan(&gotName, &gotArchived, &activeMember); err != nil {
			t.Fatalf("notification arrived before committed data was visible: %v", err)
		}
		if gotName != name || gotArchived != archived || !activeMember {
			t.Fatalf("notification saw name=%q archived=%v member=%v; want name=%q archived=%v member=true",
				gotName, gotArchived, activeMember, name, archived)
		}
	}))
	return calls
}

func TestLiveInvalidationCreateAfterCommit(t *testing.T) {
	f := newGraceVaultFixture(t)
	vaultID := uuid.NewString()
	calls := expectCommittedLiveInvalidation(t, f, vaultID, f.owner, "New browser kaata", false)
	input := CreateInput{AccountID: f.owner, VaultID: vaultID, Name: "New browser kaata", Currency: "AFN"}
	if _, err := f.svc.Create(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("create notifications = %d, want 1", *calls)
	}
	input.AccountID = f.joiner
	if _, err := f.svc.Create(t.Context(), input); !errors.Is(err, ErrVaultCollision) {
		t.Fatalf("colliding create error = %v, want ErrVaultCollision", err)
	}
	if *calls != 1 {
		t.Fatal("rolled-back create sent a notification")
	}
}

func TestLiveInvalidationRenameAfterCommit(t *testing.T) {
	f := newGraceVaultFixture(t)
	name := "Renamed on another device"
	calls := expectCommittedLiveInvalidation(t, f, f.vault, f.owner, name, false)
	if _, err := f.svc.Update(t.Context(), UpdateInput{VaultID: f.vault, AccountID: f.owner, Name: &name}); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("rename notifications = %d, want 1", *calls)
	}
	if _, err := f.svc.Update(t.Context(), UpdateInput{VaultID: f.vault, AccountID: f.editor, Name: &name}); err == nil {
		t.Fatal("editor unexpectedly renamed a kaata")
	}
	if *calls != 1 {
		t.Fatal("refused rename sent a notification")
	}
}

func TestLiveInvalidationArchiveAfterCommit(t *testing.T) {
	f := newGraceVaultFixture(t)
	calls := expectCommittedLiveInvalidation(t, f, f.vault, f.owner, "Shop", true)
	if _, err := f.svc.Archive(t.Context(), f.vault, f.editor); err == nil {
		t.Fatal("editor unexpectedly archived a kaata")
	}
	if *calls != 0 {
		t.Fatal("refused archive sent a notification")
	}
	result, err := f.svc.Archive(t.Context(), f.vault, f.owner)
	if err != nil || result.Status != "archived" {
		t.Fatalf("archive = %+v, err=%v", result, err)
	}
	if *calls != 1 {
		t.Fatalf("archive notifications = %d, want 1", *calls)
	}
	if _, err := f.svc.Archive(t.Context(), f.vault, f.owner); !errors.Is(err, ErrAlreadyArchived) {
		t.Fatalf("repeated archive error = %v, want ErrAlreadyArchived", err)
	}
	if *calls != 1 {
		t.Fatal("unchanged archive sent another notification")
	}
}

func TestLiveInvalidationMultiOwnerArchiveWaitsForFinalCommit(t *testing.T) {
	f := newGraceVaultFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='owner'
	 WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.editor); err != nil {
		t.Fatal(err)
	}
	calls := expectCommittedLiveInvalidation(t, f, f.vault, f.editor, "Shop", true)
	first, err := f.svc.Archive(t.Context(), f.vault, f.owner)
	if err != nil || first.Status != "pending" {
		t.Fatalf("first concurrence = %+v, err=%v", first, err)
	}
	if *calls != 0 {
		t.Fatal("pending concurrence announced a completed archive")
	}
	last, err := f.svc.Archive(t.Context(), f.vault, f.editor)
	if err != nil || last.Status != "archived" {
		t.Fatalf("final concurrence = %+v, err=%v", last, err)
	}
	if *calls != 1 {
		t.Fatalf("completed archive notifications = %d, want 1", *calls)
	}
}
