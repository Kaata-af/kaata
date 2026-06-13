// Package sync — server-side projection of the append-only event log into
// queryable state. This file is the Go counterpart of the TypeScript appliers
// in apps/mobile/lib/projection/.
//
// Invariant (the "server-projection equivalence" rule from the plan): given
// the same event stream, ApplyEvents MUST produce a projection whose
// serialized form is equivalent to the TS projection. The shared conformance
// corpus at apps/_shared/projection-corpus/ is the regression net.
//
// Merge semantics:
//   - Events are totally ordered by HLC ascending (CompareHLC: pms, l, did).
//   - Mutable fields are last-write-wins by HLC.
//   - Deletes are STICKY tombstones — once is_deleted, no later amend revives.
//   - Amend payloads are DELTAS; only fields the author explicitly set are
//     considered for LWW. A concurrent amend on a different field survives.
//   - account_bound is a state-side no-op locally; the projection itself is
//     identity-blind.
//   - person_archived flips relationship.archived_at AND nulls users.phone_e164
//     if no other active (non-archived) relationship references the user.
package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// ---------- HLC ----------

// HLC mirrors apps/mobile/lib/hlc.ts. JSON tags use the short field names
// the TS side emits ("pms"/"l"/"did") because the corpus fixtures encode
// HLCs in that exact shape.
type HLC struct {
	PMS int64  `json:"pms"`
	L   int64  `json:"l"`
	DID string `json:"did"`
}

// CompareHLC totally orders two HLCs: primary by physical_ms, secondary by
// logical, tertiary by device id (lexicographic). Mirrors compareHLC() in
// hlc.ts byte-for-byte.
func CompareHLC(a, b HLC) int {
	if a.PMS != b.PMS {
		if a.PMS < b.PMS {
			return -1
		}
		return 1
	}
	if a.L != b.L {
		if a.L < b.L {
			return -1
		}
		return 1
	}
	if a.DID < b.DID {
		return -1
	}
	if a.DID > b.DID {
		return 1
	}
	return 0
}

// ---------- Event envelope ----------

// Known event_type strings. Mirrors KNOWN_EVENT_TYPES in events.ts.
const (
	EventEntryCreated        = "entry_created"
	EventEntryAmended        = "entry_amended"
	EventEntryDeleted        = "entry_deleted"
	EventEntrySettled        = "entry_settled"
	EventPersonAdded         = "person_added"
	EventPersonRenamed       = "person_renamed"
	EventPersonPhoneChanged  = "person_phone_changed"
	EventPersonArchived      = "person_archived"
	EventPersonUnarchived    = "person_unarchived"
	EventShopProfileUpdated  = "shop_profile_updated"
	EventVaultSettingSet     = "vault_setting_set"
	EventVaultMemberAdded    = "vault_member_added"
	EventVaultMemberRoleChng = "vault_member_role_changed"
	EventVaultMemberRemoved  = "vault_member_removed"
	EventVaultDeviceAdded    = "vault_device_added"
	EventVaultDeviceRemoved  = "vault_device_removed"
	EventAccountBound        = "account_bound"
)

// LedgerEvent is the tagged-struct equivalent of the TS discriminated union.
// Payload is kept as json.RawMessage and decoded on demand per event_type.
type LedgerEvent struct {
	EventID               string          `json:"event_id"`
	EventType             string          `json:"event_type"`
	VaultID               string          `json:"vault_id"`
	TargetID              string          `json:"target_id"`
	RelationshipID        *string         `json:"relationship_id,omitempty"`
	HLC                   HLC             `json:"hlc"`
	DeviceID              string          `json:"device_id"`
	AuthorUserIDLocalOnly string          `json:"author_user_id_local_only"`
	ActorAccountID        *string         `json:"actor_account_id"`
	PayloadSchema         int             `json:"payload_schema"`
	Payload               json.RawMessage `json:"payload"`
	// Server-only metadata.
	ServerSeq  int64 `json:"server_seq,omitempty"`
	ReceivedAt int64 `json:"received_at,omitempty"`
}

