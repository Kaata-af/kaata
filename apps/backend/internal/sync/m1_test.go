package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/testutil"
)

const testJWTSecret = "0123456789abcdef0123456789abcdef"

// m1Fixture is one account owning one vault, pushing from one device —
// the minimal world for the M1 replication-core tests.
type m1Fixture struct {
	pool      *pgxpool.Pool
	svc       *Service
	accountID string
	vaultID   string
	deviceID  string
}

func newM1Fixture(t *testing.T) *m1Fixture {
	t.Helper()
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()

	f := &m1Fixture{
		pool:     pool,
		svc:      NewService(pool),
		vaultID:  uuid.NewString(),
		deviceID: uuid.NewString(),
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, 'owner@gmail.com', TRUE, 'Owner')
		RETURNING id::text
	`, "sub-"+uuid.NewString()).Scan(&f.accountID); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Test Shop', 'AFN', 0)
	`, f.vaultID, f.accountID); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, f.vaultID, f.accountID); err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	return f
}

// event builds a permissible entry_created push event authored by the
// fixture's account on the fixture's device. authorSeq nil = legacy client.
func (f *m1Fixture) event(authorSeq *int64) PushEvent {
	return PushEvent{
		EventID: uuid.NewString(),
		HLC: PushHLC{
			PhysicalMS: time.Now().UnixMilli(),
			Logical:    0,
			// hlc.device_id is the AUTHOR; the server stamps events.device_id
			// from it (author-keyed slots). Here author == pusher; relay
			// tests use eventAuthoredBy to diverge the two.
			DeviceID: f.deviceID,
		},
		EventType:      "entry_created",
		SchemaVersion:  1,
		ActorAccountID: &f.accountID,
		AuthorSeq:      authorSeq,
		Payload:        json.RawMessage(`{}`),
	}
}

// eventAuthoredBy builds a push event whose HLC (and therefore author slot)
// belongs to authorDeviceID — simulating a relayed event where the
// batch-level pusher differs from the event's author.
func (f *m1Fixture) eventAuthoredBy(authorDeviceID string, authorSeq *int64) PushEvent {
	ev := f.event(authorSeq)
	ev.HLC.DeviceID = authorDeviceID
	return ev
}

func (f *m1Fixture) push(t *testing.T, events ...PushEvent) *PushResponse {
	t.Helper()
	res, err := f.svc.PushEvents(context.Background(), PushInput{
		AccountID: f.accountID,
		VaultID:   f.vaultID,
		DeviceID:  f.deviceID,
		Events:    events,
	})
	if err != nil {
		t.Fatalf("PushEvents: %v", err)
	}
	return res
}

func seq(n int64) *int64 { return &n }

// ==========================================================================
// PUSH: author_seq persistence + seq_conflict
// ==========================================================================

func TestPushPersistsAuthorSeq(t *testing.T) {
	f := newM1Fixture(t)
	ctx := context.Background()

	e1 := f.event(seq(1))
	e2 := f.event(seq(2))
	eLegacy := f.event(nil)

	res := f.push(t, e1, e2, eLegacy)
	if len(res.Accepted) != 3 || len(res.Rejected) != 0 || len(res.Duplicates) != 0 {
		t.Fatalf("push = accepted:%d duplicates:%d rejected:%d, want 3/0/0 (%+v)",
			len(res.Accepted), len(res.Duplicates), len(res.Rejected), res.Rejected)
	}

	read := func(eventID string) *int64 {
		var got *int64
		if err := f.pool.QueryRow(ctx, `
			SELECT author_seq FROM events WHERE event_id = $1::uuid
		`, eventID).Scan(&got); err != nil {
			t.Fatalf("read author_seq for %s: %v", eventID, err)
		}
		return got
	}
	if got := read(e1.EventID); got == nil || *got != 1 {
		t.Errorf("e1 author_seq = %v, want 1", got)
	}
	if got := read(e2.EventID); got == nil || *got != 2 {
		t.Errorf("e2 author_seq = %v, want 2", got)
	}
	if got := read(eLegacy.EventID); got != nil {
		t.Errorf("legacy event author_seq = %v, want NULL", *got)
	}
}

