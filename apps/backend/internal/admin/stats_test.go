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

// The reported bug (2026-08-11): "I generated a new QR on the admin page, I
// scan it, and nothing changes — the new link doesn't appear at all."
//
// It wasn't the QR. A campaign scanned ONLY by the operator has every one of
// its rows rejected by the keep predicate (operator IPs are filtered from all
// aggregates by design), so it reported 0/0/0/0 — visually identical to a QR
// nobody ever scanned. Worse, `ORDER BY visits DESC LIMIT 20` then sorted that
// zero row last and cut it off entirely once 20 sources existed, so the
// campaign genuinely vanished.
//
// The row must now be PRESENT and must say, honestly, that its traffic was
// excluded rather than absent.
func TestGetStatsBySourceShowsOperatorOnlyCampaign(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()

	const (
		ua         = "Mozilla/5.0 (Android 14; Mobile) Firefox/128.0"
		operatorIP = "203.0.113.99"
	)
	at := time.Now().UTC().Truncate(time.Hour).Add(10 * time.Minute)

	seed := func(kind, source, ip, userAgent string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `
			INSERT INTO web_visits (kind, source, ip, user_agent, visited_at)
			VALUES ($1, $2, $3, $4, $5)
		`, kind, source, ip, userAgent, at); err != nil {
			t.Fatalf("seed web_visits: %v", err)
		}
	}

	// A real campaign with genuine traffic, so the new one has something to be
	// ordered against.
	seed("visit", "mandawi-flyer-1", "198.51.100.1", ua)
	// The campaign under test: scanned exactly once, by the operator.
	seed("visit", "new-qr-test", operatorIP, ua)

	svc := NewService(pool, nil, []string{operatorIP})
	st, err := svc.GetStats(ctx, "day", 7)
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}

	bySource := map[string]SourceRow{}
	for _, r := range st.BySource {
		bySource[r.Source] = r
	}

	got, ok := bySource["new-qr-test"]
	if !ok {
		t.Fatalf("new-qr-test missing from by_source entirely; got %+v", st.BySource)
	}
	if got.Visits != 0 {
		t.Errorf("Visits = %d, want 0 — operator traffic must stay out of the real count", got.Visits)
	}
	if got.Excluded != 1 {
		t.Errorf("Excluded = %d, want 1 — the operator scan must be visible as excluded", got.Excluded)
	}
	if got.RawVisits != 1 {
		t.Errorf("RawVisits = %d, want 1", got.RawVisits)
	}

	// The genuine campaign is unaffected and still counts normally.
	if real := bySource["mandawi-flyer-1"]; real.Visits != 1 || real.Excluded != 0 {
		t.Errorf("mandawi-flyer-1 = %+v, want visits=1 excluded=0", real)
	}
}
