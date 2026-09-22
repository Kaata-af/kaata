# Kaata 2.0 — testing and rollout

Implementation: mutual accounts attached to contacts, optional accept/dispute,
author-only visible voids, browser participation, durable offline queue, and
push delivery infrastructure. Existing private ledger events are not rewritten.
This is not a production release sign-off. Native two-phone testing is required.

## Local checks

`bun dev` keeps the Expo QR workflow. The backend wrapper uses the mobile
`.env.local` LAN backend address for newly generated testing links, unless an
explicit backend URL override already exists. This prevents local invitations
from opening the production service. Both phones must reach that LAN address.
For an HTTPS development tunnel, set `KAATA_DEV_PUBLIC_URL` explicitly.

Expo Go can exercise the ledger and browser counterpart, but not native push or
the installed app's `kaata://` scheme. To open an invitation directly in Expo Go,
use its printed `exp://<host>:<port>/--/t/<token>` route. The normal browser
**Open in Kaata** button is for an installed development/store build.

- Backend: `go test -count=1 ./...` and `go vet ./...` from `apps/backend`.
  Set `POSTGRES_TEST_URL` to an **isolated disposable test database** first.
  The harness drops its schema; never use the dev or production database.
- Mobile: `npm run typecheck` and all `selftest:*` scripts from `apps/mobile`.
  `selftest:tabs` uses real in-memory SQLite and a fake HTTP service, including
  cutover balances, retries, ordering, rejection retention, and restore.
- Web: `bun run build` from `apps/web`.
- Browser fixtures: `go test ./internal/tabs -run TestWriteTabPreview -preview-out <directory>`.
  Open `tab-en.html` and `tab-fa.html`; these use fake records, not a live account.

## Two-phone acceptance checklist

Use a new test contact on each device; keep real customer data out of this trial.

1. Create private tallies totaling 100 on phone A. Link that contact and share the
   link with B. B can first open it in a browser without signing in, or tap
   **Open in Kaata** and choose its own same-currency kaata and contact.
2. Verify A shows +100 and B −100, with one explicit opening tally. Old private
   entries remain under **Before linking** and are not counted twice.
3. Add on A, then B. Check both balances and opposite I-gave/I-received labels.
   Accept and dispute the other side's tally. Neither changes the amount owed;
   disputed rows stay counted until the original author voids them.
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
   A signed-out install has no account recovery: preserve its capability link.
9. Export customer and whole-kaata reports; compare displayed balances with them.
   Voided entries do not count. A bill link remains an immutable snapshot.
10. Test Dari and English, large text, long notes/names, small screens, and print.
    I received stays on the left and I gave on the right in both languages.

## Real push notifications

Expo Go cannot test remote notifications. No production credentials or store
settings are created by this code change.

1. In the existing Firebase project, register Android package `af.kaata.app` and
   supply its client config via EAS file variable `GOOGLE_SERVICES_JSON` (or an
   ignored `apps/mobile/google-services.json` for local native builds).
2. Configure FCM V1 and APNs credentials in EAS. If enhanced Expo push security
   is enabled, supply `EXPO_ACCESS_TOKEN` to the backend through its secret store.
3. Deploy backend migrations 037–039 and the worker, then enable
   `TAB_PUSH_ENABLED=true` in the testing backend. It defaults to false.
4. Build/install native testing builds and allow notifications after linking.
   With B backgrounded and then fully closed, add/review on A. B must receive a
   generic notification; tapping it switches to the right kaata and contact.
5. Revoke permission, rotate a capability link, and remove a vault member;
   verify no further alerts reach those revoked subscriptions. Test an expired
   token and a provider outage (server tests exercise receipt and backoff paths).

Push alerts are hints, not transaction authority. Delivery can be delayed or
duplicated by providers; the server ledger and its revision remain authoritative.
If disabled, local notifications only work when a pull actually runs, not while
the OS has suspended the app. No background-delivery claim should be made until
both native platforms have passed the above test.

## Release order

Deploy the backend and web routing/privacy changes before distributing 2.0 clients.
Use TestFlight and Play closed testing first. The first testing build is 2.0.0,
Android versionCode 41 and iOS build 21. Review store privacy disclosures for
shared records and notification identifiers. Leave production promotion until
the device checklist passes. Universal/app links are
not yet configured; the browser's explicit **Open in Kaata** button uses the
existing `kaata://` scheme.
