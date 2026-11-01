package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/testutil"
)

func seedWebProfileSession(t *testing.T, pool *pgxpool.Pool) (*Service, *SessionClaims) {
	t.Helper()
	svc := NewService(pool, "", emailTestSecret)
	sub := uuid.NewString()
	account := seedGoogleAccount(t, pool, sub+"@example.test", sub)
	install := uuid.NewString()
	seedSession(t, pool, install, ProviderGoogle, sub, account)
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET platform='web',app_version='web' WHERE install_id=$1::uuid`, install); err != nil {
		t.Fatal(err)
	}
	return svc, &SessionClaims{AccountID: account, InstallID: install, Provider: ProviderGoogle, ProviderSub: sub}
}

func TestWebProfilePhoneNormalization(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{"0700000001", "+93700000001"}, {"700000001", "+93700000001"},
		{"۰۷۰۰ ۰۰۰ ۰۰۱", "+93700000001"}, {"٠٧٠٠٠٠٠٠٠١", "+93700000001"},
		{"0093 700 000 001", "+93700000001"}, {"+93 (700) 000-001", "+93700000001"},
		{"+1 (212) 555-0123", "+12125550123"}, {"+39 02 12345678", "+390212345678"},
	} {
		if got, ok := NormalizeWebProfilePhone(tc.raw); !ok || got != tc.want {
			t.Errorf("%q => %q/%v, want %q", tc.raw, got, ok, tc.want)
		}
	}
	for _, raw := range []string{"", "+", "123", "+00000000", "+93+700000001", "call 0700000001", "+93700000001 ext 2", strings.Repeat("1", 129)} {
		if got, ok := NormalizeWebProfilePhone(raw); ok {
			t.Errorf("invalid %q accepted as %q", raw, got)
		}
	}
}

func TestWebProfileRequiresConfirmedIdentityAndAcceptedBook(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc, claims := seedWebProfileSession(t, pool)
	profile, err := svc.WebProfile(t.Context(), claims)
	if err != nil || profile.Name != "Google Person" || !profile.NeedsSetup || profile.HasOnboarded {
		t.Fatalf("new profile=%+v err=%v", profile, err)
	}
	profile, err = svc.SaveWebProfile(t.Context(), claims, "  احمد‌   ولی\u200b\u202e ", "۰۷۰۰ ۰۰۰ ۰۰۱")
	if err != nil || profile.Name != "احمد‌ ولی" || profile.Phone != "+93700000001" || profile.NeedsSetup || profile.HasOnboarded {
		t.Fatalf("saved identity=%+v err=%v", profile, err)
	}
	seedVaultOwnedBy(t, pool, claims.AccountID)
	if err := svc.RecordWebActivity(t.Context(), claims, "fa"); err != nil {
		t.Fatal(err)
	}
	profile, err = svc.WebProfile(t.Context(), claims)
	if err != nil || profile.NeedsSetup || !profile.HasOnboarded || profile.ShopName != "Test Kaata" {
		t.Fatalf("complete profile=%+v err=%v", profile, err)
	}
	var correct bool
	if err := pool.QueryRow(t.Context(), `SELECT self_name='احمد‌ ولی' AND self_phone='+93700000001' AND shop_name='Test Kaata'
		AND has_onboarded AND app_locale='fa' AND platform='web' AND check_in_count=1
		AND usage_entries_created=0 AND usage_customers_added=0 AND usage_shares_sent=0 FROM installs WHERE install_id=$1::uuid`, claims.InstallID).Scan(&correct); err != nil || !correct {
		t.Fatalf("web telemetry correct=%v err=%v", correct, err)
	}
	for _, tc := range []struct {
		name, phone string
		want        error
	}{{"A", "+93700000001", errInvalidWebProfileName}, {"Other Name", "bad", errInvalidWebProfilePhone}} {
		if _, err := svc.SaveWebProfile(t.Context(), claims, tc.name, tc.phone); !errors.Is(err, tc.want) {
			t.Fatalf("invalid profile err=%v want %v", err, tc.want)
		}
	}
	var name, phone string
	if err := pool.QueryRow(t.Context(), `SELECT display_name,phone_e164 FROM accounts WHERE id=$1::uuid`, claims.AccountID).Scan(&name, &phone); err != nil || name != "احمد‌ ولی" || phone != "+93700000001" {
		t.Fatalf("invalid input partially saved: %q/%q err=%v", name, phone, err)
	}
}

func TestWebProfileReusesOwnNativeIdentityWithoutChangingPhoneTelemetry(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc, claims := seedWebProfileSession(t, pool)
	phone := uuid.NewString()
	seedSession(t, pool, phone, ProviderGoogle, claims.ProviderSub, claims.AccountID)
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET platform='ios',app_version='2.3.4',has_onboarded=TRUE,
		self_name='My Kaata Name',self_phone='+93700000001',shop_name='My Shop',usage_entries_created=7,
		last_seen_at=NOW()-INTERVAL '1 day' WHERE install_id=$1::uuid`, phone); err != nil {
		t.Fatal(err)
	}
	seedVaultOwnedBy(t, pool, claims.AccountID)
	profile, err := svc.WebProfile(t.Context(), claims)
	if err != nil || profile.Name != "My Kaata Name" || profile.Phone != "+93700000001" || profile.ShopName != "My Shop" || profile.NeedsSetup || !profile.HasOnboarded {
		t.Fatalf("native profile=%+v err=%v", profile, err)
	}
	if err := svc.RecordWebActivity(t.Context(), claims, "ps"); err != nil {
		t.Fatal(err)
	}
	var untouched bool
	if err := pool.QueryRow(t.Context(), `SELECT platform='ios' AND app_version='2.3.4' AND usage_entries_created=7
		AND last_seen_at<NOW()-INTERVAL '12 hours' FROM installs WHERE install_id=$1::uuid`, phone).Scan(&untouched); err != nil || !untouched {
		t.Fatalf("native telemetry changed=%v err=%v", !untouched, err)
	}
}

