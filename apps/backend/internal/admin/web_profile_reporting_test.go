package admin

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestGetUsersRecoversCompleteOwnWebProfileWithoutNewLogin(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	owner := seedActivityAccount(t, pool)
	legacy := seedActivityAccount(t, pool)
	clerk := seedActivityAccount(t, pool)
	missingPhone := seedActivityAccount(t, pool)
	noBook := seedActivityAccount(t, pool)
	providerOnly := seedActivityAccount(t, pool)
	native := seedActivityAccount(t, pool)
	for _, fixture := range []struct{ id, name, phone string }{
		{owner, "Chosen web name", "+93700000001"},
		{clerk, "Clerk's own name", "+93700000002"},
		{missingPhone, "Incomplete profile", ""},
		{noBook, "Profile without book", "+93700000003"},
	} {
		if _, err := pool.Exec(ctx, `UPDATE accounts SET display_name=$2,phone_e164=NULLIF($3,'') WHERE id=$1::uuid`, fixture.id, fixture.name, fixture.phone); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET phone_e164='+93700000004' WHERE id=$1::uuid`, providerOnly); err != nil {
		t.Fatal(err)
	}
	var browsers []string
	for _, id := range []string{owner, legacy, clerk, missingPhone, noBook, providerOnly} {
		browser := seedWebReportBrowser(t, pool, id)
		browsers = append(browsers, browser)
	}
	phone := seedActivityInstall(t, pool, &native, "2026-08-01T10:00:00Z")
	if _, err := pool.Exec(ctx, `UPDATE installs SET platform='ios',has_onboarded=TRUE WHERE install_id=$1::uuid`, phone); err != nil {
		t.Fatal(err)
	}
	book := seedOutreachVault(t, pool, owner, "Owned book", "AFN")
	seedOutreachMember(t, pool, book, clerk, "editor")
	seedWebReportSnapshot(t, pool, book, owner, "Stale mobile name", "+93700000009", "Owned shop")
	legacyBook := seedOutreachVault(t, pool, legacy, "Legacy book", "AFN")
	seedWebReportSnapshot(t, pool, legacyBook, legacy, "Legacy own name", "+93700000005", "Legacy shop")
	seedOutreachVault(t, pool, missingPhone, "Unfinished shop", "AFN")
	seedOutreachVault(t, pool, providerOnly, "Provider name is only a prefill", "AFN")

	got, err := NewService(pool, nil, nil).GetUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	users := map[string]UserRow{}
	for _, u := range got.Users {
		users[u.AccountID] = u
	}
	if u := users[owner]; u.Name != "Chosen web name" || u.LedgerName != "Chosen web name" ||
		u.LedgerPhone != "+93700000001" || u.ShopName != "Owned shop" || !u.HasOnboarded || u.WebSessionCount != 1 || u.InstallCount != 0 {
		t.Fatalf("chosen account profile did not override stale mobile fallback: %+v", u)
	}
	if u := users[legacy]; u.LedgerName != "Legacy own name" || u.LedgerPhone != "+93700000005" || u.ShopName != "Legacy shop" || !u.HasOnboarded {
		t.Fatalf("existing own snapshot identity was not recovered: %+v", u)
	}
	if u := users[clerk]; u.LedgerName != "Clerk's own name" || u.LedgerPhone != "+93700000002" || u.ShopName != "" || !u.HasOnboarded {
		t.Fatalf("shared member inherited the owner's profile or lost their own: %+v", u)
	}
	for _, id := range []string{missingPhone, noBook, providerOnly} {
		if users[id].HasOnboarded {
			t.Fatalf("incomplete web profile was marked onboarded: %+v", users[id])
		}
	}
	if !users[native].HasOnboarded || got.TotalInstalls != 1 {
		t.Fatalf("native onboarding or app installation count changed: %+v", got)
	}
	var unchanged int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM installs WHERE install_id=ANY($1::uuid[])
		AND NOT has_onboarded AND last_activity_at IS NULL AND usage_entries_created=0
		AND usage_customers_added=0 AND usage_shares_sent=0 AND check_in_count=1
		AND installed_at='2026-08-01T10:00:00Z'`, browsers).Scan(&unchanged); err != nil || unchanged != len(browsers) {
		t.Fatalf("read-only recovery changed browser history: unchanged=%d err=%v", unchanged, err)
	}
}

