package sync

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPersonNoteRelationshipScopeAndRecovery(t *testing.T) {
	p := personCurrencyProjection(t)
	// The same user can appear in another Kaata. Their staff notes must not
	// follow an identity edit or become visible to the other book's staff.
	p.Relationships["other"] = &RelationshipProjection{ID: "other", VaultID: "other-book", UserBID: "u"}
	note := "با برادرش تماس بگیرید.\nDeliver after 5 — 💬"
	e := groupTestEvent(EventPersonNoteSet, "r", map[string]any{"note": note}, 20, "v", "r")
	originalPayload := string(e.Payload)
	if err := applyOne(&p, &e); err != nil {
		t.Fatal(err)
	}
	if p.Relationships["r"].Note == nil || *p.Relationships["r"].Note != note {
		t.Fatal("multiline customer instructions lost")
	}
	if p.Relationships["other"].Note != nil || p.Users["u"].DisplayName != "Amir" || len(p.Entries) != 0 {
		t.Fatal("staff note changed global identity, another Kaata, or financial data")
	}
	if string(e.Payload) != originalPayload || p.Relationships["r"].UpdatedAt != 1 {
		t.Fatal("note rewrote signed bytes or financial activity")
	}
	raw, err := ProjectionToJSON(p)
	if err != nil {
		t.Fatal(err)
	}
	var restored Projection
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if got := restored.Relationships["r"].Note; got == nil || *got != note {
		t.Fatal("cached projection lost note")
	}
	clear := groupTestEvent(EventPersonNoteSet, "r", map[string]any{"note": nil}, 30, "v", "r")
	if err := applyOne(&restored, &clear); err != nil {
		t.Fatal(err)
	}
	raw, _ = ProjectionToJSON(restored)
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	for _, stale := range []LedgerEvent{e, groupTestEvent(EventPersonNoteSet, "r", map[string]any{"note": "same-clock"}, 30, "v", "r")} {
		if err := applyOne(&restored, &stale); err != nil {
			t.Fatal(err)
		}
	}
	r := restored.Relationships["r"]
	if r.Note != nil || r.NoteFieldHLC == nil || r.NoteFieldHLC.PMS != 30 {
		t.Fatal("cleared note resurrected after recovery or stale sync")
	}
	if got := snapshotMaxHLC(&restored, nil); CompareHLC(got, clear.HLC) != 0 {
		t.Fatal("note clear missing from clock frontier")
	}
	// Recovery cannot grant authority by copying an unsigned scalar value.
	unsigned, _ := json.Marshal(projectRelationships(p.Relationships))
	users, _ := json.Marshal(projectUsers(p.Users))
	if strings.Contains(string(unsigned), "note") || strings.Contains(string(users), "Deliver") {
		t.Fatal("private note escaped its signed relationship event recovery")
	}
}