func TestWebProfileSnapshotRecoveryNeverUsesSharedOwnersIdentity(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc, claims := seedWebProfileSession(t, pool)
	_, owner := seedWebProfileSession(t, pool)
	shared := seedVaultOwnedBy(t, pool, owner.AccountID)
	if _, err := pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,invited_at,accepted_at,invited_by)
		VALUES($1::uuid,$2::uuid,'clerk',NOW(),NOW(),$3::uuid)`, shared, claims.AccountID, owner.AccountID); err != nil {
		t.Fatal(err)
	}
	seedProfileSnapshot := func(vault, account, name, phone, shop string) {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"shop_profile": map[string]string{"owner_name": name, "shop_name": shop}, "users": []map[string]any{{"is_local_self": 1, "account_id": account, "display_name": name, "phone_e164": phone}}})
		if _, err := pool.Exec(t.Context(), `INSERT INTO vault_snapshots(vault_id,up_to_server_seq,snapshot,schema_version,byte_size) VALUES($1::uuid,1,$2::jsonb,1,$3)`, vault, raw, len(raw)); err != nil {
			t.Fatal(err)
		}
	}
	seedProfileSnapshot(shared, owner.AccountID, "Employer Name", "+93799999999", "Employer Shop")
	profile, err := svc.WebProfile(t.Context(), claims)
	if err != nil || !profile.NeedsSetup || profile.HasOnboarded || profile.Name != "Google Person" || profile.Phone != "" || profile.ShopName != "" {
		t.Fatalf("borrowed shared identity: %+v err=%v", profile, err)
	}
	own := seedVaultOwnedBy(t, pool, claims.AccountID)
	seedProfileSnapshot(own, claims.AccountID, "Own Saved Name", "+93700000001", "Own Saved Shop")
	profile, err = svc.WebProfile(t.Context(), claims)
	if err != nil || profile.NeedsSetup || !profile.HasOnboarded || profile.Name != "Own Saved Name" || profile.Phone != "+93700000001" || profile.ShopName != "Own Saved Shop" {
		t.Fatalf("own snapshot=%+v err=%v", profile, err)
	}
}

func TestWebProfileRejectsStaleSessionsWithoutSaving(t *testing.T) {
	for _, state := range []string{"revoked", "epoch", "subject", "rebound", "retired", "pending", "disabled"} {
		t.Run(state, func(t *testing.T) {
			pool := testutil.ConnectTestDB(t)
			svc, claims := seedWebProfileSession(t, pool)
			var err error
			switch state {
			case "revoked":
				err = svc.SignOut(t.Context(), claims.InstallID, claims.Provider)
			case "epoch":
				_, err = pool.Exec(t.Context(), `UPDATE auth_credentials SET session_epoch=1 WHERE install_id=$1::uuid`, claims.InstallID)
			case "subject":
				claims.ProviderSub = uuid.NewString()
			case "rebound":
				_, other := seedWebProfileSession(t, pool)
				_, err = pool.Exec(t.Context(), `UPDATE installs SET account_id=$2::uuid WHERE install_id=$1::uuid`, claims.InstallID, other.AccountID)
			case "retired":
				_, err = pool.Exec(t.Context(), `UPDATE installs SET account_deleted_at=NOW() WHERE install_id=$1::uuid`, claims.InstallID)
			case "pending":
				_, err = pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, claims.AccountID)
			case "disabled":
				_, err = pool.Exec(t.Context(), `UPDATE accounts SET disabled_at=NOW() WHERE id=$1::uuid`, claims.AccountID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.SaveWebProfile(t.Context(), claims, "Late Name", "+93700000001"); !errors.Is(err, ErrSessionRevoked) {
				t.Fatalf("late save=%v", err)
			}
			if _, err := svc.WebProfile(t.Context(), claims); !errors.Is(err, ErrSessionRevoked) {
				t.Fatalf("stale read=%v", err)
			}
			if count := dbCount(t, pool, `SELECT COUNT(*) FROM accounts WHERE id=$1::uuid AND (display_name IS NOT NULL OR phone_e164 IS NOT NULL)`, claims.AccountID); count != 0 {
				t.Fatal("stale profile changed identity")
			}
		})
	}
}

func TestWebProfileHandlerErrorsAndAtomicSave(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc, claims := seedWebProfileSession(t, pool)
	h := NewHandler(svc)
	for _, tc := range []struct {
		body   string
		claims *SessionClaims
		status int
		code   string
	}{
		{`{"name":"My Name","phone":"+93700000001"}`, nil, 401, "session_expired"},
		{`{"name":"A","phone":"+93700000001"}`, claims, 400, "invalid_name"},
		{`{"name":"My Name","phone":"bad"}`, claims, 400, "invalid_phone"},
		{`{"name":"My Name","phone":"+93700000001","account_id":"` + uuid.NewString() + `"}`, claims, 200, ""},
	} {
		req := httptest.NewRequest(http.MethodPut, "/v1/account/web-profile", strings.NewReader(tc.body))
		if tc.claims != nil {
			req = req.WithContext(context.WithValue(req.Context(), claimsContextKey, tc.claims))
		}
		w := httptest.NewRecorder()
		h.PutWebProfile(w, req)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" || tc.code != "" && !strings.Contains(w.Body.String(), `"error_code":"`+tc.code+`"`) {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
	profile, err := svc.WebProfile(t.Context(), claims)
	if err != nil || profile.Name != "My Name" || profile.Phone != "+93700000001" {
		t.Fatalf("saved=%+v err=%v", profile, err)
	}
}

func TestWebProfileCompletionLatchesButDoesNotFollowAccountRebinding(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc, claims := seedWebProfileSession(t, pool)
	vault := seedVaultOwnedBy(t, pool, claims.AccountID)
	profile, err := svc.SaveWebProfile(t.Context(), claims, "Original Owner", "+93700000001")
	if err != nil || !profile.HasOnboarded {
		t.Fatalf("initial completion=%+v err=%v", profile, err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE vaults SET purged_at=NOW() WHERE vault_id=$1::uuid`, vault); err != nil {
		t.Fatal(err)
	}
	profile, err = svc.WebProfile(t.Context(), claims)
	if err != nil || !profile.HasOnboarded || profile.NeedsSetup {
		t.Fatalf("completed account lost history=%+v err=%v", profile, err)
	}
	_, other := seedWebProfileSession(t, pool)
	result, _, err := svc.providerSignIn(t.Context(), AccountProfile{}, signInTail{
		provider: ProviderGoogle, providerSub: other.ProviderSub, installID: claims.InstallID,
		sw: SwitchOptions{Platform: "web", AllowSwitch: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	var cleared bool
	if err := pool.QueryRow(t.Context(), `SELECT NOT has_onboarded AND self_name IS NULL AND self_phone IS NULL AND shop_name IS NULL
		FROM installs WHERE install_id=$1::uuid AND account_id=$2::uuid`, claims.InstallID, other.AccountID).Scan(&cleared); err != nil || !cleared {
		t.Fatalf("old account completion/profile survived switch: cleared=%v err=%v", cleared, err)
	}
	profile, err = svc.WebProfile(t.Context(), sessionOf(t, result))
	if err != nil || profile.HasOnboarded || !profile.NeedsSetup || profile.Phone != "" {
		t.Fatalf("switched profile=%+v err=%v", profile, err)
	}
}

func TestWebProfileRecoversOnlyUnambiguousLegacyNativeBinding(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	_, claims := seedWebProfileSession(t, pool)
	_, other := seedWebProfileSession(t, pool)
	seedVaultOwnedBy(t, pool, claims.AccountID)
	legacy := uuid.NewString()
	seedSession(t, pool, legacy, ProviderGoogle, claims.ProviderSub, claims.AccountID)
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET account_id=NULL,platform='ios',has_onboarded=TRUE,
		self_name='Legacy Own Name',self_phone='+93700000001',shop_name='Legacy Shop' WHERE install_id=$1::uuid`, legacy); err != nil {
		t.Fatal(err)
	}
	read := func() WebProfile {
		t.Helper()
		tx, err := pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(t.Context()) }()
		profiles, err := ReadOwnWebProfiles(t.Context(), tx, []string{claims.AccountID})
		if err != nil {
			t.Fatal(err)
		}
		return profiles[claims.AccountID]
	}
	profile := read()
	if profile.NeedsSetup || !profile.HasOnboarded || profile.Name != "Legacy Own Name" || profile.Phone != "+93700000001" {
		t.Fatalf("legacy own profile not recovered=%+v", profile)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO auth_credentials(install_id,provider,provider_sub,account_id)
		VALUES($1::uuid,'apple',$2,$3::uuid)`, legacy, uuid.NewString(), other.AccountID); err != nil {
		t.Fatal(err)
	}
	profile = read()
	if !profile.NeedsSetup || profile.HasOnboarded || profile.Name != "Google Person" || profile.Phone != "" {
		t.Fatalf("ambiguous install supplied identity=%+v", profile)
	}
	// A proven explicit binding wins even when legacy credentials disagree.
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET account_id=$2::uuid WHERE install_id=$1::uuid`, legacy, claims.AccountID); err != nil {
		t.Fatal(err)
	}
	profile = read()
	if profile.NeedsSetup || profile.Name != "Legacy Own Name" {
		t.Fatalf("explicit install binding did not win=%+v", profile)
	}
}
