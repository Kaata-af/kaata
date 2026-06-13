package canonical

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// Fixture UUIDs / values shared with the mobile selftests. These exact
// canonical strings are the cross-side contract: apps/mobile pins the same
// inputs against the same outputs in its lib/trust selftests so a drift in
// either canonicalizer breaks a test before it breaks a signature in the
// field. DO NOT change these strings without changing both sides.
const (
	fxAccountID = "a1b2c3d4-0000-4000-8000-000000000001"
	fxDeviceID  = "a1b2c3d4-0000-4000-8000-000000000002"
	fxVaultID   = "a1b2c3d4-0000-4000-8000-000000000003"
	fxInviterID = "a1b2c3d4-0000-4000-8000-000000000004"
	fxEventID   = "a1b2c3d4-0000-4000-8000-000000000005"
	fxIssuedAt  = int64(1750000000000)
	// base64 of the 32 bytes 0x00..0x1f.
	fxPubkeyB64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
)

func TestFixturePubkeyDecodes(t *testing.T) {
	raw, err := base64.StdEncoding.DecodeString(fxPubkeyB64)
	if err != nil {
		t.Fatalf("decode fixture pubkey: %v", err)
	}
	if len(raw) != 32 {
		t.Fatalf("fixture pubkey decodes to %d bytes, want 32", len(raw))
	}
	for i, b := range raw {
		if int(b) != i {
			t.Fatalf("fixture pubkey byte[%d] = %#x, want %#x", i, b, i)
		}
	}
}

// TestDeviceWitnessTupleCanonicalString pins the §8.1 device-witness tuple:
// canonical JSON of {account_id, device_id, device_pubkey_b64, issued_at_ms,
// vault_id} with keys sorted lexicographically. The server signs exactly
// these bytes with MESH_SIGNING_PRIVKEY_PRIMARY.
func TestDeviceWitnessTupleCanonicalString(t *testing.T) {
	got, err := Canonicalize(map[string]any{
		"account_id":        fxAccountID,
		"device_id":         fxDeviceID,
		"device_pubkey_b64": fxPubkeyB64,
		"issued_at_ms":      fxIssuedAt,
		"vault_id":          fxVaultID,
	})
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	const want = `{"account_id":"a1b2c3d4-0000-4000-8000-000000000001","device_id":"a1b2c3d4-0000-4000-8000-000000000002","device_pubkey_b64":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","issued_at_ms":1750000000000,"vault_id":"a1b2c3d4-0000-4000-8000-000000000003"}`
	if string(got) != want {
		t.Errorf("device witness canonical mismatch:\n got %s\nwant %s", got, want)
	}
}

// TestMemberWitnessTupleCanonicalString pins the §8.1 member-witness tuple:
// canonical JSON of {account_id, inviter_account_id, issued_at_ms, role,
// vault_id}.
func TestMemberWitnessTupleCanonicalString(t *testing.T) {
	got, err := Canonicalize(map[string]any{
		"account_id":         fxAccountID,
		"inviter_account_id": fxInviterID,
		"issued_at_ms":       fxIssuedAt,
		"role":               "editor",
		"vault_id":           fxVaultID,
	})
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	const want = `{"account_id":"a1b2c3d4-0000-4000-8000-000000000001","inviter_account_id":"a1b2c3d4-0000-4000-8000-000000000004","issued_at_ms":1750000000000,"role":"editor","vault_id":"a1b2c3d4-0000-4000-8000-000000000003"}`
	if string(got) != want {
		t.Errorf("member witness canonical mismatch:\n got %s\nwant %s", got, want)
	}
}

// TestSignableEventCanonicalString pins the event-signature input for a
// witnessed vault_device_added — the same shape mobile's canonicalizeEvent
// (lib/event-sig.ts) produces. Note nulls for absent envelope fields and
// the nested sorted-key payload/witness objects.
func TestSignableEventCanonicalString(t *testing.T) {
	payloadRaw := []byte(`{"account_id":"` + fxAccountID + `","device_id":"` + fxDeviceID + `","device_pubkey":"` + fxPubkeyB64 + `","witness":{"sig_b64":"c2ln","server_key_id":"primary","issued_at_ms":1750000000000}}`)
	payload, err := Decode(payloadRaw)
	if err != nil {
		t.Fatalf("Decode payload: %v", err)
	}
	got, err := Canonicalize(map[string]any{
		"actor_account_id": nil,
		"device_id":        fxDeviceID,
		"event_id":         fxEventID,
		"event_type":       "vault_device_added",
		"hlc":              map[string]any{"did": fxDeviceID, "l": int64(0), "pms": fxIssuedAt},
		"payload":          payload,
		"payload_schema":   1,
		"relationship_id":  nil,
		"target_id":        fxAccountID,
		"vault_id":         fxVaultID,
	})
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	const want = `{"actor_account_id":null,"device_id":"a1b2c3d4-0000-4000-8000-000000000002","event_id":"a1b2c3d4-0000-4000-8000-000000000005","event_type":"vault_device_added","hlc":{"did":"a1b2c3d4-0000-4000-8000-000000000002","l":0,"pms":1750000000000},"payload":{"account_id":"a1b2c3d4-0000-4000-8000-000000000001","device_id":"a1b2c3d4-0000-4000-8000-000000000002","device_pubkey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","witness":{"issued_at_ms":1750000000000,"server_key_id":"primary","sig_b64":"c2ln"}},"payload_schema":1,"relationship_id":null,"target_id":"a1b2c3d4-0000-4000-8000-000000000001","vault_id":"a1b2c3d4-0000-4000-8000-000000000003"}`
	if string(got) != want {
		t.Errorf("signable event canonical mismatch:\n got %s\nwant %s", got, want)
	}
}

// TestScalarAndEscapeEdges pins the scalar encodings that historically
// drift between JSON encoders: HTML-significant chars stay raw (JS
// JSON.stringify never HTML-escapes), control chars use the JS escape set,
// number literals survive Decode verbatim, arrays are positional.
func TestScalarAndEscapeEdges(t *testing.T) {
	v, err := Decode([]byte(`{"a&b":"<note>\u0001\t\"x\"","arr":[1,2.50,-3e2,true,null],"z":"دکان"}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	got, err := Canonicalize(v)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	const want = `{"a&b":"<note>\u0001\t\"x\"","arr":[1,2.50,-3e2,true,null],"z":"دکان"}`
	if string(got) != want {
		t.Errorf("edge canonical mismatch:\n got %s\nwant %s", got, want)
	}
}

// TestDecodePreservesNumberLiterals guards the UseNumber contract.
func TestDecodePreservesNumberLiterals(t *testing.T) {
	v, err := Decode([]byte(`{"n":1750000000000}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("decoded to %T, want map", v)
	}
	n, ok := m["n"].(json.Number)
	if !ok || n.String() != "1750000000000" {
		t.Errorf("n = %#v, want json.Number(1750000000000)", m["n"])
	}
}
