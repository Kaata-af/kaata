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
// an actual push provider. Every event keeps the configured Kaata icon; the
// client uses data.kind to add its local colored corner badge.
func TestPushNotificationPayloadOmitsIconOverride(t *testing.T) {
	for _, kind := range []string{
		"entry_created",
		"entry_accepted",
		"entry_rejected",
		"entry_voided",
		"updated",
		"unknown",
		"",
	} {
		t.Run(kind, func(t *testing.T) {
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
				"rev": int64(7), "kind": kind, "role": "b", "actor_account_id": "synthetic-actor"}
			const token = "ExpoPushToken[synthetic_status_contract]"
			const body = "احمد: 12 AFN — synthetic tally"
			var response struct {
				Data pushTicket `json:"data"`
			}
			if err := client.post(context.Background(), "/send", pushPayload(token, body, data), &response); err != nil {
				t.Fatal(err)
			}
			if response.Data.Status != "ok" || response.Data.ID != "synthetic-ticket" {
				t.Fatal("push ticket contract changed")
			}
			want := map[string]any{"to": token, "title": "Kaata", "body": body, "sound": "default",
				"channelId": "tab-updates", "ttl": float64(86400),
				"data": map[string]any{"tab_id": "synthetic-tab", "entry_id": "synthetic-entry",
					"rev": float64(7), "kind": kind, "role": "b", "actor_account_id": "synthetic-actor"}}
			got := <-requests
			if _, overridesIcon := got["icon"]; overridesIcon {
				t.Fatal("push must retain the configured Kaata icon")
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("serialized push payload: got %#v, want %#v", got, want)
			}
			if len(data) != 6 || data["rev"] != int64(7) {
				t.Fatal("building a notification mutated its navigation data")
			}
		})
	}
}
