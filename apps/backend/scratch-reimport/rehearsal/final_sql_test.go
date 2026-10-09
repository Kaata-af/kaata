// REHEARSAL ONLY (designer pass, 2026-10-08). TestFinalSQLRehearsal executes
// the GENERATED production script scratch-reimport/out/reimport.sql VERBATIM
// (the file Matee would run with psql) on the throwaway test Postgres, then
// drives the real chi-routed handlers exactly as the phone (install
// b4950978, device key K2, account a98f0bc3) will, and writes every HTTP body
// to REHEARSAL_CAPTURE_DIR/capture-final.json so the 628eed5 client harness
// (scratchpad m628 .../reimport-rehearsal-628-k2.ts, scenario "capture") can
// replay the exact server answers through the real recoverAllVaults.
//
//	cd apps/backend && \
//	POSTGRES_TEST_URL=postgres://kaata@127.0.0.1:55436/kaata_test \
//	REHEARSAL_SQL_DIR=./scratch-reimport/out \
//	REHEARSAL_CAPTURE_DIR=<scratchpad>/go-rehearsal \
//	go test ./scratch-reimport/rehearsal/ -run TestFinalSQLRehearsal -count=1 -v
//
// Assertions (each a t.Fatalf):
//  1. the script runs as the non-superuser table owner in one transaction; a
//     second run is refused by its own preflight; the 050 trigger is back ON.
//  2. row counts, the preserved signed-actor evidence (1641 main / 75 second
//     rows carry the deleted account, 57 second rows carry NULL), account_id
//     NULL on every re-inserted row, one snapshot row per vault at the cursor.
//  3. GET /v1/vaults: 3 vaults, all owner / AFN / anchor K1.
//  4. GET /v1/sync/snapshot for BOTH vaults: 200 immediately (no cron
//     window), FK-closed (every entry's relationship and every relationship's
//     user present), the oracle-complete 151/151/1771 + 123 settlements for
//     main, 38/38/82 + 1 for the second, empty tail, no membership events, the
//     reconstructed oracle names.
//  5. GET /v1/sync/pull from 0 (both vaults): every signed row verifies on the
//     wire against K1 with the ORIGINAL actor; unsigned rows (carve-lost +
//     reconstruction) are served with a NULL actor; the tail after the
//     snapshot cursor is empty.
//  6. the production snapshot cron's first tick is a no-op (still one row).
//  7. register-key + witness + K2-signed vault_device_added accepted for BOTH
//     vaults (folded into vault_devices); K2 entry_created, person_renamed of
//     a reconstructed contact and a vault_setting_set rename accepted at MAX+n
//     with the name mirrored onto vaults.name; the post-snapshot tail is those.
//  8. rollback.sql removes every trace (identity rows and the local vault
//     untouched) and reimport.sql applies cleanly again.
package rehearsal_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/mesh"
	syncapi "github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/internal/testutil"
	"github.com/matee/kaata-backend/internal/vaults"
	"github.com/matee/kaata-backend/scratch-reimport/canonevent"
)

const (
	installMid = "6c7ac239-2cbd-4cd7-aa39-3360e3d1de82"
)

type finalCapture struct {
	K2SeedB64            string                       `json:"k2_seed_b64"`
	K2PubB64             string                       `json:"k2_pub_b64"`
	WitnessServerPubB64  string                       `json:"witness_server_pub_b64"`
	WitnessServerSeedB64 string                       `json:"witness_server_seed_b64"`
	Listing              json.RawMessage              `json:"listing"`
	Snapshots            map[string]json.RawMessage   `json:"snapshots"`
	PullPages            map[string][]json.RawMessage `json:"pull_pages"`
	Tails                map[string]json.RawMessage   `json:"tails"`
	Witness              map[string]json.RawMessage   `json:"witness"`
	PushResponses        []json.RawMessage            `json:"push_responses"`
	Census               map[string]any               `json:"census"`
}

