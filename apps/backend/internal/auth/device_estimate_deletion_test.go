package auth

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestDeviceEstimateRetainedDuringDeletionGraceAndClearedAtPurge(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	account, install, token := seedDeletionSession(t, pool)
	claims, err := ParseSession(testSecret, token)
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a1", 32)
	graceExec(t, pool, `UPDATE installs SET device_id_hash=$2,device_id_kind='android_id',usage_entries_created=17 WHERE install_id=$1`, install, hash)
	// Another account may use the same phone. Deletion applies only to the
	// account's actual installations and never expands by analytics digest.
	other, otherInstall := seedAccount(t, pool, "shared-phone@example.test"), uuid.NewString()
	graceExec(t, pool, `INSERT INTO installs(install_id,account_id,device_id_hash,device_id_kind) VALUES($1,$2,$3,'android_id')`, otherInstall, other, hash)
	svc := NewService(pool, "test-client", testSecret)
	if _, err := svc.RequestAccountDeletion(ctx, claims); err != nil {
		t.Fatal(err)
	}
	if err := svc.RunAccountPurgeTick(ctx); err != nil {
		t.Fatal(err)
	}
	var intact bool
	if err := pool.QueryRow(ctx, `SELECT device_id_hash=$2 AND device_id_kind='android_id' AND account_id=$3::uuid
	 AND account_deleted_at IS NOT NULL AND usage_entries_created=17 FROM installs WHERE install_id=$1`, install, hash, account).Scan(&intact); err != nil || !intact {
		t.Fatalf("pending deletion erased recoverable metadata: intact=%v err=%v", intact, err)
	}
	graceExec(t, pool, `UPDATE accounts SET pending_delete_at=NOW()-INTERVAL '31 days' WHERE id=$1`, account)
	if err := svc.RunAccountPurgeTick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT device_id_hash IS NULL AND device_id_kind IS NULL AND account_id IS NULL
	 AND account_deleted_at IS NOT NULL AND usage_entries_created=17 FROM installs WHERE install_id=$1`, install).Scan(&intact); err != nil || !intact {
		t.Fatalf("purged tombstone kept linkable identity or lost history: intact=%v err=%v", intact, err)
	}
	if err := pool.QueryRow(ctx, `SELECT device_id_hash=$2 AND device_id_kind='android_id' AND account_id=$3::uuid
	 AND account_deleted_at IS NULL FROM installs WHERE install_id=$1`, otherInstall, hash, other).Scan(&intact); err != nil || !intact {
		t.Fatalf("analytics digest expanded deletion to another account: intact=%v err=%v", intact, err)
	}
}
