package tabs

import (
	"strings"
	"testing"
)

func TestAppOnlyInvitation(t *testing.T) {
	for _, rtl := range []bool{false, true} {
		var b strings.Builder
		err := viewTmpl.Execute(&b, viewData{Token: "x\"</script><script>alert(1)", RTL: rtl,
			PlayURL: playStoreURL, AppStoreURL: appStoreURL})
		if err != nil {
			t.Fatal(err)
		}
		html := b.String()
		for _, forbidden := range []string{"PRIVATE_NAME", "PRIVATE_BALANCE", "Authorization", "fetch(", "setInterval", "/v1/tabs", "</script><script>alert(1)"} {
			if strings.Contains(html, forbidden) {
				t.Fatalf("landing leaks/executes %q", forbidden)
			}
		}
		for _, required := range []string{"kaata://t/", "intent://t/", "App Store", "Google Play", "no-referrer"} {
			if !strings.Contains(html, required) {
				t.Fatalf("missing %q", required)
			}
		}
	}
}

func TestNotificationOnlyInvitationExplainsRecordingWithoutAcceptance(t *testing.T) {
	for _, lang := range []string{"en", "fa", "ps"} {
		var notice, legacy strings.Builder
		data := viewData{Token: "synthetic", Lang: lang, RTL: lang != "en", RecordingMode: "notify"}
		if err := viewTmpl.Execute(&notice, data); err != nil {
			t.Fatal(err)
		}
		data.RecordingMode = "review"
		if err := viewTmpl.Execute(&legacy, data); err != nil {
			t.Fatal(err)
		}
		if notice.String() == legacy.String() {
			t.Fatalf("%s invitation does not disclose notification-only recording", lang)
		}
		if strings.Contains(notice.String(), "confirmed_balance") || strings.Contains(notice.String(), "recorded_balance") {
			t.Fatal("invitation disclosed financial data")
		}
	}
}

func TestOneWayInvitationDisclosesWhoCanRecord(t *testing.T) {
	for _, tc := range []struct{ lang, required string }{
		{"en", "Only the person who created this link can add tallies"},
		{"fa", "فقط سازندهٔ این ارتباط"},
		{"ps", "یوازې د دې اړیکې جوړوونکی"},
	} {
		var notice strings.Builder
		data := viewData{Token: "synthetic", Lang: tc.lang, RTL: tc.lang != "en", RecordingMode: "notify_one_way"}
		if err := viewTmpl.Execute(&notice, data); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(notice.String(), tc.required) {
			t.Fatalf("%s invitation did not explain the read-only recipient", tc.lang)
		}
		for _, private := range []string{"PRIVATE_NAME", "recorded_balance", "confirmed_balance", "/v1/tabs", "fetch("} {
			if strings.Contains(notice.String(), private) {
				t.Fatalf("invitation disclosed financial detail %s", private)
			}
		}
	}
}
