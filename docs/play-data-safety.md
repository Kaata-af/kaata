# Google Play — Data Safety answers (Kaata)

Original audit: app **0.8.6 / versionCode 19**, with shared-account and notification
implementation updates on **2 October 2026**. Original audit ran against
`apps/mobile` + `apps/backend`, multi-agent code audit). If a data flow changes,
update this and the Play form together. Source of truth is the code, not this file.

**Four collection channels** (⚠️ corrected from the earlier draft — the check-in is
NOT anonymous, and there is a third, offline path; the fourth arrived with mutual tabs):

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
   transactions to a public **permanent** link (`kaata.af/v/<token>`). PAPER RULE
   (2026-08-07): a sent bill is the recipient's asset — no TTL, no revocation,
   not erased by account deletion. The snapshot lacks a live account reference but
   contains personal data; it is not anonymous.

4. **Shared account (mutual tab)** — `POST /v1/tabs*`, **user-initiated, requires sign-in
   in the app** (links are invitations, not ongoing browser access). A shared account is one
   running account held by TWO independent parties, so it is **stored server-side in
   plaintext for both of them**: each side's self-chosen **label**, and every tally's
   **amount, date, note, author and accept/reject/void status**. Authenticated parties
   and their authorized kaata members can read and append. Since D18 each party also
   reads the OTHER party's **account phone** (`accounts.phone_e164`, the number set at
   onboarding) on every shared-account payload, including the pre-join preview a
   signed-in holder of the invitation link sees — display/matching only (the join screen
   suggests which contact the invitation came from), never verified identity. It **survives either party's account
   deletion**. Live party/account links are detached; minimal durable author/reviewer
   IDs, recorded names, representative roles, decision times and action semantics
   remain for shared history. These are personal data, not anonymised statistics.
   **Closing freezes it; it does not delete it.** Account deletion closes a tally if
   a side has no remaining authorized representative and retires invitations; it
   never accepts, rejects, cancels or settles entries. This is a product retention
   design, not a legal conclusion that all such data may be kept indefinitely.

So a user who never signs in **still transmits** their own name/phone/shop (check-in),
crash+IP telemetry, and — if they use the share — a customer's ledger. **We collect
data → Yes.** Ledger data goes to **Kaata's own backend (api.kaata.af)**.

**2.0 notification delivery:** when the user grants permission and deployment
enables push, the app sends an Expo push token, installation ID, locale and party
subscription to the backend. Expo/FCM/APNs receive the actor’s party label, tally amount,
currency and outcome, plus tab/entry identifiers, party and revision. They do not receive
notes, balances or invitation credentials. Durable in-app history and per-account read
state are stored server-side; the app caches its first page per account and locale.
Device identifiers are optional for app functionality (notification delivery).
Review the current Play/Apple provider-processing declarations before release;
the old assertion that no messaging provider exists no longer describes 2.0.

---

## Screen 2 — top-level answers (tick through)

- [ ] Collects/shares required data types? → **Yes**
- [ ] All user data encrypted in transit? → **Yes** (TLS to `api.kaata.af`; the only
      cleartext transport is the LAN mesh, which is parked — `MESH_PARKED=true` — and
      doesn't ship)
- [ ] Way to request deletion? → **Yes** — ⚠️ see deletion caveat below

### Deletion caveat

- In-app **Delete account** (`DELETE /v1/account`) removes the signed-in account,
  credentials, owned vaults, memberships and bound installation self-profile/crash
  records. Shared history belonging to others survives. Installation tombstones
  prevent stale devices from reuploading the deleted profile; a minimal matching
  account/install receipt lets a signed session confirm deletion after a lost reply.
- **Gap:** a never-signed-in user's own `self_name`/`self_phone`/`shop_name` on the
  `installs` row has **no in-app delete**; `/v1/shared` bill links are **permanent and
  unrevocable by design** (paper rule 2026-08-07 — disclosed on the Privacy +
  Delete-account pages); and an open **shared account** is deliberately NOT erased by
  one party's account deletion. Deletion automatically closes an unrepresented
  tally; other authorized participants can still read/export its history. The
  email/web deletion request path (hello@kaata.af / kaata.af/delete-account) must
  handle retained personal records and local-only users too. Disclosure alone is
  not a lawful basis or an exception to platform deletion requirements.
- Before release, confirm applicable retention grounds, periods/review criteria,
  erasure exceptions and store disclosures. No universal legal retention period
  or automatic purge of shared evidence is established by this implementation.

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

- [ ] App interactions — **✅ Yes** (installation-linked usage counters: entries created, customers added, shares sent, has-onboarded)
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
   balance + up to 100 transactions, **permanent**), fired by any user incl. offline.
   Token is **already fine** — 96-bit `crypto/rand`, not enumerable. The 2026-07-26
   revocation + TTL were **deliberately removed 2026-08-07** (paper rule: a sent bill
   is the recipient's asset, and the immutable bill chain is the customer's
   tamper-evidence). The permanent-retention exposure is a knowing product decision,
   disclosed on the Privacy page — do not re-flag it as an oversight. "Unrevocable"
   is product policy, not capability: the operator can still hand-delete a specific
   row (`DELETE FROM shared_ledger_snapshots WHERE token = …`) for a verified legal
   or data-subject request — the Privacy page deliberately says "we do not", never
   "we cannot".
2. **Positioning vs architecture:** cloud sync payload is server-readable plaintext
   (deliberate — AI-training angle). Legal once disclosed, but **don't market Kaata as
   "private/local"** until `/v1/sync` is E2E-encrypted. The mesh already has the
   ChaCha20-Poly1305 primitives to reuse. Near-term priority.
