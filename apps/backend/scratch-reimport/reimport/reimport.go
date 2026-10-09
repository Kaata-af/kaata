// Package reimport is the SCRATCH rehearsal for the 2026-10-07 support
// incident (apps/backend/scratch-reimport, never shipped): it turns the
// forensically carved events rows of the shopkeeper's two deleted vaults into
// one production SQL transaction (plus a rollback script) and proves that
// transaction against the real backend code on a throwaway Postgres.
//
// The carve is INCOMPLETE (~26% of main rows lost in the heap gaps), so the
// carved rows alone fold to wrong balances and leave orphan relationships. A
// COMPLETE pre-deletion projection of each vault was since decoded from the
// write-ahead log (the ORACLE). This generator keeps every surviving signed
// row verbatim as evidence AND emits the minimal set of UNSIGNED
// reconstruction events that make the folded projection equal the oracle
// exactly — enforced by a hard equality gate that aborts generation on any
// residual difference.
//
// What the SQL does, in one transaction:
//
//  1. INSERT the two vaults rows under the NEW owner account, anchored on the
//     ORIGINAL device key K1 (vault_trust_anchor_pubkey). K1 is the key that
//     signed every recovered row; the mobile role gate's "anchor restore
//     carve-out" authenticates non-membership events signed by the pinned
//     anchor, so the history applies on the phone WITHOUT a membership chain.
//  2. INSERT the owner vault_members rows (what POST /v1/vaults seeds), plus —
//     only with -include-viewer — the oracle's non-owner member seats.
//  3. DISABLE the migration-050 BEFORE INSERT trigger for the duration of the
//     transaction and INSERT the recovered events rows VERBATIM — original
//     server_seq (gaps kept), hlc, author_seq, signatures and, crucially,
//     signed_actor_account_id = the actor the signature was computed over
//     (the DELETED account id, or NULL for pre-binding rows). events.account_id
//     (a live FK) is written NULL — the deletion path's own representation of
//     "author account gone".
//  4. INSERT the UNSIGNED reconstruction rows (account_id NULL, no signature)
//     that close the carve→oracle diff: person_added for lost persons,
//     person_renamed / person_phone_changed / person_archived, entry_created /
//     entry_amended / entry_deleted, and the shop name. They go in the carve's
//     server_seq gaps (then the headroom below the cursor); one final no-op
//     margin row sits at the snapshot cursor so pushes resume above it.
//  5. INSERT a vault_snapshots row built by the SAME projection code the
//     snapshot cron uses (internal/sync ApplyEventsOnto + ProjectionToJSON)
//     over EVERY row, so the phone restores through restoreFromSnapshot and
//     sets its pull cursor past the history. Snapshot and events always agree,
//     now and after any cron rebuild.
package reimport

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/sync"
	"github.com/matee/kaata-backend/scratch-reimport/canonevent"
)

// reimportNS is the uuid5 namespace stem for every synthesized event/row id.
const reimportNS = "kaata-reimport-2026-10-07"

// Row is one carved events row (keys = column names, as events_recovered.jsonl
// serialises them).
type Row struct {
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

	// Repair bookkeeping (not from the file).
	Synthetic   bool   `json:"-"`
	RepairNotes string `json:"-"`
}

// VaultSpec is what the operator must supply per vault.
type VaultSpec struct {
	ID       string
	Name     string // defaults to the oracle vault name when empty
	Currency string
	// Oracle is the decoded COMPLETE pre-deletion projection for this vault
	// (a vault_snapshots.snapshot payload). The reconstruction diffs against it
	// and the equality gate asserts against it.
	Oracle *Oracle
	// UpTo is the snapshot cursor to land on (a safety margin above any
	// server_seq a pre-deletion device could have consumed). The final no-op
	// margin row sits here and max(server_seq) == UpTo after the import.
	UpTo int64
}

// Options drive BuildPlan.
type Options struct {
	OwnerAccountID   string
	DeletedAccountID string
	PhoneInstallID   string
	// AnchorPubB64 is K1, std base64 — the signer of every recovered row.
	AnchorPubB64 string
	Vaults       []VaultSpec
	// ReimportDeviceID is the hlc_device_id/device_id stamped on synthetic rows.
	ReimportDeviceID string
	// IncludeViewer, when true, emits a vault_members seat for each non-owner
	// member in the oracle (the MAIN vault's viewer). Default off: that member's
	// app loses the kaata at next sync (Matee's decision).
	IncludeViewer bool
	// Now is the server_received_at stamped on synthetic rows.
	Now time.Time
}

// ViewerSeat is a non-owner oracle member rendered (optionally) as a
// vault_members row.
type ViewerSeat struct {
	AccountID string
	Role      string
	AddedAtMS int64
}

// VaultPlan is the per-vault output of BuildPlan.
type VaultPlan struct {
	Spec VaultSpec
	Rows []Row // recovered rows, repaired, sorted by server_seq
	// Reconstruction holds the UNSIGNED rows that close the carve→oracle diff,
	// ending with the no-op margin row at UpTo. Rendered after Rows.
	Reconstruction []Row
	Viewers        []ViewerSeat
	MinHLC, MaxHLC int64
	// UpTo is the vault_snapshots.up_to_server_seq (= max server_seq, the margin).
	UpTo         int64
	SnapshotJSON []byte
	Stats        VaultStats
}

type VaultStats struct {
	Rows             int
	Signed           int
	SignedVerified   int
	Unsigned         int // signature lost in the carve — delivered unsigned
	PubkeyFilled     int // signature present, signer column lost → filled with K1 and verified
	SignedActorFixed int // signature present, evidence column lost → restored from account_id and verified
	ByType           map[string]int
	// Reconstruction bookkeeping.
	Reconstructed int
	ReconByType   map[string]int
}

type Plan struct {
	Options Options
	Vaults  []*VaultPlan
}

// ---------------------------------------------------------------------------
// Oracle (the decoded complete pre-deletion projection)
// ---------------------------------------------------------------------------

// Oracle mirrors a vault_snapshots.snapshot payload. ms timestamps and the
// amount arrive as JSON strings in the decoded file; kept raw and normalized
// on use.
type Oracle struct {
	Users         map[string]OracleUser  `json:"users"`
	Relationships map[string]OracleRel   `json:"relationships"`
	Entries       map[string]OracleEntry `json:"entries"`
	ShopProfile   *OracleShop            `json:"shop_profile"`
	VaultSettings map[string]string      `json:"vault_settings"`
	Members       map[string]OracleMember `json:"members"`
}

type OracleUser struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"display_name"`
	PhoneE164   *string `json:"phone_e164"`
	ArchivedAt  *string `json:"archived_at"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
	IsLocalSelf bool    `json:"is_local_self"`
}