func TestPushSeqConflictRejectsEventButNotBatch(t *testing.T) {
	f := newM1Fixture(t)

	holder := f.event(seq(1))
	if res := f.push(t, holder); len(res.Accepted) != 1 {
		t.Fatalf("seed push not accepted: %+v", res)
	}

	// A DIFFERENT event claiming the taken (vault, author, seq=1) slot
	// (author == pusher here), followed by an innocent event — the batch
	// must continue.
	usurper := f.event(seq(1))
	innocent := f.event(seq(2))
	res := f.push(t, usurper, innocent)

	if len(res.Rejected) != 1 {
		t.Fatalf("rejected = %+v, want exactly the usurper", res.Rejected)
	}
	if res.Rejected[0].EventID != usurper.EventID || res.Rejected[0].Reason != "seq_conflict" {
		t.Errorf("rejected[0] = %+v, want {%s seq_conflict}", res.Rejected[0], usurper.EventID)
	}
	if len(res.Accepted) != 1 || res.Accepted[0].EventID != innocent.EventID {
		t.Errorf("accepted = %+v, want just the innocent event", res.Accepted)
	}

	// Same-event_id duplicate keeps the duplicates[] behavior — even
	// though it re-claims its own seq slot.
	res = f.push(t, holder)
	if len(res.Duplicates) != 1 || res.Duplicates[0] != holder.EventID {
		t.Errorf("re-push of holder: duplicates = %+v, want [%s]", res.Duplicates, holder.EventID)
	}
	if len(res.Rejected) != 0 {
		t.Errorf("re-push of holder must not be a seq_conflict: %+v", res.Rejected)
	}
}

// SEC FIX 1: the push loop verifies+folds (and assigns author_seq slots) in
// deterministic (hlc_physical_ms, hlc_logical, hlc_device_id, event_id)
// order, NOT wire order. Two events claiming the same (vault, author, seq=5)
// slot in one batch must resolve to the HLC-FIRST one winning regardless of
// which is listed first in the request — otherwise an attacker could pick
// the winner by reordering the wire. We give the lower-HLC claimant to
// `second` (the later arg) to prove ordering is by HLC, not arg position.
func TestPushSeqConflictWithinSameBatch(t *testing.T) {
	f := newM1Fixture(t)

	higher := f.event(seq(5))
	higher.HLC.PhysicalMS = higher.HLC.PhysicalMS + 10 // sorts AFTER → loses slot
	lower := f.event(seq(5))                           // same slot, earlier HLC → wins

	// Pass higher-HLC first on the wire; deterministic ordering must still
	// award the slot to the lower-HLC event.
	res := f.push(t, higher, lower)

	if len(res.Accepted) != 1 || res.Accepted[0].EventID != lower.EventID {
		t.Errorf("accepted = %+v, want the HLC-first claimant (%s)", res.Accepted, lower.EventID)
	}
	if len(res.Rejected) != 1 || res.Rejected[0].EventID != higher.EventID ||
		res.Rejected[0].Reason != "seq_conflict" {
		t.Errorf("rejected = %+v, want HLC-later claimant (%s) with seq_conflict", res.Rejected, higher.EventID)
	}
}

// TestPushRelayedEventKeyedByAuthor pins the FIX-1 behavior: a batch pushed
// by device R carrying an event authored by device A (hlc.device_id = A)
// must be accepted, stored with device_id = A (NOT R, which would trip 007's
// CHECK and 500 the batch), slotted under A's sequence space, and reported
// under A by the vector endpoint. Scenario 4 of the architecture doc (relay
// topology) is built on this.
func TestPushRelayedEventKeyedByAuthor(t *testing.T) {
	f := newM1Fixture(t)
	ctx := context.Background()

	authorDevice := uuid.NewString() // device A — never the pusher
	relayed := f.eventAuthoredBy(authorDevice, seq(3))

	// Pushed by the fixture device (R) on A's behalf.
	res := f.push(t, relayed)
	if len(res.Accepted) != 1 || len(res.Rejected) != 0 || len(res.Duplicates) != 0 {
		t.Fatalf("relayed push = %+v, want 1 accepted", res)
	}

	// Stored under the AUTHOR device.
	var storedDeviceID string
	var storedSeq *int64
	if err := f.pool.QueryRow(ctx, `
		SELECT device_id::text, author_seq FROM events WHERE event_id = $1::uuid
	`, relayed.EventID).Scan(&storedDeviceID, &storedSeq); err != nil {
		t.Fatalf("read stored event: %v", err)
	}
	if storedDeviceID != authorDevice {
		t.Errorf("stored device_id = %s, want author %s (not pusher %s)",
			storedDeviceID, authorDevice, f.deviceID)
	}
	if storedSeq == nil || *storedSeq != 3 {
		t.Errorf("stored author_seq = %v, want 3", storedSeq)
	}

	// The slot lives under A — the pusher's own (vault, R, 3) slot is free.
	own := f.event(seq(3))
	if res := f.push(t, own); len(res.Accepted) != 1 {
		t.Errorf("pusher's own seq-3 slot must be free: %+v", res)
	}

	// FIX 4c (author-keyed): a DIFFERENT event claiming A's taken
	// (vault, A, 3) slot — again relayed through R — is a seq_conflict.
	usurper := f.eventAuthoredBy(authorDevice, seq(3))
	res = f.push(t, usurper)
	if len(res.Rejected) != 1 || res.Rejected[0].EventID != usurper.EventID ||
		res.Rejected[0].Reason != "seq_conflict" {
		t.Errorf("author-slot usurper = %+v, want seq_conflict", res)
	}

	// Vector reports per AUTHOR: one entry for A, one for R.
	vec, err := f.svc.DeviceVectors(ctx, f.accountID, f.vaultID)
	if err != nil {
		t.Fatalf("DeviceVectors: %v", err)
	}
	if len(vec.DeviceVectors) != 2 {
		t.Fatalf("device_vectors = %+v, want entries for author and pusher", vec.DeviceVectors)
	}
	if v, ok := vec.DeviceVectors[authorDevice]; !ok || v.MaxSeq != 3 || v.Count != 1 || v.MinSeq != 3 {
		t.Errorf("vector[author] = %+v (ok=%v), want {3,1,3}", v, ok)
	}
	if v, ok := vec.DeviceVectors[f.deviceID]; !ok || v.MaxSeq != 3 || v.Count != 1 || v.MinSeq != 3 {
		t.Errorf("vector[pusher] = %+v (ok=%v), want {3,1,3} from its own event", v, ok)
	}
}

