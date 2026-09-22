package tabs

// Dev-only preview + the OG strings.
//
//	go test ./internal/tabs/ -run TestWriteTabPreview -v -preview-out <dir>
//
// Uses html/template, the SAME package the handler uses: text/template would
// emit {{.Token}} unquoted inside the script and preview a page that never
// ships. Skipped unless -preview-out is passed, so it costs a normal
// `go test ./...` nothing. It exists because the page's failure modes are
// visual — a hero that prints white, a Dari date reordered by a stray .num,
// an "I gave" button that flipped to the left under RTL — and none of them
// is reachable by assertion.

import (
	"encoding/json"
	"flag"
	"html/template"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var previewOut = flag.String("preview-out", "", "directory to write the tab page preview HTML into")

// previewFixture is what the stubbed API answers with — marshalled from the
// real wire types so the preview can never drift from what the handler
// emits. Party B's view: A (the shop) opened with 3400, B paid 400 back,
// A added 250 of goods which B disputed, one row voided.
func previewFixture() TabResponse {
	joinedA := int64(1_755_900_000_000)
	joinedB := int64(1_756_050_000_000)
	acceptedAt := int64(1_756_120_000_000)
	reason := "It was 200, not 250"
	void := Entry{ID: "e4", Seq: 4, Rev: 7, CreatedBy: "a", Direction: "b_to_a", Amount: "80", Kind: "void", OccurredAtMS: 1_756_300_000_000, CreatedAtMS: 1_756_300_000_000, Status: "accepted", StatusAtMS: &acceptedAt, VoidsEntryID: str("e3")}
	return TabResponse{
		Tab: Tab{
			ID: "11111111-1111-4111-8111-111111111111", Currency: "AFN", Rev: 7, CreatedAtMS: joinedA, You: "b",
			Parties: map[string]PartyMeta{
				"a": {Label: "دوکان اخلاص", JoinedAtMS: &joinedA, Bound: true},
				"b": {Label: "حاجی محمد", JoinedAtMS: &joinedB, Bound: false},
			},
			Balance:       map[string]string{"a": "3262.5", "b": "-3262.5"},
			PendingForYou: 1,
		},
		Entries: []Entry{
			{ID: "e1", Seq: 1, Rev: 1, CreatedBy: "a", Direction: "a_to_b", Amount: "3400", Kind: "opening", Note: str("Balance before linking"), OccurredAtMS: 1_756_000_000_000, CreatedAtMS: 1_756_000_000_000, Status: "accepted", StatusAtMS: &acceptedAt},
			{ID: "e2", Seq: 2, Rev: 3, CreatedBy: "b", Direction: "b_to_a", Amount: "400", Kind: "entry", Note: str("رسید"), OccurredAtMS: 1_756_100_000_000, CreatedAtMS: 1_756_100_000_000, Status: "pending"},
			{ID: "e3", Seq: 3, Rev: 7, CreatedBy: "a", Direction: "a_to_b", Amount: "80", Kind: "entry", Note: str("شیر"), OccurredAtMS: 1_756_200_000_000, CreatedAtMS: 1_756_200_000_000, Status: "accepted", StatusAtMS: &acceptedAt, VoidedByEntryID: str("e4")},
			void,
			{ID: "e5", Seq: 5, Rev: 6, CreatedBy: "a", Direction: "a_to_b", Amount: "250", Kind: "entry", Note: str("کیکو شفا و چند قلم دیگر که یادداشت طولانی دارد"), OccurredAtMS: 1_756_400_000_000, CreatedAtMS: 1_756_400_000_000, Status: "disputed", DisputeReason: &reason},
			{ID: "e6", Seq: 6, Rev: 5, CreatedBy: "a", Direction: "a_to_b", Amount: "12.5", Kind: "entry", OccurredAtMS: 1_756_500_000_000, CreatedAtMS: 1_756_500_000_000, Status: "pending"},
		},
		Full: true,
	}
}

// stubFetch swaps the page's one fetch call for a resolved promise carrying
// the fixture, so a local file renders the real rows and controls instead of
// the error state. PREVIEW-ONLY string surgery; production HTML is untouched.
func stubFetch(html string, fixture []byte) (string, bool) {
	const call = "fetch(apiBase + path, init)"
	if !strings.Contains(html, call) {
		return html, false
	}
	stub := "<script>window.__previewFetch = function(path, init){" +
		"var body = (init && init.method === 'POST') ? {} : " + string(fixture) + ";" +
		"return Promise.resolve({ok:true, status:200, text:function(){ return Promise.resolve(JSON.stringify(body)); }});" +
		"};</script>\n<script>\n(function(){"
	html = strings.Replace(html, call, "window.__previewFetch(path, init)", 1)
	html = strings.Replace(html, "<script>\n(function(){", stub, 1)
	return html, strings.Contains(html, "__previewFetch = function")
}

func TestWriteTabPreview(t *testing.T) {
	if *previewOut == "" {
		t.Skip("pass -preview-out <dir> to write the preview")
	}
	tmpl, err := template.New("tab").Parse(viewHTML)
	if err != nil {
		t.Fatalf("parse view template: %v", err)
	}
	if err := os.MkdirAll(*previewOut, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	fixture, err := json.Marshal(previewFixture())
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}

	for _, tc := range []struct {
		file string
		data viewData
	}{
		{
			file: "tab-fa.html",
			data: viewData{
				Token: "preview-token", TabID: "11111111-1111-4111-8111-111111111111", You: "b",
				Lang: "fa", RTL: true,
				Origin: "https://kaata.af", ShareURL: "https://kaata.af/t/preview-token", APIBase: "",
				OGTitle: ogTitle("حاجی محمد", "دوکان اخلاص", true), OGDesc: ogDesc(-326250, "AFN", "دوکان اخلاص", true),
				Currency: "AFN", MyLabel: "حاجی محمد", OtherLabel: "دوکان اخلاص",
				AbsBalance: displayAmount(-326250, true), Direction: "owe",
				PlayURL: playStoreURL, AppStoreURL: appStoreURL,
			},
		},
		{
			file: "tab-en.html",
			data: viewData{
				Token: "preview-token", TabID: "11111111-1111-4111-8111-111111111111", You: "b",
				Lang: "en", RTL: false,
				Origin: "https://kaata.af", ShareURL: "https://kaata.af/t/preview-token", APIBase: "",
				OGTitle: ogTitle("Haji Mohammad", "Ekhlas Store", false), OGDesc: ogDesc(-326250, "AFN", "Ekhlas Store", false),
				Currency: "AFN", MyLabel: "Haji Mohammad", OtherLabel: "Ekhlas Store",
				AbsBalance: displayAmount(-326250, false), Direction: "owe",
				PlayURL: playStoreURL, AppStoreURL: appStoreURL,
			},
		},
	} {
		var buf strings.Builder
		if err := tmpl.Execute(&buf, tc.data); err != nil {
			t.Fatalf("execute %s: %v", tc.file, err)
		}
		html, ok := stubFetch(buf.String(), fixture)
		if !ok {
			t.Fatalf("%s: fetch stub did not apply — the call site moved", tc.file)
		}
		path := filepath.Join(*previewOut, tc.file)
		if err := os.WriteFile(path, []byte(html), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
		t.Log(path)
	}
}

// TestTemplateEscapesIntoScript proves html/template JSON-quotes the values
// the inline script reads — the reason the handler must never switch to
// text/template. A token containing a quote and a </script> cannot break out.
func TestTemplateEscapesIntoScript(t *testing.T) {
	var buf strings.Builder
	data := viewData{Token: `x"</script><script>alert(1)`, TabID: "id", You: "a", Lang: "en", Origin: "https://kaata.af", Currency: "AFN"}
	if err := viewTmpl.Execute(&buf, data); err != nil {
		t.Fatalf("execute: %v", err)
	}
	html := buf.String()
	if strings.Contains(html, `</script><script>alert(1)`) {
		t.Fatal("token was not escaped inside the script")
	}
	if !strings.Contains(html, `var you = "a";`) || !strings.Contains(html, `var tabId = "id";`) {
		t.Fatal("script values are not JSON-quoted strings")
	}
}

// Syntax-check the actual rendered inline program, not the Go template.
// Browser/device visual acceptance remains a separate release requirement.
func TestRenderedPageJavaScriptSyntax(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is needed for the inline JavaScript syntax check")
	}
	for _, locale := range []string{"en", "fa"} {
		var buf strings.Builder
		if err := viewTmpl.Execute(&buf, viewData{Token: "synthetic-token", TabID: "test-tab", You: "b", Lang: locale, RTL: locale == "fa", Currency: "AFN"}); err != nil {
			t.Fatal(err)
		}
		scripts := regexp.MustCompile(`(?s)<script>(.*?)</script>`).FindAllStringSubmatch(buf.String(), -1)
		if len(scripts) == 0 {
			t.Fatal("no rendered program")
		}
		for _, script := range scripts {
			cmd := exec.Command(node, "--check")
			cmd.Stdin = strings.NewReader(script[1])
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%s: %v\n%s", locale, err, output)
			}
		}
	}
}

