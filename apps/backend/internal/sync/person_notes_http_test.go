package sync

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
)

type personNotePageQuery struct {
	t     *testing.T
	rows  pgx.Rows
	limit int
	after int64
}

func (q personNotePageQuery) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	q.t.Helper()
	for _, predicate := range []string{"vault_id = $1::uuid", "server_seq > $2", "redacted_at IS NULL", "event_type = 'person_note_set'", "ORDER BY server_seq ASC", "LIMIT $3", "THEN signed_actor_account_id ELSE account_id"} {
		if !strings.Contains(sql, predicate) {
			q.t.Fatalf("bounded signed recovery missing %q", predicate)
		}
	}
	if len(args) != 3 || args[0] != "book" || args[1] != q.after || args[2] != q.limit+1 {
		q.t.Fatalf("unbounded or incorrectly scoped recovery: %v", args)
	}
	return q.rows, nil
}

func TestPersonNoteRecoveryPageDoesNotSkipSparseRows(t *testing.T) {
	rows := &enabledCurrencySnapshotRows{}
	for _, serverSeq := range []int64{9, 300, 700} {
		rel, actor, signature, pub := "r", "author", "signature", "pubkey"
		rows.values = append(rows.values, []any{
			"event", int64(20), int64(0), "device", "device", &actor, &rel, &rel,
			EventPersonNoteSet, 1, []byte(`{"note":null}`), &serverSeq, &signature, &pub, serverSeq, time.UnixMilli(20),
		})
	}
	page, err := readPersonNotePage(t.Context(), personNotePageQuery{t: t, rows: rows, limit: 2, after: 5}, "book", 5, 2)
	if err != nil || !rows.closed || !page.HasMore || len(page.Events) != 2 || page.NextAfterServerSeq != 300 || page.VaultID != "book" {
		t.Fatalf("lookahead page skipped or exposed a row: %+v %v", page, err)
	}
	if *page.Events[0].EventSigB64 != "signature" || *page.Events[0].AccountID != "author" {
		t.Fatal("page lost original author material")
	}
	empty := &enabledCurrencySnapshotRows{}
	page, err = readPersonNotePage(t.Context(), personNotePageQuery{t: t, rows: empty, limit: 1000, after: 300}, "book", 300, 999999)
	if err != nil || page.HasMore || page.Events == nil || len(page.Events) != 0 || page.NextAfterServerSeq != 300 {
		t.Fatalf("empty final page or maximum page bound is wrong: %+v %v", page, err)
	}
	if _, err := readPersonNotePage(t.Context(), nil, "book", -1, 200); err == nil {
		t.Fatal("negative recovery cursor accepted")
	}
}

