// Package canonevent is a SCRATCH helper for the 2026-10-07 forensic
// re-import rehearsal (apps/backend/scratch-reimport). It mirrors
// internal/sync/membership.go canonicalSignableEvent — which is unexported —
// so the generator and the rehearsal test can verify the recovered rows'
// Ed25519 author signatures offline, exactly as the push path and the phone
// would. Never shipped; delete the whole scratch-reimport directory when the
// incident is closed.
package canonevent

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/matee/kaata-backend/internal/canonical"
)

// Envelope is the signed subset of an events row / push event.
type Envelope struct {
	VaultID        string
	EventID        string
	EventType      string
	SchemaVersion  int
	HLCPhysicalMS  int64
	HLCLogical     int64
	HLCDeviceID    string
	ActorAccountID *string // signed as null when nil
	// TargetID is COALESCE(local_target_id, target_id) — the wire value.
	TargetID       *string
	RelationshipID *string
	Payload        json.RawMessage
}

// Canonical mirrors internal/sync/membership.go canonicalSignableEvent
// (HEAD): keys actor_account_id, device_id (= hlc.did), event_id, event_type,
// hlc{did,l,pms}, payload (decoded with UseNumber), payload_schema,
// relationship_id, target_id, vault_id.
func Canonical(e Envelope) ([]byte, error) {
	raw := e.Payload
	if len(raw) == 0 {
		raw = json.RawMessage("null")
	}
	payload, err := canonical.Decode(raw)
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	return canonical.Canonicalize(map[string]any{
		"actor_account_id": strOrNull(e.ActorAccountID),
		"device_id":        e.HLCDeviceID,
		"event_id":         e.EventID,
		"event_type":       e.EventType,
		"hlc": map[string]any{
			"did": e.HLCDeviceID,
			"l":   e.HLCLogical,
			"pms": e.HLCPhysicalMS,
		},
		"payload":         payload,
		"payload_schema":  e.SchemaVersion,
		"relationship_id": strOrNull(e.RelationshipID),
		"target_id":       strOrNull(e.TargetID),
		"vault_id":        e.VaultID,
	})
}

func strOrNull(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// Verify checks sigB64 (std base64, 64 bytes) over Canonical(e) against
// pubB64 (std base64, 32 bytes). Malformed material is simply "false".
func Verify(e Envelope, sigB64, pubB64 string) (bool, error) {
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false, nil
	}
	pub, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false, nil
	}
	msg, err := Canonical(e)
	if err != nil {
		return false, err
	}
	return ed25519.Verify(ed25519.PublicKey(pub), msg, sig), nil
}

// Sign produces the std-base64 signature the mobile signer would emit.
func Sign(e Envelope, priv ed25519.PrivateKey) (string, error) {
	msg, err := Canonical(e)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, msg)), nil
}
