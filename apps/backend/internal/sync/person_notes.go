package sync

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"unicode/utf8"
)

const personNoteMaxLength = 2000

// Notes are private staff metadata on a relationship, never on the shared
// account-global user. Preserve signed payload bytes; authors trim their drafts.
func decodePersonNote(payload json.RawMessage) (*string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return nil, err
	}
	raw, present := fields["note"]
	if !present {
		return nil, errors.New("contact note missing")
	}
	var note *string
	if err := json.Unmarshal(raw, &note); err != nil {
		return nil, errors.New("contact note must be text or null")
	}
	if note != nil && utf8.RuneCountInString(*note) > personNoteMaxLength {
		return nil, errors.New("contact note too long")
	}
	return note, nil
}

func validatePersonNotePushEvent(event PushEvent) error {
	if event.TargetID == nil || *event.TargetID == "" || event.RelationshipID == nil || *event.TargetID != *event.RelationshipID {
		return errors.New("contact note target mismatch")
	}
	// This type has no unsigned legacy history. New note recovery verifies
	// every event, so never admit an unsigned note that could strand it.
	if event.EventSigB64 == nil || event.SignerDevicePubkeyB64 == nil {
		return errors.New("contact notes require an author signature")
	}
	signature, err := base64.StdEncoding.DecodeString(*event.EventSigB64)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("invalid contact note signature")
	}
	pubkey, err := base64.StdEncoding.DecodeString(*event.SignerDevicePubkeyB64)
	if err != nil || len(pubkey) != ed25519.PublicKeySize {
		return errors.New("invalid contact note signer key")
	}
	_, err = decodePersonNote(event.Payload)
	return err
}

func applyPersonNoteSet(p *Projection, event *LedgerEvent) error {
	if event.VaultID == "" || event.TargetID == "" || event.RelationshipID == nil || *event.RelationshipID != event.TargetID {
		return errors.New("contact note target mismatch")
	}
	note, err := decodePersonNote(event.Payload)
	if err != nil {
		return err
	}
	rel := p.Relationships[event.TargetID]
	if rel == nil || rel.VaultID != event.VaultID {
		return errors.New("contact note relationship missing in vault")
	}
	if rel.NoteFieldHLC != nil && CompareHLC(event.HLC, *rel.NoteFieldHLC) <= 0 {
		return nil
	}
	// Clearing is a real LWW write, so stale offline notes cannot return. Do
	// not change UpdatedAt: staff instructions are not financial activity.
	rel.Note = note
	hlc := event.HLC
	rel.NoteFieldHLC = &hlc
	return nil
}
