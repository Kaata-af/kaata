package tabs

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
	_ "time/tzdata"
)

// NotificationPreferences governs delivery to one authenticated installation.
// It never affects the shared ledger or its durable inbox.
type NotificationPreferences struct {
	Enabled       bool                   `json:"enabled"`
	Tallies       bool                   `json:"tallies"`
	Reviews       bool                   `json:"reviews"`
	Cancellations bool                   `json:"cancellations"`
	Connections   bool                   `json:"connections"`
	Reminders     bool                   `json:"reminders"`
	Sound         bool                   `json:"sound"`
	Vibration     bool                   `json:"vibration"`
	Previews      string                 `json:"previews"`
	Foreground    bool                   `json:"foreground"`
	ReviewActions bool                   `json:"review_actions"`
	QuietHours    NotificationQuietHours `json:"quiet_hours"`
	TimeZone      string                 `json:"time_zone"`
}

type NotificationQuietHours struct {
	Enabled        bool `json:"enabled"`
	StartMinute    int  `json:"start_minute"`
	EndMinute      int  `json:"end_minute"`
	AllowReminders bool `json:"allow_reminders"`
}

// An absent preference object belongs to an older client. Keep its delivery
// behavior until that installation explicitly saves a policy.
func legacyNotificationPreferences() NotificationPreferences {
	return NotificationPreferences{
		Enabled: true, Tallies: true, Reviews: true, Cancellations: true,
		Connections: true, Reminders: true, Sound: true, Vibration: true,
		Previews: "full", ReviewActions: true, TimeZone: "UTC",
		QuietHours: NotificationQuietHours{StartMinute: 22 * 60, EndMinute: 7 * 60, AllowReminders: true},
	}
}

func decodeNotificationPreferences(raw []byte) (NotificationPreferences, error) {
	var p NotificationPreferences
	// Full objects keep false values explicit. In particular, null must never
	// accidentally enable alerts by behaving like an omitted boolean.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return p, errors.New("preferences must be an object")
	}
	for _, key := range []string{"enabled", "tallies", "reviews", "cancellations", "connections", "reminders", "sound", "vibration", "foreground", "review_actions"} {
		value, ok := fields[key]
		if !ok || (string(value) != "true" && string(value) != "false") {
			return p, fmt.Errorf("invalid notification boolean %s", key)
		}
	}
	var quiet map[string]json.RawMessage
	if err := json.Unmarshal(fields["quiet_hours"], &quiet); err != nil || quiet == nil {
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
		var minute int
		if !ok || string(value) == "null" || json.Unmarshal(value, &minute) != nil || minute < 0 || minute >= 24*60 {
			return p, errors.New("invalid quiet hours minute")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return p, err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return p, errors.New("invalid trailing notification preferences")
	}
	if p.Previews != "full" && p.Previews != "name" && p.Previews != "private" {
		return p, errors.New("invalid notification previews")
	}
	if p.TimeZone == "" || p.TimeZone == "Local" || len(p.TimeZone) > 80 {
		return p, errors.New("invalid notification time zone")
	}
	if _, err := time.LoadLocation(p.TimeZone); err != nil {
		return p, errors.New("invalid notification time zone")
	}
	if p.QuietHours.Enabled && p.QuietHours.StartMinute == p.QuietHours.EndMinute {
		return p, errors.New("quiet hours need distinct start and end")
	}
	return p, nil
}

func (p NotificationPreferences) permits(kind string, now time.Time) bool {
	if !p.Enabled {
		return false
	}
	switch kind {
	case "entry_created":
		if !p.Tallies {
			return false
		}
	case "entry_accepted", "entry_rejected":
		if !p.Reviews {
			return false
		}
	case "entry_voided":
		if !p.Cancellations {
			return false
		}
	case "customer_reminder":
		if !p.Reminders {
			return false
		}
	default:
		if !p.Connections {
			return false
		}
	}
	if !p.QuietHours.Enabled || (kind == "customer_reminder" && p.QuietHours.AllowReminders) {
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

func (p NotificationPreferences) channelID() string {
	sound, vibration := 0, 0
	if p.Sound {
		sound = 1
	}
	if p.Vibration {
		vibration = 1
	}
	return fmt.Sprintf("tab-updates-s%d-v%d", sound, vibration)
}

func (p NotificationPreferences) allowsReviewActions() bool {
	// Never offer a blind financial decision when its amount is hidden.
	return p.ReviewActions && p.Previews == "full"
}

func notificationBodyWithPreferences(p NotificationPreferences, kind, locale, actor string, minor int64, direction, currency, recipient string, canReview bool) string {
	canReview = canReview && p.allowsReviewActions()
	switch p.Previews {
	case "private":
		return pushBodyFor(kind, locale, false)
	case "name":
		return detailedPushBody(kind, locale, actor, 0, "", "", recipient, false)
	default:
		return detailedPushBody(kind, locale, actor, minor, direction, currency, recipient, canReview)
	}
}

func notificationPayloadWithPreferences(token, body string, data map[string]any, p *NotificationPreferences) map[string]any {
	payload := pushPayload(token, body, data)
	if p == nil {
		return payload
	}
	payload["channelId"] = p.channelID()
	if !p.Sound {
		delete(payload, "sound")
	}
	return payload
}
