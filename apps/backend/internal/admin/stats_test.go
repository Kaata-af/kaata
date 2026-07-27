package admin

import (
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

// GetStats — store_click counting must mirror the download counting exactly:
// deduped per (ip, user_agent, hour), bot UAs and operator IPs excluded, and
// surfaced both as the headline store_clicks and per-source in by_source.
//
// Fixture (all rows in the same hour so the dedup window is exercised):
//
//	shop_42:  store_click ×2 from (ip1, ua1)  → dedup to 1
//	          store_click ×1 from (ip2, ua1)  → +1  ⇒ shop_42 store_clicks = 2
//	          visit       ×1 from (ip1, ua1)
//	          download    ×1 from (ip1, ua1)
//	(direct): store_click ×1 from (ip3, ua1)  ⇒ (direct) store_clicks = 1
//	noise:    store_click from a WhatsApp preview UA (bot)      — excluded
//	          store_click from the operator's IP               — excluded
//
// Headline store_clicks = 3 (2 shop_42 + 1 direct).
func TestGetStatsStoreClicks(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()

	const (
		ua         = "Mozilla/5.0 (Android 14; Mobile) Firefox/128.0"
		botUA      = "WhatsApp/2.24.10.81"
		operatorIP = "203.0.113.99"
	)
	at := time.Now().UTC().Truncate(time.Hour).Add(10 * time.Minute)

	seed := func(kind string, source *string, ip, userAgent, detail string) {
		t.Helper()
		var det *string
		if detail != "" {
			det = &detail
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO web_visits (kind, source, ip, user_agent, detail, visited_at)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, kind, source, ip, userAgent, det, at); err != nil {
			t.Fatalf("seed web_visits (%s): %v", kind, err)
		}
	}
	shop := "shop_42"

	seed("store_click", &shop, "198.51.100.1", ua, "play")     // dupe 1
	seed("store_click", &shop, "198.51.100.1", ua, "play")     // dupe 2 — dedups away
	seed("store_click", &shop, "198.51.100.2", ua, "appstore") // distinct ip
	seed("visit", &shop, "198.51.100.1", ua, "")
	seed("download", &shop, "198.51.100.1", ua, "")
	seed("store_click", nil, "198.51.100.3", ua, "play")      // (direct)
	seed("store_click", &shop, "198.51.100.4", botUA, "play") // bot — excluded
	seed("store_click", &shop, operatorIP, ua, "play")        // operator — excluded

	svc := NewService(pool, nil, []string{operatorIP})
	st, err := svc.GetStats(ctx, "day", 7)
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}

	if st.StoreClicks != 3 {
		t.Errorf("StoreClicks = %d, want 3 (dedup + bot/operator exclusion)", st.StoreClicks)
	}
	if st.Visits != 1 {
		t.Errorf("Visits = %d, want 1", st.Visits)
	}
	if st.Downloads != 1 {
		t.Errorf("Downloads = %d, want 1", st.Downloads)
	}

	bySource := map[string]SourceRow{}
	for _, r := range st.BySource {
		bySource[r.Source] = r
	}
	if got := bySource["shop_42"]; got.StoreClicks != 2 || got.Visits != 1 || got.Downloads != 1 {
		t.Errorf("by_source[shop_42] = %+v, want store_clicks=2 visits=1 downloads=1", got)
	}
	if got := bySource["(direct)"]; got.StoreClicks != 1 {
		t.Errorf("by_source[(direct)] = %+v, want store_clicks=1", got)
	}
}
