# Play Store listing copy

Paste these into Play Console → Store presence → Main store listing. Keep the
app positioned as a **record-keeping / ledger tool**, not a lender or payment
app, to avoid the Personal Loans policy false-positive.

## Feature graphic (1024×500, required)

`docs/store-assets/feature-graphic.png` — upload this in Main store listing →
Graphics → Feature graphic. It's the black brand field with the white K mark,
the `kaata.` wordmark, and a product card. To regenerate/tweak, edit
`docs/store-assets/feature-graphic.html` and re-render with headless Chrome:
`chrome --headless=new --allow-file-access-from-files --window-size=1024,500
--screenshot=feature-graphic.png feature-graphic.html` (the HTML references the
Vazirmatn/JetBrains ttf under `apps/mobile/node_modules` by absolute path, so
run it from this machine or fix those paths first).

## Phone screenshots (2–8 required; ≥4 at ≥1080px for promo eligibility)

`docs/store-assets/screenshots/*.png` — six 1080×1920 (9:16) marketing panels,
promotion-eligible and also valid for the 7"/10" tablet slots (Play accepts the
same 9:16 images there). Upload in this order:

1. `01-home.png` — "Know who owes you, at a glance." (home / to-collect list)
2. `02-whatsapp-reminder.png` — "A polite nudge, on WhatsApp." (the reminder message)
3. `03-person-detail.png` — "One running balance, every deal logged." (person + history)
4. `04-add-entry.png` — "Gave or received? Logged in seconds." (add-entry + keypad)
5. `05-onboarding.png` — "Your shop's book, ready in a minute." (setup done)
6. `06-dari.png` — "In your language. Works offline." (Dari home; LTR-locked like the app)

Built from the app's real design system (Vazirmatn + JetBrains Mono, exact
color tokens, faithful layouts) via `docs/store-assets/gen-screens.js` →
headless Chrome. To regenerate: `node gen-screens.js` then
`chrome --headless=new --allow-file-access-from-files --window-size=1080,1920
--screenshot=screenshot-N.png screenshot-N.html`. The generator references
Vazirmatn/JetBrains ttf under `apps/mobile/node_modules` and the K asset by
absolute path — run on this machine or fix those paths first.

Note: `02-whatsapp-reminder.png` depicts a WhatsApp chat to show the reminder
feature. That's standard for depicting an integration, but if you'd rather not
show WhatsApp's UI, drop it — the other five still exceed Play's minimums.

## Short description (max 80 chars)

**English**
```
A simple digital khata to track who owes you and what you owe. Works offline.
```

**دری**
```
یک کاتای دیجیتلی ساده برای پیگیری این‌که چه کسی به شما بدهکار است. آفلاین کار می‌کند.
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

بنویسید چه کسی به شما بدهکار است و شما به چه کسی بدهکار هستید؛ کاتا برای هر شخص موازنهٔ جاری را نگه می‌دارد. بدون ورق‌زدنِ کتابچهٔ کاغذی، همیشه می‌دانید حساب‌تان کجاست.

چرا کاتا
• آفلاین کار می‌کند — کاتای شما روی تلفن‌تان است. برای افزودن مشتری یا ثبت پرداخت به انترنت ضرورت نیست.
• ساده و سریع — یک شخص اضافه کنید، آنچه گرفت یا پرداخت را ثبت کنید، و کاتا حساب را انجام می‌دهد.
• یادآوریِ دوستانه — با دو ضربه، موازنهٔ مشتری را از طریق واتساپ برایش بفرستید.
• به زبان شما — انگلیسی و دری.
• رایگان.

چطور کار می‌کند
• آدم‌هایی را که با آن‌ها سروکار دارید اضافه کنید — مشتری، تهیه‌کننده، دوست.
• هر بار که کسی جنس نسیه می‌برد یا پرداخت می‌کند، ثبت کنید. کاتا موازنه را خودکار به‌روز می‌کند.
• در یک نگاه ببینید از چه کسی باید بگیرید و به چه کسی بدهکار هستید.
• برای فرستادنِ یادآوری با موازنه از طریق واتساپ ضربه بزنید — بدون گفتگوی ناراحت‌کننده.

معلومات شما، روی تلفن شما
کاتای شما روی دستگاه‌تان ذخیره می‌شود. ورود (اختیاری) اجازه می‌دهد آن را در کلاد پشتیبان بگیرید و روی تلفن نو بازیابی کنید. هر وقت خواستید می‌توانید حساب و داده‌های خود را از بخش تنظیمات حذف کنید.

کاتا یک ابزار ثبت حساب است. بانک، قرض‌دهنده یا سرویس پرداخت نیست — پول انتقال نمی‌دهد، قرض نمی‌دهد و سود نمی‌گیرد. فقط کمک می‌کند به یاد بسپارید چه کسی چه‌قدر بدهکار است.

ساخت کابل.
```
