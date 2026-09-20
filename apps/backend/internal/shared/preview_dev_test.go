package shared

// Dev-only preview: renders the shared-ledger page to an HTML file so a human
// can open it, click Save as PDF, and LOOK at what prints.
//
//	go test ./internal/shared/ -run TestWriteBillPreview -v -preview-out <dir>
//
// Uses html/template, the SAME package the handler uses: text/template would
// emit {{.Token}} unquoted inside the script and preview a page that never
// ships.
//
// Skipped unless -preview-out is passed, so it costs a normal `go test ./...`
// nothing. It exists because the print stylesheet's failure modes are visual
// and none of them are reachable by assertion: a masthead that prints white, a
// note that stays clipped to one line, a row split across a page break, or a
// settled history that silently prints as a partial account.

import (
	"flag"
	"html/template"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The page fetches its rows from the API, which a local preview has no way to
// reach — it would render the error state and never reveal the download
// button. Swap the one fetch call for a resolved promise carrying fixture
// data. PREVIEW-ONLY string surgery; production HTML is untouched.
const previewFetchStub = `Promise.resolve({ok:true,json:function(){return Promise.resolve({
  currency: CUR, settled_boundary_ms: 1756300000000, settled_chapters: 1,
  entries: [
    {type:'debt',    amount:220,   date:1756000000000, note:NOTE1},
    {type:'debt',    amount:100,   date:1756050000000, note:'شیر'},
    {type:'payment', amount:300,   date:1756200000000, note:'تصفیه شد'},
    {type:'debt',    amount:140,   date:1756400000000, note:'شیر'},
    {type:'debt',    amount:70.5,  date:1756500000000, note:'کیکو شفا'},
    {type:'payment', amount:500,   date:1756600000000, note:'رسید'},
    {type:'debt',    amount:300,   date:1756700000000, note:'تخم'},
    {type:'debt',    amount:85.5,  date:1756800000000, note:''}
  ]});}})`

func stubFetch(html, currency, longNote string) string {
	stub := strings.ReplaceAll(previewFetchStub, "CUR", "'"+currency+"'")
	stub = strings.ReplaceAll(stub, "NOTE1", "'"+longNote+"'")
	return strings.Replace(html, "fetch(apiBase + '/v1/shared/' + \"preview\")", stub, 1)
}

var previewOut = flag.String("preview-out", "", "directory to write the bill preview HTML into")

func TestWriteBillPreview(t *testing.T) {
	if *previewOut == "" {
		t.Skip("pass -preview-out <dir> to write the preview")
	}
	tmpl, err := template.New("view").Parse(viewHTML)
	if err != nil {
		t.Fatalf("parse view template: %v", err)
	}
	if err := os.MkdirAll(*previewOut, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	for _, tc := range []struct {
		file string
		data viewData
	}{
		{
			file: "bill-fa.html",
			data: viewData{
				Token:         "preview",
				Shop:          "دوکان اخلاص",
				Person:        "حاجی محمد اخلاص",
				Currency:      "؋",
				AbsBalance:    localizeNum(absFmt(315.5)),
				Direction:     "owe",
				RTL:           true,
				Jalali:        true,
				Origin:        "https://kaata.af",
				ShareURL:      "https://kaata.af/s/preview",
				OGTitle:       "صورت حساب",
				OGDesc:        "بل",
				GeneratedAtMs: 1_757_000_000_000,
			},
		},
		{
			file: "bill-en.html",
			data: viewData{
				Token:         "preview",
				Shop:          "Ekhlas Store",
				Person:        "Haji Mohammad Ekhlas",
				Currency:      "AFN",
				AbsBalance:    absFmt(315.5),
				Direction:     "owe",
				RTL:           false,
				Jalali:        false,
				Origin:        "https://kaata.af",
				ShareURL:      "https://kaata.af/s/preview",
				OGTitle:       "Statement",
				OGDesc:        "Bill",
				GeneratedAtMs: 1_757_000_000_000,
			},
		},
	} {
		var buf strings.Builder
		if err := tmpl.Execute(&buf, tc.data); err != nil {
			t.Fatalf("execute %s: %v", tc.file, err)
		}
		longNote := "پاپور جوس بیسکویت کاغذ نشایی و چند قلم دیگر که یادداشت طولانی دارد"
		if !tc.data.RTL {
			longNote = "Juice, biscuits, wrapping paper and several other items with a deliberately long note"
		}
		html := stubFetch(buf.String(), tc.data.Currency, longNote)
		if !strings.Contains(html, "Promise.resolve") {
			t.Fatalf("%s: fetch stub did not apply — the call site moved", tc.file)
		}
		path := filepath.Join(*previewOut, tc.file)
		if err := os.WriteFile(path, []byte(html), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
		t.Log(path)
	}
}
