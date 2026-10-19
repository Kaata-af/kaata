package admin

import (
	"strings"
	"testing"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestOutreachPashtoPreference(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	h := NewHandler(NewService(pool, nil, nil))
	r := postOutreach(h.OutreachMark, `{"phones":["+93700002501"],"lang":"ps"}`)
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"lang":"ps"`) {
		t.Fatalf("Pashto mark: %d %s", r.Code, r.Body.String())
	}
	var lang string
	if err := pool.QueryRow(t.Context(), `SELECT lang FROM outreach_contacts WHERE phone_e164='+93700002501'`).Scan(&lang); err != nil || lang != "ps" {
		t.Fatalf("Pashto preference was not stored: %q %v", lang, err)
	}
	var touches int
	if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM outreach_touches WHERE phone_e164='+93700002501'`).Scan(&touches); err != nil || touches != 0 {
		t.Fatalf("language preference created a touch: %d %v", touches, err)
	}
}
