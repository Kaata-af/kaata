package reimport

// Rehearsal of the production re-import against a REAL Postgres with the full
// migration chain (testutil.ConnectTestDB → POSTGRES_TEST_URL; never the dev
// DB). It executes the generated SQL verbatim and then drives the real
// backend services the phone will hit: GET /v1/vaults listing, the snapshot
// endpoint's LatestSnapshot, pull pages, the witness endpoint, and pushes
// signed by the phone's NEW key K2 (the witnessed device bind recovery.ts
// emits, then a person + tally, then a rename).
//
//   REIMPORT_JSONL=<path to events_recovered.jsonl> \
//   POSTGRES_TEST_URL=postgres://kaata@127.0.0.1:55436/kaata_test \
//   go test ./scratch-reimport/reimport/ -run TestReimportRehearsal -v

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/mesh"
	ksync "github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/internal/testutil"
	"github.com/matee/kaata-backend/internal/vaults"
	"github.com/matee/kaata-backend/scratch-reimport/canonevent"
)

const (
	ownerAcct   = "a98f0bc3-796e-4625-99ad-e8f7b1565ac1" // the LIVE account (second sign-in)
	deadAcct    = "498717f1-6686-4961-9f1e-7ff852e6f275" // the DELETED account that signed the history
	mainVault   = "eb7cd98d-32f0-4c6c-a456-7ad3e4ca8b6d"
	secondVault = "98e2d78f-96f4-4188-919d-0d7d5501258c"
	oldInstall  = "907448d9-3844-4a15-8b7b-d5c77870f224" // K1, retired by the deletion
	midInstall  = "6c7ac239-2cbd-4cd7-aa39-3360e3d1de82"
	newInstall  = "b4950978-cf4a-461f-b059-ba2b66bd86a8" // K2, the phone today
	k1B64       = "pMauYtxNGJ4JxjOZMZFz8x5r8NZX7GxOfPWOSvRBqeg="

	// Oracle-derived expectations (the decoded complete pre-deletion snapshots).
	mainOracleName   = "لیست نسیه سیب غزنی  سال 1405"
	secondOracleName = "لیست نسیه بار ها فراه سال در 1405"
	mainUpTo         = int64(2300)
	secondUpTo       = int64(260)

	scratchpad          = `C:\Users\Matee\AppData\Local\Temp\claude\C--Users-Matee-Desktop-Projects-Kaata-kaata\02b77d52-d3e7-44aa-852e-2348f3342122\scratchpad`
	defaultJSONL        = scratchpad + `\events_recovered.jsonl`
	defaultMainOracle   = scratchpad + `\skeptic-es\snapshot_30613.json`
	defaultSecondOracle = scratchpad + `\skeptic-es\snapshot_second_210.json`
)

// ReimportDeviceID is the deterministic device id stamped on synthetic rows.
var ReimportDeviceID = uuid.NewSHA1(uuid.NameSpaceURL, []byte("kaata-reimport-2026-10-07/device")).String()

func jsonlPath(t *testing.T) string {
	p := os.Getenv("REIMPORT_JSONL")
	if p == "" {
		p = defaultJSONL
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("recovered JSONL not found at %s (set REIMPORT_JSONL)", p)
	}
	return p
}

func loadOracle(t *testing.T, env, def string) *Oracle {
	t.Helper()
	p := os.Getenv(env)
	if p == "" {
		p = def
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("oracle not found at %s (set %s)", p, env)
	}
	o, err := LoadOracle(p)
	if err != nil {
		t.Fatal(err)
	}
	return o
}

// testOptions leaves the vault names empty so they default to the oracle name
// (vaults.name == the projected name, exactly as production generates it).
func testOptions(t *testing.T) Options {
	return Options{
		OwnerAccountID:   ownerAcct,
		DeletedAccountID: deadAcct,
		PhoneInstallID:   newInstall,
		AnchorPubB64:     k1B64,
		ReimportDeviceID: ReimportDeviceID,
		Now:              time.Now(),
		Vaults: []VaultSpec{
			{ID: mainVault, Currency: "AFN", Oracle: loadOracle(t, "REIMPORT_MAIN_ORACLE", defaultMainOracle), UpTo: mainUpTo},
			{ID: secondVault, Currency: "AFN", Oracle: loadOracle(t, "REIMPORT_SECOND_ORACLE", defaultSecondOracle), UpTo: secondUpTo},
		},
	}
}

