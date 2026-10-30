package credit

import (
	"math"
	"testing"
)

func TestCreditAlertAlternativesAndExactDirectionalThresholds(t *testing.T) {
	p := AlertPolicy{Groups: []AlertGroup{
		{Direction: "collect", Conditions: []AlertCondition{{Currency: "USD", ThresholdMinor: 1000000}}},
		{Direction: "collect", Conditions: []AlertCondition{{Currency: "AFN", ThresholdMinor: 20000000}}},
		{Direction: "collect", Conditions: []AlertCondition{{Currency: "USD", ThresholdMinor: 500000}, {Currency: "AFN", ThresholdMinor: 10000000}}},
		{Direction: "collect", Conditions: []AlertCondition{{Currency: "USD", ThresholdMinor: 800000}, {Currency: "AFN", ThresholdMinor: 8000000}}},
		{Direction: "pay", Conditions: []AlertCondition{{Currency: "USD", ThresholdMinor: 100}}},
	}}
	for _, tc := range []struct {
		usd, afn int64
		collect  bool
		pay      bool
	}{
		{999999, 0, false, false}, {1000000, 0, true, false},
		{0, 19999999, false, false}, {0, 20000000, true, false},
		{500000, 9999999, false, false}, {499999, 10000000, false, false},
		{500000, 10000000, true, false}, {800000, 8000000, true, false},
		{799999, 8000000, false, false}, {-1000000, 0, false, true},
		{-99, 0, false, false}, {-100, 0, false, true}, {math.MinInt64, 0, false, true},
		{-100, 20000000, true, true},
	} {
		balances := map[string]int64{"USD": tc.usd, "AFN": tc.afn}
		if got := p.Matches("collect", balances); got != tc.collect {
			t.Errorf("collect USD=%d AFN=%d: %v want %v", tc.usd, tc.afn, got, tc.collect)
		}
		if got := p.Matches("pay", balances); got != tc.pay {
			t.Errorf("pay USD=%d AFN=%d: %v want %v", tc.usd, tc.afn, got, tc.pay)
		}
	}
	if p.Matches("collect", nil) || p.Matches("unknown", nil) {
		t.Fatal("missing exposure must not match")
	}
}

func TestCreditAlertValidationBoundaries(t *testing.T) {
	valid := func() AlertPolicy {
		return AlertPolicy{Groups: []AlertGroup{{Direction: "collect", Conditions: []AlertCondition{{Currency: "USD", ThresholdMinor: 1}}}}}
	}
	if !(AlertPolicy{Groups: []AlertGroup{}}).Valid() || (AlertPolicy{}).Valid() {
		t.Fatal("explicit off is valid; omitted groups is not")
	}
	for _, n := range []int64{-1, 0, 1000000000000} {
		p := valid()
		p.Groups[0].Conditions[0].ThresholdMinor = n
		if p.Valid() {
			t.Fatalf("accepted threshold %d", n)
		}
	}
	for _, code := range []string{"usd", "US", "USDD", "U$D", ""} {
		p := valid()
		p.Groups[0].Conditions[0].Currency = code
		if p.Valid() {
			t.Fatalf("accepted currency %q", code)
		}
	}
	p := valid()
	p.Groups[0].Conditions = append(p.Groups[0].Conditions, p.Groups[0].Conditions[0])
	if p.Valid() {
		t.Fatal("accepted repeated currency within AND group")
	}
	p = valid()
	p.Groups[0].Conditions = nil
	if p.Valid() {
		t.Fatal("empty AND group would match every exposure")
	}
	p = valid()
	p.Groups[0].Direction = "both"
	if p.Valid() {
		t.Fatal("accepted invalid direction")
	}
	p = valid()
	p.Groups[0].Conditions[0].ThresholdMinor = 999999999999
	for len(p.Groups) < 20 {
		p.Groups = append(p.Groups, p.Groups[0])
	}
	if !p.Valid() {
		t.Fatal("maximum bound should be valid")
	}
	p.Groups = append(p.Groups, p.Groups[0])
	if p.Valid() {
		t.Fatal("accepted more than 20 groups")
	}
	p = valid()
	for n := 1; n < 21; n++ {
		p.Groups[0].Conditions = append(p.Groups[0].Conditions, AlertCondition{Currency: "A" + string(rune('A'+n/26)) + string(rune('A'+n%26)), ThresholdMinor: 1})
	}
	if p.Valid() {
		t.Fatal("accepted more than 20 conditions")
	}
}
