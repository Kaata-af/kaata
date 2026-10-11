package sync

import (
	"encoding/json"
	"testing"
)

func groupTestEvent(kind, target string, payload any, pms int64, vault, relationship string) LedgerEvent {
	raw, _ := json.Marshal(payload)
	e := LedgerEvent{EventID: kind + target, EventType: kind, VaultID: vault, TargetID: target,
		HLC: HLC{PMS: pms, DID: "test"}, Payload: raw}
	if relationship != "" {
		e.RelationshipID = &relationship
	}
	return e
}
func TestCustomerGroupsProjectionAndSnapshot(t *testing.T) {
	events := []LedgerEvent{
		groupTestEvent(EventPersonAdded, "u", map[string]any{"user_id": "u", "name": "Amir", "relationship_context": "peer"}, 1, "v", "r"),
		groupTestEvent(EventGroupCreated, "g", map[string]any{"name": " خانه\u200cگی "}, 10, "v", ""),
		groupTestEvent(EventGroupRenamed, "g", map[string]any{"name": "Family"}, 30, "v", ""),
		groupTestEvent(EventGroupRenamed, "g", map[string]any{"name": "Older"}, 20, "v", ""),
		groupTestEvent(EventGroupCreated, "g", map[string]any{"name": "Duplicate"}, 35, "v", ""),
		groupTestEvent(EventPersonGroupSet, "r", map[string]any{"group_id": "g"}, 40, "v", "r"),
		groupTestEvent(EventGroupArchived, "g", map[string]any{}, 50, "v", ""),
	}
	p, err := ApplyEvents(events)
	if err != nil {
		t.Fatal(err)
	}
	if p.CustomerGroups["g"].Name != "Family" || p.CustomerGroups["g"].ArchivedAt == nil {
		t.Fatalf("rename/archive lost: %+v", p.CustomerGroups["g"])
	}
	if p.Relationships["r"].GroupID == nil || *p.Relationships["r"].GroupID != "g" {
		t.Fatal("archive must keep dormant assignment")
	}
	if p.Relationships["r"].UpdatedAt != 1 {
		t.Fatal("classification must not advance legacy archive snapshot floor")
	}
	raw, err := ProjectionToJSON(p)
	if err != nil {
		t.Fatal(err)
	}
	var restored Projection
	if err = json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	rels, groups := projectRelationships(restored.Relationships), projectCustomerGroups(restored.CustomerGroups)
	if len(rels) != 1 || len(groups) != 1 || rels[0].GroupFieldHLCs["group_id"].PMS != 40 || groups[0].FieldHLCs["name"].PMS != 30 {
		t.Fatal("exact snapshot registers missing")
	}
	newer := groupTestEvent(EventPersonGroupSet, "r", map[string]any{"group_id": nil}, 60, "v", "r")
	newer.HLC.L = 7
	if err = applyPersonGroupSet(&restored, &newer); err != nil {
		t.Fatal(err)
	}
	old := groupTestEvent(EventPersonGroupSet, "r", map[string]any{"group_id": "g"}, 55, "v", "r")
	if err = applyPersonGroupSet(&restored, &old); err != nil {
		t.Fatal(err)
	}
	if restored.Relationships["r"].GroupID != nil {
		t.Fatal("stale arrival overwrote newer ungrouping")
	}
	if max := snapshotMaxHLC(&restored, nil); CompareHLC(max, newer.HLC) != 0 {
		t.Fatalf("snapshot frontier lost exact assignment HLC: %+v", max)
	}
	foreign := groupTestEvent(EventPersonGroupSet, "r", map[string]any{"group_id": "g"}, 70, "other", "r")
	if err = applyPersonGroupSet(&restored, &foreign); err == nil {
		t.Fatal("foreign kaata assignment accepted")
	}
	malformed := groupTestEvent(EventPersonGroupSet, "r", map[string]any{}, 70, "v", "r")
	if err = applyPersonGroupSet(&restored, &malformed); err == nil {
		t.Fatal("omitted group_id interpreted as a removal")
	}
	if normalizeGroupName(" خانه\u200cگی \n ") != "خانه\u200cگی" {
		t.Fatal("Dari ZWNJ was stripped")
	}
	if normalizeGroupName("\ufeff Test \u202e\tGroup\ufeff") != "Test Group" {
		t.Fatal("labels must normalize controls/bidi and whitespace")
	}
}

func TestCustomerGroupsPermissions(t *testing.T) {
	for _, kind := range []string{EventGroupCreated, EventGroupRenamed, EventGroupArchived, EventPersonGroupSet} {
		for _, role := range []string{"viewer", "clerk", "editor", "manager", "owner"} {
			expected := role == "editor" || role == "manager" || role == "owner"
			if got := CheckEventPermissionByRole(role, kind); got != expected {
				t.Fatalf("%s %s allowed=%v", role, kind, got)
			}
		}
	}
}