// TestDuplicateReAnnounceBackfillsAuthorSeq pins the FIX-2 behavior: pre-M1
// rows gain author_seq when their author re-pushes them as duplicates
// carrying the seq; conflicting announces never win and never seq_conflict.
func TestDuplicateReAnnounceBackfillsAuthorSeq(t *testing.T) {
	f := newM1Fixture(t)
	ctx := context.Background()

	// Pre-M1 history: pushed without a seq.
	legacy := f.event(nil)
	if res := f.push(t, legacy); len(res.Accepted) != 1 {
		t.Fatalf("seed push: %+v", res)
	}

	readSeq := func(eventID string) *int64 {
		t.Helper()
		var got *int64
		if err := f.pool.QueryRow(ctx, `
			SELECT author_seq FROM events WHERE event_id = $1::uuid
		`, eventID).Scan(&got); err != nil {
			t.Fatalf("read author_seq for %s: %v", eventID, err)
		}
		return got
	}
	if got := readSeq(legacy.EventID); got != nil {
		t.Fatalf("pre-announce author_seq = %v, want NULL", *got)
	}

	// One-shot re-announce: same event_id, now carrying its seq.
	announce := legacy
	announce.AuthorSeq = seq(4)
	res := f.push(t, announce)
	if len(res.Duplicates) != 1 || res.Duplicates[0] != legacy.EventID {
		t.Fatalf("re-announce duplicates = %+v, want [%s]", res.Duplicates, legacy.EventID)
	}
	if len(res.Rejected) != 0 || len(res.Accepted) != 0 {
		t.Fatalf("re-announce must be duplicate-only: %+v", res)
	}
	if got := readSeq(legacy.EventID); got == nil || *got != 4 {
		t.Fatalf("post-announce author_seq = %v, want 4", got)
	}

	// Conflicting re-announce for the SAME event_id: first value wins,
	// still reported as a duplicate, never a seq_conflict.
	conflicting := legacy
	conflicting.AuthorSeq = seq(9)
	res = f.push(t, conflicting)
	if len(res.Duplicates) != 1 || res.Duplicates[0] != legacy.EventID {
		t.Errorf("conflicting re-announce duplicates = %+v, want [%s]", res.Duplicates, legacy.EventID)
	}
	if len(res.Rejected) != 0 {
		t.Errorf("conflicting re-announce must not reject: %+v", res.Rejected)
	}
	if got := readSeq(legacy.EventID); got == nil || *got != 4 {
		t.Errorf("author_seq after conflicting re-announce = %v, want still 4", got)
	}

	// A re-announce whose claimed slot is held by a DIFFERENT event also
	// stays a plain duplicate and leaves the stored row's NULL untouched.
	holder := f.event(seq(8))
	if res := f.push(t, holder); len(res.Accepted) != 1 {
		t.Fatalf("seed slot-8 holder: %+v", res)
	}
	legacy2 := f.event(nil)
	if res := f.push(t, legacy2); len(res.Accepted) != 1 {
		t.Fatalf("seed second legacy: %+v", res)
	}
	announce2 := legacy2
	announce2.AuthorSeq = seq(8) // slot taken by holder
	res = f.push(t, announce2)
	if len(res.Duplicates) != 1 || res.Duplicates[0] != legacy2.EventID {
		t.Errorf("taken-slot re-announce duplicates = %+v, want [%s]", res.Duplicates, legacy2.EventID)
	}
	if len(res.Rejected) != 0 {
		t.Errorf("taken-slot re-announce must not seq_conflict: %+v", res.Rejected)
	}
	if got := readSeq(legacy2.EventID); got != nil {
		t.Errorf("legacy2 author_seq = %v, want still NULL", *got)
	}
	if got := readSeq(holder.EventID); got == nil || *got != 8 {
		t.Errorf("holder author_seq = %v, want untouched 8", got)
	}
}

