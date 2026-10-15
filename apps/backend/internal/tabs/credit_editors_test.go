package tabs

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/credit"
	syncapi "github.com/matee/kaata-backend/internal/sync"
)

func TestCreditRestrictedEditorsSharedAppendReviewAndVoid(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	boundary := time.Now().UnixMilli()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Store", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &boundary})
	if err != nil {
		t.Fatal(err)
	}
	editor := seedAccount(t, f.pool, "credit-editor@example.com", "Editor")
	seedMember(t, f.pool, f.vaultA, editor, "editor")
	p, err := f.svc.PartyByAccount(ctx, created.Tab.ID, editor)
	if err != nil {
		t.Fatal(err)
	}
	owner, peer := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	appendAs := func(as Party, direction, amount string) AppendResult {
		t.Helper()
		r, err := f.svc.Append(ctx, as, AppendInput{ID: uuid.NewString(), Direction: direction, Amount: amount, OccurredAtMS: boundary + 1})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	// Two payments offset the debt. Removing either payment would raise the
	// current 80 balance to 120, above the cap, so review/cancel must check it.
	appendAs(owner, "a_to_b", "160")
	theirs := appendAs(peer, "b_to_a", "40")
	ours := appendAs(owner, "b_to_a", "40")
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',true,1)`, f.vaultA, rel); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "20.01", OccurredAtMS: boundary + 2}); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("editor append bypassed cap: %v", err)
	}
	if _, err := f.svc.Dispute(ctx, p, theirs.Entry.ID, "Correction"); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("editor dispute bypassed cap: %v", err)
	}
	if _, err := f.svc.Void(ctx, p, ours.Entry.ID); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("editor void bypassed cap: %v", err)
	}
	// Accepting a pending row has no balance delta: pending already counts.
	if _, err := f.svc.Accept(ctx, p, theirs.Entry.ID); err != nil {
		t.Fatalf("zero-delta accept: %v", err)
	}
	// A per-member bypass affects both delegated and directly bound accounts.
	if _, err := f.pool.Exec(ctx, `INSERT INTO vault_member_credit_permissions(vault_id,account_id,vault_member_id,credit_limit_override,updated_at_ms)
	 SELECT vault_id,account_id,id,'bypass',1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, editor); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Void(ctx, p, ours.Entry.ID); err != nil {
		t.Fatalf("individual bypass did not apply: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE vault_member_credit_permissions SET credit_limit_override='enforce' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, editor); err != nil {
		t.Fatal(err)
	}
	// Repayment remains lawful while already over the cap.
	appendAs(p, "b_to_a", "1")
}

func TestCreditRestrictedEditorLinkPreservesButCannotIncreaseExposure(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	boundary := time.Now().UnixMilli()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	create := func(amount string) (CreateResult, error) {
		return f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Store", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &boundary,
			Opening: &OpeningInput{Direction: "a_to_b", Amount: amount, OccurredAtMS: boundary - 1}})
	}
	old, err := create("120")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Close(ctx, f.party(t, old.MyToken, old.Tab.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',true,1)`, f.vaultA, rel); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, f.acctA); err != nil {
		t.Fatal(err)
	}
	if _, err := create("121"); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("larger imported opening escaped cap: %v", err)
	}
	if _, err := create("120"); err != nil {
		t.Fatalf("existing over-cap balance must link unchanged: %v", err)
	}
}

func TestCreditEditorEnforceAndBoundOverride(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	boundary := time.Now().UnixMilli()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	editor := seedAccount(t, f.pool, "bound-editor@example.com", "Editor")
	seedMember(t, f.pool, f.vaultA, editor, "editor")
	created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Store", AccountID: &editor, VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &boundary})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',1)`, f.vaultA, rel); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO vault_member_credit_permissions(vault_id,account_id,vault_member_id,credit_limit_override,updated_at_ms)
	 SELECT vault_id,account_id,id,'enforce',1 FROM vault_members WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, editor); err != nil {
		t.Fatal(err)
	}
	p, err := f.svc.PartyByAccount(ctx, created.Tab.ID, editor)
	if err != nil {
		t.Fatal(err)
	}
	if p.BoundMemberRole != "editor" || p.MemberRole != "" {
		t.Fatalf("bound editor role: %+v", p)
	}
	if _, err := f.svc.Append(ctx, p, AppendInput{ID: uuid.NewString(), Direction: "a_to_b", Amount: "101", OccurredAtMS: boundary + 1}); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("bound editor individual enforce: %v", err)
	}
}

