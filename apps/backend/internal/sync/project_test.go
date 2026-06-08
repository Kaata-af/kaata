package sync

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// corpusFixture is the on-disk shape of every projection-corpus/*.json file.
//
// Shared between Go and TS: the test that ships alongside the mobile
// projection module (apps/mobile/lib/projection/*) loads the SAME JSON and
// asserts the same equivalence. If a fixture changes here, the TS test
// also has to keep passing — that's the server-projection equivalence
// invariant.
type corpusFixture struct {
	Name               string          `json:"name"`
	Description        string          `json:"description"`
	Events             []LedgerEvent   `json:"events"`
	ExpectedProjection json.RawMessage `json:"expected_projection"`
}

// TestProjectionCorpus walks apps/_shared/projection-corpus/, loads every
// fixture, runs ApplyEvents over the input event stream, and asserts the
// resulting projection is JSON-equivalent to expected_projection.
//
// Equivalence is by canonical JSON round-trip (Marshal -> Unmarshal ->
// reflect.DeepEqual on map[string]interface{}). Direct byte-equality
// would over-constrain the test (Go and TS produce semantically
// equivalent but not byte-identical JSON — e.g. integer formatting).
func TestProjectionCorpus(t *testing.T) {
	corpusDir := corpusDir(t)
	entries, err := os.ReadDir(corpusDir)
	if err != nil {
		t.Fatalf("read corpus dir %s: %v", corpusDir, err)
	}

	var names []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		t.Fatalf("no fixtures found in %s", corpusDir)
	}

	for _, name := range names {
		name := name
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(corpusDir, name)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read %s: %v", path, err)
			}
			var fx corpusFixture
			if err := json.Unmarshal(raw, &fx); err != nil {
				t.Fatalf("decode %s: %v", path, err)
			}

			got, err := ApplyEvents(fx.Events)
			if err != nil {
				t.Fatalf("apply events: %v", err)
			}

			gotJSON, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("marshal got: %v", err)
			}

			var gotMap, wantMap map[string]any
			if err := json.Unmarshal(gotJSON, &gotMap); err != nil {
				t.Fatalf("re-decode got: %v", err)
			}
			if err := json.Unmarshal(fx.ExpectedProjection, &wantMap); err != nil {
				t.Fatalf("decode expected: %v", err)
			}

			if !reflect.DeepEqual(gotMap, wantMap) {
				t.Errorf("projection mismatch for fixture %q\n--- got ---\n%s\n--- want ---\n%s",
					fx.Name, prettyJSON(gotMap), prettyJSON(wantMap))
			}
		})
	}
}

// TestCompareHLC sanity-checks the HLC total order. Mirrors the TS
// compareHLC test in lib/__dev__/replay-test.ts so any divergence between
// the Go and TS ordering shows up here too.
func TestCompareHLC(t *testing.T) {
	cases := []struct {
		name string
		a, b HLC
		want int
	}{
		{"a.pms < b.pms", HLC{PMS: 1, L: 99, DID: "z"}, HLC{PMS: 2, L: 0, DID: "a"}, -1},
		{"a.pms > b.pms", HLC{PMS: 2, L: 0, DID: "a"}, HLC{PMS: 1, L: 99, DID: "z"}, 1},
		{"pms equal, a.l < b.l", HLC{PMS: 1, L: 0, DID: "z"}, HLC{PMS: 1, L: 1, DID: "a"}, -1},
		{"pms equal, a.l > b.l", HLC{PMS: 1, L: 1, DID: "z"}, HLC{PMS: 1, L: 0, DID: "a"}, 1},
		{"pms,l equal, did string compare", HLC{PMS: 1, L: 0, DID: "a"}, HLC{PMS: 1, L: 0, DID: "b"}, -1},
		{"identical", HLC{PMS: 1, L: 0, DID: "a"}, HLC{PMS: 1, L: 0, DID: "a"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := CompareHLC(tc.a, tc.b)
			if (got < 0) != (tc.want < 0) || (got > 0) != (tc.want > 0) || (got == 0) != (tc.want == 0) {
				t.Errorf("CompareHLC(%v, %v) = %d, want signed %d", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

// corpusDir resolves the absolute path to apps/_shared/projection-corpus/
// from the working directory of the test (apps/backend/internal/sync).
// We walk up four levels: sync -> internal -> backend -> apps. Then
// drop into _shared/projection-corpus.
func corpusDir(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	// wd = .../apps/backend/internal/sync
	// Walk up three levels: sync -> internal -> backend -> apps.
	apps := filepath.Join(wd, "..", "..", "..")
	return filepath.Join(apps, "_shared", "projection-corpus")
}

// prettyJSON formats a value as indented JSON for test failure messages.
func prettyJSON(v any) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Sprintf("<marshal err: %v>", err)
	}
	return string(b)
}
