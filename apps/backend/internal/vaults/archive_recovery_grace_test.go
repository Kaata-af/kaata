package vaults

import (
	"context"
	"errors"
	"regexp"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/mail"
	"github.com/matee/kaata-backend/internal/testutil"
)

const archiveRecoverySecret = "0123456789abcdef0123456789abcdef"
const archiveRecoveryPassword = "Tq8v-Lr2x-W9pm"

// The outbox is never started: code proof runs against queued fixture mail and
// no real address or SMTP service is contacted.
type archiveRecoverySender struct{}

func (archiveRecoverySender) Send(context.Context, mail.Message) error { return nil }

type archiveRecoveryFixture struct {
	pool       *pgxpool.Pool
	auth       *auth.Service
	account    string
	vault      string
	claims     *auth.SessionClaims
	archivedAt time.Time
}

func newArchiveRecoveryFixture(t *testing.T) *archiveRecoveryFixture {
	t.Helper()
	f := &archiveRecoveryFixture{pool: testutil.ConnectTestDB(t), vault: uuid.NewString()}
	f.auth = auth.NewService(f.pool, "test-client", archiveRecoverySecret)
	f.auth.SetMailOutbox(mail.NewOutbox(f.pool, archiveRecoverySender{}, 0, 0))
	email, install := "archive.fixture@shop.af", uuid.NewString()
	if err := f.auth.EmailSignUpStart(t.Context(), email, "en", "fixture:"+uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	var body string
	if err := f.pool.QueryRow(t.Context(), `SELECT text_body FROM email_outbox WHERE to_addr=$1 ORDER BY id DESC LIMIT 1`, email).Scan(&body); err != nil {
		t.Fatal(err)
	}
	code := regexp.MustCompile(`\d{6}`).FindString(body)
	if code == "" {
		t.Fatal("fixture signup queued no verification code")
	}
	signed, err := f.auth.EmailSignUpVerify(t.Context(), install, email, code, archiveRecoveryPassword, auth.SwitchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	f.account = signed.AccountID
	f.claims, err = auth.ParseSession(archiveRecoverySecret, signed.SessionJWT)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(f.pool)
	if _, err := service.Create(t.Context(), CreateInput{AccountID: f.account, VaultID: f.vault, Name: "Saved archive", Currency: "AFN"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Archive(t.Context(), f.vault, f.account); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET archived_at=NOW()-INTERVAL '35 days' WHERE vault_id=$1::uuid`, f.vault); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT archived_at FROM vaults WHERE vault_id=$1::uuid`, f.vault).Scan(&f.archivedAt); err != nil {
		t.Fatal(err)
	}
	device, target := uuid.NewString(), uuid.NewString()
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,
	 account_id,target_id,event_type,payload,server_seq) VALUES($1::uuid,$2::uuid,10,0,$3::uuid,$3::uuid,
	 $4::uuid,$5::uuid,'person_added','{"name":"Preserved Customer"}',1)`, uuid.NewString(), f.vault, device, f.account, target); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_snapshots(vault_id,up_to_server_seq,snapshot,schema_version,byte_size)
	 VALUES($1::uuid,1,'{"fixture":"saved archive"}',1,27)`, f.vault); err != nil {
		t.Fatal(err)
	}
	return f
}

func archiveRecoverySaved(t *testing.T, f *archiveRecoveryFixture) {
	t.Helper()
	var intact bool
	if err := f.pool.QueryRow(t.Context(), `SELECT purged_at IS NULL AND archived_at=$2::timestamptz
	 AND (SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid)=1
	 AND (SELECT COUNT(*) FROM vault_snapshots WHERE vault_id=$1::uuid)=1
	 AND (SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND revoked_at IS NULL AND accepted_at IS NOT NULL)=1
	 FROM vaults WHERE vault_id=$1::uuid`, f.vault, f.archivedAt).Scan(&intact); err != nil || !intact {
		t.Fatalf("saved archive lost history or original timestamp: intact=%v err=%v", intact, err)
	}
}

func archiveRecoveryCandidates(t *testing.T, f *archiveRecoveryFixture, want bool) {
	t.Helper()
	ids, err := findPurgeCandidates(t.Context(), f.pool)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, id := range ids {
		found = found || id == f.vault
	}
	if found != want {
		t.Fatalf("archive purge candidate=%v want=%v", found, want)
	}
}

func TestAccountDeletionGraceArchiveHoldSurvivesProvedRecovery(t *testing.T) {
	f := newArchiveRecoveryFixture(t)
	archiveRecoveryCandidates(t, f, true)
	state, err := f.auth.RequestAccountDeletion(t.Context(), f.claims)
	if err != nil || state.PurgeAt == nil {
		t.Fatalf("schedule=%+v err=%v", state, err)
	}
	var hold time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT archive_purge_not_before FROM vaults WHERE vault_id=$1::uuid`, f.vault).Scan(&hold); err != nil || !hold.Equal(*state.PurgeAt) {
		t.Fatalf("archive hold=%v deadline=%v err=%v", hold, state.PurgeAt, err)
	}
	archiveRecoveryCandidates(t, f, false)
	if result, err := purgeOneVault(t.Context(), f.pool, f.vault); err != nil || !result.skipped {
		t.Fatalf("stale candidate purged pending owner: %+v %v", result, err)
	}
	archiveRecoverySaved(t, f)
	restored, err := f.auth.EmailSignIn(t.Context(), uuid.NewString(), "archive.fixture@shop.af", archiveRecoveryPassword, auth.SwitchOptions{})
	if err != nil || !restored.DeletionCancelled || restored.AccountID != f.account {
		t.Fatalf("proved archive-owner recovery=%+v err=%v", restored, err)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT archive_purge_not_before FROM vaults WHERE vault_id=$1::uuid`, f.vault).Scan(&hold); err != nil || !hold.Equal(*state.PurgeAt) {
		t.Fatalf("recovery changed original archive hold: %v %v", hold, err)
	}
	archiveRecoveryCandidates(t, f, false)
	if result, err := purgeOneVault(t.Context(), f.pool, f.vault); err != nil || !result.skipped {
		t.Fatalf("recovered archive raced restoration: %+v %v", result, err)
	}
	archiveRecoverySaved(t, f)
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET archive_purge_not_before=NOW()-INTERVAL '1 second' WHERE vault_id=$1::uuid`, f.vault); err != nil {
		t.Fatal(err)
	}
	archiveRecoveryCandidates(t, f, true)
	result, err := purgeOneVault(t.Context(), f.pool, f.vault)
	if err != nil || result.skipped || result.deletedEvents != 1 || result.deletedSnapshots != 1 || result.revokedMembers != 1 {
		t.Fatalf("expired archive hold did not resume normal purge: %+v %v", result, err)
	}
}

func TestAccountDeletionGraceArchivePurgeSkipsPendingOwnerEvenWithoutHold(t *testing.T) {
	f := newArchiveRecoveryFixture(t)
	if _, err := f.auth.RequestAccountDeletion(t.Context(), f.claims); err != nil {
		t.Fatal(err)
	}
	// Pending ownership must protect even an old/stale candidate whose hold
	// is absent. The account's destructive worker handles its eventual expiry.
	if _, err := f.pool.Exec(t.Context(), `UPDATE vaults SET archive_purge_not_before=NULL WHERE vault_id=$1::uuid`, f.vault); err != nil {
		t.Fatal(err)
	}
	archiveRecoveryCandidates(t, f, false)
	if result, err := purgeOneVault(t.Context(), f.pool, f.vault); err != nil || !result.skipped {
		t.Fatalf("pending owner bypassed archive purge guard: %+v %v", result, err)
	}
	archiveRecoverySaved(t, f)
}

func TestAccountDeletionGraceArchiveWorkerSkipsSchedulingAccountLock(t *testing.T) {
	f := newArchiveRecoveryFixture(t)
	archiveRecoveryCandidates(t, f, true)
	scheduling, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = scheduling.Rollback(context.Background()) }()
	var owner string
	if err := scheduling.QueryRow(t.Context(), `SELECT id::text FROM accounts WHERE id=$1::uuid FOR UPDATE`, f.account).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if _, err := scheduling.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.account); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if result, err := purgeOneVault(ctx, f.pool, f.vault); err != nil || !result.skipped {
		t.Fatalf("archive worker did not skip scheduling account before vault: %+v %v", result, err)
	}
	archiveRecoverySaved(t, f)
	if err := scheduling.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if result, err := purgeOneVault(t.Context(), f.pool, f.vault); err != nil || result.skipped {
		t.Fatalf("ordinary unheld archive purge changed: %+v %v", result, err)
	}
}

func TestAccountDeletionGraceDoesNotResurrectAlreadyPurgedArchive(t *testing.T) {
	f := newArchiveRecoveryFixture(t)
	if result, err := purgeOneVault(t.Context(), f.pool, f.vault); err != nil || result.skipped {
		t.Fatalf("normal archive purge: %+v %v", result, err)
	}
	if _, err := f.auth.RequestAccountDeletion(t.Context(), f.claims); err != nil {
		t.Fatal(err)
	}
	var intact bool
	if err := f.pool.QueryRow(t.Context(), `SELECT purged_at IS NOT NULL AND archive_purge_not_before IS NULL
	 AND NOT EXISTS(SELECT 1 FROM events WHERE vault_id=$1::uuid)
	 AND NOT EXISTS(SELECT 1 FROM vault_snapshots WHERE vault_id=$1::uuid)
	 FROM vaults WHERE vault_id=$1::uuid`, f.vault).Scan(&intact); err != nil || !intact {
		t.Fatalf("deletion resurrected an already-purged archive: intact=%v err=%v", intact, err)
	}
}

func TestAccountDeletionGraceRecoveredOwnerCanUnarchiveDuringHold(t *testing.T) {
	f := newArchiveRecoveryFixture(t)
	service := NewService(f.pool)
	if _, err := service.Unarchive(t.Context(), f.vault, f.account); !errors.Is(err, ErrVaultPurged) {
		t.Fatalf("unheld archive beyond ordinary cutoff was reopened: %v", err)
	}
	if _, err := f.auth.RequestAccountDeletion(t.Context(), f.claims); err != nil {
		t.Fatal(err)
	}
	if restored, err := f.auth.EmailSignIn(t.Context(), uuid.NewString(), "archive.fixture@shop.af", archiveRecoveryPassword, auth.SwitchOptions{}); err != nil || !restored.DeletionCancelled {
		t.Fatalf("recover archive owner: %+v %v", restored, err)
	}
	archiveRecoverySaved(t, f)
	if _, err := service.Unarchive(t.Context(), f.vault, f.account); err != nil {
		t.Fatalf("recovered owner could not use retained archive: %v", err)
	}
	var intact bool
	if err := f.pool.QueryRow(t.Context(), `SELECT archived_at IS NULL AND purged_at IS NULL AND archive_purge_not_before IS NULL
	 AND (SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid)=1
	 AND (SELECT COUNT(*) FROM vault_snapshots WHERE vault_id=$1::uuid)=1
	 AND (SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND revoked_at IS NULL AND accepted_at IS NOT NULL)=1
	 FROM vaults WHERE vault_id=$1::uuid`, f.vault).Scan(&intact); err != nil || !intact {
		t.Fatalf("held unarchive lost data or kept stale hold: intact=%v err=%v", intact, err)
	}
}
