# Play Store listing copy

Paste these into Play Console → Store presence → Main store listing. Keep the
app positioned as a **record-keeping / ledger tool**, not a lender or payment
app, to avoid the Personal Loans policy false-positive.

## App icon (512×512)

`docs/store-assets/play-icon-512.png` is the opaque 512px export of the original
black launcher icon with the white K, derived from `apps/mobile/assets/icon.png`.
The App Store icon comes from that app binary. The marketing recolor generator
writes only its separate marketing logo and cannot overwrite product icons.
The 2.2.0 production IPA was inspected directly: its iPhone/iPad icons contain
the correct opaque Kaata mark and its compiled asset catalog is present.

## Persian screenshot campaign

The October 16 campaign follows Matee’s Facebook reference: white background,
black original K logo, blue emphasis (`#1683C5`), and a thin yellow–blue–red
footer. All headlines, sample customer names, notes and UI labels are Persian
(Dari wording). Amounts and counts retain English digits. Product chrome stays
neutral black/white; the released customer actions use soft apricot and sage.
No Google logo, store badge or download button appears.

The images are **manually composed app previews with fictional data**, not
native device captures. They follow the current screens and installed app
fonts. Check against the final iOS/Android release when preparing future updates.

### Banner and customer image refresh — October 20, 2026

The Play feature graphic keeps its existing Persian copy, white/blue campaign
and footer. Its complete phone, logo and copy now sit inside **132px horizontal
insets**, replacing the former 56/58px margins. A 522×294 `object-fit: cover`
preview reproduces the user's clipped Play card with the old image and retains
**37.56px** of visible side space with the corrected image. Only the decorative
footer reaches the edges. The source stays at Play's required **1024×500**;
the safe area is checked in the generated layout as well as visually.

All five `02-person-detail.png` variants now match the tested/released 2.2.3
buttons: physical-left **I received** uses `#E4EEE6`, ink `#3E6149` and coin
`#CDDFD1`; physical-right **I gave** uses `#F6E4D5`, ink `#7D4923` and coin
`#ECD0B7`. Existing arrows, Persian labels, equal touch-target heights and
fictional customer data remain intact. iOS previews retain their native font
line-height floor. The surrounding campaign and other screenshot panels are
unchanged.

The six changed PNGs passed the existing renderer's font, asset, text-clipping,
dimensions and opacity checks. All five customer panels were independently
reviewed in full and checked for the six exact palette colors. The side-by-side
crop proof, approved file hashes and publication receipts are retained under
ignored `.generated/store-refresh-2026-10-20/`.

**Google Play:** the image-only edit `06799624388228727958` was accepted at
**02:42 UTC**. Independent readback verified all four intended image groups,
hashes and order, with **5/5** preservation checks passing. Listing text, app
details, icon, other image types/locales and every release track stayed unchanged;
production and internal **2.2.3/code 67** remain published. Screenshot slot 1
kept its original ID. Slots 2–6 were uploaded in order because the image API
appends uploads; only slot 2 has new pixels, and slots 3–6 remain byte-identical.
The guarded updater passed **29/29** mocked checks before its single invocation.
New feature image ID: `18002848814488897640`; customer image IDs:
`8506320547017544328` (phone), `9286799201023342740` (7-inch), and
`16666537614471662517` (10-inch). Receipts: `play-image-refresh-receipt.json`
and `artwork-verification.json` in the ignored refresh folder.

Public availability is **not yet confirmed**. At **02:45 UTC**, the public
en-US/US listing's three customer images still matched the old images exactly
at the pixel level. Google's publishing API and public CDN use different URL
identifiers, so direct pathname comparison is inconclusive; the pixel check is
recorded in `public-pixel-verification.json`. A read-only Console browser check
was rejected by automatic approval for a domain mismatch (`google.play`
instead of the requested `play.google.com`). It was not retried or bypassed;
the Console's precise review/publication status remains unverified. The
successful API commit and independent preservation readback are unaffected.

**App Store:** Matee explicitly chose to preserve 2.2.3/build 40's current
Waiting for Review submission. No Apple assets or review state were changed.
The corrected iPhone and iPad customer PNGs are ready for the **next release**.
Apple disallows screenshot edits while waiting for review, and withdrawing
would restart review on resubmission. See
[Apple's submission status rules](https://developer.apple.com/help/app-store-connect/reference/app-information/app-and-submission-statuses/)
and [withdrawal consequences](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/remove-a-submission-from-review/).

### Store upload status — October 16, 2026

Artwork commit: `a14f1f8`. Both stores use the existing `en-US` listing locale;
the images themselves are entirely Persian with English digits.

- **Google Play:** committed 19 images: six phone, six 7-inch tablet, six
  10-inch tablet, and one feature graphic. A fresh read verified every image's
  order and SHA-1/SHA-256 against the local files. Screenshot submission **32**
  is **Published**. Production **2.2.0 (59)** was subsequently submitted and is
  **In review**, with a full rollout configured after approval; the Console
  shows its automatic pre-review checks running. Internal **2.2.0 (59)** is
  published. Previous production **2.1.1 (50)** remains live. Listing text,
  icon, app details, screenshot hashes/order and closed tracks were preserved.
- **App Store:** six iPhone and six iPad images remain on `2.2.0`
  (`ea388b29-3c37-4a6c-a5b8-5f00b3a19374`), with all uploads processed
  successfully. Build **39** is attached and the release is **Waiting for
  Review**, submitted October 16 at 19:02 Kabul time. Submission
  `a01151c0-a38d-4e76-95b9-693a5d02bc9e` contains that one version. Automatic
  release to all users after approval is enabled. Released `2.1.1`, its
  metadata and its ten screenshot placements remain unchanged until approval;
  the new screenshots accompany the 2.2.0 release.

The original screenshot-only update did not build an app. Matee subsequently
authorized the production release: Android 59 was built locally and iOS 39 on
Expo. See [the production release record](2.2.0-production-release.md) for
artifact checks, store delivery and the iOS draft icon investigation. Local
receipts remain in the ignored `.generated/store-upload` directory.

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
