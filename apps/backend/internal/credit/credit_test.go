package credit

import "testing"

func TestDirectionalExposure(t *testing.T) {
	cap := int64(10000)
	p := Policy{MaxCollectMinor: &cap, MaxPayMinor: &cap, Mode: "clerk_block"}
	for _, tc := range []struct {
		before, after int64
		exceeded      bool
	}{{0, 10000, false}, {10000, 10001, true}, {12000, 11999, false}, {12000, 12001, true}, {-12000, -11999, false}, {-10000, -10001, true}, {12000, -10001, true}, {-12000, 10001, true}, {-50, 50, false}} {
		if got := p.Exceeded(tc.before, tc.after); got != tc.exceeded {
			t.Errorf("%d→%d=%v want%v", tc.before, tc.after, got, tc.exceeded)
		}
	}
	zero := int64(0)
	p.MaxCollectMinor = &zero
	if !p.Exceeded(0, 1) {
		t.Fatal("zero blocks first cent")
	}
	p.MaxCollectMinor = nil
	p.MaxPayMinor = nil
	if p.Exceeded(0, 999999999999) {
		t.Fatal("unlimited")
	}
}
func TestMinorExact(t *testing.T) {
	for raw, want := range map[string]int64{"12.34": 1234, "100": 10000, "9999999999.99": 999999999999, "1e2": 10000} {
		got, err := Minor(raw)
		if err != nil || got != want {
			t.Fatalf("%s=%d %v", raw, got, err)
		}
	}
	for _, raw := range []string{"12.345", "NaN", "9223372036854775807"} {
		if _, err := Minor(raw); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
