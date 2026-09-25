# Kaata 2.0 — testing and rollout

Implementation: mutual accounts attached to contacts, inline accept/reject,
author-only cancellation of pending tallies, app-only signed-in participation,
durable offline queue, and push delivery infrastructure. Existing private ledger
events are not rewritten.
Automated checks and store submissions do not replace native two-phone testing.

Current release candidate: **2.0.0 / Android 45 / iOS 25**. Adds pending-only
cancellation (server and offline queue), inline expanded-row cancellation,
badge-only linked names, self-authorship suffixes, contacts-permission recovery,
and brief gray notification highlights that leave already-visible tallies in place.
Backend migration 043 repairs first-kaata pre-sign-in uploads without rewriting
ledger history. The fix is compatible with existing 1.2.0 clients.

On 25 September 2026, Matee explicitly authorized commit/push, testing delivery,
then production submission once this new build is available in TestFlight.
This overrides the usual wait-for-another-approval step for this delivery only;
it does not claim that the new native builds have already been phone-tested.
Store review/availability is separate from successful upload.

### Current delivery — 26 September 2026 Kabul (45/25)

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
