// REHEARSAL ONLY (designer pass, 2026-10-08). Phase B of the end-to-end
// loop: TestClientPushBodiesAccepted rebuilds the same post-import server
// (same reimport.sql, same K2 and the same rehearsal witness key, both read
// back from capture-final.json) and replays, byte for byte, the POST
// /v1/sync/push bodies the REAL 628eed5 client produced in the Node
// "capture" scenario (client-push-bodies.json): its witnessed K2
// vault_device_added for all three vaults and the owner tally it wrote after
// the restore. Skips when either file is missing.
//
//	POSTGRES_TEST_URL=... REHEARSAL_SQL_DIR=./scratch-reimport/out \
//	REHEARSAL_CAPTURE_DIR=<scratchpad>/go-rehearsal \
//	REHEARSAL_CLIENT_BODIES=<scratchpad>/client-628eed5-rehearsal-k2/client-push-bodies.json \
//	go test ./scratch-reimport/rehearsal/ -run TestClientPushBodiesAccepted -count=1 -v
package rehearsal_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/mesh"
	syncapi "github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/internal/testutil"
	"github.com/matee/kaata-backend/internal/vaults"
)

type clientPushBody struct {
	VaultID  string            `json:"vault_id"`
	DeviceID string            `json:"device_id"`
	Events   []json.RawMessage `json:"events"`
}

