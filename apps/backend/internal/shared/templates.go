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
<link rel="stylesheet" href="/fonts/ledger.css">
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
:root{--bg:#f9fafb;--card:#fff;--ink:#101828;--sub:#475467;--mut:#98a2b3;--line:#eaecf0;--hair:#f2f4f7;--red:#b42318;--green:#067647;--mono:'JetBrains Mono','Vazirmatn',ui-monospace,'Menlo',monospace;}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Vazirmatn",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
a{color:inherit;text-decoration:none;}
.wrap{max-width:520px;margin:0 auto;padding:40px 22px 56px;}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px 24px;}
.shophead{font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--ink);text-align:center;}
.statement{margin-top:18px;padding-top:18px;border-top:1px solid var(--line);}
.stmt{font-size:15px;color:var(--sub);}
.stmt .who{font-weight:600;color:var(--ink);}
.balance{margin-top:8px;font-family:var(--mono);font-size:38px;font-weight:600;letter-spacing:-.02em;line-height:1;display:flex;align-items:baseline;gap:7px;font-variant-numeric:tabular-nums;}
.statement.owe .balance{color:var(--red);}
.statement.credit .balance{color:var(--green);}
.cur{font-family:"Vazirmatn",sans-serif;font-size:16px;font-weight:500;color:var(--mut);letter-spacing:0;}
.sectionhead{display:flex;align-items:baseline;justify-content:space-between;margin:28px 4px 12px;}
.sectiontitle{font-size:11px;color:var(--sub);text-transform:uppercase;letter-spacing:.08em;font-weight:600;}
.sectioncount{font-family:var(--mono);font-size:11px;color:var(--mut);font-weight:500;}
.rows{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;}
.row{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid var(--hair);transition:background .12s ease;}
.row:last-child{border-bottom:none;}
.ic{width:32px;height:32px;border-radius:8px;background:var(--hair);color:var(--sub);display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
.rmid{min-width:0;flex:1;}
.rtop{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
.ramtrow{display:flex;align-items:baseline;gap:4px;}
.ramt{font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink);}
.rcur{font-size:11px;font-weight:500;color:var(--mut);}
.rmeta{display:flex;align-items:baseline;white-space:nowrap;flex:0 0 auto;}
.rwhen{font-size:12px;color:var(--mut);}
.rnoterow{display:flex;align-items:baseline;gap:6px;min-width:0;margin-top:5px;}
.rnote{flex:1;min-width:0;font-size:13px;line-height:18px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.row.open .rnote{white-space:normal;overflow:visible;text-overflow:clip;}
.rmore{flex:0 0 auto;font-size:12px;font-weight:600;color:var(--ink);cursor:pointer;}
/* Every row darkens on press (parity with the app's rows), whether or not it
   expands; hover + pointer only on a clipped row that can open. The --hair icon
   chip stays visible on the lighter active tint. */
.row:active{background:var(--line);}
.row[role=button]{cursor:pointer;}
.row[role=button]:hover{background:var(--bg);}
/* press must win over hover on interactive rows: equal specificity to :hover,
   placed after it (matches web, where Tailwind emits active after hover). */
.row[role=button]:active{background:var(--line);}
.empty,.err{color:var(--mut);font-size:14px;padding:28px 4px;text-align:center;}
.foot{margin-top:26px;text-align:center;}
.foottag{font-size:12px;color:var(--mut);}
.foottag a{color:var(--sub);font-weight:700;}
.sk{background:var(--hair);border-radius:5px;animation:pulse 1.5s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    {{if .Shop}}<div class="shophead">{{.Shop}}</div>{{end}}
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
    <div class="row"><div class="ic"></div><div class="rmid"><div class="rtop"><div class="sk" style="width:60px;height:14px"></div><div class="sk" style="width:128px;height:11px"></div></div></div></div>
    <div class="row"><div class="ic"></div><div class="rmid"><div class="rtop"><div class="sk" style="width:68px;height:14px"></div><div class="sk" style="width:120px;height:11px"></div></div></div></div>
    <div class="row"><div class="ic"></div><div class="rmid"><div class="rtop"><div class="sk" style="width:54px;height:14px"></div><div class="sk" style="width:132px;height:11px"></div></div></div></div>
  </div>
  <div class="foot">
    <div class="foottag"><span id="foottag"></span> <a href="{{.Origin}}"><b>kaata.</b></a></div>
  </div>
</div>
<script>
(function(){
  var dir = {{.Direction}};
  var rtl = {{.RTL}};
  var apiBase = {{.APIBase}};
  // iOS Safari only fires :active when an ancestor has a touch listener; this
  // empty one lets every row show its tap-darken on iOS. Harmless elsewhere.
  document.addEventListener('touchstart', function(){}, {passive:true});
  var L = rtl ? {
    owe:"بدهکار است", credit:"طلبکار است", settled:"تسویه شده",
    tx:"معاملات", empty:"معامله‌ای نیست", err:"بارگذاری ناموفق بود",
    debt:"دادم", payment:"گرفتم", tag:"قدرت‌گرفته از", more:"بیشتر", less:"کمتر"
  } : {
    owe:"owes", credit:"is owed", settled:"is settled",
    tx:"Transactions", empty:"No transactions yet.", err:"Couldn't load this ledger.",
    debt:"I gave", payment:"I received", tag:"Powered by", more:"more", less:"less"
  };
  var UP='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="7"/><polyline points="6 13 12 7 18 13"/></svg>';
  var DOWN='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="17"/><polyline points="18 11 12 17 6 11"/></svg>';
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
        var cur = (p && p.currency) || '';
        var html = '';
        for(var i=0;i<list.length;i++){
          var e = list[i];
          var gave = e.type !== 'payment'; // debt → "I gave" (up); payment → "I received" (down)
          html += '<div class="row">'
            + '<div class="ic" role="img" aria-label="'+esc(gave?L.debt:L.payment)+'">'+(gave?UP:DOWN)+'</div>'
            + '<div class="rmid">'
            +   '<div class="rtop">'
            +     '<div class="ramtrow"><span class="ramt">'+fmtAmt(e.amount)+'</span><span class="rcur">'+esc(cur)+'</span></div>'
            +     '<div class="rmeta"><span class="rwhen">'+esc(fmtDate(e.date))+'</span></div>'
            +   '</div>'
            +   (e.note ? '<div class="rnoterow"><div class="rnote">'+esc(e.note)+'</div></div>' : '')
            + '</div>'
          + '</div>';
        }
        el.innerHTML = html;
        // Note + cue on one line. Only notes that actually overflow the single
        // line become tap-to-expand (a "more"/"less" cue, measured — not guessed).
        el.querySelectorAll('.rnote').forEach(function(n){
          if(n.scrollWidth > n.clientWidth + 1){
            var row = n.closest('.row');
            row.setAttribute('role','button'); row.tabIndex = 0;
            var m = document.createElement('span');
            m.className = 'rmore'; m.textContent = L.more;
            n.insertAdjacentElement('afterend', m);
          }
        });
        el.addEventListener('click', function(ev){
          var r = ev.target.closest('.row[role="button"]'); if(!r) return;
          var open = r.classList.toggle('open');
          var m = r.querySelector('.rmore'); if(m){ m.textContent = open ? L.less : L.more; }
        });
        el.addEventListener('keydown', function(ev){
          if(ev.key !== 'Enter' && ev.key !== ' ') return;
          var r = ev.target.closest('.row[role="button"]'); if(!r) return;
          ev.preventDefault();
          var open = r.classList.toggle('open');
          var m = r.querySelector('.rmore'); if(m){ m.textContent = open ? L.less : L.more; }
        });
      }
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