// ---------- Per-entity payload structs ----------

type entryCreatedPayload struct {
	EntryID                string  `json:"entry_id"`
	RelationshipID         string  `json:"relationship_id"`
	Type                   string  `json:"type"`
	AmountAFN              int64   `json:"amount_afn"`
	Note                   *string `json:"note"`
	OccurredAtMS           int64   `json:"occurred_at_ms"`
	BackfillSynthetic      *bool   `json:"backfill_synthetic,omitempty"`
	BackfillAcceptedAt     *int64  `json:"backfill_accepted_at,omitempty"`
	BackfillDisputedAt     *int64  `json:"backfill_disputed_at,omitempty"`
	BackfillDisputedReason *string `json:"backfill_disputed_reason,omitempty"`
	BackfillSettledAt      *int64  `json:"backfill_settled_at,omitempty"`
}

// entryAmendedChanges uses json.RawMessage per field so we can distinguish
// "field absent from changes" (do not amend) from "field present with null"
// (amend to NULL).
type entryAmendedChanges struct {
	AmountAFN    *int64          `json:"amount_afn,omitempty"`
	Note         json.RawMessage `json:"note,omitempty"`
	Type         *string         `json:"type,omitempty"`
	OccurredAtMS *int64          `json:"occurred_at_ms,omitempty"`
}

type entryAmendedPayload struct {
	Changes           entryAmendedChanges `json:"changes"`
	BackfillSynthetic *bool               `json:"backfill_synthetic,omitempty"`
}

type personAddedPayload struct {
	UserID              string  `json:"user_id"`
	Name                string  `json:"name"`
	PhoneE164           *string `json:"phone_e164"`
	RelationshipContext string  `json:"relationship_context"`
}

type personRenamedPayload struct {
	Name string `json:"name"`
}

type personPhoneChangedPayload struct {
	PhoneE164 *string `json:"phone_e164"`
}

type shopProfileChanges struct {
	ShopName  *string         `json:"shop_name,omitempty"`
	OwnerName json.RawMessage `json:"owner_name,omitempty"`
}

type shopProfilePayload struct {
	Changes shopProfileChanges `json:"changes"`
}

type vaultSettingSetPayload struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type vaultMemberAddedPayload struct {
	AccountID string `json:"account_id"`
	Role      string `json:"role"`
}

type vaultMemberRoleChangedPayload struct {
	AccountID string `json:"account_id"`
	Role      string `json:"role"`
}

type vaultMemberRemovedPayload struct {
	AccountID string `json:"account_id"`
}

// ---------- Projection state ----------

