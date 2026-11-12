package auth

import "testing"

func TestFriendshipNoticesFollowDistinctCommittedTransitions(t *testing.T) {
	f := newFriendFixture(t)
	count := func(kind, source, recipient string, want int) {
		t.Helper()
		if got := f.count(t, `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind=$1 AND source_id=$2::uuid AND recipient_account_id=$3::uuid`, kind, source, recipient); got != want {
			t.Fatalf("%s notices=%d want%d", kind, got, want)
		}
	}
	handled := func(id string) {
		t.Helper()
		if got := f.count(t, `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind='friend_requested' AND source_id=$1::uuid AND read_at IS NULL`, id); got != 0 {
			t.Fatal("resolved request remains unread")
		}
	}
	first := f.send(t, f.a, f.b)
	f.send(t, f.a, f.b)
	f.send(t, f.b, f.a)
	count("friend_requested", first.ID, f.b, 1)
	count("friend_requested", first.ID, f.a, 0)
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, first.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, first.ID); err != nil {
		t.Fatal(err)
	}
	count("friend_rejected", first.ID, f.a, 1)
	handled(first.ID)
	// Opposite direction is a new, consent-based cycle, even during cooldown.
	second := f.send(t, f.b, f.a)
	if second.ID == first.ID {
		t.Fatal("reused request identity")
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, second.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteFriendRequest(t.Context(), f.b, second.ID); err != nil {
		t.Fatal(err)
	}
	count("friend_cancelled", second.ID, f.a, 1)
	handled(second.ID)
	third := f.send(t, f.a, f.b)
	for range 2 {
		if _, err := f.svc.AcceptFriendRequest(t.Context(), f.b, third.ID); err != nil {
			t.Fatal(err)
		}
	}
	count("friend_accepted", third.ID, f.a, 1)
	handled(third.ID)
	for range 2 {
		if err := f.svc.RemoveFriend(t.Context(), f.a, third.ID); err != nil {
			t.Fatal(err)
		}
	}
	count("friend_removed", third.ID, f.b, 1)
	fourth := f.accepted(t, f.a, f.b)
	count("friend_accepted", fourth.ID, f.a, 1)
	if err := f.svc.RemoveFriend(t.Context(), f.a, fourth.ID); err != nil {
		t.Fatal(err)
	}
	count("friend_removed", fourth.ID, f.b, 1)
	if got := f.count(t, `SELECT COUNT(*) FROM account_connection_notifications WHERE recipient_account_id=actor_account_id OR recipient_account_id=$1::uuid`, f.c); got != 0 {
		t.Fatal("self or unrelated account notified")
	}
}
