# Recoverable account deletion

Status: implemented and deployed for the 2026-10-12 testing update, included in
2.2.0 TestFlight **34** and Play internal **54**. Physical-device recovery checks
remain pending. This replaces the October 8 design. Backend migration is **057**,
not the proposed 054.

## User contract

Delete account schedules permanent deletion **30 days after the first request**.
Sessions are revoked immediately. Saved cloud kaatas, memberships, profiles and
shared tally history remain during recovery. Repeating the request does not
extend it.

Signing in with the same proven Google, Apple or Kaata email identity before
the deadline cancels deletion. Password reset qualifies after verifying a new
code. Failed passwords, unfinished codes and rejected different-account choices
do not cancel it. Other phones' old sessions remain revoked after recovery.

The phone clears local data only after an explicit server acknowledgement.
Returning sign-in opens cloud restoration automatically, with progress and retry
for incomplete restoration. This protects future requests after backend rollout;
it cannot recover accounts already permanently purged by the former behavior.
The store-review/demo account receives the same recovery protection.

An account-matched cancellation marker takes priority at cold launch and the
onboarding index, even when an interrupted restore already minted a self row or
ordinary recovery was previously skipped. It clears only after complete
restoration. Recovery includes still-saved owned archives and preserves their
archived status without selecting them as the active kaata. Archived member
metadata returns, while historical reads remain subject to the existing sharing
cutoff. Already purged archives and shared history the account can no longer
access cannot be recreated; the confirmation asks for those exports first.

## Backup before local cleanup

New clients first verify authenticated `GET /v1/account/deletion-policy` reports
`grace_days: 30`. Against an older backend, the app stops before DELETE.

Then the app registers pending kaatas and drains unacknowledged financial vault
events through normal signed sync, followed by the shared tally outbox. Offline
no-ops, transport failures, refused uploads, incomplete registration, remaining
shared intents and unsaved credit policies stop deletion and retain phone data.
A newly refused shared intent moving into `tab_failed_ops` is still a failure
even if the normal outbox becomes empty. Work is bounded to 100 batches per vault
and a two-minute deadline between batches; in-flight calls retain their normal
transport timeout.

Confirmation captures bounded SHA-256 fingerprints of previously refused
financial event/draft content. These fingerprints are stored with the exact
deletion proof, without financial notes or unbounded ID lists in keychain. Just
before cleanup, the financial writer mutex guards a fresh all-vault/shared/credit
outbox check and the database drop/close together. Newly queued intent and newly
refused or changed drafts block erasure even during DELETE's network wait. Schema
initialization runs after releasing that mutex. Account navigation/gestures and
editing are blocked during the request as a supporting measure.

If the server has acknowledged deletion but late edits prevent local cleanup,
the receipt and phone data stay intact. Boot permits access instead of entering
a fatal cleanup loop. Account shows a direct **Sign in** action even if the
revoked JWT remains cached: signing in with the same identity cancels deletion
and enables backup. Legacy proof without a fingerprint fails closed for unknown
refused drafts; already dropped tables allow interrupted cleanup to finish.

**Private reminder settings and previously refused “Not sent” drafts are not
cloud-backed.** The confirmation asks users to export these first. Recovery
restores saved cloud data, not every local-only setting or draft. The existing
confirmed cleanup also clears backup files on this phone.

## Backend

Migration `057_account_deletion_grace.sql` adds `pending_delete_at`,
`delete_requested_from_install`, an indexed purge queue and
`vaults.archive_purge_not_before`.

Request and recovery take the same account lock. Request-time code rechecks the
deleting credential's account, provider and epoch after locking, so a stale
authenticated request cannot delete a newer sign-in. It writes the pending
timestamp and installation receipts, retires this account's installations,
revokes credentials/increments epochs, and consumes old account-bound email
codes. Legacy unbound credentials still owned by this account also revoke.
Installations explicitly switched to a different account remain unaffected.
Request time preserves ledgers, shared tallies, memberships and profile data.
Still-saved owned archives receive a purge hold through the request's original
30-day deadline. Their archive display timestamp stays unchanged. The archive
worker locks the active owner before the vault and rechecks this hold; pending
owners cannot be purged by that separate worker. Cancellation keeps the hold
until the original deadline, so cloud restoration cannot immediately race a
previously expired archive. Recovered owners can unarchive through the later
deadline; both REST and signed unarchive clear the hold. Normal archives keep
their existing lifecycle, and already-purged archive data cannot be recovered.
Archived non-owner memberships retain the existing sharing cutoff; recovery
does not expose their history.

