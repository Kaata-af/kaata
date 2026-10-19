package tabs

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPashtoInvitationAndNotifications(t *testing.T) {
	var out bytes.Buffer
	if err := viewTmpl.Execute(&out, viewData{Lang: "ps", RTL: true, Token: "safe", PlayURL: playStoreURL, AppStoreURL: appStoreURL}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`<html lang="ps" dir="rtl">`, "په کاټه کې پرانیزئ", "د کاټه د ګډ حساب بلنه"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("invitation missing %q", want)
		}
	}
	out.Reset()
	if err := notFoundTmpl.Execute(&out, viewData{Lang: "ps", RTL: true}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "دا ګډ حساب نشته، یا یې لینک نوی شوی دی.") {
		t.Fatal("missing invitation used another language")
	}
	actor, amount := "\u2068Ahmad\u2069", "\u2066−5.25 AFN\u2069"
	for _, c := range []struct{ kind, want string }{
		{"entry_created", actor + " یوه راکړه ورکړه (" + amount + ") زیاته کړه. ویې منئ یا یې رد کړئ."},
		{"entry_accepted", "ستاسو راکړه ورکړه (" + amount + ") د " + actor + " له خوا ومنل شوه."},
		{"entry_rejected", "ستاسو راکړه ورکړه (" + amount + ") د " + actor + " له خوا رد شوه. په پاتې حساب کې نه شمېرل کېږي."},
		{"entry_voided", actor + " یوه راکړه ورکړه (" + amount + ") لغوه کړه."},
	} {
		if got := detailedPushBody(c.kind, "ps-AF", "Ahmad", 525, "a_to_b", "AFN", "b", true); got != c.want {
			t.Errorf("%s actor/amount order: %q", c.kind, got)
		}
	}
	if got := pushBodyFor("entry_created", "ps", false); strings.Contains(got, "ویې منئ") {
		t.Fatal("observer asked to review")
	}
	if got := detailedPushBody("entry_created", "ps", "", 0, "", "", "", false); !strings.Contains(got, "بل لوری") {
		t.Fatal("missing Pashto actor fallback")
	}
}

func TestPashtoPushLanguagePersistence(t *testing.T) {
	f := newHTTPFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer provider.Close()
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	c := f.createOverHTTP(t, "")
	if _, err := f.svc.Bind(t.Context(), f.party(t, c.InviteToken, c.Tab.ID), BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	r := f.do(t, "POST", "/v1/tabs/"+c.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, f.acctB), map[string]string{
		"install_id": "11111111-1111-4111-8111-111111111111", "token": "ExpoPushToken[pashto_language_123456789]", "locale": "ps-AF",
	})
	if r.status != http.StatusOK {
		t.Fatalf("register: %d %s", r.status, r.body)
	}
	var lang string
	if err := f.pool.QueryRow(t.Context(), `SELECT locale FROM tab_push_subscriptions WHERE tab_id=$1 AND role='b'`, c.Tab.ID).Scan(&lang); err != nil || lang != "ps" {
		t.Fatalf("persisted language %q: %v", lang, err)
	}
}
