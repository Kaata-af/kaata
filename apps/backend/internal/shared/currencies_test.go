package shared

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

const multiBillFixture = `{"v":2,"shop":"Synthetic shop","person":"Synthetic customer","locale":"en","calendar":"gregorian","generated_at":1700000000000,"currencies":[
{"currency":"؋","currency_code":"AFN","balance":10.1,"entries":[{"currency":"AFN","type":"debt","amount":10.1,"note":"afn current","date":300},{"currency":"AFN","type":"debt","amount":20,"note":"afn old","date":100},{"currency":"AFN","type":"payment","amount":20,"note":null,"date":90}],"settled_chapters":1,"settled_boundary_ms":200,"settled_boundaries":[200]},
{"currency":"$","currency_code":"USD","balance":-10.1,"entries":[{"currency":"USD","type":"payment","amount":10.1,"note":"usd current","date":175},{"currency":"USD","type":"debt","amount":7,"note":"usd old","date":100},{"currency":"USD","type":"payment","amount":7,"note":null,"date":90}],"settled_chapters":1,"settled_boundary_ms":150,"settled_boundaries":[150]},
{"currency":"A$","currency_code":"AUD","balance":0,"entries":[{"currency":"AUD","type":"debt","amount":5,"note":"aud old","date":100},{"currency":"AUD","type":"payment","amount":5,"note":null,"date":90}],"settled_chapters":1,"settled_boundary_ms":200,"settled_boundaries":[200,200]}]}`

