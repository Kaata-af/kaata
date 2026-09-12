package shared

import (
	"bytes"
	"os/exec"
	"strings"
	"testing"
)

func TestBillDecimalAmountFormatting(t *testing.T) {
	for _, tc := range []struct {
		amount float64
		want   string
		fa     string
	}{
		{0, "0", "۰"},
		{100, "100", "۱۰۰"},
		{1234, "1,234", "۱٬۲۳۴"},
		{0.01, "0.01", "۰٫۰۱"},
		{-12.5, "12.50", "۱۲٫۵۰"},
		{1234.56, "1,234.56", "۱٬۲۳۴٫۵۶"},
	} {
		if got := absFmt(tc.amount); got != tc.want {
			t.Errorf("absFmt(%v) = %q, want %q", tc.amount, got, tc.want)
		}
		if got := localizeNum(absFmt(tc.amount)); got != tc.fa {
			t.Errorf("Persian amount %v = %q, want %q", tc.amount, got, tc.fa)
		}
	}
}

// Execute the actual inline bill functions, not a Go reimplementation of their
// arithmetic. Node is available in this monorepo's JS toolchain; Go-only users
// can still run the formatting and projection tests without it.
func TestBillInlineDecimalCoherence(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required to execute the bill's inline JavaScript")
	}
	function := func(name string) string {
		for _, line := range strings.Split(viewHTML, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "function "+name+"(") {
				return line + "\n"
			}
		}
		t.Fatalf("inline %s function not found", name)
		return ""
	}
	start := strings.Index(viewHTML, "      var sum = 0;")
	end := strings.Index(viewHTML, "      if(!coherent)")
	if start < 0 || end <= start {
		t.Fatal("inline chapter coherence block not found")
	}
	program := function("fmtAmt") + function("moneyMinor") + `
var rtl=true;
if(fmtAmt(12.5)!=='۱۲٫۵۰') throw new Error('fractional amount must keep two digits');
if(fmtAmt(1234)!=='۱٬۲۳۴') throw new Error('old whole amount must remain unchanged');
if(fmtAmt(1234.56)!=='۱٬۲۳۴٫۵۶') throw new Error('decimal thousands grouping differs');
var cases=[
  {amounts:[0.1,0.2,-0.3],balance:0,want:true},
  {amounts:[0.1,0.2],balance:0.3,want:true},
  {amounts:[0.1,0.2],balance:0.31,want:false},
  {amounts:[100,-25],balance:75,want:true},
  {amounts:[1e18],balance:1e18,want:false},
  {amounts:[9e13,9e13,-9e13,-9e13],balance:0,want:false}
];
for(var test of cases){
  var current=test.amounts.map(function(n){return {type:n<0?'payment':'debt',amount:Math.abs(n)};});
  var p={balance:test.balance};
` + viewHTML[start:end] + `
  if(coherent!==test.want) throw new Error('incorrect chapter collapse: '+JSON.stringify(test));
}
`
	cmd := exec.Command(node, "--input-type=commonjs")
	cmd.Stdin = strings.NewReader(program)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		t.Fatalf("inline decimal bill checks failed: %v\n%s", err, output.String())
	}
}
