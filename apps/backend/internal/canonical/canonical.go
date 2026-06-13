// Package canonical implements the cross-platform canonical-JSON encoding
// shared with the mobile client (apps/mobile/lib/event-sig.ts `canonicalize`).
// Every Ed25519 signature in the M2 membership chain — event signatures,
// server witness attestations — is computed over bytes produced by this
// encoding, so the Go and Hermes implementations MUST be byte-identical:
//
//   - objects: keys sorted lexicographically, emitted as
//     {"k1":v1,"k2":v2,...} with no whitespace;
//   - arrays: positional, [v1,v2,...];
//   - scalars: JSON.stringify-compatible — strings escape `"` `\` and the
//     control shorthands \b \t \n \f \r, other chars < 0x20 as \u00xx
//     (lowercase hex), everything else (including non-ASCII) raw UTF-8;
//     numbers keep their JSON literal (decode with UseNumber so the wire
//     literal — which JSON.stringify produced on the signing side — is
//     preserved verbatim).
//
// Known divergences, accepted because they only make verification FAIL
// (never falsely succeed): U+2028/U+2029 are emitted raw (matching JS,
// diverging from encoding/json), and lone surrogates cannot round-trip
// through Go strings. The fixture pins in canonical_test.go are the
// cross-side contract — the mobile selftests pin the same strings.
package canonical

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
)

// Canonicalize encodes v into the canonical byte form described above.
// Supported value types: nil, bool, string, json.Number, int, int64,
// float64, map[string]any, []any. Anything else is an error — callers
// build inputs from json.Decode(UseNumber) output or literal maps.
func Canonicalize(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := write(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Decode parses raw JSON preserving number literals (json.Number), producing
// a value tree suitable for Canonicalize. This is how a payload received on
// the wire is re-canonicalized without renormalizing the number forms the
// signer's JSON.stringify emitted.
func Decode(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, fmt.Errorf("canonical: decode: %w", err)
	}
	return v, nil
}

func write(buf *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if x {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case string:
		writeString(buf, x)
	case json.Number:
		buf.WriteString(x.String())
	case int:
		buf.WriteString(strconv.Itoa(x))
	case int64:
		buf.WriteString(strconv.FormatInt(x, 10))
	case float64:
		// encoding/json's float formatting deliberately tracks ES6
		// Number→string semantics; integral values < 2^53 print in full.
		b, err := json.Marshal(x)
		if err != nil {
			return fmt.Errorf("canonical: float: %w", err)
		}
		buf.Write(b)
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeString(buf, k)
			buf.WriteByte(':')
			if err := write(buf, x[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := write(buf, x[i]); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		return fmt.Errorf("canonical: unsupported type %T", v)
	}
	return nil
}

// writeString emits a JSON string matching JS JSON.stringify byte-for-byte
// for well-formed UTF-8 input (see package comment for the edge cases).
// encoding/json is NOT used here because it escapes <, >, & (HTML mode) and
// U+2028/U+2029 — all of which JSON.stringify leaves raw.
func writeString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(buf, `\u%04x`, r)
			} else {
				buf.WriteRune(r)
			}
		}
	}
	buf.WriteByte('"')
}
