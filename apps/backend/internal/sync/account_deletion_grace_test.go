package sync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func graceCreditRequest(t *testing.T, f *m1Fixture, method, body string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := auth.SignSession(testJWTSecret, f.accountID, uuid.NewString(), "google", "sub-x")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, "/v1/sync/credit-limits?vault_id="+f.vaultID, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	// Deliberately bypass the DB revocation cache, representing a request that
	// was authenticated before deletion. The save transaction is the last gate.
	auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).CreditLimits)).ServeHTTP(rec, req)
	return rec
}

func TestAccountDeletionGraceCreditPolicyRejectsPendingAccount(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	body := `{"relationship_id":"` + rel + `","max_collect_minor":10001,"max_pay_minor":0,"mode":"clerk_block","updated_at_ms":0}`
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.accountID); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT"} {
		if rec := graceCreditRequest(t, f, method, body); rec.Code != http.StatusUnauthorized {
			t.Fatalf("pending %s=%d %s", method, rec.Code, rec.Body.String())
		}
	}
	var count int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM customer_credit_limits`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("pending policy persisted: count=%d err=%v", count, err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NULL WHERE id=$1::uuid`, f.accountID); err != nil {
		t.Fatal(err)
	}
	if rec := graceCreditRequest(t, f, "PUT", body); rec.Code != http.StatusOK {
		t.Fatalf("restored policy save=%d %s", rec.Code, rec.Body.String())
	}
}

func TestAccountDeletionGraceCreditPolicyWaitsBeforeVaultLocks(t *testing.T) {
	f := newM1Fixture(t)
	rel := seedCreditContact(t, f)
	body := `{"relationship_id":"` + rel + `","max_collect_minor":10001,"max_pay_minor":0,"mode":"warn","updated_at_ms":0}`
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var account string
	if err := tx.QueryRow(t.Context(), `SELECT id::text FROM accounts WHERE id=$1::uuid FOR UPDATE`, f.accountID).Scan(&account); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.accountID); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- graceCreditRequest(t, f, "PUT", body) }()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
		 WHERE datname=current_database() AND wait_event_type='Lock'
		 AND query LIKE '%pending_delete_at IS NULL FOR KEY SHARE%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("credit policy did not wait on deleting account")
		case <-time.After(10 * time.Millisecond):
		}
	}
	// The credit admission lock is still available to the deleting transaction.
	var unlocked bool
	if err := tx.QueryRow(t.Context(), `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))`, "credit-vault:"+f.vaultID).Scan(&unlocked); err != nil || !unlocked {
		t.Fatalf("credit lock held before account: unlocked=%v err=%v", unlocked, err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case rec := <-result:
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("policy write after deletion=%d %s", rec.Code, rec.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("policy request did not finish")
	}
}

func TestAccountDeletionGraceSignedUnarchiveClearsArchiveHold(t *testing.T) {
	f := newM2Fixture(t)
	setting := func(value any) PushEvent {
		ev := f.membershipEvent(EventVaultSettingSet, f.anchorDeviceID, f.ownerAcct, "", map[string]any{"key": "archived_at", "value": value})
		f.signEvent(t, &ev, f.anchorPriv)
		return ev
	}
	archive := setting("1000")
	if result := f.pushAs(t, f.ownerAcct, archive); len(result.Accepted) != 1 {
		t.Fatalf("archive setting: %+v", result)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET archive_purge_not_before=NOW()+INTERVAL '720 hours' WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	var heldUntil time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT archive_purge_not_before FROM vaults WHERE vault_id=$1::uuid`, f.vaultID).Scan(&heldUntil); err != nil {
		t.Fatal(err)
	}
	// A numeric archive setting retains the hold. Unarchive alone clears it.
	rearchive := setting("1000")
	if result := f.pushAs(t, f.ownerAcct, rearchive); len(result.Accepted) != 1 {
		t.Fatalf("held archive setting: %+v", result)
	}
	var archived, holdPreserved bool
	if err := f.pool.QueryRow(t.Context(), `SELECT archived_at IS NOT NULL,archive_purge_not_before=$2::timestamptz
	 FROM vaults WHERE vault_id=$1::uuid`, f.vaultID, heldUntil).Scan(&archived, &holdPreserved); err != nil || !archived || !holdPreserved {
		t.Fatalf("archive setting changed hold: archived=%v hold=%v err=%v", archived, holdPreserved, err)
	}
	unarchive := setting(nil)
	if result := f.pushAs(t, f.ownerAcct, unarchive); len(result.Accepted) != 1 {
		t.Fatalf("unarchive setting: %+v", result)
	}
	var active bool
	if err := f.pool.QueryRow(t.Context(), `SELECT archived_at IS NULL AND archive_purge_not_before IS NULL
	 FROM vaults WHERE vault_id=$1::uuid`, f.vaultID).Scan(&active); err != nil || !active {
		t.Fatalf("unarchive did not clear hold: active=%v err=%v", active, err)
	}
}
