package shared

import (
	"math"
	"strconv"
	"strings"
)

// localizeNum rewrites ASCII digits + thousands commas to their Dari (fa-AF)
// equivalents — Persian digits (U+06F0..U+06F9) and the Arabic thousands
// separator (U+066C) — so a SERVER-rendered amount matches the CLIENT-side
// toLocaleString('fa-AF') output exactly. Without this the instant-painted
// balance shows "12,450" while the JS-rendered row amounts show "۱۲٬۴۵۰".
func localizeNum(s string) string {
	var b strings.Builder
	b.Grow(len(s) * 2)
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune('۰' + (r - '0'))
		case r == ',':
			b.WriteRune('٬') // U+066C arabic thousands separator
		case r == '.':
			b.WriteRune('٫') // U+066B arabic decimal separator (rare — AFN is whole)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// absFmt formats |balance| with thousands separators and no trailing ".0".
func absFmt(v float64) string {
	a := math.Abs(v)
	// Integers are the common case (afghani). Keep up to 2 decimals otherwise.
	if a == math.Trunc(a) {
		return groupThousands(strconv.FormatInt(int64(a), 10))
	}
	s := strconv.FormatFloat(a, 'f', 2, 64)
	return s
}

func groupThousands(s string) string {
	n := len(s)
	if n <= 3 {
		return s
	}
	out := make([]byte, 0, n+n/3)
	pre := n % 3
	if pre > 0 {
		out = append(out, s[:pre]...)
		if n > pre {
			out = append(out, ',')
		}
	}
	for i := pre; i < n; i += 3 {
		out = append(out, s[i:i+3]...)
		if i+3 < n {
			out = append(out, ',')
		}
	}
	return string(out)
}

// viewHTML — the focused, self-contained shared-ledger page. The server paints
// the summary + per-person OG meta (no image — the WhatsApp card is the balance,
// not a logo) + a skeleton, so the link opens to a styled page instantly; the
// inline script then fetches the snapshot and fills in the transaction list.
const viewHTML = `<!doctype html>
<html lang="{{if .RTL}}fa{{else}}en{{end}}" dir="{{if .RTL}}rtl{{else}}ltr{{end}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f9fafb">
<title>{{.OGTitle}}</title>
<meta name="description" content="{{.OGDesc}}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Kaata">
<meta property="og:title" content="{{.OGTitle}}">
<meta property="og:description" content="{{.OGDesc}}">
<meta property="og:url" content="{{.ShareURL}}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{{.OGTitle}}">
<meta name="twitter:description" content="{{.OGDesc}}">
<style>
:root{--bg:#f9fafb;--card:#fff;--ink:#101828;--sub:#475467;--mut:#98a2b3;--line:#eaecf0;--hair:#f2f4f7;--red:#b42318;--green:#067647;}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Inter","Vazirmatn",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
a{color:inherit;text-decoration:none;}
.wrap{max-width:520px;margin:0 auto;padding:40px 22px 56px;}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px 24px;}
.brandrow{display:flex;align-items:center;gap:11px;}
.logo{width:38px;height:38px;border-radius:10px;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;line-height:1;flex:0 0 auto;text-transform:uppercase;}
.shopname{font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--ink);min-width:0;}
.statement{margin-top:24px;}
.stmt{font-size:15px;color:var(--sub);}
.stmt .who{font-weight:600;color:var(--ink);}
.balance{margin-top:8px;font-size:40px;font-weight:600;letter-spacing:-.025em;line-height:1;display:flex;align-items:baseline;gap:8px;font-variant-numeric:tabular-nums;}
.statement.owe .balance{color:var(--red);}
.statement.credit .balance{color:var(--green);}
.cur{font-size:17px;font-weight:500;color:var(--mut);letter-spacing:0;}
.sectionhead{display:flex;align-items:baseline;justify-content:space-between;margin:28px 4px 12px;}
.sectiontitle{font-size:11px;color:var(--sub);text-transform:uppercase;letter-spacing:.08em;font-weight:600;}
.sectioncount{font-size:11px;color:var(--mut);font-weight:500;font-variant-numeric:tabular-nums;}
.rows{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;}
.row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:15px 18px;border-bottom:1px solid var(--hair);}
.row:last-child{border-bottom:none;}
.rmeta{min-width:0;}
.rkind{font-size:14px;font-weight:500;}
.rnote{font-size:13px;color:var(--sub);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw;}
.rdate{font-size:12px;color:var(--mut);margin-top:4px;font-variant-numeric:tabular-nums;}
.ramt{font-size:14px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:-.01em;}
.ramt.debt{color:var(--red);}
.ramt.payment{color:var(--green);}
.empty,.err{color:var(--mut);font-size:14px;padding:28px 4px;text-align:center;}
.asof{margin-top:24px;text-align:center;font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums;}
.foot{margin-top:22px;text-align:center;}
.foottag{font-size:12px;color:var(--mut);}
.foottag a{color:var(--sub);font-weight:700;}
.sk{background:var(--hair);border-radius:5px;animation:pulse 1.5s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    {{if .Shop}}<div class="brandrow"><div class="logo">{{.ShopInitial}}</div><div class="shopname">{{.Shop}}</div></div>{{end}}
    <div class="statement {{.Direction}}">
      <div class="stmt"><span class="who">{{.Person}}</span> <span id="stmtVerb"></span></div>
      <div class="balance">{{.AbsBalance}}<span class="cur">{{.Currency}}</span></div>
    </div>
  </div>
  <div class="sectionhead">
    <span class="sectiontitle" id="txTitle"></span>
    <span class="sectioncount" id="txCount"></span>
  </div>
  <div class="rows" id="entries">
    <div class="row"><div class="rmeta"><div class="sk" style="width:92px;height:13px"></div><div class="sk" style="width:130px;height:11px;margin-top:9px"></div></div><div class="sk" style="width:54px;height:14px"></div></div>
    <div class="row"><div class="rmeta"><div class="sk" style="width:78px;height:13px"></div><div class="sk" style="width:150px;height:11px;margin-top:9px"></div></div><div class="sk" style="width:54px;height:14px"></div></div>
    <div class="row"><div class="rmeta"><div class="sk" style="width:88px;height:13px"></div><div class="sk" style="width:110px;height:11px;margin-top:9px"></div></div><div class="sk" style="width:54px;height:14px"></div></div>
  </div>
  <div class="asof" id="asof"></div>
  <div class="foot">
    <div class="foottag"><span id="foottag"></span> <a href="{{.Origin}}"><b>kaata.</b></a></div>
  </div>
</div>
<script>
(function(){
  var dir = {{.Direction}};
  var rtl = {{.RTL}};
  var apiBase = {{.APIBase}};
  var L = rtl ? {
    owe:"بدهکار است", credit:"طلبکار است", settled:"تسویه شده",
    tx:"معاملات", empty:"معامله‌ای نیست", err:"بارگذاری ناموفق بود",
    debt:"خرید نسیه", payment:"پرداخت", asOf:"تا تاریخ", tag:"قدرت‌گرفته از"
  } : {
    owe:"owes", credit:"is owed", settled:"is settled",
    tx:"Transactions", empty:"No transactions yet.", err:"Couldn't load this ledger.",
    debt:"Credit", payment:"Payment", asOf:"As of", tag:"Powered by"
  };
  document.getElementById('stmtVerb').textContent = L[dir] || L.settled;
  document.getElementById('txTitle').textContent = L.tx;
  document.getElementById('foottag').textContent = L.tag;
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  function fmtDate(ms){try{return new Date(ms).toLocaleDateString(rtl?'fa-AF':undefined,{year:'numeric',month:'short',day:'numeric'});}catch(e){return '';}}
  function fmtAmt(n){try{return Math.abs(n).toLocaleString(rtl?'fa-AF':undefined);}catch(e){return Math.abs(n);}}
  fetch(apiBase + '/v1/shared/' + {{.Token}})
    .then(function(r){ if(!r.ok) throw 0; return r.json(); })
    .then(function(p){
      var el = document.getElementById('entries');
      var list = (p && p.entries) || [];
      if(list.length){ document.getElementById('txCount').textContent = fmtAmt(list.length); }
      if(!list.length){ el.innerHTML = '<div class="empty">'+L.empty+'</div>'; }
      else {
        var html = '';
        for(var i=0;i<list.length;i++){
          var e = list[i];
          var sign = e.type === 'payment' ? '−' : '+';
          html += '<div class="row"><div class="rmeta">'
            + '<div class="rkind">'+(e.type==='payment'?L.payment:L.debt)+'</div>'
            + (e.note ? '<div class="rnote">'+esc(e.note)+'</div>' : '')
            + '<div class="rdate">'+esc(fmtDate(e.date))+'</div>'
            + '</div><div class="ramt '+(e.type==='payment'?'payment':'debt')+'">'+sign+fmtAmt(e.amount)+'</div></div>';
        }
        el.innerHTML = html;
      }
      if(p && p.generated_at){ document.getElementById('asof').textContent = L.asOf + ' ' + fmtDate(p.generated_at); }
    })
    .catch(function(){ document.getElementById('entries').innerHTML = '<div class="err">'+L.err+'</div>'; });
})();
</script>
</body>
</html>`

const notFoundHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kaata</title>
<style>body{margin:0;background:#f9fafb;color:#101828;font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;-webkit-font-smoothing:antialiased;}a{color:#475467;font-weight:600;text-decoration:none;}</style>
</head><body><div><div style="font-size:16px;font-weight:700;letter-spacing:-.01em">kaata.</div>
<p style="color:#475467;max-width:320px;line-height:1.55">This shared ledger has expired or doesn’t exist.</p>
<p><a href="{{.Origin}}">Go to kaata.af</a></p></div></body></html>`
