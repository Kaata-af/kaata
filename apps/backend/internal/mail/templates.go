package mail

import (
	"html"
	"strings"

	"github.com/matee/kaata-backend/internal/locale"
)

// Kind names one transactional email. No free user-supplied text ever reaches
// a template: only our own copy, the recipient address, a 6-digit code and, in
// one notice, a masked sign-in address that passed address validation.
type Kind string

const (
	KindSignupCode      Kind = "signup_code"      // finish creating an account
	KindResetCode       Kind = "reset_code"       // set a new password
	KindSetupCode       Kind = "setup_code"       // add a first password while signed in
	KindAccountExists   Kind = "account_exists"   // sign-up for an address that already has a password
	KindProviderOnly    Kind = "provider_only"    // sign-up or reset for a Google/Apple-only account
	KindPasswordChanged Kind = "password_changed" // security notice, no code
	// A Google/Apple account whose password signs in with another address
	// (named masked): reset codes go there, not to this address.
	KindPasswordElsewhere Kind = "password_elsewhere"
	KindPasswordRemoved   Kind = "password_removed" // the password sign-in was removed
)

type copyText struct {
	subject string
	lead    string // the sentence before the code (or the whole notice)
}

var copyEN = map[Kind]copyText{
	KindSignupCode:        {"Your Kaata sign-up code", "Use this code to finish creating your Kaata account:"},
	KindResetCode:         {"Reset your Kaata password", "Use this code to set a new password for your Kaata account:"},
	KindSetupCode:         {"Your Kaata code", "Use this code to add a password to your Kaata account:"},
	KindAccountExists:     {"You already have a Kaata account", "Someone, maybe you, tried to create a Kaata account with this email address, but you already have one. Sign in with your password, or tap \"Forgot password?\" in the app to set a new one. If this wasn't you, you can ignore this email."},
	KindProviderOnly:      {"Sign in to Kaata with Google or Apple", "Your Kaata account signs in with Google or Apple and has no password yet. Use that button to sign in. After signing in, you can add a password in Account settings. If this wasn't you, you can ignore this email."},
	KindPasswordChanged:   {"Your Kaata password was changed", "The password of your Kaata account was just set or changed. If this was you, there is nothing to do. If it wasn't, open Kaata now and tap \"Forgot password?\" to set a new one; that signs you out on every other phone."},
	KindPasswordElsewhere: {"How you sign in to Kaata", "Someone, maybe you, asked for a Kaata code for this address. Your Kaata account signs in with Google or Apple, and its password belongs to another email address, {address}, where reset codes go. If you don't recognize that address, sign in with Google or Apple, open Account, then Sign-in, and remove the password. Otherwise you can ignore this email."},
	KindPasswordRemoved:   {"Your Kaata password was removed", "The password of your Kaata account was removed: it now signs in only with Google or Apple, and phones that used the password were signed out. If this was you, there is nothing to do. If it wasn't, open Kaata, sign in with Google or Apple and check Account settings."},
}

var copyFA = map[Kind]copyText{
	KindSignupCode:        {"کود ثبت‌نام کاتا", "برای تکمیل ساختن حساب کاتای خود از این کود استفاده کنید:"},
	KindResetCode:         {"بازیابی رمز کاتا", "برای گذاشتن رمز نو برای حساب کاتای خود از این کود استفاده کنید:"},
	KindSetupCode:         {"کود کاتای شما", "برای افزودن رمز به حساب کاتای خود از این کود استفاده کنید:"},
	KindAccountExists:     {"شما از قبل حساب کاتا دارید", "کسی، شاید خود شما، کوشش کرد با این آدرس ایمیل حساب کاتا بسازد، اما شما از قبل حساب دارید. با رمز خود وارد شوید، یا در برنامه «رمز را فراموش کرده‌اید؟» را بزنید تا رمز نو بگذارید. اگر این کار شما نبوده، این ایمیل را نادیده بگیرید."},
	KindProviderOnly:      {"با گوگل یا اپل به کاتا وارد شوید", "حساب کاتای شما با گوگل یا اپل وارد می‌شود و هنوز رمز ندارد. با همان دکمه وارد شوید. پس از ورود می‌توانید در تنظیمات حساب رمز بگذارید. اگر این کار شما نبوده، این ایمیل را نادیده بگیرید."},
	KindPasswordChanged:   {"رمز کاتای شما تغییر کرد", "رمز حساب کاتای شما همین حالا گذاشته یا تغییر داده شد. اگر این کار شما بوده، کاری لازم نیست. اگر نه، همین حالا کاتا را باز کنید و «رمز را فراموش کرده‌اید؟» را بزنید تا رمز نو بگذارید؛ این کار شما را از همه تلفون‌های دیگر خارج می‌کند."},
	KindPasswordElsewhere: {"چگونه به کاتا وارد شوید", "کسی، شاید خود شما، برای این آدرس کود کاتا خواست. با گوگل یا اپل وارد حساب کاتای خود می‌شوید، اما برای ورود با رمز از آدرس ایمیل دیگری، {address}، استفاده می‌کنید. کودهای بازیابی رمز به آن آدرس فرستاده می‌شوند. اگر آن آدرس را نمی‌شناسید، با گوگل یا اپل وارد شوید، «حساب» و سپس «ورود» را باز کنید و رمز را حذف کنید. در غیر آن، می‌توانید این ایمیل را نادیده بگیرید."},
	KindPasswordRemoved:   {"رمز کاتای شما حذف شد", "رمز حساب کاتای شما حذف شد. اکنون تنها با گوگل یا اپل می‌توانید وارد شوید. از این حساب در تلفون‌هایی که با رمز وارد شده بودند، خارج شدید. اگر خودتان این کار را کرده‌اید، کاری لازم نیست. اگر نه، کاتا را باز کنید، با گوگل یا اپل وارد شوید و تنظیمات حساب را بررسی کنید."},
}