func TestClientPushBodiesAccepted(t *testing.T) {
	sqlDir := os.Getenv("REHEARSAL_SQL_DIR")
	if sqlDir == "" {
		sqlDir = filepath.Join("..", "out")
	}
	capDir := os.Getenv("REHEARSAL_CAPTURE_DIR")
	bodiesPath := os.Getenv("REHEARSAL_CLIENT_BODIES")
	if capDir == "" || bodiesPath == "" {
		t.Skip("REHEARSAL_CAPTURE_DIR / REHEARSAL_CLIENT_BODIES not set")
	}
	sqlBytes, err := os.ReadFile(filepath.Join(sqlDir, "reimport.sql"))
	if err != nil {
		t.Skipf("no reimport.sql: %v", err)
	}
	capBytes, err := os.ReadFile(filepath.Join(capDir, "capture-final.json"))
	if err != nil {
		t.Skipf("no capture-final.json: %v", err)
	}
	bodyBytes, err := os.ReadFile(bodiesPath)
	if err != nil {
		t.Skipf("no client bodies: %v", err)
	}
	var cap finalCapture
	if err := json.Unmarshal(capBytes, &cap); err != nil {
		t.Fatal(err)
	}
	var bodies []clientPushBody
	if err := json.Unmarshal(bodyBytes, &bodies); err != nil {
		t.Fatal(err)
	}
	if len(bodies) == 0 {
		t.Fatal("client-push-bodies.json holds no pushes")
	}
	serverSeed, err := base64.StdEncoding.DecodeString(cap.WitnessServerSeedB64)
	if err != nil || len(serverSeed) != ed25519.SeedSize {
		t.Fatalf("bad witness_server_seed_b64")
	}
	serverPriv := ed25519.NewKeyFromSeed(serverSeed)
	serverPub := serverPriv.Public().(ed25519.PublicKey)
	if base64.StdEncoding.EncodeToString(serverPub) != cap.WitnessServerPubB64 {
		t.Fatal("captured server seed does not reproduce the captured server pubkey")
	}
	k2Pub, err := base64.StdEncoding.DecodeString(cap.K2PubB64)
	if err != nil || len(k2Pub) != 32 {
		t.Fatal("bad k2_pub_b64")
	}
	k1Raw, _ := base64.StdEncoding.DecodeString(anchorK1B64)

	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	mustExecF(t, pool, `INSERT INTO accounts (id, google_sub, email, email_verified, name) VALUES ($1::uuid, 'sub-live', 'hlalahmdlyzayy42@gmail.com', TRUE, 'هلال احمد علیزائی')`, acctNew)
	mustExecF(t, pool, `INSERT INTO installs (install_id, app_version, platform, account_id, account_deleted_at, deletion_account_id) VALUES
		($1::uuid, '1.2.0', 'android', NULL, NOW() - interval '1 day', $4::uuid),
		($2::uuid, '1.2.0', 'android', $5::uuid, NULL, NULL),
		($3::uuid, '1.2.0', 'android', $5::uuid, NULL, NULL)`, installOld, installMid, installNew, acctDeleted, acctNew)
	mustExecF(t, pool, `INSERT INTO device_keys (install_id, ed25519_pubkey) VALUES ($1::uuid, $2), ($3::uuid, $4)`, installOld, k1Raw, installNew, k2Pub)
	mustExecF(t, pool, `INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, vault_trust_anchor_pubkey) VALUES ($1::uuid, $2::uuid, 'New kaata', 'AFN', 0, $3)`, vaultLocal, acctNew, k1Raw)
	mustExecF(t, pool, `INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, last_change_hlc_ms) VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid, $3)`, vaultLocal, acctNew, time.Now().UnixMilli())
	if _, err := pool.Exec(ctx, string(sqlBytes)); err != nil {
		t.Fatalf("reimport.sql failed: %v", err)
	}

	syncSvc := syncapi.NewService(pool)
	syncSvc.SetWitnessPubkeys([]ed25519.PublicKey{serverPub})
	meshSvc := mesh.NewService(pool, serverPriv, cap.WitnessServerPubB64, "")
	vaultsSvc := vaults.NewService(pool)
	vaultsSvc.SetMembershipInvalidator(syncSvc)
	syncH, meshH, vaultsH := syncapi.NewHandler(syncSvc), mesh.NewHandler(meshSvc), vaults.NewHandler(vaultsSvc)
	r := chi.NewRouter()
	r.Group(func(pr chi.Router) {
		pr.Use(auth.RequireSession(jwtSecret))
		pr.Get("/v1/vaults", vaultsH.List)
		pr.Post("/v1/devices/register-key", meshH.RegisterKey)
		pr.Post("/v1/sync/push", syncH.Push)
		pr.Get("/v1/sync/pull", syncH.Pull)
	})
	jwt, err := auth.SignSession(jwtSecret, acctNew, installNew, "google", "sub-live")
	if err != nil {
		t.Fatal(err)
	}
	post := func(raw []byte) (int, []byte) {
		req := httptest.NewRequest(http.MethodPost, "/v1/sync/push", bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+jwt)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code, rec.Body.Bytes()
	}

	accepted, byType := 0, map[string]int{}
	for i, b := range bodies {
		if b.DeviceID != installNew {
			t.Fatalf("body %d: device_id %s, want the phone %s", i, b.DeviceID, installNew)
		}
		raw, _ := json.Marshal(b)
		code, resp := post(raw)
		if code != 200 {
			t.Fatalf("client body %d (%s): %d %s", i, b.VaultID[:8], code, resp)
		}
		var res syncapi.PushResponse
		if err := json.Unmarshal(resp, &res); err != nil {
			t.Fatal(err)
		}
		if len(res.Rejected) != 0 || len(res.Accepted) != len(b.Events) {
			t.Fatalf("client body %d (%s) not fully accepted: %s", i, b.VaultID[:8], resp)
		}
		accepted += len(res.Accepted)
		for _, ev := range b.Events {
			var e struct {
				EventType string `json:"event_type"`
			}
			_ = json.Unmarshal(ev, &e)
			byType[e.EventType]++
		}
	}
	// Only the vaults the client actually pushed to (the Node harness flushes
	// the outbox of the two restored vaults; the local test vault's bind stays
	// queued for the scheduler) must show the K2 binding.
	pushedVaults := map[string]bool{}
	for _, b := range bodies {
		pushedVaults[b.VaultID] = true
	}
	for id := range pushedVaults {
		var bound string
		if err := pool.QueryRow(ctx, `SELECT account_id::text FROM vault_devices WHERE vault_id=$1::uuid AND device_id=$2::uuid AND removed_at_ms IS NULL`, id, installNew).Scan(&bound); err != nil || bound != acctNew {
			t.Fatalf("%s: the client's witnessed K2 bind did not fold into vault_devices: %v %q", id[:8], err, bound)
		}
	}
	var mainHigh int64
	if err := pool.QueryRow(ctx, `SELECT max(server_seq) FROM events WHERE vault_id=$1::uuid`, vaultMain).Scan(&mainHigh); err != nil {
		t.Fatal(err)
	}
	if mainHigh <= 2300 {
		t.Fatalf("main server_seq high %d, want > 2300 (the client's tally must have landed)", mainHigh)
	}
	var k2Rows int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM events WHERE device_id=$1::uuid AND signer_device_pubkey=$2 AND signed_actor_account_id=$3::uuid AND account_id=$3::uuid`, installNew, cap.K2PubB64, acctNew).Scan(&k2Rows); err != nil {
		t.Fatal(err)
	}
	if int(k2Rows) != accepted {
		t.Fatalf("%d K2-signed rows stored for the phone, want %d (actor/account/signer columns)", k2Rows, accepted)
	}
	t.Logf("replayed %d client push bodies: %d events accepted by type %v; K2 bound in %d vaults; main server_seq high %d", len(bodies), accepted, byType, len(pushedVaults), mainHigh)
}
