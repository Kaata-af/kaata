package tabs

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestHTTPReviewIsFinalForOldClientsAndStaleNotifications(t *testing.T) {
	f := newHTTPFixture(t)
	jwtB := "Bearer " + f.jwtFor(t, f.acctB)
	for _, first := range []string{"accept", "dispute"} {
		t.Run(first, func(t *testing.T) {
			c := f.createOverHTTP(t, "")
			base := "/v1/tabs/" + c.Tab.ID
			if got := f.do(t, "POST", base+"/join", jwtB, map[string]any{"token": c.InviteToken, "label": "B"}); got.status != 200 {
				t.Fatal(string(got.body))
			}
			pa := f.party(t, c.MyToken, c.Tab.ID)
			added := f.append(t, pa, "a_to_b", "5.25", time.Now().UnixMilli())
			path := base + "/entries/" + added.Entry.ID
			body := map[string]any{"reason": "Wrong amount", "expected_rev": added.Entry.Rev}
			got := f.do(t, "POST", path+"/"+first, jwtB, body)
			if got.status != 200 {
				t.Fatal(string(got.body))
			}
			result := got.json(t)
			entry := result["entry"].(map[string]any)
			rev := entry["rev"]
			opposite := "dispute"
			if first == "dispute" {
				opposite = "accept"
			}
			for _, expected := range []any{nil, added.Entry.Rev, rev} {
				change := map[string]any{"reason": "Different reason"}
				if expected != nil {
					change["expected_rev"] = expected
				}
				got := f.do(t, "POST", path+"/"+opposite, jwtB, change)
				if got.status != 409 || got.json(t)["error_code"] != "review_final" {
					t.Fatalf("opposite verdict with rev %v: %d %s", expected, got.status, got.body)
				}
			}
			if first == "dispute" {
				got := f.do(t, "POST", path+"/dispute", jwtB, map[string]any{"reason": "Edited reason"})
				if got.status != 409 || got.json(t)["error_code"] != "review_final" {
					t.Fatal(string(got.body))
				}
			}
			// Lost responses can be retried, even with the original expected revision.
			retry := f.do(t, "POST", path+"/"+first, jwtB, body)
			if retry.status != 200 || retry.json(t)["entry"].(map[string]any)["rev"] != rev {
				t.Fatalf("retry changed decision: %d %s", retry.status, retry.body)
			}
			var notices int
			if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM tab_notifications
    WHERE tab_id=$1::uuid AND event_kind IN ('entry_accepted','entry_rejected')`, c.Tab.ID).Scan(&notices); err != nil {
				t.Fatal(err)
			}
			if notices != 1 {
				t.Fatalf("review emitted %d notices, want 1", notices)
			}
		})
	}
}

func TestConcurrentOppositeReviewsFirstDecisionWins(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	c := f.create(t, "A", "", "")
	pa, pb := f.party(t, c.MyToken, c.Tab.ID), f.party(t, c.InviteToken, c.Tab.ID)
	for i := 0; i < 8; i++ {
		added := f.append(t, pa, "a_to_b", "10", time.Now().UnixMilli())
		start := make(chan struct{})
		results := make(chan error, 2)
		go func() { <-start; _, err := f.svc.Accept(ctx, pb, added.Entry.ID); results <- err }()
		go func() { <-start; _, err := f.svc.Dispute(ctx, pb, added.Entry.ID, "No"); results <- err }()
		close(start)
		success, final := 0, 0
		for j := 0; j < 2; j++ {
			err := <-results
			switch {
			case err == nil:
				success++
			case errors.Is(err, ErrReviewFinal):
				final++
			default:
				t.Fatalf("unexpected review failure: %v", err)
			}
		}
		if success != 1 || final != 1 {
			t.Fatalf("success=%d final=%d", success, final)
		}
		var n int
		if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM tab_notifications
   WHERE entry_id=$1::uuid AND event_kind IN ('entry_accepted','entry_rejected')`, added.Entry.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("concurrent review emitted %d notices", n)
		}
	}
}
