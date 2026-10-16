# Play Store listing copy

Paste these into Play Console → Store presence → Main store listing. Keep the
app positioned as a **record-keeping / ledger tool**, not a lender or payment
app, to avoid the Personal Loans policy false-positive.

## App icon (512×512)

`docs/store-assets/play-icon-512.png` is the opaque 512px export of the original
black launcher icon with the white K, derived from `apps/mobile/assets/icon.png`.
The App Store icon comes from that app binary. The marketing recolor generator
writes only its separate marketing logo and cannot overwrite product icons.
These source assets are ready for a future production listing update; the
2.2.0 testing delivery does not change the current production store listings.

## Persian screenshot campaign — local review draft

The October 16 campaign follows Matee’s Facebook reference: white background,
black original K logo, blue emphasis (`#1683C5`), and a thin yellow–blue–red
footer. All headlines, sample customer names, notes and UI labels are Persian
(Dari wording). Amounts and counts retain English digits. The product remains
neutral black/white; no Google logo, store badge or download button appears.

The images are **manually composed app previews with fictional data**, not
native device captures. They follow the current screens and installed app
fonts. Check against the final iOS/Android release before uploading; this work
creates local artwork only and does not change any live store listing.

Six panels use the same order in every device folder:

1. `01-home.png` — تمام حساب‌ها، در یک نگاه.
2. `02-person-detail.png` — هر معامله، ثبت. هر حساب، روشن.
3. `03-add-entry.png` — دادید یا گرفتید؟ همین حالا ثبت کنید.
4. `04-search.png` — پیدا کنید، انتخاب کنید. جمع حساب را ببینید.
5. `05-onboarding.png` — یک شروع ساده، یک کاتای تازه.
6. `06-reminder.png` — زمان پیگیری را فراموش نکنید.

The reminder panel shows Kaata’s personal reminder editor. It does not imply
that a scheduled reminder automatically sends a customer a WhatsApp message.
The person panel uses the real shared-account badge; sample balances reconcile
with the displayed transactions. Search demonstrates a combined list and
selection totals. Onboarding reflects the new outlined success icon.

| Folder under `docs/store-assets` | Export size | Intended slot                  |
| -------------------------------- | ----------- | ------------------------------ |
| `screenshots`                    | 1080 × 1920 | Google Play phone              |
| `iphone-6.5`                     | 1284 × 2778 | App Store accepted iPhone size |
| `tablet-screenshots/7-inch`      | 1260 × 2240 | Google Play 7-inch tablet      |
| `tablet-screenshots/10-inch`     | 1620 × 2880 | Google Play 10-inch tablet     |
| `ipad-13`                        | 2048 × 2732 | App Store 13-inch iPad         |
| `feature-graphic.png`            | 1024 × 500  | Google Play feature graphic    |

Tablet previews preserve the app’s single-column layout at tablet logical
widths, including onboarding’s 480-point maximum content width. They do not
invent a tablet dashboard. Android exports use a camera dot; iPhone exports
use an island. All PNGs are opaque RGB.

