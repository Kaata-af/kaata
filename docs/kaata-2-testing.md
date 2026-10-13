# Kaata 2.0 — testing and rollout

Implementation: mutual accounts attached to contacts, inline accept/reject,
author-only cancellation of pending tallies, app-only signed-in participation,
durable offline queue, and push delivery infrastructure. Existing private ledger
events are not rewritten.
Automated checks and store submissions do not replace native two-phone testing.

## Testing delivery — 14 October 2026 (57/37)

Candidate **2.2.0 / Android 57 / iOS 37** uses the exact release source
`0424b02effd243e10f509771afa64b788cd79655`, pushed to `main`. This request targets
**Play internal testing** and the existing **TestFlight internal group** only.
Both testing releases are independently verified available.
Production 2.1.1 is now approved on both stores; older pending-review statements
below describe their historical checks. No 2.2.0 production promotion, closed-track
change, review cancellation or production listing edit is part of this delivery.

This candidate restores the original black native icon/splash and black/white/gray
product theme, adopts neutral shadcn web controls and isolates the colored marketing
logo/generators. Financial/review/provider/chart colors keep their meaning. It also
includes the combined home search, distinct Manage groups action, persistent
zero-tally customers, keyboard dismissal, clear-button alignment and smoother search
transitions developed after 36/56. Dashboard weekly activity, growth and cohorts
now follow **Saturday–Friday in Kabul**; Friday usage is included.

- **Live backend/web:** deployment `UGcfDy1IyVSLQMyF32RcJ` (backend) and
  `6no-2cGcW423Egmv_6kgn` (web) completed with exact source and fresh healthy
  containers. Migration 060 and its calendar constraint/function are present.
  Authenticated growth and weekly-stat reads returned 200, `week_starts_on=6`,
  and all 12 labels on Saturdays; cohort starts match. The original 11 Monday
  aggregates retain their complete fingerprint `0fc860bb9f3337ecf032ae1b0ca91086`,
  including counts, rules and recorded timestamps; 11 Saturday frozen aggregates
  are stored separately. Public health, neutral CSS, original logo hash and SMTP
  login passed.
- **Checks:** all 53 mobile selftest suites, mobile TypeScript, explicit iOS and
  Android production Metro/Hermes exports, all 90 web tests/typecheck/build, and
  26 release-helper tests passed. The full backend passed 14 tested packages and
  567 test/subcase results against an isolated UTF-8 PostgreSQL database, with no
  failures or database skips; only the optional bill-preview generator skipped.
  Go vet and server compilation passed. Original native asset bytes and marketing
  generator/path guards were verified. Browser QA covered neutral desktop/phone
  public layouts in English/Dari and the admin sign-in screen.
- **Native dependency note:** these binaries use the same native dependency
  versions/lockfile as 36/56. Expo Doctor's existing 29 patch-version warnings
  remain within SDK 57/RN 0.86; no native dependency or architecture change was
  introduced. A signed build is not a physical-device behavior check.
- **iOS 37:** EAS build `4eff038b-311e-467f-a477-cd20aefab214` finished with the
  exact version/build/source; upload `76199406-fd8c-40e0-940f-8f695a02edf7` finished.
  ASC build `14197de8-97fc-43f3-9711-f4be2f3c9a23` is `VALID`, unexpired and
  `IN_BETA_TESTING`, assigned to **Team (Expo)**
  `fcb33597-43b6-42ba-8582-b85d26fc3895`, with automatic tester notification enabled
  and exempt-encryption metadata verified. All 2,870 characters of the new English
  testing notes were written and read back exactly. The complete Apple production
  version/review snapshot matches preflight; no group/encryption change or
  production submission was needed.
- **Android 57:** EAS build `2cca5fd2-3ecc-4d11-b6b6-85d21b2400c6` finished at
  `2026-10-13T20:05:22.184Z`, with exact version/code/source verified. AAB:
  94,815,237 bytes; SHA-256
  `b75c21ab651943b6275ef49a351dac320c7dec322ed5f461a571d31298357568`.
  The guarded uploader verified Google's returned code/hash, validated and
  committed internal only once with `ERROR_IF_IN_REVIEW`. Its canonical lifecycle
  read confirms `RELEASE_LIFECYCLE_STATE_PUBLISHED` for code 57 and unchanged
  production 2.1.1/code 50. A separate disposable edit read confirmed internal
  `status=completed`, exact English testing notes, and byte-equivalent production
  and closed alpha track snapshots. That inspection edit was deleted without
  commit. Alpha remains code 43; no production or closed-testing submission was made.

Evidence is retained under ignored `apps/mobile/dist/testing-37-57`. Update existing
installations without uninstalling. Native keyboard/drag/cancel geometry, original
splash/launcher appearance, date/time widgets, blur, reminders and two-phone
shared-ledger restore/reconnect still need device checks. Use synthetic data for
deletion and credit-limit tests. The consolidated checklist remains in
[next-release-refinements.md](next-release-refinements.md).

## Testing delivery — 13 October 2026 (56/36)

Built **2.2.0 / Android 56 / iOS 36** from reviewed feature source `57d41c9`
and release commit `83314b0ba4134d7c1e154d709bca9c2e6b436879`, pushed to main.
Destinations were **Google Play internal testing** and the existing
**TestFlight internal tester group** only. TestFlight is available; Play's guarded
commit was acknowledged and a separate track read confirmed the internal release
is `completed`. Its newer lifecycle listing endpoint hit a quota, so an explicit
`RELEASE_LIFECYCLE_STATE_PUBLISHED` response was not obtained for code 56.
Production and closed-testing tracks and App Store reviews were preserved.
The Play uploader remains restricted to this exact package/version/code, commits
with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, and has no review-cancellation
fallback. The iOS helper manages TestFlight only.

- **Android 56:** EAS build `ba72c977-8cae-4452-b4b3-d024599f221d` finished at
  `2026-10-12T21:10:15.170Z`, with the exact version, code and source verified.
  Downloaded AAB: 94,827,126 bytes; SHA-256
  `b73181426cc4b462b1391ed97048b6edc9e6f6bd67f844e481b6fe26a982ede0`.
  The first upload received Google HTTP 503 before any commit, and cleanup could
  not initially be confirmed. Independent lifecycle reads showed no code 56,
  then a disposable bundle inventory confirmed that no code 56 artifact had been
  accepted and was deleted without commit. A fresh guarded attempt uploaded,
  validated and committed internal only. Its final lifecycle read failed due to
  `Listing releases quota exceeded`; it was not uploaded again. One separate
  disposable edit read confirmed `2.2.0 (56) — internal testing`, code 56,
  `status=completed`, and the exact updated English notes. That inspection edit
  was deleted without any track, tester, listing or commit mutation.
- **iOS 36:** EAS build `1e68923c-2510-4a74-ad2b-b3e71ac3e0d8` finished from the
  same exact source. Upload `313fd97c-c38b-46fd-9eff-9ff9deb44291` finished.
  ASC build `1599b2ad-1f6c-4358-bf24-8fdd5db6df90` is `VALID` and
  `IN_BETA_TESTING`, assigned to the existing **Team (Expo)** internal group
  `fcb33597-43b6-42ba-8582-b85d26fc3895`, with automatic tester notification
  enabled and exempt-encryption metadata verified. All 2,989 characters of the
  new English testing notes were written and read back exactly.
- **Production preserved:** Apple's complete version/review snapshot matched
  preflight; 2.1.1/build 30 remains `WAITING_FOR_REVIEW`. Play production code 50
  remained `IN_REVIEW` after the guarded commit, with code 40 published. Alpha
  code 43 remained published. The final separate edit read also confirmed the
  same production and alpha codes; those older track statuses do not assert
  production approval. No production or closed-testing submission was made.
