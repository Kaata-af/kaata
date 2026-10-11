package sync

import (
	"encoding/json"
	"errors"
	"golang.org/x/text/unicode/norm"
	"strings"
	"unicode"
	"unicode/utf8"
)

type CustomerGroupProjection struct {
	ID         string         `json:"id"`
	VaultID    string         `json:"vault_id"`
	Name       string         `json:"name"`
	CreatedAt  int64          `json:"created_at"`
	UpdatedAt  int64          `json:"updated_at"`
	ArchivedAt *int64         `json:"archived_at"`
	FieldHLCs  map[string]HLC `json:"field_hlcs"`
}

func normalizeGroupName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == 0xfeff || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return ' '
		}
		return r
	}, norm.NFC.String(name))
	return strings.Join(strings.Fields(name), " ")
}

func applyCustomerGroup(p *Projection, e *LedgerEvent) error {
	if e.VaultID == "" || e.TargetID == "" {
		return errors.New("group missing vault/target")
	}
	if p.CustomerGroups == nil {
		p.CustomerGroups = map[string]*CustomerGroupProjection{}
	}
	group := p.CustomerGroups[e.TargetID]
	if group != nil && group.VaultID != e.VaultID {
		return errors.New("group vault mismatch")
	}
	var payload struct {
		Name string `json:"name"`
	}
	if e.EventType != EventGroupArchived {
		if err := json.Unmarshal(e.Payload, &payload); err != nil {
			return err
		}
		payload.Name = normalizeGroupName(payload.Name)
		if n := utf8.RuneCountInString(payload.Name); n < 1 || n > 40 {
			return errors.New("invalid group name")
		}
	}
	if e.EventType == EventGroupCreated {
		if group != nil {
			return nil
		}
		p.CustomerGroups[e.TargetID] = &CustomerGroupProjection{ID: e.TargetID, VaultID: e.VaultID,
			Name: payload.Name, CreatedAt: e.HLC.PMS, UpdatedAt: e.HLC.PMS, FieldHLCs: map[string]HLC{"name": e.HLC}}
		return nil
	}
	if group == nil {
		return errors.New("group missing")
	}
	if group.FieldHLCs == nil {
		group.FieldHLCs = map[string]HLC{}
	}
	field := "name"
	if e.EventType == EventGroupArchived {
		field = "archived_at"
	}
	if old, ok := group.FieldHLCs[field]; ok && CompareHLC(e.HLC, old) <= 0 {
		return nil
	}
	group.FieldHLCs[field] = e.HLC
	if e.EventType == EventGroupArchived {
		ts := e.HLC.PMS
		group.ArchivedAt = &ts
	} else {
		group.Name = payload.Name
	}
	if e.HLC.PMS > group.UpdatedAt {
		group.UpdatedAt = e.HLC.PMS
	}
	return nil
}

func applyPersonGroupSet(p *Projection, e *LedgerEvent) error {
	if e.VaultID == "" || e.RelationshipID == nil || *e.RelationshipID != e.TargetID {
		return errors.New("group assignment target mismatch")
	}
	rel := p.Relationships[e.TargetID]
	if rel == nil || rel.VaultID != e.VaultID {
		return errors.New("group relationship missing in vault")
	}
	if old, ok := rel.GroupFieldHLCs["group_id"]; ok && CompareHLC(e.HLC, old) <= 0 {
		return nil
	}
	var payload struct {
		GroupID json.RawMessage `json:"group_id"`
	}
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return err
	}
	if len(payload.GroupID) == 0 {
		return errors.New("group_id missing")
	}
	var groupID *string
	if err := json.Unmarshal(payload.GroupID, &groupID); err != nil {
		return err
	}
	if groupID != nil {
		group := p.CustomerGroups[*groupID]
		if group == nil || group.VaultID != e.VaultID {
			return errors.New("group missing in vault")
		}
	}
	rel.GroupID = groupID
	rel.GroupFieldHLCs = map[string]HLC{"group_id": e.HLC}
	return nil
}

func projectCustomerGroups(in map[string]*CustomerGroupProjection) []CustomerGroupProjection {
	out := make([]CustomerGroupProjection, 0, len(in))
	for _, g := range in {
		out = append(out, *g)
	}
	return out
}
