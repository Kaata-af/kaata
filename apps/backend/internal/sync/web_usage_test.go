package sync

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

type webUsageFixture struct {
	*m1Fixture
	key    ed25519.PrivateKey
	claims *auth.SessionClaims
	token  string
}

func newWebUsageFixture(t *testing.T) *webUsageFixture {
	t.Helper()
	f := newM1Fixture(t)
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO installs(install_id,account_id,platform,app_version,last_seen_at)
		VALUES($1::uuid,$2::uuid,'web','web',NOW()-INTERVAL '2 days')`, f.deviceID, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO auth_credentials(install_id,account_id,provider,provider_sub,session_epoch)
		VALUES($1::uuid,$2::uuid,'google','web-usage',1)`, f.deviceID, f.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_devices(vault_id,device_id,account_id,device_pubkey,added_at_ms)
		VALUES($1::uuid,$2::uuid,$3::uuid,$4,0)`, f.vaultID, f.deviceID, f.accountID, []byte(pub)); err != nil {
		t.Fatal(err)
	}
	token, err := auth.SignSessionEpoch(testJWTSecret, f.accountID, f.deviceID, "google", "web-usage", 1)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := auth.ParseSession(testJWTSecret, token)
	if err != nil {
		t.Fatal(err)
	}
	return &webUsageFixture{m1Fixture: f, key: key, claims: claims, token: token}
}

func (f *webUsageFixture) signed(t *testing.T, ev PushEvent, key ed25519.PrivateKey) PushEvent {
	t.Helper()
	data, err := canonicalSignableEvent(f.vaultID, &ev)
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(key, data))
	pub := base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
	ev.EventSigB64, ev.SignerDevicePubkeyB64 = &sig, &pub
	return ev
}

func (f *webUsageFixture) usage(t *testing.T) (entries, customers int64, at *time.Time) {
	t.Helper()
	if err := f.pool.QueryRow(t.Context(), `SELECT usage_entries_created,usage_customers_added,last_activity_at
		FROM installs WHERE install_id=$1::uuid`, f.deviceID).Scan(&entries, &customers, &at); err != nil {
		t.Fatal(err)
	}
	return
}

func TestWebPushUsageRecordsOnlyFreshAcceptedSignedBrowserActions(t *testing.T) {
	f := newWebUsageFixture(t)
	// Fixture/restore writes without a live browser session are not web actions.
	rel := seedCreditContact(t, f.m1Fixture)
	person := f.event(nil)
	person.EventType = EventPersonAdded
	user, relationship := uuid.NewString(), uuid.NewString()
	person.TargetID, person.RelationshipID = &user, &relationship
	person.Payload = json.RawMessage(`{"user_id":"` + user + `","name":"Customer two","phone_e164":null,"relationship_context":"peer"}`)
	person = f.signed(t, person, f.key)
	entry := f.signed(t, creditEntry(f.m1Fixture, rel, "debt", "20"), f.key)
	future := creditEntry(f.m1Fixture, rel, "debt", "1")
	future.HLC.PhysicalMS = time.Now().Add(72 * time.Hour).UnixMilli()
	future = f.signed(t, future, f.key)
	unknown := f.event(nil)
	unknown.EventType = "new_unrecognized_action"
	unknown = f.signed(t, unknown, f.key)
	handler := auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).Push))
	push := func() PushResponse {
		t.Helper()
		body, _ := json.Marshal(pushRequest{VaultID: f.vaultID, DeviceID: f.deviceID, Events: []PushEvent{person, entry, future, unknown}})
		req := httptest.NewRequest("POST", "/v1/sync/push", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+f.token)
		req.Header.Set("X-Kaata-Currencies", "1")
		req.Header.Set("X-Kaata-Entry-Currency-Edit", "1")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("push status=%d body=%s", w.Code, w.Body.String())
		}
		var result PushResponse
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := push()
	if len(first.Accepted) != 2 || len(first.Rejected) != 2 {
		t.Fatalf("first push: %+v", first)
	}
	entries, customers, at := f.usage(t)
	if entries != 1 || customers != 1 || at == nil || time.Since(*at) > time.Minute {
		t.Fatalf("usage=%d/%d at=%v", entries, customers, at)
	}
	second := push()
	if len(second.Duplicates) != 2 || len(second.Accepted) != 0 || len(second.Rejected) != 2 {
		t.Fatalf("retry push: %+v", second)
	}
	gotEntries, gotCustomers, gotAt := f.usage(t)
	if gotEntries != entries || gotCustomers != customers || gotAt == nil || !gotAt.Equal(*at) {
		t.Fatalf("retry changed usage: %d/%d at=%v (was %v)", gotEntries, gotCustomers, gotAt, at)
	}
	var unchanged bool
	if err := f.pool.QueryRow(t.Context(), `SELECT installed_at IS NULL AND last_seen_at<NOW()-INTERVAL '1 day'
		AND check_in_count=1 AND usage_shares_sent=0
		AND (SELECT COUNT(*) FROM installs)=1
		AND (SELECT COUNT(*) FROM install_active_days)=0
		AND (SELECT COUNT(*) FROM install_active_hours)=0
		FROM installs WHERE install_id=$1::uuid`, f.deviceID).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("browser action changed native-install/presence metrics: intact=%v err=%v", unchanged, err)
	}
}

func TestWebPushUsageDoesNotAttributeNativeUnsignedRelayedOrRevokedActions(t *testing.T) {
	f := newWebUsageFixture(t)
	rel := seedCreditContact(t, f.m1Fixture)
	for _, scenario := range []string{"native", "unsigned", "wrong key", "tampered signature", "relayed author", "body transport", "revoked", "stale epoch", "different subject", "retired", "different account", "no session"} {
		t.Run(scenario, func(t *testing.T) {
			if _, err := f.pool.Exec(t.Context(), `UPDATE installs SET platform='web',account_deleted_at=NULL,account_id=$2::uuid WHERE install_id=$1::uuid`, f.deviceID, f.accountID); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(t.Context(), `UPDATE auth_credentials SET revoked_at=NULL,session_epoch=1 WHERE install_id=$1::uuid`, f.deviceID); err != nil {
				t.Fatal(err)
			}
			ev := creditEntry(f.m1Fixture, rel, "debt", "1")
			in := PushInput{AccountID: f.accountID, VaultID: f.vaultID, DeviceID: f.deviceID, Session: f.claims}
			var err error
			switch scenario {
			case "native":
				_, err = f.pool.Exec(t.Context(), `UPDATE installs SET platform='android' WHERE install_id=$1::uuid`, f.deviceID)
			case "relayed author":
				ev.HLC.DeviceID = uuid.NewString()
			case "body transport":
				in.DeviceID = uuid.NewString()
			case "revoked":
				_, err = f.pool.Exec(t.Context(), `UPDATE auth_credentials SET revoked_at=NOW() WHERE install_id=$1::uuid`, f.deviceID)
			case "stale epoch":
				_, err = f.pool.Exec(t.Context(), `UPDATE auth_credentials SET session_epoch=2 WHERE install_id=$1::uuid`, f.deviceID)
			case "different subject":
				claims := *f.claims
				claims.ProviderSub = "another-subject"
				in.Session = &claims
			case "retired":
				_, err = f.pool.Exec(t.Context(), `UPDATE installs SET account_deleted_at=NOW() WHERE install_id=$1::uuid`, f.deviceID)
			case "different account":
				_, err = f.pool.Exec(t.Context(), `UPDATE installs SET account_id=NULL WHERE install_id=$1::uuid`, f.deviceID)
			case "no session":
				in.Session = nil
			}
			if err != nil {
				t.Fatal(err)
			}
			if scenario != "unsigned" {
				key := f.key
				if scenario == "wrong key" {
					_, key, err = ed25519.GenerateKey(rand.Reader)
					if err != nil {
						t.Fatal(err)
					}
				}
				ev = f.signed(t, ev, key)
				if scenario == "tampered signature" {
					ev.HLC.Logical++
				}
			}
			in.Events = []PushEvent{ev}
			result, err := f.svc.PushEvents(t.Context(), in)
			if err != nil || len(result.Accepted) != 1 {
				t.Fatalf("fixture event failed: result=%+v err=%v", result, err)
			}
			entries, customers, at := f.usage(t)
			if entries != 0 || customers != 0 || at != nil {
				t.Fatalf("%s attributed to browser: %d/%d at=%v", scenario, entries, customers, at)
			}
		})
	}
}
