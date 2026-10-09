// Command projectrecovered is SCRATCH tooling for the 2026-10-07 support
// incident (apps/backend/scratch-reimport, never shipped).
//
// It folds the forensically recovered `events` rows (events_recovered.jsonl,
// one JSON object per row, keys = column names) through the backend's OWN
// projection — internal/sync.ApplyEventsOnto, the function buildSnapshotInTx
// and LoadVaultProjection call — after shaping each row into a LedgerEvent
// exactly the way loadVaultEvents does (snapshot.go). It then prints, per
// vault, what a vault_snapshots.snapshot payload and a GET /v1/sync/snapshot
// response built from those rows would contain, plus the balances the phone
// would compute from the restored rows (lib/money-sql.ts signedEntryMinorSumSql).
//
// Entirely in memory: it opens no database and writes only under -out.
//
//	cd apps/backend && go run ./scratch-reimport/projectrecovered \
//	    -in  <scratchpad>/events_recovered.jsonl \
//	    -out <scratchpad>
package main

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/scratch-reimport/canonevent"
)

// row is one carved events row, keys = Postgres column names.
type row struct {
	EventID              string          `json:"event_id"`
	VaultID              string          `json:"vault_id"`
	HLCPhysicalMS        int64           `json:"hlc_physical_ms"`
	HLCLogical           int64           `json:"hlc_logical"`
	HLCDeviceID          string          `json:"hlc_device_id"`
	DeviceID             string          `json:"device_id"`
	AccountID            *string         `json:"account_id"`
	TargetID             *string         `json:"target_id"`
	RelationshipID       *string         `json:"relationship_id"`
	EventType            string          `json:"event_type"`
	SchemaVersion        int             `json:"schema_version"`
	Payload              json.RawMessage `json:"payload"`
	ServerReceivedAt     string          `json:"server_received_at"`
	ServerSeq            int64           `json:"server_seq"`
	RedactedAt           *string         `json:"redacted_at"`
	RedactedReason       *string         `json:"redacted_reason"`
	AuthorSeq            *int64          `json:"author_seq"`
	EventSigB64          *string         `json:"event_sig_b64"`
	SignerDevicePubkey   *string         `json:"signer_device_pubkey"`
	LocalTargetID        *string         `json:"local_target_id"`
	SignedActorAccountID *string         `json:"signed_actor_account_id"`
}

type nameFlag map[string]string

func (n nameFlag) String() string { return fmt.Sprint(map[string]string(n)) }
func (n nameFlag) Set(v string) error {
	i := strings.IndexByte(v, '=')
	if i <= 0 {
		return fmt.Errorf("want <vault_id>=<name>, got %q", v)
	}
	n[v[:i]] = v[i+1:]
	return nil
}

