# Google Play — Data Safety answers (Kaata)

Code-accurate as of app **0.8.6** (audited 9 July 2026 against `apps/mobile` +
`apps/backend`). If a data flow changes, update this and the Play form together.

Two collection channels:

- **Check-in** (`POST /v1/check-in`, every launch, **no opt-out → "required"**) — anonymous install/usage/diagnostics.
- **Sign-in + cloud sync** (Google/Apple, **only if the user signs in → "optional / user can choose"**) — account identity + the ledger.

A user who never signs in transmits **no ledger content and no personal identity** — only the anonymous check-in.
All off-device data goes to **Kaata's own backend (api.kaata.af)**; Google/Apple are used **only for sign-in**.
→ **"Data shared with third parties" = NONE** (no analytics, ads, attribution, crash, or messaging SDK exists — verified: no Firebase/Sentry/Segment/Amplitude/AdMob/FCM).

---

## 1. Data types — what to SELECT on the "Data types" screen

### Location — select **neither**

- Approximate location — **No** (no location permission; backend does not resolve IP → region)
- Precise location — **No**

### Personal info

- Name — **✅ Yes** (own Google/Apple name + customer/supplier names)
- Email address — **✅ Yes** (own Google/Apple email)
- User IDs — **✅ Yes** (account_id, Google/Apple `sub`)
- Phone number — **✅ Yes** (own account phone + customer/supplier phones)
- Address — No · Race/ethnicity — No · Political/religious beliefs — No · Sexual orientation — No · Other info — No

### Financial info

- Other financial info — **✅ Yes** (the ledger debt/credit **amounts** — Google's definition of "Other financial info" literally names _"debts"_)
- User payment info — No (no cards/bank instruments) · Purchase history — No · Credit score — No

### Contacts — **✅ Yes**

The app holds `READ_CONTACTS`/`WRITE_CONTACTS`, reads the phone book for the "add customer" picker, and (once signed in) syncs the picked contact's name+number to the backend. Google cross-references the permission against this form, so **declare it**.

### App activity

- App interactions — **✅ Yes** (anonymous usage counters: entries created, customers added, shares sent, has-onboarded)
- Other user-generated content — **✅ Yes** (transaction **notes**, shop/vault name)
- In-app search history — No · Installed apps — No · Other actions — No (folds into App interactions)

### App info and performance

- Crash logs — **✅ Yes** · Diagnostics — **✅ Yes** (app version, platform, memory figures)
- Other app performance data — No

### Device or other IDs — **✅ Yes**

Anonymous `install_id` (a locally-generated UUID) + device Ed25519 public keys. **Not** an advertising ID / hardware ID (none collected).

### Select **No** for all of these

Health & fitness · Messages (the WhatsApp reminder is composed by the user and handed to WhatsApp — the app doesn't read messages) · Photos & videos · Audio · Files & docs · Calendar · Web browsing history.

> **Judgment call — Photos:** signing in returns a Google **profile-picture URL** (stored as `picture_url`). It's an OAuth avatar URL, not access to your photo library, and there's no photo/camera-photo collection — so **No** is the standard, defensible answer. (If you want maximum caution you _could_ declare Photos & videos → Photos; not required.)

---

## 2. Per-type follow-up answers

For **every** selected type: **Collected = Yes · Shared = No · Processed ephemerally = No** (all are stored server-side). Encrypted in transit (see §3).

| Data type                                                      | Purpose(s)                                                                         | Collection is…                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| Device or other IDs (`install_id`)                             | App functionality, Analytics                                                       | **Required** (automatic check-in)             |
| App activity → App interactions (usage counters)               | Analytics                                                                          | **Required** (automatic)                      |
| App info & performance → Diagnostics                           | Analytics, App functionality (force-update)                                        | **Required** (automatic)                      |
| App info & performance → Crash logs                            | Analytics (crash/bug diagnosis)                                                    | **Required** (automatic)                      |
| Personal info → Name                                           | Account management, App functionality; own-name also Analytics (feedback outreach) | **Optional** (sign-in only)                   |
| Personal info → Email address                                  | Account management                                                                 | **Optional** (sign-in only)                   |
| Personal info → Phone number                                   | Account management, App functionality                                              | **Optional** (sign-in only)                   |
| Personal info → User IDs                                       | Account management                                                                 | **Optional** (sign-in only)                   |
| Financial info → Other financial info (ledger amounts)         | App functionality (cloud backup/restore, member sync)                              | **Optional** (sign-in only)                   |
| App activity → Other user-generated content (notes, shop name) | App functionality                                                                  | **Optional** (sign-in only)                   |
| Contacts                                                       | App functionality (add customers from phone book)                                  | **Optional** (transmitted only after sign-in) |

("Required" = collected automatically, user cannot opt out. "Optional" = the user controls it by choosing whether to sign in.)

---

## 3. Security & remaining questions

- **Is all user data encrypted in transit?** → **Yes.** All requests go to `https://api.kaata.af` (TLS). _(Note for your own awareness, not a form field: the ledger is sent as plaintext JSON over TLS — it is not additionally end-to-end encrypted.)_
- **Do you provide a way to request deletion?** → **Yes** (in-app Delete account + email hello@kaata.af; page at kaata.af/delete-account).
- **Data shared with third parties?** → **None.**
- **Data collected from children / Families policy?** → No (audience is shopkeepers; no age gate).
- **Independent security review badge?** → No.

---

## 4. Flags worth knowing

- **Contacts** is the easy one to miss — you hold `READ_CONTACTS` and sync picked contacts, so it must be declared (verified: `app.json:47-48,70-74`, `contacts-sync.ts`, `person/new.tsx`).
- Crash-report `message` strings are truncated and _intended_ to exclude PII, but aren't guaranteed 100% free of user-typed text — covered by declaring **Crash logs**.
- The debt **amounts** must be declared as **Financial info › Other financial info**, not only as "user-generated content" — declaring them only as UGC would under-declare their financial nature.
