package tabs

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestHistorySnapshotCoversOlderLegacyVerdictsNotOnlyLatestRevision(t *testing.T) {
	for _, route := range []string{"create", "join", "bind"} {
		t.Run(route, func(t *testing.T) {
			f := newTabFixture(t)
			ctx := context.Background()
			rel := uuid.NewString()
			first, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "First", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &rel, Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 100}})
			if err != nil {
				t.Fatal(err)
			}
			firstA := f.party(t, first.MyToken, first.Tab.ID)
			if _, err := f.svc.Accept(ctx, f.party(t, first.InviteToken, first.Tab.ID), first.Entries[0].ID); err != nil {
				t.Fatal(err)
			}
			closed1, err := f.svc.Close(ctx, firstA)
			if err != nil {
				t.Fatal(err)
			}
			second, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Newer rejected checkpoint", AccountID: &f.acctA,
				VaultID: &f.vaultA, RelationshipID: &rel, Opening: &OpeningInput{Direction: "a_to_b", Amount: "300", OccurredAtMS: 200},
				ExpectedPreviousTabID: &first.Tab.ID, ExpectedPreviousRev: &closed1.Tab.Rev})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.svc.Dispute(ctx, f.party(t, second.InviteToken, second.Tab.ID), second.Entries[0].ID, "Not agreed"); err != nil {
				t.Fatal(err)
			}
			closed2, err := f.svc.Close(ctx, f.party(t, second.MyToken, second.Tab.ID))
			if err != nil {
				t.Fatal(err)
			}
			// Legacy records could already have a pending older proposal under
			// this newer period. Its last review must invalidate a source snapshot
			// even though the newest period's own revision does not move.
			pendingID := uuid.NewString()
			if _, err := f.pool.Exec(ctx, `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at_ms,status)
			 VALUES($1::uuid,$2::uuid,2,2,'b','b_to_a',10000,'entry',101,'pending')`, pendingID, first.Tab.ID); err != nil {
				t.Fatal(err)
			}
			var beforeRev int64
			if err := f.pool.QueryRow(ctx, `UPDATE tabs SET rev=rev+1 WHERE id=$1::uuid RETURNING rev`, first.Tab.ID).Scan(&beforeRev); err != nil {
				t.Fatal(err)
			}
			snapshot := map[string]int64{first.Tab.ID: beforeRev, second.Tab.ID: closed2.Tab.Rev}
			if _, err := f.svc.Accept(ctx, firstA, pendingID); err != nil {
				t.Fatal(err)
			}
			var candidate *CreateResult
			if route != "create" {
				c, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Candidate", AccountID: &f.acctA,
					Opening: &OpeningInput{Direction: "a_to_b", Amount: "200", OccurredAtMS: 300}})
				if err != nil {
					t.Fatal(err)
				}
				candidate = &c
			}
			try := func(receipt map[string]int64) error {
				if route == "create" {
					_, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Third", AccountID: &f.acctA,
						VaultID: &f.vaultA, RelationshipID: &rel, Opening: &OpeningInput{Direction: "a_to_b", Amount: "200", OccurredAtMS: 300},
						ExpectedPreviousTabID: &second.Tab.ID, ExpectedPreviousRev: &closed2.Tab.Rev, ExpectedHistoryRevisions: receipt})
					return err
				}
				p := f.party(t, candidate.MyToken, candidate.Tab.ID)
				if route == "join" {
					_, err := f.svc.Join(ctx, p, JoinInput{Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel,
						ExpectedPreviousTabID: &second.Tab.ID, ExpectedPreviousRev: &closed2.Tab.Rev, ExpectedHistoryRevisions: receipt})
					return err
				}
				_, err := f.svc.Bind(ctx, p, BindInput{AccountID: f.acctA, VaultID: &f.vaultA, RelationshipID: &rel,
					ExpectedPreviousTabID: &second.Tab.ID, ExpectedPreviousRev: &closed2.Tab.Rev, ExpectedHistoryRevisions: receipt})
				return err
			}
			for _, bad := range []map[string]int64{
				nil, {second.Tab.ID: closed2.Tab.Rev}, snapshot,
				{first.Tab.ID: beforeRev + 1, second.Tab.ID: closed2.Tab.Rev, uuid.NewString(): 1},
			} {
				if err := try(bad); !errors.Is(err, ErrSharedHistoryChanged) {
					t.Fatalf("%s admitted stale/incomplete source snapshot: %v", route, err)
				}
			}
			fresh, err := f.svc.Get(ctx, firstA, 0)
			if err != nil {
				t.Fatal(err)
			}
			latest, err := f.svc.Get(ctx, f.party(t, second.MyToken, second.Tab.ID), 0)
			if err != nil || latest.Tab.Rev != closed2.Tab.Rev {
				t.Fatalf("fixture unexpectedly changed latest period revision: %v", err)
			}
			if err := try(map[string]int64{first.Tab.ID: fresh.Tab.Rev, second.Tab.ID: closed2.Tab.Rev}); err != nil {
				t.Fatalf("fresh complete source snapshot refused: %v", err)
			}
		})
	}
}