func TestFinalSQLRehearsal(t *testing.T) {
	sqlDir := os.Getenv("REHEARSAL_SQL_DIR")
	if sqlDir == "" {
		sqlDir = filepath.Join("..", "out")
	}
	sqlBytes, err := os.ReadFile(filepath.Join(sqlDir, "reimport.sql"))
	if err != nil {
		t.Skipf("skipping: %v (generate with go run ./scratch-reimport/cmd/gen-reimport)", err)
	}
	rollbackBytes, err := os.ReadFile(filepath.Join(sqlDir, "rollback.sql"))
	if err != nil {
		t.Fatal(err)
	}
	sqlText, rollbackText := string(sqlBytes), string(rollbackBytes)
	if strings.Contains(sqlText, "MAIN_VAULT_NAME_REQUIRED") {
		t.Fatal("reimport.sql still carries the placeholder main-vault name")
	}

	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	cap := finalCapture{
		Snapshots: map[string]json.RawMessage{}, PullPages: map[string][]json.RawMessage{},
		Tails: map[string]json.RawMessage{}, Witness: map[string]json.RawMessage{}, Census: map[string]any{},
	}

	// ---- keys ----
	serverPub, serverPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	k2Seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(k2Seed); err != nil {
		t.Fatal(err)
	}
	k2Priv := ed25519.NewKeyFromSeed(k2Seed)
	k2Pub := k2Priv.Public().(ed25519.PublicKey)
	k2PubB64 := base64.StdEncoding.EncodeToString(k2Pub)
	cap.K2SeedB64 = base64.StdEncoding.EncodeToString(k2Seed)
	cap.K2PubB64 = k2PubB64
	cap.WitnessServerPubB64 = base64.StdEncoding.EncodeToString(serverPub)
	cap.WitnessServerSeedB64 = base64.StdEncoding.EncodeToString(serverPriv.Seed())
	k1Raw, _ := base64.StdEncoding.DecodeString(anchorK1B64)

	// ---- production-shaped residue: live account, three installs (the
	// original retired by the deletion), K1 for the old install, K2 for the
	// phone (registered 2026-10-07 13:24), the empty post-deletion vault.
	mustExecF(t, pool, `INSERT INTO accounts (id, google_sub, email, email_verified, name) VALUES ($1::uuid, 'sub-live', 'hlalahmdlyzayy42@gmail.com', TRUE, 'هلال احمد علیزائی')`, acctNew)
	mustExecF(t, pool, `INSERT INTO installs (install_id, app_version, platform, account_id, account_deleted_at, deletion_account_id) VALUES
		($1::uuid, '1.2.0', 'android', NULL, NOW() - interval '1 day', $4::uuid),
		($2::uuid, '1.2.0', 'android', $5::uuid, NULL, NULL),
		($3::uuid, '1.2.0', 'android', $5::uuid, NULL, NULL)`, installOld, installMid, installNew, acctDeleted, acctNew)
	mustExecF(t, pool, `INSERT INTO device_keys (install_id, ed25519_pubkey) VALUES ($1::uuid, $2), ($3::uuid, $4)`, installOld, k1Raw, installNew, []byte(k2Pub))
	mustExecF(t, pool, `INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, vault_trust_anchor_pubkey) VALUES ($1::uuid, $2::uuid, 'New kaata', 'AFN', 0, $3)`, vaultLocal, acctNew, k1Raw)
	mustExecF(t, pool, `INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, last_change_hlc_ms) VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid, $3)`, vaultLocal, acctNew, time.Now().UnixMilli())

	// ---- 1. THE SCRIPT, verbatim, as the table owner ----
	if _, err := pool.Exec(ctx, sqlText); err != nil {
		t.Fatalf("reimport.sql failed: %v", err)
	}
	if _, err := pool.Exec(ctx, sqlText); err == nil || !strings.Contains(err.Error(), "preflight") {
		t.Fatalf("second run must be refused by the preflight, got %v", err)
	}
	var trig string
	if err := pool.QueryRow(ctx, `SELECT tgenabled::text FROM pg_trigger WHERE tgname='signed_event_actor_evidence'`).Scan(&trig); err != nil {
		t.Fatal(err)
	}
	if trig != "O" {
		t.Fatalf("trigger state %q after import, want O", trig)
	}

	// ---- 2. row-level post-conditions (independent of the script's own DO block) ----
	count := func(sql string, args ...any) int64 {
		t.Helper()
		var n int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return n
	}
	// 2158 = 1651 carved + 507 reconstruction (incl. 1 no-op margin);
	// 225 = 133 carved + 92 reconstruction.
	wantMainRows, wantSecondRows := int64(2158), int64(225)
	if n := count(`SELECT count(*) FROM events WHERE vault_id=$1::uuid`, vaultMain); n != wantMainRows {
		t.Fatalf("main events %d, want %d", n, wantMainRows)
	}
	if n := count(`SELECT count(*) FROM events WHERE vault_id=$1::uuid`, vaultSecond); n != wantSecondRows {
		t.Fatalf("second events %d, want %d", n, wantSecondRows)
	}
	if n := count(`SELECT count(*) FROM events WHERE vault_id=$1::uuid AND signed_actor_account_id=$2::uuid`, vaultMain, acctDeleted); n != 1641 {
		t.Fatalf("main rows with the deleted signed actor %d, want 1641", n)
	}
	if n := count(`SELECT count(*) FROM events WHERE vault_id=$1::uuid AND signed_actor_account_id=$2::uuid`, vaultSecond, acctDeleted); n != 75 {
		t.Fatalf("second rows with the deleted signed actor %d, want 75", n)
	}
	if n := count(`SELECT count(*) FROM events WHERE vault_id=$1::uuid AND NULLIF(event_sig_b64,'') IS NOT NULL AND signed_actor_account_id IS NULL`, vaultSecond); n != 57 {
		t.Fatalf("second signed rows with NULL actor %d, want 57", n)
	}
	if n := count(`SELECT count(*) FROM events WHERE vault_id IN ($1::uuid,$2::uuid) AND account_id IS NOT NULL`, vaultMain, vaultSecond); n != 0 {
		t.Fatalf("%d re-inserted rows carry a live account_id, want 0", n)
	}
	if n := count(`SELECT count(*) FROM events WHERE vault_id IN ($1::uuid,$2::uuid) AND NULLIF(event_sig_b64,'') IS NOT NULL AND NULLIF(signer_device_pubkey,'') IS NULL`, vaultMain, vaultSecond); n != 0 {
		t.Fatalf("%d signed rows without a signer pubkey, want 0 (repair missed)", n)
	}
	if n := count(`SELECT count(*) FROM events WHERE vault_id IN ($1::uuid,$2::uuid) AND event_sig_b64 IS NULL`, vaultMain, vaultSecond); n != 610 {
		t.Fatalf("unsigned rows %d, want 610 (11 carve-lost + 599 reconstruction incl. 2 margin)", n)
	}
	if n := count(`SELECT count(*) FROM vault_snapshots WHERE vault_id=$1::uuid AND up_to_server_seq=2300`, vaultMain); n != 1 {
		t.Fatalf("main snapshot rows at 2300: %d", n)
	}
	if n := count(`SELECT count(*) FROM vault_snapshots WHERE vault_id=$1::uuid AND up_to_server_seq=260`, vaultSecond); n != 1 {
		t.Fatalf("second snapshot rows at 260: %d", n)
	}
	if n := count(`SELECT count(*) FROM vault_devices WHERE vault_id IN ($1::uuid,$2::uuid)`, vaultMain, vaultSecond); n != 0 {
		t.Fatalf("vault_devices pre-inserted (%d rows); the phone's witnessed bind must create them", n)
	}
	t.Logf("import: main %d rows, second %d rows, evidence preserved, account_id NULL everywhere, one snapshot row per vault", wantMainRows, wantSecondRows)

	// ---- services + router, wired like cmd/server/main.go ----
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
		pr.Post("/v1/vaults/{vault_id}/witness", meshH.Witness)
		pr.Post("/v1/sync/push", syncH.Push)
		pr.Get("/v1/sync/pull", syncH.Pull)
		pr.Get("/v1/sync/snapshot", syncH.Snapshot)
	})
	jwt, err := auth.SignSession(jwtSecret, acctNew, installNew, "google", "sub-live")
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, target string, body any) (int, []byte) {
		var rd *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		} else {
			rd = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, target, rd)
		req.Header.Set("Authorization", "Bearer "+jwt)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code, rec.Body.Bytes()
	}

	// ---- 3. GET /v1/vaults ----
	code, body := call(http.MethodGet, "/v1/vaults", nil)
	if code != 200 {
		t.Fatalf("list: %d %s", code, body)
	}
	cap.Listing = json.RawMessage(body)
	var listing struct {
		Vaults []vaults.VaultListing `json:"vaults"`
	}
	if err := json.Unmarshal(body, &listing); err != nil {
		t.Fatal(err)
	}
	seen := map[string]vaults.VaultListing{}
	for _, v := range listing.Vaults {
		seen[v.VaultID] = v
	}
	if len(seen) != 3 {
		t.Fatalf("listing has %d vaults, want 3", len(seen))
	}
	for _, id := range []string{vaultMain, vaultSecond, vaultLocal} {
		v, ok := seen[id]
		if !ok || v.Role != "owner" || v.Currency != "AFN" || v.ArchivedAtMS != nil || v.VaultTrustAnchorPubkey == nil || *v.VaultTrustAnchorPubkey != anchorK1B64 {
			t.Fatalf("listing for %s wrong: %+v", id[:8], v)
		}
	}
	t.Logf("GET /v1/vaults: main=%q second=%q local=%q, all owner/AFN/live/anchor K1", seen[vaultMain].Name, seen[vaultSecond].Name, seen[vaultLocal].Name)

	// ---- 4. snapshots: 200 immediately, FK-closed ----
	snapshots := map[string]syncapi.SnapshotResponse{}
	for _, id := range []string{vaultMain, vaultSecond} {
		code, body = call(http.MethodGet, "/v1/sync/snapshot?vault_id="+id, nil)
		if code != 200 {
			t.Fatalf("snapshot %s: %d %s", id[:8], code, body)
		}
		cap.Snapshots[id] = json.RawMessage(body)
		var snap syncapi.SnapshotResponse
		if err := json.Unmarshal(body, &snap); err != nil {
			t.Fatal(err)
		}
		snapshots[id] = snap
		users := map[string]bool{}
		for _, u := range snap.Users {
			users[u.ID] = true
		}
		rels := map[string]bool{}
		for _, rl := range snap.Relationships {
			rels[rl.ID] = true
			if !users[rl.UserBID] {
				t.Fatalf("%s: relationship %s references user %s missing from the snapshot (phone FK)", id[:8], rl.ID, rl.UserBID)
			}
		}
		for _, e := range snap.Entries {
			if !rels[e.RelationshipID] {
				t.Fatalf("%s: entry %s references relationship %s missing from the snapshot (phone FK would abort the restore)", id[:8], e.ID, e.RelationshipID)
			}
		}
		if len(snap.Events) != 0 || len(snap.MembershipEvents) != 0 {
			t.Fatalf("%s: tail=%d membership=%d, want 0/0", id[:8], len(snap.Events), len(snap.MembershipEvents))
		}
		if snap.Vault.VaultTrustAnchorPubkey == nil || *snap.Vault.VaultTrustAnchorPubkey != anchorK1B64 || snap.Vault.AccountID == nil || *snap.Vault.AccountID != acctNew {
			t.Fatalf("%s: snapshot vault header %+v", id[:8], snap.Vault)
		}
	}
	main := snapshots[vaultMain]
	if main.SnapshotServerSeq != 2300 || len(main.Users) != 151 || len(main.Relationships) != 151 || len(main.Entries) != 1771 || len(main.SettlementEvents) != 123 {
		t.Fatalf("main snapshot: cursor=%d users=%d rels=%d entries=%d settlements=%d, want 2300/151/151/1771/123", main.SnapshotServerSeq, len(main.Users), len(main.Relationships), len(main.Entries), len(main.SettlementEvents))
	}
	// The main vault's shop name + vault name were reconstructed (nothing
	// survived in the carve); they now carry the oracle value.
	if main.ShopProfile == nil || main.ShopProfile.ShopName != mainOracleShopName {
		t.Fatalf("main shop_profile %+v, want shop_name %q", main.ShopProfile, mainOracleShopName)
	}
	if main.Vault.Name != mainOracleShopName {
		t.Fatalf("main vault name %q, want %q", main.Vault.Name, mainOracleShopName)
	}
	// Pick a non-archived contact to rename and to attach a tally to (there are
	// no synthetic placeholders anymore — every person is a real reconstructed
	// or surviving contact).
	var renameUser string
	for _, u := range main.Users {
		if u.DisplayName != "" {
			if renameUser == "" || u.ID < renameUser {
				renameUser = u.ID
			}
		}
	}
	deleted := 0
	for _, e := range main.Entries {
		if e.IsDeleted == 1 {
			deleted++
		}
	}
	second := snapshots[vaultSecond]
	if second.SnapshotServerSeq != 260 || len(second.Users) != 38 || len(second.Relationships) != 38 || len(second.Entries) != 82 || len(second.SettlementEvents) != 1 {
		t.Fatalf("second snapshot: cursor=%d users=%d rels=%d entries=%d settlements=%d, want 260/38/38/82/1", second.SnapshotServerSeq, len(second.Users), len(second.Relationships), len(second.Entries), len(second.SettlementEvents))
	}
	// The second vault was RENAMED (rename lost in the carve); reconstruction
	// restores the oracle's current name, not the stale carried one.
	if second.ShopProfile == nil || second.ShopProfile.ShopName != secondOracleShopName {
		t.Fatalf("second shop_profile %+v, want shop_name %q", second.ShopProfile, secondOracleShopName)
	}
	cap.Census["main_snapshot"] = map[string]int{"users": len(main.Users), "relationships": len(main.Relationships), "entries": len(main.Entries), "deleted": deleted, "settlement_events": len(main.SettlementEvents)}
	cap.Census["second_snapshot"] = map[string]int{"users": len(second.Users), "relationships": len(second.Relationships), "entries": len(second.Entries), "settlement_events": len(second.SettlementEvents)}
	t.Logf("snapshots: main users=%d rels=%d entries=%d (deleted %d) settlements=%d name=%q; second users=%d rels=%d entries=%d settlements=%d shop=%q",
		len(main.Users), len(main.Relationships), len(main.Entries), deleted, len(main.SettlementEvents), main.Vault.Name,
		len(second.Users), len(second.Relationships), len(second.Entries), len(second.SettlementEvents), second.ShopProfile.ShopName)

	// ---- 5. pull-from-0 (the path a snapshot-less device would take) and the post-cursor tail ----
	for _, id := range []string{vaultMain, vaultSecond} {
		var pulled []syncapi.PulledEvent
		after := int64(0)
		for pages := 0; pages < 50; pages++ {
			code, body = call(http.MethodGet, fmt.Sprintf("/v1/sync/pull?vault_id=%s&after_server_seq=%d&limit=200", id, after), nil)
			if code != 200 {
				t.Fatalf("pull %s: %d %s", id[:8], code, body)
			}
			cap.PullPages[id] = append(cap.PullPages[id], json.RawMessage(body))
			var page syncapi.PullResult
			if err := json.Unmarshal(body, &page); err != nil {
				t.Fatal(err)
			}
			pulled = append(pulled, page.Events...)
			if page.NextAfterServerSeq > after {
				after = page.NextAfterServerSeq
			}
			if !page.HasMore {
				break
			}
		}
		var valid, invalid, unsigned, actorDead, actorNull int
		for _, ev := range pulled {
			sig := deref(ev.EventSigB64)
			if sig == "" {
				unsigned++
				if ev.AccountID != nil {
					t.Fatalf("%s: unsigned event %s served with actor %s, want NULL", id[:8], ev.EventID, *ev.AccountID)
				}
				continue
			}
			pub := deref(ev.SignerDevicePubkey)
			if pub != anchorK1B64 {
				t.Fatalf("%s: signed event %s served with signer %q", id[:8], ev.EventID, pub)
			}
			switch {
			case ev.AccountID == nil:
				actorNull++
			case *ev.AccountID == acctDeleted:
				actorDead++
			default:
				t.Fatalf("%s: signed event %s served with actor %s", id[:8], ev.EventID, *ev.AccountID)
			}
			ok, err := canonevent.Verify(canonevent.Envelope{
				VaultID: id, EventID: ev.EventID, EventType: ev.EventType, SchemaVersion: ev.SchemaVersion,
				HLCPhysicalMS: ev.HLC.PMS, HLCLogical: ev.HLC.L, HLCDeviceID: ev.HLC.DID,
				ActorAccountID: ev.AccountID, TargetID: ev.TargetID, RelationshipID: ev.RelationshipID, Payload: ev.Payload,
			}, sig, pub)
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				valid++
			} else {
				invalid++
			}
		}
		// [valid, invalid, unsigned, actorDead, actorNull]. Main: 1641 signed
		// (all deleted actor) + 517 unsigned (10 carve-lost + 507 reconstruction).
		// Second: 132 signed (75 deleted + 57 null) + 93 unsigned (1 + 92).
		want := map[string][5]int{vaultMain: {1641, 0, 517, 1641, 0}, vaultSecond: {132, 0, 93, 75, 57}}[id]
		if [5]int{valid, invalid, unsigned, actorDead, actorNull} != want {
			t.Fatalf("%s pull census valid=%d invalid=%d unsigned=%d dead=%d null=%d, want %v", id[:8], valid, invalid, unsigned, actorDead, actorNull, want)
		}
		if int64(len(pulled)) != map[string]int64{vaultMain: wantMainRows, vaultSecond: wantSecondRows}[id] || after != snapshots[id].SnapshotServerSeq {
			t.Fatalf("%s pull drained %d rows to %d", id[:8], len(pulled), after)
		}
		cap.Census[id[:8]+"_pull"] = map[string]int{"rows": len(pulled), "valid": valid, "invalid": invalid, "unsigned": unsigned, "actor_deleted": actorDead, "actor_null": actorNull}
		// what THIS phone pulls after restoreFromSnapshot set its cursor:
		code, body = call(http.MethodGet, fmt.Sprintf("/v1/sync/pull?vault_id=%s&after_server_seq=%d&limit=200", id, snapshots[id].SnapshotServerSeq), nil)
		if code != 200 {
			t.Fatalf("tail %s: %d %s", id[:8], code, body)
		}
		cap.Tails[id] = json.RawMessage(body)
		var tail syncapi.PullResult
		if err := json.Unmarshal(body, &tail); err != nil {
			t.Fatal(err)
		}
		if len(tail.Events) != 0 || tail.HasMore {
			t.Fatalf("%s: tail after the snapshot cursor has %d events", id[:8], len(tail.Events))
		}
		t.Logf("pull %s: %d rows, valid=%d invalid=%d unsigned=%d actor(deleted)=%d actor(null)=%d; tail after cursor empty", id[:8], len(pulled), valid, invalid, unsigned, actorDead, actorNull)
	}

	// ---- 6. the production cron's first tick is a no-op ----
	cronCtx, cancel := context.WithCancel(ctx)
	go syncapi.StartSnapshotCron(cronCtx, pool, time.Hour, 2)
	time.Sleep(2500 * time.Millisecond)
	cancel()
	for _, id := range []string{vaultMain, vaultSecond} {
		if n := count(`SELECT count(*) FROM vault_snapshots WHERE vault_id=$1::uuid`, id); n != 1 {
			t.Fatalf("%s: %d snapshot rows after the cron tick, want 1", id[:8], n)
		}
	}
	t.Log("snapshot cron tick: no-op for both vaults")

	// ---- 7. the phone binds K2 into both vaults and writes ----
	code, body = call(http.MethodPost, "/v1/devices/register-key", map[string]any{"ed25519_pubkey": k2PubB64})
	if code != 200 {
		t.Fatalf("register-key: %d %s", code, body)
	}
	now := time.Now().UnixMilli()
	sign := func(vaultID string, ev *syncapi.PushEvent) {
		msg, err := canonevent.Canonical(canonevent.Envelope{
			VaultID: vaultID, EventID: ev.EventID, EventType: ev.EventType, SchemaVersion: ev.SchemaVersion,
			HLCPhysicalMS: ev.HLC.PhysicalMS, HLCLogical: ev.HLC.Logical, HLCDeviceID: ev.HLC.DeviceID,
			ActorAccountID: ev.ActorAccountID, TargetID: ev.TargetID, RelationshipID: ev.RelationshipID, Payload: ev.Payload,
		})
		if err != nil {
			t.Fatal(err)
		}
		sig := base64.StdEncoding.EncodeToString(ed25519.Sign(k2Priv, msg))
		pub := k2PubB64
		ev.EventSigB64, ev.SignerDevicePubkeyB64 = &sig, &pub
	}
	push := func(vaultID string, evs ...syncapi.PushEvent) syncapi.PushResponse {
		code, body := call(http.MethodPost, "/v1/sync/push", map[string]any{"vault_id": vaultID, "device_id": installNew, "events": evs})
		if code != 200 {
			t.Fatalf("push %s: %d %s", vaultID[:8], code, body)
		}
		cap.PushResponses = append(cap.PushResponses, json.RawMessage(body))
		var res syncapi.PushResponse
		if err := json.Unmarshal(body, &res); err != nil {
			t.Fatal(err)
		}
		if len(res.Rejected) != 0 || len(res.Accepted) != len(evs) {
			t.Fatalf("push %s: %s", vaultID[:8], body)
		}
		return res
	}
	actor := acctNew
	authorSeq := int64(0)
	nextSeq := func() *int64 { authorSeq++; s := authorSeq; return &s }
	for _, id := range []string{vaultMain, vaultSecond} {
		code, body = call(http.MethodPost, "/v1/vaults/"+id+"/witness", nil)
		if code != 200 {
			t.Fatalf("witness %s: %d %s", id[:8], code, body)
		}
		cap.Witness[id] = json.RawMessage(body)
		var wr mesh.WitnessResult
		if err := json.Unmarshal(body, &wr); err != nil {
			t.Fatal(err)
		}
		if wr.MemberWitness != nil {
			t.Fatalf("%s: an owner must not get a member witness", id[:8])
		}
		devAdd := syncapi.PushEvent{
			EventID: uuid.NewString(), EventType: "vault_device_added", SchemaVersion: 1,
			HLC:            syncapi.PushHLC{PhysicalMS: now, Logical: 0, DeviceID: installNew},
			ActorAccountID: &actor, TargetID: strPtr(installNew), AuthorSeq: nextSeq(),
		}
		devAdd.Payload, _ = json.Marshal(map[string]any{
			"account_id": acctNew, "device_id": installNew, "device_pubkey": k2PubB64,
			"witness": map[string]any{"sig_b64": wr.DeviceWitness.SigB64, "server_key_id": wr.ServerKeyID, "issued_at_ms": wr.DeviceWitness.IssuedAtMS},
		})
		sign(id, &devAdd)
		push(id, devAdd)
		var boundAcct string
		if err := pool.QueryRow(ctx, `SELECT account_id::text FROM vault_devices WHERE vault_id=$1::uuid AND device_id=$2::uuid AND removed_at_ms IS NULL`, id, installNew).Scan(&boundAcct); err != nil || boundAcct != acctNew {
			t.Fatalf("%s: vault_devices not folded for K2: %v %q", id[:8], err, boundAcct)
		}
		now++
	}
	code, body = call(http.MethodPost, "/v1/vaults/"+vaultLocal+"/witness", nil)
	if code != 200 {
		t.Fatalf("witness local: %d %s", code, body)
	}
	cap.Witness[vaultLocal] = json.RawMessage(body)
	// a tally against a restored (non-placeholder) contact, a rename of a
	// placeholder, and a kaata rename — all K2-signed from the new install.
	var relID string
	for _, rl := range main.Relationships {
		if rl.UserBID != renameUser && rl.ArchivedAt == nil {
			relID = rl.ID
			break
		}
	}
	entryID := uuid.NewString()
	created := syncapi.PushEvent{
		EventID: uuid.NewString(), EventType: "entry_created", SchemaVersion: 1,
		HLC:            syncapi.PushHLC{PhysicalMS: now + 1, Logical: 0, DeviceID: installNew},
		ActorAccountID: &actor, TargetID: &entryID, RelationshipID: &relID, AuthorSeq: nextSeq(),
	}
	created.Payload, _ = json.Marshal(map[string]any{"entry_id": entryID, "relationship_id": relID, "type": "debt", "amount_afn": 250, "note": "rehearsal tally", "occurred_at_ms": now + 1})
	sign(vaultMain, &created)
	renamed := syncapi.PushEvent{
		EventID: uuid.NewString(), EventType: "person_renamed", SchemaVersion: 1,
		HLC:            syncapi.PushHLC{PhysicalMS: now + 2, Logical: 0, DeviceID: installNew},
		ActorAccountID: &actor, TargetID: &renameUser, AuthorSeq: nextSeq(),
	}
	renamed.Payload, _ = json.Marshal(map[string]any{"name": "حاجی صاحب (نام اصلاح شده)"})
	sign(vaultMain, &renamed)
	vaultRename := syncapi.PushEvent{
		EventID: uuid.NewString(), EventType: "vault_setting_set", SchemaVersion: 1,
		HLC:            syncapi.PushHLC{PhysicalMS: now + 3, Logical: 0, DeviceID: installNew},
		ActorAccountID: &actor, TargetID: strPtr(vaultMain), AuthorSeq: nextSeq(),
	}
	vaultRename.Payload, _ = json.Marshal(map[string]any{"key": "name", "value": "REHEARSAL renamed kaata"})
	sign(vaultMain, &vaultRename)
	res := push(vaultMain, created, renamed, vaultRename)
	if res.VaultServerSeqHigh != 2300+4 {
		t.Fatalf("server_seq high %d, want %d", res.VaultServerSeqHigh, 2300+4)
	}
	var name string
	if err := pool.QueryRow(ctx, `SELECT name FROM vaults WHERE vault_id=$1::uuid`, vaultMain).Scan(&name); err != nil || name != "REHEARSAL renamed kaata" {
		t.Fatalf("rename mirror: vaults.name=%q err=%v", name, err)
	}
	code, body = call(http.MethodGet, "/v1/sync/snapshot?vault_id="+vaultMain, nil)
	if code != 200 {
		t.Fatalf("snapshot after writes: %d", code)
	}
	var after syncapi.SnapshotResponse
	if err := json.Unmarshal(body, &after); err != nil {
		t.Fatal(err)
	}
	if len(after.Events) != 4 || len(after.MembershipEvents) != 1 {
		t.Fatalf("post-write snapshot tail=%d membership=%d, want 4/1", len(after.Events), len(after.MembershipEvents))
	}
	for _, ev := range after.Events {
		if ev.AccountID == nil || *ev.AccountID != acctNew || deref(ev.SignerDevicePubkey) != k2PubB64 {
			t.Fatalf("tail event %s served with actor %v signer %q", ev.EventType, ev.AccountID, deref(ev.SignerDevicePubkey))
		}
	}
	t.Logf("K2 writes: device bound in both vaults; entry_created/person_renamed/vault_setting_set at server_seq 2302..2304; vaults.name mirrored; tail = the 4 new rows, membership chain = the 1 witnessed bind")
	cap.Census["k2_writes"] = map[string]any{"server_seq_high": res.VaultServerSeqHigh, "vault_name_after_rename": name}

	// ---- 8. rollback removes every trace; re-import applies again ----
	if _, err := pool.Exec(ctx, rollbackText); err != nil {
		t.Fatalf("rollback.sql: %v", err)
	}
	for _, tbl := range []string{"vault_snapshots", "events", "vault_devices", "vault_audit_log", "vault_members", "vaults"} {
		if n := count(`SELECT count(*) FROM `+tbl+` WHERE vault_id IN ($1::uuid,$2::uuid)`, vaultMain, vaultSecond); n != 0 {
			t.Fatalf("%s still has %d rows after rollback", tbl, n)
		}
	}
	if a, i, k, lv := count(`SELECT count(*) FROM accounts`), count(`SELECT count(*) FROM installs`), count(`SELECT count(*) FROM device_keys`), count(`SELECT count(*) FROM vaults WHERE vault_id=$1::uuid`, vaultLocal); a != 1 || i != 3 || k != 2 || lv != 1 {
		t.Fatalf("rollback touched identity/local rows: accounts=%d installs=%d keys=%d local=%d", a, i, k, lv)
	}
	if _, err := pool.Exec(ctx, sqlText); err != nil {
		t.Fatalf("re-import after rollback: %v", err)
	}
	if n := count(`SELECT count(*) FROM events WHERE vault_id=$1::uuid`, vaultMain); n != wantMainRows {
		t.Fatalf("after re-import main events %d", n)
	}
	t.Log("rollback.sql: clean; reimport.sql re-applied")

	// ---- capture for the Node harness ----
	if dir := os.Getenv("REHEARSAL_CAPTURE_DIR"); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		out, _ := json.MarshalIndent(cap, "", " ")
		p := filepath.Join(dir, "capture-final.json")
		if err := os.WriteFile(p, out, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("capture written: %s (%d bytes)", p, len(out))
	}
}

func mustExecF(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql[:40], err)
	}
}
