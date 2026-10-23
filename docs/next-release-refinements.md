# Next release: user-feedback refinements

October 22 shared-account safety work is saved for review, without a deployment or
store release. Confirmed shared balances now exclude pending proposals, unlinking
preserves debt/history and final pending reviews while stopping new sharing and
alerts, and relinking checks fresh previous history before carrying a balance.
See [the current contract](mutual-tab-design.md#october-22-confirmed-balances-and-safe-unlinking)
for migrations, compatibility, evidence limits and required two-party phone QA.

October 23 Xiaomi checks use a separately installed, release-runtime
`af.kaata.sharedtest` app and disposable accounts on a loopback-only backend.
The installed production app (2.2.4/code 73) and its ledger are untouched.
Native restore, confirmed/pending balances, unlinking with retained history,
accept/reject after closure, accidental pending-tally cancellation, accepted
tally finality, and safe relinking passed. Peer-account API reads independently
confirmed the phone's decisions. The harness and credentials remain ignored in
`build/shared-close-safety/`; this is not a store build or release. Real FCM
delivery is outside this isolated package's checks.

Rollout note: `main` pushes automatically deploy the backend. Store code 73
cannot send the new history receipts required to relink previously shared
contacts, even when their confirmed balance is zero. First-time sharing and
ordinary existing-account tally entry remain compatible. Coordinate that
temporary relinking restriction with the next mobile release before deployment.

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
  The October 15 follow-up adds visible hourly install/activity charts,
  Busy hours with completed-hour averages and peak times, and the ten latest
  installs with second-resolution timestamps. Earlier work only exposed times
  on individual records. See [admin-analytics.md](admin-analytics.md#clock-times-and-busy-hours).
- **Product and marketing colors:** app/web controls, onboarding and PDF/email
  chrome use black, white and neutral grays, with the original black identity
  assets restored from Git. Android adaptive and notification accents are black;
  the website adopts actual neutral shadcn controls. Detailed ledger rows stay
  white, and financial, destructive, attribution and review-state colors keep
  their meanings. The Aubergine/Saffron/Ivory/Charcoal/White palette remains for
  flyers, posts and other marketing, with its own colored logo and generators
  that cannot overwrite product assets. See [brand-language.md](brand-language.md).
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
  Reporting weeks now run Saturday–Friday in Kabul. Migration 060 preserves
  legacy Monday aggregates and stores recomputed Saturday windows separately;
  Friday activity remains included. No new device telemetry is collected.
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

## October 12 safety and customization — testing update 34/54

These five requests were implemented after the 2.2.0 TestFlight 33 / Play internal
53 delivery and saved in feature commit `d7e337b`. The user then requested a new
testing release: **TestFlight 34 / Play internal 54**. Their matching backend/web
support deployed before distribution. Exact source and verified delivery are in
[the distribution log](2.2.0-testing-distribution.md). The 2.1.1 production reviews
and closed-testing track remain unchanged; no mobile production submission was
made.

- **Recoverable account deletion:** a verified authenticated deletion schedules
  permanent removal after 30 days, revokes older sessions immediately, and retains
  cloud records during the window. Signing in with the same proven identity
  cancels deletion and starts cloud recovery, with visible progress and retry.
  The updated phone first checks backend support and drains financial vault and
  shared-account outboxes; failed/refused synchronization leaves the phone's data
  intact. Private reminder configurations and old Not sent drafts are excluded
  from cloud recovery, with an explicit export warning. An account already
  permanently purged cannot be restored by this change. Migration 057 and the
  hourly purge worker deployed for the 34/54 testing update. See the
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
and two-device recovery/sync remain pending. These local checks preceded the
verified 34/54 testing distribution; marketing version remains 2.2.0.

## October 12 home controls and timed ranges — testing update 35/55

These two requests followed the verified TestFlight 34 / Play internal 54 release
and were built in `c549e04`. The user then requested testing delivery: they are
now available in **TestFlight 35 / Play internal 55**, from release source
`f91b9a8`. Exact signed-build, rollout and tester-access evidence is in
[the distribution log](2.2.0-testing-distribution.md). Production versions/reviews
and closed testing remain unchanged.

- **Separate home controls:** one lower dock contains Sort & filter, an inline
  customer search field and the black plus/add button fixed at the right. Search
  contents and text mirror in Dari; Sort stays to the left of the search field.
  Search finds existing customers, including people with no tallies; an explicit
  add mode opens the creation form and phone-book shortcuts. Viewers retain
  search/sort without creation. Kaata totals remain whole when filtering.
- **Custom tally times:** the custom date sheet adds start/end time selectors.
  Defaults are 00:00–23:59; the chosen end minute is included. Invalid same-day
  reversed times cannot apply. Today/week/month presets still span whole local
  days. Saved custom times survive reopening and calendar changes; the active
  range chip shows dates and localized 24-hour times. Dates continue to follow
  Gregorian, Shamsi or Qamari; the time follows the device timezone.

TypeScript and nine focused regression suites passed: person-find, person-detail,
tally-date-sheet, tally-search, customer-groups, bell-badge, notification-popup,
sheet-backdrop and tab-join. The final person-screen check covers inclusive end
minutes and two-line localized clock labels. iOS/Android Metro/Hermes exports
passed with the production build profile's public environment. These are local
bundle checks, not signed binaries or store uploads. Independent review's picker
error/queued-event and resolving-role badge findings were fixed and covered.
Stale group setup copy now correctly says a customer may belong to several groups.

Native narrow-screen, keyboard, RTL and Android/iOS time-picker checks remain
device work. Before the
next distribution, test search on both home tabs, groups/sorting, zero-tally
customers, viewer controls and a kaata switch while results are loading. For
timed ranges, check equal start/end minutes, crossed months, reopen/cancel,
clearing and the end-minute boundary across current/settled/Not sent history.
Whole balances, exports, WhatsApp statements and unread notices must stay whole.

## October 13 combined home search — testing 37/57

After testing build 36/56, the user requested that the home search show both
**To collect** and **To pay** results together. A nonblank query now opens one
scrollable results view for the active kaata, with compact direction headings
and a matching-customer count. Empty sides are omitted and no matches show one
empty state. Directional overview tabs and totals are hidden while searching,
so the absolute row amounts keep their meaning without a misleading total.

Clearing search restores the previous tab. A queued swipe from before search
cannot switch that tab during search or after it returns. Selected groups and
sorting still apply; each customer appears once, and row navigation, credit
badges, pull-to-refresh and role permissions use the same controls as the idle
overview. Viewers retain search without edit/delete or creation actions. Names
and phone-number matching include zero-tally customers as before. Search remains
within the current kaata and clears on a kaata/account switch.

TypeScript, person-find, customer-group-ui and customer-groups checks passed,
including English/Dari, both platforms, opposite-side-only matches, zero-tally
contacts, group deduplication, viewer/clerk gates and stale swipe callbacks before
and after clearing search. Local iOS/Android Metro/Hermes exports passed with the
production public environment. Review checked scope safety, direction cues and
accessibility; the swipe memo also tracks its generation across discarded renders.

This source change after the 36/56 delivery is included in testing 37/57. Check
the combined list in English/Dari, narrow screens and large text, including
opposite-side-only matches, both previous tabs, group filters, keyboard clearing
and returning from a customer.

## October 13 group-management visibility — testing 37/57

**Manage groups** is now a full-width black button with a folder icon in a
separated footer of the Sort & filter sheet. It stays outside the scrolling
options, so long group lists do not bury it. The scroll area yields space to
the footer under the existing sheet height limit, with bottom safe-area padding
applied once. The button also remains available when creating the first group.
Existing role restrictions and dismissal-before-navigation, double-tap and
account/kaata guards are preserved. This refinement follows testing build 36/56
and is included in testing 37/57.

TypeScript and the existing customer-groups regressions, including the sheet's
navigation/timer checks, passed. Check the footer on narrow screens, large text
and long group lists in English/Dari during the next device pass.

## October 13 saved customers without tallies — testing 37/57

Saved customers now stay on the home screen even before their first tally. A
compact **No tallies yet** section follows the financial rows on both To collect
and To pay, so returning from a new customer does not make them disappear or
switch tabs. Combined search includes those customers once. Adding a first tally
moves the same customer into the appropriate financial section.

Neutral contacts do not contribute to the financial totals, customer counts or
filtered subtotals. The group-filter hint explicitly names its financial side.
Known balances/history, settled accounts and linked or undownloaded shared
accounts retain their financial classification. Group filters still apply to
neutral contacts and can be cleared from search; recent/date sorting uses the
contact's creation date when it has no tally date. Only saved active customers
appear here, not the device's entire phone book.

TypeScript and the customer-groups and person-find regressions passed. Coverage
checks returning from creation on To pay, both idle tabs, a single search match,
first-tally transitions, group filtering, viewer/clerk controls, English/Dari,
and financial totals staying whole. Native checks remain for testing 37/57:
add a customer and go back without a tally, search/open it, then add a
tally; repeat on both tabs and with groups, narrow screens and large text.
This source change follows testing build 36/56 and is included in testing 37/57.

## October 13 bottom-search keyboard dismissal — testing 37/57

Home customer search and customer tally search now offer an accessible **Hide
keyboard** down-arrow while their input is focused, even with an empty query.
Home uses the black Add button's existing space during typing, then restores Add
when the input loses focus; viewers also get the dismissal control. Tally search
places its 44pt control alongside the date filter without adding a toolbar row.
Closing the keyboard preserves the query, matched rows and date range. Clear
still clears only the query. The keyboard's Search key also closes typing on
both screens.

The home idle/results lists and tally list use interactive keyboard dismissal on
iOS and drag dismissal on Android. Existing handled row taps, horizontal home
navigation and keyboard avoidance stay intact. Keyboard-hide events release the
input focus, including ordinary Android Back; route and account/kaata changes
clear stale focus on the screen's own field. Sort and date-sheet opening also
dismiss first. Older Android resize configurations may omit keyboard-hide events;
in that case Back can leave the down control visible until explicitly pressed.

TypeScript, person-find and person-detail regressions passed, covering empty and
nonempty searches, retained date filters, separate Clear behavior, native hide
events, focus release, viewer access and English/Dari on Android/iOS. Source
review found no blocker. Device checks remain for iPhone interactive dragging
and cancelled drags, closing/refocusing, Android Back, narrow screens and large
text with a full list. This source change follows testing build 36/56 and is
included in testing 37/57.

## October 13 search clear-button alignment — testing 37/57

Both bottom searches use the same plain cross, vertically centered in a fixed
44pt tap area at the trailing edge. The home clear target no longer leaves extra
padding around that edge, matching the tally search. Explicit physical margins
mirror the spacing in Dari; the previous tally `marginEnd` did not follow the
app's manual row reversal. Clear still only clears the query, independently of
the keyboard-down control and date filter. Existing search regressions and
TypeScript passed; inspect the alignment on phones in testing 37/57.

## October 13 smoother bottom-search transitions — testing 37/57

The iPhone dock now updates its height, action buttons and bottom padding when
the keyboard begins moving, using the same keyboard timing for opening and
closing. It previously changed again after the keyboard finished. Only a
completed hide releases input focus, so cancelling an interactive drag retains
the query and typing session. Added keyboard animation scheduling is limited to
the visible route; existing keyboard avoidance remains the single owner of
screen insets. Android retains its supported completed-event path.

Clear controls reserve their 44pt space, preventing the input from resizing on
the first or last character. The tally down control and viewer home down control
ease their width and spacing over 160ms. Hidden controls have no tappable or
accessible children; rapid changes stop the prior animation, and Reduce Motion
switches immediately. The input stays mounted and queries/date filters retain
their existing behavior. Home also avoids an independent toast lift while the
keyboard is visible. No ledger-row or per-keystroke layout animation is added.

TypeScript, person-find, person-detail and the new search-controls selftest passed.
They cover keyboard-start timing, cancelled closes, hidden-route isolation,
retained input identity, no added keyboard animation per keystroke, Reduce Motion,
LTR/RTL spacing and interrupted/unmounted control animations. Visual phone checks
remain for repeated focus/clear/close, slow interactive drags and cancellations,
toasts, narrow screens, large text and navigating to an add form and back.
This source change follows testing build 36/56 and is included in testing 37/57.

## October 13 neutral product identity and Afghan reporting week

The user requested the original black icon/splash and mostly black/white/gray
app and website. Mobile identity assets are restored from their exact original
Git bytes, and native splash/adaptive/notification colors are black. Onboarding
and export headers also use neutral tokens. The web adopts actual neutral
shadcn Button, Card, Input and Skeleton components for public controls and
shared admin chrome. Statement/invite/error pages and transactional email chrome
follow the same product direction. Financial, review, provider and chart colors
retain their meaning. The five-color marketing palette stays intact, with its
own colored logo asset and generators that cannot overwrite product assets.

Dashboard weeks now run **Saturday–Friday in Kabul**, including weekly activity,
growth accounting and install cohorts. Saturday–Thursday are the working days;
Friday is the holiday, with any Friday app use still included in the seven-day
metric. Migration 060 preserves frozen Monday rows and recomputes Saturday
windows from recorded daily history before freezing them separately. It never
shifts a Monday aggregate to a Saturday label. API metadata keeps frontend labels
correct during rollout/rollback; incomplete coverage and undefined growth rates
remain explicit.

This batch also ships the prior local home/search/group/keyboard refinements.
The candidate remains **2.2.0**, with **iOS 37 / Android 57**, restricted to
TestFlight and Play internal testing. Fresh store preflight shows production
2.1.1 is now approved on both stores; this testing request does not promote 2.2.0
or change production store versions. Mobile 53 selftest suites, TypeScript,
explicit iOS/Android production bundle exports, web 90 tests/typecheck/build and
26 release-helper tests passed. Saturday-boundary/migration checks passed on an
isolated PostgreSQL database; full server verification is recorded with delivery.
Browser checks inspected neutral English/Dari web layouts at desktop and phone
widths. Native phone checks remain separate. Both testing releases are now
verified available, with backend/web live at `0424b02`, preserved Monday history
and unchanged mobile production versions. See [the delivery log](kaata-2-testing.md).

## October 14 group actions and draggable sheet handles — next testing build

The customer group-assignment sheet now shows a full-width outlined **Manage
groups** button with a plus icon above the primary **Done** button. The home
Sort & filter sheet's existing management button also uses a plus. Permissions,
draft selections, saving and navigation remain unchanged.

All seven custom bottom sheets now share a working, full-width 44pt handle:
account/settings, kaata picker, action/overflow menus, option/language pickers,
country picker, customer Sort & filter and tally date filters. A downward drag
follows the finger and closes on a deliberate distance or flick. Short pulls,
upward returns and cancelled gestures restore the open position. Rapid re-grabs
continue from the native spring's actual position; late native replies cannot
move or close a reopened/unmounted sheet. Reduce Motion skips automatic return
movement. Tapping or activating the handle with a screen reader also closes it.

Gestures stay on the handle area, so lists, fields and row actions keep their
normal touch/scroll behavior. Dismissal closes search keyboards and uses the
date sheet's existing native-picker cleanup. Exiting sheets disable their row
touches while preserving modal exit animations and deferred navigation. Existing
native group/manage-group route gestures remain in place; centered confirmation
dialogs and the bell dropdown are not bottom sheets.

Validation: the real-hook drag/handle selftest covers direction, short/long/flick
decisions, multi-touch/cancellation, interrupted springs, asynchronous native
replies, presentation lifetimes, current callbacks and accessibility. Existing
sheet-backdrop, customer-groups, tally-date-sheet and auth-redirect suites pass,
including English/Dari and their platform/calendar cases. TypeScript and explicit
iOS/Android production Metro/Hermes exports pass. Native finger feel,
handle responder transfer, keyboard dismissal and scrolling still need checks
on iOS/Android. This source batch follows testing 37/57 and awaits the next
native testing build; no version bump or store upload is included.

## October 14 reminder notification starts the reminder flow — next testing build

Tapping a customer reminder notification now resolves its kaata/customer, waits
for the full ledger to load in the foreground and starts the existing WhatsApp
reminder flow automatically. A saved message language prepares the draft directly;
**Ask** opens the language chooser first. The normal preparation spinner, complete
statement and offline text fallback are reused. The manual nudge does not flash
before the automatic flow. Sending stays in WhatsApp, and opening a draft does
not mark the private reminder Done.

Only a native tap creates the one-use, in-memory handoff; a deep-link flag or the
in-app reminder **View** action cannot authorize automatic statement preparation.
Account, kaata, customer/access and reminder version are revalidated. Duplicate
listener/launch responses are claimed once and the retained matching native
response is cleared with SDK 57's synchronous API. Later recurring occurrences
remain distinct. Edited/completed/deleted notices, account changes (including
switch-away-and-back), navigation away, background preparation and delayed reads
cannot start or replay old work. Language-picker cancellation and WhatsApp failures
leave the normal header button available for an explicit retry.

TypeScript, person-detail (executing the actual handoff hook), reminders-ui,
notification-navigation, notifications and share regressions pass. They cover
cold/warm duplicate taps, recurrence, ordinary launch, invalid/deep-link flags,
foreground/loading, language choice, reminder edits/removal, account ABA and
legacy tab/accept/reject routing. Native notification delivery/cold launch and
the actual WhatsApp handoff still require iOS/Android checks in the next build.
Production Metro/Hermes exports also pass for both iOS and Android.
This is source work after testing 37/57, with no native version/store change.

## October 14 invite sync investigation and local anchor repair — next testing build

An accepted invitation in the admin dashboard represents the server's access
list. Phones learn the other member through signed membership/device events;
these are separate states. The reported case was investigated using read-only
VPS membership, event, device, audit, snapshot and request-log queries, the
host's supplied App health report/screenshots, and an offline replay of public
membership envelopes through the actual app signature verifier and chain fold.
Backend/web containers are healthy at deployed source `0424b02`. No live ledger,
membership, device revocation, trust key or account was changed.

The older recovered kaata lacks its original anchor-signed owner/genesis event.
Its persisted membership signatures verify, but cannot establish a usable chain.
A later remove/re-invite restores server access while the existing device-removal
rule still refuses a self-service witness. An update or a counter refresh cannot
manufacture the missing owner signature or override that removal. Do not re-anchor
the existing ledger, mark rejected proofs accepted, or clear removed device rows
as a repair. Original valid ownership proof or a separately designed recovery
path is required for that state.

The newer kaata has a valid genesis but no admission events or witness request
from the affected joiner. The host's report shows a successful server sync with
no unsent/rejected events. The joiner's own diagnostics are still needed to
locate that interruption; do not claim this specific live join is resolved.

A separate contributing app defect was reproduced against real SQLite:
`seedJoinedVaultMinimal` creates a NULL local anchor; the later listing seed's
`INSERT OR IGNORE` could leave it NULL after snapshot failure or absence. The
repair fills only a missing pin from the original session's authorized listing,
records the standard admission retry atomically and sweeps already downloaded
proofs even after the pull cursor has caught up. The periodic reconciliation pass
also repairs affected installed copies. Witness requests run outside the session
mutex, failures retain the retry marker, and existing pins/removals, other-account
private rows, archived nonowner access and account-switch guards stay enforced.

App health now separates verified membership proof from server sync: active
kaata anchor/genesis, current account/device admission, aggregate proof conflicts,
pending witness and un-applied/quarantined/rejected/tombstoned membership event
counts. It includes no event payloads, names or keys; identity/kaata/key changes
discard the probe and any probe failure leaves the rest of the report usable.
Proofs beyond the verifier's event limit report incomplete/current admission
unknown, rather than treating an older partial fold as healthy.

Validation: mobile TypeScript, invite-anchor-repair, diagnostics (10 cases),
recovery-session, sync-reconcile, sync-push, device-key, ingest and the real
membership-chain suite pass. Explicit final iOS/Android production Metro/Hermes
exports pass. Independent review checked lock/session order, immutable pins,
revocation and archived-member gates, crash retry markers and report privacy.

Source-only changes after testing 37/57; no native version/store upload or backend
deployment is included. Device join, interrupted restore and two-phone convergence
still require testing with the next build.

### Follow-up: interrupted online joins and misleading success

A subsequent read-only VPS check still found acceptance without the affected
joiner's signed admission in the newer kaata. No later join/proof request from
that device was present. Its precise interruption remains unknown because the
joiner's diagnostics were unavailable. A server-only edit cannot provide the
phone-held signature required by the installed clients; no membership, device
revocation, anchor, account or ledger data was manually changed.

The follow-up audit found independent failure paths in the shipped app:

- It saved the witness retry flag after snapshot/materialization and navigation
  work. A failure or shutdown before then could leave an accepted join unqueued.
- The once-per-process backfill guard could be consumed before the retry flag
  existed, preventing another attempt while the app remained open.
- An accepted local mirror could be mistaken for verified membership, and local
  event creation could be mistaken for publication to the shared event log.
- Request deadlines ended at response headers, allowing a stalled response body
  to hold up the rest of the join indefinitely.
- A failed first check-in could leave the server verification keys unpinned;
  waiting for join success to trigger another check-in then blocked both steps.
- The invite screen could announce success despite incomplete admission.

The mobile follow-up adds a durable account-scoped acceptance journal before the
consuming request, persists materialization/admission obligations together, and
replays lost responses idempotently. Foreground/periodic repair no longer shares
the one-shot genesis guard. Existing local joined kaatas are checked against the
authorized listing to recover missing retry flags. Completion checks use real
signed account/device proof and server publication, with incomplete or refused
setup shown explicitly. Network deadlines include body reads. Existing trust
pins, revocations and captured-session guards remain enforced.
Missing verification keys and device registration are retried as prerequisites
with the existing key-pinning and rotation rules.

The separate backend defect was reproduced with a real isolated PostgreSQL
database: a consumed invitation returned success after owner removal or
self-leave. Commit `3c1233d` now rejects that retry, while preserving legitimate
same-account retries after a lost response or token expiry. The entire vaults
package passed. This commit was pushed to `main`; Dokploy checked out that exact
commit and rolled out a new healthy backend container. The public health route
still reports `commit: unknown`, so checkout/rollout evidence establishes the
deployed version. This safeguard does not supply the missing phone signature.

Validation: TypeScript and the 18-scenario invite-join regression suite passed,
including real Ed25519 signing, SQLite journal/proof loading, lost replies,
consumed-link remounts, publication acknowledgement, missing prerequisites,
revocation/refusal, account changes and reused-route races. Snapshot deadline
tests (6), upgrade anchor/admission repair, recovery-session, invite-dialog,
membership-chain, diagnostics, device-key, sync-push, sync-reconcile and ingest
checks also passed. Production Metro/Hermes bundle exports passed for iOS and
Android. These automated checks do not replace a two-phone test; bundle exports
are not native builds or store uploads.

The mobile changes require a new installed build. Testing 37/57 and the users'
current builds do not contain them. The older recovered kaata's missing genesis
and owner-authorized re-admission after removal remain separate recovery cases;
this change does not bypass either requirement. Do not claim the affected phones
are repaired until their signed admission reaches the server and both phones
converge.

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
   controls, neutral onboarding, white ledger rows, direction and pending states,
   PDF exports, adaptive icons and notification contrast. Compare web/admin and
   statement/invite pages at mobile and desktop widths. Review email rendering,
   flyer print output, social formats and later store screenshots together.
7. Weekly growth: compare counts with the weekly activity chart; confirm Saturday
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