var copyPS = map[Kind]copyText{
	KindSignupCode:        {"ستاسو د کاټه د نوم‌لیکنې کوډ", "د خپل کاټه حساب جوړولو د بشپړولو لپاره دا کوډ وکاروئ:"},
	KindResetCode:         {"د کاټه پټنوم مو بیا وټاکئ", "د خپل کاټه حساب لپاره د نوي پټنوم ټاکلو په موخه دا کوډ وکاروئ:"},
	KindSetupCode:         {"ستاسو د کاټه کوډ", "خپل کاټه حساب ته د پټنوم زیاتولو لپاره دا کوډ وکاروئ:"},
	KindAccountExists:     {"تاسو له مخکې د کاټه حساب لرئ", "یو چا، ښايي تاسو، هڅه کړې چې په دې برېښنالیک د کاټه حساب جوړ کړي، خو تاسو له مخکې حساب لرئ. په خپل پټنوم ننوځئ، یا په اپ کې «پټنوم مو هېر شوی؟» ووهئ او نوی پټنوم وټاکئ. که دا کار تاسو نه وي کړی، دا برېښنالیک له پامه وغورځوئ."},
	KindProviderOnly:      {"د ګوګل یا اپل له لارې کاټه ته ننوځئ", "ستاسو د کاټه حساب د ګوګل یا اپل له لارې پرانیستل کېږي او لا پټنوم نه لري. د ننوتلو لپاره هماغه تڼۍ ووهئ. تر ننوتلو وروسته د حساب په امستنو کې پټنوم زیاتولای شئ. که دا کار تاسو نه وي کړی، دا برېښنالیک له پامه وغورځوئ."},
	KindPasswordChanged:   {"ستاسو د کاټه پټنوم بدل شو", "ستاسو د کاټه حساب پټنوم همدا اوس وټاکل شو یا بدل شو. که دا کار تاسو کړی وي، بل کار ته اړتیا نشته. که مو نه وي کړی، همدا اوس کاټه پرانیزئ او «پټنوم مو هېر شوی؟» ووهئ چې نوی پټنوم وټاکئ؛ په دې سره به ستاسو حساب په نورو ټولو ټیلیفونونو کې ووځي."},
	KindPasswordElsewhere: {"کاټه ته څنګه ننوځئ", "یو چا، ښايي تاسو، د دې پتې لپاره د کاټه کوډ غوښتی دی. ستاسو د کاټه حساب د ګوګل یا اپل له لارې پرانیستل کېږي، خو د پټنوم له لارې د ننوتلو لپاره مو بله برېښنالیک پته، {address}، کارولې ده. د پټنوم د بیا ټاکلو کوډونه هغې پتې ته لېږل کېږي. که هغه پته نه پېژنئ، د ګوګل یا اپل له لارې ننوځئ، «حساب» او بیا «ننوتل» پرانیزئ او پټنوم لرې کړئ. که نه، دا برېښنالیک له پامه غورځولای شئ."},
	KindPasswordRemoved:   {"ستاسو د کاټه پټنوم لرې شو", "ستاسو د کاټه حساب پټنوم لرې شو. اوس یوازې د ګوګل یا اپل له لارې ننوتلای شئ، او په هغو ټیلیفونونو کې مو حساب ووت چې په پټنوم ورننوتلي وو. که دا کار تاسو کړی وي، بل کار ته اړتیا نشته. که مو نه وي کړی، کاټه پرانیزئ، د ګوګل یا اپل له لارې ننوځئ او د حساب امستنې وګورئ."},
}