type UserProjection struct {
	ID          string  `json:"id"`
	PhoneE164   *string `json:"phone_e164"`
	DisplayName string  `json:"display_name"`
	IsLocalSelf bool    `json:"is_local_self"`
	GoogleSub   *string `json:"google_sub"`
	AccountID   *string `json:"account_id"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
	ArchivedAt  *int64  `json:"archived_at"`
}

type RelationshipProjection struct {
	ID         string `json:"id"`
	UserAID    string `json:"user_a_id"`
	UserBID    string `json:"user_b_id"`
	Context    string `json:"context"`
	VaultID    string `json:"vault_id"`
	CreatedAt  int64  `json:"created_at"`
	UpdatedAt  int64  `json:"updated_at"`
	ArchivedAt *int64 `json:"archived_at"`
}

type EntryProjection struct {
	ID               string  `json:"id"`
	VaultID          string  `json:"vault_id"`
	RelationshipID   string  `json:"relationship_id"`
	Type             string  `json:"type"`
	AmountAFN        int64   `json:"amount_afn"`
	Note             *string `json:"note"`
	CreatedAt        int64   `json:"created_at"`
	UpdatedAt        int64   `json:"updated_at"`
	DeletedAt        *int64  `json:"deleted_at"`
	ProposedByUserID string  `json:"proposed_by_user_id"`
	AcceptedAt       *int64  `json:"accepted_at"`
	DisputedAt       *int64  `json:"disputed_at"`
	DisputedReason   *string `json:"disputed_reason"`
	SettledAt        *int64  `json:"settled_at"`
	CurrentEventID   string  `json:"current_event_id"`
	IsDeleted        bool    `json:"is_deleted"`
	IsSettled        bool    `json:"is_settled"`

	// Internal LWW bookkeeping. Per-field "winning HLC" so a later event
	// touching a DIFFERENT field doesn't dethrone this field's value. Not
	// serialized; not part of the conformance contract.
	hlcAmount     HLC `json:"-"`
	hlcNote       HLC `json:"-"`
	hlcType       HLC `json:"-"`
	hlcOccurredAt HLC `json:"-"`
}

type ShopProfileProjection struct {
	VaultID   string  `json:"vault_id"`
	ShopName  *string `json:"shop_name"`
	OwnerName *string `json:"owner_name"`
	UpdatedAt int64   `json:"updated_at"`

	hlcShopName  HLC `json:"-"`
	hlcOwnerName HLC `json:"-"`
}

type MemberProjection struct {
	AccountID string `json:"account_id"`
	Role      string `json:"role"`
	AddedAt   int64  `json:"added_at"`
	UpdatedAt int64  `json:"updated_at"`
	RemovedAt *int64 `json:"removed_at"`
}

// Projection is the merged state. Maps are keyed by string ids; encoding/json
// sorts string map keys alphabetically for deterministic output.
type Projection struct {
	Users         map[string]*UserProjection         `json:"users"`
	Relationships map[string]*RelationshipProjection `json:"relationships"`
	Entries       map[string]*EntryProjection        `json:"entries"`
	ShopProfile   *ShopProfileProjection             `json:"shop_profile"`
	Members       map[string]*MemberProjection       `json:"members"`
	VaultSettings map[string]string                  `json:"vault_settings"`
}

// NewProjection returns an empty projection with non-nil maps so JSON output
// is always `{}` rather than `null` for empty collections.
func NewProjection() Projection {
	return Projection{
		Users:         map[string]*UserProjection{},
		Relationships: map[string]*RelationshipProjection{},
		Entries:       map[string]*EntryProjection{},
		ShopProfile:   nil,
		Members:       map[string]*MemberProjection{},
		VaultSettings: map[string]string{},
	}
}

// ---------- ApplyEvents ----------

// ApplyEvents sorts events by HLC ascending and folds them into a fresh
// projection. Caller is responsible for filtering events to one vault.
func ApplyEvents(events []LedgerEvent) (Projection, error) {
	sorted := make([]LedgerEvent, len(events))
	copy(sorted, events)
	sort.SliceStable(sorted, func(i, j int) bool {
		return CompareHLC(sorted[i].HLC, sorted[j].HLC) < 0
	})

	p := NewProjection()
	for i := range sorted {
		if err := applyOne(&p, &sorted[i]); err != nil {
			return Projection{}, fmt.Errorf("apply event %s (%s): %w",
				sorted[i].EventID, sorted[i].EventType, err)
		}
	}
	return p, nil
}

// ApplyEventsOnto folds events into an existing projection, in HLC order.
// Used by the snapshot generator to layer new events on top of a prior
// projected state.
func ApplyEventsOnto(p *Projection, events []LedgerEvent) error {
	sorted := make([]LedgerEvent, len(events))
	copy(sorted, events)
	sort.SliceStable(sorted, func(i, j int) bool {
		return CompareHLC(sorted[i].HLC, sorted[j].HLC) < 0
	})
	for i := range sorted {
		if err := applyOne(p, &sorted[i]); err != nil {
			return fmt.Errorf("apply event %s (%s): %w",
				sorted[i].EventID, sorted[i].EventType, err)
		}
	}
	return nil
}

func applyOne(p *Projection, e *LedgerEvent) error {
	switch e.EventType {
	case EventEntryCreated:
		return applyEntryCreated(p, e)
	case EventEntryAmended:
		return applyEntryAmended(p, e)
	case EventEntryDeleted:
		return applyEntryDeleted(p, e)
	case EventEntrySettled:
		return nil
	case EventPersonAdded:
		return applyPersonAdded(p, e)
	case EventPersonRenamed:
		return applyPersonRenamed(p, e)
	case EventPersonPhoneChanged:
		return applyPersonPhoneChanged(p, e)
	case EventPersonArchived:
		return applyPersonArchived(p, e)
	case EventPersonUnarchived:
		return applyPersonUnarchived(p, e)
	case EventShopProfileUpdated:
		return applyShopProfileUpdated(p, e)
	case EventVaultSettingSet:
		return applyVaultSettingSet(p, e)
	case EventVaultMemberAdded:
		return applyVaultMemberAdded(p, e)
	case EventVaultMemberRoleChng:
		return applyVaultMemberRoleChanged(p, e)
	case EventVaultMemberRemoved:
		return applyVaultMemberRemoved(p, e)
	case EventVaultDeviceAdded, EventVaultDeviceRemoved:
		// M2: device-registry events are a snapshot-projection no-op —
		// the server's operational fold target is the vault_devices table
		// (push path, membership.go), and mobile folds its own registry.
		// Listed here so snapshot replay doesn't fail on unknown types.
		return nil
	case EventAccountBound:
		// State-side no-op; event persists for audit/ACL on server.
		return nil
	default:
		return fmt.Errorf("unknown event_type %q", e.EventType)
	}
}

// ---------- Entry appliers ----------

func applyEntryCreated(p *Projection, e *LedgerEvent) error {
	if e.VaultID == "" {
		return errors.New("entry_created missing envelope vault_id")
	}
	var payload entryCreatedPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode entry_created payload: %w", err)
	}

	entry := &EntryProjection{
		ID:               payload.EntryID,
		VaultID:          e.VaultID,
		RelationshipID:   payload.RelationshipID,
		Type:             payload.Type,
		AmountAFN:        payload.AmountAFN,
		Note:             payload.Note,
		CreatedAt:        payload.OccurredAtMS,
		UpdatedAt:        payload.OccurredAtMS,
		ProposedByUserID: e.AuthorUserIDLocalOnly,
		CurrentEventID:   e.EventID,
		IsDeleted:        false,
		IsSettled:        payload.BackfillSettledAt != nil,
		AcceptedAt:       payload.BackfillAcceptedAt,
		DisputedAt:       payload.BackfillDisputedAt,
		DisputedReason:   payload.BackfillDisputedReason,
		SettledAt:        payload.BackfillSettledAt,
		DeletedAt:        nil,
		hlcAmount:        e.HLC,
		hlcNote:          e.HLC,
		hlcType:          e.HLC,
		hlcOccurredAt:    e.HLC,
	}
	p.Entries[payload.EntryID] = entry
	return nil
}

func applyEntryAmended(p *Projection, e *LedgerEvent) error {
	var payload entryAmendedPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode entry_amended payload: %w", err)
	}
	entry, ok := p.Entries[e.TargetID]
	if !ok {
		// Orphan amend — silently skip.
		return nil
	}
	// Sticky tombstone.
	if entry.IsDeleted {
		return nil
	}

	c := &payload.Changes
	wrote := false

	if c.AmountAFN != nil && CompareHLC(e.HLC, entry.hlcAmount) > 0 {
		entry.AmountAFN = *c.AmountAFN
		entry.hlcAmount = e.HLC
		wrote = true
	}
	if len(c.Note) > 0 && CompareHLC(e.HLC, entry.hlcNote) > 0 {
		var note *string
		if err := json.Unmarshal(c.Note, &note); err != nil {
			return fmt.Errorf("decode entry_amended note: %w", err)
		}
		entry.Note = note
		entry.hlcNote = e.HLC
		wrote = true
	}
	if c.Type != nil && CompareHLC(e.HLC, entry.hlcType) > 0 {
		entry.Type = *c.Type
		entry.hlcType = e.HLC
		wrote = true
	}
	if c.OccurredAtMS != nil && CompareHLC(e.HLC, entry.hlcOccurredAt) > 0 {
		entry.hlcOccurredAt = e.HLC
	}

	if !wrote {
		return nil
	}
	entry.UpdatedAt = e.HLC.PMS
	entry.CurrentEventID = e.EventID
	return nil
}

func applyEntryDeleted(p *Projection, e *LedgerEvent) error {
	entry, ok := p.Entries[e.TargetID]
	if !ok {
		return nil
	}
	entry.IsDeleted = true
	pms := e.HLC.PMS
	entry.DeletedAt = &pms
	entry.UpdatedAt = pms
	entry.CurrentEventID = e.EventID
	return nil
}

// ---------- Person / shop_profile appliers ----------

func applyPersonAdded(p *Projection, e *LedgerEvent) error {
	if e.RelationshipID == nil {
		return fmt.Errorf("person_added event %s missing envelope relationship_id", e.EventID)
	}
	if e.VaultID == "" {
		return fmt.Errorf("person_added event %s missing envelope vault_id", e.EventID)
	}
	var payload personAddedPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode person_added payload: %w", err)
	}
	ts := e.HLC.PMS

	p.Users[payload.UserID] = &UserProjection{
		ID:          payload.UserID,
		PhoneE164:   payload.PhoneE164,
		DisplayName: payload.Name,
		IsLocalSelf: false,
		GoogleSub:   nil,
		AccountID:   nil,
		CreatedAt:   ts,
		UpdatedAt:   ts,
		ArchivedAt:  nil,
	}

	relID := *e.RelationshipID
	if _, exists := p.Relationships[relID]; exists {
		return nil
	}
	p.Relationships[relID] = &RelationshipProjection{
		ID:         relID,
		UserAID:    e.AuthorUserIDLocalOnly,
		UserBID:    payload.UserID,
		Context:    "peer",
		VaultID:    e.VaultID,
		CreatedAt:  ts,
		UpdatedAt:  ts,
		ArchivedAt: nil,
	}
	return nil
}

func applyPersonRenamed(p *Projection, e *LedgerEvent) error {
	var payload personRenamedPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode person_renamed payload: %w", err)
	}
	u, ok := p.Users[e.TargetID]
	if !ok {
		return nil
	}
	u.DisplayName = payload.Name
	u.UpdatedAt = e.HLC.PMS
	return nil
}

func applyPersonPhoneChanged(p *Projection, e *LedgerEvent) error {
	var payload personPhoneChangedPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode person_phone_changed payload: %w", err)
	}
	u, ok := p.Users[e.TargetID]
	if !ok {
		return nil
	}
	u.PhoneE164 = payload.PhoneE164
	u.UpdatedAt = e.HLC.PMS
	return nil
}

func applyPersonArchived(p *Projection, e *LedgerEvent) error {
	if e.RelationshipID == nil {
		return fmt.Errorf("person_archived event %s missing envelope relationship_id", e.EventID)
	}
	if e.VaultID == "" {
		return fmt.Errorf("person_archived event %s missing envelope vault_id", e.EventID)
	}
	rel, ok := p.Relationships[*e.RelationshipID]
	if !ok {
		return nil
	}
	if rel.VaultID != e.VaultID {
		return nil
	}
	ts := e.HLC.PMS
	rel.ArchivedAt = &ts
	rel.UpdatedAt = ts

	stillActive := false
	for _, r := range p.Relationships {
		if r.UserBID == e.TargetID && r.ArchivedAt == nil {
			stillActive = true
			break
		}
	}
	if !stillActive {
		if u, ok := p.Users[e.TargetID]; ok {
			u.PhoneE164 = nil
			u.UpdatedAt = ts
		}
	}
	return nil
}

func applyPersonUnarchived(p *Projection, e *LedgerEvent) error {
	if e.RelationshipID == nil {
		return fmt.Errorf("person_unarchived event %s missing envelope relationship_id", e.EventID)
	}
	if e.VaultID == "" {
		return fmt.Errorf("person_unarchived event %s missing envelope vault_id", e.EventID)
	}
	rel, ok := p.Relationships[*e.RelationshipID]
	if !ok {
		return nil
	}
	if rel.VaultID != e.VaultID {
		return nil
	}
	rel.ArchivedAt = nil
	rel.UpdatedAt = e.HLC.PMS
	return nil
}

func applyShopProfileUpdated(p *Projection, e *LedgerEvent) error {
	var payload shopProfilePayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode shop_profile_updated payload: %w", err)
	}
	c := &payload.Changes
	if p.ShopProfile == nil {
		p.ShopProfile = &ShopProfileProjection{
			VaultID: e.TargetID,
		}
	}

	wrote := false
	if c.ShopName != nil && CompareHLC(e.HLC, p.ShopProfile.hlcShopName) > 0 {
		v := *c.ShopName
		p.ShopProfile.ShopName = &v
		p.ShopProfile.hlcShopName = e.HLC
		wrote = true
	}
	if len(c.OwnerName) > 0 && CompareHLC(e.HLC, p.ShopProfile.hlcOwnerName) > 0 {
		var owner *string
		if err := json.Unmarshal(c.OwnerName, &owner); err != nil {
			return fmt.Errorf("decode shop_profile owner_name: %w", err)
		}
		p.ShopProfile.OwnerName = owner
		p.ShopProfile.hlcOwnerName = e.HLC
		wrote = true
	}
	if !wrote {
		return nil
	}
	p.ShopProfile.UpdatedAt = e.HLC.PMS
	return nil
}

// ---------- Vault setting + membership appliers ----------

func applyVaultSettingSet(p *Projection, e *LedgerEvent) error {
	var payload vaultSettingSetPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode vault_setting_set payload: %w", err)
	}
	p.VaultSettings[payload.Key] = payload.Value
	return nil
}

func applyVaultMemberAdded(p *Projection, e *LedgerEvent) error {
	var payload vaultMemberAddedPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode vault_member_added payload: %w", err)
	}
	ts := e.HLC.PMS
	p.Members[payload.AccountID] = &MemberProjection{
		AccountID: payload.AccountID,
		Role:      payload.Role,
		AddedAt:   ts,
		UpdatedAt: ts,
		RemovedAt: nil,
	}
	return nil
}

func applyVaultMemberRoleChanged(p *Projection, e *LedgerEvent) error {
	var payload vaultMemberRoleChangedPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode vault_member_role_changed payload: %w", err)
	}
	m, ok := p.Members[payload.AccountID]
	if !ok {
		return nil
	}
	m.Role = payload.Role
	m.UpdatedAt = e.HLC.PMS
	return nil
}

func applyVaultMemberRemoved(p *Projection, e *LedgerEvent) error {
	var payload vaultMemberRemovedPayload
	if err := json.Unmarshal(e.Payload, &payload); err != nil {
		return fmt.Errorf("decode vault_member_removed payload: %w", err)
	}
	m, ok := p.Members[payload.AccountID]
	if !ok {
		return nil
	}
	ts := e.HLC.PMS
	m.RemovedAt = &ts
	m.UpdatedAt = ts
	return nil
}

// ---------- Serialization ----------

// ProjectionToJSON serializes a projection to a deterministic JSON byte
// sequence. encoding/json sorts string map keys alphabetically.
func ProjectionToJSON(p Projection) ([]byte, error) {
	return json.Marshal(p)
}

// ParseEvents decodes a JSON byte stream of events as produced by the
// corpus fixtures.
func ParseEvents(raw []byte) ([]LedgerEvent, error) {
	var events []LedgerEvent
	if err := json.Unmarshal(raw, &events); err != nil {
		return nil, fmt.Errorf("decode events: %w", err)
	}
	return events, nil
}
