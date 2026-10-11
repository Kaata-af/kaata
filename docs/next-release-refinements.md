# Next release: user-feedback refinements

Initial work began on `codex/next-release-refinements`, following the 2.1.1 submission.
The development batches below initially stayed local, with signed builds and
store distribution deferred until the user requested release preparation.

On October 11, 2026, the user authorized **2.2.0 for testing only**: iOS
**TestFlight/build 31** and Android **internal testing/code 51**. The initial
closed-testing request was corrected to internal testing. Preserve the pending
2.1.1 production reviews: do not cancel, replace or resubmit them, submit 2.2.0
to production, or deploy the backend/web changes. Native build/distribution
authorization does not authorize pushing `main` or publishing marketing assets.

Build identifiers, delivery status and the store-review safeguards are recorded
in [2.2.0-testing-distribution.md](2.2.0-testing-distribution.md). The development
history and consolidated phone/visual checklist below remain applicable.

Later on October 11, the user requested merging the completed branch into
`main` and pushing it to trigger the existing Dokploy auto-deploy. This
authorizes the backend/web refinements, including the weekly-growth dashboard
and branding, to go live. It leaves the 2.1.1 store reviews and 2.2.0 testing
tracks as they are. The working checkout returns to `main` after the merge.

## Implemented

- **WhatsApp reminders:** one icon beside the three-dot menu in the ledger header.
  The balance-area button and menu duplicate were removed in the follow-up batch.
  Preparation and WhatsApp opening use a spinner in the button, with phase-specific
  accessible labels and busy state. The action's accessibility hint explains what
  gets shared. Repeated taps share one attempt, including language selection;
  the native language sheet exits before sharing. Leaving the screen cancels a
  pending reminder so a late upload cannot launch WhatsApp elsewhere. Upload failure still opens a
  plain-text reminder. Opening WhatsApp does not prove the message was sent.
- **Sign-in:** Settings has one Sign in row. The existing sign-in page offers
  email, Google and Apple, retaining account-change and restore safeguards.
- **Tally search:** one box filters notes and exact amounts within a contact,
  including settled chapters, pre-link history and Not sent entries. The latest
  follow-up puts it beneath I received/I gave and adds a separate date-range
  control with presets and a calendar picker; dates are no longer text queries.
  English case/accents, Dari/Arabic letter variants, digits and ZWNJs normalize
  only for matching. Stored notes, balance, exports and shared statements remain
  whole. Hidden incoming tallies retain their notifications during a search.
- **Quiet status:** collapsed rows show only the pending yellow dot. Opened
  status labels have yellow pending, green accepted, red rejected and gray sending
  dots. Rejected tallies keep their struck number and accessible status.
- **Shared restore:** missing bindings discovered through `/v1/tabs/mine` pull
  their server rows immediately and refresh contact/balance/shared indicators.
  An unknown live poke starts discovery; contact events arriving after discovery
  trigger a retry. Closed periods load before a replacement link is inserted.
- **Remote sync:** live pokes remain the fast path. Cached shared ledgers have a
  5-second foreground fallback, with up to three concurrent pulls. Account-wide
  discovery remains on a 60-second cadence. Timer ticks join slow sweeps rather
  than extending them indefinitely, and network recovery wakes the loop.
  Non-active joined kaatas also receive fallback sync through accepted, unrevoked
  memberships, including current and retired device identities.
- **Admin times:** operational timestamps show date and 24-hour Kabul time,
  regardless of browser timezone. Relative recency remains visible; records
  with only a calendar date do not acquire a fictional time.
- **Brand color language:** the approved Aubergine/Saffron/Ivory/Charcoal/White
  palette drives branding, web controls, onboarding and marketing surfaces.
  Following the user's visual feedback, everyday mobile controls use black and
  neutral grays, including the home add/find button, selected tabs and give/receive.
  Brand colors remain for identity, onboarding and occasional highlights.
  Detailed ledger rows stay white; money direction, destructive actions,
  attribution and pending-only amber retain their meanings. Web/admin/SSR
  pages, transactional email styles, PDF headers and future flyer/social/store
  screenshot sources follow the roles in [brand-language.md](brand-language.md).
  Shared JSON is available to Metro through a scoped watch folder. The Android
  adaptive background and notification accent use Aubergine. Original opaque
  launcher/splash, favicon and social-preview artwork still need their editable
  master for faithful recoloring; existing artwork is retained meanwhile.
