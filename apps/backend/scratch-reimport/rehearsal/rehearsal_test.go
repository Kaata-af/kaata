// REHEARSAL ONLY. Runs against the throwaway test Postgres named by
// POSTGRES_TEST_URL (testutil.ConnectTestDB DROPs the public schema there and
// replays the migration chain), never the dev or production database.
//
//	cd apps/backend && \
//	POSTGRES_TEST_URL=postgres://kaata:kaata@127.0.0.1:55432/kaata_test \
//	RECOVERED_JSONL=<scratchpad>/events_recovered.jsonl \
//	REHEARSAL_CAPTURE_DIR=<scratchpad>/go-rehearsal \
//	go test ./scratch-reimport/rehearsal/ -run TestReimportRehearsal -count=1 -v
//
// What it proves, in the order the phone (1.2.0 b40 = 628eed5, install
// b4950978, device key K2, account a98f0bc3) would exercise the server after
// a server-side re-import of the carved rows:
//
//  1. the import itself: vaults/vault_members rows plus the ORIGINAL events
//     rows (server_seq, author_seq, payload, Ed25519 material, signed actor)
//     in one transaction, with migration 050's insert trigger disabled by the
//     table owner for the duration so signed_actor_account_id survives
//     verbatim. With the trigger enabled a re-inserted signed row is stamped
//     from account_id, which has to be NULL because its FK target is the
//     deleted account, and the phone then fails every signature check.
//  2. GET /v1/vaults lists the vaults for the NEW account as owner, carrying
//     the ORIGINAL trust anchor K1 (recovery.ts seedVaultFromListing pins it).
//  3. GET /v1/sync/snapshot is 404 right after the import, so a sign-in in
//     that window takes the pull-from-0 path; every pulled signed row still
//     verifies against K1 (the round trip the phone's role gate performs).
//  4. The backend's own snapshot cron (boot tick plus every 5 min in
//     cmd/server/main.go) builds a vault_snapshots row for the re-imported
//     vault unprompted, after which the SAME sign-in takes the snapshot path:
//     "approach A" becomes "approach B" by itself within minutes.
//  5. The snapshot built from the carved rows carries entries whose
//     relationship has no surviving person_added (the orphan tallies), which
//     restoreFromSnapshot cannot INSERT under the SQLite FK. The client-side
//     harness has to show what that does to the vault.
//  6. The new phone's witnessed vault_device_added (signed by K2, witness
//     from POST /v1/vaults/{id}/witness) is accepted and folded into
//     vault_devices, and K2-signed entry_created / entry_amended pushes land
//     at server_seq MAX+n: the vault is writable and syncing afterwards.
//  7. Re-running the import is a no-op (idempotent by event_id).
//
// Every HTTP body the phone would see is written to REHEARSAL_CAPTURE_DIR so
// the Node harness (scratchpad m628 reimport-rehearsal-628.ts, or a copy fed
// by this capture) can replay the exact server answers instead of a fake.
package rehearsal_test

import (
	"bufio"
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
	"sort"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/mesh"
	syncapi "github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/internal/testutil"
	"github.com/matee/kaata-backend/internal/vaults"
	"github.com/matee/kaata-backend/scratch-reimport/canonevent"
)

const (
	acctNew     = "a98f0bc3-796e-4625-99ad-e8f7b1565ac1"
	acctDeleted = "498717f1-6686-4961-9f1e-7ff852e6f275"
	installNew  = "b4950978-cf4a-461f-b059-ba2b66bd86a8"
	installOld  = "907448d9-3844-4a15-8b7b-d5c77870f224"
	vaultMain   = "eb7cd98d-32f0-4c6c-a456-7ad3e4ca8b6d"
	vaultSecond = "98e2d78f-96f4-4188-919d-0d7d5501258c"
	vaultLocal  = "2516595d-20c3-4677-ab16-e07e564c0573"
	anchorK1B64 = "pMauYtxNGJ4JxjOZMZFz8x5r8NZX7GxOfPWOSvRBqeg="
	jwtSecret   = "0123456789abcdef0123456789abcdef"

	// Oracle-derived names (reconstruction restores these exact values).
	mainOracleShopName   = "لیست نسیه سیب غزنی  سال 1405"
	secondOracleShopName = "لیست نسیه بار ها فراه سال در 1405"
)

