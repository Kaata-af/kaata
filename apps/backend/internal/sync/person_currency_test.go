package sync

import (
	"encoding/json"
	"testing"
)

func personCurrencyProjection(t *testing.T) Projection {
	t.Helper()
	p, err := ApplyEvents([]LedgerEvent{groupTestEvent(EventPersonAdded, "u", map[string]any{
		"user_id": "u", "name": "Amir", "relationship_context": "peer",
	}, 1, "v", "r")})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPersonDefaultCurrencyProjection(t *testing.T) {
	p := personCurrencyProjection(t)
	usd := groupTestEvent(EventPersonDefaultCurrencySet, "r", map[string]any{"currency": "USD"}, 20, "v", "r")
	if err := applyOne(&p, &usd); err != nil {
		t.Fatal(err)
	}
	if got := p.Relationships["r"].DefaultEntryCurrency; got == nil || *got != "USD" {
		t.Fatal("USD preference not projected")
	}
	clear := groupTestEvent(EventPersonDefaultCurrencySet, "r", map[string]any{"currency": nil}, 30, "v", "r")
	if err := applyOne(&p, &clear); err != nil {
		t.Fatal(err)
	}
	encoded, err := ProjectionToJSON(p)
	if err != nil {
		t.Fatal(err)
	}
	var restored Projection
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	if err := applyOne(&restored, &usd); err != nil {
		t.Fatal(err)
	}
	rel := restored.Relationships["r"]
	if rel.DefaultEntryCurrency != nil || rel.CurrencyFieldHLC == nil || rel.CurrencyFieldHLC.PMS != 30 {
		t.Fatalf("older USD resurrected after serialized null reset: %+v", rel)
	}
	if len(p.Entries) != 0 || p.Users["u"].DisplayName != "Amir" || rel.UpdatedAt != 1 {
		t.Fatal("preference changed unrelated contact/financial state")
	}
}

func TestPersonDefaultCurrencyValidation(t *testing.T) {
	for _, raw := range []string{`{}`, `null`, `[]`, `{"currency":false}`, `{"currency":123}`, `{"currency":"usd"}`, `{"currency":"US"}`, `{"currency":" USD"}`, `{"currency":{}}`} {
		t.Run(raw, func(t *testing.T) {
			p := personCurrencyProjection(t)
			e := groupTestEvent(EventPersonDefaultCurrencySet, "r", nil, 20, "v", "r")
			e.Payload = json.RawMessage(raw)
			if err := validatePersonDefaultCurrencyPayload(e.Payload); err == nil {
				t.Fatal("accepted invalid payload")
			}
			if err := applyOne(&p, &e); err == nil {
				t.Fatal("projection accepted invalid payload")
			}
			if p.Relationships["r"].CurrencyFieldHLC != nil {
				t.Fatal("invalid event changed field")
			}
		})
	}
	for _, raw := range []string{`{"currency":"USD"}`, `{"currency":"AFN"}`, `{"currency":null}`} {
		if err := validatePersonDefaultCurrencyPayload(json.RawMessage(raw)); err != nil {
			t.Fatalf("valid payload: %v", err)
		}
	}
	for _, fixture := range []struct{ target, vault, relationship string }{
		{"r", "other", "r"}, {"other", "v", "r"}, {"r", "v", ""}, {"missing", "v", "missing"}, {"r", "", "r"},
	} {
		p := personCurrencyProjection(t)
		e := groupTestEvent(EventPersonDefaultCurrencySet, fixture.target, map[string]any{"currency": "USD"}, 20, fixture.vault, fixture.relationship)
		if err := applyOne(&p, &e); err == nil {
			t.Fatalf("accepted wrong scope %+v", fixture)
		}
		if p.Relationships["r"].CurrencyFieldHLC != nil {
			t.Fatal("wrong scope changed field")
		}
	}
}

func TestPersonDefaultCurrencyPermissions(t *testing.T) {
	for _, role := range []string{"viewer", "clerk", "editor", "manager", "owner"} {
		want := role == "editor" || role == "manager" || role == "owner"
		if got := CheckEventPermissionByRole(role, EventPersonDefaultCurrencySet); got != want {
			t.Fatalf("role %s allowed=%v want=%v", role, got, want)
		}
	}
}

func TestPersonDefaultCurrencyPushTarget(t *testing.T) {
	r, other := "r", "other"
	valid := PushEvent{EventType: EventPersonDefaultCurrencySet, TargetID: &r, RelationshipID: &r, Payload: json.RawMessage(`{"currency":null}`)}
	if err := validatePersonDefaultCurrencyPushEvent(valid); err != nil {
		t.Fatal(err)
	}
	for _, event := range []PushEvent{
		{RelationshipID: &r, Payload: valid.Payload},
		{TargetID: &r, Payload: valid.Payload},
		{TargetID: &r, RelationshipID: &other, Payload: valid.Payload},
	} {
		if err := validatePersonDefaultCurrencyPushEvent(event); err == nil {
			t.Fatal("accepted mismatched push target")
		}
	}
}
