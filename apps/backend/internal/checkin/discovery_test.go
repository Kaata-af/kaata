package checkin

import (
	"testing"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestAnonymousNinjaCheckInDoesNotCreateDiscoverableAccount(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := NewService(pool, "", nil)
	install, name, phone, onboarded := uuid.NewString(), "Anonymous Ninja", "+93700000123", true
	request := Request{InstallID: install, Platform: "android", AppVersion: "1.0.0", SelfName: &name, SelfPhone: &phone, HasOnboarded: &onboarded}
	for range 2 {
		if _, err := svc.Handle(t.Context(), request, "127.0.0.1"); err != nil {
			t.Fatal(err)
		}
	}
	var accounts, anonymousInstalls int
	if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM accounts`).Scan(&accounts); err != nil || accounts != 0 {
		t.Fatalf("anonymous check-in created accounts=%d err=%v", accounts, err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM installs WHERE install_id=$1::uuid AND account_id IS NULL AND self_name=$2 AND self_phone=$3`, install, name, phone).Scan(&anonymousInstalls); err != nil || anonymousInstalls != 1 {
		t.Fatalf("anonymous profile changed: count=%d err=%v", anonymousInstalls, err)
	}
	search := auth.NewService(pool, "", "0123456789abcdef0123456789abcdef")
	for _, query := range []string{name, phone} {
		page, err := search.SearchPeople(t.Context(), uuid.NewString(), query)
		if err != nil || len(page.People) != 0 {
			t.Fatalf("anonymous profile became searchable: %+v err=%v", page, err)
		}
	}
}