// ==========================================================================
// PULL + SNAPSHOT TAIL: author_seq round-trip
// ==========================================================================

func TestPullRoundTripsAuthorSeq(t *testing.T) {
	f := newM1Fixture(t)

	e1 := f.event(seq(1))
	eLegacy := f.event(nil)
	f.push(t, e1, eLegacy)

	res, err := f.svc.PullEvents(context.Background(), PullInput{
		AccountID: f.accountID,
		VaultID:   f.vaultID,
		Limit:     100,
	})
	if err != nil {
		t.Fatalf("PullEvents: %v", err)
	}
	if len(res.Events) != 2 {
		t.Fatalf("pulled %d events, want 2", len(res.Events))
	}

	byID := map[string]PulledEvent{}
	for _, ev := range res.Events {
		byID[ev.EventID] = ev
	}
	if got := byID[e1.EventID].AuthorSeq; got == nil || *got != 1 {
		t.Errorf("pulled e1 author_seq = %v, want 1", got)
	}
	if got := byID[eLegacy.EventID].AuthorSeq; got != nil {
		t.Errorf("pulled legacy author_seq = %v, want nil", *got)
	}

	// Wire contract: author_seq is number|null — the key must be present
	// (NOT omitted) even for legacy rows.
	raw, err := json.Marshal(byID[eLegacy.EventID])
	if err != nil {
		t.Fatalf("marshal pulled event: %v", err)
	}
	if !strings.Contains(string(raw), `"author_seq":null`) {
		t.Errorf("legacy pulled event must serialize author_seq:null, got %s", raw)
	}
	raw, _ = json.Marshal(byID[e1.EventID])
	if !strings.Contains(string(raw), `"author_seq":1`) {
		t.Errorf("pulled event must serialize author_seq:1, got %s", raw)
	}
}

