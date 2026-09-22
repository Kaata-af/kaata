package tabs

// The living tab page (design §3.6), modelled on the bill page in
// internal/shared/templates.go and served the same way — a Go-templated shell
// proxied under kaata.af/t/<token> (Caddy @sharessr) so WhatsApp gets a
// per-tab preview card and the inline script escapes the SPA's
// script-src 'self' CSP.
//
// Division of labour: the SERVER paints what a link scraper or a first paint
// needs — OG meta, both labels, the balance hero in the Accept-Language
// script — and the inline script owns every string the language toggle can
// change, fetches GET /v1/tabs/{id} with `Authorization: Tab <token>`,
// renders the rows and polls. The URL is the credential; the page stores
// nothing but the chosen language (D11).
//
// Rules carried over from the bill (see CLAUDE.md "PDF exports"), all of
// which fail silently if dropped:
//   - print-color-adjust: exact, or the arrow chips and hero print grey;
//   - .num (direction:ltr; unicode-bidi:isolate) on NUMBERS ONLY — wrapping a
//     Dari date in it reorders the date; dates get dir="auto";
//   - the Afghan month set (حمل … حوت), never ICU's Iranian names for fa;
//   - "I received" sits LEFT of "I gave" in both scripts (the give/receive
//     invariant from mobile) — the add row is pinned direction:ltr.