func TestCreditRestrictedEditorCannotCloseIntoLargerHistoricalPeriod(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	rel := uuid.NewString()
	boundary := time.Now().UnixMilli()
	f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
	create := func(amount string, linked int64) CreateResult {
		t.Helper()
		r, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Store", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &linked,
			Opening: &OpeningInput{Direction: "a_to_b", Amount: amount, OccurredAtMS: boundary - 100}})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	old := create("120", boundary)
	if _, err := f.svc.Close(ctx, f.party(t, old.MyToken, old.Tab.ID)); err != nil {
		t.Fatal(err)
	}
	current := create("80", boundary-1)
	if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',true,1)`, f.vaultA, rel); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, f.acctA); err != nil {
		t.Fatal(err)
	}
	p, err := f.svc.PartyByAccount(ctx, current.Tab.ID, f.acctA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Close(ctx, p); !errors.Is(err, credit.ErrLimit) {
		t.Fatalf("closing restored larger old period: %v", err)
	}
}

func TestCreditRestrictedEditorCannotImportOverLimitAccount(t *testing.T) {
	for _, action := range []string{"bind", "join"} {
		t.Run(action, func(t *testing.T) {
			f := newTabFixture(t)
			ctx := context.Background()
			rel := uuid.NewString()
			boundary := time.Now().UnixMilli()
			f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
			if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',true,1)`, f.vaultA, rel); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, f.acctA); err != nil {
				t.Fatal(err)
			}
			for _, amount := range []string{"101", "80"} {
				account, direction := &f.acctA, "a_to_b"
				if action == "join" {
					account, direction = &f.acctB, "b_to_a"
				}
				created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Account", AccountID: account,
					Opening: &OpeningInput{Direction: direction, Amount: amount, OccurredAtMS: boundary - 1}})
				if err != nil {
					t.Fatal(err)
				}
				if action == "bind" {
					var p Party
					p, err = f.svc.PartyByAccount(ctx, created.Tab.ID, f.acctA)
					if err != nil {
						t.Fatal(err)
					}
					_, err = f.svc.Bind(ctx, p, BindInput{AccountID: f.acctA, VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &boundary})
				} else {
					p := f.party(t, created.InviteToken, created.Tab.ID)
					_, err = f.svc.Join(ctx, p, JoinInput{Label: "Store", AccountID: &f.acctA, VaultID: &f.vaultA, RelationshipID: &rel, LinkedAtMS: &boundary})
				}
				if amount == "101" && !errors.Is(err, credit.ErrLimit) {
					t.Fatalf("%s imported over-limit history: %v", action, err)
				}
				if amount == "80" && err != nil {
					t.Fatalf("%s safe imported history: %v", action, err)
				}
			}
		})
	}
}

func TestCreditPartialBindingRechecksVaultBeforeAdmission(t *testing.T) {
	for _, action := range []string{"bind", "join"} {
		t.Run(action, func(t *testing.T) {
			f := newTabFixture(t)
			ctx := context.Background()
			rel := uuid.NewString()
			boundary := time.Now().UnixMilli()
			f.svc.SetCreditBalanceReader(syncapi.CreditBalance)
			if _, err := f.pool.Exec(ctx, `INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,restrict_editors,updated_at_ms) VALUES($1::uuid,$2::uuid,10000,10000,'clerk_block',true,1)`, f.vaultA, rel); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET role='editor' WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultA, f.acctA); err != nil {
				t.Fatal(err)
			}
			created, err := f.svc.Create(ctx, CreateInput{Currency: "AFN", Label: "Account", AccountID: &f.acctA,
				Opening: &OpeningInput{Direction: "a_to_b", Amount: "101", OccurredAtMS: boundary - 1}})
			if err != nil {
				t.Fatal(err)
			}
			stale, err := f.svc.PartyByAccount(ctx, created.Tab.ID, f.acctA)
			if err != nil {
				t.Fatal(err)
			}
			// Another request binds only the vault after the first resolution.
			if _, err := f.svc.Bind(ctx, stale, BindInput{AccountID: f.acctA, VaultID: &f.vaultA}); err != nil {
				t.Fatal(err)
			}
			// A partial stale request must not import history using its obsolete
			// belief that this party has no kaata and needs no admission lock.
			if action == "bind" {
				_, err = f.svc.Bind(ctx, stale, BindInput{AccountID: f.acctA, RelationshipID: &rel, LinkedAtMS: &boundary})
			} else {
				_, err = f.svc.Join(ctx, stale, JoinInput{Label: "Store", AccountID: &f.acctA, RelationshipID: &rel, LinkedAtMS: &boundary})
			}
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("%s stale vault selector bypassed recheck: %v", action, err)
			}
		})
	}
}