func TestReimportRehearsal(t *testing.T) {
	ctx := context.Background()
	pool := testutil.ConnectTestDB(t)

	// ---- the production state we land in: the live account, its three
	// installs (the old one retired by the deletion), K1 still registered for
	// the dead install, K2 registered for the phone today.
	k2Pub, k2Priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	k1Raw, _ := base64.StdEncoding.DecodeString(k1B64)
	mustExec(t, pool, `INSERT INTO accounts (id, google_sub, email, email_verified, name) VALUES ($1::uuid, 'sub-live', 'hlalahmdlyzayy42@gmail.com', TRUE, 'هلال احمد علیزائی')`, ownerAcct)
	mustExec(t, pool, `INSERT INTO installs (install_id, app_version, platform, account_id, account_deleted_at, deletion_account_id) VALUES
		($1::uuid, '1.2.0', 'android', NULL, NOW() - interval '1 day', $4::uuid),
		($2::uuid, '1.2.0', 'android', $5::uuid, NULL, NULL),
		($3::uuid, '1.2.0', 'android', $5::uuid, NULL, NULL)`, oldInstall, midInstall, newInstall, deadAcct, ownerAcct)
	mustExec(t, pool, `INSERT INTO device_keys (install_id, ed25519_pubkey) VALUES ($1::uuid, $2), ($3::uuid, $4)`, oldInstall, k1Raw, newInstall, []byte(k2Pub))

	// ---- plan
	rows, err := LoadJSONL(jsonlPath(t))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := BuildPlan(rows, testOptions(t))
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	t.Log("\n" + plan.Summary())
	mainPlan, secondPlan := plan.Vaults[0], plan.Vaults[1]
	if mainPlan.Stats.Rows != 1651 || mainPlan.Stats.Signed != 1641 || mainPlan.Stats.SignedVerified != 1641 || mainPlan.Stats.Unsigned != 10 {
		t.Fatalf("main stats: %+v", mainPlan.Stats)
	}
	if secondPlan.Stats.Rows != 133 || secondPlan.Stats.Signed != 132 || secondPlan.Stats.SignedVerified != 132 || secondPlan.Stats.Unsigned != 1 {
		t.Fatalf("second stats: %+v", secondPlan.Stats)
	}
	// Reconstruction = everything the carve→oracle diff needs, plus the 1 no-op
	// margin row: 443 entry_created + 25 entry_deleted + 22 person_added +
	// 7 person_archived + 2 person_phone_changed + 1 person_renamed +
	// 1 shop_profile_updated + 1 vault_setting_set + 4 entry_amended + 1 margin.
	if len(mainPlan.Reconstruction) != 507 || mainPlan.Stats.Reconstructed != 507 {
		t.Fatalf("main reconstruction = %d, want 507", len(mainPlan.Reconstruction))
	}
	if len(secondPlan.Reconstruction) != 92 {
		t.Fatalf("second reconstruction = %d, want 92", len(secondPlan.Reconstruction))
	}
	if mainPlan.UpTo != mainUpTo {
		t.Fatalf("main up_to = %d, want %d", mainPlan.UpTo, mainUpTo)
	}

	sqlText := plan.RenderSQL()
	rollback := plan.RenderRollbackSQL()
	out := t.TempDir()
	if err := os.WriteFile(filepath.Join(out, "reimport.sql"), []byte(sqlText), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("rendered reimport.sql: %d bytes", len(sqlText))

	// ---- execute the production script verbatim (one transaction), as the
	// non-superuser table owner — exactly how psql -1 -f would run it on prod.
	if _, err := pool.Exec(ctx, sqlText); err != nil {
		t.Fatalf("reimport.sql failed: %v", err)
	}
	// Running it twice must be refused by the preflight (idempotency guard).
	if _, err := pool.Exec(ctx, sqlText); err == nil {
		t.Fatal("second run of reimport.sql must fail the preflight")
	}

	// ---- trigger is back on and the evidence column survived the bypass
	var disabled bool
	mustRow(t, pool, `SELECT tgenabled = 'D' FROM pg_trigger WHERE tgname = 'signed_event_actor_evidence'`).Scan(&disabled)
	if disabled {
		t.Fatal("trigger left disabled")
	}
	var deadEvidence, nullEvidence int
	mustRow(t, pool, `SELECT count(*) FROM events WHERE vault_id = $1::uuid AND signed_actor_account_id = $2::uuid`, mainVault, deadAcct).Scan(&deadEvidence)
	mustRow(t, pool, `SELECT count(*) FROM events WHERE vault_id = $1::uuid AND NULLIF(event_sig_b64,'') IS NOT NULL AND signed_actor_account_id IS NULL`, secondVault).Scan(&nullEvidence)
	// 56 rows signed over a null actor before the first sign-in + the one whose
	// signer column was lost in the carve (also pre-binding, verified over null).
	if deadEvidence != 1641 || nullEvidence != 57 {
		t.Fatalf("evidence columns: dead=%d (want 1641) null-signed second=%d (want 57)", deadEvidence, nullEvidence)
	}

	// ---- GET /v1/vaults as the live account
	vsvc := vaults.NewService(pool)
	listing, err := vsvc.List(ctx, ownerAcct)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing) != 2 {
		t.Fatalf("listing = %d vaults", len(listing))
	}
	for _, l := range listing {
		if l.Role != "owner" || l.MembersCount != 1 || l.ArchivedAtMS != nil || l.VaultTrustAnchorPubkey == nil || *l.VaultTrustAnchorPubkey != k1B64 {
			t.Fatalf("listing row %+v", l)
		}
		if l.Currency != "AFN" {
			t.Fatalf("currency %q", l.Currency)
		}
	}

	// ---- GET /v1/sync/snapshot for the main vault
	ssvc := ksync.NewService(pool)
	ok, err := ssvc.IsMember(ctx, ownerAcct, mainVault)
	if err != nil || !ok {
		t.Fatalf("IsMember = %v %v", ok, err)
	}
	snap, err := ssvc.LatestSnapshot(ctx, mainVault)
	if err != nil {
		t.Fatalf("LatestSnapshot: %v", err)
	}
	if snap.SnapshotServerSeq != mainPlan.UpTo || len(snap.Events) != 0 || len(snap.MembershipEvents) != 0 {
		t.Fatalf("snapshot cursor=%d tail=%d membership=%d", snap.SnapshotServerSeq, len(snap.Events), len(snap.MembershipEvents))
	}
	if len(snap.SettlementEvents) != 123 {
		t.Fatalf("settlement events = %d", len(snap.SettlementEvents))
	}
	if snap.Vault.Name != mainOracleName || snap.Vault.Currency != "AFN" || snap.Vault.VaultTrustAnchorPubkey == nil || *snap.Vault.VaultTrustAnchorPubkey != k1B64 || snap.Vault.AccountID == nil || *snap.Vault.AccountID != ownerAcct {
		t.Fatalf("snapshot vault %+v", snap.Vault)
	}
	if len(snap.Users) != 151 || len(snap.Relationships) != 151 || len(snap.Entries) != 1771 {
		t.Fatalf("snapshot users=%d relationships=%d entries=%d, want 151/151/1771", len(snap.Users), len(snap.Relationships), len(snap.Entries))
	}
	if snap.HLCLast.PMS < mainPlan.MaxHLC {
		t.Fatalf("hlc_last %d < max hlc %d", snap.HLCLast.PMS, mainPlan.MaxHLC)
	}
	relIDs := map[string]bool{}
	for _, r := range snap.Relationships {
		relIDs[r.ID] = true
	}
	deleted := 0
	gave, received := 0.0, 0.0
	for _, e := range snap.Entries {
		if !relIDs[e.RelationshipID] {
			t.Fatalf("entry %s references relationship %s missing from the snapshot (phone FK would abort the restore)", e.ID, e.RelationshipID)
		}
		if e.IsDeleted == 1 {
			deleted++
			continue
		}
		if e.RelationshipID == "e224fc62-b041-4698-8f52-eec309ba493f" {
			amt, _ := strconv.ParseFloat(string(e.AmountAFN), 64)
			if e.Type == "debt" {
				gave += amt
			} else {
				received += amt
			}
		}
	}
	// Cross-check: with the carve→oracle reconstruction, relationship e224fc62
	// (an orphan rel in the carve) now folds to its COMPLETE balance. Both
	// legs equal 202829 — a fully settled account (oracle non-deleted sums).
	if gave != 202829 || received != 202829 {
		t.Fatalf("relationship e224fc62 gave=%v received=%v, want 202829/202829", gave, received)
	}
	// All 52 deletions are present now (the reconstruction restores both the
	// lost entry_created rows and the lost tombstones), so the folded snapshot
	// carries exactly the oracle's 52 deleted entries.
	if deleted != 52 {
		t.Fatalf("deleted entries = %d, want 52", deleted)
	}
	t.Logf("main snapshot: users=%d relationships=%d entries=%d deleted=%d settlement_events=%d", len(snap.Users), len(snap.Relationships), len(snap.Entries), deleted, len(snap.SettlementEvents))

	// The offline projection equals what the cron/outreach code folds from the DB rows.
	p, err := ksync.LoadVaultProjection(ctx, pool, mainVault)
	if err != nil {
		t.Fatal(err)
	}
	dbJSON, _ := ksync.ProjectionToJSON(*p)
	if string(dbJSON) != string(mainPlan.SnapshotJSON) {
		t.Fatal("offline snapshot JSON differs from the server-side fold of the inserted rows")
	}

	// Second vault: shop profile survived in the log.
	snap2, err := ssvc.LatestSnapshot(ctx, secondVault)
	if err != nil {
		t.Fatal(err)
	}
	// The second vault's shop name was RENAMED (its rename vault_setting_set was
	// lost in the carve); reconstruction restores the oracle's current name.
	if snap2.ShopProfile == nil || snap2.ShopProfile.ShopName != secondOracleName {
		t.Fatalf("second vault shop profile %+v", snap2.ShopProfile)
	}
	if len(snap2.Users) != 38 || len(snap2.Relationships) != 38 || len(snap2.Entries) != 82 {
		t.Fatalf("second snapshot users=%d relationships=%d entries=%d, want 38/38/82", len(snap2.Users), len(snap2.Relationships), len(snap2.Entries))
	}
	t.Logf("second snapshot: users=%d relationships=%d entries=%d reconstruction=%d settlement_events=%d", len(snap2.Users), len(snap2.Relationships), len(snap2.Entries), len(secondPlan.Reconstruction), len(snap2.SettlementEvents))

	// ---- the no-snapshot path (approach A): pull from 0 serves every row with
	// the ORIGINAL signed actor and signatures that verify with K1.
	after := int64(0)
	pulled := 0
	actorDead, actorNull, actorOwner := 0, 0, 0
	for {
		res, err := ssvc.PullEvents(ctx, ksync.PullInput{AccountID: ownerAcct, VaultID: mainVault, AfterServerSeq: after, Limit: 1000})
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range res.Events {
			pulled++
			switch {
			case ev.EventSigB64 != nil && *ev.EventSigB64 != "":
				if ev.AccountID == nil {
					actorNull++
				} else if *ev.AccountID == deadAcct {
					actorDead++
				} else {
					t.Fatalf("signed event %s served with actor %s", ev.EventID, *ev.AccountID)
				}
				valid, err := canonevent.Verify(canonevent.Envelope{
					VaultID: mainVault, EventID: ev.EventID, EventType: ev.EventType, SchemaVersion: ev.SchemaVersion,
					HLCPhysicalMS: ev.HLC.PMS, HLCLogical: ev.HLC.L, HLCDeviceID: ev.HLC.DID,
					ActorAccountID: ev.AccountID, TargetID: ev.TargetID, RelationshipID: ev.RelationshipID, Payload: ev.Payload,
				}, *ev.EventSigB64, *ev.SignerDevicePubkey)
				if err != nil || !valid {
					t.Fatalf("pulled event %s (seq %d) does not verify on the wire: %v", ev.EventID, ev.ServerSeq, err)
				}
			default:
				// account_id is NULL on every re-inserted row; the main vault has no
				// account_bound, so binding resolution leaves the wire actor NULL.
				if ev.AccountID != nil {
					t.Fatalf("unsigned event %s served with actor %v, want NULL", ev.EventID, *ev.AccountID)
				}
				actorOwner++
			}
		}
		after = res.NextAfterServerSeq
		if !res.HasMore {
			break
		}
	}
	// 2158 = 1651 carved + 507 reconstruction. Signed rows (1641) keep the
	// deleted actor; the 517 unsigned rows (10 carve-lost signatures + 507
	// reconstruction) are served with a NULL actor.
	if pulled != 2158 || actorDead != 1641 || actorNull != 0 || actorOwner != 517 {
		t.Fatalf("pull: total=%d dead=%d null=%d owner=%d, want 2158/1641/0/517", pulled, actorDead, actorNull, actorOwner)
	}

	// ---- what the phone does next (recovery.ts @628eed5): a witnessed
	// vault_device_added for K2, pushed as the live owner from the new install.
	serverPub, serverPriv, _ := ed25519.GenerateKey(rand.Reader)
	ssvc.SetWitnessPubkeys([]ed25519.PublicKey{serverPub})
	msvc := mesh.NewService(pool, serverPriv, base64.StdEncoding.EncodeToString(serverPub), "")
	w, err := msvc.IssueWitness(ctx, mainVault, ownerAcct, newInstall)
	if err != nil {
		t.Fatalf("IssueWitness: %v", err)
	}
	if w.MemberWitness != nil {
		t.Fatal("owner must not get a member witness")
	}
	k2B64 := base64.StdEncoding.EncodeToString(k2Pub)
	now := time.Now().UnixMilli()
	bindPayload, _ := json.Marshal(map[string]any{
		"account_id": ownerAcct, "device_id": newInstall, "device_pubkey": k2B64,
		"witness": map[string]any{"sig_b64": w.DeviceWitness.SigB64, "server_key_id": w.ServerKeyID, "issued_at_ms": w.DeviceWitness.IssuedAtMS},
	})
	bind := signedPush(t, k2Priv, mainVault, "vault_device_added", now, newInstall, ownerAcct, newInstall, nil, 1, bindPayload)
	res := mustPush(t, ssvc, mainVault, []ksync.PushEvent{bind})
	if len(res.Accepted) != 1 || len(res.Rejected) != 0 {
		t.Fatalf("witnessed device bind: %+v", res)
	}
	var boundAcct string
	mustRow(t, pool, `SELECT account_id::text FROM vault_devices WHERE vault_id = $1::uuid AND device_id = $2::uuid AND removed_at_ms IS NULL`, mainVault, newInstall).Scan(&boundAcct)
	if boundAcct != ownerAcct {
		t.Fatalf("vault_devices bound to %q", boundAcct)
	}

	// ---- a new contact + tally authored by K2 (lawful-at-HLC ACL: owner).
	userID, relID, entryID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	personPayload, _ := json.Marshal(map[string]any{"user_id": userID, "name": "مشتری جدید", "phone_e164": nil, "relationship_context": "peer"})
	person := signedPush(t, k2Priv, mainVault, "person_added", now+1, newInstall, ownerAcct, userID, &relID, 2, personPayload)
	entryPayload, _ := json.Marshal(map[string]any{"entry_id": entryID, "relationship_id": relID, "type": "debt", "amount_afn": 250, "note": nil, "occurred_at_ms": now + 2})
	entry := signedPush(t, k2Priv, mainVault, "entry_created", now+2, newInstall, ownerAcct, entryID, &relID, 3, entryPayload)
	renamePayload, _ := json.Marshal(map[string]any{"key": "name", "value": "REHEARSAL renamed"})
	rename := signedPush(t, k2Priv, mainVault, "vault_setting_set", now+3, newInstall, ownerAcct, mainVault, nil, 4, renamePayload)
	res = mustPush(t, ssvc, mainVault, []ksync.PushEvent{person, entry, rename})
	if len(res.Accepted) != 3 || len(res.Rejected) != 0 {
		t.Fatalf("new writes: %+v", res)
	}
	if res.VaultServerSeqHigh != mainPlan.UpTo+4 {
		t.Fatalf("server_seq high %d, want %d", res.VaultServerSeqHigh, mainPlan.UpTo+4)
	}
	var name string
	mustRow(t, pool, `SELECT name FROM vaults WHERE vault_id = $1::uuid`, mainVault).Scan(&name)
	if name != "REHEARSAL renamed" {
		t.Fatalf("rename mirror: vaults.name = %q", name)
	}
	// The phone's cursor sits at the snapshot; the tail it pulls is exactly its own writes.
	tail, err := ssvc.PullEvents(ctx, ksync.PullInput{AccountID: ownerAcct, VaultID: mainVault, AfterServerSeq: mainPlan.UpTo, Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	if len(tail.Events) != 4 || tail.Events[0].AccountID == nil || *tail.Events[0].AccountID != ownerAcct {
		t.Fatalf("tail after snapshot: %d events", len(tail.Events))
	}
	// ---- rollback script removes every trace, keeps identity rows.
	if _, err := pool.Exec(ctx, rollback); err != nil {
		t.Fatalf("rollback.sql: %v", err)
	}
	for _, tbl := range []string{"events", "vault_members", "vault_devices", "vault_snapshots", "vault_audit_log", "vaults"} {
		var n int
		mustRow(t, pool, `SELECT count(*) FROM `+tbl+` WHERE vault_id IN ($1::uuid, $2::uuid)`, mainVault, secondVault).Scan(&n)
		if n != 0 {
			t.Fatalf("%s still has %d rows after rollback", tbl, n)
		}
	}
	var accounts, installs, keys int
	mustRow(t, pool, `SELECT count(*) FROM accounts`).Scan(&accounts)
	mustRow(t, pool, `SELECT count(*) FROM installs`).Scan(&installs)
	mustRow(t, pool, `SELECT count(*) FROM device_keys`).Scan(&keys)
	if accounts != 1 || installs != 3 || keys != 2 {
		t.Fatalf("identity rows touched: accounts=%d installs=%d keys=%d", accounts, installs, keys)
	}

	// ---- and the import applies cleanly again after the rollback.
	if _, err := pool.Exec(ctx, sqlText); err != nil {
		t.Fatalf("re-import after rollback: %v", err)
	}
}

// TestSnapshotCronIsNoOpAfterImport: the 5-minute cron must not regenerate (or
// 404) the snapshot we inserted — the same up_to row exists, and the candidate
// predicate needs +1000 events or a 24h-old row.
func TestSnapshotCronIsNoOpAfterImport(t *testing.T) {
	ctx := context.Background()
	pool := testutil.ConnectTestDB(t)
	mustExec(t, pool, `INSERT INTO accounts (id, google_sub, email, email_verified, name) VALUES ($1::uuid, 'sub-live', 'x@gmail.com', TRUE, 'x')`, ownerAcct)
	mustExec(t, pool, `INSERT INTO installs (install_id, app_version, platform, account_id) VALUES ($1::uuid, '1.2.0', 'android', $2::uuid)`, newInstall, ownerAcct)
	mustExec(t, pool, `INSERT INTO device_keys (install_id, ed25519_pubkey) VALUES ($1::uuid, $2)`, newInstall, make([]byte, 32))
	rows, err := LoadJSONL(jsonlPath(t))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := BuildPlan(rows, testOptions(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, plan.RenderSQL()); err != nil {
		t.Fatal(err)
	}
	ssvc := ksync.NewService(pool)
	trigger := ksync.BuildPushSnapshotTrigger(ctx, pool, ssvc)
	trigger(mainVault)
	time.Sleep(1500 * time.Millisecond)
	var n int
	mustRow(t, pool, `SELECT count(*) FROM vault_snapshots WHERE vault_id = $1::uuid`, mainVault).Scan(&n)
	if n != 1 {
		t.Fatalf("snapshot rows after trigger = %d, want the single imported row", n)
	}
}

func signedPush(t *testing.T, priv ed25519.PrivateKey, vaultID, eventType string, pms int64, deviceID, actor, target string, rel *string, authorSeq int64, payload []byte) ksync.PushEvent {
	t.Helper()
	ev := ksync.PushEvent{
		EventID:        uuid.NewString(),
		HLC:            ksync.PushHLC{PhysicalMS: pms, Logical: 0, DeviceID: deviceID},
		EventType:      eventType,
		SchemaVersion:  1,
		TargetID:       &target,
		RelationshipID: rel,
		ActorAccountID: &actor,
		AuthorSeq:      &authorSeq,
		Payload:        payload,
	}
	sig, err := canonevent.Sign(canonevent.Envelope{
		VaultID: vaultID, EventID: ev.EventID, EventType: eventType, SchemaVersion: 1,
		HLCPhysicalMS: pms, HLCLogical: 0, HLCDeviceID: deviceID, ActorAccountID: &actor,
		TargetID: &target, RelationshipID: rel, Payload: payload,
	}, priv)
	if err != nil {
		t.Fatal(err)
	}
	pub := base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
	ev.EventSigB64 = &sig
	ev.SignerDevicePubkeyB64 = &pub
	return ev
}

func mustPush(t *testing.T, svc *ksync.Service, vaultID string, events []ksync.PushEvent) *ksync.PushResponse {
	t.Helper()
	res, err := svc.PushEvents(context.Background(), ksync.PushInput{AccountID: ownerAcct, VaultID: vaultID, DeviceID: newInstall, Events: events})
	if err != nil {
		t.Fatalf("PushEvents: %v", err)
	}
	return res
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql[:40], err)
	}
}

type scanner interface{ Scan(dest ...any) error }

type rowScan struct {
	t   *testing.T
	row scanner
}

func (r rowScan) Scan(dest ...any) {
	r.t.Helper()
	if err := r.row.Scan(dest...); err != nil {
		r.t.Fatal(err)
	}
}

func mustRow(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) rowScan {
	t.Helper()
	return rowScan{t: t, row: pool.QueryRow(context.Background(), sql, args...)}
}
