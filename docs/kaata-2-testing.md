# Kaata 2.0 — testing and rollout

Implementation: mutual accounts attached to contacts, inline accept/reject,
author-only visible voids, app-only signed-in participation, durable offline queue, and
push delivery infrastructure. Existing private ledger events are not rewritten.
This is not a production release sign-off. Native two-phone testing is required.

Current testing candidate: **2.0.0 / Android 42 / iOS 22**. Source checks,
native compilation and testing uploads passed. Real-phone delivery/action
checks remain pending; this is not a production release sign-off.

### Testing delivery — 25 September 2026

- Feature commit: `9112235`; web privacy follow-up: `2fee7da`. Backend's new
  authenticated invitation route and the updated web privacy copy were verified live.
- iOS build `245115f9-f801-4632-b209-7d7b3b62d4db`: finished; TestFlight
  submission `bde0aed0-f0ab-4b3f-be1f-d626a905ffea` finished; build 22 is VALID.
- Android build `03f637b4-16b0-40a3-bffb-42e5d3372971`: finished; closed-testing
  (`alpha`) submission `2be05153-1bd3-4b89-a8b6-0bdc42ace052` finished.
  This retries `fea1b5f6-fb4b-4c9c-99c9-45f87d1ae3c9`, which failed with an
  EAS SERVER_ERROR uploading its archive; that first submission was canceled.
- Play generated a universal APK for 42 using the same app-signing certificate
  as the previously tested 41 APK. Use that Play-signed APK if review delays
  distribution; do not substitute an EAS upload-key-signed preview APK or
  uninstall/clear data to work around a signature mismatch.
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
   Re-accept it: its amount returns once. Pending tallies count until rejected.
4. Void a tally. Both see it struck out and the balance changes once. Review
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
3. Deploy backend migrations 037–040 and the worker, then enable
   `TAB_PUSH_ENABLED=true` in the testing backend. It defaults to false.
4. Build/install native testing builds and allow notifications after linking.
   Existing linked-contact upgrades/restores must prompt once on a signed-in
   foreground sweep too; there must be no need to unlink/relink to enable alerts.
   With B backgrounded and then fully closed, add/review on A. B must receive a
   generic notification with Accept/Reject actions (expand or long-press the
   alert on iOS). Actions must work without navigating into the app; tapping the
   notification body switches to the correct kaata/contact. Repeat offline and
   after restart: one tap must enqueue only once. An older alert must not undo
   a more recent decision. The author gets accepted/rejected notifications.
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