- **Weekly growth:** Admin Overview shows the latest completed week's active
  device growth, a 7% verdict, the exact whole-device target and a completed-week
  history. The current week has a provisional count/target/progress, with no
  early rate or verdict. Activity means distinct app installs checking in,
  including signed-out and read-only use; two phones count twice. It is not a
  count of unique people or new sign-ups. Operator exclusions match other admin
  analytics. Percentages use `(active − previous active) / previous active × 100`;
  the target is `ceil(previous active × 1.07)`. A zero denominator stays undefined.
  Full tracking is required for both weeks. Missing coverage and the UTC/Kabul
  transition week plus its following comparison have counts without a verdict.
  Backend changes are read-only and additive, with no migration or new telemetry.
  Older backend responses retain accounting charts but do not invent a rate.
  The benchmark links to [Paul Graham's essay](https://paulgraham.com/growth.html).

## October 11 follow-up batch

The user requested these refinements after the main deployment. Development
completed on `main` in `e03a454`. The user then requested new testing-store
builds; the refinement binaries retain 2.2.0 with TestFlight build32 and Play
internal code52. Current delivery status is tracked in
[2.2.0-testing-distribution.md](2.2.0-testing-distribution.md). The pending 2.1.1
production reviews and deployed backend/web stay separate from this upload.
Both new testing builds are now available to the existing testers; the final
store snapshots confirmed production reviews and Play closed testing unchanged.

- **Header sharing:** the single WhatsApp icon sits immediately beside the
  three-dot menu, with a separate 44pt target in English and Dari. No persistent
  share button or explanation breaks up the balance. A spinner and short
  preparation/opening line appear while working; existing statement scope,
  offline fallback, language selection and duplicate/cancellation guards remain.
- **Neutral app chrome:** everyday backgrounds, text, borders, primary actions
  and selected controls return to white/black/grays. Home add/find and ledger
  give/receive actions use black. Branding/onboarding/occasional highlights retain
  the palette; money direction, authorship, linked-account blue, pending amber
  and destructive red keep their established meanings. Marketing/web colors stay
  as recorded in [brand-language.md](brand-language.md).
- **Live review feedback:** an already displayed pending shared tally briefly
  highlights when its accepted/rejected decision is server-confirmed, with one
  localized in-app message per batch. Reduced Motion uses a static brief cue.
  Optimistic offline decisions do not announce confirmation; fresh history,
  background/refocus changes, hidden search results and folded chapters do not
  replay feedback. Rejected tallies still exclude their amount from the balance.
  The previous optimistic accept/reject success toasts were removed so queueing
  cannot masquerade as server confirmation.
- **Email Back:** email auth now opens on a native child route above provider
  choices, so first-step iOS swipe returns to email/Google/Apple selection. Header
  and Android Back still retrace reset/code steps. Deeper/busy steps guard native
  gestures; pending-code resume, different-account decisions, restore and invite
  destinations retain their context.
- **Qamari:** Settings offers lunar Hijri alongside Gregorian and Afghan Solar
  Hijri. Conversion uses the calculated Islamic civil calendar (Friday epoch),
  independent of platform `Intl`. The selector explains that local moon sighting
  can give a different date. Existing Auto behavior and stored timestamps stay
  unchanged. English/Dari absolute dates, settlement lines, PDF/prose exports,
  newly frozen WhatsApp bill snapshots, React bill pages and server SSR/preview
  render the choice consistently. CSV retains its existing Gregorian/Shamsi columns.
  Backend/web support must deploy before testing Qamari share links in production.

Final combined checks passed on October 11: mobile and web TypeScript, ten
focused mobile selftest suites (including all 69 email-auth regressions and 36
calendar groups), two web frozen-calendar tests, and Android/iOS Metro exports
with Hermes bytecode. The calendar suite compared all 10,631 days in a 30-year
cycle with ICU. The local web production build passed. Relevant pure Go calendar,
SSR-inline JavaScript and existing money/coherence checks passed; two database
service tests skipped because no test PostgreSQL was available, and the optional
preview-writing test skipped without its output flag. Those development checks
did not establish database or phone/gesture/visual QA. The later native-upload
preflight passed all 32 mobile selftest suites and typecheck; an outdated
retired-install router mock was repaired with a focus lifecycle regression.
Signed build and testing-store delivery evidence is in the distribution log.
At that point, Qamari web share/preview testing needed the matching backend/web
deployment, and the 32/52 native upload left those server changes local. The later
33/53 rollout deployed that support; see the distribution log.

## October 11 additional feedback — local development

These changes followed TestFlight build 32 / Play internal code 52 and were not
included in those binaries. At the end of this development batch, no new store
upload or backend deployment had been requested. The subsequent 33/53 delivery
is recorded in [the distribution log](2.2.0-testing-distribution.md).

- **Viewer search:** the black home control is available in every active kaata.
  For viewers it opens Find person with one name/number field, existing kaata
  contacts only, and no creation controls or phone-book permission prompt.
  Unresolved or downgraded roles cannot start a write.
- **Amounts and dates:** the existing tally search field accepts mixed note,
  exact amount and selected-calendar date queries, including Persian digits,
  grouped amounts, English/Dari month names and numeric dates. It searches settled,
  pre-link and failed tallies without changing balances, exports or reminders.
  Calendar changes immediately re-evaluate an active search; no extra filter panel
  is added.
- **Status labels:** opened pending/accepted/rejected/sending pills regain their
  small colored dots. Closed rows retain their pending-only cue and rejected strike.
- **WhatsApp loading:** the icon's spinner is the only visible progress cue.
  Screen-reader phase labels, single-attempt guard and leaving-screen cancellation
  remain in place.
- **Member identity:** names and verified emails come from a current, authorized
  profile overlay, separate from signed membership history. Role labels stay in
  their own place, and email appears below the name. Focus/resume/visible refresh
  updates renamed profiles; session changes and membership removal gate cached
  contact details. An explicit account display name survives Google/Apple sign-ins;
  offline edits retry for the same account, and future shared actions record the
  chosen name without rewriting historical attribution. Backend migration 055
  stores this override; local migration 033 adds the separate profile cache.
  These identity/email changes need the matching backend deployment.

Final checks for this local batch passed on October 11: all **35 mobile selftest
suites** and mobile TypeScript, including 74 email-auth cases, the actual viewer
search and members screens, profile-cache migrations, role changes, account
switches and deferred-result races. Amount/date tests also passed with Kabul and
New York timezones. Backend auth, vault and shared-tab packages passed against an
isolated PostgreSQL database with migration 055 and no skips; server compilation
passed. Web TypeScript and the local production build passed. Independent review
found no remaining material issues. The isolated database was stopped afterward.
These checks do not establish phone or visual QA, and no new native binary was
built or distributed for this batch.

## October 11–12 customer tools — implemented locally

Requested after the member/search batch. At the end of development, no new native
distribution or deployment had been requested; the subsequent 33/53 rollout is
recorded in [the distribution log](2.2.0-testing-distribution.md). The seven
requested features are implemented:

- Notification dropdown: keep its measured position throughout dismissal and
  reject late measure/animation callbacks after closing or reopening.
- Customer sorting: recent activity, name, amount and last-tally date from one
  Sort & filter sheet, retaining whole-ledger totals.
- Onboarding calendar: choose Gregorian, Shamsi or Qamari immediately after
  language; resume/back/invite/email-code/restore paths preserve their context.
- Balance-side detail: two compact Given/Received rows show exact totals and
  counts across the available history. Exclude rejected/cancelled/deleted tallies
  and opening balances; actual available pre-link handovers count once. Search
  and chapter folding do not change these figures. Settlement timing is omitted
  because sparse or restored history would make an average misleading.
- Customer credit limits: owner/manager sets a maximum in each balance direction,
  with warning-only and clerk-block modes. Cloud-connected clerk entries wait for
  HTTPS admission even with warnings or no cap, because a stale phone cannot
  prove that a hard limit was not enabled elsewhere. Waiting/refused attempts
  stay outside balances, exports and header statistics. Fully local paired
  notebooks retain offline clerk writes; hard restrictions require cloud
  enrollment and an online save. Repayment/reduced exposure remains legal, and
  owners/managers/editors retain overrides. The existing manager role fits limit
  configuration, so no new admin role is added. Authority, enrollment and rollout
  details are in [customer-credit-limits.md](customer-credit-limits.md).
- Personal reminders: manually schedule once, daily or on a chosen weekly day
  and clock time. Keep one outstanding due task until explicitly marked done.
  Stored for this account on this phone, separate from the shared ledger; native
  notification taps resolve opaque IDs against current access. No automatic
  customer messages or assumption that opening WhatsApp means a message was sent.
  The reminder contract and native-delivery checks are in
  [customer-reminders.md](customer-reminders.md).
- Groups: one optional custom group per customer in each kaata, synchronized with
  its members. Sorting/group filtering lives in one sheet; management and customer
  assignment stay on dedicated screens. Groups organize the list and do not grant
  access, change balances or create new ledger parties.
  The grouping decision, primary research sources and sync/restore contract are
  in [customer-groups.md](customer-groups.md).

Final mobile checks passed on October 12: all **45 selftest suites** and the
TypeScript check, including real SQLite migrations, actual screen hooks,
account/kaata/role changes, delayed-result cancellation and exact financial
boundaries. The final Android and iOS Metro exports with Hermes bytecode also
passed. These are local bundle checks, not signed APK/AAB/IPA builds or phone QA.

The backend full package suite passed against an isolated PostgreSQL database
with migration 056. All database-backed tests ran; the optional bill-preview and
private historical scratch-replay fixtures were skipped. Focused financial
regressions passed after the final credit changes. The final combined sync,
shared-tab and credit package run also passed with **zero skipped tests**.

At the end of this development batch, the local build numbers were unchanged and
no push, deployment or new native distribution had occurred. The subsequent
33/53 delivery is recorded in [the distribution log](2.2.0-testing-distribution.md).
Consolidated phone and visual checks 15–21 below remain pending.

## October 12 safety and customization — local development

These five requests are implemented in the working source after the 2.2.0
TestFlight 33 / Play internal 53 delivery. They are **not in those testing
binaries**. This batch remains local: no push, backend deployment, signed build,
store upload or mobile production submission is part of this work.

- **Recoverable account deletion:** a verified authenticated deletion schedules
  permanent removal after 30 days, revokes older sessions immediately, and retains
  cloud records during the window. Signing in with the same proven identity
  cancels deletion and starts cloud recovery, with visible progress and retry.
  The updated phone first checks backend support and drains financial vault and
  shared-account outboxes; failed/refused synchronization leaves the phone's data
  intact. Private reminder configurations and old Not sent drafts are excluded
  from cloud recovery, with an explicit export warning. An account already
  permanently purged cannot be restored by this change. Migration 057 and the
  hourly purge worker require a future backend deployment. See the
  [deletion/recovery contract](account-deletion-grace-window.md).
- **Consistent sheet blur:** every menu, country/vault/option picker, sort sheet,
  link/confirmation dialog, date-filter sheet and notification dropdown uses the
  same frosted backdrop. Expo SDK 57 Android blur now references one real native
  `BlurTargetView`; the previous method-only views silently rendered a tint.
  Android 12+ uses native blur, while Android 7–11 use an inexpensive dim backdrop.
  iOS Reduce Transparency disables blur; Reduce Motion removes sheet movement.
  Pending frames, stopped close callbacks and deferred menu navigation are
  canceled on reopening/unmount. Native stack form routes retain their existing
  system presentation.
- **Custom reminders:** any selected weekdays; monthly intervals of one, two,
  three, six or twelve months, anchored to the selected Gregorian month and local
  time. Monthly days 1–28 are disclosed and validated to keep short months and
  native recurrence consistent. Persistent Android/iOS recurrence plans continue
  without reopening the app; the existing 40-task cap and 56 native-request
  budget reject over-budget plans visibly. Outstanding tasks still require
  **Mark done** and never send a customer message. See
  [customer-reminders.md](customer-reminders.md).
- **Multiple groups:** customers may have several custom groups in one kaata.
  Assignment uses checkmarks and one explicit **Done**; the existing sort sheet
  supports any selected groups with OR matching, without duplicating customers
  or changing totals. All/Ungrouped are exclusive and clearing the last selection
  returns to All. Mobile migration 037 expands earlier single assignments; the
  signed event/snapshot add a canonical set and keep the first-group mirror for
  older clients. Update the backend and editing phones before cloud multi-group
  use: an older editor's assignment replaces the set with one group or none.
  Groups remain organization, never permission or a new ledger party. See
  [customer-groups.md](customer-groups.md).
- **Tally search and dates:** the lower dock places search directly beneath the
  existing I received/I gave buttons; viewers retain a search-only dock. One
  calendar button opens Today, Last 7 days, Last 30 days, This month and Custom.
  The custom grid follows Gregorian, Shamsi or Qamari independently of language;
  ranges include both chosen local business days. Changing calendar changes the
  labels without silently altering the selected dates. Range/clear details appear
  only while active. Search combines notes and exact localized amounts with the
  date range across settled, pre-link and Not sent history, while balances,
  Given/Received statistics, exports and WhatsApp statements stay whole. Filtered
  incoming tallies keep their unread notices.

The lower dock and list share an inner flex container inside the keyboard-avoiding
view. On iOS, keyboard padding shrinks that inner containing block: Yoga's explicit
`bottom: 0` position would otherwise keep the dock at the full outer height and
behind the keyboard. Android retains height adjustment. Native keyboard geometry
remains a device check.

Focused fixtures cover the actual date sheet and screen in English/Dari across
all three calendars, midnight and DST boundaries, complete/custom ranges,
whole-ledger scope and viewer controls. The backdrop fixture executes the real
provider and shared animation hook through target wiring, accessibility changes,
interrupted/reopened exits and unmount cleanup. Existing notification, invitation,
auth-redirect, bell and destructive-confirmation regressions pass. All **50 mobile
selftest suites plus TypeScript passed: 51 successful checks** for this local
batch. The web's 85 tests and production build passed. All 14 backend application
packages with tests passed against an isolated UTF-8 PostgreSQL database; only
the opt-in bill-preview image generator was skipped. After the last safety
changes, the full auth/vault packages passed again (154 test/subcase results),
along with the signed-unarchive and shop-profile sync regressions. Android and
iOS Metro/Hermes exports passed with the production build profile's public
environment. These are local bundle checks, not signed store builds or uploads.
Phone blur pixels, keyboard/gesture geometry, actual background notices,
and two-device recovery/sync remain pending. This batch is local only: no push,
deployment, version bump or testing distribution.

## Deferred by the user

The household/shopkeeper ledger needs two parties: the user and Dad on one
side, the shopkeeper on the other. Dad must be able to write from his own phone.
Whole-kaata membership can expose unrelated/private tallies, so do not implement
or invite anyone under the existing membership model as part of this batch.
Revisit ledger-scoped access and whether a dedicated household kaata is suitable
before building this feature. A household kaata is an option, not a settled
product decision.

## Validation

Regression coverage uses synthetic data and native/network boundary stubs;
tab and reconciliation tests execute the real SQL against in-memory SQLite.
No user database, production account or production backend is used.

Verified for the **first feedback batch** on October 11, 2026: all 30 mobile selftest suites and the mobile
TypeScript check passed; all 77 admin tests, web TypeScript check and local web
build passed. Android and iOS Metro exports with Hermes bytecode passed. These
are local bundle checks, not signed APK/AAB/IPA builds or device verification.

Source commits: `c75e22d` (sync), `e8f01dd` (mobile UI), `35b0913` (admin times).
The color and growth additions are saved in separate local commits following
that batch: `78f2b1a` (brand palette and source templates) and `6ee13bc`
(weekly growth).

For the color/growth batch, the user requested consolidated checking/testing
after feature additions finish. Basic development checks only: mobile/web
TypeScript, local web compilation, Expo config/Metro palette resolution,
source-generator syntax and base-color contrast. Six focused backend growth
tests passed against a throwaway PostgreSQL cluster (no skips), covering
accounting, per-install/operator exclusion and coverage. The subsequent calendar
gate passed three focused pure helper tests with sixteen subcases; six frontend
growth presentation regressions passed. Mail/shared/tab template packages were
compiled without running their database tests. No full mobile suite, native
export, screenshot regeneration or real-user test campaign was repeated.

Flyer source photos are absent locally, so no new flyer PDF is claimed.
Portable social templates were generated locally as HTML for later visual/export
review; nothing was posted. Store-screenshot generators were updated for future
use, but existing screenshots were not regenerated.

- Mobile TypeScript check and existing selftests.
- `selftest:tally-search`: matching semantics, literal punctuation, original
  note preservation and ledger ordering.
- `selftest:share`: progress phases, statement scope, upload fallback,
  recipient routing, cancellation and unavailable WhatsApp/counter failure paths.
- `selftest:person-detail`: real screen hooks/handlers for history search,
  whole balance/export/reminder scope, notification visibility, keyboard gates,
  repeated taps, language selection, blur/unmount cancellation, header placement
  and confirmed-review feedback versus cold/optimistic/hidden/background changes.
- `selftest:tally-highlight`: motion-preference races, reduced-motion fallback,
  touch-through rendering, expiry, request replacement and unmount cleanup.
- Calendar tests: civil-calendar goldens and a full 30-year ICU comparison,
  epoch/leap/invalid boundaries, explicit preference persistence and legacy Auto,
  frozen share metadata, PDF/CSV behavior and web/Go date rendering parity.
- `selftest:tabs`: restored pre-link balance replaced by current shared rows,
  badges, unknown pokes, closed/relinked periods, concurrent pulls, missing-contact
  wakeups and slow-loop completion.
- `selftest:sync-reconcile`: joined/paired kaatas, current/retired identities,
  registration ownership, archive/revocation gates and per-vault failure.
- Admin tests, TypeScript check and local web compilation, including timestamp
  formatting under a browser timezone outside Afghanistan.

## Consolidated checks after feature additions

These remain pending; fixture tests do not replace phone testing.

The current signed testing profiles support cloud owner/clerk/viewer flows.
Nearby mesh remains parked in the app. The mesh/pairing portions below require a
development build with `MESH_PARKED` disabled and the pairing entry points
restored; changing solo-mode configuration alone is insufficient.

1. Android/iOS, English/Dari: search with the keyboard open, clear it, and search
   settled/pre-link/Not sent notes. Confirm the balance and WhatsApp statement
   include the whole account. Open a notification while a search is active.
2. WhatsApp installed/unavailable, online/offline/slow upload: preparation is
   visible, repeated taps open once, each language choice opens once after the
   sheet closes, and upload failure still offers the text reminder.
3. Sign in from Settings with each provider; test existing-account restore and
   different-account confirmation. Inspect pending/accepted/rejected rows.
4. Two phones on separate internet connections: add/review tallies, drop the
   socket/network, resume, and confirm both balances and states converge. Restore
   onto a clean test install and verify shared and closed history/badges.
5. Leave a joined kaata non-active on a paired member's phone, write remotely,
   then revisit it. Check current and retired device identities where available.
6. English/Dari and large text: inspect primary/selected/disabled/loading
   controls, Ivory onboarding, white ledger rows, direction and pending states,
   PDF exports, adaptive icons and notification contrast. Compare web/admin and
   statement/invite pages at mobile and desktop widths. Review email rendering,
   flyer print output, social formats and later store screenshots together.
7. Weekly growth: compare counts with the weekly activity chart; confirm Monday
   rollover in Kabul even in a browser abroad, the latest completed-week verdict,
   current-week provisional target, zero/unknown/partial coverage and the
   historical UTC/Kabul transition. Verify missing/older backend, loading and
   retry states. Use synthetic fixtures or isolated test data before any real
   dashboard comparison; do not mutate production analytics.
8. Header WhatsApp: verify icon placement beside the menu, separate touch targets,
   mirrored Dari layout, no duplicate menu/balance action and spinner-only loading.
   Inspect the restored black home add/find control and neutral everyday surfaces.
9. Live decisions: with two signed-in phones, accept/reject a visible pending tally
   remotely; confirm its brief cue, accessible message and balance. Retry/no-op
   pulls must stay quiet. Check reduced motion, offline review acknowledgement,
   search-hidden/folded tallies, background/resume and leave/return behavior.
10. Email route: swipe Back from first-step email sign-in to provider choices;
    test Android/header Back, signup/reset/code steps, busy requests, cold pending
    code resume and successful settings/onboarding/invite/restore navigation.
11. Calendar: select all three calendars independently of language, restart and
    switch kaatas. Inspect exact tally/settlement dates, PDFs, CSVs and a newly
    created share link including its SSR/preview. Compare familiar Qamari dates;
    the calculated convention can differ from the user's local moon-sighting date.
12. View-only kaata: tap the black home Find person control, search name/number,
    open an existing zero-tally contact, and confirm no Add or phone-book prompt.
    Change/downgrade roles while the screen is open.
13. Tally search: inspect search below I received/I gave, including the viewer
    search-only dock, keyboard avoidance and large text. Combine notes/exact
    amounts with date presets or a custom range; try all three calendars,
    reversed/cross-month endpoints, local midnight, clear and calendar changes.
    Filter settled/shared/pre-link/Not sent history; balances, statistics and
    statements stay whole. Check label dots and unread hidden notices in EN/Dari.
14. Members: change a co-member's name on another phone, revisit/resume the list
    and verify name/email refresh. Remove a member, revoke the viewer or switch
    accounts; cached contact details must not leak into an unauthorized list.
    Edit your own name/phone with a viewer or clerk kaata active, retry a rename
    after going offline, and sign in with Google/Apple again; the chosen account
    name must persist without granting ledger-edit permission.
15. Notification dropdown: repeatedly open, dismiss and immediately reopen while
    data loads. Check its position throughout dismissal, backdrop/Android Back,
    screen changes and Reduced Motion on Android/iOS, English/Dari.
16. Sort & filter: try both name, amount and last-tally directions, open/settled
    customers, empty groups and Ungrouped. Confirm full-side totals stay whole,
    preferences stay scoped to their kaata. Select multiple groups (any-selected
    matching), remove one selected group without losing the others, and clear the
    final selection back to All. A viewer can sort/filter without write controls.
17. Fresh onboarding: language → calendar → sign-in, including Persian device
    defaults. Restart at each step, go Back, and resume email codes, invitations
    and cloud restore. Check Gregorian/Shamsi/Qamari examples and persistence.
18. Balance header: compare Given/Received amounts and counts against known local,
    shared, pre-link and earlier closed/re-linked history. Search/folding does not
    narrow them; openings, rejected, canceled and deleted tallies do not count.
    Check compact symmetry, long numbers and large text in English/Dari.
19. Credit limits: configure each direction as owner/manager, including zero and
    blank/unlimited. Try warning and clerk restrictions, exact-cent boundaries,
    repayments while over the cap, two concurrent clerk phones, offline/slow
    requests, sign-out and role changes. Waiting/refused attempts stay outside
    balances, statistics and exported statements. Higher roles retain overrides.
20. Reminders: schedule once, daily, selected weekdays and monthly (1/2/3/6/12),
    including a two-month phase across New Year. Check the stated Gregorian
    calendar and day 1–28 limit, request-budget errors, edit/remove/Mark done,
    denied permission, background delivery without reopening and native taps.
    Opening a customer or WhatsApp does not complete a task. Change account/
    timezone, remove access and restore onto another phone; private tasks stay scoped.
21. Groups across phones: create/rename/remove and assign several as an editor, sync over
    separate networks and mesh, then restore on a clean install. Test simultaneous
    offline group names, Dari joining characters, revoked roles and account/kaata
    changes while saving. Verify an archive hides only that membership and leaves
    the others intact. Groups never change balances or shared-ledger parties.
22. Safe account deletion: use a disposable account against the updated test
    backend. Try offline/failed/just-refused financial operations, then a verified
    delete. Confirm the 30-day explanation, same-identity cancellation and complete
    cloud restore with retry; other identities cannot claim its data. Check private
    reminder/old Not sent exclusions, old-session denial and deadline behavior
    with isolated fixtures. Do not delete a real customer's account for QA.
23. Sheet backdrops: compare all menus/pickers/dialogs and notification dismissal
    on iOS and Android 12+, plus the dim fallback on older Android. Try opening
    while another modal closes, rapid close/reopen, native Back, Reduce Motion and
    Reduce Transparency. Confirm scrolling and tap dismissal still work in EN/Dari.
