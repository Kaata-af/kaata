package tabs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// Exercise the production payload builder and HTTP encoder without Postgres or
// an actual push provider. Unknown events must retain the configured default.
func TestPushNotificationPayloadIcons(t *testing.T) {
	for _, tc := range []struct {
		kind, icon string
	}{
		{"entry_created", "kaata_notification_pending"},
		{"entry_accepted", "kaata_notification_accepted"},
		{"entry_rejected", "kaata_notification_rejected"},
		{"entry_voided", ""},
		{"updated", ""},
		{"unknown", ""},
		{"", ""},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			requests := make(chan map[string]any, 1)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/send" || r.Header.Get("Content-Type") != "application/json" {
					t.Error("push HTTP contract changed")
					http.Error(w, "invalid request", http.StatusBadRequest)
					return
				}
				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
					http.Error(w, "invalid JSON", http.StatusBadRequest)
					return
				}
				requests <- payload
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"synthetic-ticket"}}`))
			}))
			defer provider.Close()
			client := &pushClient{client: provider.Client(), baseURL: provider.URL}
			data := map[string]any{"tab_id": "synthetic-tab", "entry_id": "synthetic-entry",
				"rev": int64(7), "kind": tc.kind, "role": "b", "actor_account_id": "synthetic-actor"}
			const token = "ExpoPushToken[synthetic_status_contract]"
			const body = "احمد: 12 AFN — synthetic tally"
			var response struct {
				Data pushTicket `json:"data"`
			}
			if err := client.post(context.Background(), "/send", pushPayload(token, body, tc.kind, data), &response); err != nil {
				t.Fatal(err)
			}
			if response.Data.Status != "ok" || response.Data.ID != "synthetic-ticket" {
				t.Fatal("push ticket contract changed")
			}
			want := map[string]any{"to": token, "title": "Kaata", "body": body, "sound": "default",
				"channelId": "tab-updates", "ttl": float64(86400),
				"data": map[string]any{"tab_id": "synthetic-tab", "entry_id": "synthetic-entry",
					"rev": float64(7), "kind": tc.kind, "role": "b", "actor_account_id": "synthetic-actor"}}
			if tc.icon != "" {
				want["icon"] = tc.icon
			}
			if got := <-requests; !reflect.DeepEqual(got, want) {
				t.Fatalf("serialized push payload: got %#v, want %#v", got, want)
			}
			if len(data) != 6 || data["rev"] != int64(7) {
				t.Fatal("building a notification mutated its navigation data")
			}
		})
	}
}
