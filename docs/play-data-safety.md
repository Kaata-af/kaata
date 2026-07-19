# Google Play — Data Safety answers (Kaata)

Code-accurate as of app **0.8.6 / versionCode 19** (audited 9–10 July 2026 against
`apps/mobile` + `apps/backend`, multi-agent code audit). If a data flow changes,
update this and the Play form together. Source of truth is the code, not this file.

**Three collection channels** (⚠️ corrected from the earlier draft — the check-in is
NOT anonymous, and there is a third, offline path):

1. **Check-in** — `POST /v1/check-in`, every launch, **no opt-out → "required"**.
   Carries install/usage/diagnostics **AND the shopkeeper's own `self_name` /
   `self_phone` / `shop_name`** (migration 028). So own-identity leaves the device
   with **no sign-in required**.
2. **Sign-in + cloud sync** — Google/Apple, **only if the user signs in → "optional"**.
   Account identity + the **full customer ledger** (names, phones, amounts, notes),
   uploaded server-readable (`/v1/sync/push`, plaintext JSON over TLS — signed, not
   encrypted).
3. **WhatsApp "full ledger" share** — `POST /v1/shared`, **user-initiated, no auth,
   works offline too**. Uploads **one customer's** name + balance + up to 100
   transactions to a public 90-day link (`kaata.af/v/<token>`).

So a user who never signs in **still transmits** their own name/phone/shop (check-in),
crash+IP telemetry, and — if they use the share — a customer's ledger. **We collect
data → Yes.** All off-device data goes to **Kaata's own backend (api.kaata.af)**;
Google/Apple are used **only for sign-in**.
→ **"Data shared with third parties" = NONE** (no analytics/ads/attribution/crash/
messaging SDK exists — verified: no Firebase/Sentry/Segment/Amplitude/AdMob/FCM).

---

## Screen 2 — top-level answers (tick through)