func TestPersonNoteValidationAndPermission(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `[]`, `{"note":1}`, `{"note":false}`, `{"note":{}}`, `{"note":[]}`} {
		p := personCurrencyProjection(t)
		e := groupTestEvent(EventPersonNoteSet, "r", nil, 2, "v", "r")
		e.Payload = json.RawMessage(body)
		if err := applyOne(&p, &e); err == nil || p.Relationships["r"].NoteFieldHLC != nil {
			t.Fatalf("malformed note accepted or changed state: %s", body)
		}
	}
	for _, note := range []any{nil, "", "  Preserve signed whitespace  ", strings.Repeat("ت", 2000), strings.Repeat("💬", 2000)} {
		raw, _ := json.Marshal(map[string]any{"note": note})
		if _, err := decodePersonNote(raw); err != nil {
			t.Fatalf("valid Unicode note rejected: %v", err)
		}
	}
	for _, letter := range []string{"a", "ت", "💬"} {
		raw, _ := json.Marshal(map[string]any{"note": strings.Repeat(letter, 2001)})
		if _, err := decodePersonNote(raw); err == nil {
			t.Fatal("oversize note accepted")
		}
	}
	for _, scope := range []struct{ target, vault, relationship string }{
		{"r", "other", "r"}, {"other", "v", "r"}, {"r", "v", ""}, {"missing", "v", "missing"}, {"r", "", "r"},
	} {
		p := personCurrencyProjection(t)
		e := groupTestEvent(EventPersonNoteSet, scope.target, map[string]any{"note": "secret"}, 2, scope.vault, scope.relationship)
		if err := applyOne(&p, &e); err == nil || p.Relationships["r"].NoteFieldHLC != nil {
			t.Fatalf("wrong relationship or Kaata accepted: %+v", scope)
		}
	}
	for _, role := range []string{"viewer", "clerk", "editor", "manager", "owner", "unknown"} {
		want := role == "editor" || role == "manager" || role == "owner"
		if got := CheckEventPermissionByRole(role, EventPersonNoteSet); got != want {
			t.Fatalf("role %s note-write permission=%v want=%v", role, got, want)
		}
	}
	r, other := "r", "other"
	signature := base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	pubkey := base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))
	for _, e := range []PushEvent{
		{TargetID: &r, Payload: json.RawMessage(`{"note":null}`)},
		{RelationshipID: &r, Payload: json.RawMessage(`{"note":null}`)},
		{TargetID: &r, RelationshipID: &other, Payload: json.RawMessage(`{"note":null}`)},
		{TargetID: &r, RelationshipID: &r, Payload: json.RawMessage(`{"note":true}`)},
		{TargetID: &r, RelationshipID: &r, Payload: json.RawMessage(`{"note":null}`)},
		{TargetID: &r, RelationshipID: &r, Payload: json.RawMessage(`{"note":null}`), EventSigB64: &signature},
		{TargetID: &r, RelationshipID: &r, Payload: json.RawMessage(`{"note":null}`), SignerDevicePubkeyB64: &pubkey},
	} {
		if err := validatePersonNotePushEvent(e); err == nil {
			t.Fatal("malformed push note accepted")
		}
	}
	if err := validatePersonNotePushEvent(PushEvent{TargetID: &r, RelationshipID: &r, Payload: json.RawMessage(`{"note":null}`), EventSigB64: &signature, SignerDevicePubkeyB64: &pubkey}); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	new(Handler).CurrencyCapabilities(response, httptest.NewRequest("GET", "/", nil))
	var caps map[string]bool
	if err := json.Unmarshal(response.Body.Bytes(), &caps); err != nil || !caps["person_notes"] {
		t.Fatal("notes capability missing")
	}
}

func TestPersonNotePrivateLedgerReadAndOtherEdits(t *testing.T) {
	p := personCurrencyProjection(t)
	e := groupTestEvent(EventPersonNoteSet, "r", map[string]any{"note": "Call before giving credit"}, 2, "v", "r")
	if err := applyOne(&p, &e); err != nil {
		t.Fatal(err)
	}
	// Existing clients continue to send only name/phone changes. Neither may
	// erase a staff note authored by an updated device.
	for _, e := range []LedgerEvent{
		groupTestEvent(EventPersonRenamed, "u", map[string]any{"name": "New name"}, 3, "v", "r"),
		groupTestEvent(EventPersonPhoneChanged, "u", map[string]any{"phone_e164": "+93700123456"}, 4, "v", "r"),
	} {
		if err := applyOne(&p, &e); err != nil {
			t.Fatal(err)
		}
	}
	view := &WebLedger{LegacyCurrency: "AFN", DefaultEntryCurrency: "AFN"}
	if err := populateWebLedger(view, &p, nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(view.People) != 1 || view.People[0].Note == nil || *view.People[0].Note != "Call before giving credit" || view.People[0].Name != "New name" {
		t.Fatal("private ledger lost note or existing edits")
	}
}
