package tabs

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestHTTPCannotCancelReviewedTallies(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	for _, verdict := range []string{"accept", "dispute"} {
		for _, kind := range []string{"entry", "opening"} {
			t.Run(verdict+"/"+kind, func(t *testing.T) {
				c := f.createOverHTTP(t, "")
				pa := f.party(t, c.MyToken, c.Tab.ID)
				added := f.append(t, pa, "a_to_b", "5.25", time.Now().UnixMilli())
				if kind == "opening" {
					// The same lifecycle applies to carry-over tallies.
					if _, err := f.pool.Exec(ctx, `UPDATE tab_entries SET kind='opening' WHERE id=$1::uuid`, added.Entry.ID); err != nil {
						t.Fatal(err)
					}
				}
				base := "/v1/tabs/" + c.Tab.ID
				jwtB := "Bearer " + f.jwtFor(t, f.acctB)
				if got := f.do(t, "POST", base+"/join", jwtB, map[string]any{"token": c.InviteToken, "label": "B"}); got.status != 200 {
					t.Fatal(string(got.body))
				}
				path := base + "/entries/" + added.Entry.ID
				if got := f.do(t, "POST", path+"/"+verdict, jwtB, map[string]any{}); got.status != 200 {
					t.Fatal(string(got.body))
				}
				before, err := f.svc.Get(ctx, pa, 0)
				if err != nil {
					t.Fatal(err)
				}
				// Old clients send no expected revision. Still reject every attempt.
				for i := 0; i < 2; i++ {
					got := f.do(t, "POST", path+"/void", "Bearer "+f.jwtFor(t, f.acctA), map[string]any{})
					if got.status != 409 || got.json(t)["error_code"] != "review_final" {
						t.Fatalf("cancel reviewed: %d %s", got.status, got.body)
					}
				}
				after, err := f.svc.Get(ctx, pa, 0)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(before, after) {
					t.Fatal("refused cancellation changed entries, balances or revision")
				}
				var notices int
				if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM tab_notifications WHERE tab_id=$1::uuid AND event_kind='entry_voided'`, c.Tab.ID).Scan(&notices); err != nil {
					t.Fatal(err)
				}
				if notices != 0 {
					t.Fatalf("refused cancellation emitted %d notices", notices)
				}
			})
		}
	}
}

func TestConcurrentReviewAndCancellationOnlyOneWins(t *testing.T) {
	f := newTabFixture(t)
	ctx := context.Background()
	c := f.create(t, "A", "", "")
	pa, pb := f.party(t, c.MyToken, c.Tab.ID), f.party(t, c.InviteToken, c.Tab.ID)
	for _, verdict := range []string{"accepted", "disputed"} {
		for i := 0; i < 8; i++ {
			entry := f.append(t, pa, "a_to_b", "10", time.Now().UnixMilli()).Entry
			start := make(chan struct{})
			results := make(chan error, 2)
			go func() { <-start; _, err := f.svc.Void(ctx, pa, entry.ID); results <- err }()
			go func() {
				<-start
				_, err := f.svc.setStatus(ctx, pb, entry.ID, verdict, nil)
				results <- err
			}()
			close(start)
			wins, refused := 0, 0
			for j := 0; j < 2; j++ {
				err := <-results
				if err == nil {
					wins++
				} else if errors.Is(err, ErrReviewFinal) || errors.Is(err, ErrAlreadyVoided) {
					refused++
				} else {
					t.Fatal(err)
				}
			}
			if wins != 1 || refused != 1 {
				t.Fatalf("wins=%d refused=%d", wins, refused)
			}
			var status string
			var voided bool
			var rev int64
			if err := f.pool.QueryRow(ctx, `SELECT status, voided_by_entry_id IS NOT NULL, rev FROM tab_entries WHERE id=$1::uuid`, entry.ID).Scan(&status, &voided, &rev); err != nil {
				t.Fatal(err)
			}
			if (voided && status != "pending") || (!voided && status != verdict) || rev != entry.Rev+1 {
				t.Fatalf("invalid final state %s void=%v rev=%d", status, voided, rev)
			}
			var notices int
			if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM tab_notifications WHERE entry_id=$1::uuid AND event_kind IN ('entry_accepted','entry_rejected','entry_voided')`, entry.ID).Scan(&notices); err != nil {
				t.Fatal(err)
			}
			if notices != 1 {
				t.Fatalf("race emitted %d notices", notices)
			}
		}
	}
}
