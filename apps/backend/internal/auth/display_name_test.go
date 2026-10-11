package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/testutil"
)

// The Kaata name is explicit profile data, independent of proven identity.
func TestDisplayNameSurvivesProviderRelogin(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool, "test-client-id", emailTestSecret)
	for _, provider := range []string{ProviderGoogle, ProviderApple} {
		profile := googleProfile(provider+"@example.test", "Original Provider Name")
		sub := provider + "-display-name"
		account, _ := resolveInTx(t, pool, provider, sub, profile)
		if name, err := svc.SetAccountDisplayName(ctx, account, "  احمد‌  ولی\u200b\u202e "); err != nil || name != "احمد‌ ولی" {
			t.Fatalf("%s rename = %q, %v", provider, name, err)
		}
		if _, err := svc.SetAccountName(ctx, account, "Legacy Rename"); !errors.Is(err, ErrProviderName) {
			t.Fatalf("legacy provider restriction = %v", err)
		}
		profile.Name = "New Provider Name"
		res, effective, err := svc.providerSignIn(ctx, profile, signInTail{
			provider: provider, providerSub: sub, installID: uuid.NewString(),
			credEmail: profile.Email, credName: profile.Name, credPicture: profile.PictureURL,
		})
		if err != nil || res.AccountID != account || effective.name != "احمد‌ ولی" {
			t.Fatalf("%s sign-in = %+v, %+v, %v", provider, res, effective, err)
		}
		var providerName, displayName, credentialName string
		if err := pool.QueryRow(ctx, `SELECT a.name, a.display_name, c.name FROM accounts a
			JOIN auth_credentials c ON c.account_id = a.id WHERE a.id = $1::uuid`, account).
			Scan(&providerName, &displayName, &credentialName); err != nil {
			t.Fatal(err)
		}
		if providerName != profile.Name || credentialName != profile.Name || displayName != "احمد‌ ولی" {
			t.Fatalf("provider identity overwritten: provider=%q credential=%q display=%q", providerName, credentialName, displayName)
		}
		me, err := svc.AccountMe(ctx, account)
		if err != nil || me.Name != displayName || me.Email != profile.Email || len(me.Providers) != 1 || me.Providers[0] != provider {
			t.Fatalf("account me = %+v, %v", me, err)
		}
		if _, err := svc.SetAccountDisplayName(ctx, account, "A"); !errors.As(err, new(*InvalidNameError)) {
			t.Fatalf("short display name = %v", err)
		}
		if _, err := pool.Exec(ctx, `UPDATE accounts SET disabled_at = NOW() WHERE id = $1::uuid`, account); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.SetAccountDisplayName(ctx, account, "Disabled Rename"); !errors.Is(err, ErrSessionRevoked) {
			t.Fatalf("disabled display edit = %v", err)
		}
	}
	if _, err := svc.SetAccountDisplayName(ctx, uuid.NewString(), "Missing Account"); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("missing display edit = %v", err)
	}
}

func TestLegacyEmailNameSaveUpdatesDisplayOverride(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := newEmailService(t, pool)
	res := signUp(t, svc, pool, "renamed@example.test", uuid.NewString())
	if _, err := svc.SetAccountDisplayName(ctx, res.AccountID, "Modern Name"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetAccountName(ctx, res.AccountID, "Legacy Email Name"); err != nil {
		t.Fatal(err)
	}
	me, err := svc.AccountMe(ctx, res.AccountID)
	if err != nil || me.Name != "Legacy Email Name" {
		t.Fatalf("legacy save hidden by override: %+v, %v", me, err)
	}
	res, err = svc.EmailSignIn(ctx, uuid.NewString(), "renamed@example.test", goodPassword, SwitchOptions{})
	if err != nil || res.User.Name != "Legacy Email Name" {
		t.Fatalf("email sign-in = %+v, %v", res, err)
	}
}