func TestPreviewBalanceMatchesRows(t *testing.T) {
	f := previewFixture()
	var minor int64
	for _, e := range f.Entries {
		if e.Kind == "void" || e.VoidedByEntryID != nil {
			continue
		}
		n, err := parseAmountMinor(e.Amount)
		if err != nil {
			t.Fatal(err)
		}
		if e.Direction == "a_to_b" {
			minor += n
		} else {
			minor -= n
		}
	}
	if f.Tab.Balance["a"] != formatMinor(minor) || f.Tab.Balance["b"] != formatMinor(-minor) {
		t.Fatal("preview contradicts the tallies it displays")
	}
}

func TestOGStrings(t *testing.T) {
	// Title: generic until both sides have a name, then "other ⇄ you".
	if got := ogTitle("", "Ekhlas Store", false); got != "Kaata tab" {
		t.Errorf("unjoined title = %q", got)
	}
	if got := ogTitle("Haji", "", true); got != "حساب مشترک کاتا" {
		t.Errorf("unjoined fa title = %q", got)
	}
	if got := ogTitle("Haji Mohammad", "Ekhlas Store", false); got != "Ekhlas Store ⇄ Haji Mohammad" {
		t.Errorf("title = %q", got)
	}

	// Description: the link holder's view, dated nowhere, marked live.
	cases := []struct {
		minor int64
		other string
		rtl   bool
		want  string
	}{
		{-125000, "Ahmad", false, "You owe 1,250 AFN — Live tab on Kaata — updates as tallies are added"},
		{125000, "Ahmad", false, "Ahmad owes you 1,250 AFN — Live tab on Kaata — updates as tallies are added"},
		{125000, "", false, "You are owed 1,250 AFN — Live tab on Kaata — updates as tallies are added"},
		{0, "Ahmad", false, "Settled — Live tab on Kaata — updates as tallies are added"},
		{-125050, "احمد", true, "شما ۱٬۲۵۰٫۵ AFN قرضدار هستید — حساب زندهٔ کاتا، با هر معامله تازه می‌شود"},
		{125000, "احمد", true, "احمد ۱٬۲۵۰ AFN به شما قرضدار است — حساب زندهٔ کاتا، با هر معامله تازه می‌شود"},
		{0, "", true, "تصفیه شده — حساب زندهٔ کاتا، با هر معامله تازه می‌شود"},
	}
	for _, tc := range cases {
		if got := ogDesc(tc.minor, "AFN", tc.other, tc.rtl); got != tc.want {
			t.Errorf("ogDesc(%d, %q, rtl=%v) = %q, want %q", tc.minor, tc.other, tc.rtl, got, tc.want)
		}
	}

	// displayAmount: grouped, unsigned, no trailing zeros, Dari digits.
	for _, tc := range []struct {
		minor int64
		rtl   bool
		want  string
	}{
		{123456789, false, "1,234,567.89"}, {-100000, false, "1,000"}, {1250, false, "12.5"}, {0, false, "0"},
		{999_999_999_999, false, "9,999,999,999.99"}, {123456789, true, "۱٬۲۳۴٬۵۶۷٫۸۹"},
	} {
		if got := displayAmount(tc.minor, tc.rtl); got != tc.want {
			t.Errorf("displayAmount(%d, %v) = %q, want %q", tc.minor, tc.rtl, got, tc.want)
		}
	}
	for _, tc := range []struct {
		in   string
		want int64
	}{{"0", 0}, {"-1250", -125000}, {"0.25", 25}, {"12.5", 1250}} {
		if got, err := parseSignedMinor(tc.in); err != nil || got != tc.want {
			t.Errorf("parseSignedMinor(%q) = %d, %v; want %d", tc.in, got, err, tc.want)
		}
	}

	if !acceptsPersian("fa-AF,en;q=0.8") || !acceptsPersian("prs") || !acceptsPersian("ps-AF") || acceptsPersian("en-US,fa;q=0.9") || acceptsPersian("") {
		t.Error("acceptsPersian: first tag only, fa/prs/ps")
	}
}
