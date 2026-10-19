package auth

import (
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestPashtoEmailCodeLanguagePersistence(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := newEmailService(t, pool)
	if err := svc.EmailSignUpStart(t.Context(), "pashto@example.af", "ps-AF", anyClient()); err != nil {
		t.Fatal(err)
	}
	var lang string
	if err := pool.QueryRow(t.Context(), `SELECT lang FROM email_codes WHERE email='pashto@example.af'`).Scan(&lang); err != nil || lang != "ps" {
		t.Fatalf("email code language: %q %v", lang, err)
	}
	ms := mailsTo(t, pool, "pashto@example.af")
	if len(ms) != 1 || ms[0].subject != "ستاسو د کاټه د نوم‌لیکنې کوډ" || !strings.Contains(ms[0].text, "د خپل کاټه حساب جوړولو") {
		t.Fatalf("Pashto email was not queued: %+v", ms)
	}
	if got := noticeLang("", lang); got != "ps" {
		t.Fatalf("notice fallback lost Pashto: %q", got)
	}
}