- **Backend/web:** Dokploy auto-deploy completed from `83314b0` before store
  distribution. Backend deployment `ZdV8a1eXhDIMX3mh3IwZa` and web deployment
  `wm2phC2sjWoUDEHX7XeII` had fresh healthy containers and matching checkouts.
  Live migrations 058/059, the growth table, refusal fields and indexes were
  verified; public backend health was `ok`, the website returned 200, and the
  new credit-refusal route required authentication (401 without credentials).

This candidate adds the reviewed sign-in/restore/session fixes, shared-sync
watchdog and reconnect catch-up, kaata default credit limits and refusal details,
group member editing and repair migration, group filter subtotals, reminder
permission/named-alert refinements, Qamari adjustment, search/date/keyboard and
accessibility corrections, and the updated brand icons/splash. Backend migrations
058 and 059 and matching web/server support are live. The Android neutral widget
theme and brand assets are included in these new native binaries.

Fresh checks for `57d41c9` passed all 52 mobile selftest suites and TypeScript,
89 web tests and the TypeScript/Vite production build, and nine changed backend
packages against an isolated PostgreSQL database (519 test/subcase passes, no
failures or database skips; only the opt-in bill-image preview was skipped).
The server command compiled, diff checks were clean, eight generated logos
matched their generator and 34 raster assets decoded. Explicit iOS and Android
production Metro/Hermes exports passed. All 26 Play/TestFlight release-helper
tests passed with no skips, and resolved Expo config verified 2.2.0/56/36,
`af.kaata.app`, the neutral Android theme plugin and Aubergine adaptive icon.
These local checks do not verify a signed binary or native device behavior.
Both signed cloud builds finished successfully; native device checks remain
separate from build/upload verification. Operation evidence is retained locally
under ignored `apps/mobile/dist/testing-36-56`, with no credentials in this log.
Device checks remain outstanding: email swipe Back, keyboard/dock geometry,
Android native theme/pickers/blur, native reminder delivery and two-phone shared-ledger
reconnect/restore. Use synthetic data for deletion and credit-limit tests; update
existing installations without uninstalling.

Earlier release candidate: **2.1.0 / Android 47 / iOS 27**: build 46/26
(below) plus the fixes for its known issues, all mobile-only (the backend is
unchanged):

- **Retired installs recover.** HTTP 410 from check-in or Google/Apple sign-in
  now means "this phone's last account was deleted". The app explains it and
  sets `app_meta.install_retired`, which a later successful check-in or sign-in
  for the same install clears. Account offers "Reset this phone" behind a
  destructive confirmation, as does the sign-in screen. Home's dialog only
  opens Account. The reset is a local wipe plus a fresh install id, with no
  server request, and keeps Apple's one-time name for the next sign-in.
  Destructive confirmations ignore taps for their first 350 ms
  (`selftest:install-retired`).
- **Dari-safe exports.** The PDF "Cleared by {name} on {date}" line uses the
  statement's calendar and isolates the name and date. The earlier-period table
  is coloured by direction, with an isolated meta line. Rejected and cancelled
  amounts print grey and struck through. Evidence roles and sides are in words,
  and `npm run preview:pdf` works again.
- **Summable shared CSVs.** Gave/Received are empty on rejected and cancelled
  rows, a signed "Recorded amount" column carries every tally, Gave/Received
  keep their currency suffix, and Entry ID stays last. Unshared exports are
  byte-identical to 46.
- **Accurate legal copy (web, deployed by pushing main).** The privacy, terms,
  delete-account and cookie notice pages now give the real deletion path and
  state what is retained. `docs/play-data-safety.md` no longer calls the
  install id anonymous.

Build 46/26 was built from release commit `6ac3989`: `84c3af4` plus the version
bump and the two pre-build fixes below. Everything since 2.0.0's `a7df93c` reaches devices for
the first time: clearing a shared account at zero (backend 051, mobile 032),
evidence kept through account deletion (backend 047/049/050, mobile 031), the
join rework (currency switch, sender-phone match, full contact list), the
"handled means read" notification model, restyled tally rows (cancelled
tallies leave the list but stay in exports) and onboarding keyboard handling.
Mobile migrations 031 and 032 reset every tab cursor, so the first online launch
re-pulls each shared account once. The backend for all of it was live before
the build (verified 2 October 2026: `/v1/tabs/{id}/settlements` is routed and
the web privacy page carries the 2 October 2026 date). Testing tracks only: no
production promotion or App Store review submission is authorized for 46/26.

Production baseline:

- App Store: 2.0.0, released 26 September 2026.
- Google Play: 1.2.0 (versionCode 40). Play Console, 3 October 2026, lists it as
  the version available on Google Play. 2.0.0 (45) was committed to the
  production track at 100% but never published there. The API reads a track's
  committed releases, not Google's approval, so "production: 45 (completed)" in
  `play-promote.mjs` output only ever meant committed. Android users therefore
  go straight from 1.2.0 to 2.1.0.

Pre-build review fixes (2 October 2026), each pinned by a selftest that fails
without it:

- Boot no longer decrypts the stored session on every launch. The fatal
  `account_deletion_cleanup` step returns unless a deletion receipt exists, so a
  Keystore read failure can no longer lock a signed-in user out of the ledger
  unless a deletion receipt is present (`selftest:account-deletion`).
- Android onboarding (profile, kaata) is wrapped in a `KeyboardAvoidingView`
  again, as in 2.0.0, now enabled on Android only. Edge-to-edge means adjustResize no
  longer shrinks the window, so without it the phone field, the currency row and
  the Continue/Create buttons sat under the keyboard with nothing to scroll
  (`selftest:onboarding-keyboard`).

### Google rejected 49 — 9 October 2026; Android build 50 adds Kaata email accounts

Google rejected Android 2.1.0 (49): "Login credentials restricted by device
authentication". Our Android Google sign-in only uses accounts already on the
phone, so the review Gmail had to be added to the reviewer's device. iOS 2.1.0
(29) was approved on 4 October; build 50 is Android first (`android.versionCode`
50, `version` and `ios.buildNumber` unchanged), and the next iOS build carries the
same flows.

On 2026-10-10 Matee replaced the first fix (a reviewer-only username login, never
shipped) with Kaata's own accounts for everyone: email + password next to Google
and Apple, the email verified by a 6-digit code, an optional username for
sign-in. Contract, principles and setup: `docs/kaata-accounts.md`.

What 50 changes:

- **Accounts**: sign up, sign in with email or username, forgot password, a first
  password for Google/Apple accounts (signed in, from Account settings), change
  password, username and, for email accounts, the account name. Backend migration
  052 and `internal/mail` (an SMTP outbox). Mail needs the provider setup in
  `docs/kaata-accounts.md` §12 before codes can arrive.
- **Every sign-in** now goes through one server tail: a different account on a
  phone that holds another account's data gets the keep / start fresh / cancel
  dialog from the SERVER (409 different_account), for Google and Apple too; any
  sign-in replaces the phone's other sessions, and sign-out removes all of them.
- Backing out of Google's chooser is a silent cancel (google-signin 16 resolves a
  cancel; we reopened the chooser and then showed "no_id_token", very likely
  what the reviewer saw).
- A restore opens the account's own kaata and pulls shared accounts (up to 20
  seconds) before landing on home.
- Web: the privacy policy and deletion page describe email accounts.

Phone checks for 50 (Android, before sending it for review):

1. A fresh install in English: Continue with email. Before typing anything,
   "Already have an account? Sign in" is visible under the title with no
   keyboard open. Create an account with a real Gmail; the code arrives (check
   Spam), the account opens on onboarding.
