package sync

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestWebPersonNoteHistoryRejectsUnscopedOrMalformedCursor(t *testing.T) {
	vault, rel := uuid.NewString(), uuid.NewString()
	valid := webNoteCursor{VaultID: vault, RelationshipID: rel, HLC: HLC{PMS: 123, L: 2, DID: uuid.NewString()}, EventID: uuid.NewString()}
	encode := func(cursor webNoteCursor) string {
		raw, _ := json.Marshal(cursor)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	if got, err := parseWebNoteCursor(encode(valid), vault, rel); err != nil || *got != valid {
		t.Fatalf("valid cursor: %+v %v", got, err)
	}
	for _, raw := range []string{"!", strings.Repeat("a", 1025), base64.RawURLEncoding.EncodeToString([]byte(`{}`))} {
		if _, err := parseWebNoteCursor(raw, vault, rel); err == nil {
			t.Fatal("invalid cursor accepted")
		}
	}
	for _, mutate := range []func(*webNoteCursor){
		func(c *webNoteCursor) { c.VaultID = uuid.NewString() }, func(c *webNoteCursor) { c.RelationshipID = uuid.NewString() },
		func(c *webNoteCursor) { c.HLC.PMS = -1 }, func(c *webNoteCursor) { c.HLC.PMS = maxJavaScriptSafeInteger + 1 },
		func(c *webNoteCursor) { c.HLC.L = -1 }, func(c *webNoteCursor) { c.HLC.DID = "invalid" }, func(c *webNoteCursor) { c.EventID = "invalid" },
	} {
		candidate := valid
		mutate(&candidate)
		if _, err := parseWebNoteCursor(encode(candidate), vault, rel); err == nil {
			t.Fatalf("unsafe cursor accepted: %+v", candidate)
		}
	}
	h := NewHandler(nil)
	for _, query := range []string{
		"vault_id=" + vault + "&relationship_id=invalid", "vault_id=invalid&relationship_id=" + rel,
		"vault_id=" + vault + "&relationship_id=" + rel + "&cursor=invalid",
		"vault_id=" + vault + "&relationship_id=" + rel + "&relationship_id=" + rel,
		"vault_id=" + vault + "&relationship_id=" + rel + "&after_server_seq=0",
	} {
		if response := personNotesRequest(t, h, uuid.NewString(), uuid.NewString(), query); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid scoped request status %d", response.Code)
		}
	}
}