const viewHTML = `<!doctype html>
<html lang="{{.Lang}}" dir="{{if .RTL}}rtl{{else}}ltr{{end}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f9fafb">
<!-- "only light" disables Chrome's Auto Dark Theme on Android, which would
     otherwise darken this light page when the phone is in dark mode. -->
<meta name="color-scheme" content="only light">
<!-- The URL is a capability: never let a crawler that found it index it. -->
<meta name="robots" content="noindex, nofollow">
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
/* Direction palette "Emerald Vault & Garnet" — hand-kept in sync with
   apps/web/src/theme.ts + apps/mobile/lib/colors.ts + the bill page. Colour
   means DIRECTION (owe = value away, credit = value toward you) or danger;
   status pills are monochrome on purpose so a "New" chip never reads as
   money moving. */
:root{--bg:#f9fafb;--card:#fff;--ink:#101828;--sub:#475467;--mut:#98a2b3;--line:#eaecf0;--hair:#f2f4f7;--owe:#A3203A;--owebg:#F8EAEC;--credit:#0C745A;--creditbg:#E8F4EF;--warn:#B54708;--warnbg:#FEF0C7;--mono:'JetBrains Mono','Vazirmatn',ui-monospace,'Menlo',monospace;}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Vazirmatn",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
a{color:inherit;text-decoration:none;}
button,input{font-family:inherit;font-size:inherit;color:inherit;}
.wrap{max-width:520px;margin:0 auto;padding:18px 22px 56px;}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.brand{font-size:16px;font-weight:700;letter-spacing:-.01em;direction:ltr;}
.lang{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600;color:var(--sub);cursor:pointer;}
.lang:active{background:var(--hair);}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 22px;}
.parties{display:flex;align-items:baseline;justify-content:center;gap:10px;flex-wrap:wrap;text-align:center;}
.who{font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--ink);}
.who.pending{color:var(--mut);font-weight:500;font-style:italic;}
.swap{color:var(--mut);font-size:15px;}
.meta{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px;}
.chip{font-size:11px;font-weight:600;color:var(--sub);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:3px 10px;}
.live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--sub);}
.dot{width:7px;height:7px;border-radius:50%;background:var(--mut);}
.live.on .dot{background:var(--credit);box-shadow:0 0 0 3px var(--creditbg);}
.live.closed .dot{background:var(--owe);}
.statement{margin-top:18px;padding-top:18px;border-top:1px solid var(--line);text-align:center;}
.stmt{font-size:14px;color:var(--sub);}
.stmt .n{font-weight:600;color:var(--ink);}
.balance{margin-top:8px;font-family:var(--mono);font-size:38px;font-weight:600;letter-spacing:-.02em;line-height:1;display:flex;align-items:baseline;justify-content:center;gap:7px;font-variant-numeric:tabular-nums;}
.statement.owe .balance{color:var(--owe);}
.statement.credit .balance{color:var(--credit);}
.cur{font-family:"Vazirmatn",sans-serif;font-size:16px;font-weight:500;color:var(--mut);letter-spacing:0;}
/* Numbers are LTR islands so a signed amount inside a Dari sentence keeps
   its sign and digits in order. Never put a DATE in .num. */
.num{direction:ltr;unicode-bidi:isolate;}
/* Join card — party B's first visit. */
.join{margin-top:14px;}
.jtitle{font-size:16px;font-weight:700;letter-spacing:-.01em;}
.jbody{margin-top:4px;font-size:13px;color:var(--sub);}
.field{display:block;margin-top:12px;}
.field span{display:block;font-size:11px;font-weight:600;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;}
.field input{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px 12px;font-size:15px;background:var(--bg);outline:none;}
.field input:focus{border-color:var(--sub);background:var(--card);}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--line);background:var(--card);border-radius:12px;padding:12px 16px;font-size:14px;font-weight:600;color:var(--ink);cursor:pointer;text-align:center;}
.btn:active{background:var(--hair);}
.btn.primary{background:var(--ink);border-color:var(--ink);color:#fff;}
.btn.primary:active{background:#000;}
.btn[disabled]{opacity:.5;cursor:default;}
.btnrow{display:flex;gap:10px;margin-top:14px;}
.btnrow .btn{flex:1;}
/* Add-tally row. INVARIANT (mobile person screen): "I received" LEFT,
   "I gave" RIGHT — the right hand is the giving hand. Pinned LTR so the RTL
   page cannot flip it; the labels themselves are dir=auto. */
.addrow{direction:ltr;display:flex;gap:10px;margin-top:14px;}
.addbtn{flex:1;border:1px solid var(--line);border-radius:14px;padding:14px 12px;font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;}
.addbtn.recv{background:var(--creditbg);color:var(--credit);border-color:transparent;}
.addbtn.gave{background:var(--owebg);color:var(--owe);border-color:transparent;}
.addbtn:active{filter:brightness(.95);}
.addform{margin-top:12px;}
.addform.gave .ftitle{color:var(--owe);}
.addform.recv .ftitle{color:var(--credit);}
.ftitle{font-size:15px;font-weight:700;}
.notice{margin-top:12px;border-radius:12px;padding:11px 14px;font-size:13px;line-height:1.45;background:var(--warnbg);color:var(--warn);border:1px solid #FEDF89;}
.notice.err{background:var(--owebg);color:var(--owe);border-color:#F4C7CF;}
.sectionhead{display:flex;align-items:baseline;justify-content:space-between;margin:26px 4px 12px;}
.sectiontitle{font-size:11px;color:var(--sub);text-transform:uppercase;letter-spacing:.08em;font-weight:600;}
.sectioncount{font-family:var(--mono);font-size:11px;color:var(--mut);font-weight:500;}
.sectioncount b{color:var(--ink);font-weight:600;font-family:"Vazirmatn",sans-serif;}
.rows{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;}
.row{display:flex;align-items:flex-start;gap:12px;padding:13px 16px;border-bottom:1px solid var(--hair);}
.row:last-child{border-bottom:none;}
.ic{width:32px;height:32px;border-radius:8px;background:var(--hair);color:var(--sub);display:flex;align-items:center;justify-content:center;flex:0 0 auto;margin-top:1px;}
/* Tinted arrow chip carries direction: "I gave" = value out → owe colour;
   "I received" = value in → credit colour. Same axis as the balance. */
.ic.gave{background:var(--owebg);color:var(--owe);}
.ic.recv{background:var(--creditbg);color:var(--credit);}
.rmid{min-width:0;flex:1;}
.rtop{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
.ramtrow{display:flex;align-items:baseline;gap:4px;}
.ramt{font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink);}
.rcur{font-size:11px;font-weight:500;color:var(--mut);}
.rmeta{display:flex;align-items:baseline;white-space:nowrap;flex:0 0 auto;}
.rwhen{font-size:12px;color:var(--mut);}
.rsub{display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;}
.rby{font-size:12px;color:var(--mut);}
.pill{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:2px 8px;background:var(--hair);color:var(--sub);}
.pill.disputed{background:var(--warnbg);color:var(--warn);}
.rnote{margin-top:5px;font-size:13px;line-height:18px;color:var(--sub);overflow-wrap:break-word;}
.rreason{margin-top:5px;font-size:12px;line-height:17px;color:var(--warn);}
.racts{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap;}
.act{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:6px 12px;font-size:12px;font-weight:600;color:var(--ink);cursor:pointer;}
.act:active{background:var(--hair);}
.act.danger{color:var(--owe);}
.reasonbox{display:flex;gap:8px;margin-top:9px;width:100%;}
.reasonbox input{flex:1;min-width:0;border:1px solid var(--line);border-radius:9px;padding:8px 10px;font-size:13px;background:var(--bg);outline:none;}
/* Voided: struck, muted, the chip at half strength — visible history, not
   an erasure (D5). */
.row.voided .ramt{text-decoration:line-through;color:var(--mut);}
.row.voided .ic{opacity:.5;}
.empty,.err{color:var(--mut);font-size:14px;padding:28px 4px;text-align:center;}
.cta{margin-top:18px;text-align:center;}
.ctatitle{font-size:14px;font-weight:600;color:var(--sub);}
.foot{margin-top:26px;text-align:center;}
.foottag{font-size:12px;color:var(--mut);}
.foottag a{color:var(--sub);font-weight:700;}
.sk{background:var(--hair);border-radius:5px;animation:pulse 1.5s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
/* Save-as-PDF: the browser's print dialog is the download — no server-side
   PDF engine. Hidden until the rows have loaded; printing a skeleton is
   worse than offering nothing. */
.dl{display:none;width:100%;margin-top:14px;border:1px solid var(--line);background:var(--card);border-radius:12px;padding:13px 16px;font-size:13px;font-weight:600;color:var(--sub);cursor:pointer;align-items:center;justify-content:center;gap:8px;}
.dl.on{display:flex;}
.dl:active{background:var(--hair);}
@media print{
  /* WITHOUT this the tinted arrow chips and the balance colour print as grey:
     browsers drop backgrounds and force black text unless told otherwise. */
  html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#fff;}
  @page{margin:14mm 12mm;}
  .wrap{max-width:none;padding:0;}
  .card,.rows{border-radius:0;border-color:var(--hair);}
  /* Controls are not part of the document. */
  .lang,.join,.addrow,.addform,.notice,.racts,.reasonbox,.cta,.dl,.live{display:none !important;}
  .row,.card{break-inside:avoid;page-break-inside:avoid;}
  .foot{margin-top:18px;}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a class="brand" href="{{.Origin}}">kaata.</a>
    <button type="button" class="lang" id="langbtn"></button>
  </div>
  <div class="card">
    <div class="parties">
      <span class="who{{if not .OtherLabel}} pending{{end}}" id="otherLabel" dir="auto">{{.OtherLabel}}</span>
      <span class="swap">⇄</span>
      <span class="who" id="myLabel" dir="auto">{{.MyLabel}}</span>
    </div>
    <div class="meta">
      <span class="chip" id="curchip">{{.Currency}}</span>
      <span class="live" id="live"><span class="dot"></span><span id="livetext"></span></span>
    </div>
    <div class="statement {{.Direction}}" id="stmt">
      <div class="stmt" id="stmtText"></div>
      <div class="balance"><span class="num" id="balNum">{{.AbsBalance}}</span><span class="cur" id="balCur">{{.Currency}}</span></div>
    </div>
  </div>
  <div class="card join" id="join" hidden>
    <div class="jtitle" id="joinTitle"></div>
    <div class="jbody" id="joinBody"></div>
    <label class="field"><span id="joinNameLabel"></span><input id="joinName" type="text" maxlength="80" autocomplete="name"></label>
    <div class="btnrow"><button type="button" class="btn primary" id="joinBtn"></button></div>
  </div>
  <div class="addrow" id="addrow" hidden>
    <button type="button" class="addbtn recv" id="btnRecv" dir="auto"></button>
    <button type="button" class="addbtn gave" id="btnGave" dir="auto"></button>
  </div>
  <form class="card addform" id="addform" hidden autocomplete="off">
    <div class="ftitle" id="ftitle"></div>
    <label class="field"><span id="amtLabel"></span><input id="amt" type="text" inputmode="decimal" class="num" placeholder="0"></label>
    <label class="field"><span id="noteLabel"></span><input id="note" type="text" maxlength="500"></label>
    <label class="field"><span id="dateLabel"></span><input id="date" type="date"></label>
    <div class="btnrow"><button type="button" class="btn" id="addCancel"></button><button type="submit" class="btn primary" id="addSubmit"></button></div>
  </form>
  <div class="notice" id="notice" hidden></div>
  <div class="sectionhead">
    <span class="sectiontitle" id="txTitle"></span>
    <span class="sectioncount" id="txCount"></span>
  </div>
  <div class="rows" id="entries">
    <div class="row"><div class="ic"></div><div class="rmid"><div class="rtop"><div class="sk" style="width:60px;height:14px"></div><div class="sk" style="width:128px;height:11px"></div></div></div></div>
    <div class="row"><div class="ic"></div><div class="rmid"><div class="rtop"><div class="sk" style="width:68px;height:14px"></div><div class="sk" style="width:120px;height:11px"></div></div></div></div>
    <div class="row"><div class="ic"></div><div class="rmid"><div class="rtop"><div class="sk" style="width:54px;height:14px"></div><div class="sk" style="width:132px;height:11px"></div></div></div></div>
  </div>
  <button type="button" class="dl" id="dlbtn">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    <span id="dllabel"></span>
  </button>
  <div class="card cta" id="cta">
    <div class="ctatitle" id="ctaTitle"></div>
    <div class="btnrow"><a class="btn primary" id="openApp" href="#"></a><a class="btn" id="getApp" href="#" target="_blank" rel="noopener"></a></div>
  </div>
  <div class="foot">
    <!-- dir="ltr": the brand line is all-English in both locales; inside the
         RTL page the trailing "." of "kaata." would snap to the left edge. -->
    <div class="foottag" dir="ltr"><span id="foottag"></span> <a href="{{.Origin}}"><b>kaata.</b></a></div>
  </div>
</div>
<script>
(function(){
  var token = {{.Token}};
  var tabId = {{.TabID}};
  var you = {{.You}};
  var apiBase = {{.APIBase}};
  var origin = {{.Origin}};
  var playUrl = {{.PlayURL}};
  var appStoreUrl = {{.AppStoreURL}};
  var lang = {{.Lang}};
  var other = you === 'a' ? 'b' : 'a';
  // iOS Safari only fires :active when an ancestor has a touch listener; this
  // empty one lets every button show its tap-darken on iOS. Harmless elsewhere.
  document.addEventListener('touchstart', function(){}, {passive:true});

  // Afghan Dari: کاتا, دکان, تلفون — never the Iranian forms.
  var LANGS = {
    en: {
      untitled:"Kaata tab", live:"live", offline:"offline", closed:"closed", gone:"link no longer valid", notJoined:"not joined yet",
      youOwe:"You owe", owesYou:"{n} owes you", youAreOwed:"You are owed", settled:"Settled",
      recv:"I received", gave:"I gave", amount:"Amount", note:"Note (optional)", date:"Date", add:"Add", cancel:"Cancel",
      tx:"Tallies", empty:"No tallies yet.", review:"{n} to review", count:"{n}",
      neu:"New", disputed:"Disputed", voided:"Voided", opening:"Opening balance",
      byYou:"by you", by:"by {n}", accept:"Accept", dispute:"Dispute", voidBtn:"Void", reason:"Reason", send:"Send",
      confirmVoid:"Void this tally? It stays visible, struck out.",
      disputedReason:"Disputed: {r}", dup:"{n} already recorded {a} within a day of this — check before adding again.",
      joinTitle:"{n} shares a tab with you", joinTitleAnon:"You were invited to a shared tab", joinBody:"Enter your name so they know who joined.", yourName:"Your name", join:"Join",
      ctaTitle:"Have Kaata? Keep this tab in your own ledger.", openApp:"Open in Kaata", getApp:"Get the app", pdf:"Save as PDF", tag:"Powered by",
      err:"Couldn't load this tab.", goneBody:"This link is no longer valid.", saveErr:"Couldn't save. Try again.", closedErr:"This tab is closed.", badAmount:"Enter an amount like 250 or 12.50.",
      langBtn:"دری"
    },
    fa: {
      untitled:"حساب مشترک کاتا", live:"زنده", offline:"آفلاین", closed:"بسته شده", gone:"لینک دیگر معتبر نیست", notJoined:"هنوز نپیوسته",
      youOwe:"شما قرضدار هستید", owesYou:"{n} به شما قرضدار است", youAreOwed:"به نفع شما", settled:"تصفیه شده",
      recv:"گرفتم", gave:"دادم", amount:"مقدار", note:"یادداشت (اختیاری)", date:"تاریخ", add:"ثبت", cancel:"لغو",
      tx:"معاملات", empty:"معامله‌ای نیست.", review:"{n} برای بررسی", count:"{n}",
      neu:"تازه", disputed:"اعتراض", voided:"باطل شد", opening:"ماندهٔ قبلی",
      byYou:"از طرف شما", by:"از طرف {n}", accept:"تأیید", dispute:"اعتراض", voidBtn:"باطل کردن", reason:"دلیل", send:"ارسال",
      confirmVoid:"این معامله باطل شود؟ خط‌خورده باقی می‌ماند.",
      disputedReason:"اعتراض: {r}", dup:"{n} همین {a} را در همان روز ثبت کرده است — پیش از ثبت دوباره بررسی کنید.",
      joinTitle:"{n} یک حساب مشترک با شما دارد", joinTitleAnon:"به یک حساب مشترک دعوت شده‌اید", joinBody:"نام خود را بنویسید تا بداند کی پیوسته است.", yourName:"نام شما", join:"پیوستن",
      ctaTitle:"کاتا دارید؟ این حساب را در کاتای خود نگه دارید.", openApp:"در کاتا باز کنید", getApp:"اپ را بگیرید", pdf:"ذخیرهٔ PDF", tag:"Powered by",
      err:"بارگذاری ناموفق بود.", goneBody:"این لینک دیگر معتبر نیست.", saveErr:"ثبت نشد. دوباره کوشش کنید.", closedErr:"این حساب بسته شده است.", badAmount:"مقدار را مانند ۲۵۰ یا ۱۲٫۵۰ بنویسید.",
      langBtn:"EN"
    }
  };
  // The server guessed from Accept-Language; a toggle the visitor made
  // earlier wins. Only preference the page ever stores — never the token.
  try { var saved = localStorage.getItem('kaata_lang'); if (saved === 'en' || saved === 'fa') lang = saved; } catch (e) {}
  function L(){ return LANGS[lang]; }
  function rtl(){ return lang === 'fa'; }
  // Calendar follows language on this page (the two axes the app separates
  // collapse here: a Dari reader gets Solar Hijri, an English reader Gregorian).
  function jalali(){ return rtl(); }
  function applyLang(){ document.documentElement.lang = lang; document.documentElement.dir = rtl() ? 'rtl' : 'ltr'; }
  function setLang(l){ lang = l; try { localStorage.setItem('kaata_lang', l); } catch (e) {} applyLang(); render(); }
  applyLang();

  function esc(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function tpl(s, vars){ return s.replace(/\{(\w+)\}/g, function(_, k){ return vars[k] != null ? vars[k] : ''; }); }
  function $(id){ return document.getElementById(id); }

  var UP='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="7"/><polyline points="6 13 12 7 18 13"/></svg>';
  var DOWN='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="17"/><polyline points="18 11 12 17 6 11"/></svg>';

  // Two INDEPENDENT axes, matching the app (lib/jalali.ts) and the bill page:
  //   jalali -> which calendar (which months exist)
  //   rtl    -> which script (Arabic-script names + Persian digits, or Latin)
  // Calendar conversion stays ICU's; only the vocabulary is ours — the zodiac
  // set (حمل … حوت), never the Iranian names ICU ships for fa.
  var AFM=['حمل','ثور','جوزا','سرطان','اسد','سنبله','میزان','عقرب','قوس','جدی','دلو','حوت'];
  var AFML=['Hamal','Sawr','Jawza','Saratan','Asad','Sunbula','Mizan','Aqrab','Qaws','Jadi','Dalw','Hut'];
  var GME=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var GMF=['جنوری','فبروری','مارچ','اپریل','می','جون','جولای','اگست','سپتمبر','اکتوبر','نومبر','دسمبر'];
  function faNum(s){return String(s).replace(/\d/g,function(d){return '۰۱۲۳۴۵۶۷۸۹'[+d];});}
  function dnum(v){return rtl()?faNum(v):String(v);}
  function fmtDate(ms){
    try{
      var dt=new Date(ms);
      if(jalali()){
        var parts=new Intl.DateTimeFormat('en-US-u-ca-persian',{year:'numeric',month:'numeric',day:'numeric'}).formatToParts(dt);
        var y='',m=0,d='';
        for(var i=0;i<parts.length;i++){var p=parts[i];if(p.type==='year')y=p.value;else if(p.type==='month')m=+p.value;else if(p.type==='day')d=p.value;}
        if(!y||!d||m<1||m>12) throw 0;
        return dnum(d)+' '+(rtl()?AFM:AFML)[m-1]+' '+dnum(y);
      }
      // Day-first in every combination, so all four read the same shape.
      return dnum(dt.getDate())+' '+(rtl()?GMF:GME)[dt.getMonth()]+' '+dnum(dt.getFullYear());
    }catch(e){
      try{return new Date(ms).toLocaleDateString(rtl()?'fa-AF':undefined,{year:'numeric',month:'short',day:'numeric'});}catch(e2){return '';}
    }
  }

  // Money stays a decimal STRING on the wire and integer hundredths here —
  // no float ever touches an amount (D16).
  function toMinor(s){
    s = String(s == null ? '0' : s); var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
    var parts = s.split('.'); var whole = parseInt(parts[0] || '0', 10) || 0;
    var frac = parseInt(((parts[1] || '') + '00').slice(0, 2), 10) || 0;
    var m = whole * 100 + frac; return neg ? -m : m;
  }
  function group(s){ return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtMinor(minor){
    var m = Math.abs(minor); var whole = String(Math.floor(m / 100)); var frac = m % 100;
    var out = group(whole);
    if (frac) { out += '.' + (frac < 10 ? '0' : '') + frac; out = out.replace(/\.(\d)0$/, '.$1'); }
    if (rtl()) { out = faNum(out.replace(/,/g, '٬').replace('.', '٫')); }
    return out;
  }
  // Accepts what a Dari keyboard types: Persian / Arabic-Indic digits and the
  // Arabic decimal separator, normalised to the server's regex shape.
  function normAmount(s){
    s = String(s || '').trim();
    s = s.replace(/[۰-۹]/g, function(d){ return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); });
    s = s.replace(/[٠-٩]/g, function(d){ return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)); });
    s = s.replace(/[٫,]/g, function(c){ return c === '٫' ? '.' : ''; });
    return s;
  }
  var AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

  function uuid(){
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function(x){ return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  }

  // One fetch wrapper: the token rides in the Authorization header (CORS
  // already allows it), never in a query string that would land in logs.
  function api(method, path, body){
    var init = { method: method, headers: { 'Authorization': 'Tab ' + token, 'Accept': 'application/json' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    var abort = new AbortController(); init.signal = abort.signal;
    var deadline = setTimeout(function(){ abort.abort(); }, 15000);
    return fetch(apiBase + path, init).then(function(r){
      return r.text().then(function(t){
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var err = new Error((j && j.error) || ('HTTP ' + r.status)); err.status = r.status; err.code = j && j.error_code; throw err; }
        return j;
      });
    }).finally(function(){ clearTimeout(deadline); });
  }

  // ---- state + polling ---------------------------------------------------
  var base = '/v1/tabs/' + encodeURIComponent(tabId);
  var tab = null, entries = {}, rev = 0, dead = false, failures = 0, timer = null, inflight = false, loaded = false;
  var addType = null, reasonFor = null, noticeText = '', noticeErr = false;

  function absorb(resp){
    if (!resp || !resp.tab) return;
    if (resp.tab.rev < rev) return;
    tab = resp.tab; if (resp.full) entries = {};
    (resp.entries || []).forEach(function(e){ entries[e.id] = e; });
    rev = tab.rev; loaded = true;
  }
  // Cursor pull: only rows with rev > ours come back. After a write we pull
  // rather than trusting the write response's rev, or a concurrent change
  // between two pulls would be skipped forever.
  function pull(){
    if (dead || inflight) return Promise.resolve();
    inflight = true;
    return api('GET', base + '?after_rev=' + rev).then(function(resp){
      inflight = false; failures = 0; absorb(resp); render();
    }).catch(function(err){
      inflight = false;
      if (err.status === 404 || err.status === 401) { dead = true; } else { failures++; }
      render();
    });
  }
  // 10 s while visible; exponential backoff to 60 s on errors; nothing
  // while hidden (the visibilitychange pull catches up).
  function schedule(){
    if (timer) clearTimeout(timer);
    if (dead) return;
    var delay = failures ? Math.min(60000, 10000 * Math.pow(2, failures - 1)) : 10000;
    timer = setTimeout(tick, delay);
  }
  function tick(){ if (document.visibilityState !== 'visible') { schedule(); return; } pull().then(schedule); }
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible') { pull().then(schedule); } });

  // ---- derived -----------------------------------------------------------
  function myLabel(){ return tab ? tab.parties[you].label : ''; }
  function otherLabel(){ return tab ? tab.parties[other].label : ''; }
  function joined(){ return !!(tab && tab.parties[you].joined_at_ms != null); }
  function closed(){ return !!(tab && tab.closed_at_ms != null); }
  function canAct(){ return loaded && !dead && joined() && !closed(); }
  // The party that is the SOURCE of the direction gave value.
  function isGave(e){ return (e.direction === 'a_to_b') === (you === 'a'); }
  function directionFor(gave){ return (gave === (you === 'a')) ? 'a_to_b' : 'b_to_a'; }
  function otherName(){ return otherLabel() || L().notJoined; }

  function setNotice(text, isErr){ noticeText = text || ''; noticeErr = !!isErr; render(); }

  // ---- render ------------------------------------------------------------
  function render(){
    var T = L();
    $('langbtn').textContent = T.langBtn;
    $('txTitle').textContent = T.tx;
    $('foottag').textContent = T.tag;
    $('dllabel').textContent = T.pdf;
    $('ctaTitle').textContent = T.ctaTitle;
    $('openApp').textContent = T.openApp;
    $('getApp').textContent = T.getApp;
    $('btnRecv').textContent = T.recv;
    $('btnGave').textContent = T.gave;
    $('amtLabel').textContent = T.amount; $('noteLabel').textContent = T.note; $('dateLabel').textContent = T.date;
    $('addCancel').textContent = T.cancel; $('addSubmit').textContent = T.add;
    $('joinBody').textContent = T.joinBody; $('joinNameLabel').textContent = T.yourName; $('joinBtn').textContent = T.join;

    // Header + hero
    var ol = $('otherLabel'), ml = $('myLabel');
    if (tab) {
      ol.textContent = otherLabel() || T.notJoined; ol.className = 'who' + (otherLabel() ? '' : ' pending');
      ml.textContent = myLabel() || T.notJoined; ml.className = 'who' + (myLabel() ? '' : ' pending');
      $('curchip').textContent = tab.currency; $('balCur').textContent = tab.currency;
      var bal = toMinor(tab.balance[you]);
      var stmt = $('stmt'); stmt.className = 'statement ' + (bal < 0 ? 'owe' : bal > 0 ? 'credit' : 'settled');
      var sentence = bal < 0 ? T.youOwe : bal > 0 ? (otherLabel() ? tpl(T.owesYou, {n: '<span class="n" dir="auto">' + esc(otherLabel()) + '</span>'}) : T.youAreOwed) : T.settled;
      $('stmtText').innerHTML = sentence;
      $('balNum').textContent = (bal < 0 ? '−' : '') + fmtMinor(bal);
    } else if (!$('otherLabel').textContent) {
      ol.textContent = T.notJoined;
    }
    var live = $('live');
    live.className = 'live' + (dead ? '' : closed() ? ' closed' : failures ? '' : loaded ? ' on' : '');
    $('livetext').textContent = dead ? T.gone : closed() ? T.closed : failures ? T.offline : loaded ? T.live : '';

    // Join card — party B's first visit, before anything else.
    var showJoin = loaded && !dead && !joined() && !closed();
    $('join').hidden = !showJoin;
    if (showJoin) { $('joinTitle').textContent = otherLabel() ? tpl(T.joinTitle, {n: otherLabel()}) : T.joinTitleAnon; }

    // Add-tally
    $('addrow').hidden = !(canAct() && !addType);
    var form = $('addform'); form.hidden = !(canAct() && addType);
    if (addType) { form.className = 'card addform ' + addType; $('ftitle').textContent = addType === 'gave' ? T.gave : T.recv; }

    var n = $('notice'); n.hidden = !noticeText; n.textContent = noticeText; n.className = 'notice' + (noticeErr ? ' err' : '');

    // List — newest first (seq DESC). The kind='void' rows are NOT listed:
    // a void carries the OPPOSITE direction of the tally it cancels, so
    // rendering it beside the struck original reads as a second, inverted
    // tally and doubles what the eye has to reconcile. The struck original
    // IS the audit trail (D5). This is also what the phone shows
    // (lib/tabs/db.ts listTabEntriesAsEntries filters the same way) — both
    // parties must see the same list, which is the whole point of the tab —
    // and it is what the count beside the heading already claimed.
    // (No backticks anywhere below: this whole page is one Go raw string.)
    var el = $('entries');
    if (dead) { el.innerHTML = '<div class="err">' + esc(T.goneBody) + '</div>'; $('txCount').textContent = ''; }
    else if (!loaded) { if (failures) { el.innerHTML = '<div class="err">' + esc(T.err) + '</div>'; } }
    else {
      var list = Object.keys(entries).map(function(k){ return entries[k]; })
        .filter(function(e){ return e.kind !== 'void'; })
        .sort(function(a, b){ return b.seq - a.seq; });
      var count = list.length;
      var pending = tab.pending_for_you || 0;
      $('txCount').innerHTML = (pending ? '<b>' + esc(tpl(T.review, {n: dnum(pending)})) + '</b> · ' : '') + esc(dnum(count));
      el.innerHTML = list.length ? list.map(rowHtml).join('') : '<div class="empty">' + esc(T.empty) + '</div>';
      if (reasonFor) { var inp = el.querySelector('.reasonbox input'); if (inp) inp.focus(); }
    }
    $('dlbtn').className = 'dl' + (loaded && !dead ? ' on' : '');

    // CTA: deep link + store. Android Chrome silently ignores unhandled
    // custom-scheme navigations, so it gets intent:// with a browser
    // fallback (the Invite page's pattern); everything else the plain scheme.
    var ua = navigator.userAgent || '';
    var isAndroid = /Android/i.test(ua), isIOS = /iPhone|iPad|iPod/i.test(ua);
    $('openApp').href = isAndroid
      ? 'intent://t/' + encodeURIComponent(token) + '#Intent;scheme=kaata;S.browser_fallback_url=' + encodeURIComponent(origin + '/download') + ';end'
      : 'kaata://t/' + encodeURIComponent(token);
    $('getApp').href = isIOS ? appStoreUrl : playUrl;
  }

  function rowHtml(e){
    var T = L();
    var cur = tab ? tab.currency : '';
    var mine = e.created_by === you;
    var byline = mine ? T.byYou : tpl(T.by, {n: otherName()});
    // kind='void' never reaches here — the render list filters it out above.
    var gave = isGave(e);
    var voided = e.voided_by_entry_id != null;
    var pill = voided ? '<span class="pill">' + esc(T.voided) + '</span>'
      : e.status === 'disputed' ? '<span class="pill disputed">' + esc(T.disputed) + '</span>'
      : (e.status === 'pending' && !mine) ? '<span class="pill">' + esc(T.neu) + '</span>' : '';
    var note = e.note ? e.note : (e.kind === 'opening' ? T.opening : '');
    var acts = '';
    if (canAct() && !voided) {
      if (!mine && e.status !== 'accepted') acts += '<button type="button" class="act" data-act="accept" data-id="' + esc(e.id) + '">' + esc(T.accept) + '</button>';
      if (!mine && e.status !== 'disputed') acts += '<button type="button" class="act" data-act="dispute" data-id="' + esc(e.id) + '">' + esc(T.dispute) + '</button>';
      if (mine) acts += '<button type="button" class="act danger" data-act="void" data-id="' + esc(e.id) + '">' + esc(T.voidBtn) + '</button>';
    }
    var reason = '';
    if (reasonFor === e.id && canAct()) {
      reason = '<form class="reasonbox" data-id="' + esc(e.id) + '"><input type="text" maxlength="300" placeholder="' + esc(T.reason) + '"><button type="submit" class="act">' + esc(T.send) + '</button></form>';
    }
    return '<div class="row' + (voided ? ' voided' : '') + '">'
      + '<div class="ic ' + (gave ? 'gave' : 'recv') + '" role="img" aria-label="' + esc(gave ? T.gave : T.recv) + '">' + (gave ? UP : DOWN) + '</div>'
      + '<div class="rmid">'
      +   '<div class="rtop">'
      +     '<div class="ramtrow"><span class="ramt num">' + fmtMinor(toMinor(e.amount)) + '</span><span class="rcur">' + esc(cur) + '</span></div>'
      +     '<div class="rmeta"><span class="rwhen" dir="auto">' + esc(fmtDate(e.occurred_at_ms)) + '</span></div>'
      +   '</div>'
      +   '<div class="rsub"><span class="rby" dir="auto">' + esc(byline) + '</span>' + pill + '</div>'
      +   (note ? '<div class="rnote" dir="auto">' + esc(note) + '</div>' : '')
      +   (e.status === 'disputed' && e.dispute_reason ? '<div class="rreason" dir="auto">' + esc(tpl(T.disputedReason, {r: e.dispute_reason})) + '</div>' : '')
      +   (acts ? '<div class="racts">' + acts + '</div>' : '')
      +   reason
      + '</div>'
    + '</div>';
  }

  // ---- actions -----------------------------------------------------------
  function afterWrite(){ return pull().then(schedule); }
  function writeFailed(err){
    var T = L();
    if (err.code === 'tab_closed') setNotice(T.closedErr, true);
    else if (err.status === 404 || err.status === 401) { dead = true; render(); }
    else setNotice(T.saveErr, true);
    // The row may have moved under us (voided by the other side) — resync.
    return pull();
  }

  $('langbtn').addEventListener('click', function(){ setLang(lang === 'fa' ? 'en' : 'fa'); });

  $('joinBtn').addEventListener('click', function(){
    var name = $('joinName').value.trim(); if (!name) { $('joinName').focus(); return; }
    $('joinBtn').disabled = true;
    api('POST', base + '/join', {label: name}).then(function(resp){ absorb(resp); setNotice(''); }).catch(writeFailed)
      .then(function(){ $('joinBtn').disabled = false; return afterWrite(); });
  });

  function openAdd(type){
    addType = type; setNotice('');
    var d = new Date(), mm = String(d.getMonth() + 1), dd = String(d.getDate());
    $('date').value = d.getFullYear() + '-' + (mm.length < 2 ? '0' : '') + mm + '-' + (dd.length < 2 ? '0' : '') + dd;
    $('amt').value = ''; $('note').value = '';
    render(); setTimeout(function(){ $('amt').focus(); }, 50);
  }
  $('btnRecv').addEventListener('click', function(){ openAdd('recv'); });
  $('btnGave').addEventListener('click', function(){ openAdd('gave'); });
  $('addCancel').addEventListener('click', function(){ addType = null; render(); });
  var pendingAppend = null;
  $('addform').addEventListener('submit', function(ev){
    ev.preventDefault();
    var T = L();
    var amount = normAmount($('amt').value);
    if (!AMOUNT_RE.test(amount) || toMinor(amount) <= 0) { setNotice(T.badAmount, true); $('amt').focus(); return; }
    var note = $('note').value.trim();
    // Local noon of the picked day: yyyy-mm-dd parses as UTC midnight, which
    // is the previous evening in Kabul.
    var p = ($('date').value || '').split('-'); var when = p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0).getTime() : Date.now();
    var body = { id: uuid(), direction: directionFor(addType === 'gave'), amount: amount, note: note || null, occurred_at_ms: when };
    // Preserve the id when a response is lost and Save is retried.
    var fingerprint = JSON.stringify([body.direction,body.amount,body.note,body.occurred_at_ms]);
    if (pendingAppend && pendingAppend.fingerprint === fingerprint) body.id = pendingAppend.id;
    pendingAppend = {fingerprint:fingerprint,id:body.id};
    $('addSubmit').disabled = true;
    api('POST', base + '/entries', body).then(function(resp){
      pendingAppend = null;
      addType = null;
      if (resp && resp.duplicate_hint) { setNotice(tpl(T.dup, {n: otherName(), a: fmtMinor(toMinor(amount)) + ' ' + (tab ? tab.currency : '')}), false); }
      else setNotice('');
    }).catch(writeFailed).then(function(){ $('addSubmit').disabled = false; return afterWrite(); });
  });

  $('entries').addEventListener('click', function(ev){
    var b = ev.target.closest('button.act[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    var T = L();
    if (act === 'dispute') { reasonFor = reasonFor === id ? null : id; render(); return; }
    if (act === 'void' && !window.confirm(T.confirmVoid)) return;
    b.disabled = true;
    api('POST', base + '/entries/' + encodeURIComponent(id) + '/' + act, {}).then(function(){ setNotice(''); }).catch(writeFailed).then(afterWrite);
  });
  $('entries').addEventListener('submit', function(ev){
    var f = ev.target.closest('form.reasonbox'); if (!f) return;
    ev.preventDefault();
    var id = f.getAttribute('data-id'); var reason = f.querySelector('input').value.trim();
    if (!reason) { f.querySelector('input').focus(); return; }
    api('POST', base + '/entries/' + encodeURIComponent(id) + '/dispute', {reason: reason}).then(function(){ reasonFor = null; setNotice(''); }).catch(writeFailed).then(afterWrite);
  });

  // Save as PDF: print on the next frame so the browser has laid out the
  // current rows. The list here is one flat render — nothing collapsed that
  // print CSS would have to reveal.
  $('dlbtn').addEventListener('click', function(){
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ window.print(); }); });
  });

  render();
  pull().then(schedule);
})();
</script>
</body>
</html>`

