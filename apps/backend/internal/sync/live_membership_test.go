package sync

import "testing"

func TestLiveMembershipReachesNewAccountAndDeduplicatesKnownVault(t *testing.T) {
	b := newLiveBroker()
	newMember, _ := b.subscribe("new", []string{liveAccountKey("new")})
	existing, _ := b.subscribe("owner", []string{"book", liveAccountKey("owner")})
	unrelated, _ := b.subscribe("unrelated", []string{liveAccountKey("unrelated")})
	b.notifyMembership("book", "new")
	for _, sub := range []*liveSub{newMember, existing} {
		if len(sub.ch) != 1 {
			t.Fatalf("account %s: got %d hints, want one", sub.accountID, len(sub.ch))
		}
		if msg := <-sub.ch; msg.T != "poke" || msg.VaultID != "book" {
			t.Fatalf("unexpected hint: %+v", msg)
		}
	}
	if len(unrelated.ch) != 0 {
		t.Fatal("unrelated account received a membership hint")
	}
	b.notifyMembership("book", "owner")
	if len(existing.ch) != 1 {
		t.Fatal("known vault subscriber received a duplicate through its account key")
	}
}