type OracleRel struct {
	ID         string  `json:"id"`
	UserBID    string  `json:"user_b_id"`
	ArchivedAt *string `json:"archived_at"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

type OracleEntry struct {
	ID             string          `json:"id"`
	RelationshipID string          `json:"relationship_id"`
	Type           string          `json:"type"`
	AmountAFN      json.RawMessage `json:"amount_afn"`
	Note           *string         `json:"note"`
	IsDeleted      bool            `json:"is_deleted"`
	CreatedAt      string          `json:"created_at"`
	UpdatedAt      string          `json:"updated_at"`
	DeletedAt      *string         `json:"deleted_at"`
}

type OracleShop struct {
	ShopName  *string         `json:"shop_name"`
	OwnerName *string         `json:"owner_name"`
	UpdatedAt json.RawMessage `json:"updated_at"`
}

type OracleMember struct {
	Role      string          `json:"role"`
	AccountID string          `json:"account_id"`
	AddedAt   json.RawMessage `json:"added_at"`
	RemovedAt *string         `json:"removed_at"`
}

// LoadOracle reads a decoded vault_snapshots.snapshot payload.
func LoadOracle(path string) (*Oracle, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var o Oracle
	if err := json.Unmarshal(b, &o); err != nil {
		return nil, fmt.Errorf("decode oracle %s: %w", path, err)
	}
	if len(o.Users) == 0 || len(o.Entries) == 0 {
		return nil, fmt.Errorf("oracle %s looks empty (users=%d entries=%d)", path, len(o.Users), len(o.Entries))
	}
	return &o, nil
}

// VaultName returns the oracle's user-perceived vault name: vault_settings.name
// if present, else shop_profile.shop_name.
func (o *Oracle) VaultName() string {
	if n, ok := o.VaultSettings["name"]; ok && n != "" {
		return n
	}
	if o.ShopProfile != nil && o.ShopProfile.ShopName != nil {
		return *o.ShopProfile.ShopName
	}
	return ""
}

// LoadJSONL reads events_recovered.jsonl.
func LoadJSONL(path string) ([]Row, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	var out []Row
	line := 0
	for sc.Scan() {
		line++
		b := sc.Bytes()
		if len(strings.TrimSpace(string(b))) == 0 {
			continue
		}
		var r Row
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		// Payload may have been serialised as a JSON string holding JSON.
		if len(r.Payload) > 0 && r.Payload[0] == '"' {
			var s string
			if err := json.Unmarshal(r.Payload, &s); err == nil {
				r.Payload = json.RawMessage(s)
			}
		}
		out = append(out, r)
	}
	return out, sc.Err()
}

// BuildPlan filters, dedupes, repairs, verifies, reconstructs and projects.
func BuildPlan(all []Row, opts Options) (*Plan, error) {
	if _, err := uuid.Parse(opts.OwnerAccountID); err != nil {
		return nil, fmt.Errorf("owner account id: %w", err)
	}
	anchorRaw, err := base64.StdEncoding.DecodeString(opts.AnchorPubB64)
	if err != nil || len(anchorRaw) != 32 {
		return nil, errors.New("anchor pubkey must be std base64 of 32 bytes")
	}
	if _, err := uuid.Parse(opts.ReimportDeviceID); err != nil {
		return nil, fmt.Errorf("reimport device id: %w", err)
	}
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	plan := &Plan{Options: opts}
	for _, spec := range opts.Vaults {
		if _, err := uuid.Parse(spec.ID); err != nil {
			return nil, fmt.Errorf("vault id %q: %w", spec.ID, err)
		}
		if spec.Oracle == nil {
			return nil, fmt.Errorf("vault %s: oracle snapshot is required", spec.ID)
		}
		if strings.TrimSpace(spec.Name) == "" {
			spec.Name = spec.Oracle.VaultName()
		}
		if strings.TrimSpace(spec.Name) == "" {
			return nil, fmt.Errorf("vault %s: name is required (vaults.name is NOT NULL) and the oracle carries none", spec.ID)
		}
		if spec.Currency == "" {
			spec.Currency = "AFN"
		}
		if spec.UpTo == 0 {
			return nil, fmt.Errorf("vault %s: UpTo (snapshot cursor) is required", spec.ID)
		}
		vp, err := buildVault(all, spec, opts)
		if err != nil {
			return nil, fmt.Errorf("vault %s: %w", spec.ID, err)
		}
		plan.Vaults = append(plan.Vaults, vp)
	}
	return plan, nil
}

func buildVault(all []Row, spec VaultSpec, opts Options) (*VaultPlan, error) {
	vp := &VaultPlan{Spec: spec, Stats: VaultStats{ByType: map[string]int{}, ReconByType: map[string]int{}}}

	// Filter + dedupe by event_id. The carve can hold several tuple versions
	// of one row (a pre- and a post-deletion-detach version); prefer the one
	// with the most evidence columns populated.
	byID := map[string]Row{}
	for _, r := range all {
		if r.VaultID != spec.ID {
			continue
		}
		if r.RedactedAt != nil {
			continue
		}
		if prev, ok := byID[r.EventID]; ok {
			if score(r) <= score(prev) {
				continue
			}
		}
		byID[r.EventID] = r
	}
	rows := make([]Row, 0, len(byID))
	for _, r := range byID {
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ServerSeq < rows[j].ServerSeq })
	if len(rows) == 0 {
		return nil, errors.New("no rows")
	}
	seqs := map[int64]bool{}
	for i := range rows {
		r := &rows[i]
		if seqs[r.ServerSeq] {
			return nil, fmt.Errorf("duplicate server_seq %d", r.ServerSeq)
		}
		seqs[r.ServerSeq] = true
		if r.DeviceID != r.HLCDeviceID {
			return nil, fmt.Errorf("event %s: device_id != hlc_device_id", r.EventID)
		}
		if r.LocalTargetID != nil {
			return nil, fmt.Errorf("event %s: unexpected local_target_id", r.EventID)
		}
		if len(r.Payload) == 0 {
			return nil, fmt.Errorf("event %s: empty payload", r.EventID)
		}
		vp.Stats.ByType[r.EventType]++
		if i == 0 || r.HLCPhysicalMS < vp.MinHLC {
			vp.MinHLC = r.HLCPhysicalMS
		}
		if r.HLCPhysicalMS > vp.MaxHLC {
			vp.MaxHLC = r.HLCPhysicalMS
		}

		// ---- repair the carve damage (trailing columns lost) ----
		if r.EventSigB64 == nil || *r.EventSigB64 == "" {
			// Signature lost: deliver as a legacy unsigned row. Its evidence
			// column must be NULL too (the trigger rule: unsigned → NULL).
			r.EventSigB64 = nil
			r.SignerDevicePubkey = nil
			r.SignedActorAccountID = nil
			r.RepairNotes = "signature lost in carve; delivered unsigned"
			vp.Stats.Unsigned++
			continue
		}
		vp.Stats.Signed++
		if r.SignerDevicePubkey == nil || *r.SignerDevicePubkey == "" {
			k := opts.AnchorPubB64
			r.SignerDevicePubkey = &k
			r.RepairNotes = "signer column lost; filled with K1 and verified"
			vp.Stats.PubkeyFilled++
		}
		if *r.SignerDevicePubkey != opts.AnchorPubB64 {
			return nil, fmt.Errorf("event %s: signer %s is not K1", r.EventID, *r.SignerDevicePubkey)
		}
		if r.SignedActorAccountID == nil && r.AccountID != nil {
			// Migration 050's own backfill rule: signed rows carried
			// signed_actor_account_id = account_id. The carve lost the
			// trailing evidence column on a handful of rows.
			a := *r.AccountID
			r.SignedActorAccountID = &a
			r.RepairNotes = "evidence column lost; restored from account_id and verified"
			vp.Stats.SignedActorFixed++
		}
		ok, err := canonevent.Verify(envelopeOf(*r), *r.EventSigB64, *r.SignerDevicePubkey)
		if err != nil {
			return nil, fmt.Errorf("event %s: verify: %w", r.EventID, err)
		}
		if !ok {
			return nil, fmt.Errorf("event %s (seq %d, %s): signature does NOT verify over actor %v", r.EventID, r.ServerSeq, r.EventType, deref(r.SignedActorAccountID))
		}
		vp.Stats.SignedVerified++
	}
	vp.Stats.Rows = len(rows)
	vp.Rows = rows

	// ---- carve projection: fold the surviving rows exactly as the server does ----
	carveProj := sync.NewProjection()
	if err := sync.ApplyEventsOnto(&carveProj, ledgerEventsOf(rows)); err != nil {
		return nil, fmt.Errorf("fold carve: %w", err)
	}

	// ---- reconstruct the carve→oracle diff as UNSIGNED events ----
	recon, err := reconstruct(&carveProj, spec.Oracle, spec.ID, opts)
	if err != nil {
		return nil, err
	}

	// Fold the reconstruction HLCs into the vault's Min/Max BEFORE the margin.
	// The margin then sits AT MaxHLC: it is a projection no-op, and the
	// snapshot's hlc_last is derived from the projection's updated_at fields
	// (snapshot.go snapshotMaxHLC), so a margin HLC above MaxHLC would never be
	// reflected there and would only desync the two.
	for _, r := range recon {
		if r.HLCPhysicalMS < vp.MinHLC {
			vp.MinHLC = r.HLCPhysicalMS
		}
		if r.HLCPhysicalMS > vp.MaxHLC {
			vp.MaxHLC = r.HLCPhysicalMS
		}
	}

	// ---- assign server_seqs: carve gaps first, then the headroom below UpTo,
	// then the final no-op margin AT UpTo so pushes resume above it ----
	if err := assignServerSeqs(recon, rows, spec.UpTo); err != nil {
		return nil, err
	}
	marginRow, err := buildMarginRow(spec.Oracle, spec.ID, spec.UpTo, vp.MaxHLC, opts)
	if err != nil {
		return nil, err
	}
	recon = append(recon, marginRow)
	vp.Reconstruction = recon
	vp.UpTo = spec.UpTo
	for _, r := range recon {
		vp.Stats.Reconstructed++
		vp.Stats.ReconByType[r.EventType]++
	}

	// ---- final projection over EVERY row, exactly as the snapshot cron folds ----
	finalProj := sync.NewProjection()
	if err := sync.ApplyEventsOnto(&finalProj, ledgerEventsOf(append(append([]Row{}, rows...), recon...))); err != nil {
		return nil, fmt.Errorf("fold final: %w", err)
	}

	// ---- HARD EQUALITY GATE: the fold must equal the oracle on every field
	// that matters, or the whole generation aborts ----
	if err := gateProjectionEqualsOracle(finalProj, spec.Oracle, spec.ID); err != nil {
		return nil, err
	}

	out, err := sync.ProjectionToJSON(finalProj)
	if err != nil {
		return nil, fmt.Errorf("serialize projection: %w", err)
	}
	vp.SnapshotJSON = out

	// ---- optional non-owner member seats from the oracle ----
	if opts.IncludeViewer {
		for _, acct := range sortedKeys(spec.Oracle.Members) {
			m := spec.Oracle.Members[acct]
			if m.Role == "owner" || acct == opts.OwnerAccountID || m.RemovedAt != nil {
				continue
			}
			vp.Viewers = append(vp.Viewers, ViewerSeat{AccountID: m.AccountID, Role: m.Role, AddedAtMS: parseMS(m.AddedAt)})
		}
	}
	return vp, nil
}

// reconstruct emits the minimal UNSIGNED event set that turns the carve
// projection into the oracle. Deterministic (sorted keys, uuid5 ids).
func reconstruct(carve *sync.Projection, o *Oracle, vaultID string, opts Options) ([]Row, error) {
	var rec []Row
	mk := func(eventType, target string, rel *string, payload any, pms int64, idKey string) Row {
		pl, _ := json.Marshal(payload)
		eid := uuid.NewSHA1(uuid.NameSpaceURL, []byte(reimportNS+"/"+eventType+"/"+vaultID+"/"+idKey)).String()
		var tgt *string
		if target != "" {
			t := target
			tgt = &t
		}
		return Row{
			EventID:          eid,
			VaultID:          vaultID,
			HLCPhysicalMS:    pms,
			HLCLogical:       0,
			HLCDeviceID:      opts.ReimportDeviceID,
			DeviceID:         opts.ReimportDeviceID,
			AccountID:        nil,
			TargetID:         tgt,
			RelationshipID:   rel,
			EventType:        eventType,
			SchemaVersion:    1,
			Payload:          pl,
			ServerReceivedAt: opts.Now.UTC().Format(time.RFC3339Nano),
			Synthetic:        true,
			RepairNotes:      "reconstruction from oracle",
		}
	}

	// user_b_id → relationship id (the oracle is 1:1; validated below).
	userRel := map[string]string{}
	for rid, r := range o.Relationships {
		if prev, dup := userRel[r.UserBID]; dup {
			return nil, fmt.Errorf("oracle has >1 relationship for user %s (%s, %s); reconstruction assumes 1:1", r.UserBID, prev, rid)
		}
		userRel[r.UserBID] = rid
	}

	// 1. person_added for users missing from the carve (creates user + its rel).
	for _, uid := range sortedKeys(o.Users) {
		if _, ok := carve.Users[uid]; ok {
			continue
		}
		ou := o.Users[uid]
		if ou.IsLocalSelf {
			return nil, fmt.Errorf("oracle user %s is is_local_self; never synthesize the local self", uid)
		}
		relID, ok := userRel[uid]
		if !ok {
			return nil, fmt.Errorf("oracle user %s has no relationship; cannot place person_added", uid)
		}
		rel := relID
		rec = append(rec, mk("person_added", uid, &rel, map[string]any{
			"user_id":              uid,
			"name":                 ou.DisplayName,
			"phone_e164":           phoneAny(ou.PhoneE164),
			"relationship_context": "peer",
		}, parseStrMS(ou.CreatedAt), uid))
	}

	// 2. person_renamed for present users whose display_name differs.
	for _, uid := range sortedKeys(o.Users) {
		cu, ok := carve.Users[uid]
		if !ok {
			continue
		}
		ou := o.Users[uid]
		if cu.DisplayName != ou.DisplayName {
			rec = append(rec, mk("person_renamed", uid, nil, map[string]any{"name": ou.DisplayName}, parseStrMS(ou.UpdatedAt), uid))
		}
	}

	// 3. person_phone_changed for present users whose phone differs.
	for _, uid := range sortedKeys(o.Users) {
		cu, ok := carve.Users[uid]
		if !ok {
			continue
		}
		ou := o.Users[uid]
		if !samePtr(cu.PhoneE164, ou.PhoneE164) {
			rec = append(rec, mk("person_phone_changed", uid, nil, map[string]any{"phone_e164": phoneAny(ou.PhoneE164)}, parseStrMS(ou.UpdatedAt), uid))
		}
	}

	// 4. person_archived for rels archived in the oracle but not in the carve.
	// Real client convention (verified in persons.ts@628eed5 and project.go):
	// target_id = the USER id, relationship_id (envelope) = the relationship.
	for _, rid := range sortedKeys(o.Relationships) {
		orl := o.Relationships[rid]
		if orl.ArchivedAt == nil {
			continue
		}
		if cr, ok := carve.Relationships[rid]; ok && cr.ArchivedAt != nil {
			continue
		}
		rel := rid
		rec = append(rec, mk("person_archived", orl.UserBID, &rel, map[string]any{}, parseStrMS(*orl.ArchivedAt), rid))
	}

	// 5. entry_created for entries missing from the carve.
	for _, eid := range sortedKeys(o.Entries) {
		if _, ok := carve.Entries[eid]; ok {
			continue
		}
		oe := o.Entries[eid]
		amt, err := amountNumber(oe.AmountAFN)
		if err != nil {
			return nil, fmt.Errorf("entry %s: %w", eid, err)
		}
		rel := oe.RelationshipID
		rec = append(rec, mk("entry_created", eid, &rel, map[string]any{
			"entry_id":       eid,
			"relationship_id": rel,
			"type":           oe.Type,
			"amount_afn":     amt,
			"note":           notEmptyPtr(oe.Note),
			"occurred_at_ms": parseStrMS(oe.CreatedAt),
		}, parseStrMS(oe.CreatedAt), eid))
	}

	// 6. entry_amended for present entries whose amount differs.
	for _, eid := range sortedKeys(o.Entries) {
		ce, ok := carve.Entries[eid]
		if !ok {
			continue
		}
		oe := o.Entries[eid]
		if normNum(ce.AmountAFN.String()) != normNumRaw(oe.AmountAFN) {
			amt, err := amountNumber(oe.AmountAFN)
			if err != nil {
				return nil, fmt.Errorf("entry %s: %w", eid, err)
			}
			rel := oe.RelationshipID
			rec = append(rec, mk("entry_amended", eid, &rel, map[string]any{
				"changes": map[string]any{"amount_afn": amt},
			}, parseStrMS(oe.UpdatedAt), eid))
		}
	}

	// 7. entry_deleted for entries deleted in the oracle but not in the carve.
	for _, eid := range sortedKeys(o.Entries) {
		oe := o.Entries[eid]
		if !oe.IsDeleted {
			continue
		}
		if ce, ok := carve.Entries[eid]; ok && ce.IsDeleted {
			continue
		}
		when := oe.UpdatedAt
		if oe.DeletedAt != nil && *oe.DeletedAt != "" {
			when = *oe.DeletedAt
		}
		rel := oe.RelationshipID
		rec = append(rec, mk("entry_deleted", eid, &rel, map[string]any{}, parseStrMS(when), eid))
	}

	// 8. shop name + vault name. Emit shop_profile_updated FIRST so the
	// vault_setting_set name-mirror has a profile to write onto (order also
	// deterministic in the fold's stable sort at equal HLC).
	shopMS := parseMS(nil)
	if o.ShopProfile != nil {
		shopMS = parseMS(o.ShopProfile.UpdatedAt)
	}
	if o.ShopProfile != nil && o.ShopProfile.ShopName != nil {
		need := carve.ShopProfile == nil || carve.ShopProfile.ShopName == nil || *carve.ShopProfile.ShopName != *o.ShopProfile.ShopName
		if carve.ShopProfile != nil && !samePtr(carve.ShopProfile.OwnerName, o.ShopProfile.OwnerName) {
			need = true
		}
		if need {
			changes := map[string]any{"shop_name": *o.ShopProfile.ShopName}
			if o.ShopProfile.OwnerName != nil {
				changes["owner_name"] = *o.ShopProfile.OwnerName
			}
			rec = append(rec, mk("shop_profile_updated", vaultID, nil, map[string]any{"changes": changes}, shopMS, "shopprofile"))
		}
	}
	if name, ok := o.VaultSettings["name"]; ok && name != "" {
		if carve.VaultSettings["name"] != name {
			rec = append(rec, mk("vault_setting_set", vaultID, nil, map[string]any{"key": "name", "value": name}, shopMS, "name"))
		}
	}
	return rec, nil
}

// assignServerSeqs fills the carved server_seq gaps (ascending) and then the
// headroom below upTo, in a deterministic reconstruction order, keeping every
// (vault, server_seq) unique and strictly below the margin at upTo.
func assignServerSeqs(recon []Row, carved []Row, upTo int64) error {
	used := map[int64]bool{}
	var maxSeq int64
	for _, r := range carved {
		used[r.ServerSeq] = true
		if r.ServerSeq > maxSeq {
			maxSeq = r.ServerSeq
		}
	}
	// Free slots: gaps in [1, maxSeq], then the headroom (maxSeq, upTo).
	var free []int64
	for s := int64(1); s <= maxSeq; s++ {
		if !used[s] {
			free = append(free, s)
		}
	}
	for s := maxSeq + 1; s < upTo; s++ {
		free = append(free, s)
	}
	if len(recon) > len(free) {
		return fmt.Errorf("reconstruction needs %d server_seq slots below the cursor %d, only %d free (raise UpTo)", len(recon), upTo, len(free))
	}
	// Deterministic order: by (hlc_physical_ms, event_id), assigned to free
	// slots ascending so pull order roughly tracks time.
	order := make([]int, len(recon))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		ra, rb := recon[order[a]], recon[order[b]]
		if ra.HLCPhysicalMS != rb.HLCPhysicalMS {
			return ra.HLCPhysicalMS < rb.HLCPhysicalMS
		}
		return ra.EventID < rb.EventID
	})
	for i, idx := range order {
		recon[idx].ServerSeq = free[i]
	}
	return nil
}

// buildMarginRow is the final no-op row at upTo. An entry_amended with empty
// changes on an existing entry folds to a strict no-op (Go: wrote=false;
// mobile: the entry is found and nothing changes) and is served in neither the
// membership chain nor the settlement bundle nor the post-cursor tail.
func buildMarginRow(o *Oracle, vaultID string, upTo, maxHLC int64, opts Options) (Row, error) {
	// A deterministic existing entry id (smallest) so the no-op has a real
	// target on both server and phone.
	ids := sortedKeys(o.Entries)
	if len(ids) == 0 {
		return Row{}, fmt.Errorf("vault %s: oracle has no entries to anchor the margin row", vaultID)
	}
	entryID := ids[0]
	rel := o.Entries[entryID].RelationshipID
	pl, _ := json.Marshal(map[string]any{"changes": map[string]any{}})
	eid := uuid.NewSHA1(uuid.NameSpaceURL, []byte(reimportNS+"/margin/"+vaultID)).String()
	target := entryID
	return Row{
		EventID:          eid,
		VaultID:          vaultID,
		// At MaxHLC, not above it: the margin is a projection no-op and
		// hlc_last is projection-derived (see buildVault).
		HLCPhysicalMS:    maxHLC,
		HLCLogical:       0,
		HLCDeviceID:      opts.ReimportDeviceID,
		DeviceID:         opts.ReimportDeviceID,
		AccountID:        nil,
		TargetID:         &target,
		RelationshipID:   &rel,
		EventType:        "entry_amended",
		SchemaVersion:    1,
		Payload:          pl,
		ServerReceivedAt: opts.Now.UTC().Format(time.RFC3339Nano),
		ServerSeq:        upTo,
		Synthetic:        true,
		RepairNotes:      "no-op margin: parks the snapshot cursor above any pre-deletion seq",
	}, nil
}

// gateProjectionEqualsOracle is the correctness guarantee: the folded
// projection must equal the oracle on users (display_name, phone, archived
// present/absent), relationships (user_b_id, archived present/absent), entries
// (relationship_id, type, amount, note, is_deleted) and the shop/vault name.
// Any residual difference aborts generation.
func gateProjectionEqualsOracle(p sync.Projection, o *Oracle, vaultID string) error {
	var diffs []string
	add := func(f string, a ...any) {
		if len(diffs) < 40 {
			diffs = append(diffs, fmt.Sprintf(f, a...))
		}
	}

	// Users: set equality (ignoring is_local_self, of which the oracle has none).
	oracleUsers := map[string]bool{}
	for id, u := range o.Users {
		if u.IsLocalSelf {
			continue
		}
		oracleUsers[id] = true
	}
	for id := range p.Users {
		if !oracleUsers[id] {
			add("user %s in fold but not in oracle", id)
		}
	}
	for id := range oracleUsers {
		fu, ok := p.Users[id]
		if !ok {
			add("user %s in oracle but not in fold", id)
			continue
		}
		ou := o.Users[id]
		if fu.DisplayName != ou.DisplayName {
			add("user %s display_name fold=%q oracle=%q", id, fu.DisplayName, ou.DisplayName)
		}
		if !samePtr(fu.PhoneE164, ou.PhoneE164) {
			add("user %s phone_e164 fold=%v oracle=%v", id, deref(fu.PhoneE164), deref(ou.PhoneE164))
		}
		if (fu.ArchivedAt != nil) != (ou.ArchivedAt != nil) {
			add("user %s archived present fold=%v oracle=%v", id, fu.ArchivedAt != nil, ou.ArchivedAt != nil)
		}
	}

	// Relationships.
	for id := range p.Relationships {
		if _, ok := o.Relationships[id]; !ok {
			add("relationship %s in fold but not in oracle", id)
		}
	}
	for id, orl := range o.Relationships {
		fr, ok := p.Relationships[id]
		if !ok {
			add("relationship %s in oracle but not in fold", id)
			continue
		}
		if fr.UserBID != orl.UserBID {
			add("relationship %s user_b_id fold=%q oracle=%q", id, fr.UserBID, orl.UserBID)
		}
		if (fr.ArchivedAt != nil) != (orl.ArchivedAt != nil) {
			add("relationship %s archived present fold=%v oracle=%v", id, fr.ArchivedAt != nil, orl.ArchivedAt != nil)
		}
	}

	// Entries.
	for id := range p.Entries {
		if _, ok := o.Entries[id]; !ok {
			add("entry %s in fold but not in oracle", id)
		}
	}
	for id, oe := range o.Entries {
		fe, ok := p.Entries[id]
		if !ok {
			add("entry %s in oracle but not in fold", id)
			continue
		}
		if fe.RelationshipID != oe.RelationshipID {
			add("entry %s relationship_id fold=%q oracle=%q", id, fe.RelationshipID, oe.RelationshipID)
		}
		if fe.Type != oe.Type {
			add("entry %s type fold=%q oracle=%q", id, fe.Type, oe.Type)
		}
		if normNum(fe.AmountAFN.String()) != normNumRaw(oe.AmountAFN) {
			add("entry %s amount fold=%q oracle=%q", id, fe.AmountAFN.String(), normNumRaw(oe.AmountAFN))
		}
		if !samePtr(fe.Note, oe.Note) {
			add("entry %s note fold=%v oracle=%v", id, deref(fe.Note), deref(oe.Note))
		}
		if fe.IsDeleted != oe.IsDeleted {
			add("entry %s is_deleted fold=%v oracle=%v", id, fe.IsDeleted, oe.IsDeleted)
		}
	}

	// Shop / vault name.
	if o.ShopProfile != nil && o.ShopProfile.ShopName != nil {
		if p.ShopProfile == nil || p.ShopProfile.ShopName == nil || *p.ShopProfile.ShopName != *o.ShopProfile.ShopName {
			add("shop_profile.shop_name fold=%v oracle=%q", shopName(p.ShopProfile), *o.ShopProfile.ShopName)
		}
	}
	if name, ok := o.VaultSettings["name"]; ok && name != "" {
		if p.VaultSettings["name"] != name {
			add("vault_settings[name] fold=%q oracle=%q", p.VaultSettings["name"], name)
		}
	}

	if len(diffs) > 0 {
		return fmt.Errorf("vault %s: equality gate FAILED, fold != oracle (%d diffs shown):\n  %s",
			vaultID, len(diffs), strings.Join(diffs, "\n  "))
	}
	return nil
}

func shopName(s *sync.ShopProfileProjection) any {
	if s == nil || s.ShopName == nil {
		return nil
	}
	return *s.ShopName
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func samePtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func phoneAny(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func notEmptyPtr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// parseStrMS parses a decimal ms string ("1786947757471"); 0 on failure.
func parseStrMS(s string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(strings.Trim(s, `"`)), 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// parseMS parses a ms value that may be a JSON number or a JSON string.
func parseMS(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	return parseStrMS(string(raw))
}

// normNum canonicalizes a numeric token for comparison (trims quotes, a
// leading +, and trailing-zero decimals).
func normNum(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"`)
	s = strings.TrimPrefix(s, "+")
	if strings.Contains(s, ".") {
		s = strings.TrimRight(s, "0")
		s = strings.TrimRight(s, ".")
	}
	if s == "" || s == "-" || s == "-0" {
		s = "0"
	}
	return s
}

func normNumRaw(raw json.RawMessage) string { return normNum(string(raw)) }

// amountNumber returns the oracle amount as an unquoted JSON number token
// (json.Number marshals without quotes), preserving decimals.
func amountNumber(raw json.RawMessage) (json.Number, error) {
	s := normNum(string(raw))
	if _, err := strconv.ParseFloat(s, 64); err != nil {
		return "", fmt.Errorf("amount %q is not numeric: %w", string(raw), err)
	}
	return json.Number(s), nil
}

func score(r Row) int {
	s := 0
	if r.AccountID != nil {
		s++
	}
	if r.SignedActorAccountID != nil {
		s++
	}
	if r.EventSigB64 != nil {
		s++
	}
	if r.SignerDevicePubkey != nil {
		s++
	}
	return s
}

func deref(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// envelopeOf is the signed subset as the server will serve it on pull:
// actor_account_id = signed_actor_account_id (the trigger-bypassed evidence
// column), target = COALESCE(local_target_id, target_id).
func envelopeOf(r Row) canonevent.Envelope {
	return canonevent.Envelope{
		VaultID:        r.VaultID,
		EventID:        r.EventID,
		EventType:      r.EventType,
		SchemaVersion:  r.SchemaVersion,
		HLCPhysicalMS:  r.HLCPhysicalMS,
		HLCLogical:     r.HLCLogical,
		HLCDeviceID:    r.HLCDeviceID,
		ActorAccountID: r.SignedActorAccountID,
		TargetID:       r.TargetID,
		RelationshipID: r.RelationshipID,
		Payload:        r.Payload,
	}
}

func ledgerEventsOf(rows []Row) []sync.LedgerEvent {
	out := make([]sync.LedgerEvent, 0, len(rows))
	for _, r := range rows {
		out = append(out, ledgerEventOf(r))
	}
	return out
}

// ledgerEventOf mirrors internal/sync loadVaultEvents' row→LedgerEvent mapping
// (actor = CASE WHEN signed THEN signed_actor ELSE account_id; target =
// COALESCE(local_target_id, target_id)).
func ledgerEventOf(r Row) sync.LedgerEvent {
	ev := sync.LedgerEvent{
		EventID:       r.EventID,
		EventType:     r.EventType,
		VaultID:       r.VaultID,
		HLC:           sync.HLC{PMS: r.HLCPhysicalMS, L: r.HLCLogical, DID: r.HLCDeviceID},
		DeviceID:      r.DeviceID,
		PayloadSchema: r.SchemaVersion,
		Payload:       r.Payload,
		ServerSeq:     r.ServerSeq,
	}
	if r.EventSigB64 != nil && *r.EventSigB64 != "" {
		ev.ActorAccountID = r.SignedActorAccountID
	} // unsigned rows carry account_id NULL -> actor nil; the projection never reads it
	if r.TargetID != nil {
		ev.TargetID = *r.TargetID
	}
	ev.RelationshipID = r.RelationshipID
	return ev
}

// ---------------------------------------------------------------------------
// SQL rendering
// ---------------------------------------------------------------------------

const dollarTag = "$kaata_reimport$"

func lit(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func litp(p *string) string {
	if p == nil {
		return "NULL"
	}
	return lit(*p)
}

func litNum(p *int64) string {
	if p == nil {
		return "NULL"
	}
	return fmt.Sprintf("%d", *p)
}

func dollar(s string) string {
	if strings.Contains(s, dollarTag) {
		panic("dollar tag collision")
	}
	return dollarTag + s + dollarTag
}

func inList(ids []string) string {
	q := make([]string, len(ids))
	for i, id := range ids {
		q[i] = lit(id) + "::uuid"
	}
	return strings.Join(q, ", ")
}

// RenderSQL renders the one-transaction production script.
func (p *Plan) RenderSQL() string {
	var b strings.Builder
	ids := make([]string, 0, len(p.Vaults))
	for _, v := range p.Vaults {
		ids = append(ids, v.Spec.ID)
	}
	owner := p.Options.OwnerAccountID
	fmt.Fprintf(&b, "-- kaata re-import of forensically recovered vaults (generated %s)\n", p.Options.Now.UTC().Format(time.RFC3339))
	b.WriteString("-- Run with: psql -v ON_ERROR_STOP=1 -f reimport.sql   (the file owns one BEGIN/COMMIT; any error stops psql before COMMIT, so nothing lands)\n")
	b.WriteString("SET client_encoding = 'UTF8';\n")
	// The ALTER ... DISABLE TRIGGER below holds a ShareRowExclusiveLock on
	// events for ~0.2s; a 2s ceiling fails fast rather than stalling other
	// shops' pushes behind a long wait.
	b.WriteString("SET lock_timeout = '2s';\n")
	b.WriteString("SET statement_timeout = '120s';\n")
	b.WriteString("BEGIN;\n")
	// Preflight.
	fmt.Fprintf(&b, `DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM vaults WHERE vault_id IN (%s)) THEN
    RAISE EXCEPTION 'reimport preflight: a target vault row already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM events WHERE vault_id IN (%s)) THEN
    RAISE EXCEPTION 'reimport preflight: events already exist for a target vault';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = %s::uuid) THEN
    RAISE EXCEPTION 'reimport preflight: owner account %% is missing', %s;
  END IF;
  IF EXISTS (SELECT 1 FROM vault_snapshots WHERE vault_id IN (%s)) THEN
    RAISE EXCEPTION 'reimport preflight: a snapshot already exists for a target vault';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'events'::regclass AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'reimport preflight: expected EXACTLY one non-internal trigger on events, found %%', (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'events'::regclass AND NOT tgisinternal);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'signed_event_actor_evidence' AND tgrelid = 'events'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'reimport preflight: migration 050 trigger not found or not in its normal enabled state (schema drift)';
  END IF;
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'events'::regclass) <> current_user
     AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), FALSE) THEN
    RAISE EXCEPTION 'reimport preflight: events is owned by %% and %% is not a superuser; run as the owner (DISABLE TRIGGER needs it)', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'events'::regclass), current_user;
  END IF;%s%s
END
$pre$;
`, inList(ids), inList(ids), lit(owner), lit(owner), inList(ids), installPreflight(p.Options.PhoneInstallID, owner), viewerPreflight(p.Vaults))

	for _, v := range p.Vaults {
		createdAt := time.UnixMilli(v.MinHLC).UTC().Format(time.RFC3339Nano)
		fmt.Fprintf(&b, "\n-- vault %s (%s): %d recovered rows + %d reconstruction/margin, snapshot up_to %d\n",
			v.Spec.ID, v.Spec.Name, len(v.Rows), len(v.Reconstruction), v.UpTo)
		fmt.Fprintf(&b, "INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch, created_at, archived_at, vault_trust_anchor_pubkey)\nVALUES (%s::uuid, %s::uuid, %s, %s, 0, %s::timestamptz, NULL, decode(%s, 'base64'));\n",
			lit(v.Spec.ID), lit(owner), lit(v.Spec.Name), lit(v.Spec.Currency), lit(createdAt), lit(p.Options.AnchorPubB64))
		fmt.Fprintf(&b, "INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, last_change_hlc_ms)\nVALUES (%s::uuid, %s::uuid, 'owner', NOW(), NOW(), %s::uuid, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint);\n",
			lit(v.Spec.ID), lit(owner), lit(owner))
		for _, vw := range v.Viewers {
			// Conditional on the account existing so an absent member is a
			// skip-with-warning (see viewerPreflight) rather than an FK abort.
			fmt.Fprintf(&b, "INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, last_change_hlc_ms)\nSELECT %s::uuid, %s::uuid, %s, to_timestamp(%d / 1000.0), to_timestamp(%d / 1000.0), NULL, %d\nWHERE EXISTS (SELECT 1 FROM accounts WHERE id = %s::uuid);\n",
				lit(v.Spec.ID), lit(vw.AccountID), lit(vw.Role), vw.AddedAtMS, vw.AddedAtMS, vw.AddedAtMS, lit(vw.AccountID))
		}
	}

	b.WriteString("\n-- Migration 050's BEFORE INSERT trigger would overwrite signed_actor_account_id with account_id;\n")
	b.WriteString("-- the signed evidence must stay the ORIGINAL actor or every pulled row fails signature verification on the phone.\n")
	b.WriteString("ALTER TABLE events DISABLE TRIGGER signed_event_actor_evidence;\n")
	const cols = "event_id, vault_id, hlc_physical_ms, hlc_logical, hlc_device_id, device_id, account_id, target_id, relationship_id, event_type, schema_version, payload, server_received_at, server_seq, redacted_at, redacted_reason, author_seq, event_sig_b64, signer_device_pubkey, local_target_id, signed_actor_account_id"
	for _, v := range p.Vaults {
		rows := append(append([]Row{}, v.Rows...), v.Reconstruction...)
		const chunk = 100
		for i := 0; i < len(rows); i += chunk {
			end := i + chunk
			if end > len(rows) {
				end = len(rows)
			}
			fmt.Fprintf(&b, "INSERT INTO events (%s) VALUES\n", cols)
			for j := i; j < end; j++ {
				r := rows[j]
				vals := []string{
					lit(r.EventID) + "::uuid",
					lit(r.VaultID) + "::uuid",
					fmt.Sprintf("%d", r.HLCPhysicalMS),
					fmt.Sprintf("%d", r.HLCLogical),
					lit(r.HLCDeviceID) + "::uuid",
					lit(r.DeviceID) + "::uuid",
					"NULL", // events.account_id: live FK, author account deleted -> NULL (the deletion path's own convention)
					nullableUUID(r.TargetID),
					nullableUUID(r.RelationshipID),
					lit(r.EventType),
					fmt.Sprintf("%d", r.SchemaVersion),
					dollar(string(r.Payload)) + "::jsonb",
					lit(r.ServerReceivedAt) + "::timestamptz",
					fmt.Sprintf("%d", r.ServerSeq),
					"NULL",
					"NULL",
					litNum(r.AuthorSeq),
					litp(r.EventSigB64),
					litp(r.SignerDevicePubkey),
					"NULL",
					nullableUUID(r.SignedActorAccountID),
				}
				sep := ","
				if j == end-1 {
					sep = ";"
				}
				fmt.Fprintf(&b, "  (%s)%s\n", strings.Join(vals, ", "), sep)
			}
		}
	}
	b.WriteString("ALTER TABLE events ENABLE TRIGGER signed_event_actor_evidence;\n")

	for _, v := range p.Vaults {
		fmt.Fprintf(&b, "\nINSERT INTO vault_snapshots (vault_id, up_to_server_seq, schema_version, snapshot, byte_size, created_at)\nVALUES (%s::uuid, %d, %d, %s::jsonb, %d, NOW());\n",
			lit(v.Spec.ID), v.UpTo, sync.SnapshotSchemaVersion, dollar(string(v.SnapshotJSON)), len(v.SnapshotJSON))
	}

	// Post-conditions.
	b.WriteString("\nDO $post$\nDECLARE n bigint;\nBEGIN\n")
	for _, v := range p.Vaults {
		total := len(v.Rows) + len(v.Reconstruction)
		signed := v.Stats.Signed
		fmt.Fprintf(&b, "  SELECT count(*) INTO n FROM events WHERE vault_id = %s::uuid; IF n <> %d THEN RAISE EXCEPTION 'vault %s: %% events, want %d', n; END IF;\n", lit(v.Spec.ID), total, v.Spec.ID, total)
		nDead, nNull := signedActorCounts(v, p.Options.DeletedAccountID)
		fmt.Fprintf(&b, "  SELECT count(*) INTO n FROM events WHERE vault_id = %s::uuid AND NULLIF(event_sig_b64,'') IS NOT NULL AND signed_actor_account_id = %s::uuid; IF n <> %d THEN RAISE EXCEPTION 'vault %s: %% signed rows keep the deleted account as signed actor, want %d (trigger bypass failed?)', n; END IF;\n", lit(v.Spec.ID), lit(p.Options.DeletedAccountID), nDead, v.Spec.ID, nDead)
		fmt.Fprintf(&b, "  SELECT count(*) INTO n FROM events WHERE vault_id = %s::uuid AND NULLIF(event_sig_b64,'') IS NOT NULL AND signed_actor_account_id IS NULL; IF n <> %d THEN RAISE EXCEPTION 'vault %s: %% signed rows with a NULL (pre-sign-in) signed actor, want %d (trigger bypass failed?)', n; END IF;\n", lit(v.Spec.ID), nNull, v.Spec.ID, nNull)
		fmt.Fprintf(&b, "  SELECT count(*) INTO n FROM events WHERE vault_id = %s::uuid AND account_id IS NOT NULL; IF n <> 0 THEN RAISE EXCEPTION 'vault %s: %% rows carry a live account_id, want 0', n; END IF;\n", lit(v.Spec.ID), v.Spec.ID)
		fmt.Fprintf(&b, "  SELECT count(*) INTO n FROM events WHERE vault_id = %s::uuid AND NULLIF(event_sig_b64,'') IS NOT NULL; IF n <> %d THEN RAISE EXCEPTION 'vault %s: %% signed rows, want %d', n; END IF;\n", lit(v.Spec.ID), signed, v.Spec.ID, signed)
		fmt.Fprintf(&b, "  SELECT max(server_seq) INTO n FROM events WHERE vault_id = %s::uuid; IF n <> %d THEN RAISE EXCEPTION 'vault %s: max server_seq %%, want %d', n; END IF;\n", lit(v.Spec.ID), v.UpTo, v.Spec.ID, v.UpTo)
		fmt.Fprintf(&b, "  SELECT count(*) INTO n FROM vault_snapshots WHERE vault_id = %s::uuid AND up_to_server_seq = %d; IF n <> 1 THEN RAISE EXCEPTION 'vault %s: snapshot row missing'; END IF;\n", lit(v.Spec.ID), v.UpTo, v.Spec.ID)
		fmt.Fprintf(&b, "  SELECT count(*) INTO n FROM vault_members WHERE vault_id = %s::uuid AND account_id = %s::uuid AND role = 'owner' AND accepted_at IS NOT NULL AND revoked_at IS NULL; IF n <> 1 THEN RAISE EXCEPTION 'vault %s: owner membership missing'; END IF;\n", lit(v.Spec.ID), lit(owner), v.Spec.ID)
		for _, vw := range v.Viewers {
			// The seat lands only if the account exists (FK); assert exactly that.
			fmt.Fprintf(&b, "  SELECT count(*) INTO n FROM vault_members WHERE vault_id = %s::uuid AND account_id = %s::uuid AND role = %s AND revoked_at IS NULL; IF n <> (CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE id = %s::uuid) THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'vault %s: viewer seat for %s not in its expected state', n; END IF;\n",
				lit(v.Spec.ID), lit(vw.AccountID), lit(vw.Role), lit(vw.AccountID), v.Spec.ID, vw.AccountID[:8])
		}
	}
	b.WriteString("  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'signed_event_actor_evidence' AND tgrelid = 'events'::regclass AND tgenabled = 'O') THEN RAISE EXCEPTION 'trigger not re-enabled (tgenabled must be O)'; END IF;\n")
	b.WriteString("END\n$post$;\n")
	b.WriteString("COMMIT;\n")
	return b.String()
}

// signedActorCounts returns how many signed recovered rows carry the deleted
// account as signed actor and how many carry NULL (signed before sign-in).
func signedActorCounts(v *VaultPlan, deleted string) (dead, null int) {
	for _, r := range v.Rows {
		if r.EventSigB64 == nil {
			continue
		}
		switch {
		case r.SignedActorAccountID == nil:
			null++
		case *r.SignedActorAccountID == deleted:
			dead++
		}
	}
	return dead, null
}

// installPreflight renders the optional phone-install guard for the preflight
// DO block (empty when no install id was supplied): retired, no device key, or
// not bound to the owner account.
func installPreflight(installID, owner string) string {
	if installID == "" {
		return ""
	}
	return fmt.Sprintf(`
  IF EXISTS (SELECT 1 FROM installs WHERE install_id = %s::uuid AND account_deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'reimport preflight: phone install %s is retired (410 on sign-in)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM device_keys WHERE install_id = %s::uuid) THEN
    RAISE EXCEPTION 'reimport preflight: phone install %s has no registered device key (witness would 412)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM installs WHERE install_id = %s::uuid AND account_id = %s::uuid) THEN
    RAISE EXCEPTION 'reimport preflight: phone install %s is not bound to the owner account %s';
  END IF;`, lit(installID), installID, lit(installID), installID, lit(installID), lit(owner), installID, owner)
}

// viewerPreflight warns (not aborts) when an -include-viewer seat's account is
// absent: its conditional INSERT then simply inserts nothing.
func viewerPreflight(vaults []*VaultPlan) string {
	var b strings.Builder
	for _, v := range vaults {
		for _, vw := range v.Viewers {
			fmt.Fprintf(&b, `
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = %s::uuid) THEN
    RAISE WARNING 'reimport: viewer account %s absent; its membership seat for vault %s will be skipped', %s, %s;
  END IF;`, lit(vw.AccountID), vw.AccountID, v.Spec.ID[:8], lit(vw.AccountID), lit(v.Spec.ID))
		}
	}
	return b.String()
}

func nullableUUID(p *string) string {
	if p == nil {
		return "NULL"
	}
	return lit(*p) + "::uuid"
}

// RenderRollbackSQL removes everything the import (and anything the phone
// pushed into these vaults afterwards) wrote. Account, install and device-key
// rows are untouched.
func (p *Plan) RenderRollbackSQL() string {
	ids := make([]string, 0, len(p.Vaults))
	for _, v := range p.Vaults {
		ids = append(ids, v.Spec.ID)
	}
	in := inList(ids)
	return fmt.Sprintf(`-- rollback of the kaata re-import: deletes the two vaults and every row hanging off them
SET lock_timeout = '2s';
BEGIN;
DELETE FROM vault_snapshots WHERE vault_id IN (%s);
DELETE FROM events          WHERE vault_id IN (%s);
DELETE FROM vault_devices   WHERE vault_id IN (%s);
DELETE FROM vault_audit_log WHERE vault_id IN (%s);
DELETE FROM vault_members   WHERE vault_id IN (%s);
DELETE FROM vaults          WHERE vault_id IN (%s);
COMMIT;
`, in, in, in, in, in, in)
}

// Summary is a human-readable account of what the plan would insert.
func (p *Plan) Summary() string {
	var b strings.Builder
	for _, v := range p.Vaults {
		fmt.Fprintf(&b, "vault %s %q %s: carved=%d signed=%d verified=%d unsigned(sig lost)=%d pubkey-filled=%d evidence-restored=%d | reconstruction=%d up_to=%d snapshot=%d bytes hlc=[%s .. %s]\n",
			v.Spec.ID, v.Spec.Name, v.Spec.Currency, v.Stats.Rows, v.Stats.Signed, v.Stats.SignedVerified, v.Stats.Unsigned,
			v.Stats.PubkeyFilled, v.Stats.SignedActorFixed, v.Stats.Reconstructed, v.UpTo, len(v.SnapshotJSON),
			time.UnixMilli(v.MinHLC).UTC().Format(time.RFC3339), time.UnixMilli(v.MaxHLC).UTC().Format(time.RFC3339))
		fmt.Fprintf(&b, "   total events = carved %d + reconstruction %d = %d\n", len(v.Rows), len(v.Reconstruction), len(v.Rows)+len(v.Reconstruction))
		carvedTypes := make([]string, 0, len(v.Stats.ByType))
		for k := range v.Stats.ByType {
			carvedTypes = append(carvedTypes, k)
		}
		sort.Strings(carvedTypes)
		b.WriteString("   carved by type:\n")
		for _, k := range carvedTypes {
			fmt.Fprintf(&b, "     %-24s %d\n", k, v.Stats.ByType[k])
		}
		reconTypes := make([]string, 0, len(v.Stats.ReconByType))
		for k := range v.Stats.ReconByType {
			reconTypes = append(reconTypes, k)
		}
		sort.Strings(reconTypes)
		b.WriteString("   reconstruction by type (incl. 1 no-op margin):\n")
		for _, k := range reconTypes {
			fmt.Fprintf(&b, "     %-24s %d\n", k, v.Stats.ReconByType[k])
		}
		for _, vw := range v.Viewers {
			fmt.Fprintf(&b, "   viewer seat %s role=%s (conditional on the account existing)\n", vw.AccountID, vw.Role)
		}
	}
	return b.String()
}