Cancellation belongs to `completeSignIn`, the transaction tail shared by every
auth provider. It follows identity proof and precedes retired-install checks,
rolling back if any later sign-in step fails. The `deletion_cancelled` response
flag is stored against the recovered account ID, not an unscoped boolean.
Pending hollow accounts skip the legacy same-email merge, so cancellation or
expiry is checked against the original account rather than another account.
Defensive legacy credentials use an explicit installation owner when their
account field is absent; missing both ownership fields fails closed.

Authenticated writes lock and recheck the actor's active account before their
other rows, so a request already authorized before deletion cannot mutate the
pending account afterward. Credential cache invalidation is immediate in this
server; other processes retain the existing maximum 60-second cache freshness.

The worker runs at boot and hourly, scanning up to 50 expired accounts per tick.
Each destructive transaction uses `FOR UPDATE SKIP LOCKED` and rechecks expiry.
Recovery and purge serialize on the same lock. Multiple workers cannot purge a
cancelled or unexpired request. Expired accounts cannot reactivate while waiting
for the next worker tick.

Purge retains permanent-deletion semantics: remove the account, private owned
vaults/events, memberships/device bindings and private identity; detach
attribution in surviving participants' records and close abandoned shared
tallies without accepting entries or settling balances. Other participants keep
shared financial history.

## HTTP and old clients

New clients send `X-Kaata-Deletion-Grace: 30` and get
`{"status":"deletion_scheduled","purge_at":"…"}`. Older installed clients get
their recognized `status: "deleted"` plus `purge_at`; server retention remains
30 days, supporting their existing acknowledgement/local-reset behavior.

Dedicated deletion middleware performs a fresh credential check. A matching
installation/account receipt can confirm a lost-response retry without granting
account access. Receipt status is read atomically. An ordinary 401 or another
account's receipt never authorizes cleanup. SecureStore proof writes and cleanup
are bound to the captured local session generation and exact proof, preventing
late responses from overwriting or clearing a newer account's data.

## Disclosure and rollout

English/Dari confirmation, privacy policy and deletion page describe retention,
cancellation and local-only exclusions. Apple requires deletion rather than
temporary deactivation and allows deletion taking time when explained; Google
requires account/data deletion and clear retention disclosures. **30 days is
our product choice**, not a specific duration endorsed by either store.
References: [Apple account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/),
[Google account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111).

When asked to ship, deploy backend migration/worker and public web disclosures
before distributing mobile. Verify the live policy reports 30, worker health
and any store disclosures needed for that release. The 34/54 testing delivery
deployed migration 057, the exact worker source and public disclosures, and
verified the live authenticated policy reports 30. No destructive live deletion
or purge was tested. Both testing builds are available; production store reviews
were unchanged. See [the rollout evidence](2.2.0-testing-distribution.md).

## Validation and device checks

Real PostgreSQL regressions cover retained private/shared evidence, revoked
sessions, failed proof, email/Google/Apple/reset recovery, expired refusal/purge,
concurrent locks, lost-response/legacy acknowledgements, stale epochs and legacy
credentials, pending hollow identity recovery/expiry, unknown attribution and
late phone/profile/password edits. Archive regressions cover pending-owner
locking, saved history retention across cancellation, the retained hold and its
expiry, stale candidates and ordinary/already-purged archives. Mobile tests cover
policy compatibility, backup refusals/failures/bounds, actual auth generation
races, receipt cleanup and restore interactions.

All 14 backend application packages with tests passed against an isolated UTF-8
PostgreSQL database. The final full auth/vault rerun passed 154 test/subcase
results, and the signed-unarchive/shop-profile sync rerun passed 10. All 50
mobile selftest suites, TypeScript, 85 web tests, the web build and both native
Metro/Hermes exports passed. The only backend skip was the opt-in bill-preview
image generator. Native end-to-end recovery remains a device check.

Before the next distribution, test Android/iOS end to end with synthetic ledgers:
accepted shared tallies; a final offline edit that blocks unsafe deletion;
online scheduling and other-phone revocation; sign-in before deadline and
complete cloud recovery; interrupted restore/retry; English/Dari disclosure.
Deadline/purge tests must use synthetic accounts.
