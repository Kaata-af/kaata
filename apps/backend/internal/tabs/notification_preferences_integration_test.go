package tabs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func registerPreferences(t *testing.T, f *httpFixture, tabID, jwt, token string, preferences any) {
	t.Helper()
	body := map[string]any{"install_id": uuid.NewString(), "token": token, "locale": "en"}
	if preferences != nil {
		body["preferences"] = preferences
	}
	r := f.do(t, "POST", "/v1/tabs/"+tabID+"/notifications", "Bearer "+jwt, body)
	if r.status != http.StatusOK {
		t.Fatalf("register preferences: %d %s", r.status, r.body)
	}
}

func preferenceProvider(t *testing.T, f *httpFixture) (*atomic.Int32, <-chan map[string]any) {
	t.Helper()
	var sends atomic.Int32
	payloads := make(chan map[string]any, 20)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/send" {
			t.Error("unexpected provider endpoint", r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		sends.Add(1)
		payloads <- payload
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"synthetic-preference-ticket"}}`))
	}))
	t.Cleanup(provider.Close)
	f.svc.push = &pushClient{client: provider.Client(), baseURL: provider.URL}
	return &sends, payloads
}

func TestNotificationPreferenceRegistrationIsPersonalAndBackwardCompatible(t *testing.T) {
	f := newHTTPFixture(t)
	preferenceProvider(t, f)
	ctx := context.Background()
	created := f.createOverHTTP(t, "")
	pb := f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	jwt := f.jwtFor(t, f.acctB)
	const token = "ExpoPushToken[synthetic_preferences_B_123456]"
	p := legacyNotificationPreferences()
	p.Previews, p.Sound, p.TimeZone = "name", false, "Asia/Kabul"
	registerPreferences(t, f, created.Tab.ID, jwt, token, p)
	var installID string
	var stored []byte
	if err := f.pool.QueryRow(ctx, "SELECT install_id::text,preferences FROM tab_push_subscriptions WHERE tab_id=$1::uuid", created.Tab.ID).Scan(&installID, &stored); err != nil {
		t.Fatal(err)
	}
	var authenticated bool
	if err := f.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM auth_credentials WHERE install_id=$1::uuid AND account_id=$2::uuid AND revoked_at IS NULL)", installID, f.acctB).Scan(&authenticated); err != nil || !authenticated {
		t.Fatalf("policy is not bound to the JWT installation: %v %v", authenticated, err)
	}
	decoded, err := decodeNotificationPreferences(stored)
	if err != nil || !reflect.DeepEqual(decoded, p) {
		t.Fatalf("policy was not persisted faithfully: %#v %v", decoded, err)
	}
	// A language/token refresh from a legacy build cannot reset explicit choices.
	registerPreferences(t, f, created.Tab.ID, jwt, token, nil)
	var after []byte
	_ = f.pool.QueryRow(ctx, "SELECT preferences FROM tab_push_subscriptions WHERE tab_id=$1::uuid AND install_id=$2::uuid", created.Tab.ID, installID).Scan(&after)
	if string(stored) != string(after) {
		t.Fatal("legacy registration reset the existing preference object")
	}
	for _, invalid := range []any{map[string]any{}, []any{}, "muted", map[string]any{"enabled": false}} {
		r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+jwt, map[string]any{
			"install_id": installID, "token": token, "preferences": invalid,
		})
		if r.status != http.StatusBadRequest {
			t.Fatalf("invalid preferences accepted: %d %s", r.status, r.body)
		}
	}
	r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+jwt, map[string]any{
		"install_id": installID, "token": token, "preferences": json.RawMessage("null"),
	})
	if r.status != http.StatusBadRequest {
		t.Fatalf("explicit null cannot erase privacy preferences: %d %s", r.status, r.body)
	}
	// This second session supplies the first phone's ID, but only changes itself.
	secondJWT := f.jwtFor(t, f.acctB)
	second := p
	second.Enabled = false
	const secondToken = "ExpoPushToken[synthetic_preferences_second_123456]"
	r = f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+secondJWT, map[string]any{
		"install_id": installID, "token": secondToken, "preferences": second,
	})
	if r.status != http.StatusOK {
		t.Fatalf("second installation: %d %s", r.status, r.body)
	}
	_ = f.pool.QueryRow(ctx, "SELECT preferences FROM tab_push_subscriptions WHERE tab_id=$1::uuid AND install_id=$2::uuid", created.Tab.ID, installID).Scan(&after)
	if string(stored) != string(after) {
		t.Fatal("a supplied install_id changed another phone's policy")
	}
	var subscriptions int
	_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_push_subscriptions WHERE tab_id=$1::uuid", created.Tab.ID).Scan(&subscriptions)
	if subscriptions != 2 {
		t.Fatalf("authenticated installations lost independent policies: %d", subscriptions)
	}
	stranger := seedAccount(t, f.pool, "stranger-pref@example.com", "Stranger")
	r = f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, stranger), map[string]any{
		"install_id": installID, "token": token, "preferences": second,
	})
	if r.status != http.StatusNotFound && r.status != http.StatusForbidden {
		t.Fatalf("nonparty modified preferences: %d %s", r.status, r.body)
	}
}

func TestNotificationPreferencesApplyLatestPolicyWithoutErasingInbox(t *testing.T) {
	f := newHTTPFixture(t)
	sends, _ := preferenceProvider(t, f)
	ctx := context.Background()
	created := f.createOverHTTP(t, "")
	pa, pb := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	jwt := f.jwtFor(t, f.acctB)
	const token = "ExpoPushToken[synthetic_latest_policy_123456]"
	for _, tc := range []struct {
		name   string
		change func(*NotificationPreferences)
		badDB  bool
	}{
		{"master mute", func(p *NotificationPreferences) { p.Enabled = false }, false},
		{"new tally category", func(p *NotificationPreferences) { p.Tallies = false }, false},
		{"quiet hours", func(p *NotificationPreferences) {
			minute := time.Now().UTC().Hour()*60 + time.Now().UTC().Minute()
			p.QuietHours.Enabled = true
			p.QuietHours.StartMinute = (minute + 24*60 - 30) % (24 * 60)
			p.QuietHours.EndMinute = (minute + 30) % (24 * 60)
		}, false},
		{"malformed persisted policy fails closed", func(*NotificationPreferences) {}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := legacyNotificationPreferences()
			registerPreferences(t, f, created.Tab.ID, jwt, token, p)
			entry := f.append(t, pa, "a_to_b", "123.45", time.Now().UnixMilli())
			var original string
			if err := f.pool.QueryRow(ctx, "SELECT to_jsonb(e)::text FROM tab_entries e WHERE id=$1::uuid", entry.Entry.ID).Scan(&original); err != nil {
				t.Fatal(err)
			}
			tc.change(&p)
			registerPreferences(t, f, created.Tab.ID, jwt, token, p)
			if tc.badDB {
				if _, err := f.pool.Exec(ctx, `UPDATE tab_push_subscriptions SET preferences='{"enabled":true}'::jsonb WHERE tab_id=$1::uuid`, created.Tab.ID); err != nil {
					t.Fatal(err)
				}
			}
			if more, err := f.svc.deliverPush(ctx); err != nil || !more {
				t.Fatalf("consume muted job: %v %v", more, err)
			}
			if sends.Load() != 0 {
				t.Fatal("a queued message bypassed the most recent policy")
			}
			var jobs, notices int
			_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_push_outbox").Scan(&jobs)
			_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_notifications WHERE tab_id=$1::uuid AND entry_id=$2::uuid", created.Tab.ID, entry.Entry.ID).Scan(&notices)
			if jobs != 0 || notices != 1 {
				t.Fatalf("mute must drop only delivery, retain inbox: jobs=%d notices=%d", jobs, notices)
			}
			var unchanged string
			_ = f.pool.QueryRow(ctx, "SELECT to_jsonb(e)::text FROM tab_entries e WHERE id=$1::uuid", entry.Entry.ID).Scan(&unchanged)
			if original != unchanged {
				t.Fatal("a notification preference mutated the tally")
			}
			registerPreferences(t, f, created.Tab.ID, jwt, token, legacyNotificationPreferences())
			if more, err := f.svc.deliverPush(ctx); err != nil || more || sends.Load() != 0 {
				t.Fatalf("unmuting replayed stale alerts: %v %v sends=%d", more, err, sends.Load())
			}
		})
	}
}

func TestNotificationPreferencesPersistWhileProviderIsDisabled(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()
	created := f.createOverHTTP(t, "")
	pb := f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	jwt := f.jwtFor(t, f.acctB)
	p := legacyNotificationPreferences()
	p.Enabled, p.Previews = false, "private"
	body := map[string]any{
		"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_disabled_provider_123456]", "preferences": p,
	}
	r := f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+jwt, body)
	if r.status != http.StatusOK || !strings.Contains(string(r.body), `"enabled":false`) {
		t.Fatalf("disabled provider must report unavailable: %d %s", r.status, r.body)
	}
	var raw []byte
	if err := f.pool.QueryRow(ctx, "SELECT preferences FROM tab_push_subscriptions WHERE tab_id=$1::uuid", created.Tab.ID).Scan(&raw); err != nil {
		t.Fatal("disabled provider dropped a privacy setting", err)
	}
	policy, err := decodeNotificationPreferences(raw)
	if err != nil || policy.Enabled || policy.Previews != "private" {
		t.Fatalf("disabled provider persisted wrong preference: %#v %v", policy, err)
	}
	body["token"] = ""
	r = f.do(t, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+jwt, body)
	if r.status != http.StatusOK {
		t.Fatalf("disabled provider did not honor unregister: %d %s", r.status, r.body)
	}
	var count int
	_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_push_subscriptions WHERE tab_id=$1::uuid", created.Tab.ID).Scan(&count)
	if count != 0 {
		t.Fatal("revoked installation survived provider downtime")
	}
}

func TestNotificationPreferencesShapeActualProviderPayload(t *testing.T) {
	f := newHTTPFixture(t)
	_, payloads := preferenceProvider(t, f)
	ctx := context.Background()
	created := f.createOverHTTP(t, "")
	pa, pb := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	jwt := f.jwtFor(t, f.acctB)
	const token = "ExpoPushToken[synthetic_preview_policy_123456]"
	for _, tc := range []struct {
		preview                 string
		sound, vibration, quick bool
		wantActor, wantAmount   bool
	}{
		{"full", true, false, true, true, true},
		{"full", true, true, false, true, true},
		{"name", false, true, true, true, false},
		{"private", false, false, true, false, false},
	} {
		t.Run(tc.preview+":"+boolString(tc.quick), func(t *testing.T) {
			p := legacyNotificationPreferences()
			p.Previews, p.Sound, p.Vibration, p.ReviewActions = tc.preview, tc.sound, tc.vibration, tc.quick
			registerPreferences(t, f, created.Tab.ID, jwt, token, p)
			entry := f.append(t, pa, "a_to_b", "123.45", time.Now().UnixMilli())
			if more, err := f.svc.deliverPush(ctx); err != nil || !more {
				t.Fatalf("send: %v %v", more, err)
			}
			var payload map[string]any
			select {
			case payload = <-payloads:
			case <-time.After(time.Second):
				t.Fatal("provider received no eligible alert")
			}
			body := payload["body"].(string)
			if strings.Contains(body, "Matee") != tc.wantActor || strings.Contains(body, "AFN") != tc.wantAmount {
				t.Fatalf("privacy mode leaked/omitted content: %s", body)
			}
			_, actions := payload["categoryId"]
			if actions != (tc.quick && tc.preview == "full") {
				t.Fatalf("incorrect review actions: %#v", payload)
			}
			if payload["channelId"] != p.channelID() {
				t.Fatalf("sound/vibration selected wrong channel: %#v", payload)
			}
			if _, sound := payload["sound"]; sound != tc.sound {
				t.Fatal("silent policy sent an iOS sound")
			}
			data := payload["data"].(map[string]any)
			if data["entry_id"] != entry.Entry.ID || len(data) > 6 {
				t.Fatal("notification lost navigation or gained private money data", data)
			}
			if _, err := f.pool.Exec(ctx, "DELETE FROM tab_push_outbox"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func boolString(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

func TestNotificationPreferencesRecordedTalliesNotifyWithoutReviewActions(t *testing.T) {
	f := newHTTPFixture(t)
	_, payloads := preferenceProvider(t, f)
	ctx := context.Background()
	created, err := f.svc.Create(ctx, CreateInput{RecordingMode: "notify", Currency: "AFN", Label: "A", AccountID: &f.acctA, VaultID: &f.vaultA})
	if err != nil {
		t.Fatal(err)
	}
	pa, pb := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Join(ctx, pb, JoinInput{Label: "B", AccountID: &f.acctB, VaultID: &f.vaultB}); err != nil {
		t.Fatal(err)
	}
	policy := legacyNotificationPreferences()
	result := recordingHTTP(t, f, "POST", "/v1/tabs/"+created.Tab.ID+"/notifications", "Bearer "+f.jwtFor(t, f.acctB), map[string]any{
		"install_id": uuid.NewString(), "token": "ExpoPushToken[synthetic_recorded_delivery_123456]", "preferences": policy,
	})
	if result.status != http.StatusOK {
		t.Fatalf("notify-mode registration: %d %s", result.status, result.body)
	}
	entry := f.append(t, pa, "a_to_b", "12.50", time.Now().UnixMilli())
	if entry.Entry.Status != "recorded" || entry.Entry.ReviewerAccountID != nil || entry.Entry.ReviewerParty != nil || entry.Entry.ReviewSemanticsVersion != nil {
		t.Fatal("tally was not independently recorded", entry.Entry)
	}
	if more, err := f.svc.deliverPush(ctx); err != nil || !more {
		t.Fatalf("recorded notification was suppressed: %v %v", more, err)
	}
	select {
	case payload := <-payloads:
		body := payload["body"].(string)
		if _, actions := payload["categoryId"]; actions || strings.Contains(body, "Accept or reject") {
			t.Fatalf("recorded tally asks for a fictional review: %#v", payload)
		}
		if !strings.Contains(body, "Matee") || !strings.Contains(body, "12.5 AFN") {
			t.Fatalf("recorded notification lost its actor or amount: %s", body)
		}
		if payload["data"].(map[string]any)["entry_id"] != entry.Entry.ID {
			t.Fatal("recorded notification lost its navigation target")
		}
	case <-time.After(time.Second):
		t.Fatal("no recorded tally reached the synthetic provider")
	}
}

func TestNotificationPreferencesMuteReviewAndCancellationOutcomes(t *testing.T) {
	f := newHTTPFixture(t)
	sends, _ := preferenceProvider(t, f)
	ctx := context.Background()
	created := f.createOverHTTP(t, "")
	pa, pb := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	p := legacyNotificationPreferences()
	p.Reviews, p.Cancellations = false, false
	registerPreferences(t, f, created.Tab.ID, f.jwtFor(t, f.acctA), "ExpoPushToken[synthetic_review_muted_A_123456]", p)
	registerPreferences(t, f, created.Tab.ID, f.jwtFor(t, f.acctB), "ExpoPushToken[synthetic_review_muted_B_123456]", p)
	for _, kind := range []string{"entry_accepted", "entry_rejected", "entry_voided"} {
		entry := f.append(t, pa, "a_to_b", "1", time.Now().UnixMilli())
		if _, err := f.pool.Exec(ctx, "DELETE FROM tab_push_outbox"); err != nil {
			t.Fatal(err)
		}
		var err error
		switch kind {
		case "entry_accepted":
			_, err = f.svc.Accept(ctx, pb, entry.Entry.ID)
		case "entry_rejected":
			_, err = f.svc.Dispute(ctx, pb, entry.Entry.ID, "")
		case "entry_voided":
			_, err = f.svc.Void(ctx, pa, entry.Entry.ID)
		}
		if err != nil {
			t.Fatalf("actual outcome %s: %v", kind, err)
		}
		if more, err := f.svc.deliverPush(ctx); err != nil || more || sends.Load() != 0 {
			t.Fatalf("outcome category ignored policy %s: more=%v err=%v sends=%d", kind, more, err, sends.Load())
		}
		var notices int
		_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_notifications WHERE tab_id=$1::uuid AND entry_id=$2::uuid AND event_kind=$3", created.Tab.ID, entry.Entry.ID, kind).Scan(&notices)
		if notices != 1 {
			t.Fatalf("muting erased outcome evidence %s", kind)
		}
	}
}

func TestNotificationPreferencesDoNotQueueMutedActivityForLaterUnmute(t *testing.T) {
	f := newHTTPFixture(t)
	sends, _ := preferenceProvider(t, f)
	ctx := context.Background()
	created := f.createOverHTTP(t, "")
	pa, pb := f.party(t, created.MyToken, created.Tab.ID), f.party(t, created.InviteToken, created.Tab.ID)
	if _, err := f.svc.Bind(ctx, pb, BindInput{AccountID: f.acctB}); err != nil {
		t.Fatal(err)
	}
	jwt := f.jwtFor(t, f.acctB)
	const token = "ExpoPushToken[synthetic_no_unmute_backlog_123456]"
	for _, tc := range []struct {
		name string
		mute func(*NotificationPreferences)
	}{
		{"master", func(p *NotificationPreferences) { p.Enabled = false }},
		{"category", func(p *NotificationPreferences) { p.Tallies = false }},
		{"quiet", func(p *NotificationPreferences) {
			minute := time.Now().UTC().Hour()*60 + time.Now().UTC().Minute()
			p.QuietHours.Enabled = true
			p.QuietHours.StartMinute = (minute + 24*60 - 30) % (24 * 60)
			p.QuietHours.EndMinute = (minute + 30) % (24 * 60)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := legacyNotificationPreferences()
			tc.mute(&p)
			registerPreferences(t, f, created.Tab.ID, jwt, token, p)
			entry := f.append(t, pa, "a_to_b", "1", time.Now().UnixMilli())
			var jobs, notices int
			_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_push_outbox").Scan(&jobs)
			_ = f.pool.QueryRow(ctx, "SELECT COUNT(*) FROM tab_notifications WHERE tab_id=$1::uuid AND entry_id=$2::uuid", created.Tab.ID, entry.Entry.ID).Scan(&notices)
			if jobs != 0 || notices != 1 {
				t.Fatalf("muted activity must create inbox only: jobs=%d notices=%d", jobs, notices)
			}
			registerPreferences(t, f, created.Tab.ID, jwt, token, legacyNotificationPreferences())
			if more, err := f.svc.deliverPush(ctx); err != nil || more || sends.Load() != 0 {
				t.Fatalf("unmute replayed an event from muted time: %v %v sends=%d", more, err, sends.Load())
			}
		})
	}
}
