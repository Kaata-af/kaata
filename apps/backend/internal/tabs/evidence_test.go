package tabs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func evidenceParties(t *testing.T, f *tabFixture) (CreateResult, Party, Party) {
	t.Helper()
	ctx := context.Background()
	c := f.create(t, "Store A", "", "")
	if _, err := f.svc.Bind(ctx, f.party(t, c.MyToken, c.Tab.ID), BindInput{AccountID: f.acctA, VaultID: &f.vaultA}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Bind(ctx, f.party(t, c.InviteToken, c.Tab.ID), BindInput{AccountID: f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	a, err := f.svc.PartyByAccount(ctx, c.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.svc.PartyByAccount(ctx, c.Tab.ID, f.acctB)
	if err != nil {
		t.Fatal(err)
	}
	return c, a, b
}

func TestSharedEvidenceSurvivesDeletedStaffAccounts(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	c, ownerA, _ := evidenceParties(t, f)
	writerID := seedAccount(t, f.pool, "writer-evidence@example.com", "Writer at action")
	reviewerID := seedAccount(t, f.pool, "reviewer-evidence@example.com", "Reviewer at action")
	seedMember(t, f.pool, f.vaultA, writerID, "clerk")
	seedMember(t, f.pool, f.vaultB, reviewerID, "editor")
	writer, err := f.svc.PartyByAccount(ctx, c.Tab.ID, writerID)
	if err != nil {
		t.Fatal(err)
	}
	reviewer, err := f.svc.PartyByAccount(ctx, c.Tab.ID, reviewerID)
	if err != nil {
		t.Fatal(err)
	}
	entry := f.append(t, writer, "a_to_b", "500.25", time.Now().UnixMilli()).Entry
	accepted, err := f.svc.Accept(ctx, reviewer, entry.ID, entry.Rev)
	if err != nil {
		t.Fatal(err)
	}
	e := accepted.Entry
	if e.AuthorMemberRole == nil || *e.AuthorMemberRole != "clerk" || e.ReviewerMemberRole == nil || *e.ReviewerMemberRole != "editor" ||
		e.ReviewerAccountID == nil || *e.ReviewerAccountID != reviewerID || e.ReviewerParty == nil || *e.ReviewerParty != "b" ||
		e.ReviewSemanticsVersion == nil || *e.ReviewSemanticsVersion != reviewSemanticsVersion || e.StatusAtMS == nil {
		t.Fatalf("missing actual action evidence: %+v", e)
	}
	// Profile changes and identical retries must not replace the first review.
	if _, err = f.pool.Exec(ctx, `UPDATE accounts SET name='Renamed later' WHERE id=$1::uuid`, reviewerID); err != nil {
		t.Fatal(err)
	}
	retry, err := f.svc.Accept(ctx, reviewer, entry.ID)
	if err != nil || retry.Entry.ReviewerName != "Reviewer at action" || retry.Entry.Rev != e.Rev || *retry.Entry.StatusAtMS != *e.StatusAtMS {
		t.Fatalf("retry changed evidence: %+v %v", retry.Entry, err)
	}
	if _, err = f.svc.Dispute(ctx, reviewer, entry.ID, "changed mind"); !errors.Is(err, ErrReviewFinal) {
		t.Fatalf("review was not final: %v", err)
	}
	// Exercise the actual FK actions; these staff accounts own no vaults.
	for _, id := range []string{writerID, reviewerID} {
		if _, err = f.pool.Exec(ctx, `DELETE FROM vault_members WHERE account_id=$1::uuid`, id); err != nil {
			t.Fatal(err)
		}
		if _, err = f.pool.Exec(ctx, `DELETE FROM accounts WHERE id=$1::uuid`, id); err != nil {
			t.Fatal(err)
		}
	}
	page, err := f.svc.Get(ctx, ownerA, 0)
	if err != nil || len(page.Entries) != 1 {
		t.Fatalf("read retained record: %+v %v", page, err)
	}
	got := page.Entries[0]
	if got.AuthorAccountID == nil || *got.AuthorAccountID != writerID || got.AuthorName != "Writer at action" ||
		got.ReviewerAccountID == nil || *got.ReviewerAccountID != reviewerID || got.ReviewerName != "Reviewer at action" ||
		got.Status != "accepted" || got.StatusAtMS == nil || *got.StatusAtMS != *e.StatusAtMS {
		t.Fatalf("deletion erased shared evidence: %+v", got)
	}
	inbox, err := f.svc.listInbox(ctx, f.acctA, "en", 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range inbox.Items {
		if item.EntryID == entry.ID && item.Kind == "entry_accepted" && strings.Contains(item.Body, "Reviewer at action") {
			found = true
		}
	}
	if !found {
		t.Fatalf("retained acknowledgement lost reviewer name: %+v", inbox)
	}
	// A caller resolved before erasure cannot append or review after it.
	if _, err = f.svc.Append(ctx, writer, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "1", OccurredAtMS: time.Now().UnixMilli()}); !errors.Is(err, ErrAuthRequired) {
		t.Fatalf("deleted writer retained authority: %v", err)
	}
	if _, err = f.svc.Accept(ctx, reviewer, entry.ID); !errors.Is(err, ErrAuthRequired) {
		t.Fatalf("deleted reviewer retained authority: %v", err)
	}
	if _, err = f.pool.Exec(ctx, `UPDATE tab_parties SET install_id=NULL,last_seen_at=NULL WHERE tab_id=$1::uuid AND role='b'`, c.Tab.ID); err != nil {
		t.Fatal(err)
	}
	staleInstall := uuid.NewString()
	f.svc.touchParty(ctx, reviewer, &staleInstall)
	var touched bool
	if err = f.pool.QueryRow(ctx, `SELECT install_id IS NOT NULL OR last_seen_at IS NOT NULL FROM tab_parties WHERE tab_id=$1::uuid AND role='b'`, c.Tab.ID).Scan(&touched); err != nil || touched {
		t.Fatalf("stale read repopulated deleted actor metadata: touched=%v err=%v", touched, err)
	}
}

func TestSharedEvidenceMigrationDoesNotInventHistory(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	_, a, b := evidenceParties(t, f)
	known := f.append(t, a, "a_to_b", "10", time.Now().UnixMilli()).Entry
	if _, err := f.svc.Accept(ctx, b, known.ID); err != nil {
		t.Fatal(err)
	}
	unknown := f.append(t, a, "a_to_b", "20", time.Now().UnixMilli()).Entry
	if _, err := f.pool.Exec(ctx, `UPDATE tab_entries SET status='accepted',status_at_ms=123 WHERE id=$1::uuid`, unknown.ID); err != nil {
		t.Fatal(err)
	}
	legacy := f.append(t, a, "a_to_b", "30", time.Now().UnixMilli()).Entry
	if _, err := f.svc.Accept(ctx, b, legacy.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE tab_notifications SET actor_account_id=NULL,actor_label='Legacy shop label'
	 WHERE entry_id=$1::uuid AND event_kind='entry_accepted'`, legacy.ID); err != nil {
		t.Fatal(err)
	}
	// Recreate exactly the pre-migration schema for the historical backfill.
	if _, err := f.pool.Exec(ctx, `ALTER TABLE tab_entries DROP COLUMN author_evidence_account_id,
	 DROP COLUMN author_member_role, DROP COLUMN reviewer_account_id, DROP COLUMN reviewer_name,
	 DROP COLUMN reviewer_party, DROP COLUMN reviewer_member_role, DROP COLUMN review_semantics_version`); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile(filepath.Join("..", "db", "migrations", "049_tab_evidence.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	page, err := f.svc.Get(ctx, a, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range page.Entries {
		if e.AuthorMemberRole != nil || e.ReviewerMemberRole != nil || e.ReviewSemanticsVersion != nil {
			t.Fatalf("invented historical role or semantics: %+v", e)
		}
		if e.ID == known.ID && (e.ReviewerAccountID == nil || *e.ReviewerAccountID != f.acctB || e.ReviewerName != "Ahmad" || e.ReviewerParty == nil || *e.ReviewerParty != "b") {
			t.Fatalf("lost trustworthy historical review: %+v", e)
		}
		if e.ID == unknown.ID && (e.ReviewerAccountID != nil || e.ReviewerName != "" || e.ReviewerParty != nil) {
			t.Fatalf("invented unknown reviewer: %+v", e)
		}
		if e.ID == legacy.ID && (e.ReviewerAccountID != nil || e.ReviewerName != "" || e.ReviewerParty == nil || *e.ReviewerParty != "b") {
			t.Fatalf("legacy party label became an individual reviewer: %+v", e)
		}
	}
}

func TestMutationRechecksCurrentStaffAuthority(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	c, a, _ := evidenceParties(t, f)
	reviewerID := seedAccount(t, f.pool, "demoted-reviewer@example.com", "Reviewer")
	seedMember(t, f.pool, f.vaultB, reviewerID, "editor")
	p, err := f.svc.PartyByAccount(ctx, c.Tab.ID, reviewerID)
	if err != nil {
		t.Fatal(err)
	}
	e := f.append(t, a, "a_to_b", "10", time.Now().UnixMilli()).Entry
	if _, err = f.pool.Exec(ctx, `UPDATE vault_members SET role='viewer' WHERE account_id=$1::uuid`, reviewerID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Accept(ctx, p, e.ID); !errors.Is(err, ErrRoleInsufficient) {
		t.Fatalf("stale editor authority accepted: %v", err)
	}
	if _, err = f.pool.Exec(ctx, `UPDATE vault_members SET revoked_at=NOW() WHERE account_id=$1::uuid`, reviewerID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.svc.Close(ctx, p); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked member closed tab: %v", err)
	}
}
