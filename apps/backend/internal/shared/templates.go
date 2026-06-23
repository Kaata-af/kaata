package shared

import (
	"math"
	"strconv"
)

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

// viewHTML — tiny self-contained shell. Server renders the summary + OG meta;
// the inline script fetches the snapshot and renders the transaction list.
const viewHTML = `<!doctype html>
<html lang="{{if .RTL}}fa{{else}}en{{end}}" dir="{{if .RTL}}rtl{{else}}ltr{{end}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{{.OGTitle}}</title>
<meta name="description" content="{{.OGDesc}}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Kaata">
<meta property="og:title" content="{{.OGTitle}}">
<meta property="og:description" content="{{.OGDesc}}">
<meta property="og:url" content="{{.Origin}}/v/{{.Token}}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{{.OGTitle}}">
<meta name="twitter:description" content="{{.OGDesc}}">
<style>
:root{--bg:#fafaf9;--card:#fff;--ink:#1c1917;--sub:#78716c;--line:#e7e5e4;--red:#dc2626;--green:#16a34a;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;}
.wrap{max-width:560px;margin:0 auto;padding:20px 16px 48px;}
.brand{font-size:13px;font-weight:700;letter-spacing:-.2px;color:var(--sub);text-transform:lowercase;}
.shop{font-size:13px;color:var(--sub);margin-top:2px;}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-top:16px;}
.person{font-size:18px;font-weight:600;}
.ballabel{font-size:12px;color:var(--sub);margin-top:14px;text-transform:uppercase;letter-spacing:.4px;}
.balance{font-size:34px;font-weight:700;margin-top:2px;}
.balance.owe{color:var(--red);}
.balance.credit{color:var(--green);}
.cur{font-size:18px;font-weight:600;color:var(--sub);margin-inline-start:6px;}
.sectiontitle{font-size:12px;color:var(--sub);text-transform:uppercase;letter-spacing:.4px;margin:24px 4px 8px;}
.rows{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;}
.row{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);}
.row:last-child{border-bottom:none;}
.rmeta{min-width:0;}
.rkind{font-size:14px;font-weight:600;}
.rnote{font-size:13px;color:var(--sub);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw;}
.rdate{font-size:11px;color:var(--sub);margin-top:2px;}
.ramt{font-size:15px;font-weight:700;white-space:nowrap;margin-inline-start:12px;}
.ramt.debt{color:var(--red);}
.ramt.payment{color:var(--green);}
.empty,.err{color:var(--sub);font-size:14px;padding:20px 4px;text-align:center;}
.foot{margin-top:28px;text-align:center;font-size:13px;color:var(--sub);}
.foot a{color:var(--ink);font-weight:600;text-decoration:none;}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">kaata.</div>
  {{if .Shop}}<div class="shop">{{.Shop}}</div>{{end}}
  <div class="card">
    <div class="person">{{.Person}}</div>
    <div class="ballabel" id="balLabel"></div>
    <div class="balance {{.Direction}}">{{.AbsBalance}}<span class="cur">{{.Currency}}</span></div>
  </div>
  <div class="sectiontitle" id="txTitle"></div>
  <div class="rows" id="entries"><div class="empty" id="loading"></div></div>
  <div class="foot">See your ledger on <a href="{{.Origin}}">kaata.af</a></div>
</div>
<script>
(function(){
  var dir = {{.Direction}};
  var rtl = {{.RTL}};
  var L = rtl ? {
    owe:"مانده برای تصفیه", credit:"به نفع شما", settled:"تصفیه شده",
    tx:"معاملات", loading:"در حال بارگذاری…", empty:"معامله‌ای نیست", err:"بارگذاری ناموفق بود",
    debt:"خرید نسیه", payment:"پرداخت"
  } : {
    owe:"Balance to settle", credit:"In your favour", settled:"Settled",
    tx:"Transactions", loading:"Loading…", empty:"No transactions", err:"Couldn't load this ledger.",
    debt:"Credit", payment:"Payment"
  };
  document.getElementById('balLabel').textContent = L[dir] || L.settled;
  document.getElementById('txTitle').textContent = L.tx;
  document.getElementById('loading').textContent = L.loading;
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  function fmtDate(ms){try{return new Date(ms).toLocaleDateString(rtl?'fa-AF':undefined,{year:'numeric',month:'short',day:'numeric'});}catch(e){return '';}}
  function fmtAmt(n){try{return Math.abs(n).toLocaleString(rtl?'fa-AF':undefined);}catch(e){return Math.abs(n);}}
  fetch('/v1/shared/' + {{.Token}})
    .then(function(r){ if(!r.ok) throw 0; return r.json(); })
    .then(function(p){
      var el = document.getElementById('entries');
      var list = (p && p.entries) || [];
      if(!list.length){ el.innerHTML = '<div class="empty">'+L.empty+'</div>'; return; }
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
<style>body{margin:0;background:#fafaf9;color:#1c1917;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;}a{color:#1c1917;font-weight:600;}</style>
</head><body><div><div style="font-size:13px;font-weight:700;color:#78716c">kaata.</div>
<p style="color:#78716c;max-width:320px">This shared ledger has expired or doesn't exist.</p>
<p><a href="{{.Origin}}">kaata.af</a></p></div></body></html>`
