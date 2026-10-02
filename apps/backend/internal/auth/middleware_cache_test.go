package auth

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type revocationCheckFunc func(context.Context, string, string, string) (bool, error)

func (f revocationCheckFunc) CheckCredentialRevoked(ctx context.Context, install, provider, account string) (bool, error) {
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
					a.Invalidate(claims.InstallID, claims.Provider)
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