// Localized by the viewer's Accept-Language (viewData.RTL) — an unknown link
// has no tab to follow. Same shape as the bill's notFoundHTML; the copy
// avoids "expired" because a dead tab link is a regenerated or mistyped one,
// and it must read the same for "never existed" and "not yours".
const notFoundHTML = `<!doctype html>
<html lang="{{if .RTL}}fa{{else}}en{{end}}" dir="{{if .RTL}}rtl{{else}}ltr{{end}}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="only light">
<meta name="robots" content="noindex, nofollow">
<title>Kaata</title>
<style>body{margin:0;background:#f9fafb;color:#101828;font-family:"Vazirmatn","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;-webkit-font-smoothing:antialiased;}a{color:#475467;font-weight:600;text-decoration:none;}</style>
</head><body><div><div style="font-size:16px;font-weight:700;letter-spacing:-.01em" dir="ltr">kaata.</div>
<p style="color:#475467;max-width:320px;line-height:1.55">{{if .RTL}}این حساب مشترک وجود ندارد یا لینک آن تازه شده است.{{else}}This tab doesn’t exist, or its link has been renewed.{{end}}</p>
<p><a href="{{.Origin}}">{{if .RTL}}رفتن به kaata.af{{else}}Go to kaata.af{{end}}</a></p></div></body></html>`