func personNotesRequest(t *testing.T, handler *Handler, account, device, query string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/sync/person-notes?"+query, nil)
	if account != "" {
		token, err := auth.SignSession(testJWTSecret, account, device, "google", "test")
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("X-Kaata-Currencies", "1")
	req.Header.Set("X-Kaata-Entry-Currency-Edit", "1")
	rec := httptest.NewRecorder()
	auth.RequireSession(testJWTSecret)(http.HandlerFunc(handler.PersonNotes)).ServeHTTP(rec, req)
	return rec
}

func TestPersonNoteRecoveryRequiresAuthenticationAndValidPage(t *testing.T) {
	h := NewHandler(nil)
	if got := personNotesRequest(t, h, "", "", "vault_id="+uuid.NewString()).Code; got != http.StatusUnauthorized {
		t.Fatalf("anonymous staff notes: %d", got)
	}
	for _, query := range []string{"", "vault_id=invalid", "vault_id=" + uuid.NewString() + "&after_server_seq=-1", "vault_id=" + uuid.NewString() + "&limit=0", "vault_id=" + uuid.NewString() + "&limit=no", "vault_id=" + uuid.NewString() + "&after_server_seq=NaN"} {
		if rec := personNotesRequest(t, h, uuid.NewString(), uuid.NewString(), query); rec.Code != http.StatusBadRequest {
			t.Fatalf("invalid staff-note page %s: %d", query, rec.Code)
		}
	}
}

func TestPersonNoteRecoveryHTTPPreservesSignaturesAndMembership(t *testing.T) {
	f := newM2Fixture(t)
	ctx := t.Context()
	rel := uuid.NewString()
	user := uuid.NewString()
	person := f.membershipEvent(EventPersonAdded, f.anchorDeviceID, f.ownerAcct, user, map[string]any{"user_id": user, "name": "Customer", "phone_e164": nil, "relationship_context": "peer"})
	person.RelationshipID = &rel
	f.signEvent(t, &person, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, person), 1)
	signed := []PushEvent{}
	for _, note := range []any{"با برادرش تماس بگیرید.\nDeliver after 5 💬", nil} {
		event := f.membershipEvent(EventPersonNoteSet, f.anchorDeviceID, f.ownerAcct, rel, map[string]any{"note": note})
		event.RelationshipID = &rel
		f.signEvent(t, &event, f.anchorPriv)
		requireAccepted(t, f.pushAs(t, f.ownerAcct, event), 1)
		signed = append(signed, event)
	}
	// Irrelevant history must never be included by the metadata-only stream.
	entry := f.membershipEvent(EventEntryCreated, f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{})
	entry.RelationshipID = &rel
	requireAccepted(t, f.pushAs(t, f.ownerAcct, entry), 1)
	redacted := f.membershipEvent(EventPersonNoteSet, f.anchorDeviceID, f.ownerAcct, rel, map[string]any{"note": "redacted staff note"})
	redacted.RelationshipID = &rel
	f.signEvent(t, &redacted, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, redacted), 1)
	if _, err := f.pool.Exec(ctx, "UPDATE events SET redacted_at=NOW() WHERE event_id=$1::uuid", redacted.EventID); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(f.svc)
	query := "vault_id=" + f.vaultID + "&limit=1"
	var last int64
	for i, want := range signed {
		rec := personNotesRequest(t, h, f.ownerAcct, f.anchorDeviceID, query+"&after_server_seq="+strconv.FormatInt(last, 10))
		if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("owner recovery failed: %d %s", rec.Code, rec.Body.String())
		}
		var page PersonNotesResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		if len(page.Events) != 1 || page.Events[0].EventID != want.EventID || page.HasMore != (i == 0) || page.NextAfterServerSeq <= last {
			t.Fatalf("wrong signed metadata page: %+v", page)
		}
		got := page.Events[0]
		canonical, err := canonicalSignableEvent(f.vaultID, &PushEvent{EventID: got.EventID, EventType: got.EventType, SchemaVersion: got.SchemaVersion,
			HLC: PushHLC{PhysicalMS: got.HLC.PMS, Logical: got.HLC.L, DeviceID: got.HLC.DID}, TargetID: got.TargetID, RelationshipID: got.RelationshipID,
			ActorAccountID: got.AccountID, AuthorSeq: got.AuthorSeq, Payload: got.Payload})
		if err != nil || got.EventSigB64 == nil || *got.EventSigB64 != *want.EventSigB64 {
			t.Fatal("note recovery rewrote signature authority")
		}
		signature, err := base64.StdEncoding.DecodeString(*got.EventSigB64)
		if err != nil || !ed25519.Verify(f.anchorPub, canonical, signature) {
			t.Fatal("recovered staff note no longer verifies")
		}
		last = page.NextAfterServerSeq
	}
	outsider := f.seedAccount(t, "outsider@example.test")
	if rec := personNotesRequest(t, h, outsider, uuid.NewString(), query); rec.Code != http.StatusForbidden || strings.Contains(rec.Body.String(), "Deliver") {
		t.Fatal("a nonmember/shared contact could obtain private staff notes")
	}
	for _, role := range []string{"viewer", "clerk", "editor", "manager"} {
		member := f.seedAccount(t, role+"@example.test")
		if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1::uuid,$2::uuid,$3,NOW())`, f.vaultID, member, role); err != nil {
			t.Fatal(err)
		}
		if rec := personNotesRequest(t, h, member, uuid.NewString(), query); rec.Code != http.StatusOK {
			t.Fatalf("%s cannot read instructions: %d", role, rec.Code)
		}
		if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, member); err != nil {
			t.Fatal(err)
		}
		if rec := personNotesRequest(t, h, member, uuid.NewString(), query); rec.Code != http.StatusForbidden {
			t.Fatalf("revoked %s retained recovery access: %d", role, rec.Code)
		}
	}
}
