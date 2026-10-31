package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/testutil"
)

func TestWebActivityUpdatesExistingBrowserWithoutCreatingInstallOrMobileUsage(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := newEmailService(t, pool)
	install := uuid.NewString()
	result := signUp(t, svc, pool, "web-presence@shop.af", install)
	claims := sessionOf(t, result)
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET last_seen_at=NOW()-INTERVAL '2 days',
		installed_at=NOW()-INTERVAL '3 days', app_locale='fa' WHERE install_id=$1`, install); err != nil {
		t.Fatal(err)
	}
	var first, installed time.Time
	var checkins int
	if err := pool.QueryRow(t.Context(), `SELECT first_seen_at,installed_at,check_in_count FROM installs
		WHERE install_id=$1`, install).Scan(&first, &installed, &checkins); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := svc.RecordWebActivity(t.Context(), claims, "ps"); err != nil {
			t.Fatal(err)
		}
	}
	var platform, version, locale string
	var recent bool
	var gotFirst, gotInstalled time.Time
	var gotCheckins, entries, customers, shares, hours, days, installs int
	if err := pool.QueryRow(t.Context(), `SELECT platform,app_version,app_locale,last_seen_at>NOW()-INTERVAL '1 minute',
		first_seen_at,installed_at,check_in_count,usage_entries_created,usage_customers_added,usage_shares_sent,
		(SELECT COUNT(*) FROM install_active_hours),(SELECT COUNT(*) FROM install_active_days),(SELECT COUNT(*) FROM installs)
		FROM installs WHERE install_id=$1`, install).Scan(&platform, &version, &locale, &recent, &gotFirst,
		&gotInstalled, &gotCheckins, &entries, &customers, &shares, &hours, &days, &installs); err != nil {
		t.Fatal(err)
	}
	if platform != "web" || version != "web" || locale != "ps" || !recent {
		t.Fatalf("web presence=%q/%q/%q recent=%v", platform, version, locale, recent)
	}
	if !gotFirst.Equal(first) || !gotInstalled.Equal(installed) || gotCheckins != checkins ||
		entries != 0 || customers != 0 || shares != 0 || hours != 0 || days != 0 || installs != 1 {
		t.Fatalf("presence changed install birth or mobile usage: checkins=%d/%d usage=%d/%d/%d activity=%d/%d installs=%d",
			gotCheckins, checkins, entries, customers, shares, hours, days, installs)
	}
}

func TestWebActivityNeverRelabelsKnownMobilePlatform(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := newEmailService(t, pool)
	install := uuid.NewString()
	result := signUp(t, svc, pool, "native-presence@shop.af", install)
	if _, err := pool.Exec(t.Context(), `UPDATE installs SET platform='ios',app_version='2.3.0',
		last_seen_at=NOW()-INTERVAL '2 days',app_locale='fa' WHERE install_id=$1`, install); err != nil {
		t.Fatal(err)
	}
	if err := svc.RecordWebActivity(t.Context(), sessionOf(t, result), "ps"); err != nil {
		t.Fatal(err)
	}
	var unchanged bool
	if err := pool.QueryRow(t.Context(), `SELECT platform='ios' AND app_version='2.3.0'
		AND app_locale='fa' AND last_seen_at<NOW()-INTERVAL '1 day' FROM installs WHERE install_id=$1`, install).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("mobile install changed: unchanged=%v err=%v", unchanged, err)
	}
}

func TestWebActivityRejectsRevokedReboundRetiredAndPendingSessions(t *testing.T) {
	for _, state := range []string{"signed out", "replaced epoch", "different account", "retired", "pending deletion", "disabled", "missing install"} {
		t.Run(state, func(t *testing.T) {
			pool := testutil.ConnectTestDB(t)
			svc := newEmailService(t, pool)
			install := uuid.NewString()
			result := signUp(t, svc, pool, "ended-presence@shop.af", install)
			claims := sessionOf(t, result)
			var err error
			switch state {
			case "signed out":
				err = svc.SignOut(t.Context(), install, claims.Provider)
			case "replaced epoch":
				_, err = pool.Exec(t.Context(), `UPDATE auth_credentials SET session_epoch=session_epoch+1 WHERE install_id=$1`, install)
			case "different account":
				other := signUp(t, svc, pool, "other-presence@shop.af", uuid.NewString())
				_, err = pool.Exec(t.Context(), `UPDATE installs SET account_id=$2::uuid WHERE install_id=$1`, install, other.AccountID)
			case "retired":
				_, err = pool.Exec(t.Context(), `UPDATE installs SET account_deleted_at=NOW() WHERE install_id=$1`, install)
			case "pending deletion":
				_, err = pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, claims.AccountID)
			case "disabled":
				_, err = pool.Exec(t.Context(), `UPDATE accounts SET disabled_at=NOW() WHERE id=$1::uuid`, claims.AccountID)
			case "missing install":
				claims.InstallID = uuid.NewString()
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(t.Context(), `UPDATE installs SET last_seen_at=NOW()-INTERVAL '2 days' WHERE install_id=$1`, install); err != nil {
				t.Fatal(err)
			}
			if err := svc.RecordWebActivity(t.Context(), claims, "en"); !errors.Is(err, ErrSessionRevoked) {
				t.Fatalf("expected ended session, got %v", err)
			}
			var updated int
			if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM installs WHERE platform='web'
				OR last_seen_at>NOW()-INTERVAL '1 day' AND install_id=$1`, install).Scan(&updated); err != nil || updated != 0 {
				t.Fatalf("ended session wrote presence: count=%d err=%v", updated, err)
			}
		})
	}
}

func TestWebActivityHandlerUsesClaimsAndValidatesLocale(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	svc := newEmailService(t, pool)
	install := uuid.NewString()
	result := signUp(t, svc, pool, "handler-presence@shop.af", install)
	claims := sessionOf(t, result)
	h := NewHandler(svc)
	for _, tc := range []struct {
		body   string
		claims *SessionClaims
		status int
	}{
		{`{"locale":"en"}`, nil, http.StatusUnauthorized},
		{`{"locale":"bad"}`, claims, http.StatusBadRequest},
		{`not json`, claims, http.StatusBadRequest},
		{`{"locale":"ps","install_id":"` + uuid.NewString() + `","account_id":"` + uuid.NewString() + `"}`, claims, http.StatusNoContent},
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/account/web-activity", strings.NewReader(tc.body))
		if tc.claims != nil {
			req = req.WithContext(context.WithValue(req.Context(), claimsContextKey, tc.claims))
		}
		w := httptest.NewRecorder()
		h.WebActivity(w, req)
		if w.Code != tc.status {
			t.Fatalf("status=%d want=%d body=%s", w.Code, tc.status, w.Body.String())
		}
	}
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM installs WHERE install_id=$1 AND platform='web' AND app_locale='ps'`, install).Scan(&count); err != nil || count != 1 {
		t.Fatalf("claims-bound update count=%d err=%v", count, err)
	}
}