func TestWebPersonNoteHistoryIsScopedHLCOrderedAndPrivate(t *testing.T) {
	f := newM2Fixture(t)
	rel, user := uuid.NewString(), uuid.NewString()
	person := f.membershipEvent(EventPersonAdded, f.anchorDeviceID, f.ownerAcct, user, map[string]any{"user_id": user, "name": "Customer", "phone_e164": nil})
	person.RelationshipID = &rel
	f.signEvent(t, &person, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, person), 1)
	notes := []PushEvent{}
	for i := 0; i < 52; i++ {
		var value any = "Private staff instruction"
		if i == 51 {
			value = nil
		}
		event := f.membershipEvent(EventPersonNoteSet, f.anchorDeviceID, f.ownerAcct, rel, map[string]any{"note": value})
		event.RelationshipID = &rel
		f.signEvent(t, &event, f.anchorPriv)
		notes = append(notes, event)
	}
	// Network arrival order differs from author order. History and the winning
	// revision must follow signed HLC, never the newest receipt/server sequence.
	for i := len(notes) - 1; i >= 0; i-- {
		requireAccepted(t, f.pushAs(t, f.ownerAcct, notes[i]), 1)
	}
	h := NewHandler(f.svc)
	query := "vault_id=" + f.vaultID + "&relationship_id=" + rel
	read := func(account, suffix string) WebPersonNoteHistory {
		response := personNotesRequest(t, h, account, f.anchorDeviceID, query+suffix)
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("history failed: %d %s", response.Code, response.Body.String())
		}
		var page WebPersonNoteHistory
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	page := read(f.ownerAcct, "")
	if len(page.Entries) != 50 || !page.HasMore || page.NextCursor == nil || page.Entries[0].EventID != notes[51].EventID || page.Entries[0].Note != nil || page.Entries[49].EventID != notes[2].EventID {
		t.Fatalf("wrong newest page: %+v", page)
	}
	for _, revision := range page.Entries {
		if revision.Actor != nil {
			t.Fatal("claimed actor surfaced as verified author")
		}
	}
	last := read(f.ownerAcct, "&cursor="+url.QueryEscape(*page.NextCursor))
	if len(last.Entries) != 2 || last.HasMore || last.NextCursor != nil || last.Entries[0].EventID != notes[1].EventID || last.Entries[1].EventID != notes[0].EventID {
		t.Fatalf("wrong continuation: %+v", last)
	}
	view, err := f.svc.WebLedger(t.Context(), f.ownerAcct, f.anchorDeviceID, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.People) != 1 || view.People[0].Note != nil || view.People[0].NoteEventID == nil || *view.People[0].NoteEventID != notes[51].EventID || view.People[0].NoteHLC == nil || view.People[0].NoteHLC.PMS != notes[51].HLC.PhysicalMS {
		t.Fatalf("ledger winner follows receipt rather than signed register: %+v", view.People)
	}
	otherQuery := "vault_id=" + f.vaultID + "&relationship_id=" + uuid.NewString()
	response := personNotesRequest(t, h, f.ownerAcct, f.anchorDeviceID, otherQuery)
	var empty WebPersonNoteHistory
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &empty) != nil || len(empty.Entries) != 0 {
		t.Fatal("history leaked into another relationship")
	}
	if response = personNotesRequest(t, h, f.ownerAcct, f.anchorDeviceID, otherQuery+"&cursor="+url.QueryEscape(*page.NextCursor)); response.Code != 400 {
		t.Fatal("cross-relationship cursor accepted")
	}
	outsider := f.seedAccount(t, "notes-outsider@example.test")
	if response = personNotesRequest(t, h, outsider, uuid.NewString(), query); response.Code != 403 || strings.Contains(response.Body.String(), "Private staff instruction") {
		t.Fatal("outsider can read staff notes")
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1::uuid,$2::uuid,'viewer',NOW())`, f.vaultID, outsider); err != nil {
		t.Fatal(err)
	}
	read(outsider, "")
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, outsider); err != nil {
		t.Fatal(err)
	}
	if response = personNotesRequest(t, h, outsider, uuid.NewString(), query); response.Code != 403 {
		t.Fatal("revoked reader retains note access")
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE events SET redacted_at=NOW() WHERE event_id=$1::uuid`, notes[51].EventID); err != nil {
		t.Fatal(err)
	}
	if got := read(f.ownerAcct, ""); got.Entries[0].EventID == notes[51].EventID {
		t.Fatal("redacted history returned")
	}
}

func TestWebLedgerNoteRegisterAndDisputedExposureMetadata(t *testing.T) {
	p := NewProjection()
	p.Users["u"] = &UserProjection{ID: "u", DisplayName: "Customer"}
	note := "Private instruction"
	clock := HLC{PMS: 20, L: 1, DID: "device"}
	p.Relationships["r"] = &RelationshipProjection{ID: "r", UserBID: "u", Note: &note, NoteFieldHLC: &clock}
	disputed := int64(30)
	p.Entries["e"] = &EntryProjection{ID: "e", RelationshipID: "r", Type: "debt", AmountAFN: json.Number("100"), DisputedAt: &disputed}
	rel := "r"
	events := []LedgerEvent{{EventID: "winner", EventType: EventPersonNoteSet, TargetID: "r", RelationshipID: &rel, HLC: clock, Payload: json.RawMessage(`{"note":"Private instruction"}`)}}
	view := &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "AFN"}
	if err := populateWebLedger(view, &p, events, nil); err != nil {
		t.Fatal(err)
	}
	if !view.CreditBalancesComplete || view.Entries[0].DisputedAt == nil || !view.Entries[0].ReadOnly || view.People[0].NoteEventID == nil || *view.People[0].NoteEventID != "winner" {
		t.Fatalf("missing exact financial/note metadata: %+v", view)
	}
	duplicate := events[0]
	duplicate.EventID = "same-clock"
	view = &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "AFN"}
	if err := populateWebLedger(view, &p, append(events, duplicate), nil); err != nil {
		t.Fatal(err)
	}
	if view.People[0].NoteEventID != nil || *view.People[0].NoteHLC != clock {
		t.Fatal("ambiguous equal-clock note guessed a winning event")
	}
}