func main() {
	var (
		inPath   = flag.String("in", "", "path to events_recovered.jsonl (required)")
		outDir   = flag.String("out", ".", "directory for recovered-*.json / .csv outputs")
		owner    = flag.String("owner", "a98f0bc3-796e-4625-99ad-e8f7b1565ac1", "account id to stamp as vault.account_id in the synthesized snapshot header (the vaults row is gone; this is an INPUT, not a recovered fact)")
		currency = flag.String("currency", "AFN", "vault.currency for the synthesized snapshot header (the vaults row is gone; INPUT, not recovered)")
		onlyVlt  = flag.String("vault", "", "fold only this vault_id (default: every vault in the file)")
		names    = nameFlag{}
	)
	flag.Var(names, "vault-name", "<vault_id>=<name> for the synthesized snapshot header (repeatable). Unknown → placeholder.")
	flag.Parse()
	if *inPath == "" {
		fmt.Fprintln(os.Stderr, "-in is required")
		os.Exit(2)
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fail("mkdir out: %v", err)
	}

	rows, lineErrs := loadRows(*inPath)
	fmt.Printf("== input: %s\n   rows parsed: %d, unparseable lines: %d\n", *inPath, len(rows), lineErrs)

	deduped, dupReport := dedupe(rows)
	fmt.Printf("   distinct event_ids: %d (%d duplicate carvings collapsed)\n", len(deduped), len(rows)-len(deduped))
	for _, l := range dupReport {
		fmt.Println("   " + l)
	}

	byVault := map[string][]row{}
	for _, r := range deduped {
		byVault[r.VaultID] = append(byVault[r.VaultID], r)
	}
	vaultIDs := make([]string, 0, len(byVault))
	for v := range byVault {
		vaultIDs = append(vaultIDs, v)
	}
	// Biggest vault first — the two ledgers before the two foreign membership stubs.
	sort.Slice(vaultIDs, func(i, j int) bool {
		if len(byVault[vaultIDs[i]]) != len(byVault[vaultIDs[j]]) {
			return len(byVault[vaultIDs[i]]) > len(byVault[vaultIDs[j]])
		}
		return vaultIDs[i] < vaultIDs[j]
	})

	for _, vid := range vaultIDs {
		if *onlyVlt != "" && vid != *onlyVlt {
			continue
		}
		foldVault(vid, byVault[vid], *outDir, names[vid], *currency, *owner)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

func loadRows(path string) ([]row, int) {
	f, err := os.Open(path)
	if err != nil {
		fail("open %s: %v", path, err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	var rows []row
	bad := 0
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var r row
		if err := json.Unmarshal(line, &r); err != nil {
			bad++
			fmt.Fprintf(os.Stderr, "skip unparseable line: %v\n", err)
			continue
		}
		// payload may have been carved as an object OR as a JSON string
		// holding the object's text; normalize to the object bytes.
		r.Payload = normalizePayload(r.Payload)
		rows = append(rows, r)
	}
	if err := sc.Err(); err != nil {
		fail("read %s: %v", path, err)
	}
	return rows, bad
}

func normalizePayload(raw json.RawMessage) json.RawMessage {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return json.RawMessage("null")
	}
	if t[0] == '"' {
		var s string
		if err := json.Unmarshal(t, &s); err == nil && json.Valid([]byte(s)) {
			return json.RawMessage(s)
		}
	}
	return t
}

// dedupe collapses rows carved more than once (the heap held the pre- and
// post-binding-resolution versions of a few membership rows). Prefers the
// version with the most identity columns populated; everything else about
// such pairs is byte-identical (checked in the profiling pass).
func dedupe(rows []row) ([]row, []string) {
	best := map[string]row{}
	order := []string{}
	var report []string
	for _, r := range rows {
		cur, seen := best[r.EventID]
		if !seen {
			best[r.EventID] = r
			order = append(order, r.EventID)
			continue
		}
		if score(r) > score(cur) {
			best[r.EventID] = r
		}
		report = append(report, fmt.Sprintf("dup event_id %s (%s, vault %.8s, seq %d): kept the version with account_id=%s signer=%v",
			r.EventID, r.EventType, r.VaultID, r.ServerSeq, deref(best[r.EventID].AccountID), best[r.EventID].SignerDevicePubkey != nil))
	}
	out := make([]row, 0, len(order))
	for _, id := range order {
		out = append(out, best[id])
	}
	return out, report
}

func score(r row) int {
	s := 0
	if r.AccountID != nil {
		s++
	}
	if r.SignerDevicePubkey != nil {
		s++
	}
	if r.SignedActorAccountID != nil {
		s++
	}
	return s
}

func deref(p *string) string {
	if p == nil {
		return "<null>"
	}
	return *p
}

// ---------------------------------------------------------------------------
// row -> LedgerEvent / PulledEvent, exactly as the server's SQL shapes them
// ---------------------------------------------------------------------------

// toLedgerEvent mirrors loadVaultEvents (internal/sync/snapshot.go):
//
//	CASE WHEN NULLIF(event_sig_b64,'') IS NOT NULL THEN signed_actor_account_id ELSE account_id END
//	COALESCE(local_target_id, target_id::text)
//
// author_user_id_local_only never reaches the server, so it is "" here as it
// is for every event the server folds.
func toLedgerEvent(r row) sync.LedgerEvent {
	ev := sync.LedgerEvent{
		EventID:        r.EventID,
		EventType:      r.EventType,
		VaultID:        r.VaultID,
		RelationshipID: r.RelationshipID,
		HLC:            sync.HLC{PMS: r.HLCPhysicalMS, L: r.HLCLogical, DID: r.HLCDeviceID},
		DeviceID:       r.DeviceID,
		ActorAccountID: wireActor(r),
		PayloadSchema:  r.SchemaVersion,
		Payload:        r.Payload,
		ServerSeq:      r.ServerSeq,
	}
	if t := wireTarget(r); t != nil {
		ev.TargetID = *t
	}
	return ev
}

func wireActor(r row) *string {
	if r.EventSigB64 != nil && *r.EventSigB64 != "" {
		return r.SignedActorAccountID
	}
	return r.AccountID
}

func wireTarget(r row) *string {
	if r.LocalTargetID != nil {
		return r.LocalTargetID
	}
	return r.TargetID
}

// toPulledEvent mirrors scanPulledEvents (snapshot.go) — the wire shape of
// snapshot.events / membership_events / settlement_events and of /v1/sync/pull.
func toPulledEvent(r row) sync.PulledEvent {
	ev := sync.PulledEvent{
		EventID:            r.EventID,
		HLC:                sync.HLC{PMS: r.HLCPhysicalMS, L: r.HLCLogical, DID: r.HLCDeviceID},
		DeviceID:           r.DeviceID,
		AccountID:          wireActor(r),
		TargetID:           wireTarget(r),
		RelationshipID:     r.RelationshipID,
		EventType:          r.EventType,
		SchemaVersion:      r.SchemaVersion,
		Payload:            r.Payload,
		AuthorSeq:          r.AuthorSeq,
		EventSigB64:        r.EventSigB64,
		SignerDevicePubkey: r.SignerDevicePubkey,
		ServerSeq:          r.ServerSeq,
	}
	if t, err := time.Parse(time.RFC3339Nano, r.ServerReceivedAt); err == nil {
		ev.ServerReceivedAt = t.UTC().Format(time.RFC3339Nano)
	} else {
		ev.ServerReceivedAt = r.ServerReceivedAt
	}
	return ev
}

// ---------------------------------------------------------------------------
// per-vault fold
// ---------------------------------------------------------------------------

type diag struct {
	skippedByType map[string]int // from ApplyEventsOnto's "skipping event" log lines
	orphanByType  map[string]int // silently-ignored or dangling prerequisites (pre-checked)
	notes         []string
}

var skipLine = regexp.MustCompile(`projection: skipping event (\S+) \((\S+)\) in vault (\S+): (.*)$`)

func foldVault(vaultID string, rows []row, outDir, vaultName, currency, owner string) {
	short := vaultID[:8]
	fmt.Printf("\n==================== vault %s ====================\n", vaultID)

	// Exclude redacted rows the way every server read does (redacted_at IS NULL).
	live := make([]row, 0, len(rows))
	redacted := 0
	for _, r := range rows {
		if r.RedactedAt != nil {
			redacted++
			continue
		}
		live = append(live, r)
	}
	sort.Slice(live, func(i, j int) bool { return live[i].ServerSeq < live[j].ServerSeq }) // ORDER BY server_seq ASC
	var minSeq, maxSeq int64
	seqs := map[int64]bool{}
	for _, r := range live {
		seqs[r.ServerSeq] = true
		if minSeq == 0 || r.ServerSeq < minSeq {
			minSeq = r.ServerSeq
		}
		if r.ServerSeq > maxSeq {
			maxSeq = r.ServerSeq
		}
	}
	missing := 0
	for s := int64(1); s <= maxSeq; s++ {
		if !seqs[s] {
			missing++
		}
	}
	fmt.Printf("rows: %d live (%d redacted excluded); server_seq %d..%d, %d distinct, %d gaps in 1..%d\n",
		len(live), redacted, minSeq, maxSeq, len(seqs), missing, maxSeq)

	byType := map[string]int{}
	for _, r := range live {
		byType[r.EventType]++
	}
	fmt.Printf("event types: %s\n", fmtCounts(byType))

	// --- signatures: prove the carved rows are the original bytes -------------
	sigOK, sigBad, unsigned := 0, 0, 0
	signers := map[string]int{}
	var badSig []string
	for _, r := range live {
		if r.EventSigB64 == nil || *r.EventSigB64 == "" || r.SignerDevicePubkey == nil {
			unsigned++
			continue
		}
		signers[*r.SignerDevicePubkey]++
		env := canonevent.Envelope{
			VaultID: r.VaultID, EventID: r.EventID, EventType: r.EventType, SchemaVersion: r.SchemaVersion,
			HLCPhysicalMS: r.HLCPhysicalMS, HLCLogical: r.HLCLogical, HLCDeviceID: r.HLCDeviceID,
			ActorAccountID: r.SignedActorAccountID, TargetID: wireTarget(r), RelationshipID: r.RelationshipID,
			Payload: r.Payload,
		}
		ok, err := canonevent.Verify(env, *r.EventSigB64, *r.SignerDevicePubkey)
		if err == nil && ok {
			sigOK++
			continue
		}
		// Diagnose: was the live account_id (or null) the signed actor instead?
		env.ActorAccountID = r.AccountID
		if ok2, _ := canonevent.Verify(env, *r.EventSigB64, *r.SignerDevicePubkey); ok2 {
			sigOK++
			badSig = append(badSig, fmt.Sprintf("seq %d %s verifies only with actor=account_id (%s), not signed_actor_account_id", r.ServerSeq, r.EventType, deref(r.AccountID)))
			continue
		}
		env.ActorAccountID = nil
		if ok3, _ := canonevent.Verify(env, *r.EventSigB64, *r.SignerDevicePubkey); ok3 {
			sigOK++
			badSig = append(badSig, fmt.Sprintf("seq %d %s verifies only with actor=null", r.ServerSeq, r.EventType))
			continue
		}
		sigBad++
		badSig = append(badSig, fmt.Sprintf("seq %d %s %s: signature does NOT verify (%v)", r.ServerSeq, r.EventType, r.EventID, err))
	}
	fmt.Printf("signatures: %d verify (Ed25519 over canonicalSignableEvent with actor=signed_actor_account_id), %d FAIL, %d unsigned legacy rows; signer pubkeys: %s\n",
		sigOK, sigBad, unsigned, fmtCounts(signers))
	for _, l := range badSig {
		fmt.Println("   ! " + l)
	}
	anchor := majorityKey(signers)

	// --- the fold, through the server's own function --------------------------
	events := make([]sync.LedgerEvent, 0, len(live))
	for _, r := range live {
		events = append(events, toLedgerEvent(r))
	}

	var logBuf bytes.Buffer
	log.SetOutput(&logBuf)
	log.SetFlags(0)
	batch := sync.NewProjection()
	if err := sync.ApplyEventsOnto(&batch, events); err != nil {
		fail("ApplyEventsOnto: %v", err)
	}
	log.SetOutput(os.Stderr)
	d := &diag{skippedByType: map[string]int{}, orphanByType: map[string]int{}}
	for _, line := range strings.Split(logBuf.String(), "\n") {
		if m := skipLine.FindStringSubmatch(line); m != nil {
			d.skippedByType[m[2]]++
			d.notes = append(d.notes, fmt.Sprintf("server SKIPPED %s %s: %s", m[2], m[1], m[4]))
		}
	}

	// Same fold, one event at a time in the same HLC order, with a prerequisite
	// probe before each — to label the orphans the appliers swallow silently
	// (project.go returns nil for an amend/delete/rename/archive whose target is
	// missing, and happily creates an entry whose relationship never existed).
	sorted := make([]sync.LedgerEvent, len(events))
	copy(sorted, events)
	sort.SliceStable(sorted, func(i, j int) bool { return sync.CompareHLC(sorted[i].HLC, sorted[j].HLC) < 0 })
	incr := sync.NewProjection()
	orphanRels := map[string]int{} // relationship_id -> entries created on it with no person_added
	settledByRel := map[string][]int64{}
	settledOrphans := 0
	for i := range sorted {
		ev := &sorted[i]
		probe(&incr, ev, d, orphanRels, settledByRel, &settledOrphans)
		log.SetOutput(&bytes.Buffer{})
		_ = sync.ApplyEventsOnto(&incr, []sync.LedgerEvent{*ev})
		log.SetOutput(os.Stderr)
	}
	batchJSON, err := sync.ProjectionToJSON(batch)
	if err != nil {
		fail("ProjectionToJSON: %v", err)
	}
	incrJSON, _ := sync.ProjectionToJSON(incr)
	fmt.Printf("fold: batch (buildSnapshotInTx path) vs incremental re-fold identical: %v\n", bytes.Equal(batchJSON, incrJSON))
	fmt.Printf("fold: events the server's fold SKIPPED with an error, by type: %s\n", fmtCounts(d.skippedByType))
	fmt.Printf("fold: silently-ignored / dangling prerequisites, by kind: %s\n", fmtCounts(d.orphanByType))
	for _, n := range d.notes {
		fmt.Println("   - " + n)
	}

	// --- projection stats -------------------------------------------------------
	p := batch
	relsOfUser := map[string][]*sync.RelationshipProjection{}
	activeRels, archivedRels := 0, 0
	for _, r := range p.Relationships {
		relsOfUser[r.UserBID] = append(relsOfUser[r.UserBID], r)
		if r.ArchivedAt == nil {
			activeRels++
		} else {
			archivedRels++
		}
	}
	usersActive, usersArchived, usersNoRel := 0, 0, 0
	for id := range p.Users {
		rs := relsOfUser[id]
		switch {
		case len(rs) == 0:
			usersNoRel++
		case allArchived(rs):
			usersArchived++
		default:
			usersActive++
		}
	}
	liveEntries, deletedEntries, settledFlag := 0, 0, 0
	for _, e := range p.Entries {
		if e.IsDeleted {
			deletedEntries++
		} else {
			liveEntries++
		}
		if e.IsSettled {
			settledFlag++
		}
	}
	fmt.Printf("projection: users %d (%d with an active relationship, %d archived-only, %d without any relationship)\n", len(p.Users), usersActive, usersArchived, usersNoRel)
	fmt.Printf("projection: relationships %d (%d active, %d archived)\n", len(p.Relationships), activeRels, archivedRels)
	fmt.Printf("projection: entries %d (%d live, %d deleted/tombstoned, %d with is_settled flag [backfill only — entry_settled is a server no-op])\n", len(p.Entries), liveEntries, deletedEntries, settledFlag)
	if p.ShopProfile != nil {
		fmt.Printf("projection: shop_profile shop_name=%q owner_name=%q updated_at=%d\n", derefS(p.ShopProfile.ShopName), derefS(p.ShopProfile.OwnerName), p.ShopProfile.UpdatedAt)
	} else {
		fmt.Printf("projection: shop_profile = nil (no shop_profile_updated / rename survived → snapshot.shop_profile would be null)\n")
	}
	fmt.Printf("projection: vault_settings = %s\n", fmtMap(p.VaultSettings))
	if len(p.Members) == 0 {
		fmt.Printf("projection: members = {} (no vault_member_added survived for this vault)\n")
	} else {
		for _, m := range p.Members {
			removed := "null"
			if m.RemovedAt != nil {
				removed = fmt.Sprint(*m.RemovedAt)
			}
			fmt.Printf("projection: member %s role=%s added_at=%d removed_at=%s\n", m.AccountID, m.Role, m.AddedAt, removed)
		}
	}
	fmt.Printf("projection: entry_settled markers %d (%d on relationships with no person_added) — mobile-only settlements table; ride along as snapshot.settlement_events\n",
		byType[sync.EventEntrySettled], settledOrphans)

	// --- balances (what lib/money-sql.ts computes from the restored rows) ------
	bals := map[string]*bal{}
	for id, r := range p.Relationships {
		b := &bal{relID: id, userID: r.UserBID, archivedAt: r.ArchivedAt}
		if u, ok := p.Users[r.UserBID]; ok {
			b.name = u.DisplayName
			b.phone = derefS(u.PhoneE164)
		} else {
			b.name = "(users row missing)"
		}
		bals[id] = b
	}
	for rel := range orphanRels {
		if _, ok := bals[rel]; !ok {
			bals[rel] = &bal{relID: rel, name: "(person_added LOST — name unknown)", orphan: true}
		}
	}
	var badAmounts []string
	for _, e := range p.Entries {
		b, ok := bals[e.RelationshipID]
		if !ok {
			b = &bal{relID: e.RelationshipID, name: "(person_added LOST — name unknown)", orphan: true}
			bals[e.RelationshipID] = b
		}
		if e.IsDeleted {
			b.deletedN++
			continue
		}
		b.liveN++
		if e.CreatedAt > b.lastEntryAt {
			b.lastEntryAt = e.CreatedAt
		}
		m, err := minorUnits(e.AmountAFN)
		if err != nil {
			badAmounts = append(badAmounts, fmt.Sprintf("entry %s amount %q: %v", e.ID, e.AmountAFN, err))
			continue
		}
		switch e.Type {
		case "debt":
			b.minor += m
		case "payment":
			b.minor -= m
		default:
			badAmounts = append(badAmounts, fmt.Sprintf("entry %s has type %q", e.ID, e.Type))
		}
	}
	for _, b := range bals {
		if b.minor != 0 {
			continue
		}
		var maxSettled int64 = -1
		for _, s := range settledByRel[b.relID] {
			if s > maxSettled {
				maxSettled = s
			}
		}
		b.settled = maxSettled >= 0 && maxSettled >= b.lastEntryAt
	}
	for _, l := range badAmounts {
		fmt.Println("   ! " + l)
	}

	list := make([]*bal, 0, len(bals))
	for _, b := range bals {
		list = append(list, b)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].lastEntryAt != list[j].lastEntryAt {
			return list[i].lastEntryAt > list[j].lastEntryAt
		}
		return list[i].relID < list[j].relID
	})
	var collectMinor, payMinor int64
	homeRows, collectN, payN, zeroN, settledN := 0, 0, 0, 0, 0
	for _, b := range list {
		if b.archivedAt != nil || b.liveN == 0 {
			continue // home list: active people with ≥1 live tally (listAllPeople)
		}
		homeRows++
		switch {
		case b.minor > 0:
			collectN++
			collectMinor += b.minor
		case b.minor < 0:
			payN++
			payMinor += b.minor
		default:
			zeroN++
			if b.settled {
				settledN++
			}
		}
	}
	fmt.Printf("balances (mobile rule: Σ ±ROUND(amount×100) over deleted_at IS NULL, /100): home list would show %d people — %d to collect (total %s), %d to pay (total %s), %d at zero (%d deliberately settled)\n",
		homeRows, collectN, major(collectMinor), payN, major(payMinor), zeroN, settledN)
	fmt.Printf("balances: %d relationships total, %d of them orphans (entries but no person_added — %d live entries, names unknown)\n", len(list), len(orphanRels), orphanLiveEntries(list))
	fmt.Println("balances: top rows by last activity (full table in the CSV):")
	shown := 0
	for _, b := range list {
		if shown >= 12 {
			break
		}
		if b.liveN == 0 && !b.orphan {
			continue
		}
		flag := ""
		if b.archivedAt != nil {
			flag = " [archived]"
		}
		if b.orphan {
			flag += " [ORPHAN]"
		}
		fmt.Printf("   %-40s %-14s %12s  live=%d del=%d%s\n", clip(b.name, 40), b.phone, major(b.minor), b.liveN, b.deletedN, flag)
		shown++
	}

	// --- outputs ----------------------------------------------------------------
	projPath := filepath.Join(outDir, "recovered-projection-"+short+".json")
	if err := os.WriteFile(projPath, batchJSON, 0o644); err != nil {
		fail("write %s: %v", projPath, err)
	}
	fmt.Printf("wrote %s (%d bytes — the exact vault_snapshots.snapshot payload ProjectionToJSON would store)\n", projPath, len(batchJSON))

	csvPath := filepath.Join(outDir, "recovered-balances-"+short+".csv")
	cf, err := os.Create(csvPath)
	if err != nil {
		fail("create %s: %v", csvPath, err)
	}
	w := csv.NewWriter(cf)
	_ = w.Write([]string{"person_name", "phone_e164", "balance_major", "relationship_id", "user_id", "archived_at", "live_entries", "deleted_entries", "last_entry_at_ms", "deliberately_settled", "note"})
	for _, b := range list {
		note := ""
		if b.orphan {
			note = "person_added not recovered; entries only"
		}
		arch := ""
		if b.archivedAt != nil {
			arch = fmt.Sprint(*b.archivedAt)
		}
		_ = w.Write([]string{b.name, b.phone, major(b.minor), b.relID, b.userID, arch, fmt.Sprint(b.liveN), fmt.Sprint(b.deletedN), fmt.Sprint(b.lastEntryAt), fmt.Sprint(b.settled), note})
	}
	w.Flush()
	_ = cf.Close()
	fmt.Printf("wrote %s (%d rows)\n", csvPath, len(list))

	// --- the GET /v1/sync/snapshot body the server would serve ------------------
	// Everything the projection carries is exact. The vault header comes from the
	// deleted `vaults` row and is therefore INPUT (flags) — marked as such.
	if vaultName == "" {
		vaultName = "(vaults.name unknown — not in the recovered events)"
	}
	var createdAt int64
	for _, r := range live {
		if createdAt == 0 || r.HLCPhysicalMS < createdAt {
			createdAt = r.HLCPhysicalMS
		}
	}
	var trust *string
	if anchor != "" {
		a := anchor
		trust = &a
	}
	var membership, settlements []sync.PulledEvent
	hlcSorted := make([]row, len(live))
	copy(hlcSorted, live)
	sort.Slice(hlcSorted, func(i, j int) bool { // ORDER BY hlc_physical_ms, hlc_logical, hlc_device_id, event_id
		a, b := hlcSorted[i], hlcSorted[j]
		if a.HLCPhysicalMS != b.HLCPhysicalMS {
			return a.HLCPhysicalMS < b.HLCPhysicalMS
		}
		if a.HLCLogical != b.HLCLogical {
			return a.HLCLogical < b.HLCLogical
		}
		if a.HLCDeviceID != b.HLCDeviceID {
			return a.HLCDeviceID < b.HLCDeviceID
		}
		return a.EventID < b.EventID
	})
	for _, r := range hlcSorted {
		if sync.IsMembershipEventType(r.EventType) {
			membership = append(membership, toPulledEvent(r))
		}
		if r.EventType == sync.EventEntrySettled {
			settlements = append(settlements, toPulledEvent(r))
		}
	}
	if membership == nil {
		membership = []sync.PulledEvent{}
	}
	if settlements == nil {
		settlements = []sync.PulledEvent{}
	}
	ownerCopy := owner
	resp := sync.SnapshotResponse{
		VaultID:           vaultID,
		SnapshotServerSeq: maxSeq,
		GeneratedAtMS:     time.Now().UnixMilli(),
		SchemaVersion:     sync.SnapshotSchemaVersion,
		Vault: sync.SnapshotVault{
			ID: vaultID, Name: vaultName, Currency: currency,
			CreatedAt: createdAt, UpdatedAt: createdAt, IsDefault: 1,
			AccountID: &ownerCopy, VaultTrustAnchorPubkey: trust,
		},
		ShopProfile:      shopProfileRow(vaultID, p.ShopProfile),
		Users:            usersRows(p.Users),
		Relationships:    relationshipRows(p.Relationships),
		Entries:          entryRows(p.Entries),
		HLCLast:          maxHLC(&p),
		Events:           []sync.PulledEvent{}, // up_to = max seq → empty tail
		MembershipEvents: membership,
		SettlementEvents: settlements,
	}
	snapJSON, err := json.Marshal(resp)
	if err != nil {
		fail("marshal snapshot: %v", err)
	}
	snapPath := filepath.Join(outDir, "recovered-snapshot-"+short+".json")
	if err := os.WriteFile(snapPath, snapJSON, 0o644); err != nil {
		fail("write %s: %v", snapPath, err)
	}
	fmt.Printf("wrote %s (%d bytes — SnapshotResponse: %d users, %d relationships, %d entries, shop_profile=%v, %d membership_events, %d settlement_events, hlc_last=%+v; vault header name/currency/owner/anchor are INPUTS)\n",
		snapPath, len(snapJSON), len(resp.Users), len(resp.Relationships), len(resp.Entries), resp.ShopProfile != nil, len(membership), len(settlements), resp.HLCLast)

	// --- what the PHONE does with it (lib/restore.ts @628eed5, foreign_keys=ON) --
	fmt.Println("mobile restore check (restoreFromSnapshot @628eed5, PRAGMA foreign_keys=ON):")
	orphanEntries := 0
	for _, e := range p.Entries {
		if _, ok := p.Relationships[e.RelationshipID]; !ok {
			orphanEntries++
		}
	}
	if orphanEntries > 0 {
		fmt.Printf("   ! %d snapshot entries reference %d relationships that are NOT in snapshot.relationships → `INSERT OR REPLACE INTO entries` violates entries.relationship_id REFERENCES relationships(id) → the ONE restore transaction rolls back → vault %.8s restore FAILS unless those people are re-created first\n",
			orphanEntries, len(orphanRels), vaultID)
	} else {
		fmt.Println("   every entry's relationship is present — the snapshot seed would insert cleanly")
	}
	userless := 0
	for _, r := range p.Relationships {
		if _, ok := p.Users[r.UserBID]; !ok {
			userless++
		}
	}
	if userless > 0 {
		fmt.Printf("   ! %d relationships reference a users row that is not in snapshot.users (FK user_b_id)\n", userless)
	}
	fmt.Printf("   relationships.user_a_id is \"\" on every row (server never knows the self user) → remapped to the local self by restoreFromSnapshot; entries.proposed_by_user_id \"\" → NULL\n")
	fmt.Printf("   membership_events is empty → the phone's chain for this vault has no genesis; role/ownership for FUTURE writes must come from the server listing (reestablishOwnerIfConfirmed) or a new witnessed admission — outside this fold's scope\n")
}

