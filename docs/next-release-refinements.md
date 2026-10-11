# Next release: user-feedback refinements

Local work on `codex/next-release-refinements`, following the 2.1.1 submission.
No deployment, store submission or release build is authorized for this batch.
Keep the submitted version/build identifiers unchanged until release preparation.

## Implemented

- **WhatsApp reminders:** a visible action below the balance, with a short
  explanation of what gets shared. Preparation and WhatsApp opening have separate
  loading labels. Repeated taps share one attempt, including language selection;
  the native language sheet exits before sharing. Leaving the screen cancels a
  pending reminder so a late upload cannot launch WhatsApp elsewhere. Upload failure still opens a
  plain-text reminder. Opening WhatsApp does not prove the message was sent.
- **Sign-in:** Settings has one Sign in row. The existing sign-in page offers
  email, Google and Apple, retaining account-change and restore safeguards.
- **Note search:** filters tallies within a contact, including settled chapters,
  pre-link history and Not sent entries. All query words must appear in a note;
  English case/accents, Dari/Arabic letter variants, digits and ZWNJs normalize
  only for matching. Stored notes, balance, exports and shared statements remain
  whole. Hidden incoming tallies retain their notifications during a search.
- **Quiet status:** pending tallies have the only yellow dot. Accepted tallies
  have no dot; rejected tallies keep their struck number and accessible status.
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
  palette now drives mobile and web controls, onboarding and marketing surfaces.
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
  repeated taps, language selection and blur/unmount cancellation.
- `selftest:tabs`: restored pre-link balance replaced by current shared rows,
  badges, unknown pokes, closed/relinked periods, concurrent pulls, missing-contact
  wakeups and slow-loop completion.
- `selftest:sync-reconcile`: joined/paired kaatas, current/retired identities,
  registration ownership, archive/revocation gates and per-vault failure.
- Admin tests, TypeScript check and local web compilation, including timestamp
  formatting under a browser timezone outside Afghanistan.

## Consolidated checks after feature additions

These remain pending; fixture tests do not replace phone testing.

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
