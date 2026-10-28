package tabs

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func preferencesJSON(t *testing.T, p NotificationPreferences) []byte {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestNotificationPreferencesValidateCompleteTypedPolicy(t *testing.T) {
	p := legacyNotificationPreferences()
	p.Previews, p.TimeZone = "name", "Asia/Kabul"
	raw := preferencesJSON(t, p)
	got, err := decodeNotificationPreferences(raw)
	if err != nil || !reflect.DeepEqual(got, p) {
		t.Fatalf("round trip: %#v %v", got, err)
	}
	for _, invalid := range []string{
		`null`, `[]`, `{}`, string(raw) + `{}`,
		strings.Replace(string(raw), `"enabled":true`, `"enabled":null`, 1),
		strings.Replace(string(raw), `"sound":true`, `"sound":"true"`, 1),
		strings.Replace(string(raw), `"previews":"name"`, `"previews":"all"`, 1),
		strings.Replace(string(raw), `"time_zone":"Asia/Kabul"`, `"time_zone":"Local"`, 1),
		strings.Replace(string(raw), `"time_zone":"Asia/Kabul"`, `"time_zone":"No/Such_Zone"`, 1),
		strings.Replace(string(raw), `"start_minute":1320`, `"start_minute":1440`, 1),
		strings.Replace(string(raw), `"end_minute":420`, `"end_minute":-1`, 1),
		strings.Replace(string(raw), `"end_minute":420`, `"end_minute":420.5`, 1),
		strings.Replace(string(raw), `"end_minute":420`, `"end_minute":null`, 1),
		strings.Replace(string(raw), `"allow_reminders":true`, `"allow_reminders":null`, 1),
		strings.TrimSuffix(string(raw), "}") + `,"unexpected":true}`,
	} {
		if _, err := decodeNotificationPreferences([]byte(invalid)); err == nil {
			t.Errorf("accepted invalid policy: %s", invalid)
		}
	}
	p.QuietHours.Enabled = true
	p.QuietHours.EndMinute = p.QuietHours.StartMinute
	if _, err := decodeNotificationPreferences(preferencesJSON(t, p)); err == nil {
		t.Fatal("enabled quiet hours cannot silently mean all day or no hours")
	}
	p.QuietHours.Enabled = false
	if _, err := decodeNotificationPreferences(preferencesJSON(t, p)); err != nil {
		t.Fatal("inactive equal-hour draft must remain saveable", err)
	}
}

func TestNotificationPreferencesCategoriesRemainIndependent(t *testing.T) {
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		kind string
		mute func(*NotificationPreferences)
	}{
		{"entry_created", func(p *NotificationPreferences) { p.Tallies = false }},
		{"entry_accepted", func(p *NotificationPreferences) { p.Reviews = false }},
		{"entry_rejected", func(p *NotificationPreferences) { p.Reviews = false }},
		{"entry_voided", func(p *NotificationPreferences) { p.Cancellations = false }},
		{"joined", func(p *NotificationPreferences) { p.Connections = false }},
		{"updated", func(p *NotificationPreferences) { p.Connections = false }},
		{"customer_reminder", func(p *NotificationPreferences) { p.Reminders = false }},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			p := legacyNotificationPreferences()
			if !p.permits(tc.kind, now) {
				t.Fatal("legacy defaults disabled a live event")
			}
			tc.mute(&p)
			if p.permits(tc.kind, now) {
				t.Fatal("muted category still alerts")
			}
			p = legacyNotificationPreferences()
			p.Enabled = false
			if p.permits(tc.kind, now) {
				t.Fatal("master mute must override every event category")
			}
		})
	}
}