2. Sign out, sign in with the email, then with a username set in Account
   settings. A wrong password shows the error; 11 wrong tries in 15 minutes
   wait.
3. Forgot password: the code arrives, the new password works, the old does not,
   and a second phone signed in to the account is signed out.
4. A Google account: Account settings → Set a password shows the Gmail address
   read-only (no field) → code → then sign in with the Gmail address and that
   password on another phone. Back in the Google session, Remove password: the
   password stops working, the other phone is signed out, and a "password was
   removed" email arrives.
5. On a phone with a kaata recently bound to an account, sign out and sign in
   to a different account: the keep / start fresh / cancel dialog appears, for
   email AND Google. An unbound offline kaata is adopted on first sign-in by
   design and does not exercise this dialog.
6. On a phone with no Google account, tap Sign in with Google and back out:
   no error.
7. Kill the app on the code screen and reopen: it returns to the code step.
8. In Dari: the email forms, codes typed with Persian digits, error messages.
9. Play review account: on a fresh install follow the published instructions
   word for word (Continue with email, then Already have an account? Sign in),
   restore, open Demo Partner, accept or reject a pending tally.
10. Change password on one phone while another is signed in: this phone stays
    signed in, the other is signed out, and a "password was changed" email
    arrives in the app's language.

#### Rollout record — 11 October 2026

Production/API coverage and native coverage are recorded separately below.

| Area        | Completed                                                                                       | Remaining                                                |
| ----------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Mail        | Domain verified; SMTP enabled; all eight messages confirmed delivered.                          | Inbox versus Spam placement.                             |
| Backend     | Healthy production deployment; all four operator IDs active.                                    | Native integration checks.                               |
| Account API | Sign-up, sign-in, reset, password change, session revocation and throttle verified.             | Native results listed below; physical two-device checks. |
| Review demo | Ordinary email account and six-tally demo seeded; saved Play flow and one native Accept passed. | No remaining item 9 steps.                               |
| Android APK | Replacement 2.1.0/50 installed; signing/version verified; code-step cold launch passed.         | Remaining native checks.                                 |
| Stores      | iOS 2.1.1/30 waiting for review; Play 2.1.1/50 in review after quick checks passed.             | Both store approvals.                                    |
| Firewall    | Matee skipped the optional Cloudflare-only origin firewall.                                     | No change planned for this rollout.                      |

Resend verified `mail.kaata.af` using its current records in Cloudflare; the
existing root DMARC policy was preserved. The sending-only key is restricted
to that domain. SMTP uses port 587 and username `resend`, with caps of 30/hour
and 90/day. Matee received the Dari sign-up and reset codes in Gmail; inbox
versus Spam placement was not observed.

The initial mail/copy deploy `d964382` passed its SMTP login check. Migrations
052 and 053 ran at 08:42 UTC after a validated 08:40 UTC backup in root's
`kaata-backups` directory. The 09:41:26 UTC audit of `8bd28f3` confirmed a
running, healthy container, public health 200 and four live
`OPERATOR_ACCOUNT_IDS`: both demo accounts plus the two existing operators.
Both demo accounts are excluded from operator-filtered analytics. Production
then deployed `280c048`, whose backend code is unchanged; it was healthy and
passed SMTP login at 10:28:46 UTC.
The API and web returned 200 from Matee's workstation at 10:39 UTC. A
Cloudflare 403 for a Python request from the VPS was separate from those
successful public requests.

