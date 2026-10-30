package credit

import "testing"

func TestOrdinaryLimitAlertsDeriveInclusiveCapsWithoutChangingAdmission(t *testing.T) {
	collect, pay := int64(10000), int64(20000)
	p := &Policy{Currency: "USD", MaxCollectMinor: &collect, MaxPayMinor: &pay, UpdatedAtMS: 10}
	on := &LimitNotificationPolicy{Enabled: true, UpdatedAtMS: 20}
	a := LimitAlertPolicy(p, on, "customer")
	if a == nil || a.UpdatedAtMS != 20 {
		t.Fatalf("derived policy %+v", a)
	}
	for _, tc := range []struct {
		direction string
		balance   int64
		want      bool
	}{{"collect", 9999, false}, {"collect", 10000, true}, {"collect", 10001, true}, {"pay", -19999, false}, {"pay", -20000, true}, {"pay", -20001, true}} {
		if got := a.Matches(tc.direction, map[string]int64{"USD": tc.balance}); got != tc.want {
			t.Errorf("%s %d matched=%v", tc.direction, tc.balance, got)
		}
	}
	if p.Exceeded(0, collect) || p.Exceeded(0, -pay) || !p.Exceeded(collect, collect+1) || !p.Exceeded(-pay, -pay-1) {
		t.Fatal("notification thresholds changed admission")
	}
	zero := int64(0)
	p.MaxCollectMinor = &zero
	p.MaxPayMinor = nil
	a = LimitAlertPolicy(p, on, "customer")
	if a.Matches("collect", map[string]int64{"USD": 0}) || !a.Matches("collect", map[string]int64{"USD": 1}) || a.Matches("pay", map[string]int64{"USD": -1}) {
		t.Fatal("zero/unlimited limits misclassified")
	}
	if LimitAlertPolicy(p, nil, "customer") != nil || LimitAlertPolicy(p, &LimitNotificationPolicy{}, "customer") != nil || LimitAlertPolicy(nil, on, "customer") != nil || LimitAlertPolicy(&Policy{Currency: "USD"}, on, "customer") != nil {
		t.Fatal("disabled/missing/unlimited policy produced watch")
	}
}