- [ ] Collects/shares required data types? → **Yes**
- [ ] All user data encrypted in transit? → **Yes** (TLS to `api.kaata.af`; the only
      cleartext transport is the LAN mesh, which is parked — `MESH_PARKED=true` — and
      doesn't ship)
- [ ] Way to request deletion? → **Yes** — ⚠️ see deletion caveat below

### Deletion caveat

- In-app **Delete account** (`DELETE /v1/account`) + server `redacted_at` erasure cover
  **signed-in** users.
- **Gap:** a never-signed-in user's own `self_name`/`self_phone`/`shop_name` on the
  `installs` row has **no in-app delete**; `/v1/shared` links auto-expire at 90 days but
  aren't user-revocable. Provide an **email/web deletion request** URL
  (hello@kaata.af / kaata.af/delete-account) as the catch-all so "Yes" is honest.

---

## 1. Data types — what to SELECT on the "Data types" screen

### Location — select **neither**

- Approximate location — **No** (no location permission; backend does not resolve IP → region)
- Precise location — **No**

### Personal info

- [ ] Name — **✅ Yes** (own name via **check-in**, + customer/supplier names via sync)
- [ ] Email address — **✅ Yes** (own Google/Apple email)
- [ ] User IDs — **✅ Yes** (account_id, Google/Apple `sub`)
- [ ] Phone number — **✅ Yes** (own phone via **check-in** + account, + customer/supplier phones via sync)
- Address — No · Race/ethnicity — No · Political/religious beliefs — No · Sexual orientation — No · Other info — No

### Financial info

- [ ] Other financial info — **✅ Yes** (the ledger debt/credit **amounts** — Google's
      definition of "Other financial info" literally names _"debts"_. Sent via sync
      **and** via the WhatsApp share.)
- User payment info — No (no cards/bank instruments) · Purchase history — No · Credit score — No

### Contacts — **✅ Yes** (declare defensively)

Nuance from the audit: the device **address book is read on-device only and is NOT
uploaded** (`contacts-sync.ts` imports only `expo-contacts`, no network). Strictly,
"Contacts" as a _type_ isn't transmitted — a contact the user promotes to a customer
becomes ledger Name/Phone (declared under Personal info). **But** the app holds
`READ_CONTACTS`/`WRITE_CONTACTS`, and Google cross-references permissions against this
form — so **declaring Contacts avoids review friction**. Keep it checked. (Verified:
`app.json:47-48,70-74`, `contacts-sync.ts`, `person/new.tsx`.)

### App activity

- [ ] App interactions — **✅ Yes** (anonymous usage counters: entries created, customers added, shares sent, has-onboarded)
- [ ] Other user-generated content — **✅ Yes** (transaction **notes**, shop/vault name)
- In-app search history — No · Installed apps — No · Other actions — No (folds into App interactions)

### App info and performance

- [ ] Crash logs — **✅ Yes** · Diagnostics — **✅ Yes** (app version, platform, memory figures)
- Other app performance data — No

### Device or other IDs — **✅ Yes**

Anonymous `install_id` (locally-generated UUID) + device Ed25519 public keys + client
**IP** captured server-side in `crash_reports`/`web_visits`. **Not** an advertising ID /
hardware ID (none collected).

### Select **No** for all of these

Health & fitness · Messages (the WhatsApp reminder is composed by the user and handed to
WhatsApp — the app doesn't read messages) · Photos & videos · Audio · Files & docs ·
Calendar · Web browsing history.

> **Judgment call — Photos:** signing in returns a Google **profile-picture URL**
> (`picture_url`). It's an OAuth avatar URL, not photo-library access, so **No** is the
> standard, defensible answer.

---

## 2. Per-type follow-up answers

For **every** selected type: **Collected = Yes · Shared = No · Processed ephemerally =
No** (all stored server-side). Encrypted in transit (see §3).

**Why "Shared = No":** "Shared" = transfer to a third party. Our only third-party touch
is Sign-in with Google/Apple — the user authenticating _themselves_ with a provider that
already holds that identity; Google's rules exclude user-initiated auth from "sharing."
No data sold; no ad/analytics SDKs.

| Data type                                                      | Purpose(s)                                                                         | Collection is…                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Device or other IDs (`install_id`, IP)                         | App functionality, Analytics                                                       | **Required** (automatic check-in)                                                                         |
| App activity → App interactions (usage counters)               | Analytics                                                                          | **Required** (automatic)                                                                                  |
| App info & performance → Diagnostics                           | Analytics, App functionality (force-update)                                        | **Required** (automatic)                                                                                  |
| App info & performance → Crash logs                            | Analytics (crash/bug diagnosis)                                                    | **Required** (automatic)                                                                                  |
| Personal info → **Name**                                       | App functionality, Account management; own-name also Analytics (feedback outreach) | **Required** ⚠️ (own name via check-in — no opt-out)                                                      |
| Personal info → **Phone number**                               | App functionality, Account management                                              | **Required** (own phone is mandatory in onboarding — `profile.tsx:148-155` — then sent on every check-in) |
| Personal info → Email address                                  | Account management                                                                 | **Optional** (sign-in only)                                                                               |
| Personal info → User IDs (account_id/sub)                      | Account management                                                                 | **Optional** (sign-in only)                                                                               |
| Financial info → Other financial info (amounts)                | App functionality (backup/restore, member sync); also user-initiated share         | **Optional** (requires sign-in OR a deliberate WhatsApp-share tap)                                        |
| App activity → Other user-generated content (notes, shop name) | App functionality                                                                  | **Optional** (sign-in only)¹                                                                              |

("Required" = collected automatically, user cannot opt out. "Optional" = the user
controls it by choosing whether to sign in / share.)

¹ _Shop name is also sent on check-in (`shop_name`), so if you want to be strict, "Other
user-generated content" leans Required too. Notes only leave via sync (optional). Pick
Required for the type if you'd rather over-declare._

---

## 3. Security & remaining questions

- **All user data encrypted in transit?** → **Yes.** All requests use TLS to
  `https://api.kaata.af`. _(Awareness, not a form field: the ledger is plaintext JSON
  over TLS — signed but not additionally end-to-end encrypted; the server can read it.)_
- **Way to request deletion?** → **Yes** (in-app Delete account + email
  hello@kaata.af + kaata.af/delete-account) — mind the deletion caveat above.
- **Data shared with third parties?** → **None.**
- **Data collected from children / Families policy?** → No (audience is shopkeepers).
- **Independent security review badge?** → No.

---

## 4. Flags worth knowing

- **Check-in is not anonymous** — it carries the shopkeeper's own name/phone/shop. This
  is why Name/Phone are "Required," not "Optional (sign-in only)."
- **The debt amounts** must be declared as **Financial info › Other financial info**, not
  only as UGC — declaring them only as UGC under-declares their financial nature.
- **Contacts** — declared defensively (permission cross-check), though the address book
  itself isn't uploaded.
- Crash-report `message` strings are truncated and _intended_ PII-free but not guaranteed
  — covered by declaring Crash logs.

---

## Appendix A — Apple carry-over (for the iOS build later)

**App Privacy labels** — mirror the above, all **Linked to the user**, **Not used for
tracking** (no ad/attribution SDK): Contact Info (Name/Email/Phone) · Financial Info
(debt balances) · User Content (notes) · Identifiers (User ID/Device ID) · Diagnostics ·
Usage Data.

**Export compliance** (`ITSAppUsesNonExemptEncryption`): audit is definitive — **no
proprietary/custom cryptographic _algorithm_**; all standard primitives (Ed25519,
X25519, ChaCha20-Poly1305, HKDF-SHA512, HMAC-SHA256, SHA-2) from `@noble/*` + native
`expo-crypto` (one hand-written SHA-1 for UUIDs = standard algorithm, non-security). So
Apple's "proprietary encryption?" → **No**; qualify for the **standard-cryptography
exemption**. `false` is defensible, but the honest posture is "uses encryption, all
standard/exempt" (we do use ChaCha20 in the parked mesh) — not "no encryption."

---

## Appendix B — Two things that matter more than the form (not launch blockers)

1. **`/v1/shared` is a public, no-auth link** to a named customer's debt record (name +
   balance + up to 100 transactions, 90-day TTL), fired by any user incl. offline.
   Token is **already fine** — 96-bit `crypto/rand` (`service.go:92-98`), not
   enumerable. Remaining gap is only **no revocation** (a link lives its full 90 days)
   - the 90-day retention of a named customer's debt on a public URL. Low urgency;
     consider a revoke button + shorter TTL later.
2. **Positioning vs architecture:** cloud sync payload is server-readable plaintext
   (deliberate — AI-training angle). Legal once disclosed, but **don't market Kaata as
   "private/local"** until `/v1/sync` is E2E-encrypted. The mesh already has the
   ChaCha20-Poly1305 primitives to reuse. Near-term priority.