func TestSnapshotTailRoundTripsAuthorSeq(t *testing.T) {
	f := newM1Fixture(t)
	ctx := context.Background()

	e1 := f.event(seq(1))
	eLegacy := f.event(nil)
	f.push(t, e1, eLegacy)

	// Plant an empty snapshot at up_to_server_seq=0 so both events land in
	// the tail.
	emptyProjection, err := ProjectionToJSON(NewProjection())
	if err != nil {
		t.Fatalf("serialize empty projection: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_snapshots (vault_id, up_to_server_seq, snapshot, schema_version, byte_size)
		VALUES ($1::uuid, 0, $2::jsonb, $3, $4)
	`, f.vaultID, string(emptyProjection), SnapshotSchemaVersion, len(emptyProjection)); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}

	snap, err := f.svc.LatestSnapshot(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("LatestSnapshot: %v", err)
	}
	if len(snap.Events) != 2 {
		t.Fatalf("snapshot tail has %d events, want 2", len(snap.Events))
	}
	byID := map[string]PulledEvent{}
	for _, ev := range snap.Events {
		byID[ev.EventID] = ev
	}
	if got := byID[e1.EventID].AuthorSeq; got == nil || *got != 1 {
		t.Errorf("tail e1 author_seq = %v, want 1", got)
	}
	if got := byID[eLegacy.EventID].AuthorSeq; got != nil {
		t.Errorf("tail legacy author_seq = %v, want nil", *got)
	}
}

// ==========================================================================
// VECTOR endpoint
// ==========================================================================

func TestVectorReportsGaps(t *testing.T) {
	f := newM1Fixture(t)

	f.push(t, f.event(seq(1)), f.event(seq(2)), f.event(seq(3)), f.event(seq(7)))

	res, err := f.svc.DeviceVectors(context.Background(), f.accountID, f.vaultID)
	if err != nil {
		t.Fatalf("DeviceVectors: %v", err)
	}
	if len(res.DeviceVectors) != 1 {
		t.Fatalf("device_vectors has %d entries, want 1: %+v", len(res.DeviceVectors), res.DeviceVectors)
	}
	v, ok := res.DeviceVectors[f.deviceID]
	if !ok {
		t.Fatalf("device %s missing from vectors: %+v", f.deviceID, res.DeviceVectors)
	}
	if v.MaxSeq != 7 || v.Count != 4 || v.MinSeq != 1 {
		t.Errorf("vector = %+v, want {max 7, count 4, min 1}", v)
	}
	if res.VaultServerSeqHigh != 4 {
		t.Errorf("vault_server_seq_high = %d, want 4", res.VaultServerSeqHigh)
	}
}

func TestVectorEmptyVault(t *testing.T) {
	f := newM1Fixture(t)

	res, err := f.svc.DeviceVectors(context.Background(), f.accountID, f.vaultID)
	if err != nil {
		t.Fatalf("DeviceVectors: %v", err)
	}
	if len(res.DeviceVectors) != 0 {
		t.Errorf("empty vault device_vectors = %+v, want none", res.DeviceVectors)
	}
	if res.VaultServerSeqHigh != 0 {
		t.Errorf("empty vault vault_server_seq_high = %d, want 0", res.VaultServerSeqHigh)
	}

	// Wire shape: an empty map must serialize as {} (not null) so clients
	// can iterate without a null check.
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"device_vectors":{}`) {
		t.Errorf("empty device_vectors must serialize as {}, got %s", raw)
	}
}

// TestVectorEndpointAuthAndMembership exercises the HTTP surface: members
// get 200, non-members and unknown vaults get the same 403 as pull (no
// existence oracle), missing auth gets 401.
func TestVectorEndpointAuthAndMembership(t *testing.T) {
	f := newM1Fixture(t)
	ctx := context.Background()

	f.push(t, f.event(seq(1)))

	// A second account with no membership.
	var strangerID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO accounts (google_sub, email, email_verified, name)
		VALUES ($1, 'stranger@gmail.com', TRUE, 'Stranger')
		RETURNING id::text
	`, "sub-"+uuid.NewString()).Scan(&strangerID); err != nil {
		t.Fatalf("seed stranger: %v", err)
	}

	handler := auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).Vector))

	get := func(accountID, vaultID, withAuth string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/v1/sync/vector?vault_id="+vaultID, nil)
		if withAuth == "yes" {
			tok, err := auth.SignSession(testJWTSecret, accountID, uuid.NewString(), "google", "sub-x")
			if err != nil {
				t.Fatalf("mint jwt: %v", err)
			}
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// Member → 200 with the vector payload.
	rec := get(f.accountID, f.vaultID, "yes")
	if rec.Code != http.StatusOK {
		t.Fatalf("member GET = %d (%s), want 200", rec.Code, rec.Body.String())
	}
	var body struct {
		DeviceVectors      map[string]DeviceVector `json:"device_vectors"`
		VaultServerSeqHigh int64                   `json:"vault_server_seq_high"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if v := body.DeviceVectors[f.deviceID]; v.MaxSeq != 1 || v.Count != 1 || v.MinSeq != 1 {
		t.Errorf("member vector body = %+v, want {1,1,1}", body.DeviceVectors)
	}

	// Non-member → 403 (same as pull).
	if rec := get(strangerID, f.vaultID, "yes"); rec.Code != http.StatusForbidden {
		t.Errorf("non-member GET = %d, want 403", rec.Code)
	}

	// Unknown vault → 403 too (no existence oracle, mirrors pull).
	if rec := get(f.accountID, uuid.NewString(), "yes"); rec.Code != http.StatusForbidden {
		t.Errorf("unknown-vault GET = %d, want 403", rec.Code)
	}

	// No auth → 401.
	if rec := get("", f.vaultID, "no"); rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated GET = %d, want 401", rec.Code)
	}
}

// TestPushHandlerRejectsAuthorSeqBelowOne pins the wire validation: 0 and
// negatives are 400s before the service ever runs.
func TestPushHandlerRejectsAuthorSeqBelowOne(t *testing.T) {
	f := newM1Fixture(t)

	handler := auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).Push))

	ev := f.event(seq(0)) // invalid
	body, err := json.Marshal(map[string]any{
		"vault_id":  f.vaultID,
		"device_id": f.deviceID,
		"events":    []PushEvent{ev},
	})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}

	tok, err := auth.SignSession(testJWTSecret, f.accountID, uuid.NewString(), "google", "sub-x")
	if err != nil {
		t.Fatalf("mint jwt: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/sync/push", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("push with author_seq=0 = %d (%s), want 400", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "author_seq") {
		t.Errorf("error body should name author_seq: %s", rec.Body.String())
	}
}
