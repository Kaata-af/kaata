# Find and invite Kaata members

The existing **Members → Add member** screen reuses the people directory. An
owner or manager can search a discoverable account by name, username, or full
phone number, choose Editor, Clerk, or Viewer, and confirm the recipient and
role. The existing shareable-link option remains on the same screen.

The recipient sees a member invitation in the existing notification inbox.
Review opens the existing invitation screen. Only acceptance grants access;
searching, selecting a person, and sending a request create no financial
contact and grant no membership. Declining removes the server-side request.
Search privacy follows the account's existing “Let people find me” setting;
Ninja accounts remain outside the directory.

## Server contract

- `vault_account_invites: true` in `/v1/sync/capabilities` gates sending.
- `POST /v1/vaults/{id}/account-invites` accepts `target_account_id` and `role`.
  It returns `invite_id`, the nonsecret `v_<UUID>` selector, `delivery: in_app`,
  and an ISO expiry. This distinct endpoint prevents older servers from
  interpreting an unknown recipient field as a wildcard link invitation.
- `GET /v1/vaults/invites/pending?include_account_invites=1` includes direct
  requests. Omitting that flag preserves the legacy email-only response, so
  older clients cannot overwrite their per-vault link-token cache with a
  different request's role or inviter. The new inbox keeps direct rows in
  account-scoped memory and never writes that legacy cache.
- Authenticated `GET` and `DELETE /v1/vaults/invites/requests/{id}` preview and
  decline a request only for its recipient. Public link preview never resolves
  a direct selector. Acceptance uses the existing authenticated accept route
  and membership witness, journal, admission, and materialization pipeline.

Migration 083 keeps pending `account_id` null and stores the target separately.
Creation requires an active owner or manager and an active target who is
discoverable or an [accepted friend](people-profiles.md) of the inviter.
Preview and acceptance recheck the recipient, inviter authority, expiry, and
Kaata state. Turning off discovery after a request was sent does not strand it.
Switching accounts or sessions invalidates stale UI and network results.

Duplicate sends preserve the original request and expiry. A different pending
role requires resolving the earlier request; it cannot silently change the
recipient's grant. Limits are 20 pending requests per Kaata and 50 per recipient.
Existing members cannot be invited again. Previously removed members require
owner-signed readmission, which this flow deliberately refuses until the
membership-chain readmission protocol is supported.

## Verification

The full backend vault suite passed 104 tests. The focused account-invitation
suite passed 16 real-PostgreSQL tests, including recipient-only access, no
pending ACL grant, deduplication, immutable roles, revoked authority, membership
witnesses, and byte-for-byte legacy pending-response compatibility.

Mobile verification covers the real API transport, authenticated preview and
decline, sender role confirmation, existing inbox navigation and badge counts,
sign-out and account/session races, and the existing join and ownership paths.
Member-discovery, people-discovery, email-auth (91), members-screen, ownership,
English/Dari/Pashto, language restart, and TypeScript checks passed.

Automated checks use isolated fixtures and databases. No real person received
an invitation during development. A full two-account device acceptance test
remains tester QA.

The feature is available in Android internal build 86 and iOS TestFlight build 51. See [testing distribution](2.3.2-member-discovery-testing.md) for delivery
evidence and verification limits.