func TestGetUsersRecoversOnlyProvenWebActorWriteActivity(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	owner := seedActivityAccount(t, pool)
	other := seedActivityAccount(t, pool)
	web := seedWebReportBrowser(t, pool, owner)
	otherWeb := seedWebReportBrowser(t, pool, other)
	native := seedActivityInstall(t, pool, &owner, "2026-08-01T10:00:00Z")
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET platform='android' WHERE install_id=$1::uuid`, native); err != nil {
		t.Fatal(err)
	}
	book := seedOutreachVault(t, pool, owner, "Activity book", "AFN")
	seed := func(seq int, device, actor, received string, signed, redacted bool, kind ...string) {
		t.Helper()
		var signature *string
		if signed {
			sig := "stored-test-signature"
			signature = &sig
		}
		eventType := "vault_setting_set"
		if len(kind) > 0 {
			eventType = kind[0]
		}
		if _, err := pool.Exec(t.Context(), `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,
			hlc_device_id,device_id,account_id,event_type,payload,server_seq,event_sig_b64,server_received_at,redacted_at)
			VALUES($1::uuid,$2::uuid,9999999999999,0,$3::uuid,$3::uuid,$4::uuid,$9,
			'{"key":"default_entry_currency","value":"AFN"}',$5,$6,$7,CASE WHEN $8 THEN NOW() ELSE NULL END)`,
			uuid.NewString(), book, device, actor, seq, signature, activityTime(t, received), redacted, eventType); err != nil {
			t.Fatal(err)
		}
	}
	seed(1, web, owner, "2026-09-02T10:00:00Z", true, false)
	seed(2, web, other, "2026-09-03T10:00:00Z", true, false) // Another actor cannot borrow this browser.
	seed(3, web, owner, "2026-09-04T10:00:00Z", false, false)
	seed(4, native, owner, "2026-09-05T10:00:00Z", true, false)
	seed(5, web, owner, "2026-09-06T10:00:00Z", true, true)
	seed(6, otherWeb, other, "2026-09-07T10:00:00Z", true, false)
	seed(7, web, owner, "2026-09-08T10:00:00Z", true, false, "account_bound")
	seed(8, web, owner, "2026-09-09T10:00:00Z", true, false, "vault_device_added")
	seed(9, web, owner, "2026-09-10T10:00:00Z", true, false, "vault_device_removed")
	got, err := NewService(pool, nil, nil).GetUsers(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range got.Users {
		want := "2026-09-02T10:00:00Z"
		if u.AccountID == other {
			want = "2026-09-07T10:00:00Z"
		}
		if u.LastActivityAt != want {
			t.Fatalf("account %s actor activity=%q, want %q", u.AccountID, u.LastActivityAt, want)
		}
	}
	var untouched bool
	if err := pool.QueryRow(t.Context(), `SELECT bool_and(last_activity_at IS NULL AND usage_entries_created=0)
		FROM installs`).Scan(&untouched); err != nil || !untouched {
		t.Fatalf("historical report fabricated telemetry: untouched=%v err=%v", untouched, err)
	}
}

func TestOutreachKnownAccountPhoneKeepsBrowserDetailsAndChosenName(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	account := seedOutreachAccount(t, pool, "Old provider name", "+93700000011")
	if _, err := pool.Exec(t.Context(), `UPDATE accounts SET display_name='Chosen web name' WHERE id=$1::uuid`, account); err != nil {
		t.Fatal(err)
	}
	web := seedWebReportBrowser(t, pool, account)
	phone := seedOutreachInstall(t, pool, &account, "2026-07-01T10:00:00Z", "+93700000011", "Old mobile name", "Mobile shop")
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET platform='ios' WHERE install_id=$1::uuid`, phone); err != nil {
		t.Fatal(err)
	}
	book := seedOutreachVault(t, pool, account, "Book", "AFN")
	if _, err := pool.Exec(t.Context(), `INSERT INTO events(event_id,vault_id,hlc_physical_ms,hlc_logical,
		hlc_device_id,device_id,account_id,event_type,payload,server_seq,event_sig_b64,server_received_at)
		VALUES($1::uuid,$2::uuid,1757000000000,0,$3::uuid,$3::uuid,$4::uuid,'vault_setting_set',
		'{"key":"default_entry_currency","value":"AFN"}',1,'stored-test-signature','2026-09-02T10:00:00Z')`,
		uuid.NewString(), book, web, account); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, nil, nil)
	got, err := svc.GetOutreach(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	contact := findOutreach(t, got, "+93700000011")
	if sk := contact.Shopkeeper; contact.Name != "Chosen web name" || sk == nil || sk.InstallCount != 1 || sk.WebSessionCount != 1 ||
		!reflect.DeepEqual(sk.Platforms, []string{"ios", "web"}) || sk.LastActivityAt != "2026-09-02T10:00:00Z" {
		t.Fatalf("known account phone lost web/profile details: %+v / %+v", contact, sk)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO outreach_exclusions(kind,id,reason) VALUES('install',$1,'fixture')`, web); err != nil {
		t.Fatal(err)
	}
	excluded, err := svc.GetOutreach(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if sk := findOutreach(t, excluded, "+93700000011").Shopkeeper; sk.WebSessionCount != 0 || sk.LastActivityAt != "" {
		t.Fatalf("excluded browser leaked activity into outreach: %+v", sk)
	}
}

func seedWebReportBrowser(t *testing.T, pool *pgxpool.Pool, account string) string {
	t.Helper()
	id := seedActivityInstall(t, pool, &account, "2026-08-01T10:00:00Z")
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET platform='web',app_version='web' WHERE install_id=$1::uuid`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedWebReportSnapshot(t *testing.T, pool *pgxpool.Pool, vault, account, name, phone, shop string) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"shop_profile": map[string]any{"owner_name": name, "shop_name": shop},
		"users":        []map[string]any{{"display_name": name, "phone_e164": phone, "is_local_self": 1, "account_id": account}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO vault_snapshots(vault_id,up_to_server_seq,snapshot,schema_version,byte_size)
		VALUES($1::uuid,0,$2::jsonb,1,$3)`, vault, raw, len(raw)); err != nil {
		t.Fatal(err)
	}
}
