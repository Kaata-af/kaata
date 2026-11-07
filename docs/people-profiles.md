# People profiles and friends

Tap a **People on Kaata** result from Home search or Add person to open a
full-screen profile. Saved ledger contacts continue to open their ledgers. The
existing account menu has a **Friends** list; finding new people stays in the
same search. Profiles and friendship work without a selected Kaata or ledger
write permissions.

- **Add friend** sends a mutual-consent request. The recipient opens it in the
  existing inbox, then accepts or declines on the person's profile. The sender
  can cancel; either friend can remove the friendship. Existing contacts,
  tallies and memberships are never inferred to be friends.
- **Share a tally** opens the existing shared account confirmation for the
  selected Kaata. It keeps the contact, currency, recording mode and history
  checks. Sending stays on the profile; the recipient uses the existing tally
  join flow. A joined tally opens its ledger once synced to the device.
- **Invite to Kaata** opens the existing role picker with the recipient staged.
  It names the selected Kaata and requires an authorized owner or manager to
  confirm the role. The recipient uses the existing invitation acceptance.

Friendship grants neither a tally nor a Kaata role. Removing a friend changes
neither. Tally and member invitations are still possible for discoverable
accounts without first adding a friend. The profile can show outgoing pending
tally/member invitations and an active shared tally for the selected Kaata.
That summary does not expose balances, invite tokens, other senders' pending
requests or a vault roster.

## Privacy and compatibility

The authenticated profile endpoint returns only name, username and avatar,
the viewer's own relationship state, and an optional authorized Kaata summary.
There is no public friends list, phone or email on a profile. Turning off
discovery hides the account from strangers. Accepted friends can still find it
by name or username, open its profile, and send separate requests. Phone
lookup never finds a hidden friend. An already pending friendship remains
reviewable with minimal identity; an opted-out pending party's username stays
hidden until acceptance. That preview does not allow sending new tally or
member invitations. Disabled/deleted accounts and Ninja local profiles do not
appear.

Migration 084 adds a canonical account pair and an instance ID that rotates
on replacement. Existing request IDs cannot accept or remove a newer request.
Requests expire in 14 days, have a 24-hour cooldown after cancellation,
decline or removal, and have bounded pending queues. Account deletion cascades
the friendship rows. Crossed requests still require explicit acceptance.

- `GET /v1/people/profiles/{account_id}` reads a profile; optional `vault_id`
  adds only the selected authorized Kaata's request and relationship summary.
- `GET /v1/friends` lists accepted friends with a cursor; `GET /v1/friends/requests`
  lists incoming pending requests. `POST /v1/friends/requests` creates a request;
  `POST /v1/friends/requests/{id}/accept` accepts it. The request and friendship
  `DELETE` routes use the exact instance ID.
- `include_friends=1` opts in to private friend matching on existing search.
  Older clients keep discovery-only results. Existing `r_` tally and `v_`
  member invitation contracts stay separate and compatible.

Mobile verification: `npm run selftest:people-profiles` covers client transport,
profile and Friends screens, independent actions, pending states, the inbox,
and stale session, account, route and vault changes. Existing people discovery,
membership invitation, profile settings and contact regressions cover older
flows. Backend tests use isolated PostgreSQL for pair authorization,
concurrency, lifecycle, search privacy, and the selected Kaata summary.

## Two-account device check

Use two updated tester accounts and a test Kaata. Open the second account's
profile from ordinary search and send a friend request. On the recipient's
phone, open it from **Friend requests** in the existing inbox, then accept it.
Confirm that both accounts see the friendship and that no tally or membership
was created.

From that profile, send **Share a tally** and **Invite to Kaata** as separate
requests. Verify that the recipient can review each in its own inbox section,
that the tally preview asks for the correct contact and sharing choices, and
that the member preview names the test Kaata and selected role. Accept each
independently. Removing the friendship should leave the joined tally and role
in place. With discovery off, the former friend should no longer see the
account under **People on Kaata**.

The feature is available in Android internal build 87 and iOS TestFlight
build 52. See the [private testing release](2.3.2-people-profiles-testing.md).