func multiBill(t *testing.T) sharePayload {
	t.Helper()
	var p sharePayload
	if err := json.Unmarshal([]byte(multiBillFixture), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestMultiCurrencyBillValidation(t *testing.T) {
	p := multiBill(t)
	if err := validateSharePayload(p); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*sharePayload){
		func(p *sharePayload) { p.Currencies[1].CurrencyCode = "AFN" },
		func(p *sharePayload) { p.Currencies[1].Entries[0].Currency = "AFN" },
		func(p *sharePayload) { p.Currencies[0].Balance = nil },
		func(p *sharePayload) { p.Currencies[0].Entries = nil },
		func(p *sharePayload) { p.Currencies[0].Entries[0].Amount = -1 },
		func(p *sharePayload) { p.Currencies[0].Entries[0].Amount = 0.001 },
		func(p *sharePayload) { p.Currencies[0].SettledBoundaries = []int64{-1} },
	} {
		bad := multiBill(t)
		mutate(&bad)
		if err := validateSharePayload(bad); err == nil {
			t.Fatal("accepted an invalid currency statement")
		}
	}
	p = multiBill(t)
	for i := range p.Currencies {
		p.Currencies[i].Entries = []shareEntry{}
	}
	for i := 0; i < maxSharedEntries; i++ {
		p.Currencies[i%2].Entries = append(p.Currencies[i%2].Entries, shareEntry{Currency: p.Currencies[i%2].CurrencyCode, Type: "debt", Amount: 0.01, Date: 1})
	}
	if err := validateSharePayload(p); err != nil {
		t.Fatalf("exact aggregate limit: %v", err)
	}
	p.Currencies[2].Entries = append(p.Currencies[2].Entries, shareEntry{Currency: "AUD", Type: "payment", Amount: 1, Date: 1})
	if err := validateSharePayload(p); err == nil {
		t.Fatal("entry limit must apply across all currencies")
	}
	var legacy sharePayload
	if err := json.Unmarshal([]byte(`{"v":1,"person":"Old customer","balance":1200,"entries":[]}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if err := validateSharePayload(legacy); err != nil {
		t.Fatalf("old single-currency snapshot changed: %v", err)
	}
	legacy.Entries = make([]shareEntry, 500)
	if err := validateSharePayload(legacy); err != nil {
		t.Fatal("legacy exact 500-row limit changed")
	}
	legacy.Entries = append(legacy.Entries, shareEntry{})
	if err := validateSharePayload(legacy); err == nil {
		t.Fatal("legacy 501-row snapshot must still be rejected")
	}
}

func TestMultiCurrencyBillCurrencyCount(t *testing.T) {
	for _, count := range []int{155, maxSharedCurrencies, maxSharedCurrencies + 1} {
		balance := 0.0
		p := sharePayload{V: 2, Person: "Synthetic customer"}
		for i := 0; i < count; i++ {
			code := string([]byte{byte('A' + i/676), byte('A' + (i/26)%26), byte('A' + i%26)})
			p.Currencies = append(p.Currencies, shareCurrencyLedger{
				Currency: code, CurrencyCode: code, Balance: &balance, Entries: []shareEntry{},
			})
		}
		err := validateSharePayload(p)
		if (err == nil) != (count <= maxSharedCurrencies) {
			t.Fatalf("currency count %d: %v", count, err)
		}
	}
}

type memorySnapshotStore struct {
	payload []byte
	writes  int
}

func historyBill(t *testing.T) sharePayload {
	t.Helper()
	p := multiBill(t)
	p.V = 3
	for c := range p.Currencies {
		for e := range p.Currencies[c].Entries {
			p.Currencies[c].Entries[e].ID = fmt.Sprintf("current-%d-%d", c, e)
		}
	}
	a, b := "before-gave", "old-gave"
	privateNote, sharedNote, backdatedNote := "Private pre-link tally", "Earlier shared tally", "Backdated after clearance"
	p.Currencies[0].History = []shareHistory{
		{Kind: "pre_link", Entries: []shareEntry{
			{ID: a, Currency: "AFN", Type: "debt", Amount: 20, Date: 100, Note: &privateNote},
			{ID: "before-paid", Currency: "AFN", Type: "payment", Amount: 10, Date: 200},
		}, Settlements: []shareHistorySettlement{{AfterEntryID: &a, Date: 150}}},
		{Kind: "closed_shared", Entries: []shareEntry{
			{ID: b, Currency: "AFN", Type: "debt", Amount: 90, Date: 3000, Note: &sharedNote},
			{ID: "old-backdated", Currency: "AFN", Type: "payment", Amount: 50, Date: 1000, Note: &backdatedNote},
		}, Settlements: []shareHistorySettlement{{AfterEntryID: &b, Date: 3500}, {AfterEntryID: &b, Date: 3600}}},
	}
	return p
}

func TestBillHistoryValidation(t *testing.T) {
	if err := validateSharePayload(historyBill(t)); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*sharePayload){
		"missing id":                func(p *sharePayload) { p.Currencies[0].Entries[0].ID = "" },
		"duplicate current/history": func(p *sharePayload) { p.Currencies[0].History[0].Entries[0].ID = p.Currencies[0].Entries[0].ID },
		"foreign currency":          func(p *sharePayload) { p.Currencies[0].History[0].Entries[0].Currency = "USD" },
		"unknown history":           func(p *sharePayload) { p.Currencies[0].History[0].Kind = "unknown" },
		"invalid anchor": func(p *sharePayload) {
			wrong := "current-0-0"
			p.Currencies[0].History[0].Settlements[0].AfterEntryID = &wrong
		},
		"unordered anchors": func(p *sharePayload) {
			p.Currencies[0].History[0].Settlements = append(p.Currencies[0].History[0].Settlements, shareHistorySettlement{Date: 200})
		},
		"old version":    func(p *sharePayload) { p.V = 2 },
		"future version": func(p *sharePayload) { p.V = 4 },
		"unsafe running": func(p *sharePayload) {
			p.Currencies[0].History[0].Entries[0].Amount = 90071992547409.0
			p.Currencies[0].History[0].Entries[1].Type = "debt"
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := historyBill(t)
			mutate(&p)
			if err := validateSharePayload(p); err == nil {
				t.Fatal("accepted invalid history")
			}
		})
	}
	p := historyBill(t)
	for i := range p.Currencies {
		p.Currencies[i].Entries = []shareEntry{}
		p.Currencies[i].History = nil
		p.Currencies[i].SettledBoundaries = nil
		p.Currencies[i].SettledBoundaryMs = nil
	}
	p.Currencies[0].History = []shareHistory{{Kind: "pre_link", Entries: []shareEntry{}}}
	for i := 0; i < maxSharedEntries; i++ {
		p.Currencies[0].History[0].Entries = append(p.Currencies[0].History[0].Entries, shareEntry{ID: fmt.Sprint(i), Currency: "AFN", Type: "debt", Amount: 0.01, Date: 1})
	}
	if err := validateSharePayload(p); err != nil {
		t.Fatal(err)
	}
	p.Currencies[1].Entries = append(p.Currencies[1].Entries, shareEntry{ID: "overflow", Currency: "USD", Type: "debt", Amount: 0.01, Date: 1})
	if err := validateSharePayload(p); err == nil {
		t.Fatal("current and history entry counts must share one limit")
	}
	p = historyBill(t)
	p.Currencies[0].SettledBoundaries = make([]int64, maxSharedEntries-6)
	if err := validateSharePayload(p); err != nil {
		t.Fatalf("exact aggregate marker bound: %v", err)
	}
	p.Currencies[0].SettledBoundaries = append(p.Currencies[0].SettledBoundaries, 0)
	if err := validateSharePayload(p); err == nil {
		t.Fatal("current and history markers must share one bound")
	}
}

func TestBillHistoryHTTP(t *testing.T) {
	store := &memorySnapshotStore{}
	h := NewHandler(store, "https://kaata.af", "https://bill.kaata.af", "https://api.kaata.af")
	r := chi.NewRouter()
	r.Post("/v1/shared", h.Create)
	r.Get("/v3/{token}", h.View)
	p := historyBill(t)
	body, _ := json.Marshal(p)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/shared", bytes.NewReader(body)))
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if w.Code != 200 || result["bill_version"] != float64(3) || result["url"] != "https://bill.kaata.af/v3/synthetic-token" {
		t.Fatalf("unsafe history handoff: %d %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(store.payload, body) {
		t.Fatal("history snapshot must be frozen without normalization or truncation")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v3/synthetic-token", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "https://bill.kaata.af/v3/synthetic-token") || !strings.Contains(w.Body.String(), "AFN ؋") {
		t.Fatal("history page/canonical balance unavailable")
	}
}

func (s *memorySnapshotStore) Create(_ context.Context, p []byte) (string, error) {
	s.payload = append([]byte(nil), p...)
	s.writes++
	return "synthetic-token", nil
}
func (s *memorySnapshotStore) Get(context.Context, string) ([]byte, error) { return s.payload, nil }

func TestMultiCurrencyBillHTTPCompatibility(t *testing.T) {
	store := &memorySnapshotStore{}
	h := NewHandler(store, "https://kaata.af", "https://bill.kaata.af", "https://api.kaata.af")
	r := chi.NewRouter()
	r.Post("/v1/shared", h.Create)
	r.Get("/v1/shared/capabilities", h.Capabilities)
	r.Get("/v/{token}", h.View)
	r.Get("/v2/{token}", h.View)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/shared/capabilities", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"bill_versions":[1,2,3]`) {
		t.Fatalf("missing explicit v2 capability: %s", w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/shared", strings.NewReader(multiBillFixture)))
	var response map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	if w.Code != 200 || response["bill_version"] != float64(2) || response["url"] != "https://bill.kaata.af/v2/synthetic-token" {
		t.Fatalf("unsafe v2 handoff: %d %s", w.Code, w.Body.String())
	}
	if !bytes.Equal(store.payload, []byte(multiBillFixture)) {
		t.Fatal("server changed the frozen complete payload")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v2/synthetic-token", nil))
	for _, value := range []string{"AFN ؋", "USD $", "AUD A$", "owes", "is owed", "https://bill.kaata.af/v2/synthetic-token"} {
		if !strings.Contains(w.Body.String(), value) {
			t.Fatalf("SSR missing %q", value)
		}
	}
	if strings.Contains(w.Body.String(), `class="cleartitle"`) {
		t.Fatal("opposing currencies must not become one settled balance")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/shared", strings.NewReader(`{"v":1,"person":"Old customer","currency":"AFN","balance":5,"entries":[]}`)))
	response = map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	if response["bill_version"] != nil || response["url"] != "https://bill.kaata.af/v/synthetic-token" {
		t.Fatal("legacy single-currency URL/response changed")
	}
	complete := strings.Replace(multiBillFixture, "afn current", strings.Repeat("x", maxPayload-len(multiBillFixture)+len("afn current")), 1)
	if len(complete) != maxPayload {
		t.Fatal("fixture must exercise exact body limit")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/shared", strings.NewReader(complete)))
	if w.Code != http.StatusOK || len(store.payload) != maxPayload {
		t.Fatal("complete bill at exact 4MiB limit must be retained without truncation")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/shared", strings.NewReader(complete+" ")))
	if w.Code != http.StatusBadRequest || store.writes != 3 {
		t.Fatal("oversized bill must be refused before storing a partial statement")
	}
}

func TestMultiCurrencyBillInlineRendering(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for actual inline bill renderer")
	}
	p := multiBill(t)
	var page bytes.Buffer
	if err := viewTmpl.Execute(&page, viewData{Lang: "en", Direction: "multi", Person: p.Person, Currencies: currencyPreviews(p, "en"), Token: "synthetic", Calendar: "gregorian"}); err != nil {
		t.Fatal(err)
	}
	html := page.String()
	start := strings.Index(html, "<script>") + len("<script>")
	end := strings.Index(html[start:], "</script>") + start
	script, _ := json.Marshal(html[start:end])
	historyPayload, _ := json.Marshal(historyBill(t))
	program := `const assert=require('node:assert/strict'),vm=require('node:vm');
class Element{
 constructor(){this.children=[];this.listeners={};this._html='';this._text='';this.classList={add:()=>{}};}
 set innerHTML(value){this._html=value;this.children=[];this.button=null;} get innerHTML(){return this._html+this.children.map(c=>c.innerHTML).join('');}
 set textContent(value){this._text=String(value);this._html=this._text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');} get textContent(){return this._text;}
 appendChild(child){this.children.push(child);} querySelectorAll(){return [];}
 querySelector(selector){if(selector==='.histbtn'&&this._html.includes('class="histbtn"'))return this.button??=new Element();return null;}
 addEventListener(name,fn){this.listeners[name]=fn;}
}
async function run(payload){
 const ids=Object.fromEntries(['entries','stmtVerb','txTitle','txCount','foottag','billDate','dlbtn','dllabel'].map(id=>[id,new Element()]));let printed='';
 const document={getElementById:id=>ids[id]??null,createElement:()=>new Element(),addEventListener:()=>{}};
 vm.runInNewContext(` + string(script) + `,{document,fetch:()=>Promise.resolve({ok:true,json:()=>Promise.resolve(payload)}),requestAnimationFrame:fn=>fn(),window:{print:()=>{printed=ids.entries.innerHTML;}}});
 await new Promise(resolve=>setImmediate(resolve));
 return {ids,groups:payload.v>=2?ids.entries.children.filter(child=>child.className==='rows'):[ids.entries],histories:ids.entries.children.filter(child=>child.className==='rows historical-rows'),print:()=>{ids.dlbtn.listeners.click();return printed;}};
}
(async()=>{const payload=` + multiBillFixture + `;
 const bill=await run(payload);assert.equal(bill.groups.length,3);
 const rows=group=>(group.innerHTML.match(/class="row"/g)||[]).length;
 assert.deepEqual(bill.groups.map(rows),[1,1,0],'each currency uses only its own cutoff and balance');
 assert.match(bill.groups[0].innerHTML,/AFN ؋/);assert.match(bill.groups[1].innerHTML,/USD \$/);assert.equal(bill.ids.txCount.textContent,'2');
 bill.groups[0].querySelector('.histbtn').listeners.click();assert.deepEqual(bill.groups.map(rows),[3,1,0],'expanding AFN leaves USD and AUD unchanged');
 bill.groups[0].querySelector('.histbtn').listeners.click();assert.deepEqual(bill.groups.map(rows),[1,1,0]);
 const printed=bill.print();assert.deepEqual(bill.groups.map(rows),[3,3,2]);assert.equal((printed.match(/class="chline"/g)||[]).length,3,'duplicate same-currency boundaries collapse');
 assert.match(printed,/AUD A\$/);assert.ok(!printed.includes('NaN'));
 const old=await run({...payload,...payload.currencies[0],v:1});assert.equal(rows(old.groups[0]),1);old.print();assert.equal(rows(old.groups[0]),3,'v1 print still includes all settled rows');
 const historical=await run(` + string(historyPayload) + `);
 assert.deepEqual(historical.groups.map(rows),[1,1,0],'historic books never alter current balance/coherence');
 assert.deepEqual(historical.histories.map(rows),[2,2],'pre-link and earlier shared books remain complete');
 assert.equal(historical.ids.txCount.textContent,'6','visible count includes history without adding its money');
 const prior=historical.histories[1].innerHTML;
 assert.ok(prior.indexOf('Earlier shared tally')<prior.indexOf('class="chline"')&&prior.indexOf('class="chline"')<prior.indexOf('Backdated after clearance'),'clearance remains at its frozen sequence anchor');
 assert.equal((prior.match(/class="chline"/g)||[]).length,1,'duplicate adjacent anchors collapse');
 assert.match(prior,/Historical balance/);assert.match(prior,/40/);assert.match(prior,/AFN ؋/);
 const historyPrint=historical.print();assert.match(historyPrint,/Private pre-link tally/);assert.match(historyPrint,/Earlier shared tally/);assert.ok(!historyPrint.includes('NaN'));
})().catch(error=>{console.error(error);process.exitCode=1;});`
	cmd := exec.Command(node, "--input-type=commonjs")
	cmd.Stdin = strings.NewReader(program)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("actual inline renderer: %v\n%s", err, output)
	}
}
