package sync

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const tallyNoteMaxLength = 500

func isTallyNoteEvent(eventType string) bool {
	return eventType == EventTallyNoteAdded || eventType == EventTallyNoteRemoved
}

func canonicalNoteID(raw string) bool {
	id, err := uuid.Parse(raw)
	return err == nil && id != uuid.Nil && id.String() == raw
}

// Decode only the fields supported by the two note events. Notes are private
// staff records, with no amount, currency or editable customer-note field.
func normalizeTallyNote(ev *PushEvent) (json.RawMessage, bool) {
	noteID, relationshipID := derefStr(ev.TargetID), derefStr(ev.RelationshipID)
	if ev.SchemaVersion != 1 || !canonicalNoteID(noteID) || !canonicalNoteID(relationshipID) ||
		!canonicalNoteID(ev.EventID) || !canonicalNoteID(ev.HLC.DeviceID) ||
		(ev.ActorAccountID != nil && !canonicalNoteID(*ev.ActorAccountID)) {
		return nil, false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(ev.Payload, &fields) != nil || fields == nil {
		return nil, false
	}
	if ev.EventType == EventTallyNoteRemoved {
		return json.RawMessage(`{}`), len(fields) == 0 && ev.EventID != noteID
	}
	var note string
	if ev.EventID != noteID || len(fields) != 1 || json.Unmarshal(fields["note"], &note) != nil ||
		note == "" || note != strings.TrimSpace(note) || strings.ContainsRune(note, 0) ||
		utf8.RuneCountInString(note) > tallyNoteMaxLength {
		return nil, false
	}
	payload, err := json.Marshal(map[string]string{"note": note})
	return payload, err == nil
}

func tallyNoteSigner(vaultID string, ev *PushEvent) []byte {
	sig, err := base64.StdEncoding.DecodeString(derefStr(ev.EventSigB64))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil
	}
	pubkey, err := base64.StdEncoding.DecodeString(derefStr(ev.SignerDevicePubkeyB64))
	if err != nil || len(pubkey) != ed25519.PublicKeySize {
		return nil
	}
	message, err := canonicalSignableEvent(vaultID, ev)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(pubkey), message, sig) {
		return nil
	}
	return pubkey
}

// Tally notes grant no new ledger authority. Validate the actual signing
// device as well as the role so a relaying viewer cannot claim a manager's
// account ID. A historical role alone cannot authorize a fresh deletion.
func admitTallyNote(ctx context.Context, tx pgx.Tx, vaultID, author uuid.UUID, ev *PushEvent) (*RejectedEvent, error) {
	invalid := &RejectedEvent{EventID: ev.EventID, Reason: "invalid_payload"}
	payload, ok := normalizeTallyNote(ev)
	if !ok {
		return invalid, nil
	}
	signer := tallyNoteSigner(vaultID.String(), ev)
	if signer == nil {
		return invalid, nil
	}
	need := RequiredRoleFor(ev.EventType)
	role, active, err := currentMemberRole(ctx, tx, author, vaultID)
	if err != nil {
		return nil, err
	}
	if !active || !roleSatisfies(role, need) {
		return &RejectedEvent{EventID: ev.EventID, Reason: "insufficient_role", RequiredRole: need, CurrentRole: role}, nil
	}
	var bound bool
	// Some older server-anchored books lack a vault_devices row. Their
	// account's registered install key supplies the same author binding.
	// Never fall back past an explicit device binding or removal in the book.
	// A Ninja note may predate the device's account binding, so compare the
	// current binding here. The role and pre-sign-in cutoff were checked above.
	err = tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM vault_devices d
		 WHERE d.vault_id=$1 AND d.account_id=$2 AND d.device_id=$3::uuid AND d.device_pubkey=$4
		   AND d.removed_at_ms IS NULL
		UNION ALL
		SELECT 1 FROM installs i JOIN device_keys k USING(install_id)
		 WHERE i.account_id=$2 AND i.install_id=$3::uuid AND k.ed25519_pubkey=$4
		   AND NOT EXISTS (SELECT 1 FROM vault_devices d WHERE d.vault_id=$1
		     AND (d.device_id=$3::uuid OR (d.device_pubkey=$4 AND d.removed_at_ms IS NOT NULL)))
	)`, vaultID, author, ev.HLC.DeviceID, signer).Scan(&bound)
	if err != nil {
		return nil, err
	}
	if !bound {
		return &RejectedEvent{EventID: ev.EventID, Reason: RejectReasonMembershipUnverified}, nil
	}
	var contactAvailable bool
	// Check the relationship in this exact book. Removal may precede its
	// creation in the cloud when a manager first receives the note over mesh.
	// The client retains a tombstone scoped to the book, contact and note ID.
	// The last Ninja event is a special case: if it is a note, the existing
	// account_bound cutoff needs that note before earlier contacts can sync.
	// That history has already passed the retroactive owner and signer checks.
	preSignInOwner := role == "owner" && ev.ActorAccountID == nil
	err = tx.QueryRow(ctx, `SELECT v.archived_at IS NULL AND ($3::boolean OR EXISTS (
		SELECT 1 FROM events e WHERE e.vault_id=v.vault_id AND e.relationship_id=$2::uuid
		   AND e.event_type='person_added' AND e.redacted_at IS NULL
	)) FROM vaults v WHERE v.vault_id=$1`, vaultID, *ev.RelationshipID, preSignInOwner).Scan(&contactAvailable)
	if err != nil {
		return nil, err
	}
	if !contactAvailable {
		return &RejectedEvent{EventID: ev.EventID, Reason: "tally_note_contact_unavailable"}, nil
	}
	// Write the same canonical fields as valid JSONB. This also avoids raw
	// malformed UTF-16 escapes being accepted by Go but rejected by Postgres.
	ev.Payload = payload
	return nil, nil
}