Dimensions were checked against the official
[Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
and [Google Play preview-asset guidance](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en).

## Editing and rendering the artwork

- `store-design.js`: Persian campaign copy, palette and output sizes.
- `store-scenes.js`: fictional app data, UI composition and Persian layout.
- `gen-screens.js`: installed mobile fonts, icons and shared UI primitives.
- `generate-store-assets.js`: campaign layouts and feature graphic.
- `render-store-assets.js`: local Chrome rendering and export checks.

From the repository root:

```powershell
node docs/store-assets/render-store-assets.js
```

This exports the PNGs and creates a local review gallery at
`docs/store-assets/.generated/index.html`, with phone/tablet contact sheets and
`validation.json`. It waits for fonts and images, rejects visible English
words, detects clipped text boxes, and verifies image dimensions and opacity.
Review every image visually as well; automated checks cannot verify native UI
fidelity. The ignored `.generated` folder contains local absolute font paths.

For a single review image:

```powershell
node docs/store-assets/render-store-assets.js --platform play-phone --slug home
```

The tool uses installed Playwright (resolved normally, via `NODE_PATH`, or from
the desktop’s bundled runtime) and installed Chrome. `CHROME_PATH` can override
the browser executable. It does not download dependencies or run Expo/EAS.
The legacy `gen-iphone65.js`, `gen-tablet10.js`, and `gen-ipad13.js` entry points
still generate HTML for their respective sets through the shared generator.
The website demo thumbnail and social/flyer artwork are separate assets.

## Short description (max 80 chars)

**English**

```
A simple digital khata to track who owes you and what you owe. Works offline.
```

**دری**

```
یک کاتای دیجیتلی ساده برای پیگیری این‌که چه کسی به شما قرضدار است. آفلاین کار می‌کند.
```

## Full description (max 4000 chars)

**English**

```
Kaata is a simple digital khata (ledger) for shopkeepers — and anyone who keeps track of money between people they trust.

Write down who owes you and what you owe, and Kaata keeps a running balance for every person. You always know where you stand, without flipping through a paper notebook.

WHY KAATA
• Works offline — your ledger lives on your phone. No internet needed to add a customer or record a payment.
• Simple and fast — add a person, record what they took or paid, and Kaata does the math.
• Friendly reminders — send a customer a gentle WhatsApp reminder of their balance in two taps.
• In your language — English and Dari.
• Free.

HOW IT WORKS
• Add the people you deal with — customers, suppliers, friends.
• Each time someone takes goods on credit or makes a payment, record it. Kaata updates the balance automatically.
• See at a glance who you need to collect from and who you owe.
• Tap to send a WhatsApp reminder with the balance — no awkward conversation needed.

YOUR DATA, ON YOUR PHONE
Your ledger is stored on your device. Sign in (optional) to back it up to the cloud and restore it on a new phone if you ever lose this one. You can delete your account and its data at any time from Settings.

Kaata is a record-keeping tool. It is not a bank, a lender, or a payment service — it doesn't move money, lend money, or charge interest. It simply helps you remember who owes what.

Made in Kabul.
```

**دری**

```
کاتا یک دفترچهٔ حساب (خاتهٔ) دیجیتلی ساده برای دکانداران است — و برای هر کسی که حساب پول را بین آدم‌های مورد اعتمادش نگه می‌دارد.

بنویسید چه کسی به شما قرضدار است و شما به چه کسی قرضدار هستید؛ کاتا برای هر شخص موازنهٔ جاری را نگه می‌دارد. بدون ورق‌زدنِ کتابچهٔ کاغذی، همیشه می‌دانید حساب‌تان کجاست.

چرا کاتا
• آفلاین کار می‌کند — کاتای شما روی تلفن‌تان است. برای افزودن مشتری یا ثبت پرداخت به انترنت ضرورت نیست.
• ساده و سریع — یک شخص اضافه کنید، آنچه گرفت یا پرداخت را ثبت کنید، و کاتا حساب را انجام می‌دهد.
• یادآوریِ دوستانه — با دو ضربه، موازنهٔ مشتری را از طریق واتساپ برایش بفرستید.
• به زبان شما — انگلیسی و دری.
• رایگان.

چطور کار می‌کند
• آدم‌هایی را که با آن‌ها سروکار دارید اضافه کنید — مشتری، تهیه‌کننده، دوست.
• هر بار که کسی جنس نسیه می‌برد یا پرداخت می‌کند، ثبت کنید. کاتا موازنه را خودکار به‌روز می‌کند.
• در یک نگاه ببینید از چه کسی باید بگیرید و به چه کسی قرضدار هستید.
• برای فرستادنِ یادآوری با موازنه از طریق واتساپ ضربه بزنید — بدون گفتگوی ناراحت‌کننده.

معلومات شما، روی تلفن شما
کاتای شما روی دستگاه‌تان ذخیره می‌شود. ورود (اختیاری) اجازه می‌دهد آن را در کلاد پشتیبان بگیرید و روی تلفن نو بازیابی کنید. هر وقت خواستید می‌توانید حساب و داده‌های خود را از بخش تنظیمات حذف کنید.

کاتا یک ابزار ثبت حساب است. بانک، قرض‌دهنده یا سرویس پرداخت نیست — پول انتقال نمی‌دهد، قرض نمی‌دهد و سود نمی‌گیرد. فقط کمک می‌کند به یاد بسپارید چه کسی چه‌قدر قرضدار است.

ساخت کابل.
```