// probe labels, BEFORE the event applies, the prerequisites project.go either
// silently ignores or does not check.
func probe(p *sync.Projection, ev *sync.LedgerEvent, d *diag, orphanRels map[string]int, settledByRel map[string][]int64, settledOrphans *int) {
	switch ev.EventType {
	case sync.EventEntryCreated:
		var pl struct {
			EntryID        string `json:"entry_id"`
			RelationshipID string `json:"relationship_id"`
		}
		if json.Unmarshal(ev.Payload, &pl) != nil {
			return
		}
		if _, ok := p.Relationships[pl.RelationshipID]; !ok {
			d.orphanByType["entry_created on relationship with no person_added (server still projects it; mobile FK fails)"]++
			orphanRels[pl.RelationshipID]++
		}
		if _, dup := p.Entries[pl.EntryID]; dup {
			d.orphanByType["entry_created for an entry_id that already exists (overwrite)"]++
		}
	case sync.EventEntryAmended, sync.EventEntryDeleted:
		e, ok := p.Entries[ev.TargetID]
		if !ok {
			d.orphanByType[ev.EventType+" whose target entry is missing (server: silent no-op; mobile: quarantined missing_prereq forever)"]++
			return
		}
		if e.IsDeleted && ev.EventType == sync.EventEntryAmended {
			d.orphanByType["entry_amended after entry_deleted (sticky tombstone, ignored on both sides)"]++
		}
	case sync.EventEntrySettled:
		var pl struct {
			SettledAtMS int64 `json:"settled_at_ms"`
		}
		_ = json.Unmarshal(ev.Payload, &pl)
		if ev.RelationshipID != nil {
			settledByRel[*ev.RelationshipID] = append(settledByRel[*ev.RelationshipID], pl.SettledAtMS)
			if _, ok := p.Relationships[*ev.RelationshipID]; !ok {
				*settledOrphans++
			}
		}
	case sync.EventPersonAdded:
		var pl struct {
			UserID string `json:"user_id"`
		}
		_ = json.Unmarshal(ev.Payload, &pl)
		if _, dup := p.Users[pl.UserID]; dup {
			d.orphanByType["person_added for a user_id that already exists (users row overwritten, relationship kept)"]++
		}
	case sync.EventPersonRenamed, sync.EventPersonPhoneChanged:
		if _, ok := p.Users[ev.TargetID]; !ok {
			d.orphanByType[ev.EventType+" whose target user is missing (server: silent no-op; mobile: quarantined missing_prereq forever)"]++
		}
	case sync.EventPersonArchived, sync.EventPersonUnarchived:
		if ev.RelationshipID == nil {
			return
		}
		if _, ok := p.Relationships[*ev.RelationshipID]; !ok {
			d.orphanByType[ev.EventType+" whose relationship is missing (server: silent no-op; mobile: quarantined missing_prereq forever)"]++
		}
	}
}

