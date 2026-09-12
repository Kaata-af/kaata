package checkin

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestRecordActivityKabulHoursAndUsage(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	install := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id) VALUES ($1::uuid)`, install); err != nil {
		t.Fatalf("seed install: %v", err)
	}
	svc := NewService(pool, "", nil)
	for _, tc := range []struct {
		at       string
		hadUsage bool
	}{
		{"2026-09-13T19:29:59Z", false}, // Kabul September 13, 23:59:59.
		{"2026-09-13T19:30:00Z", false}, // Kabul September 14, 00:00:00.
		{"2026-09-13T19:31:00Z", true},  // Same hour; latch usage.
		{"2026-09-13T19:45:00Z", false}, // A later empty ping cannot clear usage.
		{"2026-09-14T00:00:00Z", false}, // New UTC day, still Kabul September 14.
	} {
		at, err := time.Parse(time.RFC3339, tc.at)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.recordActivity(ctx, install, tc.hadUsage, at); err != nil {
			t.Fatalf("recordActivity at %s: %v", tc.at, err)
		}
	}

	rows, err := pool.Query(ctx, `
		SELECT to_char(active_hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'), had_usage
		FROM install_active_hours WHERE install_id = $1::uuid ORDER BY active_hour
	`, install)
	if err != nil {
		t.Fatalf("read activity hours: %v", err)
	}
	defer rows.Close()
	type hour struct {
		at    string
		usage bool
	}
	want := []hour{
		{"2026-09-13T18:30", false},
		{"2026-09-13T19:30", true},
		{"2026-09-13T23:30", false},
	}
	index := 0
	for rows.Next() {
		var got hour
		if err := rows.Scan(&got.at, &got.usage); err != nil {
			t.Fatalf("scan activity hour: %v", err)
		}
		if index >= len(want) {
			t.Fatalf("unexpected extra activity hour: %+v", got)
		}
		if got != want[index] {
			t.Errorf("hour[%d] = %+v, want %+v", index, got, want[index])
		}
		index++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate activity hours: %v", err)
	}
	if index != len(want) {
		t.Errorf("hour count = %d, want %d", index, len(want))
	}

	// Continue recording UTC days without changing the historical table's
	// meaning. Multiple local days inside one UTC day remain one legacy row.
	var legacyRows int
	var firstDayUsage bool
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*), BOOL_OR(had_usage) FILTER (WHERE active_date = '2026-09-13')
		FROM install_active_days WHERE install_id = $1::uuid
	`, install).Scan(&legacyRows, &firstDayUsage); err != nil {
		t.Fatalf("read legacy days: %v", err)
	}
	if legacyRows != 2 || !firstDayUsage {
		t.Errorf("legacy rows=%d first-day usage=%v, want 2/true", legacyRows, firstDayUsage)
	}
}
