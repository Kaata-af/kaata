package tabs

// Invitation landing only. html/template escapes the invitation token in script
// context. Opening the web app still requires sign-in and an explicit join.
// Neutral product styling stays separate from the flyers/social palette.
const viewHTML = `<!doctype html>
<html lang="{{.Language}}" dir="{{if .RTL}}rtl{{else}}ltr{{end}}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta property="og:title" content="{{if eq .Language "ps"}}د کاټه د ګډ حساب بلنه{{else if .RTL}}دعوت به حساب مشترک کاتا{{else}}Kaata shared-account invitation{{end}}">
<meta property="og:description" content="{{if eq .Language "ps"}}دا بلنه په کاټه کې پرانیزئ.{{else if .RTL}}این دعوت را در کاتا باز کنید.{{else}}Open this invitation in Kaata.{{end}}">
<title>Kaata</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:#FFFFFF;color:#171717;font:16px/1.7 system-ui,sans-serif}
main{width:100%;max-width:420px;text-align:center;background:white;border:1px solid #E2E2E2;border-radius:20px;padding:36px 24px}
.brand{font-size:26px;font-weight:700;color:#000000}h1{font-size:21px;line-height:1.5;margin:24px 0 12px}p{color:#6B6B6B}
a{display:block;color:#171717;text-decoration:none;padding:12px;margin-top:8px;border:1px solid #E2E2E2;border-radius:12px}
.primary{background:#000000;color:white;border-color:#000000;font-weight:600;margin:24px 0}
.stores{display:flex;gap:8px}.stores a{flex:1;font-size:14px}
</style></head><body><main>
<div class="brand" dir="ltr">kaata.</div>
<h1>{{if eq .Language "ps"}}په کاټه کې ګډ حساب{{else if .RTL}}حساب مشترک در کاتا{{else}}Share an account in Kaata{{end}}</h1>
<p>{{if eq .Language "ps"}}د ګډون لپاره اپ یا د کاټه وېب پرانیزئ او خپل حساب ته ننوځئ.{{else if .RTL}}برای پیوستن، اپ یا کاتای وب را باز کنید و وارد حساب خود شوید.{{else}}Open the app or Kaata Web and sign in to join.{{end}}</p>
{{if eq .RecordingMode "notify_one_way"}}<p>{{if eq .Language "ps"}}یوازې د دې اړیکې جوړوونکی ثبتونه زیاتولی شي. تاسو حساب کتلی شئ او خبرتیاوې ترلاسه کوئ. د هر ثبت جلا تایید ته اړتیا نشته؛ ګډون د هر ثبت د منلو معنا نه لري.{{else if .RTL}}فقط سازندهٔ این ارتباط می‌تواند ثبت اضافه کند. شما حساب را می‌بینید و اطلاعیه دریافت می‌کنید. تأیید جداگانهٔ هر ثبت لازم نیست؛ پیوستن به معنی تأیید هر ثبت نیست.{{else}}Only the person who created this link can add tallies. You can view the account and receive notifications. No individual approval is needed; joining does not mean you accepted each tally.{{end}}</p>{{else if eq .RecordingMode "notify"}}<p>{{if eq .Language "ps"}}په دې حساب کې ثبتونه د هر ثبت له جلا تایید پرته لیکل کېږي او تاسو ته خبر درکول کېږي. ګډون د هر ثبت د منلو معنا نه لري.{{else if .RTL}}در این حساب، ثبت‌ها بدون تأیید جداگانه درج می‌شوند و به شما خبر داده می‌شود. پیوستن به این حساب به معنی تأیید هر ثبت نیست.{{else}}Tallies in this account are recorded without individual approval, and you receive notifications. Joining does not mean you accepted each tally.{{end}}</p>{{end}}
<a class="primary" id="open" href="#">{{if eq .Language "ps"}}په کاټه کې پرانیزئ{{else if .RTL}}باز کردن در کاتا{{else}}Open in Kaata{{end}}</a>
<a id="open-web" href="{{.Origin}}/app" rel="noreferrer" referrerpolicy="no-referrer">{{if eq .Language "ps"}}په کاټه وېب کې پرانیزئ{{else if .RTL}}باز کردن در کاتای وب{{else}}Open in Kaata Web{{end}}</a>
<p>{{if eq .Language "ps"}}د موبایل اپ غواړئ؟ له لاندې یې ښکته کړئ.{{else if .RTL}}اپ موبایل را ترجیح می‌دهید؟ از لینک‌های زیر دانلود کنید.{{else}}Prefer the mobile app? Download it below.{{end}}</p>
<div class="stores"><a href="{{.AppStoreURL}}" rel="noreferrer">App Store</a><a href="{{.PlayURL}}" rel="noreferrer">Google Play</a></div>
</main><script>
(function(){
  var token = {{.Token}};
  var app = 'kaata://t/' + encodeURIComponent(token);
  if (/Android/i.test(navigator.userAgent)) {
    app = 'intent://t/' + encodeURIComponent(token) + '#Intent;scheme=kaata;package=af.kaata.app;S.browser_fallback_url=' + encodeURIComponent({{.PlayURL}}) + ';end';
  }
  document.getElementById('open').href = app;
  document.getElementById('open-web').href = {{.Origin}} + '/app#shared_invite=' + encodeURIComponent(token);
})();
</script></body></html>`

// Localized by the viewer's Accept-Language (viewData.Lang) — an unknown link
// has no tab to follow. Same shape as the bill's notFoundHTML; the copy
// avoids "expired" because a dead tab link is a regenerated or mistyped one,
// and it must read the same for "never existed" and "not yours".
const notFoundHTML = `<!doctype html>
<html lang="{{.Language}}" dir="{{if .RTL}}rtl{{else}}ltr{{end}}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="only light">
<meta name="robots" content="noindex, nofollow">
<title>Kaata</title>
<style>body{margin:0;background:#FFFFFF;color:#171717;font-family:"Vazirmatn","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;-webkit-font-smoothing:antialiased;}a{color:#616161;font-weight:600;text-decoration:none;}</style>
</head><body><div><div style="font-size:16px;font-weight:700;letter-spacing:-.01em" dir="ltr">kaata.</div>
<p style="color:#616161;max-width:320px;line-height:1.55">{{if eq .Language "ps"}}دا ګډ حساب نشته، یا یې لینک نوی شوی دی.{{else if .RTL}}این حساب مشترک وجود ندارد یا لینک آن تازه شده است.{{else}}This tab doesn’t exist, or its link has been renewed.{{end}}</p>
<p><a href="{{.Origin}}">{{if eq .Language "ps"}}kaata.af ته لاړ شئ{{else if .RTL}}رفتن به kaata.af{{else}}Go to kaata.af{{end}}</a></p></div></body></html>`