// row is one carved events row (keys = Postgres column names).
type row struct {
	EventID            string          `json:"event_id"`
	VaultID            string          `json:"vault_id"`
	HLCPhysicalMS      int64           `json:"hlc_physical_ms"`
	HLCLogical         int64           `json:"hlc_logical"`
	HLCDeviceID        string          `json:"hlc_device_id"`
	DeviceID           string          `json:"device_id"`
	AccountID          *string         `json:"account_id"`
	TargetID           *string         `json:"target_id"`
	RelationshipID     *string         `json:"relationship_id"`
	EventType          string          `json:"event_type"`
	SchemaVersion      int             `json:"schema_version"`
	Payload            json.RawMessage `json:"payload"`
	ServerReceivedAt   string          `json:"server_received_at"`
	ServerSeq          int64           `json:"server_seq"`
	RedactedAt         *string         `json:"redacted_at"`
	RedactedReason     *string         `json:"redacted_reason"`
	AuthorSeq          *int64          `json:"author_seq"`
	EventSigB64        *string         `json:"event_sig_b64"`
	SignerDevicePubkey *string         `json:"signer_device_pubkey"`
	LocalTargetID      *string         `json:"local_target_id"`
	SignedActorAccount *string         `json:"signed_actor_account_id"`
}

func loadRows(t *testing.T, path string) map[string][]row {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("skipping: RECOVERED_JSONL not readable (%v)", err)
	}
	defer f.Close()
	byID := map[string]row{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var r row
		if err := json.Unmarshal(line, &r); err != nil {
			t.Fatalf("bad jsonl line: %v", err)
		}
		prev, ok := byID[r.EventID]
		// Heap versions of one tuple: keep the pre-deletion image (account_id set).
		if !ok || (prev.AccountID == nil && r.AccountID != nil) {
			byID[r.EventID] = r
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	out := map[string][]row{}
	for _, r := range byID {
		out[r.VaultID] = append(out[r.VaultID], r)
	}
	for _, list := range out {
		sort.Slice(list, func(i, j int) bool { return list[i].ServerSeq < list[j].ServerSeq })
	}
	return out
}

// importVault is THE production import statement sequence for one vault, in
// one transaction. Returns the number of events rows actually inserted.
func importVault(ctx context.Context, pool *pgxpool.Pool, vaultID, name, currency string, rows []row) (int64, error) {
	if len(rows) == 0 {
		return 0, fmt.Errorf("no rows for %s", vaultID)
	}
	if name == "" {
		name = "Restored kaata " + vaultID[:8]
	}
	anchor, err := base64.StdEncoding.DecodeString(anchorK1B64)
	if err != nil {
		return 0, err
	}
	minPMS := rows[0].HLCPhysicalMS
	for _, r := range rows {
		if r.HLCPhysicalMS < minPMS {
			minPMS = r.HLCPhysicalMS
		}
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. vault row: owner = the NEW account, anchor = the ORIGINAL device key K1.
	if _, err := tx.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, created_at, vault_trust_anchor_pubkey)
		VALUES ($1::uuid, $2::uuid, $3, $4, 0, to_timestamp($5::bigint / 1000.0), $6)
		ON CONFLICT (vault_id) DO NOTHING
	`, vaultID, acctNew, name, currency, minPMS, anchor); err != nil {
		return 0, fmt.Errorf("vaults: %w", err)
	}
	// 2. owner seat, exactly as vaults.Service.Create seeds it.
	if _, err := tx.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, last_change_hlc_ms)
		SELECT $1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid, $3
		WHERE NOT EXISTS (SELECT 1 FROM vault_members WHERE vault_id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL)
	`, vaultID, acctNew, time.Now().UnixMilli()); err != nil {
		return 0, fmt.Errorf("vault_members: %w", err)
	}
	// 3. the events rows, verbatim. Migration 050's BEFORE INSERT trigger
	// would overwrite signed_actor_account_id with account_id (NULL here: its
	// FK target is the deleted account), breaking every signature on pull;
	// the table owner disables it for this transaction only.
	if _, err := tx.Exec(ctx, `ALTER TABLE events DISABLE TRIGGER signed_event_actor_evidence`); err != nil {
		return 0, fmt.Errorf("disable trigger: %w", err)
	}
	var inserted int64
	for _, r := range rows {
		var actor any
		if r.AccountID != nil && *r.AccountID != acctDeleted {
			actor = *r.AccountID // a live account; never the deleted one (FK)
		}
		payload := r.Payload
		if len(payload) == 0 {
			payload = json.RawMessage("null")
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO events (
				event_id, vault_id, hlc_physical_ms, hlc_logical, hlc_device_id, device_id,
				account_id, target_id, relationship_id, event_type, schema_version, payload,
				server_received_at, server_seq, redacted_at, redacted_reason, author_seq,
				event_sig_b64, signer_device_pubkey, local_target_id, signed_actor_account_id
			) VALUES (
				$1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid,
				$7::uuid, $8::uuid, $9::uuid, $10, $11, $12::jsonb,
				$13::timestamptz, $14, $15::timestamptz, $16, $17,
				$18, $19, $20, $21::uuid
			)
			ON CONFLICT (event_id) DO NOTHING
		`, r.EventID, r.VaultID, r.HLCPhysicalMS, r.HLCLogical, r.HLCDeviceID, r.DeviceID,
			actor, r.TargetID, r.RelationshipID, r.EventType, r.SchemaVersion, string(payload),
			r.ServerReceivedAt, r.ServerSeq, r.RedactedAt, r.RedactedReason, r.AuthorSeq,
			r.EventSigB64, r.SignerDevicePubkey, r.LocalTargetID, r.SignedActorAccount)
		if err != nil {
			return 0, fmt.Errorf("events seq=%d: %w", r.ServerSeq, err)
		}
		inserted += tag.RowsAffected()
	}
	if _, err := tx.Exec(ctx, `ALTER TABLE events ENABLE TRIGGER signed_event_actor_evidence`); err != nil {
		return 0, fmt.Errorf("enable trigger: %w", err)
	}
	return inserted, tx.Commit(ctx)
}

type capture struct {
	K2SeedB64           string            `json:"k2_seed_b64"`
	K2PubB64            string            `json:"k2_pub_b64"`
	WitnessServerPubB64 string            `json:"witness_server_pub_b64"`
	Listing             json.RawMessage   `json:"listing"`
	SnapshotBeforeCron  int               `json:"snapshot_status_before_cron"`
	SnapshotAfterCron   json.RawMessage   `json:"snapshot_after_cron"`
	PullPages           []json.RawMessage `json:"pull_pages"`
	DeviceWitness       json.RawMessage   `json:"device_witness"`
	PushDeviceAdded     json.RawMessage   `json:"push_device_added_response"`
	PushEntryCreated    json.RawMessage   `json:"push_entry_created_response"`
	PushEntryAmended    json.RawMessage   `json:"push_entry_amended_response"`
	Census              map[string]any    `json:"census"`
}

func TestReimportRehearsal(t *testing.T) {
	jsonl := os.Getenv("RECOVERED_JSONL")
	if jsonl == "" {
		t.Skip("skipping: RECOVERED_JSONL not set")
	}
	byVault := loadRows(t, jsonl)
	mainRows, secondRows := byVault[vaultMain], byVault[vaultSecond]
	if len(mainRows) == 0 {
		t.Fatalf("no rows for the main vault in %s", jsonl)
	}

	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	cap := capture{Census: map[string]any{}}

	// ---- keys: the server witness key (test-local) and the phone's K2 ----
	serverPub, serverPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	k2Seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(k2Seed); err != nil {
		t.Fatal(err)
	}
	k2Priv := ed25519.NewKeyFromSeed(k2Seed)
	k2PubB64 := base64.StdEncoding.EncodeToString(k2Priv.Public().(ed25519.PublicKey))
	cap.K2SeedB64 = base64.StdEncoding.EncodeToString(k2Seed)
	cap.K2PubB64 = k2PubB64
	cap.WitnessServerPubB64 = base64.StdEncoding.EncodeToString(serverPub)

	// ---- prod-shaped residue after the deletion plus the reinstall's sign-in ----
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, google_sub, email, email_verified, name) VALUES ($1::uuid, 'sub-rehearsal', 'rehearsal@example.com', TRUE, 'rehearsal')`, acctNew); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id, account_id) VALUES ($1::uuid, $2::uuid)`, installNew, acctNew); err != nil {
		t.Fatalf("seed new install: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id, account_deleted_at, deletion_account_id) VALUES ($1::uuid, NOW(), $2::uuid)`, installOld, acctDeleted); err != nil {
		t.Fatalf("seed retired install: %v", err)
	}
	k1, _ := base64.StdEncoding.DecodeString(anchorK1B64)
	if _, err := pool.Exec(ctx, `INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, vault_trust_anchor_pubkey) VALUES ($1::uuid, $2::uuid, 'New kaata', 'AFN', 0, $3)`, vaultLocal, acctNew, k1); err != nil {
		t.Fatalf("seed local vault: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, last_change_hlc_ms) VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid, $3)`, vaultLocal, acctNew, time.Now().UnixMilli()); err != nil {
		t.Fatalf("seed local membership: %v", err)
	}

	// ---- 1. THE IMPORT ----
	nMain, err := importVault(ctx, pool, vaultMain, os.Getenv("REHEARSAL_MAIN_NAME"), "AFN", mainRows)
	if err != nil {
		t.Fatalf("import main: %v", err)
	}
	nSecond, err := importVault(ctx, pool, vaultSecond, "تربار فروشی وکمیشن کاری حاجی عبدالرحمان و پسران", "AFN", secondRows)
	if err != nil {
		t.Fatalf("import second: %v", err)
	}
	if nMain != int64(len(mainRows)) || nSecond != int64(len(secondRows)) {
		t.Fatalf("inserted %d/%d main, %d/%d second", nMain, len(mainRows), nSecond, len(secondRows))
	}
	var maxMain int64
	var trig string
	if err := pool.QueryRow(ctx, `SELECT MAX(server_seq) FROM events WHERE vault_id=$1::uuid`, vaultMain).Scan(&maxMain); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT tgenabled::text FROM pg_trigger WHERE tgname='signed_event_actor_evidence'`).Scan(&trig); err != nil {
		t.Fatal(err)
	}
	if trig != "O" {
		t.Fatalf("trigger left in state %q after import", trig)
	}
	var keptActor int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid AND signed_actor_account_id=$2::uuid`, vaultMain, acctDeleted).Scan(&keptActor); err != nil {
		t.Fatal(err)
	}
	cap.Census["main_rows"] = nMain
	cap.Census["second_rows"] = nSecond
	cap.Census["main_max_server_seq"] = maxMain
	cap.Census["main_rows_with_deleted_signed_actor"] = keptActor
	t.Logf("import: main=%d rows (max server_seq %d, %d keep the deleted account as signed actor), second=%d rows", nMain, maxMain, keptActor, nSecond)

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
	jwt, err := auth.SignSession(jwtSecret, acctNew, installNew, "google", "sub-rehearsal")
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

	// ---- 2. GET /v1/vaults ----
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
	for _, id := range []string{vaultMain, vaultSecond, vaultLocal} {
		v, ok := seen[id]
		if !ok || v.Role != "owner" || v.Currency != "AFN" || v.VaultTrustAnchorPubkey == nil || *v.VaultTrustAnchorPubkey != anchorK1B64 {
			t.Fatalf("listing for %s wrong: %+v", id[:8], v)
		}
	}
	t.Logf("GET /v1/vaults: %d vaults, all owner/AFN, anchor K1 carried", len(listing.Vaults))

	// ---- 3. snapshot is 404 right after the import; pull-from-0 drains ----
	code, body = call(http.MethodGet, "/v1/sync/snapshot?vault_id="+vaultMain, nil)
	cap.SnapshotBeforeCron = code
	if code != 404 {
		t.Fatalf("snapshot before cron: %d %s", code, body)
	}
	var pulled []syncapi.PulledEvent
	after := int64(0)
	for pages := 0; pages < 50; pages++ {
		code, body = call(http.MethodGet, fmt.Sprintf("/v1/sync/pull?vault_id=%s&after_server_seq=%d&limit=200", vaultMain, after), nil)
		if code != 200 {
			t.Fatalf("pull: %d %s", code, body)
		}
		cap.PullPages = append(cap.PullPages, json.RawMessage(body))
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
	if int64(len(pulled)) != nMain || after != maxMain {
		t.Fatalf("pull drained %d rows to cursor %d, want %d rows to %d", len(pulled), after, nMain, maxMain)
	}
	// The round trip the phone's role gate performs: verify each signed row
	// against its signer pubkey over the WIRE envelope (actor = wire account_id).
	var valid, invalid, unsigned, noPub, actorDeleted int
	for _, ev := range pulled {
		sig := deref(ev.EventSigB64)
		pub := deref(ev.SignerDevicePubkey)
		if sig == "" {
			unsigned++
			continue
		}
		if pub == "" {
			noPub++
			continue
		}
		if ev.AccountID != nil && *ev.AccountID == acctDeleted {
			actorDeleted++
		}
		ok, err := canonevent.Verify(canonevent.Envelope{
			VaultID: vaultMain, EventID: ev.EventID, EventType: ev.EventType, SchemaVersion: ev.SchemaVersion,
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
	cap.Census["pull_rows"] = len(pulled)
	cap.Census["pull_sig_valid"] = valid
	cap.Census["pull_sig_invalid"] = invalid
	cap.Census["pull_unsigned"] = unsigned
	cap.Census["pull_signed_no_pubkey"] = noPub
	cap.Census["pull_wire_actor_is_deleted_account"] = actorDeleted
	t.Logf("pull-from-0: %d rows, signatures valid=%d invalid=%d unsigned=%d no-pubkey=%d; wire actor = deleted account on %d signed rows", len(pulled), valid, invalid, unsigned, noPub, actorDeleted)
	if valid < len(pulled)*9/10 {
		t.Fatalf("most signatures must verify after a verbatim import (valid=%d of %d)", valid, len(pulled))
	}

	// ---- 4. the production snapshot cron builds a snapshot unprompted ----
	cronCtx, cancel := context.WithCancel(ctx)
	go syncapi.StartSnapshotCron(cronCtx, pool, time.Hour, 2)
	deadline := time.Now().Add(90 * time.Second)
	var snapUpTo int64
	for time.Now().Before(deadline) {
		if err := pool.QueryRow(ctx, `SELECT COALESCE(MAX(up_to_server_seq),0) FROM vault_snapshots WHERE vault_id=$1::uuid`, vaultMain).Scan(&snapUpTo); err != nil {
			t.Fatal(err)
		}
		if snapUpTo > 0 {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	cancel()
	if snapUpTo != maxMain {
		t.Fatalf("cron snapshot up_to=%d, want %d", snapUpTo, maxMain)
	}
	code, body = call(http.MethodGet, "/v1/sync/snapshot?vault_id="+vaultMain, nil)
	if code != 200 {
		t.Fatalf("snapshot after cron: %d %s", code, body)
	}
	cap.SnapshotAfterCron = json.RawMessage(body)
	var snap syncapi.SnapshotResponse
	if err := json.Unmarshal(body, &snap); err != nil {
		t.Fatal(err)
	}
	rels := map[string]bool{}
	for _, rl := range snap.Relationships {
		rels[rl.ID] = true
	}
	orphanEntries, orphanRels := 0, map[string]bool{}
	for _, e := range snap.Entries {
		if !rels[e.RelationshipID] {
			orphanEntries++
			orphanRels[e.RelationshipID] = true
		}
	}
	cap.Census["snapshot_users"] = len(snap.Users)
	cap.Census["snapshot_relationships"] = len(snap.Relationships)
	cap.Census["snapshot_entries"] = len(snap.Entries)
	cap.Census["snapshot_entries_with_orphan_relationship"] = orphanEntries
	cap.Census["snapshot_orphan_relationships"] = len(orphanRels)
	cap.Census["snapshot_settlement_events"] = len(snap.SettlementEvents)
	cap.Census["snapshot_membership_events"] = len(snap.MembershipEvents)
	anchorOK := snap.Vault.VaultTrustAnchorPubkey != nil && *snap.Vault.VaultTrustAnchorPubkey == anchorK1B64
	t.Logf("snapshot (cron, up_to %d): users=%d relationships=%d entries=%d (%d entries reference %d relationships with no person_added), settlement_events=%d membership_events=%d, vault name=%q anchorK1=%v",
		snap.SnapshotServerSeq, len(snap.Users), len(snap.Relationships), len(snap.Entries), orphanEntries, len(orphanRels), len(snap.SettlementEvents), len(snap.MembershipEvents), snap.Vault.Name, anchorOK)

	// ---- 6. the new phone binds its device and writes ----
	code, body = call(http.MethodPost, "/v1/devices/register-key", map[string]any{"ed25519_pubkey": k2PubB64})
	if code != 200 {
		t.Fatalf("register-key: %d %s", code, body)
	}
	code, body = call(http.MethodPost, "/v1/vaults/"+vaultMain+"/witness", nil)
	if code != 200 {
		t.Fatalf("witness: %d %s", code, body)
	}
	cap.DeviceWitness = json.RawMessage(body)
	var wr mesh.WitnessResult
	if err := json.Unmarshal(body, &wr); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	sign := func(ev *syncapi.PushEvent) {
		msg, err := canonevent.Canonical(canonevent.Envelope{
			VaultID: vaultMain, EventID: ev.EventID, EventType: ev.EventType, SchemaVersion: ev.SchemaVersion,
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
	push := func(ev syncapi.PushEvent) (syncapi.PushResponse, []byte) {
		code, body := call(http.MethodPost, "/v1/sync/push", map[string]any{"vault_id": vaultMain, "device_id": installNew, "events": []syncapi.PushEvent{ev}})
		if code != 200 {
			t.Fatalf("push %s: %d %s", ev.EventType, code, body)
		}
		var res syncapi.PushResponse
		if err := json.Unmarshal(body, &res); err != nil {
			t.Fatal(err)
		}
		return res, body
	}
	actor := acctNew
	seq1, seq2, seq3 := int64(1), int64(2), int64(3)
	devAdd := syncapi.PushEvent{
		EventID: uuid.NewString(), EventType: "vault_device_added", SchemaVersion: 1,
		HLC:            syncapi.PushHLC{PhysicalMS: now, Logical: 0, DeviceID: installNew},
		ActorAccountID: &actor, TargetID: strPtr(installNew), AuthorSeq: &seq1,
	}
	devAdd.Payload, _ = json.Marshal(map[string]any{
		"account_id": acctNew, "device_id": installNew, "device_pubkey": k2PubB64,
		"witness": map[string]any{"sig_b64": wr.DeviceWitness.SigB64, "server_key_id": wr.ServerKeyID, "issued_at_ms": wr.DeviceWitness.IssuedAtMS},
	})
	sign(&devAdd)
	res, raw := push(devAdd)
	cap.PushDeviceAdded = json.RawMessage(raw)
	if len(res.Accepted) != 1 {
		t.Fatalf("witnessed vault_device_added not accepted: %s", raw)
	}
	var boundAcct string
	if err := pool.QueryRow(ctx, `SELECT account_id::text FROM vault_devices WHERE vault_id=$1::uuid AND device_id=$2::uuid AND removed_at_ms IS NULL`, vaultMain, installNew).Scan(&boundAcct); err != nil || boundAcct != acctNew {
		t.Fatalf("vault_devices not folded for K2: %v %q", err, boundAcct)
	}
	// a tally against a restored contact, then an amend of a restored tally
	relID := snap.Relationships[0].ID
	entryID := uuid.NewString()
	created := syncapi.PushEvent{
		EventID: uuid.NewString(), EventType: "entry_created", SchemaVersion: 1,
		HLC:            syncapi.PushHLC{PhysicalMS: now + 1, Logical: 0, DeviceID: installNew},
		ActorAccountID: &actor, TargetID: &entryID, RelationshipID: &relID, AuthorSeq: &seq2,
	}
	created.Payload, _ = json.Marshal(map[string]any{"entry_id": entryID, "relationship_id": relID, "type": "debt", "amount_afn": 250, "note": "rehearsal tally", "occurred_at_ms": now + 1})
	sign(&created)
	res, raw = push(created)
	cap.PushEntryCreated = json.RawMessage(raw)
	if len(res.Accepted) != 1 || res.Accepted[0].ServerSeq != maxMain+2 {
		t.Fatalf("entry_created by K2: %s", raw)
	}
	target := snap.Entries[0].ID
	amended := syncapi.PushEvent{
		EventID: uuid.NewString(), EventType: "entry_amended", SchemaVersion: 1,
		HLC:            syncapi.PushHLC{PhysicalMS: now + 2, Logical: 0, DeviceID: installNew},
		ActorAccountID: &actor, TargetID: &target, RelationshipID: strPtr(snap.Entries[0].RelationshipID), AuthorSeq: &seq3,
	}
	amended.Payload, _ = json.Marshal(map[string]any{"changes": map[string]any{"note": "amended in rehearsal"}})
	sign(&amended)
	res, raw = push(amended)
	cap.PushEntryAmended = json.RawMessage(raw)
	if len(res.Accepted) != 1 || res.Accepted[0].ServerSeq != maxMain+3 {
		t.Fatalf("entry_amended by K2: %s", raw)
	}
	t.Logf("K2 pushes: witnessed vault_device_added folded into vault_devices; entry_created -> server_seq %d; entry_amended -> server_seq %d", maxMain+2, maxMain+3)

	// ---- 7. idempotent re-import ----
	again, err := importVault(ctx, pool, vaultMain, "", "AFN", mainRows)
	if err != nil {
		t.Fatalf("re-import: %v", err)
	}
	if again != 0 {
		t.Fatalf("re-import inserted %d rows, want 0", again)
	}
	var total int64
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM events WHERE vault_id=$1::uuid`, vaultMain).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != nMain+3 {
		t.Fatalf("events after everything: %d, want %d", total, nMain+3)
	}

	// ---- capture for the Node harness ----
	if dir := os.Getenv("REHEARSAL_CAPTURE_DIR"); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		out, _ := json.MarshalIndent(cap, "", " ")
		p := filepath.Join(dir, "capture.json")
		if err := os.WriteFile(p, out, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("capture written: %s (%d bytes)", p, len(out))
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func strPtr(s string) *string { return &s }
