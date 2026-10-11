package auth

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type revocationCheckFunc func(context.Context, string, string, string) (bool, error)

func (f revocationCheckFunc) CheckCredentialRevoked(ctx context.Context, install, provider, account string, _ int64) (bool, error) {
	return f(ctx, install, provider, account)
}

func TestInvalidateAccountClearsAllInstallsAndProviders(t *testing.T) {
	a := NewSessionAuthenticator(nil, "")
	for _, key := range []string{
		"phone|google|deleted-account",
		"phone|apple|deleted-account",
		"tablet|google|deleted-account",
		"phone|google|other-account",
	} {
		a.cache.Add(key, revokedEntry{checkedAt: time.Now()})
	}
	a.InvalidateAccount("deleted-account")
	if got := a.cache.Keys(); len(got) != 1 || got[0] != "phone|google|other-account" {
		t.Fatalf("cached sessions after deletion = %v; want only the other account", got)
	}
}

// Keys are install|provider|epoch|account: an install's verdicts go whatever
// the provider, epoch or account, and nobody else's do.
func TestInvalidateInstallClearsEveryProviderEpochAndAccount(t *testing.T) {
	a := NewSessionAuthenticator(nil, "")
	for _, key := range []string{
		"phone|google|0|acct-a",
		"phone|email|42|acct-b",
		"phone|apple|7|acct-a",
		"phone2|google|0|acct-a", // another install whose id starts the same
		"tablet|google|0|acct-a",
	} {
		a.cache.Add(key, revokedEntry{checkedAt: time.Now()})
	}
	a.InvalidateInstall("phone")
	got := map[string]bool{}
	for _, k := range a.cache.Keys() {
		got[k] = true
	}
	if len(got) != 2 || !got["phone2|google|0|acct-a"] || !got["tablet|google|0|acct-a"] {
		t.Fatalf("cached verdicts after invalidating the install = %v", a.cache.Keys())
	}
}

// The cache key carries the epoch: a verdict for one session of an install
// never answers for another.
func TestRevocationCacheIsPerEpoch(t *testing.T) {
	a := NewSessionAuthenticator(nil, "")
	var calls atomic.Int32
	a.svc = epochCheckFunc(func(epoch int64) bool {
		calls.Add(1)
		return epoch != 2 // only epoch 2 is the live session
	})
	old := &SessionClaims{InstallID: "phone", Provider: "email", AccountID: "acct", Epoch: 1}
	live := &SessionClaims{InstallID: "phone", Provider: "email", AccountID: "acct", Epoch: 2}
	if revoked, _ := a.isRevoked(t.Context(), live); revoked {
		t.Fatal("the live session must authorize")
	}
	if revoked, _ := a.isRevoked(t.Context(), old); !revoked {
		t.Fatal("an older session of the same install must not reuse the live verdict")
	}
	if calls.Load() != 2 {
		t.Fatalf("lookups = %d, want one per epoch", calls.Load())
	}
}

type epochCheckFunc func(epoch int64) bool

func (f epochCheckFunc) CheckCredentialRevoked(_ context.Context, _, _, _ string, epoch int64) (bool, error) {
	return f(epoch), nil
}

func TestInvalidationCannotBeUndoneByPendingRevocationLookup(t *testing.T) {
	for _, scope := range []string{"account", "install"} {
		t.Run(scope, func(t *testing.T) {
			a := NewSessionAuthenticator(nil, "")
			started := make(chan struct{})
			release := make(chan struct{})
			var calls atomic.Int32
			a.svc = revocationCheckFunc(func(context.Context, string, string, string) (bool, error) {
				if calls.Add(1) == 1 {
					close(started)
					<-release
					return false, nil // A read that began before deletion committed.
				}
				return true, nil
			})
			claims := &SessionClaims{InstallID: "phone", Provider: "google", AccountID: "deleted-account"}
			lookupDone := make(chan struct{})
			go func() {
				_, _ = a.isRevoked(t.Context(), claims)
				close(lookupDone)
			}()
			<-started
			invalidating := make(chan struct{})
			invalidated := make(chan struct{})
			go func() {
				close(invalidating)
				if scope == "account" {
					a.InvalidateAccount(claims.AccountID)
				} else {
					a.InvalidateInstall(claims.InstallID)
				}
				close(invalidated)
			}()
			<-invalidating
			select {
			case <-invalidated:
				t.Error("invalidation completed before the pending stale lookup was ordered before it")
			case <-time.After(25 * time.Millisecond):
			}
			close(release)
			<-lookupDone
			<-invalidated
			if revoked, err := a.isRevoked(t.Context(), claims); err != nil || !revoked {
				t.Fatalf("request after invalidation: revoked=%v err=%v; want fresh revoked result", revoked, err)
			}
			if calls.Load() != 2 {
				t.Fatalf("DB lookups = %d, want 2", calls.Load())
			}
		})
	}
}
