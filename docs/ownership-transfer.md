# Ownership invitations

Implemented for the next 2.2.0 testing update. Backend migration **064** and the
matching server must deploy before the mobile builds. No cloud build or store
upload was started while this feature was being added.

## User flow

The current owner opens **Manage this Kaata → Transfer ownership**, enters the
recipient's sign-in email, confirms the handover terms, and shares the resulting
link through Email or WhatsApp. Copy is also available. Those actions open the
phone's composer; the app does not send messages on the user's behalf.

The owner keeps ownership until the recipient signs into the invited email and
explicitly chooses **Accept ownership**. Acceptance makes the recipient Owner
and leaves the sender as **Editor**, as requested. The sender's phone can be
offline during acceptance. The recipient can already be a member or join through
this invitation. Ownership stays attached to the same kaata, contacts, tallies,
and shared accounts.

Invitations expire after seven days and are single-use. Pending status shows the
recipient and expiry; the owner can cancel it. Creating a replacement invalidates
the previous link. Only the currently authorized owner may create or cancel a
handover. Admins and lower roles cannot transfer ownership. The existing transfer
to a member remains available.

The owner must have a signed, published membership/device proof. A registered
legacy kaata with a missing server anchor uses ordinary idempotent registration
to publish its existing anchor. Missing or refused authority stops creation;
the app never silently substitutes an unsigned grant.

Update all phones that use the kaata before transferring. Older apps do not
understand the new handover proof and can display stale roles or quarantine later
updates. Opening the web page alone never transfers ownership. Older mobile
clients cannot consume this invitation through the ordinary member endpoint.
Nearby Bluetooth/Wi-Fi mesh remains disabled in every build. This feature does
not enable offline ownership invitations or establish historical membership
frontiers for direct device-to-device transfers; privileged admission goes
through the server's current-authority checks.

## Persistence and authority

Ownership invitations use a dedicated table with a hashed random token, normalized
email, exact source membership revision, expiry, and an immutable owner-device
authorization. The grant explicitly names the kaata, transfer ID, source account,
recipient email, and Editor demotion. Pre-sign-in kaatas also sign their exact
local chain identity so both representations of the old owner are demoted.

Acceptance rechecks the proven recipient email, current source ownership, account
state, archive state, expiry, and registered device removals under account/vault
locks. One transaction changes the role rows and canonical owner pointer,
consumes the invitation, writes the audit record, and publishes a signed
`vault_member_added` carrying the narrow handover proof. Ordinary invitation
witnesses still cannot grant Owner or Admin.

The proof combines the owner's device signature with the pinned server's final
event signature. Its receipt binds the exact event ID, time, recipient and grant
hash. Retries return that receipt and current membership; they do not issue a new
event or restore a role changed later. The server event is durable before the
acceptance response, so a crash or reinstall cannot strand the ownership change.

Mobile stores the token and its acceptance intent before the consuming request.
The account-scoped journal resumes lost responses and interrupted restoration.
The recipient screen waits for the exact handover event to apply, even if they
already had an Editor membership, before showing completion. Session, route and
kaata changes cannot paint or clear another flow's state.

Canonical ownership must follow direct member handovers too; a former owner's
later account purge must not remove the new owner's kaata. The migration repairs
old pointers when their recorded owner no longer has an active Owner seat, using
an existing active owner. It also repairs the old local identity handover only
when the original signed anchor, registered founder key, latest signed
self-demotion and an active successor all corroborate it. Later explicit
ownership changes and ambiguous identities are preserved.

## Validation

Focused tests exercise real Ed25519 signatures, deterministic membership folds,
SQLite projection/role gates, durable client journals, sender/recipient screens,
and isolated PostgreSQL invitation lifecycles. They cover wrong accounts, expiry,
cancellation, concurrent acceptance, replacements, lost replies, session changes,
local identities, later demotion/removal, preserved device removals and former
owner authority. Native end-to-end Email/WhatsApp opening, update-in-place,
two-phone handover, cold restore, and English/Dari layout remain device checks.

Release validation passed all 67 mobile suites, the final 83-case auth suite,
eight affected follow-up suites, mobile TypeScript, both native Hermes exports,
102 web tests and the production web build, and 26 store-helper tests. Full
backend validation passed 677 cases/subcases with no failures or database skips,
plus static checks and server compilation. Three optional development preview
and capture fixtures required external inputs and were skipped.

Testing distribution uses the existing TestFlight group and Play internal track;
this feature does not authorize a production mobile promotion.