EAS build `66bbeb06-d8ff-4cfd-8ddf-863fdf906ab9` finished from `8bd28f3`
as version 2.1.0, versionCode 50: `device-test` profile, production environment,
existing keystore and frozen remote credentials. The
[original APK artifact](https://expo.dev/artifacts/eas/wKGaiV4d3_OzwDStPzB4sxj4O-Ri81XWwkw_sSNQiEw.apk)
was installed on two new, clean Android 14 AVDs (`emulator-5560` and
`emulator-5562`). The original Pixel 4 AVD was untouched. This internal APK
has not been submitted to a store; `ios.buildNumber` remains 29.

The original APK exposed a startup-routing bug: after an onboarded offline
user closed the app on the reset-code screen, cold launch opened Home. The
pending reset was preserved; manually opening email sign-in resumed the
code/password step with the email retained and code/password fields empty.
Commit `280c048` fixes startup navigation in three mobile files, with an
actual mounted-route resume after launch notifications are inspected. Seven
new regression cases cover resumption, current-account setup, one-time
navigation and cancellation by other launch intents. Typecheck and the
email-auth selftest (69 cases), auth-redirect, notification-navigation and
install-retired (26 cases) all passed. Replacement EAS build
`061b44b3-9bf8-4e21-9460-0fb91e1d542c` finished at 10:46:30 UTC from
`280c048dcc34743555fc91ab8964935217f79b99`: version 2.1.0, versionCode 50,
internal `device-test` APK, production environment and frozen existing
signing credentials. Its
[replacement APK artifact](https://expo.dev/artifacts/eas/0ugSbfl-4niwZvsi6d2SGI88pRP44YegEhg_fcPhVy0.apk)
was downloaded (136,542,293 bytes); `aapt` confirmed `af.kaata.app`, version
2.1.0 and versionCode 50. `apksigner` verified it and confirmed the same signing
certificate as the original APK. Installation on the primary `emulator-5560`
succeeded at 10:54 UTC; its installed manifest confirmed versionCode 50,
version 2.1.0, minSdk 24 and targetSdk 36. Only this disposable AVD's app data
was cleared at about 10:55 UTC, after the revocation check. The second
emulator's app data was not cleared; the original Pixel 4 AVD was untouched.
On the fresh-data Dari reset step, process death was confirmed by an empty
`adb pidof`; cold launch directly
resumed the code/password pane with the team email retained and both input
fields empty, without manual sign-in or Account navigation.

The exact original failure condition also passed: after restoring Demo Shop,
explicit sign-out and email sign-in's Forgot password flow, one code was
requested. Removing the app from Recents and confirming an empty `adb pidof`
then cold launching directly resumed the Dari reset pane, preserving the email
and leaving both code/password fields empty. No code was fetched or entered
and no reset verification/password change was made for this last challenge.
Back cancelled its pending step. A final sign-in with `play_demo_reviewer` and
the stable password using Persian digits returned to Demo Shop, with the same
1,475 AFN balance, three pending tallies and signed-in avatar.

Production API observations before native testing: ordinary email/code/password
sign-up and email/username sign-in worked. A reset accepted Persian digits,
rejected the old password with 401 and invalidated all older/other session
JWTs with 401. A new sign-in invalidated its previous token; changing the
password kept the current session working (200) and rejected the other session
(401). The username is `play_demo_reviewer`. A Dari name containing ZWNJ
round-tripped; the name was then restored to `Demo Reviewer`. A signed pull
returned three events, one vault and the tab binding with six entries, four
pending.

The 09:38 UTC audit made exactly 11 failed sign-in requests for a unique,
unregistered controlled address and a fresh install ID. Requests 1–10 returned
401 `invalid_credentials`; request 11 returned 429 `too_many_attempts` with
`Retry-After: 894` seconds. No account, install or mail was created; the
reviewer address's limits were not used. This covers the server side of
checklist item 2.

At that audit, the SMTP outbox held three sent rows, zero pending and zero
expired: one each of Dari (`fa`) `signup_code`, `reset_code` and
`password_changed`. Each had a cleared body, one attempt and no errors.
Resend showed all three as Delivered (accepted by Gmail); receipt of the first
two codes was confirmed by Matee. The reviewer had exactly one active
credential; Demo Partner had none after privileged fixture cleanup.

The later native English reset start returned 200 at 10:08:22 UTC. Its
English `reset_code` was sent at 10:08:25 UTC through SMTP with one attempt,
a cleared body and no error. At 10:11 UTC, Resend's dashboard showed all four
messages as Delivered. This is historical mail-delivery evidence; that reset
was cancelled before completion.

The second emulator completed a password-change flow at 10:44:45 UTC and
remained signed in. It reused the existing review password, so Play's saved
credentials are unchanged. The English `password_changed` notice was sent
at 10:44:48.971 UTC in one SMTP attempt, with its bodies cleared and no error;
the outbox then held five sent messages. At 10:51 UTC, Resend showed all five
as Delivered, including the English password-change notice. An older setup
JWT returned 401 at 10:47:28 UTC, and a scoped database check found one active
reviewer credential. The first emulator initially displayed its cached profile;
after automatic sync settled, its avatar became anonymous and the sheet showed
Google, Apple and email sign-in choices, without manual sign-in or sign-out.
Its local 1 AFN tally remained intact. Reusing the same password exercised the
session-revocation path; old-password rejection was covered by the earlier API
test using a different password.

The replacement APK's Dari reset requested a code at 11:03:02.976 UTC; it was
sent at 11:03:10.078 UTC in one SMTP attempt, with the body cleared and no
error. At 11:03:50 UTC, all six outbox messages were sent. Matee confirmed
receipt of this code, including its leading zeros. Inbox/Spam placement was
not observed. Native reset verification
returned 200 at 11:09:55.313 UTC after entry of the code with Persian digits
and both leading zeros, plus the stable password using Persian digits. The
challenge was consumed and exactly one new active credential remained. A
new Dari `password_changed` notice was sent at 11:09:58.391 UTC in one SMTP
attempt with its body cleared and no error. The app restored its one cloud
ledger to Demo Shop, with a 1,475 AFN balance and three pending Demo Partner
tallies. The second emulator automatically signed out, without manual
sign-out, and retained the same ledger, balance and pending tallies. Its
anonymous avatar and account sheet offered sign-in to enable backup/sync and
provider choices. This reset reused the stable Play password; rejection of a
different old password was proved earlier through the API. Native username
sign-in using `play_demo_reviewer` and the stable password with Persian digits
then returned to Dari Demo Shop with the same balance and three pending
tallies. A controlled wrong-credentials request showed the Dari error and
provider hint, with coherent RTL wrapping. Both fresh and onboarded-offline
cold-launch rechecks then passed on the replacement APK.

At 11:34 UTC, Resend's browser table confirmed all eight messages as Delivered:
one Dari sign-up code, three Dari reset codes (including the final, unverified
cold-launch challenge), one English reset code, two Dari password-change
notices and one English password-change notice. Receipt of the codes used in
the completed flows was confirmed by Matee. Delivered confirms recipient-mail
server acceptance; Inbox versus Spam placement remains unobserved.

Demo identifiers (no credentials):

- Review account: `kaata.team@gmail.com`, `724724ec-be90-46c5-a081-4b635a246af4`.
- Demo Shop vault: `5ae56887-3db1-4e74-afa8-aaf02833730d`.
- Demo Partner fixture: `df92808e-c741-4d72-91bf-e1861be4d619`; tab
  `409636e1-90d1-4382-876f-52d70503501f`. Its phone number is empty. The demo
  was seeded with four pending, one accepted and one disputed tally. The
  partner is a privileged synthetic fixture with no email/password identity;
  its temporary credential was revoked after seeding. It was not created
  through anonymous sign-up.

The first disposable native offline kaata had never been bound to an account,
so sign-in adopted it as the contract requires. That disposable vault
(`617094ea…`) was archived through the API at 10:23:03 UTC. The sole active
reviewer vault was then Demo Shop, with the seeded six entries still at four
pending, one accepted and one disputed.

The fresh Play flow later accepted exactly one tally. A read-only server
check at 10:33:20 UTC confirmed six total: three pending, two accepted and one
disputed, with only the original Demo Shop vault active and the disposable
vault still reversibly archived. First sign-in had also adopted the fixture's
WhatsApp number; the reviewer's original blank number was restored through
the scoped public API at 10:36:55 UTC and then cleared in the native UI after
the password change. The second emulator's Save then showed the blank phone
placeholder, with `Demo Reviewer`, `play_demo_reviewer` and its signed-in state
unchanged. Other profile fields were unchanged.

The final primary Account readback confirmed `Demo Reviewer`, the team email,
`play_demo_reviewer`, an empty phone placeholder and Dari. Returning Home
showed the restored Demo Shop, 1,475 AFN and three pending Demo Partner tallies.

The proposed second mailbox already belonged to an existing Google account;
it received no sign-up/reset request and no account or credential changes.
No plus-tag alias was used, and the unused generated fixture password was
discarded. Native fresh email sign-up and the different-account test remain
outstanding without an unused mailbox or another account's Kaata password.

Play Console's saved form was reloaded: instructions matched, the form buttons
were disabled with no unsaved changes, and a screenshot showed the correct
email. Tool readback returned `<redacted>` for username/password, so their
exact strings were not compared by readback. Passwords are stored outside Git
under local `Documents/Security` with a user-only ACL.

Native results below match checklist items 1–10 above. The clean-emulator
report confirms only the stated portions; other results are pending. A second
isolated emulator (`emulator-5562`) has run the fresh Play sign-in/restore flow.
No spare physical phone is available, so physical-phone coverage remains
outstanding. Authenticated Google first-password/removal and the Google branch
of the different-account dialog are also outstanding.

1. **Partial:** English and Dari Create a Kaata account screens show the
   existing-account sign-in shortcut before the keyboard opens. Native real-email
   sign-up remains outstanding without an unused mailbox.
2. **Partial:** one wrong password showed the English "That email, username
   or password isn't right." error and provider hint. Entering a Gmail address
   in sign-in showed no "Continue with Google" shortcut. Email sign-in passed
   in the fresh Play flow. On the fixed APK, `play_demo_reviewer` sign-in with
   the stable password entered in Persian digits returned to Demo Shop. A
   controlled wrong-credentials request showed the Dari error/provider hint.
   The 11th-attempt throttle passed through the API; a native 11-attempt sequence
   was not performed.
3. **Passed on two emulators:** the Dari code arrived, the reset using Persian
   digits succeeded, and the primary restored Demo Shop. The second emulator
   automatically signed out and retained its local ledger. This reused the
   stable password; old-password rejection was proved by the earlier API test
   with different passwords. Physical-phone coverage remains outstanding.
4. **Outstanding:** authenticated Google first-password setup and removal,
   second-phone behavior and the removal notice.
5. **Outstanding:** different-account keep/start-fresh/cancel for email with a
   previously bound, signed-out kaata; the authenticated Google branch remains
   outstanding. Another account's Kaata password is unavailable. First sign-in's
   adoption of an unbound offline kaata worked as expected.
6. **Passed on emulator:** with no Google accounts configured, Google sign-in
   opened the account-add UI; Android edge-back returned silently to Kaata's
   provider choices with no error.
7. **Passed on the fixed APK in both fresh and onboarded flows:** after
   confirmed process death, cold launch directly opened the Dari code/password
   pane, retaining the email with both fields empty. No manual Account/sign-in
   navigation was needed. The onboarded check followed restored Demo Shop →
   sign out → Home email sign-in → Forgot password, matching the original
   failure. Its final code was not fetched or verified. The original APK had
   opened Home; its stored step still resumed through manual sign-in.
8. **Passed on emulator:** Dari signup/reset labels and RTL wrapping looked
   coherent.
   Native reset admitted the code in Persian digits with both leading zeros
   preserved, and the stable password typed with Persian digits. A controlled
   wrong-credentials request showed "ایمیل، نام کاربری یا رمز درست نیست." and
   the provider hint with coherent RTL wrapping. ZWNJ names passed through the
   API.
9. **Passed on emulator:** the fresh second emulator followed the saved Play
   instructions through email sign-in, "Restore 1 ledger" and "Restore from
   cloud" to Demo Shop. Demo Partner showed six tallies, four "To review" and
   a 1,475 AFN balance before the decision. Exactly one Accept was tapped on
   the 75 AFN "Sample: cash received" tally: its UI turned accepted and the
   decision buttons disappeared. The 1,200, 250 and 500 AFN samples remained
   pending (three total).
10. **Passed on two emulators:** the second completed a change using the
    existing review password and remained signed in. The older emulator's
    cached profile became signed out after automatic sync settled, with no
    manual sign-in/sign-out and its local 1 AFN tally preserved. The English
    notice was Delivered in Resend. The old setup JWT returned 401 and one
    reviewer credential remained active. Same-password reuse does not test
    old-password rejection; the earlier API test did. Physical-phone coverage
    remains outstanding.

### Production 2.1.1 review — 11 October 2026 (50/30)

Matee requested production builds and review submission for both Google Play
and the App Store as **2.1.1**, Android versionCode **50** and iOS build **30**.
Both EAS production build jobs started from source
`d275470030a63dd49c0a59aca2e319457ad5974d`:

- Android 50: `4f8d7279-4da6-47ce-83fa-fc36ad8ad309`, created at 11:45:31 UTC.
- iOS 30: `5cf3963b-b10b-48e8-a525-936f94c934fb`, created at 11:46:35 UTC.

Both builds and uploads finished, and both store review-submission actions
were completed. Apple's version is waiting for review; Play's initial quick
checks passed and its changes are in review. The 2.1.0 internal APK results
above remain the history of the email-account and startup-resume checks.

Both store reviews use the ordinary `kaata.team@gmail.com` Kaata account,
its stable password stored outside Git, and the email sign-in →
Restore from cloud route verified above. The remaining native gaps are still
those recorded in the checklist; no additional device coverage is claimed.

iOS production build `5cf3963b-b10b-48e8-a525-936f94c934fb` finished at
11:53:22 UTC. EAS upload `8a671861-3ef6-4094-82b1-23208194595d` was confirmed
`FINISHED` at 12:00:43 UTC. App Store Connect build
`2cdcbf6d-d2a2-46e8-8b28-00f2a26719f3` is `VALID` in the 2.1.1 train.

`asc-submit` created version `2fcbfaf3-fa73-4bdf-9547-73ec380c19e9`, attached
build 30, wrote the 602-character release notes and retained the 1,420-character
description and ten screenshots. It configured the ordinary Kaata email
review account using its private credential file. The version was submitted
at `2026-10-11T12:00:22.358Z` and is `WAITING_FOR_REVIEW`, with release type
`AFTER_APPROVAL`. Independent `asc-submit --status` confirmed that state and
the older 2.1.0 version as `READY_FOR_SALE`.

Android production build `4f8d7279-4da6-47ce-83fa-fc36ad8ad309` finished at
12:01:34 UTC. EAS internal-hold upload
`cf558aa3-41a6-4a48-892e-dfb60aa63b3f` finished at 12:08:17 UTC, without
sending changes for review. `play-promote --from internal --to production
--no-send` successfully staged 2.1.1 [50] on production. Google approval and
publication remain pending.

Publishing overview exposed stale closed-testing release objects 47 and 46
(2.1.0), then 45 and 44 (2.0.0). Each showed 0% of installs and was unsubmitted
or rejected. All four release objects were discarded; each confirmation
explicitly retained the uploaded bundles in the artifact library. Closed
testing now remains paused on its already released 2.0.0 [43] from 25 September,
with no pending new release, resume or rollout. Production 2.1.1 [50] remains
staged.

The final Publishing overview "Send changes for review" confirmation was
completed. The page now shows "Changes in review": production 2.1.1's Start
full rollout, the existing closed-track Pause entry, complete Data Safety and
the updated Sign-in details. No old closed-release rollout is in this batch.
At 12:24 UTC, the quick checks had completed and Publishing overview confirmed
"Your changes are now in review." Google approval and publication remain
pending.

The official 9 October rejection email for Android 49 was read through Play
Console's policy-email link (`4977992791420563614`). It cites "Login credentials
restricted by device authentication" and gives this sequence:

1. Update App content → Sign-in details with valid credentials.
2. Provide English instructions for accessing all restricted features.
3. In Publishing overview, send the changes for review.

The email allows corrected credentials to be resubmitted without contacting
policy support. The ordinary Kaata email account and verified fresh-install
route address the cited device-dependent login issue. Updating sign-in details
does not itself send the app back for review; that final Publishing overview
step was completed for this 2.1.1 submission.

### Production submission — 3 October 2026 (49/29)

On 3 October 2026 Matee asked for 2.1.0 to go straight to production on both
stores, with closed testing left as it was. The quiet tally rows and the
closed-row status dot reached production review WITHOUT a two-phone check;
they were verified by selftests and rendered previews only.

- Source commit: `72f2fec`. That is the quiet tally rows (`5783e6a`) plus the
  closed-row status dot, with build tooling from `b5272f6`. All 25 selftests,
  the typecheck and both native bundle exports passed.
- Build 48/28 (`b5272f6`) was withdrawn because Matee wanted the dot first.
  Its App Store review was cancelled (version back to DEVELOPER_REJECTED), and
  its internal Play upload failed when a concurrent track listing expired
  EAS's edit (see the release flow in CLAUDE.md).
- iOS build: `5b3bd4ec-0d1b-409c-b8f4-7b78dc1e3299`; upload submission
  `3ea251a4-1ffd-43a1-8611-3e71abf954f6`; build 29 is VALID. Version 2.1.0
  (`73b94fba-13a6-4afc-ac2e-4313799adbda`) was reused with build 29 attached
  and submitted with `--review-account`: WAITING_FOR_REVIEW, AFTER_APPROVAL.
  The sign-in-required flag, demo account, password and notes were confirmed
  through the API.
- Android build: `fc470aca-16aa-4d00-8d3a-50be5f2a8111`; internal-track
  submission `8e7a3c7b-b844-4adb-813f-ced8b14655d9`. It was promoted with
  `play-promote.mjs --from internal --to production` and the en-US 2.1.0 notes.
  Production holds 2.1.0 [49] completed (100%). Play Console shows it "In
  review" next to the 1.2.0 (40) that users actually have. Closed testing
  (alpha) still holds 47, also "In review"; the build testers can get there is
  still 2.0.0 (43). Internal holds 49.

### Previous testing delivery — 3 October 2026 (47/27)

- Source commit: `2f56b61`, pushed to main. Before the build, the full mobile
  suite passed (typecheck, 25 selftests including `install-retired`), along with
  both native bundle exports, the web typecheck, build and tests, and Prettier.
  Three review rounds found no blockers. The web copy was verified live (the
  cookie card says "We record visits"; the deletion path is on the privacy
  page).
- Android build: `33245fb9-2aa0-4e9f-939f-209531c51b31`; closed-testing
  submission `9aa1f385-11c0-4f2f-b908-cddb27105fb5`. Both FINISHED. Play alpha
  holds release "2.1.0" (versionCode 47); production is still 45, checked with a
  discarded dry-run edit.
- iOS build: `e352785d-e70e-455b-b71f-b211c6d48a96`; TestFlight submission
  `988353a1-a9b2-4abb-ada8-1cce8d979feb`. Both FINISHED; build 27 is VALID in
  App Store Connect. App Store production is still 2.0.0.
- Google rejected 46 for missing login credentials. Play Console → App content →
  Sign-in details now lists the review account (`kaata.review@gmail.com`;
  password with Matee) and instructions. Its demo data is a "Demo Shop" kaata
  plus a shared "Demo Partner" account with pending tallies. The changes are
  sent for review from Publishing overview. No production promotion and no App
  Store review submission were made.

### Previous testing delivery — 2 October 2026 (46/26)

- Source commit: `6ac39898627b9a6e2483cd915b399e4d30d6b1da`. Checks run before
  the build:
  - isolated-Postgres Go tests: 378 passed, 0 failed; the only skip is the
    opt-in bill preview;
  - Go build and vet;
  - web typecheck, build and 75 node tests;
  - mobile typecheck, all 24 selftests, both native bundle exports, and the
    notification-mask and release-note checks.

  A five-dimension review of `a7df93c..HEAD` with adversarial verification
  found no blockers. Its two confirmed regressions were fixed in this commit,
  then re-checked by two independent reviewers and by mutation tests.

- Android build: `dfe4e6cc-a80e-4902-b74d-e4ef42b65a38`; closed-testing submission
  `867d421b-0593-4cae-80ae-545f9c4beeee`. Both FINISHED. Play alpha holds release
  "2.1.0" (versionCode 46) and production is still 45, checked with a discarded
  dry-run edit. The build used the existing keystore ("Using Keystore from
  configuration") and the secret EAS file variable `GOOGLE_SERVICES_JSON`. Its
  "googleServicesFile not checked in" warning refers only to the ignored local copy.
- iOS build: `1fee276f-391a-4517-8442-14a596e4b0d0`; TestFlight submission
  `3ad25502-5d84-48d1-87a7-9d9dfa379357`. Both FINISHED; build 26 is VALID in
  App Store Connect. App Store production is still 2.0.0 (READY_FOR_SALE).
- Until 2 October 2026, App Store Connect refused every API call with
  `FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`. Matee's login is not the
  Account Holder. The Account Holder had to accept the pending agreements, on
  developer.apple.com and then in App Store Connect → Business.
- Store notes for the later production step are in
  `apps/mobile/scripts/release-notes/2.1.0-{ios,play}.txt`. None were attached to
  the testing releases.
- No production promotion and no App Store review submission were made. No
  direct-install Android build was created.

### Phone checks for 46/26 and 47/27

- Install over 2.0.0 on both phones; never uninstall. Before updating, note each
  shared contact's home balance, person-screen balance and "to review" count.
  After the first online launch has re-pulled every shared account, they must
  match, and the two phones must agree (sign-flipped).
- Update both phones before testing clearing or read syncing. A 2.0.0 phone keeps
  identical balances but never shows the cleared line.
- Clearing needs a connection, an exact zero balance, nothing pending and nothing
  unsent. The first tap may answer "changed" if a sync just landed; tap again.
  Both phones must then show the cleared line and a fresh page.
- Cancel your own pending tally: it leaves both lists and appears in PDF/CSV
  exports struck through, counting zero. Rejected tallies stay in the list.
- Android onboarding on the smallest phone available, in Dari and English: Next
  from Last name to Phone keeps the field visible, Continue is reachable with the
  keyboard open, and an invalid-number error is visible. Repeat on the kaata
  step. Check iPhone too.
- Cold-start several times signed in, signed out and after signing back in. A
  "Couldn't start" screen naming `account_deletion_cleanup` is a regression.
- Notifications: tapping one, reviewing the tally, or opening the contact must
  drop the bell badge and clear the tray item, including from airplane mode
  after reconnecting.
- Test account deletion ONLY with a throwaway account (see the retired-install
  check below).

Added for 47/27:

- Retired install, with a throwaway account signed in on BOTH phones: delete it
  on phone A. On phone B, signing in (with any account) must show the "This
  phone's account was deleted" explanation, not "(server 410)", and B's ledger
  keeps working. Home's dialog opens Account settings, which shows the notice
  card. A quick double tap on "Reset this phone" must open the confirmation
  without erasing anything. Export first, then "Reset this phone": B returns to
  onboarding with an empty ledger and can sign in again. Cancelling any of these
  dialogs must leave the ledger untouched.
- Dari PDF of a cleared shared account: the "صاف‌شده توسط … در …" line is legible
  with Afghan month names, and rejected/cancelled amounts are grey and struck
  through. Open the shared CSV in a spreadsheet: SUM(Gave) − SUM(Received) equals
  the balance.
- After pushing main, kaata.af/privacy, /delete-account and /terms show the new
  deletion wording, and the cookie card no longer says "anonymous" and has a
  single "Okay" button.

### Known issues

Fixed in 47/27 (see the candidate summary above):

- the retired-install lock-out (no in-app recovery after a 410);
- the PDF "Cleared by" line;
- the privacy policy's deletion claim;
- the shared CSV shape;
- the `npm run preview:pdf` crash.

Still open, minor and deferred:

- After the one-time full re-pull, an offline accept/reject/cancel that is still
  in retry backoff can show as pending again until it sends (self-heals).
- Dismissing the join screen by swipe or Back after "Create a … kaata" leaves
  the currency preset armed for the next new kaata.
- Rarely, a deletion can report "Couldn't delete" after the server already
  deleted the account. This happens when a sync 401 or a token refresh lands
  mid-request. Retrying Delete from Account finishes it; if the attempt token
  has expired, the phone ends up retired and uses the reset.

### Before production: store and legal decisions (Matee)

- The WhatsApp outreach (admin Outreach page) contacts shopkeepers and people
  recorded in ledgers. The privacy policy does not say so yet. If it continues,
  disclose it there first. Then add Developer communications or marketing to the
  Play Data Safety purposes for Name, Phone number and Contacts, and to the App
  Store labels.
- Play wants retention periods on the deletion page; none is stated for retained
  shared tally history.
- Re-check the remaining Play Data Safety and App Store privacy answers listed in
  `docs/play-data-safety.md`: Device IDs (install_id is pseudonymous, plus the
  Expo push token), third-party sharing (Expo, FCM and APNs as service providers
  for notification text), and Contacts.

### Previous delivery — 26 September 2026 Kabul (45/25)

On 25 September 2026, Matee explicitly authorized commit/push, testing delivery,
then production submission once this new build is available in TestFlight.
This overrides the usual wait-for-another-approval step for this delivery only;
it does not claim that the new native builds have already been phone-tested.
Store review/availability is separate from successful upload.

- Source commit: `a7df93c124aa6d2b32f93c1573737caff5f651b0`, pushed to main.
  Full isolated-Postgres Go tests, Go build/vet, mobile typecheck and all 18
  selftests passed before delivery. Release preflight repeated the typecheck,
  both native bundle exports, notification-mask validation and release-note checks.
- Android build: `1668ec44-4b12-486d-8554-49e1892546a1`; closed-testing submission:
  `ebf3b9e2-7e28-4c88-a1c8-97b470fcf95a`. Both FINISHED; Play alpha contains 45.
- iOS build: `381cb0f2-ecf5-4e41-9f9f-9d59c279b4ac`; TestFlight submission:
  `21bd0844-384c-4094-99fb-499557038c79`. Both FINISHED; build 25 is VALID in ASC
  (`f8a99c1c-858e-4a46-a453-2dc03271c23f`). The long delay was in Expo's
  submission queue; the existing build was uploaded without rebuilding.
- After TestFlight processing completed, iOS 2.0.0 was submitted for production
  review at `2026-09-25T21:20:48.948Z`: WAITING_FOR_REVIEW, build 25 attached,
  release type AFTER_APPROVAL, English release notes included.
  App Store version ID: `23d5f09a-51ac-4533-b4b1-2abac0f18dca`.
- Android 45 was then verified on the production track at 100% (`completed`),
  promoted from alpha with English release notes. Google review/public availability
  is separate; this does not assert that the update is already visible to everyone.
- Pushing main triggered the configured Dokploy auto-deploy. Backend health is OK
  and the web returns HTTP 200. Health still reports commit `unknown`, so the exact
  deployed revision and migration state could not be independently verified there.
- Migration 043 preserves ledger history and supports old 1.2.0 clients. Existing
  app data should be kept intact. No direct-install Android build was created.

### Previous testing delivery — 25 September 2026 (44/24)

- Source commit: `105ef08643500cc5d3e88b28e7bb90cf05cdd81d`.
  Full isolated-Postgres Go tests, Go build/vet, mobile typecheck and all selftests,
  Android/iOS bundle exports passed before delivery. Release preflight repeated
  the tabs tests, Go vet and mobile typecheck; the web production build also passed.
- Android build: `b25bc493-26a4-4d66-b7ff-3c73ffba4b35`; closed-testing submission:
  `31c571e9-7b3c-4397-832b-70fc24aebe4a`. Both FINISHED; Play alpha contains 44.
- iOS build: `2493b0db-a7f5-4024-9553-10f5395b4688`; TestFlight submission:
  `3ce5e48b-3285-4b77-a695-74e63006cd3c`. Both FINISHED; build 24 VALID in ASC.
- Pushing main triggered the configured Dokploy auto-deploy. Backend health is OK
  and the web returns HTTP 200. The health response still reports commit `unknown`,
  so the exact deployed revision could not be independently verified from it.
- Production unchanged: Play versionCode 40; App Store 1.2.0 READY_FOR_SALE.
  Play inspection used a discarded dry-run edit; no production promotion or
  App Store review submission was made. No direct-install Android build was created.
- Identity migration 042 is additive. Existing tallies and balances are not rewritten.

### Previous testing delivery — 25 September 2026 (43/23)

- Source commit: `44b1c76`. Mobile typecheck and all selftests passed; backend
  tests passed against isolated Postgres, `go vet` passed, and the web production
  build passed. Android notification mask was verified.
- Android build: `ced29d23-324b-4603-b92b-21fd2e27ba6e`; closed-testing submission:
  `96df6e6e-e28f-42c3-ab72-2de787addfae`. Both FINISHED.
- iOS build: `d9435548-d45e-4eaa-83ee-8a8543f9ce9a`; TestFlight submission:
  `14462cdd-7ce8-41fc-b353-b8c0d918f2af`. Both FINISHED; build 23 VALID in ASC.
- Dokploy auto-deploy verified: existing download links redirect to the store page
  with their source retained; the web serves its updated store-only security policy.
- Production unchanged: Play versionCode 40; App Store 1.2.0. The Play inspection
  used a discarded dry-run edit, not a promotion.
- This delivery used only the production build profile and testing submit profile.
  The old direct-download service and obsolete publishing instructions are removed.
  Historical migrations, ledger records and Git history are preserved.

### Previous testing delivery — 25 September 2026 (42/22)

- Feature commit: `9112235`; web privacy follow-up: `2fee7da`. Backend's new
  authenticated invitation route and the updated web privacy copy were verified live.
- iOS build `245115f9-f801-4632-b209-7d7b3b62d4db`: finished; TestFlight
  submission `bde0aed0-f0ab-4b3f-be1f-d626a905ffea` finished; build 22 is VALID.
- Android build `03f637b4-16b0-40a3-bffb-42e5d3372971`: finished; closed-testing
  (`alpha`) submission `2be05153-1bd3-4b89-a8b6-0bdc42ace052` finished.
  This retries `fea1b5f6-fb4b-4c9c-99c9-45f87d1ae3c9`, which failed with an
  EAS SERVER_ERROR uploading its archive; that first submission was canceled.
- Install Android updates through the Play closed-testing track. Keep app data intact.
- Neither store was promoted to production. Update BOTH testing phones before
  checking rejected-tally balances, notifications and inline reviews.

## Local checks

`bun dev` keeps the Expo QR workflow. The backend wrapper uses the mobile
`.env.local` LAN backend address for newly generated testing links, unless an
explicit backend URL override already exists. This prevents local invitations
from opening the production service. Both phones must reach that LAN address.
For an HTTPS development tunnel, set `KAATA_DEV_PUBLIC_URL` explicitly.

Expo Go can exercise the ledger and signed-in join flow, but not native push or
the installed app's `kaata://` scheme. To open an invitation directly in Expo Go,
use its printed `exp://<host>:<port>/--/t/<token>` route. The normal browser
**Open in Kaata** button is for an installed development/store build.

- Backend: `go test -count=1 ./...` and `go vet ./...` from `apps/backend`.
  Set `POSTGRES_TEST_URL` to an **isolated disposable test database** first.
  The harness drops its schema; never use the dev or production database.
- Mobile: `npm run typecheck` and all `selftest:*` scripts from `apps/mobile`.
  `selftest:tabs` uses real in-memory SQLite and a fake HTTP service, including
  cutover balances, retries, ordering, rejection retention, and restore.
  `selftest:notifications` covers upgrade permission prompts, denied/revoked
  permission, foreground/background action dispatch, cold-start handoffs,
  invalid payloads and signed-out/Expo Go behavior with synthetic adapters.
- Web: `bun run build` from `apps/web`.
- Invitation landing: `go test ./internal/tabs -run TestAppOnlyInvitation`.

## Two-phone acceptance checklist

Use a new test contact on each device; keep real customer data out of this trial.

1. Create private tallies totaling 100 on phone A. Link that contact and share the
   link with B. The browser shows only a generic invitation. B taps **Open in
   Kaata**, signs in, then chooses its own same-currency kaata and contact.
   A forwarded link must not expose the ledger or replace B after it is claimed.
2. Verify A shows +100 and B −100, with one explicit opening tally. Old private
   entries remain under **Before linking** and are not counted twice.
3. Add on A, then B. Check both balances and opposite I-gave/I-received labels.
   Accept and reject the other side's tally using its inline controls. Rejection
   immediately excludes it from BOTH balances while preserving the visible row.
   Both decisions are final: old alerts and repeated taps cannot change them.
   After rejection, send a NEW tally to try again. Pending tallies count until rejected.
4. Expand an own pending tally and cancel it inline. Both see it struck out and
   the balance changes once. Accepted and rejected tallies cannot be cancelled.
   Review
   clerk/viewer access separately: a clerk adds, an editor reviews, a viewer reads.
5. Turn off data, add several tallies, restart, reconnect. Each arrives exactly
   once. Retry after a timeout; later operations must not pass a deferred one.
6. While B is offline, add and close from A. Reopen B: the final shared balance
   must arrive before the account freezes. A refused offline tally appears under
   **Not sent**, is kept locally, and does not affect the shared balance.
7. After closing, add a private tally. It adds to the frozen shared balance.
   Linking again carries the displayed balance once, with old history retained.
8. Sign in and wait for sync on both phones; reinstall/restore one **test** install.
   Its account, cutoff, final closed history and balance must recover through `/mine`.
   Shared-account writes require sign-in; private local ledger use is unchanged.
9. Export customer and whole-kaata reports; compare displayed balances with them.
   Voided AND rejected entries do not count. Existing bill links remain immutable snapshots.
10. Test Dari and English, large text, long notes/names, small screens, and print.
    I received stays on the left and I gave on the right in both languages.

## Real push notifications

Expo Go cannot test remote notifications. Fresh native builds are required.

### Configured credentials (2026-09-24)

- Firebase was added to the EXISTING Cloud project `kaata-498506` (sender
  `987359341353`). The owner login used for setup is `mateesaafi@gmail.com`.
  Always pass this project/account explicitly to gcloud: its default project
  may be the unrelated `hesarak-backend`, which must not be modified.
- Android package `af.kaata.app` is registered. Client configuration is stored
  as the secret EAS FILE variable `GOOGLE_SERVICES_JSON` for production,
  preview and development; the local copy is ignored `apps/mobile/google-services.json`.
- EAS FCM V1 uses `kaata-push@kaata-498506.iam.gserviceaccount.com`, with ONLY
  `roles/firebasecloudmessaging.admin`. Its local key is ignored
  `apps/mobile/credentials/firebase-push.json`. Never commit it or use the
  separate Play publishing key for push. Authenticated FCM `validate_only`
  succeeded; this sent no notifications and is not a device delivery test.
- iOS already has APNs key `UDSAKL5S4Q` assigned in EAS (team `2JPK69B8Z2`).
- No billing settings were changed. The user left the console Analytics and
  Gemini assistance options enabled; no Analytics/AI SDK was added to the app.

### Native delivery verification

1. Confirm the build uses the existing EAS file variable `GOOGLE_SERVICES_JSON`
   for package `af.kaata.app`; credential setup above is already complete.
2. Keep the assigned FCM V1 and APNs credentials. If enhanced Expo push security
   is enabled, supply `EXPO_ACCESS_TOKEN` to the backend through its secret store.
3. Deploy backend migrations through 043 and the worker, then enable
   `TAB_PUSH_ENABLED=true` in the testing backend. It defaults to false.
4. Build/install native testing builds and allow notifications after linking.
   Existing linked-contact upgrades/restores must prompt once on a signed-in
   foreground sweep too; there must be no need to unlink/relink to enable alerts.
   With B backgrounded and then fully closed, add/review on A. B must receive a
   notification naming the actual actor and signed amount/currency, with
   Accept/Reject actions (expand or long-press the
   alert on iOS). Actions must work without navigating into the app; tapping the
   notification body switches to the correct kaata/contact, scrolls to the tally,
   and briefly highlights it. Repeat offline and
   after restart: one tap must enqueue only once. An older alert must not undo
   a final decision. The author gets accepted/rejected notifications, not alerts
   for their own actions. While foregrounded, the inbox and ledger update without
   an OS banner/list entry or sound. Test both phones, including account switching
   on one install and an account that belongs to both sides' kaatas.
5. Revoke permission, sign out, and remove a vault member;
   verify no further alerts reach those revoked subscriptions. Test an expired
   token and a provider outage (server tests exercise receipt and backoff paths).

Push alerts are hints, not transaction authority. Delivery can be delayed or
duplicated by providers; the server ledger and its revision remain authoritative.
If disabled, local notifications only work when a pull actually runs, not while
the OS has suspended the app. No background-delivery claim should be made until
both native platforms have passed the above test.

## Release order

Deploy the backend and web routing/privacy changes before distributing 2.0 clients.
Use TestFlight and Play closed testing first. The first testing build was 2.0.0,
Android versionCode 41 and iOS build 21; these notification changes require NEW
native builds (42/22). Existing 41/21 clients still count rejected tallies, so update
both testing phones together when deploying the changed rules. Review store privacy disclosures for
shared records and notification identifiers. Leave production promotion until
the device checklist passes. Universal/app links are
not yet configured; the browser's explicit **Open in Kaata** button uses the
existing `kaata://` scheme.

## Delivered in 43/23: inbox and customer-screen polish (2026-09-25)

Delivered to testing as recorded above. User confirmed notifications on
Android 42/iOS 22; these changes build on that working baseline.

- Home bell: preview, unread count, mark all read, and paginated /notifications.
  History starts at backend migration 041; no fictional past status transitions.
  Persisted independently of push permissions/receipts; read state follows account.
- Alerts include party label, signed tally amount and ISO currency (recipient view).
  Notes, balances and credentials remain excluded. Privacy copy updated accordingly.
- Rejected tallies: gray amount/icon and struck amount/note; still excluded from totals.
- Person footer: received LEFT / gave RIGHT, safe-area inset. Ellipsis opens a bottom
  sheet including WhatsApp ping. Blue shared-account badge replaces identity link marks.
- Explicit LTR isolation for phones and calling codes, including contact pickers.
- Native Android icon: white-on-transparent mask instead of the opaque launcher logo.

Checks: isolated Postgres full Go suite + vet (including concurrent first-review-wins
and WebSocket regressions); 23 tab regression groups, 10 notification orchestration
regressions, inbox lifecycle tests, EN/FA tally/inbox layout-structure regressions,
other existing mobile selftests, tsc,
web build, and deterministic 96×96 icon validation. The general Expo --platform all
check also attempts the unsupported mobile-web build and hits the existing SQLite
WASM resolver issue; use explicit android/ios for mobile release bundle checks.

Phone checks still required on new testing binaries:

1. Add separate fractional USD/AFN/AED tallies, accept one and reject another.
   Neither can change decision when expanded, after relaunch, on a second phone,
   or from an old notification. Try opposite decisions simultaneously: first wins.
   Send a NEW tally after rejection; only the new tally counts if accepted.
   Check signed amount, counterparty label, one notification per decision and balances.
2. Open the bell, mark one/all read, reopen/relaunch; check the full page and both phones
   on the SAME account. Switch accounts; old inbox content must not cross over.
3. Rejected amount/note crossed out gray with a soft red Rejected pill; voided rows
   show Voided only once beside the date. Expanded attribution aligns with the date
   and names are bold in both English and Dari.
4. Persian +937… and country codes stay LTR. Long names fit with the blue badge.
5. Give/receive labels remain visible at phone widths and large text sizes (Expo Go too).
   Both floating buttons rise with a toast and return afterward. Last tally is scrollable
   above the footer. WhatsApp is the first bottom-sheet row; PDF/share still works.
6. Xiaomi lock-screen/status-bar icon is the Kaata silhouette, no square block.
7. Bell preview has equal side margins on small/large iPhones, in English/Dari and
   after rotation. Full inbox title is centered on the back-button row, not duplicated.
8. With WARP off, foreground changes arrive via WebSocket pokes immediately; reconnect
   and foreground catch-up still work. Background pushes retain their separate OS path.
9. Link an unlinked contact from the ellipsis menu: only one confirmation modal.
   Saved number → confirm → targeted WhatsApp compose (the user still presses Send).
   No number → sharing/copy choices remain in the same modal. "Ask" language preference
   offers inline Dari/English choices. Offline create/WhatsApp/clipboard failure stays
   recoverable; delivery retries do not duplicate the tab or opening balance.
   `npm run selftest:invite-dialog` covers these paths with native boundaries mocked.

## Additional phone checks for 44/24

1. Give account and kaata different names. New tally attribution and alerts use the
   actual account name; historical rows with no author identity do not guess the owner.
   The blue shared-account badge shows the other account name, while actions use a link icon.
2. Incoming unreviewed tallies show yellow New; outgoing show yellow Pending.
   Accepted is green, Rejected and Voided are soft red. The redundant Linked pill is gone.
3. Tap a tally notification from the bell and from the OS, including a cold launch
   and a tally in older history. It scrolls into view and highlights briefly; the
   highlight must not intercept taps. Repeat the same notification after navigating away.
4. Follow an invitation while signed out on an install with existing kaatas.
   Redirected sign-in has no Ninja option, restores/selects existing kaatas, and
   resumes the invitation instead of sending the user through new-kaata onboarding.
   Test the different-account keep/wipe/cancel safeguard separately with test data.
