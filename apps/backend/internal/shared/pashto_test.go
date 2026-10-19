package shared

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestPashtoBillLanguageAndCalendar(t *testing.T) {
	ms := time.Date(2026, time.March, 21, 12, 0, 0, 0, kabulTZ).UnixMilli()
	if got := billDateForLanguage(ms, "ps", "jalali", 0); got != "۱ وری ۱۴۰۵" {
		t.Fatalf("Pashto Nowruz: %q", got)
	}
	if got := billDateForLanguage(ms, "ps", "gregorian", 0); got != "۲۱ مارچ ۲۰۲۶" {
		t.Fatalf("Pashto frozen Gregorian choice: %q", got)
	}
	if got := ogDescForLanguage("۵۰۰", "AFN", "owe", "ps", "۱ وری ۱۴۰۵"); got != "د ۱ وری ۱۴۰۵ نېټې بل — د تصفیې پاتې حساب: ۵۰۰ AFN" {
		t.Fatalf("Pashto dated social preview: %q", got)
	}
	var out bytes.Buffer
	if err := viewTmpl.Execute(&out, viewData{Lang: "ps", RTL: true, Direction: "settled", Person: "<script>unsafe</script>"}); err != nil {
		t.Fatal(err)
	}
	html := out.String()
	for _, want := range []string{`<html lang="ps" dir="rtl">`, "حساب تصفیه دی", "راکړې ورکړې", "وری", "جمادی‌الاول", `var lang = "ps";`, "&lt;script&gt;unsafe&lt;/script&gt;"} {
		if !strings.Contains(html, want) {
			t.Errorf("Pashto bill missing %q", want)
		}
	}
	if strings.Contains(html, "<script>unsafe</script>") {
		t.Fatal("bill did not escape the account label")
	}
	out.Reset()
	if err := notFoundTmpl.Execute(&out, viewData{Lang: "ps", RTL: true}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "دا شریکه کاټه نشته.") {
		t.Fatal("missing bill used another language")
	}
}

func TestPashtoBillInlineFormatting(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required to verify inline bill formatting")
	}
	start := strings.Index(viewHTML, "  var AFMP=")
	end := strings.Index(viewHTML, "  function moneyMinor(")
	if start < 0 || end <= start {
		t.Fatal("inline date/amount functions not found")
	}
	program := "var calendar='jalali',rtl=true,lang='ps',qamariOffset=0;\n" + viewHTML[start:end] + `
var anchor = new Date('2026-03-21T07:30:00Z').getTime();
if(fmtDate(anchor)!=='۱ وری ۱۴۰۵') throw new Error('Pashto Nowruz: '+fmtDate(anchor));
calendar='gregorian';
if(fmtDate(anchor)!=='۲۱ مارچ ۲۰۲۶') throw new Error('Pashto Gregorian: '+fmtDate(anchor));
calendar='qamari';
if(fmtDate(anchor)!=='۲ شوال ۱۴۴۷') throw new Error('Pashto Qamari: '+fmtDate(anchor));
if(fmtAmt(1234.5)!=='۱٬۲۳۴٫۵۰') throw new Error('Pashto amount differs from SSR: '+fmtAmt(1234.5));
`
	cmd := exec.Command(node, "--input-type=commonjs")
	cmd.Env = append(os.Environ(), "TZ=Asia/Kabul")
	cmd.Stdin = strings.NewReader(program)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("inline Pashto bill: %v\n%s", err, output)
	}
}