// ---------------------------------------------------------------------------
// SnapshotResponse row mapping — a transcription of the unexported
// projectUsers / projectRelationships / projectEntries / projectShopProfile /
// snapshotMaxHLC in internal/sync/snapshot.go (field copies + bool→int), with
// deterministic ordering by id where the server iterates a Go map.
// ---------------------------------------------------------------------------

func shopProfileRow(vaultID string, sp *sync.ShopProfileProjection) *sync.SnapshotShopProfile {
	if sp == nil {
		return nil
	}
	name := ""
	if sp.ShopName != nil {
		name = *sp.ShopName
	}
	return &sync.SnapshotShopProfile{VaultID: vaultID, OwnerName: sp.OwnerName, ShopName: name, CreatedAt: sp.UpdatedAt, UpdatedAt: sp.UpdatedAt}
}

func usersRows(in map[string]*sync.UserProjection) []sync.SnapshotUser {
	out := make([]sync.SnapshotUser, 0, len(in))
	for _, id := range sortedKeys(in) {
		u := in[id]
		out = append(out, sync.SnapshotUser{ID: u.ID, PhoneE164: u.PhoneE164, DisplayName: u.DisplayName, IsLocalSelf: b2i(u.IsLocalSelf), GoogleSub: u.GoogleSub, AccountID: u.AccountID, CreatedAt: u.CreatedAt, UpdatedAt: u.UpdatedAt, ArchivedAt: u.ArchivedAt})
	}
	return out
}

