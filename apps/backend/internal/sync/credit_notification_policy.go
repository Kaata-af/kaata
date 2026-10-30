package sync

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
	_ "time/tzdata"
)

// Keep the existing installation privacy/sound/quiet-hour contract without a
// tabs dependency. CreditAlerts is additive and defaults to true for old prefs.
type creditNotificationPreferences struct {
	Enabled       bool   `json:"enabled"`
	Tallies       bool   `json:"tallies"`
	Reviews       bool   `json:"reviews"`
	Cancellations bool   `json:"cancellations"`
	Connections   bool   `json:"connections"`
	Reminders     bool   `json:"reminders"`
	CreditAlerts  bool   `json:"credit_alerts"`
	Sound         bool   `json:"sound"`
	Vibration     bool   `json:"vibration"`
	Previews      string `json:"previews"`
	Foreground    bool   `json:"foreground"`
	ReviewActions bool   `json:"review_actions"`
	QuietHours    struct {
		Enabled        bool `json:"enabled"`
		StartMinute    int  `json:"start_minute"`
		EndMinute      int  `json:"end_minute"`
		AllowReminders bool `json:"allow_reminders"`
	} `json:"quiet_hours"`
	TimeZone string `json:"time_zone"`
}

func defaultCreditNotificationPreferences() creditNotificationPreferences {
	p := creditNotificationPreferences{Enabled: true, Tallies: true, Reviews: true, Cancellations: true, Connections: true, Reminders: true, CreditAlerts: true, Sound: true, Vibration: true, Previews: "full", ReviewActions: true, TimeZone: "UTC"}
	p.QuietHours.StartMinute, p.QuietHours.EndMinute, p.QuietHours.AllowReminders = 22*60, 7*60, true
	return p
}

func decodeCreditNotificationPreferences(raw []byte) (creditNotificationPreferences, error) {
	p := defaultCreditNotificationPreferences()
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return p, errors.New("preferences must be an object")
	}
	for _, key := range []string{"enabled", "tallies", "reviews", "cancellations", "connections", "reminders", "sound", "vibration", "foreground", "review_actions"} {
		value, ok := fields[key]
		if !ok || (string(value) != "true" && string(value) != "false") {
			return p, fmt.Errorf("invalid notification boolean %s", key)
		}
	}
	if value, ok := fields["credit_alerts"]; ok && string(value) != "true" && string(value) != "false" {
		return p, errors.New("invalid credit alert preference")
	}
	var quiet map[string]json.RawMessage
	if json.Unmarshal(fields["quiet_hours"], &quiet) != nil || quiet == nil {
		return p, errors.New("invalid quiet hours")
	}
	for _, key := range []string{"enabled", "allow_reminders"} {
		value, ok := quiet[key]
		if !ok || (string(value) != "true" && string(value) != "false") {
			return p, errors.New("invalid quiet hours boolean")
		}
	}
	for _, key := range []string{"start_minute", "end_minute"} {
		value, ok := quiet[key]
		var n int
		if !ok || string(value) == "null" || json.Unmarshal(value, &n) != nil || n < 0 || n >= 24*60 {
			return p, errors.New("invalid quiet hours minute")
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return p, err
	}
	if d.Decode(new(any)) != io.EOF {
		return p, errors.New("invalid trailing preferences")
	}
	if p.Previews != "full" && p.Previews != "name" && p.Previews != "private" {
		return p, errors.New("invalid notification previews")
	}
	if p.TimeZone == "" || p.TimeZone == "Local" || len(p.TimeZone) > 80 {
		return p, errors.New("invalid time zone")
	}
	if _, err := time.LoadLocation(p.TimeZone); err != nil {
		return p, errors.New("invalid time zone")
	}
	if p.QuietHours.Enabled && p.QuietHours.StartMinute == p.QuietHours.EndMinute {
		return p, errors.New("quiet hours need distinct times")
	}
	return p, nil
}

func (p creditNotificationPreferences) permits(now time.Time) bool {
	if !p.Enabled || !p.CreditAlerts {
		return false
	}
	if !p.QuietHours.Enabled {
		return true
	}
	zone, err := time.LoadLocation(p.TimeZone)
	if err != nil {
		return false
	}
	local := now.In(zone)
	minute := local.Hour()*60 + local.Minute()
	start, end := p.QuietHours.StartMinute, p.QuietHours.EndMinute
	quiet := minute >= start && minute < end
	if start > end {
		quiet = minute >= start || minute < end
	}
	return !quiet
}

type creditCustomerPreferences struct {
	RelationshipID string          `json:"relationship_id"`
	Preferences    json.RawMessage `json:"preferences"`
}

func creditPreferencesFor(raw, customers []byte, relationshipID string) (creditNotificationPreferences, error) {
	p, err := decodeCreditNotificationPreferences(raw)
	if err != nil {
		return p, err
	}
	var overrides []creditCustomerPreferences
	if err := json.Unmarshal(customers, &overrides); err != nil {
		return p, err
	}
	for _, c := range overrides {
		if c.RelationshipID == relationshipID {
			effective, err := decodeCreditNotificationPreferences(c.Preferences)
			effective.Enabled = effective.Enabled && p.Enabled
			return effective, err
		}
	}
	return p, nil
}