const (
	footerPS = "دا کوډ په 15 دقیقو کې باطلېږي. دا کوډ له هېچا سره مه شریکوئ. که تاسو نه وي غوښتی، دا برېښنالیک له پامه وغورځوئ."
	footerEN = "It expires in 15 minutes. Never share this code with anyone. If you didn't ask for it, ignore this email."
	footerFA = "این کود پس از 15 دقیقه باطل می‌شود. این کود را با هیچ‌کس شریک نکنید. اگر شما آن را نخواسته‌اید، این ایمیل را نادیده بگیرید."
)

// HasCode reports whether a kind carries a code.
func (k Kind) HasCode() bool {
	return k == KindSignupCode || k == KindResetCode || k == KindSetupCode
}

// Lang returns the supported language, accepting regional tags and Dari prs.
func Lang(lang string) string { return locale.Normalize(lang) }

// MaskAddress shows the first character of the local part and the whole
// domain ("t***@evil.af"): enough for the owner to recognize the mailbox.
func MaskAddress(addr string) string {
	at := strings.LastIndexByte(addr, '@')
	if at <= 0 {
		return "***"
	}
	return addr[:1] + "***" + addr[at:]
}

// Render builds a message in English, Dari or Pashto.
// The code is never in the subject: lock-screen previews show the opening
// sentence, and the code only after it.
func Render(kind Kind, lang, to, code string) Message {
	return render(kind, lang, to, code, "")
}

// RenderElsewhere builds the KindPasswordElsewhere notice, which names the
// account's password sign-in address masked (MaskAddress).
func RenderElsewhere(lang, to, maskedAddress string) Message {
	return render(KindPasswordElsewhere, lang, to, "", maskedAddress)
}

func render(kind Kind, lang, to, code, address string) Message {
	lang = Lang(lang)
	rtl := locale.RTL(lang)
	table, footer, dir, htmlLang := copyEN, footerEN, "ltr", "en"
	if lang == "fa" {
		table, footer, dir, htmlLang = copyFA, footerFA, "rtl", "fa"
	} else if lang == "ps" {
		table, footer, dir, htmlLang = copyPS, footerPS, "rtl", "ps"
	}
	c := table[kind]

	textLead := c.lead
	htmlLead := html.EscapeString(c.lead)
	if strings.Contains(c.lead, "{address}") {
		shown := address
		if rtl {
			shown = "\u2066" + address + "\u2069" // LTR isolate inside RTL text
		}
		textLead = strings.ReplaceAll(textLead, "{address}", shown)
		htmlLead = strings.ReplaceAll(htmlLead, "{address}", `<span dir="ltr">`+html.EscapeString(address)+`</span>`)
	}

	var text strings.Builder
	text.WriteString(textLead)
	text.WriteString("\n\n")
	if kind.HasCode() {
		if rtl {
			// LTR isolate, so the digits keep their order inside RTL text.
			text.WriteString("⁦" + code + "⁩")
		} else {
			text.WriteString(code)
		}
		text.WriteString("\n\n")
		text.WriteString(footer)
		text.WriteString("\n")
	}

	var h strings.Builder
	// Transactional mail stays neutral, separate from marketing. Codes stay large,
	// dark and selectable; all verification instructions retain their wording.
	h.WriteString(`<!doctype html><html lang="` + htmlLang + `" dir="` + dir + `"><body style="margin:0;padding:24px;background:#F7F7F7;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#292929"><div style="max-width:520px;margin:0 auto;padding:24px;background:#FFFFFF;border:1px solid #E2E2E2;border-radius:16px">`)
	h.WriteString(`<p dir="ltr" style="margin:0 0 24px;font-size:22px;font-weight:bold;color:#000000">kaata.</p>`)
	h.WriteString("<p>" + htmlLead + "</p>")
	if kind.HasCode() {
		h.WriteString(`<p dir="ltr" style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:Menlo,Consolas,monospace;color:#171717;background:#F7F7F7;padding:16px;border-radius:12px">` +
			html.EscapeString(code) + "</p>")
		h.WriteString(`<p style="color:#616161;font-size:14px">` + html.EscapeString(footer) + "</p>")
	}
	h.WriteString("</div></body></html>")

	return Message{To: to, Subject: c.subject, Text: text.String(), HTML: h.String()}
}