func relationshipRows(in map[string]*sync.RelationshipProjection) []sync.SnapshotRelationship {
	out := make([]sync.SnapshotRelationship, 0, len(in))
	for _, id := range sortedKeys(in) {
		r := in[id]
		out = append(out, sync.SnapshotRelationship{ID: r.ID, VaultID: r.VaultID, UserAID: r.UserAID, UserBID: r.UserBID, Context: r.Context, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, ArchivedAt: r.ArchivedAt})
	}
	return out
}

func entryRows(in map[string]*sync.EntryProjection) []sync.SnapshotEntry {
	out := make([]sync.SnapshotEntry, 0, len(in))
	for _, id := range sortedKeys(in) {
		e := in[id]
		var cur, prop *string
		if e.CurrentEventID != "" {
			c := e.CurrentEventID
			cur = &c
		}
		if e.ProposedByUserID != "" {
			pp := e.ProposedByUserID
			prop = &pp
		}
		out = append(out, sync.SnapshotEntry{ID: e.ID, VaultID: e.VaultID, RelationshipID: e.RelationshipID, Type: e.Type, AmountAFN: e.AmountAFN, Note: e.Note, CreatedAt: e.CreatedAt, UpdatedAt: e.UpdatedAt, DeletedAt: e.DeletedAt, ProposedByUserID: prop, CurrentEventID: cur, IsDeleted: b2i(e.IsDeleted), IsSettled: b2i(e.IsSettled), AcceptedAt: e.AcceptedAt, DisputedAt: e.DisputedAt, DisputedReason: e.DisputedReason, SettledAt: e.SettledAt})
	}
	return out
}