func TestNotificationQuietHoursUseLocalClockIncludingDST(t *testing.T) {
	p := legacyNotificationPreferences()
	p.TimeZone = "Asia/Kabul"
	p.QuietHours.Enabled = true
	for _, tc := range []struct {
		utc   string
		allow bool
	}{
		{"2026-10-28T17:29:00Z", true},  // 21:59
		{"2026-10-28T17:30:00Z", false}, // 22:00
		{"2026-10-28T23:30:00Z", false}, // 04:00 next day
		{"2026-10-29T02:29:00Z", false}, // 06:59
		{"2026-10-29T02:30:00Z", true},  // 07:00
	} {
		now, _ := time.Parse(time.RFC3339, tc.utc)
		if got := p.permits("entry_created", now); got != tc.allow {
			t.Errorf("Kabul %s: allow=%v want=%v", tc.utc, got, tc.allow)
		}
	}
	night, _ := time.Parse(time.RFC3339, "2026-10-28T23:30:00Z")
	if !p.permits("customer_reminder", night) {
		t.Fatal("explicit reminder exception was ignored")
	}
	p.QuietHours.AllowReminders = false
	if p.permits("customer_reminder", night) {
		t.Fatal("quiet reminder still alerts without its exception")
	}
	p.TimeZone = "America/New_York"
	p.QuietHours.StartMinute, p.QuietHours.EndMinute = 60, 180
	// Both repetitions of 01:30 on the autumn DST boundary are quiet.
	for _, utc := range []string{"2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"} {
		now, _ := time.Parse(time.RFC3339, utc)
		if p.permits("entry_created", now) {
			t.Fatalf("DST repeated local hour leaked an alert: %s", utc)
		}
	}
	// Spring clock skips 02:00. The remaining part of the interval is quiet.
	for _, utc := range []string{"2026-03-08T06:30:00Z", "2026-03-08T07:00:00Z"} {
		now, _ := time.Parse(time.RFC3339, utc)
		want := strings.Contains(utc, "07:00") // exactly local03:00 is the end
		if got := p.permits("entry_created", now); got != want {
			t.Fatalf("DST spring boundary: %s allow=%v want=%v", utc, got, want)
		}
	}
	p.TimeZone = "UTC"
	p.QuietHours.StartMinute, p.QuietHours.EndMinute = 9*60, 17*60
	if p.permits("updated", time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)) ||
		!p.permits("updated", time.Date(2026, 10, 28, 17, 0, 0, 0, time.UTC)) {
		t.Fatal("same-day quiet hours must use an inclusive start and exclusive end")
	}
}

func TestNotificationPreviewsAndQuickActionsProtectAmounts(t *testing.T) {
	for _, locale := range []string{"en", "fa", "ps"} {
		for _, kind := range []string{"entry_created", "entry_accepted", "entry_rejected", "entry_voided", "updated"} {
			p := legacyNotificationPreferences()
			full := notificationBodyWithPreferences(p, kind, locale, "Matee", 12345, "a_to_b", "AFN", "b", true)
			if !strings.Contains(full, "Matee") || (kind != "updated" && !strings.Contains(full, "AFN")) {
				t.Fatalf("full preview lost its details: %s", full)
			}
			p.Previews = "name"
			name := notificationBodyWithPreferences(p, kind, locale, "Matee\n\u202e", 12345, "a_to_b", "AFN", "b", true)
			if !strings.Contains(name, "Matee") || strings.Contains(name, "AFN") || strings.Contains(name, "123") || strings.ContainsAny(name, "\n\u202e") {
				t.Fatalf("name preview leaked money or unsanitized actor: %s", name)
			}
			if p.allowsReviewActions() {
				t.Fatal("hidden amount cannot offer a blind financial decision")
			}
			p.Previews = "private"
			private := notificationBodyWithPreferences(p, kind, locale, "Matee", 12345, "a_to_b", "AFN", "b", true)
			if strings.Contains(private, "Matee") || strings.Contains(private, "AFN") || strings.Contains(private, "123") || p.allowsReviewActions() {
				t.Fatalf("private preview leaked identity or amount: %s", private)
			}
		}
	}
	p := legacyNotificationPreferences()
	p.ReviewActions = false
	if p.allowsReviewActions() {
		t.Fatal("explicitly muted quick actions stayed enabled")
	}
}

func TestNotificationPreferencePayloadChannelsAndLegacyFallback(t *testing.T) {
	data := map[string]any{"tab_id": "opaque", "rev": int64(1), "kind": "entry_created"}
	legacy := notificationPayloadWithPreferences("synthetic-token", "body", data, nil)
	if legacy["channelId"] != "tab-updates" || legacy["sound"] != "default" {
		t.Fatal("legacy client delivery changed", legacy)
	}
	for _, sound := range []bool{false, true} {
		for _, vibration := range []bool{false, true} {
			p := legacyNotificationPreferences()
			p.Sound, p.Vibration = sound, vibration
			payload := notificationPayloadWithPreferences("synthetic-token", "body", data, &p)
			if payload["channelId"] != p.channelID() {
				t.Fatal("wrong immutable Android channel", payload)
			}
			if _, hasSound := payload["sound"]; hasSound != sound {
				t.Fatal("silent iOS payload still requests a sound", payload)
			}
			if _, icon := payload["icon"]; icon {
				t.Fatal("policy overrides the configured Kaata icon")
			}
			if len(data) != 3 || payload["data"] == nil {
				t.Fatal("policy mutated opaque navigation data")
			}
		}
	}
}