func maxHLC(p *sync.Projection) sync.HLC {
	max := sync.HLC{}
	for _, u := range p.Users {
		if u.UpdatedAt > max.PMS {
			max = sync.HLC{PMS: u.UpdatedAt}
		}
	}
	for _, r := range p.Relationships {
		if r.UpdatedAt > max.PMS {
			max = sync.HLC{PMS: r.UpdatedAt}
		}
	}
	for _, e := range p.Entries {
		if e.UpdatedAt > max.PMS {
			max = sync.HLC{PMS: e.UpdatedAt}
		}
	}
	return max
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// minorUnits is CAST(ROUND(amount_afn * 100) AS INTEGER) (lib/money-sql.ts):
// exact decimal arithmetic, half away from zero.
func minorUnits(n json.Number) (int64, error) {
	r, ok := new(big.Rat).SetString(string(n))
	if !ok {
		return 0, fmt.Errorf("not a number")
	}
	r.Mul(r, big.NewRat(100, 1))
	q, m := new(big.Int).QuoRem(r.Num(), r.Denom(), new(big.Int))
	twice := new(big.Int).Abs(new(big.Int).Mul(m, big.NewInt(2)))
	if twice.Cmp(r.Denom()) >= 0 {
		if r.Num().Sign() < 0 {
			q.Sub(q, big.NewInt(1))
		} else {
			q.Add(q, big.NewInt(1))
		}
	}
	if !q.IsInt64() {
		return 0, fmt.Errorf("overflow")
	}
	return q.Int64(), nil
}

func major(minor int64) string {
	sign := ""
	if minor < 0 {
		sign = "-"
		minor = -minor
	}
	if minor%100 == 0 {
		return fmt.Sprintf("%s%d", sign, minor/100)
	}
	return fmt.Sprintf("%s%d.%02d", sign, minor/100, minor%100)
}

// bal is one relationship's balance the way the phone computes it.
type bal struct {
	relID, userID, name, phone string
	archivedAt                 *int64
	minor                      int64
	liveN, deletedN            int
	lastEntryAt                int64
	settled                    bool
	orphan                     bool
}

func orphanLiveEntries(list []*bal) int {
	n := 0
	for _, b := range list {
		if b.orphan {
			n += b.liveN
		}
	}
	return n
}

func allArchived(rs []*sync.RelationshipProjection) bool {
	for _, r := range rs {
		if r.ArchivedAt == nil {
			return false
		}
	}
	return true
}

func majorityKey(m map[string]int) string {
	best, n := "", 0
	for k, v := range m {
		if v > n {
			best, n = k, v
		}
	}
	return best
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func fmtCounts(m map[string]int) string {
	if len(m) == 0 {
		return "{}"
	}
	ks := sortedKeys(m)
	parts := make([]string, 0, len(ks))
	for _, k := range ks {
		parts = append(parts, fmt.Sprintf("%s=%d", k, m[k]))
	}
	return strings.Join(parts, ", ")
}

func fmtMap(m map[string]string) string {
	if len(m) == 0 {
		return "{}"
	}
	ks := sortedKeys(m)
	parts := make([]string, 0, len(ks))
	for _, k := range ks {
		parts = append(parts, fmt.Sprintf("%s=%q", k, m[k]))
	}
	return strings.Join(parts, ", ")
}

func derefS(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
